// The kit habit: game sense the body keeps on its own after each obtain that succeeds, from what it already holds and
// with no extra mining: a shield in the off hand, iron armour worn from spare iron, food in reach of the eat reflex.
// CP2r (16 games): the shield was owned 45-53% of the time, lost only by dying and back after 2 of 11 such deaths;
// armour was worn in 0 of 16 games though 12 of them held 9+ iron at some point; the eat reflex slept 53-66% of the
// time with no food in the hotbar; and the model followed route advice for these steps in about a third of cases.

import { heldCounts, keepPickaxeMakings, planObtain } from './obtain-plan.mjs';
import { getSwitch } from './switches.mjs';

/** The habit stays out of the way while hurt: low health is recovery's job, not kit's. */
export const KIT_MIN_HEALTH = 10;
/** Most steps one obtain adds: a craft and its equip, a hotbar move and an equip left over from before. */
export const KIT_MAX_STEPS = 4;
/** Each kit craft runs from held materials, so it needs no search; a minute covers placing a table and crafting. */
export const KIT_CRAFT_TIMEOUT_MS = 60_000;
/** A furnace takes 10 s an item: a craft that smelts held raw iron first gets that much more, with some slack. */
export const KIT_SMELT_MS = 12_000;
/** kit.ironTripArmour: the most one top-up of the chestplate's iron at the ore may take, search included. */
export const IRON_TOPUP_MS = 150_000;
/** The iron trip is down a mine: under cover and below this height (skill-fits MINE_Y). */
const MINE_Y = 50;
/** The obtains that make the route's iron kit: a top-up of the chestplate's iron follows only these. */
export const IRON_KIT_ITEMS = /^(minecraft:)?(iron_pickaxe|iron_ingot|raw_iron|bucket|water_bucket|lava_bucket|shield|flint_and_steel)$/;

const FOOD = /^minecraft:(cooked_(beef|porkchop|mutton|chicken|rabbit|cod|salmon)|bread|baked_potato|golden_carrot|pumpkin_pie|rabbit_stew|mushroom_stew|beetroot_soup|beef|porkchop|mutton|rabbit|cod|salmon|apple|carrot|potato|sweet_berries|glow_berries|melon_slice|beetroot|cookie|dried_kelp)$/;
// Iron pieces in the order of armour points per iron (chestplate 6 for 8, leggings 5 for 7, boots 2 for 4, helmet 2 for 5).
const ARMOUR = Object.freeze([
	{ itemId: 'minecraft:iron_chestplate', slot: 'chest', iron: 8, part: /_chestplate$/ },
	{ itemId: 'minecraft:iron_leggings', slot: 'legs', iron: 7, part: /_leggings$/ },
	{ itemId: 'minecraft:iron_boots', slot: 'feet', iron: 4, part: /_boots$/ },
	{ itemId: 'minecraft:iron_helmet', slot: 'head', iron: 5, part: /_helmet$/ },
]);
const PLANKS = /^minecraft:[a-z_]+_planks$/;
const LOGS = /^minecraft:[a-z_]+_(log|wood|stem|hyphae)$/;

// A pickaxe about to break is not one the route can mine with: obtain's planner (heldCounts) skips it, so its
// replacement's iron stays reserved.
const soundPickaxe = items => [...heldCounts({ inventory: { items } })].some(([id, n]) => /^(iron|diamond|netherite)_pickaxe$/.test(id) && n > 0);
const numbered = item => Number.isInteger(item.slot) && item.slot >= 0 && item.slot <= 35;
const bare = id => String(id ?? '').replace(/^minecraft:/, '');
const inHotbar = item => item.slot === 'mainhand' || item.slot === 'offhand' || item.hotbar === true || Number.isInteger(item.slot) && item.slot <= 8;

/**
 * Iron the rest of the route still needs from what is held now: an iron pickaxe (3), the shield (1), two buckets (3
 * each, a filled one counts) and flint and steel (1). Only iron beyond this goes to armour, so the habit never slows the
 * route to the portal.
 */
export function ironReserved(items, { environment = process.env } = {}) {
	const has = re => items.some(item => re.test(item.itemId ?? ''));
	const buckets = items.filter(item => /^minecraft:(bucket|water_bucket|lava_bucket)$/.test(item.itemId ?? '')).reduce((n, item) => n + item.count, 0);
	// kit.rekit: the second bucket waits for the chestplate. With both buckets reserved, 13 iron in the bag made no armour
	// (fresh game g5 on main 069e471), and 40 of 42 deaths in those 8 games had no armour on.
	const wanted = rekitEnabled(environment) && !items.some(item => item.slot === 'chest') ? 1 : 2;
	return (soundPickaxe(items) ? 0 : 3) + (has(/^minecraft:shield$/) ? 0 : 1)
		+ Math.max(0, wanted - buckets) * 3 + (has(/^minecraft:flint_and_steel$/) ? 0 : 1);
}

/** MINEAGEN_REKIT=off turns the re-kit changes off (an A/B round's off arm); they are on otherwise. */
export function rekitEnabled(environment = process.env) {
	return getSwitch('kit.rekit', environment).value;
}

/** MINEAGEN_IRON_TRIP_ARMOUR=off turns the iron trip's chestplate top-up off (an A/B round's off arm); it is on otherwise. */
export function ironTripArmourEnabled(environment = process.env) {
	return getSwitch('kit.ironTripArmour', environment).value;
}

/**
 * Whether a kit craft runs from what is held alone: the whole obtain plan for it (a table to make, planks from logs)
 * needs nothing gathered. It plans as obtain does, with the next pickaxe's sticks kept back (keepPickaxeMakings) and,
 * under cover, from everything held; a table counts only when held, never one merely in view. reserved: items the
 * obtain just handed back ({ids, count}), never spent on kit.
 */
export function craftsFromHeld(o, itemId, { reserved = null, count = 1 } = {}) {
	const counts = heldCounts(o);
	const take = map => {
		if (reserved === null) return map;
		const left = new Map(map);
		// Every member of a family request is kept back in full: which member the caller counts on is unknown.
		for (const member of reserved.ids.map(bare)) if (left.has(member)) left.set(member, Math.max(0, left.get(member) - reserved.count));
		return left;
	};
	const ids = [bare(itemId)];
	const sound = plan => plan.needs.length === 0 && plan.unreachable.length === 0;
	try {
		const held = take(keepPickaxeMakings(counts, ids));
		if (sound(planObtain({ ids, count }, { held, dimension: o?.world?.dimension }))) return true;
		return o?.player?.skyOpen === false && sound(planObtain({ ids, count }, { held: take(counts), dimension: o?.world?.dimension }));
	} catch { return false; }
}

/**
 * The next kit step from a fresh observation, or null when the kit is kept or the body is hurt:
 * {kind:'equip', sourceSlot, targetSlot, itemId}, {kind:'hotbar', sourceSlot, hotbarSlot, itemId} or {kind:'craft', itemId}.
 * Equips come first (free), then food in reach, then a shield, then one armour piece from spare iron, then a spare
 * shield in the Overworld once the chestplate and boots are worn.
 * reserved ({ids, count}): what the obtain just handed back; kit crafts never spend it.
 * topUp: kit.ironTripArmour may mine the chestplate's iron now (an iron kit obtain just ended, no top-up lately):
 * {kind:'craft', itemId:'minecraft:raw_iron', count, timeoutMs, topUp:true} when the body is down a mine with no chestplate.
 */
export function nextKitStep(o, { reserved = null, topUp = false } = {}) {
	const items = (o?.inventory?.items ?? []).filter(item => item?.count > 0 && typeof item.itemId === 'string');
	if (!Array.isArray(o?.inventory?.items)) return null;
	const health = o?.player?.health;
	if (!Number.isFinite(health)) return null;
	// kit.rekit: putting on armour already carried takes no time, so it happens hurt too; crafting waits for health.
	const hurt = health < KIT_MIN_HEALTH;
	if (hurt && !rekitEnabled()) return null;
	const worn = slot => items.some(item => item.slot === slot);
	// The selected hotbar slot is observed only as 'mainhand': shields and armour held there equip from its slot number.
	const selected = o.inventory.selectedSlot;
	const heldSlot = item => numbered(item) ? item.slot : item.slot === 'mainhand' && Number.isInteger(selected) && selected >= 0 && selected <= 8 ? selected : null;
	const shields = items.filter(item => item.itemId === 'minecraft:shield');
	// Another item in the off hand (torches) is the player's choice, and equip would not swap it: the shield waits.
	const offhandFree = !items.some(item => item.slot === 'offhand' && item.itemId !== 'minecraft:shield');
	if (offhandFree && !shields.some(item => item.slot === 'offhand')) {
		const stored = shields.find(item => heldSlot(item) !== null);
		if (stored) return { kind: 'equip', sourceSlot: heldSlot(stored), targetSlot: 'offhand', itemId: stored.itemId };
	}
	for (const piece of ARMOUR) {
		if (worn(piece.slot)) continue;
		const stored = items.find(item => heldSlot(item) !== null && piece.part.test(item.itemId));
		if (stored) return { kind: 'equip', sourceSlot: heldSlot(stored), targetSlot: piece.slot, itemId: stored.itemId };
	}
	if (hurt) return null;
	const food = items.filter(item => FOOD.test(item.itemId));
	if (food.length > 0 && !food.some(inHotbar)) {
		const stored = food.find(numbered);
		const taken = new Set(items.filter(item => Number.isInteger(item.slot) && item.slot <= 8).map(item => item.slot));
		if (Number.isInteger(o.inventory.selectedSlot)) taken.add(o.inventory.selectedSlot);
		const free = [8, 7, 6, 5, 4, 3, 2, 1, 0].find(slot => !taken.has(slot));
		if (stored && free !== undefined) return { kind: 'hotbar', sourceSlot: stored.slot, hotbarSlot: free, itemId: stored.itemId };
	}
	const count = re => items.filter(item => re.test(item.itemId)).reduce((n, item) => n + item.count, 0);
	// kit.ironTripArmour: raw iron counts as iron too (a craft smelts it first). In 10 fresh games of 27 Nov the trip
	// ended with 2-7 raw iron unsmelted in 6, and the habit counted only ingots.
	const tripArmour = ironTripArmourEnabled();
	const ingotsReserved = reserved !== null && reserved.ids.some(id => bare(id) === 'iron_ingot');
	// Raw iron the caller asked for is never smelted for armour: obtain's planner would take it from the held stack.
	const rawReserved = reserved !== null && reserved.ids.some(id => bare(id) === 'raw_iron');
	const iron = tripArmour && !rawReserved ? /^minecraft:(iron_ingot|raw_iron)$/ : /^minecraft:iron_ingot$/;
	const heldIngots = count(/^minecraft:iron_ingot$/);
	const kept = ingotsReserved ? reserved.count : 0;
	const ingots = Math.max(0, count(iron) - kept);
	const craftable = (itemId, count = 1) => craftsFromHeld(o, itemId, { reserved, count });
	// The raw iron a craft of `need` iron smelts first, and the time that takes on top of the craft's minute.
	const freeIngots = Math.max(0, heldIngots - kept);
	const smeltTime = need => KIT_SMELT_MS * Math.max(0, need - freeIngots);
	// With ingots reserved, a craft that smelts smelts its raw iron as its own step first: obtain's planner spends any
	// ingot held, so a chestplate from 3 reserved ingots and 8 raw would smelt 5 and spend the 3 the caller asked for.
	const smeltFirst = (need, timeoutMs, topUp = false) => tripArmour && ingotsReserved && smeltTime(need) > 0
		? { kind: 'craft', itemId: 'minecraft:iron_ingot', count: heldIngots + need - freeIngots, timeoutMs, smelt: true, ...(topUp ? { topUp } : {}) } : null;
	const wood = count(PLANKS) + 4 * count(LOGS);
	// The iron pickaxe comes first: its 3 ingots are never spent on the shield (obtain iron_ingot count 3 for it would hand back 2).
	const pickaxeOwed = soundPickaxe(items) ? 0 : 3;
	if (shields.length === 0 && ingots >= 1 + pickaxeOwed && wood >= 6 && craftable('minecraft:shield')) return { kind: 'craft', itemId: 'minecraft:shield' };
	const spare = ingots - ironReserved(items);
	const chestplate = items.some(item => /_chestplate$/.test(item.itemId));
	const at = o.position ?? o.player?.position ?? o.player;
	const mineDown = (o.world?.dimension ?? 'minecraft:overworld') === 'minecraft:overworld' && o.player?.skyOpen === false && Number.isFinite(at?.y) && at.y < MINE_Y;
	for (const piece of ARMOUR) {
		if (worn(piece.slot) || items.some(item => piece.part.test(item.itemId))) continue;
		// kit.ironTripArmour: leggings take 7 of the chestplate's 8 for fewer points, so they wait for it (A/B game
		// freshrb: 7 spare became leggings and the chestplate never came).
		if (tripArmour && !chestplate && piece.slot === 'legs') continue;
		if (piece.iron > spare) continue;
		if (!craftable(piece.itemId)) {
			// kit.ironTripArmour: the chestplate's iron held but nothing to smelt it with (A/B game freshd1 ended with 10
			// raw iron, a furnace and no fuel): its obtain gathers the fuel too, as a top-up, down a mine only.
			if (tripArmour && topUp && piece.slot === 'chest' && mineDown) {
				return smeltFirst(piece.iron, IRON_TOPUP_MS + smeltTime(piece.iron), true)
					?? { kind: 'craft', itemId: piece.itemId, timeoutMs: IRON_TOPUP_MS + smeltTime(piece.iron), topUp: true };
			}
			continue;
		}
		const smelt = smeltFirst(piece.iron, KIT_CRAFT_TIMEOUT_MS + smeltTime(piece.iron));
		if (smelt !== null) return smelt;
		return tripArmour && smeltTime(piece.iron) > 0 ? { kind: 'craft', itemId: piece.itemId, timeoutMs: KIT_CRAFT_TIMEOUT_MS + smeltTime(piece.iron) }
			: { kind: 'craft', itemId: piece.itemId };
	}
	// kit.ironTripArmour: at the ore for the iron kit with no chestplate, the chestplate's 8 iron (with the kit's own still
	// owed) is mined now, in the same trip. The route's armour row asked for it 93 times in 10 fresh games of 27 Nov and
	// the model took it 0 times; a gate at the portal (#304) found no ore there. Down a mine only, with a pickaxe that
	// mines iron, capped at IRON_TOPUP_MS; the runtime spaces top-ups out, so a seed short of iron never stalls on it.
	const minesIron = [...heldCounts({ inventory: { items } })].some(([id, n]) => /^(stone|iron|diamond|netherite)_pickaxe$/.test(id) && n > 0);
	if (tripArmour && topUp && !chestplate && mineDown && minesIron) {
		const short = ironReserved(items) + ARMOUR[0].iron - ingots;
		if (short > 0) return { kind: 'craft', itemId: 'minecraft:raw_iron', count: count(/^minecraft:raw_iron$/) + short, timeoutMs: IRON_TOPUP_MS, topUp: true };
	}
	// COMBAT-2: a spare shield before the Nether, from iron left once the route's own armour is on (chestplate and boots,
	// skill-fits KIT_ARMOUR), so it never takes that armour's iron. A shield that breaks there ("the shield broke") then
	// has its replacement in the pack, which the equip step above puts in the off hand.
	// Counted as obtain's planner counts them: a shield about to break is not one (heldCounts), so the step asks for one
	// more than the usable ones and crafts exactly one, whose 1 iron the spare covers.
	const routeArmour = worn('chest') && worn('feet');
	const usable = heldCounts(o).get('shield') ?? 0;
	if (shields.length === 1 && usable <= 1 && routeArmour && spare >= 1 && wood >= 6 && (o.world?.dimension ?? 'minecraft:overworld') === 'minecraft:overworld'
		&& craftable('minecraft:shield', usable + 1)) return { kind: 'craft', itemId: 'minecraft:shield', count: usable + 1 };
	return null;
}

/** MINEAGEN_KIT_HABIT=off turns the habit off (an A/B round's off arm); it is on otherwise. */
export function kitHabitEnabled(environment = {}) {
	return getSwitch('kit.habit', environment).value;
}

/**
 * Runs kit steps after an obtain: body is obtain's body (observe, act), craft(itemId, count, timeoutMs) runs a nested
 * obtain (timeoutMs undefined: the kit craft's own). Stops at the first step that does not succeed, a repeated craft, or
 * the step cap. Returns the steps done; stop.result is set to the result of the step that did not succeed (an
 * interrupted one carries its running action). topUp: whether kit.ironTripArmour may mine the chestplate's iron in this
 * run; onTopUp() is called when it starts, so the caller can space the next one out.
 */
export async function keepKit(body, craft, { stopped = () => false, reserved = null, stop = {}, topUp = false, onTopUp = () => {} } = {}) {
	const done = [], crafted = new Set();
	let toppedUp = false;
	// A top-up adds two steps: the mining itself and the chestplate's craft after it (its equip is the usual one).
	const cap = KIT_MAX_STEPS + (topUp && ironTripArmourEnabled() ? 2 : 0);
	for (let index = 0; index < cap && !stopped(); index += 1) {
		// A top-up's chestplate may follow its raw iron in the same run (its fuel gathered then); a repeat of either ends the run.
		const step = nextKitStep(await body.observe(), { reserved, topUp });
		if (step === null) break;
		let result;
		const name = step.itemId.replace(/^minecraft:/, '');
		if (step.kind === 'equip') result = await body.act('equip_item', { sourceSlot: step.sourceSlot, targetSlot: step.targetSlot, expectedItemId: step.itemId });
		else if (step.kind === 'hotbar') result = await body.act('select_tool', { sourceSlot: step.sourceSlot, hotbarSlot: step.hotbarSlot, expectedItemId: step.itemId, minRemainingDurability: 0 });
		else {
			if (crafted.has(step.itemId)) break;
			crafted.add(step.itemId);
			if (step.topUp && !toppedUp) { toppedUp = true; onTopUp(); }
			// count: the total to hold (a spare shield is the second one), as obtain counts.
			result = await craft(step.itemId, step.count ?? 1, step.timeoutMs);
		}
		if (result?.state !== 'SUCCEEDED') {
			stop.result = result ?? null;
			done.push(step.topUp ? `${step.itemId === 'minecraft:raw_iron' ? 'mining the iron_chestplate\'s iron' : `${name} with its fuel`} stopped (${result?.reasonCode ?? result?.state ?? 'no result'})`
				: `${step.kind} ${name} stopped (${result?.reasonCode ?? result?.state ?? 'no result'})`);
			break;
		}
		done.push(step.kind === 'equip' ? `wore ${name} (${step.targetSlot})` : step.kind === 'hotbar' ? `${name} to hotbar ${step.hotbarSlot}`
			: step.topUp && step.itemId === 'minecraft:raw_iron' ? `mined ${step.count} raw_iron for the iron_chestplate`
				: step.smelt ? `smelted iron_ingot to ${step.count} for armour` : `crafted ${name}`);
	}
	return done;
}
