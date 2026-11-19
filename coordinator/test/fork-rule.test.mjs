import test from 'node:test';
import assert from 'node:assert/strict';
import { eatCalls, lowHealthFork, naturalRegeneration } from '../src/fork-rule.mjs';

const bread = { slot: 2, itemId: 'minecraft:bread', nutrition: 5 };
const sample = ({ threats = [], world = {}, ...player } = {}) => ({
	player: { x: 0, y: 64, z: 0, health: 5, foodLevel: 10, saturation: 0, canHealNow: false, bestFood: null, threats, ...player },
	inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_sword', count: 1, slot: 0 }] },
	world: { dimension: 'minecraft:overworld', difficulty: 'normal', naturalRegeneration: true, ...world },
});
const mob = (type, row = {}) => ({ uuid: `${type}-1`, type: `minecraft:${type}`, distance: 6, lineOfSight: true, targeting: true, signals: ['targeting'], ...row });

test('carried food it can eat now: eat', () => {
	assert.deepEqual(lowHealthFork(sample({ canHealNow: true, bestFood: bread })), { recover: 'eat', food: bread });
	const heal = { slot: 20, itemId: 'minecraft:golden_apple', nutrition: 4, alwaysEdible: true };
	assert.deepEqual(lowHealthFork(sample({ canHealNow: true, bestFood: bread, healFood: heal, foodLevel: 20 })).food, heal);
	// Not safe or not hurt by the server's word: no eating; with no regeneration that is a fork.
	assert.ok(lowHealthFork(sample({ canHealNow: false, bestFood: bread })).fork);
});

test('regeneration only at food 18 or more, and only when saturation and the food above 17 pay for the climb to 10', () => {
	assert.deepEqual(lowHealthFork(sample({ health: 7, foodLevel: 18, saturation: 4 })), { recover: 'regen' });
	assert.deepEqual(lowHealthFork(sample({ health: 5, foodLevel: 20, saturation: 4.5 })), { recover: 'regen' });
	const thin = lowHealthFork(sample({ health: 5, foodLevel: 18, saturation: 2 }));
	assert.match(thin.fork, /^health 5, food 18, saturation 2: no food to eat, and regeneration \(food 18 or more\) cannot pay/);
	assert.equal(thin.starved, true);
	// High saturation does not regenerate below food 18.
	assert.ok(lowHealthFork(sample({ health: 5, foodLevel: 17, saturation: 20 })).fork);
	assert.match(lowHealthFork(sample({ foodLevel: 20, saturation: 20, world: { naturalRegeneration: false } })).fork, /natural regeneration is off/);
	assert.deepEqual(lowHealthFork(sample({ foodLevel: 2, world: { difficulty: 'peaceful' } })), { recover: 'regen' });
});

test('unknown facts fork, never wait', () => {
	assert.match(lowHealthFork({ player: { health: 5 } }).fork, /^health 5, food \?, saturation \?/);
	assert.equal(naturalRegeneration({}, {}), null);
});

test('mobs: one after the body at low health forks even out of sight; one not after it is left alone', () => {
	assert.match(lowHealthFork(sample({ canHealNow: true, bestFood: bread, threats: [mob('zombie', { distance: 4 })] })).fork, /^health 5 with a zombie 4 blocks away/);
	assert.match(lowHealthFork(sample({ canHealNow: true, bestFood: bread, threats: [mob('skeleton', { lineOfSight: false, distance: 12 })] })).fork, /health 5 with a skeleton/);
	assert.deepEqual(lowHealthFork(sample({ canHealNow: true, bestFood: bread, threats: [mob('skeleton', { targeting: false, signals: [], lineOfSight: false, distance: 12 })] })), { recover: 'eat', food: bread });
	assert.match(lowHealthFork(sample({ canHealNow: true, bestFood: bread, threats: [mob('creeper', { targeting: false, signals: [], lineOfSight: false, distance: 7 })] })).fork, /creeper/);
	assert.match(lowHealthFork(sample({ canHealNow: true, bestFood: bread, threats: [mob('creeper', { targeting: false, signals: [], lineOfSight: true, distance: 14 })] })).fork, /creeper/);
});

test('a mob it would fight at good health is still a fork: recovery does not fight', () => {
	const judged = lowHealthFork(sample({ health: 19, canHealNow: true, bestFood: bread, threats: [mob('zombie', { distance: 4 })] }));
	assert.match(judged.fork, /recovering does not fight/);
});

test('body hazards fork first', () => {
	assert.equal(lowHealthFork(sample({ canHealNow: true, bestFood: bread, inLava: true })).fork, 'in lava');
	assert.equal(lowHealthFork(sample({ canHealNow: true, bestFood: bread, onFire: true })).fork, 'on fire');
});

test('eatCalls: hotbar food by select_item, slots 9-35 by select_tool into the selected slot, then use_item', () => {
	assert.deepEqual(eatCalls(bread, 4), [
		{ actionType: 'select_item', arguments: { itemId: 'minecraft:bread' } },
		{ actionType: 'use_item', arguments: { durationMs: 2000, expectedItemId: 'minecraft:bread' } },
	]);
	assert.deepEqual(eatCalls({ ...bread, slot: 30 }, 4)[0], { actionType: 'select_tool', arguments: { sourceSlot: 30, hotbarSlot: 4, expectedItemId: 'minecraft:bread', minRemainingDurability: 0 } });
	assert.equal(eatCalls({ ...bread, slot: 30 }, undefined)[0].arguments.hotbarSlot, 0);
	// The offhand (slot 40) is eaten with the off hand; an armor slot is out of reach of every call.
	assert.deepEqual(eatCalls({ ...bread, slot: 40 }), [{ actionType: 'use_item', arguments: { durationMs: 2000, hand: 'off' } }]);
	assert.equal(eatCalls({ ...bread, slot: 37 }), null);
	assert.ok(lowHealthFork(sample({ canHealNow: true, bestFood: { ...bread, slot: 37 } })).fork);
});
