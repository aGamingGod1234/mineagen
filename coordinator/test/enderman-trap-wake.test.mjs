import assert from 'node:assert/strict';
import test from 'node:test';
import { ENDERMAN_TRAP_TRIGGER, endermanTrapEdge } from '../src/need-sources.mjs';
import { classifyObservationTrigger } from '../src/observation-facts.mjs';
import { WakeFilter } from '../src/wake-filter.mjs';

const enderman = (uuid, distance, y = 64, extra = {}) => ({ uuid, type: 'minecraft:enderman', alive: true, distance, x: distance, y, z: 0, ...extra });
const sample = (entities, items = [{ itemId: 'minecraft:oak_boat', count: 1 }], world = {}) => ({
	world: { dimension: 'minecraft:overworld', raining: false, ...world }, player: { position: { x: 0, y: 64, z: 0 }, health: 20 },
	entities, inventory: { items: [{ itemId: 'minecraft:stone_sword', count: 1 }, ...items] },
});

test('a calm enderman within 16 m wakes once per enderman while a boat or 5 planks of Overworld wood is held', () => {
	const state = {};
	assert.deepEqual(endermanTrapEdge(state, sample([enderman('a', 10)])), { id: 'a', distance: 10 });
	// The same enderman does not wake again; a second one does.
	assert.equal(endermanTrapEdge(state, sample([enderman('a', 6)])), null);
	assert.deepEqual(endermanTrapEdge(state, sample([enderman('a', 6), enderman('b', 9)])), { id: 'b', distance: 9 });
	// Wood for one counts: 2 logs are 8 planks' worth; 4 planks are not enough, nor are warped stems.
	assert.notEqual(endermanTrapEdge({}, sample([enderman('c', 8)], [{ itemId: 'minecraft:spruce_log', count: 2 }])), null);
	assert.equal(endermanTrapEdge({}, sample([enderman('c', 8)], [{ itemId: 'minecraft:oak_planks', count: 4 }])), null);
	assert.equal(endermanTrapEdge({}, sample([enderman('c', 8)], [{ itemId: 'minecraft:warped_stem', count: 4 }])), null);
});

test('no trap wake for an angry, far, high or heard-only enderman, in rain, in the Nether or End, or with 12 pearls', () => {
	const none = (observation) => assert.equal(endermanTrapEdge({}, observation), null);
	none(sample([enderman('a', 10, 64, { targetingAgent: true })]));
	none(sample([enderman('a', 10, 64, { appearance: { screaming: true } })]));
	none(sample([enderman('a', 17)]));
	none(sample([enderman('a', 10, 68)]));
	none(sample([enderman('a', 10, 64, { perceivedBy: 'sound' })]));
	none(sample([enderman('a', 10)], undefined, { raining: true }));
	none(sample([enderman('a', 10)], undefined, { dimension: 'minecraft:the_end' }));
	none(sample([enderman('a', 10)], [{ itemId: 'minecraft:oak_boat', count: 1 }, { itemId: 'minecraft:ender_pearl', count: 12 }]));
});

test('the trap signal is an attention trigger of its own, and the wake filter wakes for it even after endermen were shown', () => {
	const observation = sample([enderman('a', 10)]);
	const classified = classifyObservationTrigger({ attention: false, changedFacts: ['entities'] }, observation, { endermanTrap: { id: 'a', distance: 10 } });
	assert.deepEqual(classified, { attention: true, priority: 'ordinary', trigger: ENDERMAN_TRAP_TRIGGER });
	// Damage in the same sample still outranks it.
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['player.health'] }, observation, { endermanTrap: { id: 'a' } }).trigger, 'damage');
	const filter = new WakeFilter();
	filter.take('bot', observation); // the model has been shown an enderman already
	assert.equal(filter.discovery('bot', { attention: { attention: true, priority: 'ordinary', trigger: 'attention' }, observation, goalText: 'beat the game' }), null);
	assert.equal(filter.discovery('bot', { attention: classified, observation, goalText: 'beat the game' }), 'calm enderman near with a boat trap ready');
	assert.equal(filter.decide('bot', { attention: classified, observation, goalText: 'beat the game' }).verdict, 'wake');
});

test('an enderman forgotten after a sample woke for something else wakes the next sample', async () => {
	const { forgetEndermanTrap } = await import('../src/need-sources.mjs');
	const state = {};
	const first = endermanTrapEdge(state, sample([enderman('a', 10)]));
	forgetEndermanTrap(state, first.id);
	assert.deepEqual(endermanTrapEdge(state, sample([enderman('a', 9)])), { id: 'a', distance: 9 });
	assert.equal(endermanTrapEdge(state, sample([enderman('a', 8)])), null);
});
