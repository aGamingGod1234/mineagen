import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_MS, noteSearch, progressFacts } from '../src/step-progress.mjs';

const focus = { id: 'iron', label: 'Iron pickaxe and bucket', check: null };
const state = () => ({ progress: { lastGain: 0 }, alarms: {}, observation: {} });
const receipt = (actionType, ok = true) => ({ actionType, state: ok ? 'SUCCEEDED' : 'FAILED' });

test('three minutes of looking and short moves with no plan progress is stated once, with the ways to get the resource', () => {
	const s = state();
	let at = 10_000, fired = 0;
	for (let i = 0; i < 14; i++) {
		at += 14_000;
		fired += noteSearch(s, i % 3 === 0 ? receipt('navigate_to', i % 2 === 0) : receipt('control'), at, focus) ? 1 : 0;
	}
	assert.ok(at >= SEARCH_MS);
	assert.equal(fired, 1, 'stated once');
	const line = progressFacts(s, at, focus).search;
	assert.match(line, /^Searching 3 min with no plan progress: \d+ camera turns, \d+ moves \(\d+ failed\), 0 work actions; step iron: unchecked\. Ways to get iron: exposed ore/);
	assert.match(line, /staircase near y16/);
	s.progress.lastGain = at + 1;
	assert.equal(progressFacts(s, at + 2, focus).search, undefined, 'plan progress clears it');
});

test('working (breaking, digging, crafting) or early minutes state nothing', () => {
	const busy = state();
	let at = 10_000, fired = 0;
	for (let i = 0; i < 20; i++) { at += 12_000; fired += noteSearch(busy, receipt(i % 4 === 0 ? 'break_block' : 'control'), at, focus) ? 1 : 0; }
	assert.equal(fired, 0, 'four or more work actions mean it is working, not searching');
	const early = state();
	for (let i = 0; i < 20; i++) assert.equal(noteSearch(early, receipt('control'), 1_000 + i * 5_000, focus), false, 'under three minutes since progress');
});

test('a step result says what it gained, spent and wore, so no inventory inspect is needed after it', async () => {
	const { stepChange } = await import('../src/step-progress.mjs');
	const before = [{ itemId: 'minecraft:iron_pickaxe', count: 1, damage: 10, maxDamage: 250 }, { itemId: 'minecraft:coal', count: 5 }, { itemId: 'minecraft:stone_pickaxe', count: 1, damage: 120, maxDamage: 131 }];
	const after = [{ itemId: 'minecraft:iron_pickaxe', count: 1, damage: 52, maxDamage: 250 }, { itemId: 'minecraft:coal', count: 3 }, { itemId: 'minecraft:raw_iron', count: 4 }, { itemId: 'minecraft:cobblestone', count: 30 }];
	assert.equal(stepChange(before, after), 'held +4 raw_iron, -2 coal, -1 stone_pickaxe, +30 stone/dirt; tool uses iron_pickaxe -42 (198 left), stone_pickaxe -11 (broke)');
	assert.equal(stepChange(after, after), 'inventory unchanged', 'a failed step that changed nothing says so');
	assert.equal(stepChange(null, after), null, 'no starting inventory: unknown, not unchanged');
});
