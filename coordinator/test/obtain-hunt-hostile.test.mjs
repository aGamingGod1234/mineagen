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

for (const reason of ['TARGET_UNREACHABLE', 'NO_SEEN_ROUTE', 'FIGHT_UNTIL_TIMED_OUT', 'NO_TARGET_SEEN']) test(`a hunt under cover that ends ${reason} climbs out on the next round`, async () => {
	const calls = [];
	const cave = { type: 'minecraft:cave_spider', uuid: 'cs', x: 10.5, y: 20, z: 0.5, hostile: true, alive: true, visible: true, distance: 10 };
	const body = {
		observe: async () => ({ ready: true, player: { x: 0.5, y: 20, z: 0.5, health: 20, foodLevel: 20, skyOpen: false, onGround: true, threats: [] },
			world: { dimension: 'minecraft:overworld', dayTime: 6000 }, blocks: [], entities: [cave], inventory: { items: [{ itemId: 'minecraft:iron_sword', count: 1, slot: 0 }] } }),
		act: async (actionType) => {
			calls.push(actionType);
			if (actionType === 'fight_until') return { state: 'FAILED', reasonCode: reason, message: 'no way to it' };
			return { state: 'FAILED', reasonCode: 'NO_STANCE', message: 'no stance' };
		},
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }),
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	await runObtain({ item: 'string', count: 2, timeoutMs: 600_000 }, body, { now: clock() });
	assert.equal(calls.filter((type) => type === 'fight_until').length, 1, JSON.stringify(calls));
	assert.ok(calls.indexOf('dig_to') > calls.indexOf('fight_until'), `climbs after the failed hunt: ${JSON.stringify(calls)}`);
});

test('a second skeleton drawing on the body during a bone hunt\'s walk-up is still danger', async () => {
	const calls = [];
	const state = { at: { x: 0.5, y: 64, z: 0.5 } };
	const hunted = { type: 'minecraft:skeleton', uuid: 'h', stableId: 'h', x: 60.5, y: 64, z: 0.5, hostile: true, alive: true, visible: true };
	const shooter = { type: 'minecraft:skeleton', uuid: 's', stableId: 's', x: 15.5, y: 64, z: 30.5, hostile: true, alive: true, visible: true, targeting: true };
	const rows = () => [hunted, ...(calls.includes('travel_to') ? [shooter] : [])].map((row) => ({ ...row, distance: Math.hypot(row.x - state.at.x, row.z - state.at.z) }));
	const body = {
		observe: async () => ({ ready: true, player: { ...state.at, health: 20, foodLevel: 20, skyOpen: true, onGround: true, threats: rows().filter((row) => row.distance <= 48) },
			world: { dimension: 'minecraft:overworld', dayTime: 6000 }, blocks: [], entities: rows(), inventory: { items: [{ itemId: 'minecraft:iron_sword', count: 1, slot: 0 }] } }),
		act: async (actionType) => {
			calls.push(actionType);
			if (actionType === 'travel_to') { state.at = { x: 15.5, y: 64, z: 0.5 }; return { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:skeleton targeting 30 blocks away' }; }
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		},
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }),
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	const result = await runObtain({ item: 'bone', count: 2, timeoutMs: 600_000 }, body, { now: clock() });
	assert.equal(result.state, 'INTERRUPTED', result.message);
	assert.equal(result.reasonCode, 'DANGER');
	assert.equal(calls.filter((type) => type === 'travel_to').length, 1);
});

test('the hunted skeleton drawing on the body is still the walk-up\'s arrival', async () => {
	const calls = [];
	const state = { at: { x: 0.5, y: 64, z: 0.5 }, bone: 0 };
	const hunted = { type: 'minecraft:skeleton', uuid: 'h', stableId: 'h', x: 40.5, y: 64, z: 0.5, hostile: true, alive: true, visible: true };
	const rows = () => [{ ...hunted, targeting: calls.includes('travel_to'), distance: Math.hypot(hunted.x - state.at.x, hunted.z - state.at.z) }];
	const body = {
		observe: async () => ({ ready: true, player: { ...state.at, health: 20, foodLevel: 20, skyOpen: true, onGround: true, threats: rows() },
			world: { dimension: 'minecraft:overworld', dayTime: 6000 }, blocks: [], entities: rows(),
			inventory: { items: [{ itemId: 'minecraft:iron_sword', count: 1, slot: 0 }, ...(state.bone ? [{ itemId: 'minecraft:bone', count: state.bone, slot: 1 }] : [])] } }),
		act: async (actionType, args) => {
			calls.push(actionType);
			if (actionType === 'travel_to') { state.at = { x: 26.5, y: 64, z: 0.5 }; return { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:skeleton targeting 14 blocks away' }; }
			if (actionType === 'fight_until') { state.bone = args.untilCount; return { state: 'SUCCEEDED', reasonCode: 'TARGET_REACHED' }; }
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		},
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }),
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	const result = await runObtain({ item: 'bone', count: 2, timeoutMs: 600_000 }, body, { now: clock() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.deepEqual(calls.filter((type) => ['travel_to', 'fight_until'].includes(type)), ['travel_to', 'fight_until']);
});

test('after climbing out of a failed hunt under cover, a spider on the surface above the spot is hunted', async () => {
	const calls = [];
	const state = { at: { x: 0.5, y: 20, z: 0.5 }, string: 0 };
	const cave = { type: 'minecraft:cave_spider', uuid: 'cs', stableId: 'cs', x: 10.5, y: 20, z: 0.5, hostile: true, alive: true, visible: true };
	const top = { type: 'minecraft:spider', uuid: 'sp', stableId: 'sp', x: 20.5, y: 64, z: 0.5, hostile: true, alive: true, visible: true };
	const sky = () => state.at.y >= 60;
	const rows = () => (sky() ? [top] : [cave]).map((row) => ({ ...row, distance: Math.hypot(row.x - state.at.x, row.y - state.at.y, row.z - state.at.z) }));
	const body = {
		observe: async () => ({ ready: true, player: { ...state.at, health: 20, foodLevel: 20, skyOpen: sky(), onGround: true, threats: [] },
			world: { dimension: 'minecraft:overworld', dayTime: 6000 }, blocks: [], entities: rows(),
			inventory: { items: [{ itemId: 'minecraft:iron_sword', count: 1, slot: 0 }, { itemId: 'minecraft:stone_pickaxe', count: 1, slot: 2 }, ...(state.string ? [{ itemId: 'minecraft:string', count: state.string, slot: 1 }] : [])] } }),
		act: async (actionType, args) => {
			calls.push(actionType);
			if (actionType === 'fight_until') {
				if (!sky()) return { state: 'FAILED', reasonCode: 'FIGHT_UNTIL_TIMED_OUT', message: 'out of time' };
				state.string = args.untilCount; return { state: 'SUCCEEDED', reasonCode: 'TARGET_REACHED' };
			}
			if (actionType === 'dig_to') { state.at = { x: 0.5, y: 64, z: 0.5 }; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED', message: 'at the surface' }; }
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		},
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }),
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	const result = await runObtain({ item: 'string', count: 2, timeoutMs: 600_000 }, body, { now: clock() });
	assert.equal(result.state, 'SUCCEEDED', `${result.message} ${JSON.stringify(calls)}`);
	assert.equal(calls.filter((type) => type === 'fight_until').length, 2, JSON.stringify(calls));
});
