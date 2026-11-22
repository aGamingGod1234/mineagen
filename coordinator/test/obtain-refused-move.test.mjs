import assert from 'node:assert/strict';
import test from 'node:test';
import { runObtain } from './helpers/checked-body.mjs';

// A move the tool refuses comes back from the production obtain body as a FAILED result; a body that throws the refusal
// (as the checked test bodies do) is taken the same way, and the step's failure names it.

test("a thrown INVALID_MINECRAFT_TOOL_ARGUMENTS becomes the craft step's recorded failure, not an escaped throw", async () => {
	const acts = [];
	const body = {
		observe: async () => ({ ready: true, player: { x: 0.5, y: 64, z: 0.5, health: 20, foodLevel: 20, skyOpen: true, onGround: true },
			world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains' }, blocks: [],
			inventory: { items: [{ itemId: 'minecraft:oak_log', count: 1, slot: 0 }] } }),
		act: async (actionType, args) => {
			acts.push(actionType);
			throw Object.assign(new TypeError(`refused ${actionType} for this test`), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
		},
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'Searched to 96 blocks from the start' }),
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	const result = await runObtain({ item: 'oak_planks', count: 4, timeoutMs: 600_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.ok(acts.includes('craft_inventory'), JSON.stringify(acts));
	assert.equal(result.state, 'FAILED', result.message);
	assert.match(result.message, /INVALID_MINECRAFT_TOOL_ARGUMENTS/);
});

test('any other thrown error still escapes, as before', async () => {
	const body = {
		observe: async () => ({ ready: true, player: { x: 0.5, y: 64, z: 0.5, health: 20, foodLevel: 20, skyOpen: true, onGround: true },
			world: { dimension: 'minecraft:overworld' }, blocks: [], inventory: { items: [{ itemId: 'minecraft:oak_log', count: 1, slot: 0 }] } }),
		act: async () => { throw Object.assign(new Error('cancelled'), { code: 'NATIVE_ACTION_CANCELLED' }); },
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }),
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	await assert.rejects(runObtain({ item: 'oak_planks', count: 4, timeoutMs: 600_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })() }), { code: 'NATIVE_ACTION_CANCELLED' });
});
