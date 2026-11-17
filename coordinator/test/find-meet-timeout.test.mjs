import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFor } from '../src/find-search.mjs';

// K7 (issue #2): find stands for a mob after the body that is not in reach yet (fight_target pursue:false). One that never
// comes (behind rock) used to hold the body for the fight's whole 20 s timeout before the search went on.
test('K7: a mob that never comes into reach holds a search at most 8 s', async () => {
	const zombie = { uuid: 'z1', stableId: 'z1', type: 'minecraft:zombie', distance: 10, targeting: true, lineOfSight: true, signals: ['targeting'] };
	let observation = {
		player: { x: 0.5, y: -54, z: 0.5, yaw: 0, health: 20, skyOpen: false, threats: [zombie] },
		world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains' }, inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }] },
		entities: [{ stableId: 'z1', type: 'minecraft:zombie', hostile: true, x: 10.5, y: -54, z: 0.5 }],
	};
	let clock = 0, stood = null;
	const digs = [{ state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:zombie z1 at 10,-54,0, 10.0 blocks away' },
		{ state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 8,-54,3, 9 blocks away' }];
	const body = {
		now: () => clock,
		progress: () => {},
		observe: async () => structuredClone(observation),
		look: async () => { clock += 2_000; return { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => {
			if (actionType === 'fight_target') {
				// The mob never comes: the fight waits out its whole timeout.
				assert.equal(args.pursue, false);
				stood = args.timeoutMs;
				clock += args.timeoutMs;
				return { state: 'TIMED_OUT', reasonCode: 'FIGHT_TIMED_OUT' };
			}
			clock += 3_000;
			return digs.shift() ?? { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED' };
		},
		frontier: () => ({ candidates: [], coverage: { headings: {} } }),
		known: () => null,
		places: async () => [],
	};
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	// Metric: body time stood for a mob that never came. Pass bar: at most 8 s (it was 20 s); find's leg floor is 5 s.
	assert.ok(stood !== null && stood <= 8_000, `stood ${stood} ms for a mob that never came`);
});
