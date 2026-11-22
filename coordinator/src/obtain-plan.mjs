// obtain: what still has to be gathered and crafted to hold N of an item, worked out from the game's own data
// (config/howto-index.json: recipes, tags, block drops, harvest tools, mob drops, world generation). The plan is netted
// against what the body holds and re-made from a fresh inventory before every move, so it never runs a stale list.
// Choices between ways are by a rough cost in body time: a log is cheap, an ore found by digging is dear, a tool not yet
// held adds its own cost, a block in view is cheaper than one to search for.
import { howtoIndex, resolveHowtoTopic } from './howto.mjs';

// Stations the body can use: crafting in the inventory grid or at a table, smelting in a furnace. Blast furnaces,
// smokers and campfires smelt the same things slower or need more, stonecutters and smithing are out of scope.
const STATIONS = new Set(['inventory', 'crafting_table', 'furnace']);
const SMELT_TICKS = 200;
const PLANK_FUEL_TICKS = 300;
const COAL_FUEL_TICKS = 1600;
const CYCLE = Symbol('cycle');
// Mining cost per block once its tool is held, by kind; anything else the world generates costs DEFAULT_MINE.
const DEFAULT_MINE = 10;
const MINE_COSTS = [
	[/_(log|stem)$/, 1],
	[/^(stone|cobblestone|dirt|grass_block|sand|red_sand|gravel|clay|andesite|diorite|granite|tuff|snow_block)$/, 1.5],
	[/^(deepslate|cobbled_deepslate)$/, 6],
	[/^(deepslate_)?coal_ore$/, 4],
	[/^(deepslate_)?copper_ore$/, 6],
	[/^(deepslate_)?iron_ore$/, 8],
	[/^(deepslate_)?(redstone|lapis)_ore$/, 14],
	[/^(deepslate_)?gold_ore$/, 16],
	[/^(deepslate_)?diamond_ore$/, 30],
	[/^(deepslate_)?emerald_ore$/, 60],
];
// Drops that come only some of the time: breaks per item (flint is 1 in 10 gravel).
const CHANCE_BREAKS = { flint: 10 };
const HOSTILE = /^(zombie|husk|drowned|skeleton|stray|bogged|parched|spider|cave_spider|creeper|enderman|witch|slime|phantom|pillager|vindicator|evoker|ravager|silverfish|guardian|elder_guardian|warden|breeze|zombie_villager)$/;
const PASSIVE_KILL = 4, HOSTILE_KILL = 12;
// Kill ways outside the Overworld: blaze rods and ender pearls, the eye of ender's makings.
const AWAY_KILLS = new Set(['blaze', 'enderman']);
// Kills per item for a mob's rare drop (zombie iron, carrots and potatoes, drowned copper): about 1 in 40 in vanilla.
const RARE_DROP_KILLS = 40;
const RARE_VARIANT = { sheep: (id) => id.endsWith('_wool') && id !== 'white_wool' };
const SEEN_FACTOR = 0.4;
// ServerDigController.WORN_USES (2) plus one: the last use before the body refuses the tool.
const WORN_USES = 3;
const SPARE_STICKS = 8;
const STATION_COST = { crafting_table: 1.5, furnace: 9 };

export const OBTAIN_STATIONS = Object.freeze(['crafting_table', 'furnace']);
const EQUIPMENT = /_(pickaxe|shovel|axe|hoe|sword|spear|helmet|chestplate|leggings|boots|horse_armor|nautilus_armor)$/;
const short = (id) => String(id ?? '').replace(/^(#?)minecraft:/, '$1');
const full = (id) => `minecraft:${short(id)}`;

/**
 * The index ids a request names: an exact item, a tag, or a plain word that names a family (bed, boat, planks, log)
 * as every item whose id ends in _<word>. Returns { ids, label } or { ids: [], candidates }.
 */
export function resolveObtainItem(name, index = howtoIndex()) {
	const raw = short(String(name).trim().toLowerCase().replace(/[\s-]+/g, '_'));
	if (index.tags[raw.startsWith('#') ? raw : `#${raw}`] && !index.recipes[raw] && !index.blockDrops[raw] && !index.mobDrops[raw]) {
		const tag = raw.startsWith('#') ? raw : `#${raw}`;
		return { ids: [...index.tags[tag]], label: tag };
	}
	if (index.recipes[raw] || index.blockDrops[raw] || index.mobDrops[raw]) return { ids: [raw], label: raw };
	const family = [...new Set([...Object.keys(index.recipes), ...Object.keys(index.blockDrops), ...Object.keys(index.mobDrops)])]
		.filter((id) => id.endsWith(`_${raw}`) && !id.includes(`_chest_${raw}`)).sort();
	if (family.length > 0) return { ids: family, label: raw };
	const resolved = resolveHowtoTopic(raw, index);
	if (resolved.id && (index.recipes[resolved.id] || index.blockDrops[resolved.id] || index.mobDrops[resolved.id])) return { ids: [resolved.id], label: resolved.id };
	return { ids: [], candidates: resolved.candidates ?? [] };
}

export function heldCounts(observation) {
	const counts = new Map();
	for (const row of observation?.inventory?.items ?? []) {
		if (!row || !(row.count > 0) || ['head', 'chest', 'legs', 'feet'].includes(row.slot)) continue;
		// A tool about to break is not a tool the plan can count on: the body digs only with more than 2 uses left.
		if (row.maxDamage > 0 && Number.isFinite(row.damage) && row.maxDamage - row.damage <= WORN_USES) continue;
		const id = short(row.itemId);
		counts.set(id, (counts.get(id) ?? 0) + row.count);
	}
	return counts;
}

export function keepPickaxeMakings(held, ids = [], index = howtoIndex()) {
	const pickaxe = (id) => /_pickaxe$/.test(short(id));
	if (ids.length > 0 && ids.every(pickaxe)) return held;
	if (![...held].some(([id, n]) => pickaxe(id) && n > 0)) return held;
	const kept = new Map();
	let sticks = Math.min(held.get('stick') ?? 0, SPARE_STICKS);
	if (sticks > 0) kept.set('stick', sticks);
	const most = (ids) => ids.filter((id) => (held.get(id) ?? 0) > 0).sort((a, b) => held.get(b) - held.get(a))[0];
	const planks = most(index.tags['#planks'] ?? []);
	if (sticks < SPARE_STICKS && planks && held.get(planks) >= 2) { kept.set(planks, 2); sticks += 4; }
	const log = sticks < SPARE_STICKS ? most(index.tags['#logs'] ?? []) : undefined;
	if (log) { kept.set(log, 1); sticks += 8; }
	if (sticks < 2) return held;
	const left = new Map(held);
	for (const [id, n] of kept) left.set(id, left.get(id) - n);
	return left;
}

/**
 * Rough body-time cost of one of each item and the way that achieves it, under what is held and seen. Memoized per
 * planner; a value reached through a cycle is not memoized.
 */
class Costs {
	constructor(index, held, seen, dimension) {
		this.index = index; this.held = held; this.seen = seen; this.dimension = short(dimension); this.memo = new Map();
	}

	members(spec) {
		if (spec.startsWith('#')) return this.index.tags[spec] ?? [];
		return spec.split('|');
	}

	of(id, path = []) {
		if (this.memo.has(id)) return this.memo.get(id);
		if (path.includes(id)) return { cost: Infinity, cycle: true };
		const next = [...path, id];
		let best = { cost: Infinity }, cycle = false;
		const consider = (way, cost) => { if (cost < best.cost) best = { cost, way }; };
		for (const [station, yieldCount, inputs, recipeName] of this.index.recipes[id] ?? []) {
			if (!STATIONS.has(station)) continue;
			if (station === 'furnace' && inputs.every(([spec]) => this.members(spec).every((member) => EQUIPMENT.test(member)))) continue;
			let cost = station === 'inventory' ? 0.1 : 0.2;
			if (station === 'furnace') cost += 0.4;
			for (const [spec, count] of inputs) {
				const input = this.spec(spec, next, count);
				if (input.cycle) cycle = true;
				cost += input.cost * count;
			}
			cost /= yieldCount;
			if (station !== 'inventory' && !this.held.has(station)) cost += STATION_COST[station] / 4;
			consider({ kind: station === 'furnace' ? 'smelt' : 'craft', station, yieldCount, inputs, recipeId: recipeName ?? id }, cost);
		}
		// Every block that drops it is one way: the body takes whichever it finds, the cheapest first.
		const mined = [];
		for (const [block, flags] of this.index.blockDrops[id] ?? []) {
			if (/[sh]/.test(flags)) continue;
			// Generation restricts searches, but a block actually seen here is available here.
			if (!this.index.worldgen[block]?.d?.includes(this.dimension) && !this.seen.has(block)) continue;
			let cost = MINE_COSTS.find(([pattern]) => pattern.test(block))?.[1] ?? DEFAULT_MINE;
			if (block.startsWith('deepslate_')) cost *= 1.6;
			if (flags.includes('r')) cost *= CHANCE_BREAKS[id] ?? 3;
			if (flags.includes('p')) cost *= 2;
			if (this.seen.has(block)) cost *= SEEN_FACTOR;
			const tool = this.tool(block, next);
			if (tool.cycle) cycle = true;
			if (tool.cost < Infinity) mined.push({ block, cost: cost + tool.cost, tool: tool.id });
		}
		mined.sort((a, b) => a.cost - b.cost);
		if (mined.length > 0) consider({ kind: 'mine', blocks: mined.map((row) => row.block), tool: mined[0].tool }, mined[0].cost);
		const otherWay = best.cost < Infinity;
		for (const [mob, flags] of this.index.mobDrops[id] ?? []) {
			// A mob is a way where it spawns (cows only in the Overworld). Outside the Overworld only the eye hunts count: a
			// coal or gold plan must not send the body after wither skeletons, ghasts or piglins.
			if (!(this.index.mobSpawns?.[mob] ?? []).some((place) => place.split(' ')[0] === this.dimension)) continue;
			if (this.dimension !== 'overworld' && !AWAY_KILLS.has(mob)) continue;
			let cost = HOSTILE.test(mob) ? HOSTILE_KILL : PASSIVE_KILL;
			if (flags.includes('r')) cost *= otherWay && flags.includes('k') ? RARE_DROP_KILLS : 3;
			// Most of a mob's kind look alike: dyed sheep are rare, so only white wool is a sheep's usual drop.
			if (RARE_VARIANT[mob]?.(id)) cost *= 10;
			if (this.seen.has(mob)) cost *= SEEN_FACTOR;
			consider({ kind: 'kill', mobs: [mob] }, cost);
		}
		if (!(cycle && best.cost === Infinity)) this.memo.set(id, best);
		return cycle && best.cost === Infinity ? { cost: Infinity, cycle: true } : best;
	}

	spec(spec, path, count = 1) {
		// A member already on the path is a cycle (raw iron from a block of raw iron), even when one is held.
		const members = this.members(spec).filter((member) => !path.includes(member));
		if (members.length === 0) return { cost: Infinity, cycle: true };
		const held = members.reduce((sum, member) => sum + (this.held.get(member) ?? 0), 0);
		if (held >= count) return { cost: 0.05 };
		let best = Infinity, cycle = false;
		for (const member of members) {
			const result = this.of(member, path);
			if (result.cycle) cycle = true;
			best = Math.min(best, result.cost);
		}
		if (best === Infinity) return { cost: Infinity, cycle };
		return { cost: (held * 0.05 + (count - held) * best) / count };
	}

	/** The harvest tool a block needs: nothing, one already held, or the cheapest tool of its minimum tier. */
	tool(block, path) {
		const set = this.index.toolSets[this.index.harvest[block]];
		if (set === undefined || set.all.length === 0) return { id: null, cost: 0 };
		if (set.all.some((tool) => (this.held.get(tool) ?? 0) > 0)) return { id: null, cost: 0, held: true };
		let best = { id: null, cost: Infinity }, cycle = false;
		for (const tool of set.min) {
			const result = this.of(tool, path);
			if (result.cycle) cycle = true;
			if (result.cost < best.cost) best = { id: tool, cost: result.cost };
		}
		return { ...best, cycle: cycle && best.cost === Infinity };
	}
}

/**
 * The plan to hold `count` of any of `ids`: needs (raw items to mine or kill for, with the tool each needs first) and
 * ops (crafts and smelts in an order where every op's inputs come before it), netted against what is held.
 *   also: more targets [{ ids, count }] planned in the same pool, after the first (a whole kit: one iron need for the
 *   pickaxe, shield, buckets and flint and steel together, sharing stations, tools and fuel).
 *   held: Map short id -> count. seen: Set of short block/mob ids in view or remembered nearby.
 *   stations: { crafting_table: boolean, furnace: boolean } for one placed within walking reach.
 * Returns { ops, needs, fuel, unreachable }: unreachable lists ids with no way the body can do.
 */
export function planObtain({ ids, count, also = [] }, { held = new Map(), seen = new Set(), stations = {}, index = howtoIndex(), coalFirst = false, dimension = 'minecraft:overworld', costHeld = held } = {}) {
	const costs = new Costs(index, costHeld, seen, dimension);
	const pool = new Map(held);
	const ops = new Map(), needs = new Map(), unreachable = new Set(), stationNeed = new Set();
	let smelts = 0;
	const take = (members, n) => {
		let left = n;
		for (const member of [...members].sort((a, b) => (pool.get(b) ?? 0) - (pool.get(a) ?? 0))) {
			const used = Math.min(pool.get(member) ?? 0, left);
			if (used > 0) { pool.set(member, pool.get(member) - used); left -= used; }
			if (left === 0) break;
		}
		return left;
	};
	const addNeed = (accept, way, n, tool) => {
		const key = `${way.kind}:${[...accept].sort().join(',')}`;
		const need = needs.get(key) ?? { kind: way.kind, accept: [...new Set(accept)], blocks: [], mobs: [], count: 0, tool: null, chance: false };
		need.count += n;
		for (const block of way.blocks ?? []) if (!need.blocks.includes(block)) need.blocks.push(block);
		for (const mob of way.mobs ?? []) if (!need.mobs.includes(mob)) need.mobs.push(mob);
		if (tool) need.tool = tool;
		if (accept.some((id) => CHANCE_BREAKS[id])) need.chance = true;
		needs.set(key, need);
	};
	const addOp = (key, op, times, inputs) => {
		const existing = ops.get(key);
		if (existing) { existing.times += times; for (const input of inputs) { const row = existing.inputs.find((r) => r.spec === input.spec); if (row) row.count += input.count; else existing.inputs.push({ ...input }); } return; }
		ops.set(key, { ...op, times, inputs: inputs.map((input) => ({ ...input })) });
	};
	const tools = new Set();
	const demand = (spec, n, path) => {
		// Never through itself, and never deeper than any real chain (the iron pickaxe is 6 deep).
		const members = costs.members(spec).filter((member) => !path.includes(member));
		if (members.length === 0 || path.length > 12) { unreachable.add(spec); return; }
		const shortfall = take(members, n);
		if (shortfall === 0) return;
		// A member made from other members of the same group (oak wood from oak logs) is never a way to the group.
		const priced = members.map((member) => ({ member, ...costs.of(member, path) })).filter((row) => row.cost < Infinity)
			.filter((row) => members.length === 1 || row.way.kind === 'mine' || row.way.kind === 'kill' || !row.way.inputs.some(([input]) => costs.members(input).some((m) => members.includes(m))))
			.sort((a, b) => a.cost - b.cost);
		if (priced.length === 0) { unreachable.add(spec); return; }
		const ties = priced.filter((row) => row.cost <= priced[0].cost * 1.25 + 0.01);
		// Any member mined will do (any log, any stone material): one shared demand over every member mined the same way,
		// its blocks cheapest first, so the body takes whichever it finds.
		if (members.length > 1 && priced[0].way.kind === 'mine') {
			const mined = priced.filter((row) => row.way.kind === 'mine' && row.way.tool === priced[0].way.tool);
			const tool = priced[0].way.tool;
			addNeed(mined.map((row) => row.member), { kind: 'mine', blocks: [...new Set(mined.flatMap((row) => row.way.blocks))] }, shortfall, tool);
			if (tool) demandTool(tool, path);
			return;
		}
		if (ties.length > 1 && ties.every((row) => row.way.kind === 'craft' && row.way.station === ties[0].way.station && row.way.yieldCount === ties[0].way.yieldCount && row.way.inputs.length === 1)) {
			const way = ties[0].way, times = Math.ceil(shortfall / way.yieldCount);
			const inputSpec = [...new Set(ties.flatMap((row) => costs.members(row.way.inputs[0][0])))].join('|');
			const per = way.inputs[0][1];
			const surplus = times * way.yieldCount - shortfall;
			if (surplus > 0) pool.set(ties[0].member, (pool.get(ties[0].member) ?? 0) + surplus);
			demand(inputSpec, per * times, [...path, spec]);
			if (way.station !== 'inventory') stationNeed.add(way.station);
			addOp(`any:${spec}`, { kind: 'craft', station: way.station, yieldCount: way.yieldCount, outputs: ties.map((row) => row.member),
				choices: ties.map((row) => ({ output: row.member, recipeId: row.way.recipeId, input: costs.members(row.way.inputs[0][0]) })) }, times, [{ spec: inputSpec, count: per * times }]);
			return;
		}
		const { member, way } = priced[0];
		if (way.kind === 'mine' || way.kind === 'kill') {
			addNeed([member], way, shortfall, way.tool);
			if (way.tool) demandTool(way.tool, path);
			return;
		}
		const times = Math.ceil(shortfall / way.yieldCount);
		const surplus = times * way.yieldCount - shortfall;
		if (surplus > 0) pool.set(member, (pool.get(member) ?? 0) + surplus);
		const inputs = way.inputs.map(([inputSpec, per]) => ({ spec: inputSpec, count: per * times }));
		for (const input of inputs) demand(input.spec, input.count, [...path, member]);
		if (way.station !== 'inventory') stationNeed.add(way.station);
		if (way.kind === 'smelt') smelts += times;
		addOp(`${way.kind}:${member}`, { kind: way.kind, station: way.station, yieldCount: way.yieldCount, outputs: [member], recipeId: way.recipeId }, times, inputs);
	};
	// A harvest tool is kept, not used up: one is enough for every need behind it.
	const demandTool = (tool, path) => {
		if (tools.has(tool)) return;
		tools.add(tool);
		demand(tool, 1, path);
	};
	demand(ids.length === 1 ? ids[0] : ids.join('|'), count, []);
	for (const target of also) demand(target.ids.length === 1 ? target.ids[0] : target.ids.join('|'), target.count, []);
	// Stations: one placed in reach or held serves every op at it; otherwise it is made like any item.
	const resolveStations = () => {
		for (const station of OBTAIN_STATIONS) {
			if (!stationNeed.has(station) || stations[station] || stationNeed.has(`${station}:handled`)) continue;
			stationNeed.add(`${station}:handled`);
			if ((pool.get(station) ?? 0) > 0) { pool.set(station, pool.get(station) - 1); continue; }
			if (!ids.includes(station) && !also.some((target) => target.ids.includes(station))) demand(station, 1, []);
		}
	};
	resolveStations();
	// Fuel for every smelt: held coal or charcoal first, then planks (one plank smelts 1.5 items).
	let fuel = null;
	if (smelts > 0) {
		const coal = Math.min(pool.get('coal') ?? 0, Math.ceil(smelts / 8)) + 0;
		const coalUsed = take(['coal', 'charcoal'], Math.ceil(smelts / 8));
		const coalTicks = (Math.ceil(smelts / 8) - coalUsed) * 1600;
		const remaining = Math.max(0, smelts * SMELT_TICKS - coalTicks);
		const planks = Math.ceil(remaining / PLANK_FUEL_TICKS);
		const wood = (index.tags['#planks'] ?? []).reduce((sum, id) => sum + (pool.get(id) ?? 0), 0)
			+ 4 * (index.tags['#logs_that_burn'] ?? []).reduce((sum, id) => sum + (pool.get(id) ?? 0), 0);
		if (planks > wood && (coalFirst || seen.has('coal_ore') || seen.has('deepslate_coal_ore'))) demand('coal', Math.ceil(remaining / COAL_FUEL_TICKS), []);
		else if (planks > 0) demand('#planks', planks, []);
		fuel = { smelts, planks, coal: coal > 0 ? coal : 0 };
		resolveStations();
	}
	resolveStations();
	// A partial held input can make a recipe look cheap while its remainder, fuel or station is unavailable.
	// Retry pricing without consumable discounts; actual held materials still satisfy demand. Keep harvest tools
	// and stations in the cost context, since they are reusable rather than recipe inputs.
	const alternativeCosts = new Map([...held].filter(([id]) => EQUIPMENT.test(id) || STATIONS.has(id)));
	if (unreachable.size > 0 && costHeld === held && alternativeCosts.size < held.size) {
		return planObtain({ ids, count, also }, { held, seen, stations, index, coalFirst, dimension, costHeld: alternativeCosts });
	}
	return { ops: [...ops.values()], needs: [...needs.values()], fuel, unreachable: [...unreachable], tools: [...tools] };
}

export function heldOf(spec, held, index = howtoIndex()) {
	const members = spec.startsWith('#') ? index.tags[spec] ?? [] : spec.split('|');
	return members.reduce((sum, member) => sum + (held.get(member) ?? 0), 0);
}

/** The crafts of an op the body can make now from held inputs (at most the planned times). */
export function readyTimes(op, held, index = howtoIndex()) {
	let times = op.times;
	for (const input of op.inputs) {
		const per = input.count / op.times;
		times = Math.min(times, Math.floor(heldOf(input.spec, held, index) / per));
	}
	return Math.max(0, times);
}

export { full as fullId, short as shortId };
