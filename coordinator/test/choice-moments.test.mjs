import assert from 'node:assert/strict';
import test from 'node:test';
import { CHOICE_MENUS, CHOOSE_RESPONSE_TOOL, ChoiceMoments, againstRunning, choiceResultText, choiceToolEnabled, flagMoment, momentLine, momentSignals, planChoice } from '../src/choice-moments.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { planCountDefault } from '../src/plan-count.mjs';

const zombie = { uuid: '0b7f4f5e-8a54-4a33-9d0e-2c1b1d6f2a10', type: 'minecraft:zombie', distance: 6, targeting: true };
const skeleton = { uuid: '9a3c2b1d-0000-4a33-9d0e-2c1b1d6f2a11', type: 'minecraft:skeleton', distance: 14, signals: ['targeting'] };
const observation = (player = {}, extra = {}) => ({ player: { health: 20, threats: [], skyOpen: true, ...player }, world: { dimension: 'minecraft:overworld', dayTime: 1000 }, inventory: { items: [], selectedSlot: 0 }, ...extra });

test('the choice tool is off unless MINEAGEN_CHOICE_TOOL is on', () => {
	assert.equal(choiceToolEnabled({}), false);
	assert.equal(choiceToolEnabled({ MINEAGEN_CHOICE_TOOL: 'off' }), false);
	assert.equal(choiceToolEnabled({ MINEAGEN_CHOICE_TOOL: 'on' }), true);
	assert.equal(choiceToolEnabled({ MINEAGEN_CHOICE_TOOL: ' ON ' }), true);
});

test('a hostile targeting the player flags a threat moment, and low health outranks it', () => {
	assert.equal(flagMoment(momentSignals({ observation: observation({ threats: [zombie] }) })), 'threat');
	assert.equal(flagMoment(momentSignals({ observation: observation({ health: 6, threats: [zombie] }) })), 'low_health');
	assert.equal(flagMoment(momentSignals({ observation: observation() })), null);
	assert.equal(flagMoment(momentSignals({ observation: observation({ threats: [{ ...zombie, targeting: false }] }) })), null, 'a mob that is not targeting is not a threat moment');
	assert.equal(flagMoment(momentSignals({ observation: observation({ threats: { entries: [zombie] } }) })), 'threat', 'threat rows may come as entries');
});

test('a respawn wake flags respawned even at full health with mobs about', () => {
	const s = momentSignals({ observation: observation({ threats: [zombie] }), changed: 'respawned in overworld after death' });
	assert.equal(flagMoment(s), 'respawned');
	assert.equal(flagMoment(momentSignals({ observation: observation(), trigger: 'player_death' })), 'respawned');
});

test('the death screen offers nothing and keeps the respawn offer for the living body', () => {
	let now = 0;
	const moments = new ChoiceMoments({ now: () => now });
	assert.equal(moments.offer('a', momentSignals({ observation: observation({ dead: true, health: 0 }), trigger: 'player_death' })), null);
	now = 5_000;
	assert.equal(moments.offer('a', momentSignals({ observation: observation(), changed: 'respawned in overworld after death' })).kind, 'respawned');
});

test('a known cave flags cave_seen only while the next resource is an ore, in the Overworld', () => {
	const taskFacts = '{"known":"caves: cave(air 62/125) 12m S dy+12 y42 @8,42,-200"}';
	const s = momentSignals({ observation: observation(), taskFacts, goalNow: 'bucket 0/1; next: iron' });
	assert.equal(flagMoment(s), 'cave_seen');
	assert.deepEqual(s.cave, { x: 8, y: 42, z: -200 });
	assert.equal(flagMoment(momentSignals({ observation: observation(), taskFacts, goalNow: 'blaze_rod 0/6; next: blaze_rods' })), null);
	const far = '{"known":"caves: cave(air 62/125) 80m S dy+12 y42 @8,42,-280; cave(air 40/125) 20m E dy-3 y60 @30,60,-5"}';
	assert.deepEqual(momentSignals({ observation: observation(), taskFacts: far, goalNow: 'next: iron' }).cave, { x: 30, y: 60, z: -5 }, 'the first cave within 32 m');
	assert.equal(momentSignals({ observation: observation(), taskFacts: far.replace('20m E', '40m E'), goalNow: 'next: iron' }).cave, null);
	const nether = observation({}, { world: { dimension: 'minecraft:the_nether' } });
	assert.equal(momentSignals({ observation: nether, taskFacts, goalNow: 'next: iron' }).cave, null);
});

test('night is flagged from the change line or the clock, last of all', () => {
	assert.equal(flagMoment(momentSignals({ observation: observation(), changed: 'night began' })), 'night_falls');
	assert.equal(flagMoment(momentSignals({ observation: observation({}, { world: { dimension: 'minecraft:overworld', dayTime: 15000 } }) })), 'night_falls');
	assert.equal(flagMoment(momentSignals({ observation: observation({ threats: [zombie] }), changed: 'night began' })), 'threat');
	const underground = observation({ skyOpen: false, y: 20 }, { world: { dimension: 'minecraft:overworld', dayTime: 15000 }, position: { x: 0, y: 20, z: 0 } });
	assert.equal(flagMoment(momentSignals({ observation: underground })), null, 'night underground is not asked');
});

test('food held outside the hotbar flags food_stored with the slots to move it', () => {
	const o = observation({}, { inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 'mainhand' }, { itemId: 'minecraft:cooked_beef', count: 5, slot: 14 }] } });
	const s = momentSignals({ observation: o });
	assert.equal(flagMoment(s), 'food_stored');
	const plan = planChoice('food_stored', 'food_to_hotbar', s);
	assert.equal(plan.kind, 'call');
	assert.equal(plan.args.actionType, 'select_tool');
	assert.equal(plan.args.arguments.sourceSlot, 14);
	assert.equal(plan.args.arguments.expectedItemId, 'minecraft:cooked_beef');
});

test('the same kind is not offered again inside its window, and the offer is remembered for the answer', () => {
	let now = 0;
	const moments = new ChoiceMoments({ now: () => now });
	const s = momentSignals({ observation: observation({ threats: [zombie] }) });
	const offer = moments.offer('a', s);
	assert.equal(offer.kind, 'threat');
	assert.match(offer.line, /^A hostile mob has just started targeting you\. First call choose_response/);
	assert.match(offer.line, /retreat_cover = break line of sight/);
	assert.equal(offer.line.includes('\n'), false, 'the line joins the wake first line');
	assert.equal(moments.offered('a').kind, 'threat');
	now = 5_000;
	assert.equal(moments.offer('a', s), null);
	now = 25_000;
	assert.equal(moments.offer('a', s).kind, 'threat');
	moments.clear('a');
	assert.equal(moments.offered('a'), null);
	assert.equal(moments.offer('b', momentSignals({ observation: observation() })), null);
});

test('each body plan is a valid model tool call', () => {
	const s = momentSignals({ observation: observation({ threats: [skeleton, zombie], health: 6, x: 3.7, y: 64, z: -9.2, yaw: 178 }, { inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:dirt', count: 12, slot: 3 }, { itemId: 'minecraft:cobblestone', count: 40, slot: 4 }] } }) });
	s.lastDeath = { x: 10.4, y: 64, z: -3.6, dimensionId: 'minecraft:overworld' };
	s.cave = { x: 8, y: 42, z: -200 };
	s.foodToHotbar = { kind: 'hotbar', sourceSlot: 12, hotbarSlot: 8, itemId: 'minecraft:bread' };
	let calls = 0;
	for (const [kind, menu] of Object.entries(CHOICE_MENUS)) for (const key of Object.keys(menu)) {
		const plan = planChoice(kind, key, s);
		assert.ok(['call', 'carry_on', 'hand_back'].includes(plan.kind), `${kind}.${key}`);
		if (plan.kind !== 'call') continue;
		calls++;
		assert.doesNotThrow(() => normalizeMinecraftToolCall(plan.name, plan.args), `${kind}.${key}`);
	}
	assert.ok(calls >= 10);
	assert.equal(planChoice('threat', 'retreat_cover', s).args.arguments.targetId, zombie.uuid, 'flees from the nearest threat');
	assert.deepEqual(planChoice('respawned', 'recover_items', s).args.target, { x: 10, y: 64, z: -4, tolerance: 2 });
	assert.equal(planChoice('threat', 'block_shield', s).kind, 'hand_back', 'the shield does not turn to the mob, so blocking goes back to the model');
	assert.equal(planChoice('night_falls', 'work_underground', s).kind, 'hand_back', 'no body step takes the bot underground');
	assert.equal(planChoice('night_falls', 'work_surface', s).kind, 'carry_on');
	assert.equal(planChoice('low_health', 'block_in', s).kind, 'hand_back', 'build_shelter leaves a window, so healing inside goes back to the model');
	assert.deepEqual(planChoice('night_falls', 'shelter', s).args.target, { x: 3, y: 64, z: -10, opening: 'north', itemId: 'minecraft:cobblestone', roof: true });
	assert.equal(planChoice('threat', 'ignore', s).kind, 'carry_on');
	assert.equal(planChoice('threat', 'sleep', s).kind, 'invalid');
	assert.equal(planChoice('respawned', 'recover_items', { ...s, lastDeath: { ...s.lastDeath, dimensionId: 'minecraft:the_nether' } }).kind, 'hand_back', 'drops in another dimension go back to the model');
	assert.equal(planChoice('respawned', 'recover_items', { ...s, lastDeath: { x: 1, y: 2, z: 3 } }).kind, 'hand_back', 'a death with no known dimension goes back to the model');
	assert.equal(planChoice('threat', 'retreat_cover', { ...s, threats: [] }).kind, 'hand_back');
});

test('air, lava, fire and falls outrank every menu, so the emergency line and escape lead the wake', () => {
	const drowned = { ...zombie, type: 'minecraft:drowned' };
	const drowning = momentSignals({ observation: observation({ health: 6, threats: [drowned], underWater: true, air: 60 }) });
	assert.equal(drowning.emergency, 'air');
	assert.equal(flagMoment(drowning), null, 'drowning at 6 HP with a drowned on it is not a fight-or-run menu');
	assert.equal(flagMoment(momentSignals({ observation: observation({ health: 6, underWater: true, airSecondsLeft: 12 }) })), 'low_health', 'plenty of air left is not an emergency');
	const lavaBlocks = { blocks: [{ blockId: 'minecraft:lava', x: 0, y: 64, z: 0 }] };
	assert.equal(flagMoment(momentSignals({ observation: observation({ x: 0, y: 64, z: 0, inLava: true }, lavaBlocks) })), null, 'touching lava offers no use_lava or carry_on');
	assert.equal(flagMoment(momentSignals({ observation: observation({ x: 0, y: 64, z: 0, hazard: 'lava' }, lavaBlocks) })), null);
	assert.equal(flagMoment(momentSignals({ observation: observation({ onFire: true, threats: [zombie] }) })), null, 'burning outranks a threat menu');
	assert.equal(flagMoment(momentSignals({ observation: observation({ onGround: false, fallDistance: 9, threats: [zombie] }) })), null, 'falling outranks a threat menu');
	assert.equal(flagMoment(momentSignals({ observation: observation({ onGround: false, fallDistance: 1, threats: [zombie] }) })), 'threat', 'a hop is not a fall');
	assert.equal(flagMoment(momentSignals({ observation: observation({ x: 0, y: 64, z: 0, inLava: true, effects: [{ effectId: 'minecraft:fire_resistance' }] }, lavaBlocks) })), 'lava_seen', 'fire resistance makes lava harmless');
	assert.match(choiceResultText('low_health', 'fight', { kind: 'emergency', emergency: 'air' }), /running out of air comes first/);
});

test('lava is a moment only within 4 blocks', () => {
	const lava = (d) => observation({ x: 0, y: 64, z: 0 }, { blocks: [{ blockId: 'minecraft:lava', x: d, y: 64, z: 0 }] });
	assert.equal(flagMoment(momentSignals({ observation: lava(2) })), 'lava_seen');
	assert.equal(flagMoment(momentSignals({ observation: lava(7) })), null);
});

test('a chosen fight stays on one blaze even when the goal needs six rods', () => {
	const blaze = { ...zombie, type: 'minecraft:blaze' };
	const signals = momentSignals({ observation: observation({ threats: [blaze] }) });
	const context = { entities: [blaze], needs: [{ id: 'minecraft:blaze_rod', have: 0, need: 6 }] };
	for (const kind of ['threat', 'low_health']) {
		const chosen = planChoice(kind, 'fight', signals);
		for (const running of [null, { actionId: 'walk' }]) {
			const { plan } = againstRunning(chosen, running, 1);
			const call = normalizeMinecraftToolCall(plan.name, plan.args);
			const { tool } = planCountDefault(call, context);
			assert.deepEqual(tool.arguments, { targetId: blaze.uuid, timeoutMs: 30_000 });
		}
	}
});

test('an open offer expires after a minute', () => {
	let now = 0;
	const moments = new ChoiceMoments({ now: () => now });
	moments.offer('a', momentSignals({ observation: observation({ threats: [zombie] }) }));
	now = 59_000;
	assert.equal(moments.offered('a').kind, 'threat');
	now = 61_000;
	assert.equal(moments.offered('a'), null);
});

test('with a body action running, urgent moves replace it, food waits for it, and obtain cancels it first', () => {
	const running = { actionId: 'act-7', actionType: 'dig_to', arguments: {} };
	const s = momentSignals({ observation: observation({ threats: [zombie], x: 1, y: 64, z: 1 }, { inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:cobblestone', count: 40, slot: 4 }] } }) });
	s.foodToHotbar = { kind: 'hotbar', sourceSlot: 12, hotbarSlot: 8, itemId: 'minecraft:bread' };
	s.cave = { x: 8, y: 42, z: -200 };
	const flee = againstRunning(planChoice('threat', 'retreat_cover', s), running, 3);
	assert.equal(flee.plan.name, 'replaceAction');
	assert.deepEqual(flee.plan.args, { actionId: 'act-7', goalRevision: 3, actionType: 'flee_from', arguments: { targetId: zombie.uuid, distance: 16, timeoutMs: 10_000 } });
	assert.equal(flee.cancel, null);
	const cave = againstRunning(planChoice('cave_seen', 'enter_cave', s), running, 3);
	assert.equal(cave.plan.name, 'replaceAction');
	assert.equal(cave.plan.args.actionType, 'travel_to');
	const food = againstRunning(planChoice('food_stored', 'food_to_hotbar', s), running, 3);
	assert.equal(food.plan.name, 'act');
	assert.equal(food.plan.args.after, 'act-7');
	const shield = againstRunning(planChoice('kit_gap', 'craft_shield', s), running, 3);
	assert.equal(shield.plan.name, 'do_step');
	assert.deepEqual(shield.cancel, { name: 'cancelAction', args: { actionId: 'act-7', goalRevision: 3 } });
	for (const r of [flee, cave, food, shield, againstRunning(planChoice('night_falls', 'shelter', s), running, 3)]) {
		assert.doesNotThrow(() => normalizeMinecraftToolCall(r.plan.name, r.plan.args));
		if (r.cancel) assert.doesNotThrow(() => normalizeMinecraftToolCall(r.cancel.name, r.cancel.args));
	}
	assert.equal(againstRunning(planChoice('threat', 'ignore', s), running, 3).plan.kind, 'carry_on');
	assert.equal(againstRunning(planChoice('threat', 'retreat_cover', s), null, 3).plan.name, 'act', 'an idle body starts the move directly');
});

test('choose_response parses one key and is offered as its own tool', () => {
	assert.deepEqual(normalizeMinecraftToolCall('choose_response', { choice: 'retreat_cover', why: 'skeleton in the open' }), { kind: 'choose_response', choice: 'retreat_cover', why: 'skeleton in the open' });
	assert.throws(() => normalizeMinecraftToolCall('choose_response', { choice: 'run away now!' }));
	assert.throws(() => normalizeMinecraftToolCall('choose_response', { choice: 'fight', extra: 1 }));
	assert.equal(CHOOSE_RESPONSE_TOOL.name, 'choose_response');
	assert.deepEqual(CHOOSE_RESPONSE_TOOL.inputSchema.required, ['choice']);
});

test('the result text tells the model what happens next', () => {
	assert.match(choiceResultText('threat', 'ignore', { kind: 'carry_on' }), /running step goes on/);
	assert.match(choiceResultText('lava_seen', 'avoid_block', { kind: 'hand_back' }), /make the tool call that does it now/);
	const flee = { kind: 'call', name: 'act', args: { actionType: 'flee_from' } };
	assert.match(choiceResultText('threat', 'retreat_cover', flee, { state: 'RUNNING' }), /The body started flee_from/);
	assert.match(choiceResultText('threat', 'retreat_cover', flee, { state: 'SUCCEEDED' }), /The body did flee_from/);
	assert.match(choiceResultText('threat', 'retreat_cover', flee, { state: 'REJECTED', executed: false, reasonCode: 'NATIVE_ACTION_IN_PROGRESS' }), /could not do it \(flee_from: NATIVE_ACTION_IN_PROGRESS\); make the tool call/);
	assert.match(choiceResultText('threat', 'retreat_cover', flee, { state: 'TIMED_OUT', reasonCode: 'FLEE_TIMED_OUT' }), /could not do it \(flee_from: FLEE_TIMED_OUT\); make the tool call/);
	assert.match(choiceResultText(null, 'fight', { kind: 'invalid' }), /no moment is open/);
	assert.match(momentLine('kit_gap'), /craft_shield = craft a shield/);
});
