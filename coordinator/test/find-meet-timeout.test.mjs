import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSearchBody, searchFor } from './helpers/checked-body.mjs';

// The game names every seen entity by a UUID; fight_target refuses any other id.
const ZOMBIE = '00000000-0000-4000-8000-0000000000a1';

// K7 (issue #2): find stands for a mob after the body that is not in reach yet (fight_target pursue:false). One that never
// comes (behind rock) used to hold the body for the fight's whole 20 s timeout before the search went on.
test('K7: a mob that never comes into reach holds a search at most 8 s', async () => {
	const zombie = { uuid: ZOMBIE, stableId: ZOMBIE, type: 'minecraft:zombie', distance: 10, targeting: true, lineOfSight: true, signals: ['targeting'] };
	let observation = {
		player: { x: 0.5, y: -54, z: 0.5, yaw: 0, health: 20, skyOpen: false, threats: [zombie] },
		world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains' }, inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }] },
		entities: [{ stableId: ZOMBIE, type: 'minecraft:zombie', hostile: true, x: 10.5, y: -54, z: 0.5 }],
	};
	let clock = 0, stood = null;
	const digs = [{ state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: `Stopped: minecraft:zombie ${ZOMBIE} at 10,-54,0, 10.0 blocks away` },
		{ state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 8,-54,3, 9 blocks away' }];
	const body = checkedSearchBody({
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
	});
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	// Metric: body time stood for a mob that never came. Pass bar: at most 8 s (it was 20 s); find's leg floor is 5 s.
	assert.ok(stood !== null && stood <= 8_000, `stood ${stood} ms for a mob that never came`);
});

// MEET_MS covers the wait and the fight: a zombie that arrives after 3-4 s and needs about 5 s to kill times the 8 s out
// alive and in reach. That is no mob that never came: the search fights it on for a whole fight.
test('K7: a mob that came late and timed the meet out in reach is fought on, not walked away from', async () => {
	const zombie = { uuid: ZOMBIE, stableId: ZOMBIE, type: 'minecraft:zombie', distance: 10, targeting: true, lineOfSight: true, signals: ['targeting'] };
	let observation = {
		player: { x: 0.5, y: -54, z: 0.5, yaw: 0, health: 20, skyOpen: false, threats: [zombie] },
		world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains' }, inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }] },
		entities: [{ stableId: ZOMBIE, type: 'minecraft:zombie', hostile: true, x: 10.5, y: -54, z: 0.5 }],
	};
	let clock = 0;
	const fights = [];
	const digs = [{ state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: `Stopped: minecraft:zombie ${ZOMBIE} at 10,-54,0, 10.0 blocks away` },
		{ state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 8,-54,3, 9 blocks away' }];
	const body = checkedSearchBody({
		now: () => clock,
		progress: () => {},
		observe: async () => structuredClone(observation),
		look: async () => { clock += 2_000; return { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => {
			if (actionType === 'fight_target') {
				fights.push(args.timeoutMs);
				clock += args.timeoutMs;
				if (fights.length === 1) {
					// It arrived and was hit, but the meet ran out with it alive beside the body.
					observation = { ...observation, entities: [{ stableId: ZOMBIE, type: 'minecraft:zombie', hostile: true, x: 2.0, y: -54, z: 0.5 }] };
					return { state: 'TIMED_OUT', reasonCode: 'FIGHT_TIMED_OUT' };
				}
				observation = { ...observation, entities: [], player: { ...observation.player, threats: [] } };
				return { state: 'SUCCEEDED', reasonCode: 'TARGET_KILLED' };
			}
			clock += 3_000;
			return digs.shift() ?? { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED' };
		},
		frontier: () => ({ candidates: [], coverage: { headings: {} } }),
		known: () => null,
		places: async () => [],
	});
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.deepEqual(fights, [8_000, 30_000], 'the meet, then a whole fight for the mob in reach');
});
