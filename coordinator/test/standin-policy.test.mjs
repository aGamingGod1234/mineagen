// The practice rooms' stand-in for the model (scripts/quality/lib/standin-policy.mjs): each test is a fork from the
// gameplay friction logs where the old stand-in ended or idled a room that a model would have answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { FORK_CAPS, mobAnswer, standinFork, standinEntry, playStandin, eatCalls, toolCalls, relocateCall } from '../../scripts/quality/lib/standin-policy.mjs';

const ZOMBIE = '0b14864e-43f8-4b06-bf5c-a8c0a280511b';
const PIGLIN = '41738045-14c1-45a4-9003-f69b66eaf826';
const body = ({ health = 20, foodLevel = 20, yaw = 0, underWater = false, inWater = false, items = [], entities = [], blocks = [], selectedSlot = 0 } = {}) => ({
	player: { x: 0.5, y: 64, z: 0.5, yaw, health, foodLevel, underWater, inWater },
	inventory: { selectedSlot, items },
	entities, blocks,
});
const kit = [{ itemId: 'minecraft:iron_sword', count: 1, slot: 0 }, { itemId: 'minecraft:iron_pickaxe', count: 1, slot: 1 }, { itemId: 'minecraft:bread', count: 8, slot: 2 }];
const zombie = (distance, extra = {}) => ({ stableId: ZOMBIE, type: 'minecraft:zombie', hostile: true, alive: true, x: 0.5 + distance, y: 64, z: 0.5, ...extra });
const failed = (reasonCode, message = '') => ({ state: 'FAILED', reasonCode, message });

test('an archer named by the stop but not in the latest sample is fled, never chased', () => {
	// hostileInWay gives such an archer distance null; null <= 8 is true in JavaScript, so it was taken as in sight.
	const SKELETON = '5f0f2a52-1c3e-4a8b-9d2e-0c6b7a1e9f30';
	const decision = standinFork({ result: failed('FIND_DANGER', `Stopped for danger: minecraft:skeleton ${SKELETON} shooting`), observation: body({ items: kit }) });
	assert.equal(decision.fork, 'hostile');
	assert.equal(decision.mob.distance, null);
	assert.equal(decision.choice, 'flee');
});

test('a zombie that stopped the build next to the body is fought, not waited out', () => {
	// cast-gate-7: build nether_portal ended HOSTILE_NEAR with a zombie 1.4 blocks away; the old stand-in only re-asked.
	const decision = standinFork({ result: failed('HOSTILE_NEAR', `build nether_portal; minecraft:zombie ${ZOMBIE} 1.4 blocks away`), observation: body({ items: kit, entities: [zombie(1.4)] }) });
	assert.equal(decision.fork, 'hostile');
	assert.equal(decision.choice, 'fight');
	assert.deepEqual(decision.calls, [{ name: 'act', arguments: { actionType: 'fight_target', arguments: { targetId: ZOMBIE, timeoutMs: 20_000 } } }]);
});

test('a piglin shooting during a fortress search is answered with a fight at full health with a sword', () => {
	// fortress-gate-3: four FIND_DANGER hand-backs from piglin arrows; the stand-in idled between calls and the body died.
	const piglin = { stableId: PIGLIN, type: 'minecraft:piglin', hostile: true, alive: true, x: 8.5, y: 64, z: 0.5, targetingAgent: true };
	const decision = standinFork({ result: failed('FIND_DANGER', 'Stopped for danger: TRAVEL_DAMAGED (Took 4.0 damage (arrow from minecraft:piglin); health 15.7)'), observation: body({ health: 15.7, items: kit, entities: [piglin] }) });
	assert.equal(decision.fork, 'hostile');
	assert.equal(decision.choice, 'fight');
	assert.equal(decision.calls[0].arguments.arguments.targetId, PIGLIN);
});

test('the fight or flee rule is the build rooms\' round-4 rule', () => {
	assert.equal(mobAnswer({ type: 'creeper', id: 'c', health: 20 }).choice, 'flee');
	assert.equal(mobAnswer({ type: 'zombie', id: 'z', health: 12 }).choice, 'flee');
	assert.equal(mobAnswer({ type: 'zombie', id: 'z', health: 13 }).choice, 'fight');
	assert.equal(mobAnswer({ type: 'zombie', id: 'z', health: 20, many: true }).choice, 'flee');
	assert.equal(mobAnswer({ type: 'zombie', id: 'z', health: 20, unarmed: true }).choice, 'flee');
	assert.equal(mobAnswer({ type: 'zombie', id: 'z', health: 8 }).choice, 'cover');
	// A lone archer is fought above 8, with the shield up when one is held; one out of sight is fled, never chased.
	assert.deepEqual(mobAnswer({ type: 'skeleton', id: 's', health: 10, shielded: true }).call, { actionType: 'fight_target', arguments: { targetId: 's', fleeAtHealth: 8, shield: true, timeoutMs: 20_000 } });
	assert.equal(mobAnswer({ type: 'skeleton', id: 's', health: 10, outOfSight: true }).choice, 'flee');
	assert.equal(mobAnswer({ type: 'minecraft:blaze', id: 'b', health: 20 }).choice, 'flee');
});

test('a hostile far off that did not stop the step is no fork', () => {
	const decision = standinFork({ result: failed('FIND_BLOCKED', 'No way on: 18 legs in a row got less than half way'), observation: body({ items: kit, entities: [zombie(14)] }) });
	assert.equal(decision.fork, 'blocked');
});

test('hungry with bread carried and no mob close: eat it', () => {
	const decision = standinFork({ result: failed('FIND_DANGER', 'Health 7.3 is at or below 8: eat or recover before searching on'), observation: body({ health: 7.3, foodLevel: 12, items: kit }) });
	assert.equal(decision.fork, 'hunger');
	assert.deepEqual(decision.calls.map(call => call.arguments.actionType), ['select_item', 'use_item']);
	// Hurt with food under 20 eats too (vanilla heals from food); full food does not.
	assert.equal(standinFork({ result: failed('LOW_HEALTH'), observation: body({ health: 12, foodLevel: 19, items: kit }) }).fork, 'hunger');
	assert.equal(standinFork({ result: failed('LOW_HEALTH'), observation: body({ health: 12, foodLevel: 20, items: kit }) }).fork, null);
	// No food carried: no eat call (the fixture's own heal goes for food).
	assert.equal(standinFork({ result: failed('LOW_HEALTH'), observation: body({ health: 12, foodLevel: 10, items: kit.slice(0, 2) }) }).fork, null);
});

test('food only in the main inventory goes to a free hotbar slot before it is eaten', () => {
	const eat = eatCalls(body({ items: [{ itemId: 'minecraft:iron_sword', count: 1, slot: 0 }, { itemId: 'minecraft:cooked_beef', count: 4, slot: 20 }] }));
	assert.equal(eat.food, 'minecraft:cooked_beef');
	assert.deepEqual(eat.calls[0].arguments, { actionType: 'select_tool', arguments: { sourceSlot: 20, hotbarSlot: 8, expectedItemId: 'minecraft:cooked_beef', minRemainingDurability: 0 } });
	assert.equal(eat.calls.length, 3);
});

test('a worn pickaxe is swapped for a sound one carried, else re-crafted when the materials are there', () => {
	const worn = { itemId: 'minecraft:iron_pickaxe', count: 1, slot: 1, damage: 249, maxDamage: 250 };
	const spare = { itemId: 'minecraft:stone_pickaxe', count: 1, slot: 14, damage: 10, maxDamage: 131 };
	const result = failed('FIND_BLOCKED', 'The body cannot go on: TOOL_WORN (A tunnel heading needs a usable tool: minecraft:netherrack)');
	const swap = standinFork({ result, observation: body({ items: [worn, spare] }) });
	assert.equal(swap.fork, 'tool');
	assert.equal(swap.choice, 'switch');
	assert.deepEqual(swap.calls[0].arguments.arguments, { sourceSlot: 14, hotbarSlot: 0, expectedItemId: 'minecraft:stone_pickaxe', minRemainingDurability: 3 });
	const craft = standinFork({ result, observation: body({ items: [worn, { itemId: 'minecraft:cobblestone', count: 64, slot: 3 }, { itemId: 'minecraft:oak_planks', count: 4, slot: 4 }] }) });
	assert.equal(craft.choice, 'craft');
	assert.deepEqual(craft.calls[0].arguments.target, { item: 'minecraft:stone_pickaxe', count: 1 });
	// fortress-gate-1: a worn iron pickaxe in the Nether with cobblestone but no wood: nothing to craft with, no fork, and
	// no walk to another angle either (it would not mend the pickaxe).
	const none = standinFork({ result, observation: body({ items: [worn, { itemId: 'minecraft:cobblestone', count: 128, slot: 3 }] }) });
	assert.equal(none.fork, null);
	assert.match(none.why, /no sticks, planks or logs/);
	assert.equal(toolCalls(body({ items: [worn, { itemId: 'minecraft:iron_ingot', count: 3, slot: 5 }, { itemId: 'minecraft:stick', count: 2, slot: 6 }] })).calls[0].arguments.target.item, 'minecraft:iron_pickaxe');
});

test('a search stopped by water under the spot walks away from the water, then asks again', () => {
	// lava-gate-1 and lava-gate-6: 13 rooms ended "water under this spot stops every dig down, and the move off this
	// spot stopped too"; the stand-in re-asked from the same spot or tunnelled 8 blocks into the same water.
	const water = { stableId: '3,63,0', blockId: 'minecraft:water', x: 3, y: 63, z: 0 };
	const result = failed('FIND_BLOCKED', 'No way on from here: water under this spot stops every dig down, and the move off this spot stopped too (NO_ROUTE)');
	const decision = standinFork({ result, observation: body({ items: kit, blocks: [water] }) });
	assert.equal(decision.fork, 'water');
	// The water lies east (+x) of the body, so the walk heads west: yaw 90.
	assert.deepEqual(decision.calls[0].arguments, { actionType: 'travel_to', arguments: { yaw: 90, distance: 24, timeoutMs: 60_000 } });
	// A step after water (a bucket to fill) is not walked away from it.
	assert.equal(standinFork({ result, observation: body({ items: kit, blocks: [water] }), wantsWater: true }).fork, 'blocked');
	// Under water the body walks out whatever the step was after.
	assert.equal(standinFork({ result: failed('OBTAIN_STUCK'), observation: body({ underWater: true, items: kit }), wantsWater: true }).fork, 'water');
	// Standing in shallow water is no fork.
	assert.equal(standinFork({ result: failed('BUILD_SHORT'), observation: body({ inWater: true, items: kit }) }).fork, null);
});

test('a blocked search is tried from another angle once per step, then left to end', () => {
	const result = failed('FIND_BLOCKED', 'No way on: 18 legs in a row got less than half way (last NO_ROUTE)');
	const first = standinFork({ result, observation: body({ yaw: 0, items: kit }) });
	assert.equal(first.fork, 'blocked');
	assert.deepEqual(first.calls[0].arguments.arguments, { yaw: 90, distance: 24, timeoutMs: 60_000 });
	assert.equal(relocateCall(body({ yaw: 135 })).call.arguments.arguments.yaw, -135);
	const second = standinFork({ result, observation: body({ items: kit }), used: { blocked: FORK_CAPS.blocked } });
	assert.equal(second.fork, null);
});

test('every fork has a cap, and a skipped fork is passed over', () => {
	for (const fork of ['water', 'hostile', 'hunger', 'tool', 'blocked']) assert.ok(FORK_CAPS[fork] >= 1);
	const result = failed('HOSTILE_NEAR', `minecraft:zombie ${ZOMBIE} 1.4 blocks away`);
	assert.equal(standinFork({ result, observation: body({ items: kit, entities: [zombie(1.4)] }), used: { hostile: FORK_CAPS.hostile } }).fork, null);
	assert.equal(standinFork({ result, observation: body({ items: kit, entities: [zombie(1.4)] }), skip: ['hostile'] }).fork, null);
	assert.equal(standinFork({ result, observation: {} }).fork, null);
});

test('the same inputs always give the same choice', () => {
	const input = { result: failed('FIND_DANGER', `minecraft:zombie ${ZOMBIE} 3 blocks away`), observation: body({ health: 14, foodLevel: 10, items: kit, entities: [zombie(3)] }) };
	assert.deepEqual(standinFork(structuredClone(input)), standinFork(structuredClone(input)));
});

test('each choice is recorded with what its calls ended with, and play stops at a death', async () => {
	const decision = standinFork({ result: failed('LOW_HEALTH'), observation: body({ health: 10, foodLevel: 10, items: kit }) });
	let calls = 0;
	const outcomes = await playStandin(decision, { run: async () => { calls++; return { state: 'SUCCEEDED', reasonCode: 'OK' }; }, dead: async () => calls >= 1 });
	assert.equal(calls, 1);
	const entry = standinEntry(decision, { atS: 12, step: 0, code: 'LOW_HEALTH', outcomes });
	assert.deepEqual(entry, { atS: 12, step: 0, code: 'LOW_HEALTH', fork: 'hunger', choice: 'eat', why: 'food 10, health 10: eat bread',
		calls: [{ type: 'select_item', state: 'SUCCEEDED', reasonCode: 'OK' }, { type: 'use_item', state: null, reasonCode: null }] });
	assert.deepEqual(standinEntry({ fork: null, why: 'no fork for BUILD_SHORT' }, { atS: 3, code: 'BUILD_SHORT' }), { atS: 3, code: 'BUILD_SHORT', fork: null, why: 'no fork for BUILD_SHORT', calls: [] });
});

test('at health 8 or less with a mob near, cover flees the mob and eats, never idles', () => {
	// fortress-gate-3: health 7.3 then 0.3 with piglins shooting; the old stand-in slept 15 s between finds and the body died.
	const piglin = { stableId: PIGLIN, type: 'minecraft:piglin', hostile: true, alive: true, x: 6.5, y: 64, z: 0.5, targetingAgent: true };
	const decision = standinFork({ result: failed('FIND_DANGER', 'Health 7.3 is at or below 8: eat or recover before searching on'), observation: body({ health: 7.3, foodLevel: 15, items: kit, entities: [piglin] }) });
	assert.equal(decision.fork, 'hostile');
	assert.equal(decision.choice, 'cover');
	assert.deepEqual(decision.calls.map(call => call.arguments.actionType), ['flee_from', 'select_item', 'use_item']);
});

test('every call the policy can send passes the coordinator\'s tool schema', () => {
	const water = { stableId: '3,63,0', blockId: 'minecraft:water', x: 3, y: 63, z: 0 };
	const worn = { itemId: 'minecraft:iron_pickaxe', count: 1, slot: 1, damage: 249, maxDamage: 250 };
	const decisions = [
		standinFork({ result: failed('HOSTILE_NEAR', `minecraft:zombie ${ZOMBIE} 1.4 blocks away`), observation: body({ items: kit, entities: [zombie(1.4)] }) }),
		standinFork({ result: failed('HOSTILE_NEAR', `minecraft:zombie ${ZOMBIE} 1.4 blocks away`), observation: body({ health: 10, items: kit, entities: [zombie(1.4)] }) }),
		standinFork({ result: failed('HOSTILE_NEAR', `minecraft:zombie ${ZOMBIE} 1.4 blocks away`), observation: body({ health: 6, foodLevel: 10, items: kit, entities: [zombie(1.4)] }) }),
		standinFork({ result: failed('LOW_HEALTH'), observation: body({ health: 10, foodLevel: 10, items: [{ itemId: 'minecraft:bread', count: 3, slot: 20 }] }) }),
		standinFork({ result: failed('FIND_BLOCKED', 'TOOL_WORN'), observation: body({ items: [worn, { itemId: 'minecraft:stone_pickaxe', count: 1, slot: 14 }] }) }),
		standinFork({ result: failed('FIND_BLOCKED', 'TOOL_WORN'), observation: body({ items: [worn, { itemId: 'minecraft:cobblestone', count: 9, slot: 3 }, { itemId: 'minecraft:oak_log', count: 1, slot: 4 }] }) }),
		standinFork({ result: failed('FIND_BLOCKED', 'water under this spot stops every dig down'), observation: body({ items: kit, blocks: [water] }) }),
		standinFork({ result: failed('FIND_BLOCKED', 'No way on'), observation: body({ yaw: 135, items: kit }) }),
	];
	assert.deepEqual(decisions.map(decision => decision.fork), ['hostile', 'hostile', 'hostile', 'hunger', 'tool', 'tool', 'water', 'blocked']);
	for (const decision of decisions) for (const call of decision.calls) {
		const args = call.name === 'do_step' ? { ...call.arguments, target: { ...call.arguments.target, timeoutMs: 120_000 } } : call.arguments;
		assert.doesNotThrow(() => normalizeMinecraftToolCall(call.name, args), `${decision.fork} ${JSON.stringify(args)}`);
	}
});
