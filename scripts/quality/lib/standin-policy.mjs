// The provider-free stand-in for the model in practice rooms: what its next call is when a step stops at a fork.
// Rooms have no model, so a fixture plays the model's part. A stand-in that only re-asks fails rooms for reasons a
// real game would not (it never fights the mob in the way, never eats, ends on a worn pickaxe or a blocked search).
// This policy answers the common forks the way the in-game model is told to (coordinator/config/minecraft-agent):
// "answer its reason: recover, go around, change the way", "at hunger or health <=14/20, eat carried food", and
// "when danger already acts on you ... your first call is the escape or the defence itself". It is deterministic,
// reads only what the model would see (the step's result and the latest observation), and returns the calls to make;
// the fixture makes them and records each choice in the room's row (row.standin).
//
// Forks, first match wins:
//   water    the body is under water, or the step stopped for water under it: walk 24 blocks away from the water
//   hostile  a hostile is attacking or in the way: fight it or flee it (mobAnswer); at health 8 or less, cover: flee
//            it and eat (a fixture with its own heal, the build rooms', walls in and eats instead)
//   hunger   food carried and food level 14 or less, or health 14 or less with food under 20: eat
//   tool     a worn or missing pickaxe: switch to a sound one carried, else re-craft one the materials allow
//   blocked  the step could not go on (FIND_BLOCKED, NO_ROUTE ...): once per step, walk 24 blocks to one side, retry
// Each fork has a per-step cap (FORK_CAPS) so an answer that changes nothing never loops to the step limit.

// STANDIN_POLICY=off plays the old stand-in (re-ask only; the build rooms' own answer without the new forks), so a room
// batch can play old and new side by side on the same code and machines (an @ROOM:old line with STANDIN_POLICY=off).
export const STANDIN_POLICY_ON = process.env.STANDIN_POLICY !== 'off';
export const FOOD = /^minecraft:(cooked_[a-z]+|beef|porkchop|mutton|chicken|rabbit|bread|apple|baked_potato|carrot|sweet_berries|golden_carrot|golden_apple)$/;
export const ARCHER = /^(skeleton|stray|bogged|parched|pillager)$/;
const ALWAYS_FLEE = /^(creeper|witch|drowned|blaze)$/;
const WEAPON = /_(sword|axe|pickaxe|shovel)$/;
// Stops where the way on is shut, not dangerous: the model goes around (another angle) and asks again.
export const BLOCKED_CODES = new Set(['FIND_BLOCKED', 'NO_ROUTE', 'FIND_BUDGET', 'FIND_NOT_FOUND', 'TRAVEL_TIMEOUT', 'DIG_STUCK', 'NAVIGATION_STUCK', 'OBTAIN_STUCK']);
// Stops for a mob or for damage: the model answers the mob before asking again.
export const DANGER_CODES = new Set(['DANGER', 'FIND_DANGER', 'HOSTILE_NEAR', 'DAMAGE_TAKEN', 'TRAVEL_DAMAGED', 'NAVIGATION_DAMAGED', 'SURFACE_DANGER', 'LOW_HEALTH']);
export const FORK_CAPS = Object.freeze({ water: 2, hostile: 4, hunger: 6, tool: 2, blocked: 1 });
const WATER_STOP = /\bwater under (this|the) spot\b|\bflooded\b|\b(in|under) water\b|\bstill water\b/i;
const TOOL_STOP = /\b(TOOL_WORN|NO_TOOL)\b|\bpickaxe (is |was )?(worn|missing)|\b(worn[- ]out|missing|no usable) ([a-z_:]+ )?pickaxe/i;
const UUID = /minecraft:([a-z_]+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
const RELOCATE_BLOCKS = 24;
const PICK_TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];

const failed = result => result && result.state !== 'SUCCEEDED';
const mobType = id => String(id ?? '').replace(/^minecraft:/, '');
const distanceTo = (at, one) => (at && [one?.x, one?.y, one?.z].every(Number.isFinite) ? Math.hypot(one.x - at.x, one.y - at.y, one.z - at.z) : null);
const isHeld = (item, selected) => item.slot === 'mainhand' || item.slot === 'offhand' || item.slot === 40 || (Number.isInteger(item.slot) && item.slot <= 8) || item.slot === selected;
const usesLeft = item => (item?.maxDamage > 0 ? item.maxDamage - (item.damage ?? 0) : Infinity);
// Minecraft yaw: 0 faces +z (south), 90 faces -x (west).
const yawToward = (dx, dz) => Math.round(Math.atan2(-dx, dz) * 180 / Math.PI);
const wrapYaw = yaw => Math.round(((yaw % 360) + 540) % 360 - 180);

/**
 * Fight, flee or cover for one hostile, the rule the build rooms' stand-in has used since round 4: a lone archer is
 * fought above 8 health (fleeing an archer got away 5 times in 16), shield up when one is held; a creeper, witch,
 * drowned or blaze, two or more hostiles, no weapon, or an archer out of sight are fled; another hostile is fought above
 * 12 health and fled at 12 or less; health 8 or less with a mob near is cover (the fixture walls in and heals).
 */
export function mobAnswer({ type, id, many = false, health, unarmed = false, outOfSight = false, shielded = false }) {
	const kind = mobType(type), archer = !many && ARCHER.test(kind);
	if (!(health > 8)) return { choice: 'cover', why: `${kind} near at health ${health}` };
	const flee = unarmed || (archer && outOfSight) || many || ALWAYS_FLEE.test(kind) || (!archer && !(health > 12));
	const why = flee ? `${kind}: flee (${unarmed ? 'no weapon' : many ? 'two or more hostiles' : ALWAYS_FLEE.test(kind) ? `never melee a ${kind}` : archer ? 'archer out of sight' : `health ${health} is 12 or less`})`
		: `${kind}: fight${archer ? ' (lone archer)' : ''}`;
	const call = flee ? { actionType: 'flee_from', arguments: { targetId: id, distance: 16, timeoutMs: 12_000 } }
		: { actionType: 'fight_target', arguments: { targetId: id, ...(archer ? { fleeAtHealth: 8, ...(shielded ? { shield: true } : {}) } : {}), timeoutMs: 20_000 } };
	return { choice: flee ? 'flee' : 'fight', why, call };
}

/** The hostile the model answers: the one the stop named when it is in view, else the nearest in view within 16 blocks. */
export function hostileInWay(result, observation, { within = 16 } = {}) {
	const at = observation?.player;
	const named = UUID.exec(String(result?.message ?? ''));
	const alive = (observation?.entities ?? []).filter(one => one?.hostile === true && one.alive !== false && typeof one.stableId === 'string' && distanceTo(at, one) !== null);
	const near = alive.filter(one => distanceTo(at, one) <= within).sort((a, b) => distanceTo(at, a) - distanceTo(at, b));
	if (named) {
		const seen = alive.find(one => one.stableId === named[2]);
		return { type: named[1], id: named[2], many: false, distance: seen ? distanceTo(at, seen) : null, seen: Boolean(seen) };
	}
	if (!near.length) return null;
	return { type: mobType(near[0].type), id: near[0].stableId, many: near.length > 1, distance: distanceTo(at, near[0]), seen: true };
}

/** The calls that eat one carried food: move it to the hotbar when it is only in the main inventory, select it, eat. */
export function eatCalls(observation) {
	const inventory = observation?.inventory ?? {}, items = inventory.items ?? [];
	const foods = items.filter(item => FOOD.test(item.itemId)).sort((a, b) => /cooked/.test(b.itemId) - /cooked/.test(a.itemId) || b.count - a.count);
	if (!foods.length) return null;
	const held = foods.find(item => isHeld(item, inventory.selectedSlot));
	const calls = [];
	const food = held ?? foods[0];
	if (!held && Number.isInteger(food.slot) && food.slot > 8 && food.slot <= 35) {
		const used = new Set(items.map(item => (item.slot === 'mainhand' ? inventory.selectedSlot : item.slot)).filter(slot => Number.isInteger(slot) && slot <= 8));
		const free = [8, 7, 6, 5, 4, 3, 2, 1, 0].find(slot => !used.has(slot)) ?? 8;
		calls.push({ name: 'act', arguments: { actionType: 'select_tool', arguments: { sourceSlot: food.slot, hotbarSlot: free, expectedItemId: food.itemId, minRemainingDurability: 0 } } });
	}
	calls.push({ name: 'act', arguments: { actionType: 'select_item', arguments: { itemId: food.itemId } } });
	calls.push({ name: 'act', arguments: { actionType: 'use_item', arguments: { mode: 'hold', durationMs: 2_000 } } });
	return { food: food.itemId, calls };
}

/** What a worn or missing pickaxe is answered with: a sound one carried off the hotbar, else one the materials craft. */
export function toolCalls(observation) {
	const inventory = observation?.inventory ?? {}, items = inventory.items ?? [];
	const spare = items.filter(item => /_pickaxe$/.test(item.itemId) && Number.isInteger(item.slot) && item.slot >= 9 && item.slot <= 35 && usesLeft(item) > 2)
		.sort((a, b) => PICK_TIERS.indexOf(mobType(b.itemId).split('_')[0]) - PICK_TIERS.indexOf(mobType(a.itemId).split('_')[0]))[0];
	if (spare) {
		const selected = Number.isInteger(inventory.selectedSlot) ? inventory.selectedSlot : 0;
		return { choice: 'switch', why: `switch to the ${mobType(spare.itemId)} carried`, calls: [{ name: 'act', arguments: { actionType: 'select_tool', arguments: { sourceSlot: spare.slot, hotbarSlot: selected, expectedItemId: spare.itemId, minRemainingDurability: 3 } } }] };
	}
	const count = pattern => items.filter(item => pattern.test(item.itemId)).reduce((sum, item) => sum + (item.count ?? 0), 0);
	// Two sticks: carried sticks, or planks (2 planks make 4 sticks), or one log (4 planks). The crafting table needs
	// 4 planks more unless one is carried; obtain plans that part, so it is not counted here.
	const sticks = count(/^minecraft:stick$/) >= 2 || count(/_planks$/) >= 2 || count(/_(log|stem)$/) >= 1;
	const head = count(/^minecraft:iron_ingot$/) >= 3 ? 'minecraft:iron_pickaxe'
		: count(/^minecraft:(cobblestone|cobbled_deepslate|blackstone)$/) >= 3 ? 'minecraft:stone_pickaxe' : null;
	if (!sticks || !head) return { choice: 'none', why: `no materials for a pickaxe (${!sticks ? 'no sticks, planks or logs' : 'no iron ingots or cobblestone'})`, calls: [] };
	return { choice: 'craft', why: `re-craft a ${mobType(head)} from carried materials`, calls: [{ name: 'do_step', arguments: { verb: 'obtain', target: { item: head, count: 1 }, why: 'a sound pickaxe to dig on with' } }] };
}

/** A leg of RELOCATE_BLOCKS at a yaw: away from the nearest seen water, or a quarter turn from where the body faces. */
export function relocateCall(observation, { awayFromWater = false } = {}) {
	const at = observation?.player;
	const water = awayFromWater && at ? (observation?.blocks ?? []).filter(block => block?.blockId === 'minecraft:water' && distanceTo(at, block) !== null)
		.sort((a, b) => distanceTo(at, a) - distanceTo(at, b))[0] : null;
	const yaw = water ? yawToward(at.x - water.x - 0.5, at.z - water.z - 0.5) : wrapYaw((Number.isFinite(at?.yaw) ? at.yaw : 0) + 90);
	const why = water ? `away from the water at ${water.x},${water.y},${water.z}` : 'a quarter turn from the way the body faced';
	return { why, call: { name: 'act', arguments: { actionType: 'travel_to', arguments: { yaw, distance: RELOCATE_BLOCKS, timeoutMs: 60_000 } } } };
}

/**
 * The stand-in's answer to a step that stopped: { fork, choice, why, calls } with the calls to make before the step is
 * asked again, or { fork: null, why } when no fork applies (the fixture keeps its old behaviour: wait or end). A fixture
 * calls it once more at a room's end with no caps (used {}) and plays nothing: row.standinEnd, the same classifier in both
 * arms, says whether the room ended at a fork the policy answers.
 * used counts the forks already answered for this step; a fork at its FORK_CAPS cap is passed over. skip names forks
 * the fixture answers itself (the build rooms re-craft a pickaxe their own way). choice cover carries plain calls (flee,
 * eat) for a fixture without its own heal.
 */
export function standinFork({ result, observation, used = {}, skip = [], wantsWater = false } = {}) {
	const open = fork => !skip.includes(fork) && !((used[fork] ?? 0) >= FORK_CAPS[fork]);
	const code = String(result?.reasonCode ?? ''), message = String(result?.message ?? '');
	const player = observation?.player;
	if (!player) return { fork: null, why: 'no player sample' };
	const health = player.health;
	const stopped = failed(result);
	// Under water, or a step stopped by water under it. Standing in shallow water is no fork, and a step after water
	// (wantsWater: a bucket to fill) is not walked away from it unless the head is under.
	if (open('water') && (player.underWater === true || (stopped && !wantsWater && WATER_STOP.test(message)))) {
		const leg = relocateCall(observation, { awayFromWater: true });
		return { fork: 'water', choice: 'step-out', why: `${player.underWater ? 'under water' : 'water stopped the step'}: walk ${leg.why}`, calls: [leg.call] };
	}
	const mob = hostileInWay(result, observation);
	const attacked = mob && (DANGER_CODES.has(code) || mob.distance !== null && mob.distance <= 6 || (observation.entities ?? []).some(one => one?.stableId === mob.id && one.targetingAgent === true));
	if (open('hostile') && mob && attacked) {
		const items = observation.inventory?.items ?? [];
		const answer = mobAnswer({ ...mob, health, outOfSight: !(mob.distance <= 8), unarmed: /nothing to fight/i.test(message) || !items.some(item => WEAPON.test(item.itemId)),
			shielded: items.some(item => (item.slot === 40 || item.slot === 'offhand') && item.itemId === 'minecraft:shield') });
		// Cover: a fixture with its own heal (the build rooms wall in and eat) uses that; the calls here are the plain
		// answer for one without: flee the mob, then eat when food is carried.
		const calls = answer.call ? [{ name: 'act', arguments: answer.call }]
			: [{ name: 'act', arguments: { actionType: 'flee_from', arguments: { targetId: mob.id, distance: 16, timeoutMs: 12_000 } } }, ...(Number.isFinite(player.foodLevel) && player.foodLevel < 20 ? eatCalls(observation)?.calls ?? [] : [])];
		return { fork: 'hostile', choice: answer.choice, why: answer.why, mob: { type: mob.type, id: mob.id, distance: mob.distance === null ? null : Math.round(mob.distance) }, calls };
	}
	const food = player.foodLevel;
	const hostileClose = mob && mob.distance !== null && mob.distance <= 8;
	if (open('hunger') && !hostileClose && Number.isFinite(food) && (food <= 14 || (health <= 14 && food < 20))) {
		const eat = eatCalls(observation);
		if (eat) return { fork: 'hunger', choice: 'eat', why: `food ${food}, health ${Math.round(health)}: eat ${mobType(eat.food)}`, calls: eat.calls };
	}
	if (open('tool') && stopped && (['TOOL_WORN', 'NO_TOOL'].includes(code) || TOOL_STOP.test(message))) {
		const tool = toolCalls(observation);
		if (tool.calls.length) return { fork: 'tool', choice: tool.choice, why: tool.why, calls: tool.calls };
		return { fork: null, why: tool.why };
	}
	if (open('blocked') && stopped && BLOCKED_CODES.has(code)) {
		const leg = relocateCall(observation);
		return { fork: 'blocked', choice: 'another-angle', why: `${code}: walk ${leg.why}, then ask again`, calls: [leg.call] };
	}
	return { fork: null, why: `no fork for ${code || result?.state || 'this result'}` };
}

/** One row.standin entry: what the stand-in chose, and what each of its calls ended with. */
export function standinEntry(decision, { atS, step, code, outcomes = [] } = {}) {
	return { atS, ...(step === undefined ? {} : { step }), code, fork: decision.fork, ...(decision.choice ? { choice: decision.choice } : {}), why: decision.why,
		...(decision.mob ? { mob: decision.mob } : {}), calls: (decision.calls ?? []).map((call, index) => ({ type: call.arguments?.actionType ?? call.arguments?.verb ?? call.name,
			state: outcomes[index]?.state ?? null, reasonCode: outcomes[index]?.reasonCode ?? null })) };
}

/** Makes a decision's calls in order with the fixture's own runner (run(call, index) -> result); stops at a death. */
export async function playStandin(decision, { run, dead = async () => false }) {
	const outcomes = [];
	for (const [index, call] of (decision.calls ?? []).entries()) {
		outcomes.push(await run(call, index));
		if (await dead()) break;
	}
	return outcomes;
}
