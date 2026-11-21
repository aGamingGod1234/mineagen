import assert from 'node:assert/strict';
import test from 'node:test';
import { CHOICE_MENUS, CHOOSE_RESPONSE_TOOL, ChoiceMoments, choiceResultText, choiceToolEnabled, flagMoment, momentLine, momentSignals, planChoice } from '../src/choice-moments.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const zombie = { uuid: '0b7f4f5e-8a54-4a33-9d0e-2c1b1d6f2a10', type: 'minecraft:zombie', distance: 6 };
const skeleton = { uuid: '9a3c2b1d-0000-4a33-9d0e-2c1b1d6f2a11', type: 'minecraft:skeleton', distance: 14 };
const observation = (player = {}, extra = {}) => ({ player: { health: 20, threats: [], ...player }, world: { dimension: 'minecraft:overworld', dayTime: 1000 }, inventory: { items: [], selectedSlot: 0 }, ...extra });

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
});

test('a respawn wake flags respawned even at full health with mobs about', () => {
	const s = momentSignals({ observation: observation({ threats: [zombie] }), changed: 'respawned in overworld after death' });
	assert.equal(flagMoment(s), 'respawned');
	assert.equal(flagMoment(momentSignals({ observation: observation(), trigger: 'player_death' })), 'respawned');
});

test('a known cave flags cave_seen only while the next resource is an ore, in the Overworld', () => {
	const taskFacts = '{"known":"caves: cave(air 62/125) 12m S dy+12 y42 @8,42,-200"}';
	const s = momentSignals({ observation: observation(), taskFacts, goalNow: 'bucket 0/1; next: iron' });
	assert.equal(flagMoment(s), 'cave_seen');
	assert.deepEqual(s.cave, { x: 8, y: 42, z: -200 });
	assert.equal(flagMoment(momentSignals({ observation: observation(), taskFacts, goalNow: 'blaze_rod 0/6; next: blaze_rods' })), null);
	const nether = observation({}, { world: { dimension: 'minecraft:the_nether' } });
	assert.equal(momentSignals({ observation: nether, taskFacts, goalNow: 'next: iron' }).cave, null);
});

test('night is flagged from the change line or the clock, last of all', () => {
	assert.equal(flagMoment(momentSignals({ observation: observation(), changed: 'night began' })), 'night_falls');
	assert.equal(flagMoment(momentSignals({ observation: observation({}, { world: { dimension: 'minecraft:overworld', dayTime: 15000 } }) })), 'night_falls');
	assert.equal(flagMoment(momentSignals({ observation: observation({ threats: [zombie] }), changed: 'night began' })), 'threat');
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
	s.lastDeath = { x: 10.4, y: 64, z: -3.6, dimension: 'minecraft:overworld' };
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
	assert.deepEqual(planChoice('night_falls', 'shelter', s).args.target, { x: 3, y: 64, z: -10, opening: 'north', itemId: 'minecraft:cobblestone', roof: true });
	assert.equal(planChoice('threat', 'ignore', s).kind, 'carry_on');
	assert.equal(planChoice('threat', 'sleep', s).kind, 'invalid');
	assert.equal(planChoice('respawned', 'recover_items', { ...s, lastDeath: { ...s.lastDeath, dimension: 'minecraft:the_nether' } }).kind, 'hand_back', 'drops in another dimension go back to the model');
	assert.equal(planChoice('threat', 'retreat_cover', { ...s, threats: [] }).kind, 'hand_back');
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
	assert.match(choiceResultText('threat', 'retreat_cover', { kind: 'call', name: 'act', args: { actionType: 'flee_from' } }), /The body started flee_from/);
	assert.match(choiceResultText(null, 'fight', { kind: 'invalid' }), /no moment is open/);
	assert.match(momentLine('kit_gap'), /craft_shield = craft a shield/);
});
