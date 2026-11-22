import assert from 'node:assert/strict';
import test from 'node:test';
import { runObtain } from './helpers/checked-body.mjs';

// obtain string hunts a spider. Walking up to one more than 12 blocks off, travel stops for it once it is close
// (HOSTILE_NEAR): that stop is the hunt's arrival, not danger. Another hostile near the body still is.

function spiderHunt({ others = [] } = {}) {
	const calls = [];
	const state = { at: { x: 0.5, y: 64, z: 0.5 }, string: 0 };
	const spider = { type: 'minecraft:spider', uuid: 'sp', x: 30.5, y: 64, z: 0.5, hostile: true, alive: true, visible: true };
	const mobs = () => [spider, ...others].map((row) => ({ ...row, distance: Math.hypot(row.x - state.at.x, row.z - state.at.z) }));
	const body = {
		observe: async () => ({ ready: true, player: { ...state.at, health: 20, foodLevel: 20, skyOpen: true, onGround: true, threats: mobs().filter((row) => row.distance <= 16) },
			world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains', dayTime: 6000 }, blocks: [], entities: mobs(),
			inventory: { items: [{ itemId: 'minecraft:iron_sword', count: 1, slot: 0 }, ...(state.string ? [{ itemId: 'minecraft:string', count: state.string, slot: 1 }] : [])] } }),
		act: async (actionType, args) => {
			calls.push(actionType);
			if (actionType === 'travel_to') {
				state.at = { x: spider.x - 5, y: 64, z: spider.z };
				return { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:spider 5.0 blocks away' };
			}
			if (actionType === 'fight_until') { state.string = args.untilCount; return { state: 'SUCCEEDED', reasonCode: 'TARGET_REACHED', message: 'done' }; }
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		},
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }),
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	return { body, calls };
}
const clock = () => { let t = 0; return () => (t += 100); };

test('a walk-up stopped by the spider being hunted goes on to the fight', async () => {
	const { body, calls } = spiderHunt();
	const result = await runObtain({ item: 'string', count: 3, timeoutMs: 600_000 }, body, { now: clock() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.deepEqual(calls.filter((type) => ['travel_to', 'fight_until'].includes(type)), ['travel_to', 'fight_until']);
});

test('a zombie near the body during the walk-up still stops the hunt as danger', async () => {
	const { body, calls } = spiderHunt({ others: [{ type: 'minecraft:zombie', uuid: 'zb', x: 27.5, y: 64, z: 3.5, hostile: true, alive: true, visible: true }] });
	const result = await runObtain({ item: 'string', count: 3, timeoutMs: 600_000 }, body, { now: clock() });
	assert.equal(result.state, 'INTERRUPTED', result.message);
	assert.equal(result.reasonCode, 'DANGER');
	assert.ok(!calls.includes('fight_until'));
});

test('a cave spider in view under cover is hunted there, not climbed away from', async () => {
	const calls = [];
	let string = 0;
	const at = { x: 0.5, y: 20, z: 0.5 };
	const cave = { type: 'minecraft:cave_spider', uuid: 'cs', x: 6.5, y: 20, z: 0.5, hostile: true, alive: true, visible: true, distance: 6 };
	const body = {
		observe: async () => ({ ready: true, player: { ...at, health: 20, foodLevel: 20, skyOpen: false, onGround: true, threats: [] },
			world: { dimension: 'minecraft:overworld', dayTime: 15000 }, blocks: [], entities: [cave],
			inventory: { items: [{ itemId: 'minecraft:iron_sword', count: 1, slot: 0 }, ...(string ? [{ itemId: 'minecraft:string', count: string, slot: 1 }] : [])] } }),
		act: async (actionType, args) => {
			calls.push(actionType);
			if (actionType === 'fight_until') { string = args.untilCount; return { state: 'SUCCEEDED', reasonCode: 'TARGET_REACHED' }; }
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		},
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }),
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	const result = await runObtain({ item: 'string', count: 2, timeoutMs: 600_000 }, body, { now: clock() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.ok(calls.includes('fight_until'), JSON.stringify(calls));
	assert.ok(!calls.includes('dig_to'), `no climb: ${JSON.stringify(calls)}`);
});

test('a cow heard through a cave ceiling still means climbing out first', async () => {
	const calls = [];
	const cow = { type: 'minecraft:cow', uuid: 'c', x: 4.5, y: 40, z: 0.5, alive: true, visible: false, perceivedBy: 'sound', distance: 20 };
	const body = {
		observe: async () => ({ ready: true, player: { x: 0.5, y: 20, z: 0.5, health: 20, foodLevel: 20, skyOpen: false, onGround: true, threats: [] },
			world: { dimension: 'minecraft:overworld', dayTime: 6000 }, blocks: [], entities: [cow], inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }] } }),
		act: async (actionType) => { calls.push(actionType); return { state: 'FAILED', reasonCode: 'NO_STANCE', message: 'no stance' }; },
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }),
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	await runObtain({ item: 'beef', count: 1, timeoutMs: 600_000 }, body, { now: clock() });
	assert.ok(calls.includes('dig_to'), `climbs: ${JSON.stringify(calls)}`);
	assert.ok(!calls.includes('fight_until'), JSON.stringify(calls));
});

test('a hunt under cover that cannot reach its mob climbs out on the next round', async () => {
	const calls = [];
	const cave = { type: 'minecraft:cave_spider', uuid: 'cs', x: 10.5, y: 20, z: 0.5, hostile: true, alive: true, visible: true, distance: 10 };
	const body = {
		observe: async () => ({ ready: true, player: { x: 0.5, y: 20, z: 0.5, health: 20, foodLevel: 20, skyOpen: false, onGround: true, threats: [] },
			world: { dimension: 'minecraft:overworld', dayTime: 6000 }, blocks: [], entities: [cave], inventory: { items: [{ itemId: 'minecraft:iron_sword', count: 1, slot: 0 }] } }),
		act: async (actionType) => {
			calls.push(actionType);
			if (actionType === 'fight_until') return { state: 'FAILED', reasonCode: 'TARGET_OUT_OF_REACH', message: 'no path' };
			return { state: 'FAILED', reasonCode: 'NO_STANCE', message: 'no stance' };
		},
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }),
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	await runObtain({ item: 'string', count: 2, timeoutMs: 600_000 }, body, { now: clock() });
	assert.equal(calls.filter((type) => type === 'fight_until').length, 1, JSON.stringify(calls));
	assert.ok(calls.indexOf('dig_to') > calls.indexOf('fight_until'), `climbs after the failed hunt: ${JSON.stringify(calls)}`);
});
