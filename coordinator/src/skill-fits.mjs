import { foodAdviceNeeded, portalBedSource } from './survival-advice.mjs';
import { heldCounts, keepPickaxeMakings, planObtain } from './obtain-plan.mjs';

// One wake fact: a goal skill (fight_until, barter_until, build nether_portal by casting, cast_obsidian) whose preconditions hold right now, with the
// call's fields and the facts that make it fit. It names a call the model may make; nothing runs from it.

export const SKILL_FITS_BYTES = 240;
// fight_until's default area radius; barter_until looks for piglins within 32 blocks (it walks that far to one), cast_obsidian for lava within 16.
const FIGHT_RANGE = 24;
const BARTER_RANGE = 32;
const LAVA_RANGE = 16;
const MELEE = /^minecraft:(wooden|golden|stone|copper|iron|diamond|netherite)_(sword|axe)$/;
const GOLD_ARMOUR = /^minecraft:golden_(helmet|chestplate|leggings|boots)$/;
const WORN = new Set(['head', 'chest', 'legs', 'feet']);

/**
 * needs: the plan's open counted needs in plan order, { id, have, need } (have < need). sightings: remembered source rows
 * (kind spawner with mob or nether). lavaPools: remembered still lava ({ dimension, x, y, z, sources, cells }).
 * Returns at most one line, or null when no goal skill fits.
 */
export function skillFitsLine({ observation: o = null, needs = [], sightings = [], lavaPools = [] } = {}) {
	if (!live(o) || !Array.isArray(o.inventory?.items) || remembered(o, 'inventory') || !needs.length) return null;
	const at = o.position ?? o.player?.position ?? o.player;
	if (![at?.x, at?.y, at?.z].every(Number.isFinite)) return null;
	const items = o.inventory.items.filter(i => i?.count > 0);
	const count = re => items.filter(i => re.test(i.itemId ?? '')).reduce((n, i) => n + i.count, 0);
	const entities = remembered(o, 'entities') ? [] : (o.entities ?? []).filter(e => e?.alive !== false && Number.isFinite(e?.distance));
	const nearest = (type, range, ok = () => true) => entities.filter(e => e.type === type && e.distance <= range && ok(e)).sort((a, b) => a.distance - b.distance)[0] ?? null;
	const away = row => Math.hypot(row.x - at.x, row.y - at.y, row.z - at.z);
	const dimension = o.world?.dimension;
	const running = o.currentAction?.active === true ? o.currentAction.actionType : null;
	const melee = items.filter(i => MELEE.test(i.itemId)).sort((a, b) => tier(b.itemId) - tier(a.itemId))[0]?.itemId.slice(10) ?? null;
	const bow = count(/^minecraft:(bow|crossbow)$/) > 0 ? count(/^minecraft:(arrow|spectral_arrow|tipped_arrow)$/) : 0;
	const m = n => `${Math.round(n)} m`;

	const blaze = need => {
		if (dimension !== 'minecraft:the_nether' || running === 'fight_until' || (!melee && !bow)) return null;
		const blocks = remembered(o, 'blocks') ? [] : [...(o.blocks ?? []), ...(o.landmarks ?? [])];
		const spawners = [...blocks.filter(b => b?.blockId === 'minecraft:spawner' && [b.x, b.y, b.z].every(Number.isFinite)),
			...sightings.filter(r => r?.kind === 'spawner' && (r.mob === 'minecraft:blaze' || r.mob === undefined && r.nether === true) && [r.x, r.y, r.z].every(Number.isFinite))]
			.map(away).filter(d => d <= FIGHT_RANGE).sort((a, b) => a - b);
		const mob = nearest('minecraft:blaze', FIGHT_RANGE);
		if (!spawners.length && !mob) return null;
		const gear = [melee, bow ? `bow + ${bow} arrows` : null].filter(Boolean).join(', ');
		return `fight_until mob:minecraft:blaze untilItem:minecraft:blaze_rod untilCount:${need.need} (${spawners.length ? `spawner ${m(spawners[0])}` : `blaze ${m(mob.distance)}`}, ${gear}, rods ${need.have}/${need.need})`;
	};
	const enderman = need => {
		// An enderman is always fought in melee (fight_until never shoots one).
		if (running === 'fight_until' || !melee) return null;
		const mob = nearest('minecraft:enderman', FIGHT_RANGE);
		return mob && `fight_until mob:minecraft:enderman untilItem:minecraft:ender_pearl untilCount:${need.need} (enderman ${m(mob.distance)}, ${melee}, pearls ${need.have}/${need.need})`;
	};
	const barter = need => {
		// barter_until crafts carried gold blocks and nuggets into ingots and puts on carried gold armour itself.
		const gold = count(/^minecraft:gold_ingot$/) + 9 * count(/^minecraft:gold_block$/) + Math.floor(count(/^minecraft:gold_nugget$/) / 9);
		const worn = items.some(i => WORN.has(i.slot) && GOLD_ARMOUR.test(i.itemId));
		if (running === 'barter_until' || gold === 0 || !worn && !items.some(i => GOLD_ARMOUR.test(i.itemId))) return null;
		const piglin = nearest('minecraft:piglin', BARTER_RANGE, e => e.baby !== true && e.targetingAgent !== true);
		return piglin && `barter_until itemId:minecraft:ender_pearl count:${Math.min(64, need.need - need.have)} (piglin ${m(piglin.distance)}, gold ${gold}, gold armour ${worn ? 'worn' : 'carried, put on first'}, pearls ${need.have}/${need.need})`;
	};
	const cast = need => {
		// Water poured in the Nether evaporates, so casting is an Overworld (or End) fact.
		if (dimension === 'minecraft:the_nether' || running === 'cast_obsidian' || count(/^minecraft:water_bucket$/) === 0) return null;
		const seen = remembered(o, 'blocks') ? [] : (o.blocks ?? []).filter(b => b?.blockId === 'minecraft:lava' && String(b.state?.level) === '0' && b.visible !== false);
		const pools = lavaPools.filter(p => p?.dimension === dimension).flatMap(p => Array.isArray(p.cells) && p.cells.length ? p.cells.map(c => { const [x, y, z] = String(c).split(',').map(Number); return { x, y, z }; }) : [p]);
		const source = [...seen, ...pools].filter(c => [c.x, c.y, c.z].every(Number.isFinite)).map(c => ({ c, d: away(c) })).filter(r => r.d <= LAVA_RANGE).sort((a, b) => a.d - b.d)[0];
		if (!source) return null;
		// With a second bucket the build verb casts the whole frame beside the pool and lights it (a frame needs 10).
		if (count(/^minecraft:(bucket|lava_bucket)$/) > 0 && need.need >= 10 && running !== 'build')
			return `build nether_portal (casts the frame by the lava source at ${source.c.x},${source.c.y},${source.c.z}, ${m(source.d)}, and lights it; ${need.step ? `for ${need.step}; ` : ''}water_bucket + bucket, plain blocks ${count(MOULD)}/13, obsidian ${need.have}/${need.need})`;
		return `cast_obsidian x:${source.c.x} y:${source.c.y} z:${source.c.z} count:${Math.min(64, need.need - need.have)} (${need.step ? `for ${need.step}; ` : ''}lava source ${m(source.d)}, water_bucket, obsidian ${need.have}/${need.need})`;
	};
	const iron = need => {
		if (running === 'break_block' || remembered(o, 'blocks')) return null;
		const pick = items.filter(i => /^(?:minecraft:)(stone|copper|iron|diamond|netherite)_pickaxe$/.test(i.itemId) && (i.usesLeft === undefined || i.usesLeft > 0))
			.sort((a, b) => tier(b.itemId) - tier(a.itemId))[0];
		if (!pick) return null;
		const ore = (o.blocks ?? []).filter(b => /^minecraft:(deepslate_)?iron_ore$/.test(b?.blockId) && b.visible !== false && b.remembered !== true && [b.x,b.y,b.z].every(Number.isFinite))
			.map(c => ({ c, d: away(c) })).filter(r => r.d <= 4.5).sort((a,b) => a.d - b.d)[0];
		return ore && `break_block x:${ore.c.x} y:${ore.c.y} z:${ore.c.z} with ${pick.itemId.slice(10)} (iron ore seen ${m(ore.d)}; for ${need.step ?? 'iron'}; click reach/line must be clear)`;
	};
	const ways = { 'minecraft:raw_iron': [iron], 'minecraft:iron_ingot': [iron], 'minecraft:iron_ore': [iron], 'minecraft:deepslate_iron_ore': [iron], 'minecraft:blaze_rod': [blaze], 'minecraft:ender_pearl': [enderman, barter], 'minecraft:obsidian': [cast] };
	for (const need of needs) {
		if (!(need?.have < need?.need)) continue;
		for (const way of ways[need.id] ?? []) {
			const line = way(need);
			if (line) return Buffer.byteLength(line) <= SKILL_FITS_BYTES ? line : null;
		}
	}
	return null;
}

function live(o) { return o?.ready === true && o.player?.dead !== true && o.continuity?.phase !== 'dead'; }
function remembered(o, section) { return o.continuity?.rememberedSections?.includes(section) === true; }
function tier(id) { return ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'].indexOf(id.slice(10).split('_')[0]); }

// The usual route to beat the game, as data: each stage is done when its plan check holds (plan-checks.mjs, placements
// included), and the first stage not done is the usual next step. One wake line that suggests; it names a step the model
// may take or ignore, and starts nothing.
export const ROUTE_BYTES = 220;
export const PORTAL_ENTRY_NEXT = 'enter the Nether through the lit portal now';
const ENTRY_FOOD = 'food stocks are optional unless health or hunger is low';
// Also the PORTAL_LIT result's hint, which cannot see the inventory, so it names the bed step's condition.
export const PORTAL_ENTRY_PREP = `place and use a bed by the portal first if a bed, 3 matching wool or sheep are in reach; ${ENTRY_FOOD}`;
// A respawn set this close to the portal already brings a Nether death back to it.
const BED_NEAR = 24;
// Height counts: a surface bed above an underground portal is still a long way back from a Nether death.
const byPortal = (a, near) => Math.hypot(a.x - near.x, Number.isFinite(a.y) && Number.isFinite(near.y) ? a.y - near.y : 0, a.z - near.z) <= BED_NEAR;
const USE_BED = 'interact_block it until "Respawn point set" (by day too), keep it';

/**
 * C33: the respawn bed by the Overworld portal. In rounds 4 to 6, 17 Nether deaths respawned 50 to 576 blocks from the
 * portal and took about 557 minutes to get back, more than the 362 spent there. Offered at every lit-portal visit while
 * the respawn is not set by the portal, not only before the first entry, on purpose: a respawn far from the portal
 * costs the same walk back after any death, first trip or tenth. Only from what is in reach (portalBedSource), never a
 * wool search. lit: the portal is lit (frame: its cell when known); before lighting the bed is only made ready. Returns
 * { step: [next, why] } or { skip: reason }.
 */
function portalBed(o, known, { lit, frame = null }) {
	const at = o.position ?? o.player?.position ?? o.player;
	const near = frame ?? at;
	const spawn = known.spawn;
	if (spawn?.kind === 'set' && spawn.dimension === 'minecraft:overworld' && [near?.x, near?.z].every(Number.isFinite)
		&& byPortal(spawn, near)) return { skip: 'respawn set by the portal' };
	const source = portalBedSource(o);
	if (source === null) return { skip: 'no bed, 3 matching wool or sheep in reach: no portal bed' };
	const by = frame ? `the portal at ${frame.x},${frame.y},${frame.z}` : 'the portal';
	const place = lit ? `place_block it by ${by}, ${USE_BED}` : 'carry it to the portal';
	if (source.kind === 'held') return lit ? { step: [`place_block ${source.itemId.slice(10)} by ${by}, ${USE_BED}`, 'bed held; a Nether death then respawns here'] } : { skip: 'bed held' };
	if (source.kind === 'seen') {
		const b = source.block, id = b.blockId.slice(10), cell = `${b.x},${b.y},${b.z}`;
		if (lit && byPortal(b, near)) return { step: [`interact_block the ${id} at ${cell} until "Respawn point set" (by day too), keep it`, 'bed by the portal'] };
		return { step: [`break_block the ${id} at ${cell}, then ${place}`, 'bed in view'] };
	}
	const bed = `${source.colour}_bed`;
	if (source.kind === 'wool') return { step: [`obtain ${bed}, then ${place}`, `${source.held} ${source.colour}_wool held`] };
	const from = [source.sheep ? `${source.sheep} sheep` : null, source.blocks ? `${source.blocks} wool blocks` : null].filter(Boolean).join(' and ');
	return { step: [`get ${source.colour}_wool from the ${from} in view, obtain ${bed}, then ${lit ? 'place and use it by the portal' : 'carry it to the portal'}`,
		`${source.held} held, no wool search; skip if they leave`] };
}

// Hunger at or under this (of 20) makes food part of the step (health stops regenerating under 18). The 7 gate2 games
// that held a bucket and flint and steel had hunger 19-20 at the time, and all of them went hunting instead of to lava.
const HUNGRY = 14;
const FOOD = /^minecraft:(cooked_(beef|porkchop|mutton|chicken|rabbit|cod|salmon)|bread|baked_potato|golden_carrot|pumpkin_pie|rabbit_stew|mushroom_stew|beetroot_soup)$/;
// Raw meat and fish count as carried food for the spawn food step (any of it eaten restores hunger).
const RAW_FOOD = /^minecraft:(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/;
// Anything a player eats from the inventory without crafting: what 'food held' counts everywhere in the route line.
const EDIBLE = new RegExp(`${FOOD.source}|${RAW_FOOD.source}|^minecraft:(apple|carrot|potato|sweet_berries|glow_berries|melon_slice|beetroot|cookie|dried_kelp)$`);
// About 4 raw meat from one animal at spawn: batch 1 ended 14 of 24 runs by health with no food carried (health comes back
// only at hunger 18+).
const MEAT = 4;
const MEAT_STOCK = 8;
const MEATS = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'];
const COOKED_MEAT = /^minecraft:cooked_(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/;
const ANIMAL_MEAT = { cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken', rabbit: 'rabbit' };

/**
 * Whether a finished obtain or find says the food stock has no source here: an obtain of cooked meat that failed or ran
 * out of time, or a find for a meat animal that searched its whole range or budget. A danger, low-health or cancelled
 * stop is not one (the source may still be there), nor a failed observation.
 */
export function foodStockHandback(tool, result) {
	if (!['FAILED', 'TIMED_OUT'].includes(result?.state) || result.reasonCode === 'OBSERVATION_UNAVAILABLE') return false;
	const id = value => String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/^minecraft:/, '');
	if (tool?.kind === 'obtain') return COOKED_MEAT.test(`minecraft:${id(typeof result.item === 'string' ? result.item : tool.arguments?.item)}`);
	return tool?.kind === 'find' && Object.hasOwn(ANIMAL_MEAT, id(tool.arguments?.mob)) && (result.reasonCode === 'FIND_NOT_FOUND' || result.state === 'TIMED_OUT');
}

/**
 * Whether a finished obtain says the trip's wood has no source here: an obtain of logs or planks that failed or ran out
 * of time (no tree in reach, or no way up to one from under cover). The trip then goes down with the wood it has, as a
 * player who finds no tree nearby does; the obtain helper still fetches a log later if a craft needs one.
 */
export function woodStockHandback(tool, result) {
	if (tool?.kind !== 'obtain' || !['FAILED', 'TIMED_OUT'].includes(result?.state) || result.reasonCode === 'OBSERVATION_UNAVAILABLE') return false;
	const id = String(typeof result.item === 'string' ? result.item : tool.arguments?.item ?? '').trim().toLowerCase().replace(/^#?minecraft:/, '').replace(/^#/, '');
	return /^(log|logs|planks|[a-z_]+_(log|planks|stem))$/.test(id);
}

function nearbyMeat(o) {
	if (remembered(o, 'entities')) return null;
	const at = o.position ?? o.player;
	return (o.entities ?? []).filter(row => row?.alive !== false && row.visible !== false && row.perceivedBy !== 'sound' && row.baby !== true && row.appearance?.baby !== true && ANIMAL_MEAT[String(row.type).replace(/^minecraft:/, '')])
		.map(row => ({ meat: ANIMAL_MEAT[String(row.type).replace(/^minecraft:/, '')], distance: Number.isFinite(row.distance) ? row.distance : Math.hypot(row.x - at?.x, row.y - at?.y, row.z - at?.z) }))
		.filter(row => row.distance <= 32).sort((a, b) => a.distance - b.distance)[0]?.meat ?? null;
}

function stockFoodNext(f) {
	const exact = meat => f.count(new RegExp('^minecraft:' + meat + '$'));
	const raw = MEATS.find(meat => exact(meat) > 0);
	const meat = raw ?? f.nearbyMeat;
	const why = `cooked meat ${f.cookedMeat}/${MEAT_STOCK}`;
	if (meat === null || meat === undefined) return ['look for nearby cows/pigs/sheep/chickens, then obtain cooked meat with a furnace before digging below Y40', why];
	// Obtain counts are totals of this cooked type; cook held raw meat before hunting for more.
	const total = exact('cooked_' + meat) + Math.min(MEAT_STOCK - f.cookedMeat, raw ? exact(raw) : MEAT_STOCK);
	return [`obtain cooked_${meat} count ${total} using a furnace before digging below Y40`, `${why}; ${raw ? 'raw meat held' : 'animal seen nearby'}`];
}
// The blocks a cast frame's mould is made of: plain full blocks that neither burn nor fall (planks would catch fire).
const MOULD = /^minecraft:(cobblestone|cobbled_deepslate|dirt|stone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt|end_stone)$/;
const BUCKETS = 'has:minecraft:bucket|minecraft:water_bucket|minecraft:lava_bucket*2';
// Plain blocks a cast frame's mould takes (build nether_portal), with one to step up on.
const CAST_BLOCKS = 13;
const EYES = 12;
const ROUTE = [
	// Food at spawn from the nearest passive animal. Optional: once the first pickaxe is made (a seed with no animal in view
	// moves on), the portal is lit or the Nether visited, the route no longer holds it up. held: any food carried ends it too (eating it down to one piece keeps it ended; all of it eaten before a pickaxe brings it back).
	{ id: 'food', done: 'tool:pickaxe:wooden+ | frame:lit | visited:minecraft:the_nether', held: f => f.food >= 1 || !f.foodNeeded,
		next: f => [`obtain beef count ${MEAT} (or porkchop, mutton or chicken from the nearest animal; skip if none in view)`, 'no food held, health regrows only at hunger 18+'] },
	{ id: 'wood', done: 'tool:pickaxe:wooden+', next: f => [`obtain wooden_pickaxe`, f.wood ? `${f.wood} logs/planks held` : 'no tools yet'] },
	// R6G5: food after casting meant a 95-block climb. Bite before stone/furnace acquisition can enter a mine.
	// Released by a food obtain or animal find that came back without a source this life, or, while health and hunger are
	// above 14, by half the stock held with nothing to cook and no animal in view: held as a hard quota it headed the route
	// for 31 minutes of one game and hid the stone, iron and kit steps. A hand-back releases it at any hunger: with no food
	// to eat, hunger only falls, and the later rows carry the low-hunger restock suffix instead.
	// Surface preparation only: down a mine there is no animal to hunt, and the line would send the body back up.
	// A hand-back releases it only until an animal comes into view again: released for the whole life, it let the body go
	// down with nothing to eat (all 29 food climbs of the 19 Nov round had no food held).
	{ id: 'food_stock', done: 'visited:minecraft:the_nether', next: stockFoodNext,
		held: f => f.cookedMeat >= MEAT_STOCK || f.below || f.foodHandedBack && f.nearbyMeat === null || !f.foodNeeded && f.cookedMeat >= MEAT && f.rawMeat === 0 && f.nearbyMeat === null },
	{ id: 'stone', done: 'tool:pickaxe:stone+', next: () => ['obtain stone_pickaxe', 'wooden pickaxe, no stone tools'] },
	{ id: 'furnace', done: 'has:minecraft:furnace*1 | has:minecraft:iron_ingot*3 | tool:pickaxe:iron+', next: f => ['obtain furnace', `stone tools, ${f.count(/^minecraft:cobblestone$/)} cobblestone`] },
	// One trip down for the whole kit, as a player goes: the wood its crafts and smelting take is carried down first
	// (the obtain helper climbs back to the surface for any log it lacks underground), then all of its iron in one
	// obtain. Per item, each craft that ran out of planks underground was a climb, and each item's iron another descent.
	{ id: 'trip_wood', done: 'frame:lit | visited:minecraft:the_nether', held: f => f.below || f.woodHandedBack || f.tripLogs === 0,
		next: f => [`obtain log count ${f.logs + f.tripLogs} before going down`, `wood for the kit's crafts and smelting, so the trip needs no climb back; ${f.wood} logs/planks held`] },
	{ id: 'iron_trip', done: 'frame:lit | visited:minecraft:the_nether', held: f => f.kitIron <= f.ingots,
		next: f => [`obtain iron_ingot count ${f.kitIron} in one trip, then craft the kit`, `kit iron ${f.kitIron}: ${f.kitParts}; ${f.iron} iron held`] },
	{ id: 'iron_pickaxe', done: 'tool:pickaxe:iron+', next: f => ['obtain iron_pickaxe', f.iron ? `stone tools, ${f.iron}/3 iron held` : 'stone tools, no iron yet'] },
	// Skeletons killed 8 of 12 scripted deaths; a shield in the off hand blocks their arrows.
	// A shield lost after the portal is lit (or the Nether visited) no longer holds the route back.
	{ id: 'shield', done: 'offhand:minecraft:shield | frame:lit | visited:minecraft:the_nether', next: f => f.count(/^minecraft:shield$/) ? ['equip_item shield to offhand', 'shield held, not in the off hand']
		: ['obtain shield, then equip_item it to offhand', `iron ${f.iron} held, shield takes 1`] },
	{ id: 'iron_kit', done: `${BUCKETS} & has:minecraft:flint_and_steel*1`,
		held: f => f.count(/^minecraft:obsidian$/) >= 10 && f.count(/^minecraft:flint_and_steel$/) > 0, next: f => {
		// A carried frame skips the casting buckets, but still needs its lighter.
		if (f.count(/^minecraft:obsidian$/) >= 10) return ['obtain flint_and_steel', `iron ${f.iron} held, 1 needed for flint_and_steel`];
		const missing = [f.buckets < 2 ? `${2 - f.buckets} bucket${2 - f.buckets > 1 ? 's' : ''}` : null, f.count(/^minecraft:flint_and_steel$/) ? null : 'flint_and_steel'].filter(Boolean);
		// obtain takes one item at a time and its count is the total to hold: empty buckets held plus the ones still
		// missing (a filled bucket counts toward the two but is not an empty bucket).
		const first = f.buckets < 2 ? `bucket count ${f.count(/^minecraft:bucket$/) + 2 - f.buckets}` : missing[0];
		// Iron still needed for what is missing (3 per bucket, 1 for flint_and_steel), not the whole kit's 11.
		const need = Math.max(0, 2 - f.buckets) * 3 + (f.count(/^minecraft:flint_and_steel$/) ? 0 : 1);
		return [`obtain ${first}${missing.length > 1 ? `, then ${missing.slice(1).join(', ')}` : ''}`, `iron ${f.iron} held, ${need} needed for ${missing.join(', ')}`];
	} },
	// Without a diamond pickaxe the frame is cast in place: build nether_portal does it beside a seen lava pool.
	{ id: 'portal', done: 'frame:lit | visited:minecraft:the_nether', next: f => {
		const kit = `plain blocks ${f.blocks}/${CAST_BLOCKS}, lava pools seen ${f.pools}`;
		if (f.count(/^minecraft:obsidian$/) >= 10) return ['build nether_portal', `${f.count(/^minecraft:obsidian$/)} obsidian held`];
		// obtain fills a carried bucket at the nearest water; gate games that read "fill a bucket with water" asked obtain for
		// water_bucket (then refused) or climbed to the surface for it.
		if (!f.count(/^minecraft:water_bucket$/)) return [`obtain water_bucket, then ${f.pools ? 'build nether_portal beside the lava pool' : 'find block minecraft:lava and build nether_portal beside it'}`, kit];
		if (!f.pools) return ['find block minecraft:lava, then build nether_portal beside the pool (casts the frame with your buckets, lights it)', `water bucket held, ${kit}`];
		return ['build nether_portal beside the lava pool (casts the frame with your buckets and lights it)', `water bucket held, ${kit}`];
	} },
];

// Step 2 item 5 (instincts arm): the weapon habit is a route step, because a reflex cannot craft. Wooden and golden do not
// count; a lit portal or a Nether visit ends it, as it does the shield.
const WEAPON = { id: 'weapon', done: 'tool:sword:stone+ | tool:axe:stone+ | frame:lit | visited:minecraft:the_nether',
	next: () => ['obtain stone_sword', 'no stone-or-better sword or axe; defend and fights swing the best one held'] };
const INSTINCT_ROUTE = ROUTE.flatMap(row => row.id === 'stone' ? [row, WEAPON] : [row]);

// Step 2 item 6 (instincts arm): the eat reflex reads only the hotbar and offhand (ReflexActions.lacks), so food in the
// main inventory is food the body cannot eat in a fight. Rows with no slot facts count as in reach.
const outOfReach = item => item.slot !== 'mainhand' && item.slot !== 'offhand'
	&& (item.hotbar === false || Number.isInteger(item.slot) && item.slot >= 9 && item.hotbar !== true);

// The default eat reflex does not top up (hunger 14+) on these, or on a golden apple above health 8 (ReflexActions.topUpLacks,
// both arms), so food like this in the hotbar does not put food in its reach.
const TOP_UP_SKIPPED = /^minecraft:(rotten_flesh|spider_eye|poisonous_potato|pufferfish|suspicious_stew|chorus_fruit|chicken)$/;
const HEALING_FOOD = /^minecraft:(enchanted_)?golden_apple$/;
// Every vanilla item with a food component, as the eat reflex reads them (ReflexActions.Held.food): EDIBLE plus the foods
// the route never counts as a stock (last-resort food, golden apples, honey).
const REFLEX_FOOD = new RegExp(`${EDIBLE.source}|^minecraft:(golden_apple|enchanted_golden_apple|rotten_flesh|spider_eye|poisonous_potato|pufferfish|tropical_fish|suspicious_stew|chorus_fruit|honey_bottle)$`);
const reflexEats = (item, o) => !(o.player?.foodLevel >= 14
	&& (TOP_UP_SKIPPED.test(item.itemId ?? '') || HEALING_FOOD.test(item.itemId ?? '') && !(o.player?.health <= 8)));

const HOGLIN_HEALTH = 10;

// A food source each dimension has, in view now; null when none is.
function foodSource(o) {
	const dimension = o.world?.dimension;
	if (dimension === 'minecraft:the_nether') {
		if (remembered(o, 'entities')) return null;
		const hoglin = (o.entities ?? []).find(row => row?.alive !== false && row.visible !== false && row.perceivedBy !== 'sound' && row.type === 'minecraft:hoglin'
			&& row.baby !== true && row.appearance?.baby !== true && (!Number.isFinite(row.distance) || row.distance <= 32));
		// A hoglin hits hard: at low health it is not a food source but a reason to recover first.
		return hoglin && !(o.player?.health <= HOGLIN_HEALTH) ? 'fight_target the hoglin in view for porkchop (cook it or eat it raw)' : null;
	}
	if (dimension === 'minecraft:the_end') return null;
	const meat = nearbyMeat(o);
	return meat ? `obtain ${meat} count ${MEAT} from the animal in view` : null;
}

/**
 * The usual next step toward beating the game from the player's state, or null without a live sample. observation: the
 * newest live sample; known: plan-checks facts (visited dimensions, lit frames, lava pools, placements); evaluate: the
 * plan-check evaluator (evaluatePlanCheck); memory: scoped, contradiction-aware source facts from LiveTaskViews;
 * foodHandedBack: a food hand-back this life (foodStockHandback) released the cooked-meat stock; woodHandedBack: a wood
 * hand-back this life (woodStockHandback) released the trip's wood step.
 */
export function routeLine({ observation: o = null, known = null, memory = null, foodHandedBack = false, woodHandedBack = false, evaluate, instincts = false } = {}) {
	if (!live(o) || !Array.isArray(o.inventory?.items) || remembered(o, 'inventory') || known === null || typeof evaluate !== 'function') return null;
	const items = o.inventory.items.filter(i => i?.count > 0);
	const count = re => items.filter(i => re.test(i.itemId ?? '')).reduce((n, i) => n + i.count, 0);
	const ok = check => { try { return evaluate(check, o, known).ok === true; } catch { return false; } };
	const done = row => row.held?.(facts) === true || ok(row.done);
	const dimension = o.world?.dimension;
	const food = count(EDIBLE);
	// The End needs 12 eyes in its portal frames. What is still missing counts down from the eyes already held or set in a
	// frame (a thrown eye that broke counts up again), then the powder and rods that make them, and pearls likewise.
	const frames = remembered(o, 'blocks') ? [] : [...(o.blocks ?? []), ...(o.landmarks ?? [])];
	const filled = Math.min(EYES, frames.filter(b => b?.blockId === 'minecraft:end_portal_frame' && [true, 'true'].includes(b.state?.eye)).length);
	const portalOpen = frames.some(b => b?.blockId === 'minecraft:end_portal');
	const eyesHeld = count(/^minecraft:ender_eye$/), eyesNeeded = portalOpen ? 0 : Math.max(0, EYES - eyesHeld - filled);
	const powderNeeded = Math.max(0, eyesNeeded - count(/^minecraft:blaze_powder$/));
	// One spare rod while nothing is crafted yet: the usual 7 rods for 12 eyes.
	const rodsNeeded = Math.ceil(powderNeeded / 2) + (eyesHeld + filled + count(/^minecraft:blaze_powder$/) === 0 && eyesNeeded > 0 ? 1 : 0);
	const rods = count(/^minecraft:blaze_rod$/), pearls = count(/^minecraft:ender_pearl$/);
	const rodsMissing = Math.max(0, rodsNeeded - rods), pearlsMissing = Math.max(0, eyesNeeded - pearls);
	const eyeFacts = `rods ${rods}/${rodsNeeded}, pearls ${pearls}/${eyesNeeded}, eyes ${eyesHeld} held + ${filled} set of ${EYES}`;
	const facts = { count, foodNeeded: foodAdviceNeeded(o), foodHandedBack: foodHandedBack === true, food: count(EDIBLE), cookedMeat: count(COOKED_MEAT), rawMeat: count(RAW_FOOD), nearbyMeat: nearbyMeat(o), blocks: count(MOULD), wood: count(/^minecraft:([a-z_]+_(log|planks|stem))$/), iron: count(/^minecraft:(iron_ingot|raw_iron)$/),
		buckets: count(/^minecraft:(bucket|water_bucket|lava_bucket)$/), pools: (known.lavaPools ?? []).filter(p => p?.dimension === dimension).length,
		below: belowGround(o), woodHandedBack: woodHandedBack === true, logs: count(/^minecraft:[a-z_]+_log$/), ingots: count(/^minecraft:iron_ingot$/) };
	const kit = kitLeft(count);
	Object.assign(facts, { kitIron: kit.iron, kitParts: kit.parts });
	// Planned only when the route reaches the step: a whole-kit obtain plan per wake is not free.
	Object.defineProperty(facts, 'tripLogs', { get: () => tripLogs(o, kit) });
	// Instincts arm: food first in every dimension (C27), before more resource travel.
	let foodNote = '';
	if (instincts === true) {
		const food = items.filter(i => EDIBLE.test(i.itemId ?? ''));
		const eats = items.filter(i => REFLEX_FOOD.test(i.itemId ?? '') && reflexEats(i, o));
		const stored = eats.filter(outOfReach);
		// Only while eating is due soon (the eat reflex fires below 18) or the body is hurt: at full hunger it would only
		// crowd out the step that matters.
		const eatingDue = !Number.isFinite(o.player?.foodLevel) || o.player.foodLevel < 18 || o.player?.health <= 14;
		const best = stored.find(i => FOOD.test(i.itemId) && Number.isInteger(i.slot)) ?? stored.find(i => Number.isInteger(i.slot));
		if (eatingDue && stored.length > 0 && stored.length === eats.length && best !== undefined) {
			const taken = new Set(items.filter(i => Number.isInteger(i.slot) && i.slot >= 0 && i.slot <= 8).map(i => i.slot));
			const hotbarSlot = [8, 7, 6, 5, 4, 3, 2, 1, 0].find(slot => !taken.has(slot)) ?? 8;
			return line(`select_tool sourceSlot:${best.slot} hotbarSlot:${hotbarSlot} expectedItemId:${best.itemId} minRemainingDurability:0`,
				'food only in the main inventory; the eat reflex reads the hotbar and offhand');
		}
		if (food.length === 0 && foodAdviceNeeded(o)) {
			const source = foodSource(o);
			if (source) return line(source, 'no food held; health regrows only at hunger 18+');
			foodNote = 'no food source in view, take one when seen; ';
		}
	}
	function line(next, why) {
		const text = `usual next step: ${foodNote}${next} (${why})`;
		if (Buffer.byteLength(text) <= ROUTE_BYTES) return text;
		let clipped = '', used = 0;
		for (const char of text) {
			const bytes = Buffer.byteLength(char);
			if (used + bytes > ROUTE_BYTES - 3) break;
			clipped += char; used += bytes;
		}
		return `${clipped}…`;
	}
	if (dimension === 'minecraft:the_end') {
		// A queued wake can render an older sample after the live tally has changed.
		const seen = o.endCrystals;
		const crystals = Array.isArray(seen?.standing) && Number.isSafeInteger(seen.broken) && seen.broken >= 0
			? { standing: seen.standing.length, broken: seen.broken } : known.crystals;
		if (crystals?.standing === 0 && crystals.broken > 0)
			return line('fight the dragon from open ground near the exit fountain', 'no remembered standing crystals; if it heals, look for others');
		return line('kill the ender_dragon: break the end crystals first', 'in the End');
	}
	if (dimension === 'minecraft:the_nether') {
		if (rodsMissing > 0) {
			const fortress = `find a fortress and fight_until ${rodsNeeded} blaze_rods`;
			if (items.some(i => WORN.has(i.slot) && GOLD_ARMOUR.test(i.itemId))) return line(fortress, eyeFacts);
			const gold = items.find(i => GOLD_ARMOUR.test(i.itemId));
			const prep = gold ? `consider equip_item ${gold.itemId.slice(10)} before searching` : 'consider gold armour if safely nearby; skip a gold hunt';
			return line(`${prep}; ${fortress}`, `no gold worn; ${eyeFacts}`);
		}
		if (pearlsMissing > 0) return line(`get ${eyesNeeded}-${eyesNeeded + 2} ender_pearls: warped-forest endermen, or barter_until with gold`, eyeFacts);
		return line('return home through the portal', eyeFacts);
	}
	const visitedNether = ok('visited:minecraft:the_nether') || [...(known.advancements ?? []), ...(o.advancements ?? [])]
		.some(id => /^(minecraft:)?story\/enter_the_nether$/.test(id));
	if (visitedNether) {
		if (portalOpen) return line('enter the End portal', 'portal open');
		// At the frames with eyes in hand, set them first: an observation lists at most 8 blocks of a kind, so the filled
		// count seen here is a lower bound and must not send the agent back to the Nether while it still holds eyes.
		if (eyesHeld > 0 && frames.some(b => b?.blockId === 'minecraft:end_portal_frame')) return line('set the ender_eyes in the empty End portal frames', eyeFacts);
		const portal = overworldPortal(o, memory);
		if ((rodsMissing > 0 || pearlsMissing > 0) && portal) {
			const survival = foodAdviceNeeded(o) ? `low health/hunger, food ${food} held: recover first; ` : 'food stocking optional while healthy; ';
			return line(`return via known Overworld portal at ${portal.x},${portal.y},${portal.z} to the Nether`, `${survival}active portal needs no iron pick or ignition; use held tools`);
		}
		// Without a retained portal, keep the existing preparation route; no coordinates are inferred from history.
		const rebuild = ROUTE.slice(0, ROUTE.findIndex(row => row.id === 'iron_pickaxe') + 1).find(row => !['food_stock', 'trip_wood', 'iron_trip'].includes(row.id) && !done(row));
		if (rebuild !== undefined) { const [next, why] = rebuild.next(facts); return line(next, `${why}; rebuild after the Nether visit`); }
		if (foodAdviceNeeded(o) && food < 10) return line(`obtain cooked_beef count ${20 - food} before going on (food ${food}/10)`, eyeFacts);
		if (frames.some(b => /^minecraft:(?:(?:mossy_|cracked_)?stone_bricks|iron_bars)$/.test(b?.blockId ?? '')))
			return line('find block end_portal_frame walks observed passages to the portal room; resume after handling danger or a blocked doorway', eyeFacts);
		if (rodsMissing > 0 || pearlsMissing > 0) return line(`go back to the Nether for ${[rodsMissing ? `${rodsMissing} blaze_rods` : null, pearlsMissing ? `${pearlsMissing} ender_pearls` : null].filter(Boolean).join(' and ')}`, eyeFacts);
		if (eyesNeeded > 0) return line(`craft ${eyesNeeded} ender_eyes from pearls and blaze powder`, eyeFacts);
		if (filled > 0 || frames.some(b => b?.blockId === 'minecraft:end_portal_frame')) return line(`set the ender_eyes in the empty End portal frames`, eyeFacts);
		return line('find structure stronghold follows thrown eyes and digs down; then find block end_portal_frame walks passages; resume after danger', eyeFacts);
	}
	// Round1 games6/8 lit portals, then spent the rest of the game on optional surface preparation; the portal bed is the
	// one step allowed there, and only from what is in reach.
	if (ok('frame:lit')) {
		const bed = portalBed(o, known, { lit: true, frame: litFrame(o, known) });
		return bed.step ? line(...bed.step) : line(PORTAL_ENTRY_NEXT, `${bed.skip}; ${ENTRY_FOOD}`);
	}
	const stage = (instincts === true ? INSTINCT_ROUTE : ROUTE).find(row => !done(row));
	if (stage !== undefined) {
		// Checked before lighting too: the sheep or wool in view now may be gone once the portal is lit.
		const bed = stage.id === 'portal' ? portalBed(o, known, { lit: false }) : null;
		const [next, why] = bed?.step ? [`before lighting the portal, ${bed.step[0]}`, bed.step[1]] : stage.next(facts);
		// Food on the way when hungry, once the stone tools are made: a full hunger bar needs no hunt.
		// Down a mine, food carried is eaten there (the eat reflex) rather than hunted: the hunt is a climb back up, so it is
		// named only once the food is gone.
		const restock = !['food', 'food_stock', 'wood', 'stone'].includes(stage.id) && foodNote === '' && (facts.below ? food === 0 : food < 10) && foodAdviceNeeded(o) ? `; low hunger/health, food ${food} held: obtain cooked_beef on the way` : '';
		return line(`${next}${restock}`, why);
	}
	return null;
}

// Down a mine: under the sky and below this height. Cave and tunnel floors are under it; a spawn on dry land is not.
const MINE_Y = 50;
function belowGround(o) {
	const at = o.position ?? o.player?.position ?? o.player;
	return o.world?.dimension === 'minecraft:overworld' && Number.isFinite(at?.y) && at.y < MINE_Y && o.player?.skyOpen !== true;
}

// The iron kit the portal route still needs from what is held: an iron pickaxe (3 iron), a shield (1), two buckets (3
// each, a filled one counts; none once a frame's 10 obsidian is carried) and flint and steel (1).
function kitLeft(count) {
	const items = [];
	if (!count(/^minecraft:(iron|diamond|netherite)_pickaxe$/)) items.push({ id: 'iron_pickaxe', count: 1, iron: 3, name: 'pickaxe 3' });
	if (!count(/^minecraft:shield$/)) items.push({ id: 'shield', count: 1, iron: 1, name: 'shield 1' });
	const buckets = count(/^minecraft:obsidian$/) >= 10 ? 0 : Math.max(0, 2 - count(/^minecraft:(bucket|water_bucket|lava_bucket)$/));
	if (buckets > 0) items.push({ id: 'bucket', count: count(/^minecraft:bucket$/) + buckets, iron: 3 * buckets, name: `${buckets} bucket${buckets > 1 ? 's' : ''} ${3 * buckets}` });
	if (!count(/^minecraft:flint_and_steel$/)) items.push({ id: 'flint_and_steel', count: 1, iron: 1, name: 'flint_and_steel 1' });
	return { items, iron: items.reduce((n, item) => n + item.iron, 0), parts: items.map(item => item.name).join(', ') };
}

// Logs the rest of the kit still takes from what is held, by obtain's own planner over the whole kit at once: sticks, the
// shield's planks, a table when none is carried, and plank fuel for smelting its iron unless coal is held or in view. The
// next pickaxe's sticks stay kept back as obtain keeps them (keepPickaxeMakings).
function tripLogs(o, kit) {
	if (kit.items.length === 0) return 0;
	try {
		const ids = kit.items.map(item => item.id);
		const held = keepPickaxeMakings(heldCounts(o), ids);
		const seen = new Set(remembered(o, 'blocks') ? [] : (o.blocks ?? []).filter(b => b?.visible !== false).map(b => String(b.blockId ?? '').replace(/^minecraft:/, '')));
		const [first, ...also] = kit.items.map(item => ({ ids: [item.id], count: item.count }));
		const plan = planObtain({ ...first, also }, { held, seen, dimension: o.world?.dimension });
		return plan.needs.filter(need => need.kind === 'mine' && need.blocks.length > 0 && need.blocks.every(block => /_(log|stem)$/.test(block)))
			.reduce((n, need) => n + need.count, 0);
	} catch { return 0; }
}

// The lit Overworld frame nearest the player, from the plan-check facts that made frame:lit hold.
function litFrame(o, known) {
	const at = o.position ?? o.player?.position ?? o.player;
	return (known.frames ?? []).filter(f => f?.lit === true && f.dimension === 'minecraft:overworld' && [f.x, f.y, f.z].every(Number.isFinite))
		.sort((a, b) => Math.hypot(a.x - at?.x, a.z - at?.z) - Math.hypot(b.x - at?.x, b.z - at?.z))[0] ?? null;
}

// knownSources already scopes and withdraws sources. Never refill an empty result from historical frames or poi.
function overworldPortal(o, memory) {
	if (o.world?.dimension !== 'minecraft:overworld' || remembered(o, 'world')) return null;
	const scoped = row => (row.worldId === undefined || row.worldId === o.world?.worldId)
		&& (row.dimension === undefined || row.dimension === o.world?.dimension);
	const known = memory?.known;
	if (known != null && !scoped(known)) return null;
	const rows = known != null ? [...(known.sightings ?? []).filter(r => /^(minecraft:)?nether_portal$/.test(r?.what)),
		...(known.blocks ?? []).filter(r => r?.blockId === 'minecraft:nether_portal')]
		: remembered(o, 'blocks') ? [] : [...(o.blocks ?? []), ...(o.landmarks ?? [])]
			.filter(r => r?.blockId === 'minecraft:nether_portal' && r.visible !== false && r.remembered !== true);
	const at = memory?.position ?? o.position ?? o.player?.position ?? o.player;
	const distance = row => [at?.x, at?.y, at?.z].every(Number.isFinite) ? Math.hypot(row.x - at.x, row.y - at.y, row.z - at.z) : 0;
	return rows.filter(r => r && scoped(r) && [r.x, r.y, r.z].every(Number.isFinite)).sort((a, b) => distance(a) - distance(b))[0] ?? null;
}
