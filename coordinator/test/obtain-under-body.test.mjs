// Playtest 22 Nov: the bot stood on an iron ore at the end of a tunnel, mine_vein refused the block under its feet, and
// obtain wrote the ore off as unreachable; the next iron trip saw it 2.9 blocks away and tunnelled past it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runObtain } from '../src/obtain-runner.mjs';

test('an ore under the body (VEIN_UNDER_BODY) is not written off as unreachable for later searches', async () => {
	const missed = [];
	const o = () => ({ world: { dimension: 'minecraft:overworld' }, player: { x: 298.5, y: 15, z: -260.5, health: 20, food: 20, onGround: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1, remainingDurability: 100 }] },
		blocks: [{ blockId: 'minecraft:iron_ore', x: 298, y: 14, z: -261 }, { blockId: 'minecraft:stone', x: 298, y: 14, z: -260 }] });
	const body = { observe: async () => o(), stopped: () => false, interrupted: () => false, note: () => {},
		act: async () => ({ state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' }),
		mine: async () => ({ state: 'FAILED', reasonCode: 'VEIN_UNDER_BODY', message: 'every seen block lies under the body' }),
		search: async () => ({ reasonCode: 'FIND_NOT_FOUND', message: 'not found' }),
		missPlace: (place, why) => missed.push({ ...place, why }) };
	let t = 0;
	await runObtain({ item: 'raw_iron', count: 1, timeoutMs: 60_000 }, body, { now: () => (t += 1000) });
	assert.deepEqual(missed.filter((row) => row.why === 'unreachable'), [], 'the ore stays a known source');
});

test('an ore under the body with no stance mine_vein can take: obtain steps back once and mines it from there', async () => {
	const calls = [];
	const o = () => ({ world: { dimension: 'minecraft:overworld' }, player: { x: 298.5, y: 15, z: -260.5, yaw: 180, health: 20, food: 20, onGround: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1, remainingDurability: 100 }] },
		blocks: [{ blockId: 'minecraft:iron_ore', x: 298, y: 14, z: -261 }] });
	let mines = 0;
	const body = { observe: async () => o(), stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type, args) => { calls.push([type, args]); return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; },
		mine: async (args) => { calls.push(['mine', args]); return mines++ === 0 ? { state: 'FAILED', reasonCode: 'VEIN_UNDER_BODY' } : { state: 'SUCCEEDED', reasonCode: 'VEIN_MINED', message: 'mined: 1 minecraft:iron_ore in 1 s' }; },
		search: async () => ({ reasonCode: 'FIND_NOT_FOUND' }), missPlace: () => {} };
	let t = 0;
	await runObtain({ item: 'raw_iron', count: 1, timeoutMs: 30_000 }, body, { now: () => (t += 1000) });
	const first = calls.findIndex(([type]) => type === 'mine');
	assert.deepEqual(calls[first + 1]?.[0], 'travel_to', 'a step back after VEIN_UNDER_BODY');
	assert.deepEqual([calls[first + 1][1].yaw, calls[first + 1][1].distance], [0, 2], 'back the way it faced from');
	assert.equal(calls[first + 2]?.[0], 'mine', 'then mines again');
});

test('drops not picked up after a vein: the body steps into the pocket itself, not its rim', async () => {
	const calls = [];
	const o = () => ({ world: { dimension: 'minecraft:overworld' }, player: { x: 299.4, y: 15, z: -261.5, yaw: 90, health: 20, food: 20, onGround: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1, remainingDurability: 100 }] },
		blocks: [{ blockId: 'minecraft:iron_ore', x: 298, y: 14, z: -262 }] });
	const body = { observe: async () => o(), stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type, args) => { calls.push([type, args]); return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; },
		mine: async () => ({ state: 'SUCCEEDED', reasonCode: 'VEIN_MINED', message: 'mined: 2 minecraft:iron_ore in 4 s; no seen block of it is left' }),
		search: async () => ({ reasonCode: 'FIND_NOT_FOUND' }), missPlace: () => {} };
	let t = 0;
	await runObtain({ item: 'raw_iron', count: 2, timeoutMs: 600_000 }, body, { now: () => (t += 100) });
	const into = calls.find(([type, args]) => type === 'travel_to' && args.x === 298.5 && args.z === -261.5);
	assert.ok(into, 'walks into the mined pocket');
	assert.ok(into[1].tolerance <= 0.5, `into the cell, not within a block of it: tolerance ${into[1].tolerance}`);
});

test('the pocket step: never into lava or water, and climbs back out to its mining level after the pickup', async () => {
	const run = async (extra) => {
		const calls = [];
		let player = { x: 299.4, y: 15, z: -261.5, yaw: 90, health: 20, food: 20, onGround: true };
		const o = () => ({ world: { dimension: 'minecraft:overworld' }, player,
			inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1, remainingDurability: 100 }] },
			blocks: [{ blockId: 'minecraft:iron_ore', x: 298, y: 14, z: -262 }, ...extra] });
		const body = { observe: async () => o(), stopped: () => false, interrupted: () => false, note: () => {},
			act: async (type, args) => { calls.push([type, args]); if (type === 'travel_to' && args.tolerance < 1) player = { ...player, x: 298.5, y: 13, z: -261.5 }; else if (type === 'travel_to') player = { ...player, x: args.x, y: args.y, z: args.z }; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; },
			mine: async () => ({ state: 'SUCCEEDED', reasonCode: 'VEIN_MINED', message: 'mined: 2 minecraft:iron_ore in 4 s' }),
			search: async () => ({ reasonCode: 'FIND_NOT_FOUND' }), missPlace: () => {} };
		let t = 0;
		await runObtain({ item: 'raw_iron', count: 2, timeoutMs: 600_000 }, body, { now: () => (t += 100) });
		return calls;
	};
	const dry = await run([]);
	const into = dry.findIndex(([type, args]) => type === 'travel_to' && args.tolerance < 1);
	assert.ok(into >= 0);
	const out = dry.slice(into + 1).find(([type]) => type === 'dig_to');
	assert.deepEqual([out?.[1].pattern, out?.[1].y], ['stairs_up', 15], 'stairs back up to the level it mined from');
	const lava = await run([{ blockId: 'minecraft:lava', x: 298, y: 12, z: -262 }]);
	assert.equal(lava.filter(([type, args]) => type === 'travel_to' && args.tolerance < 1).length, 0, 'no step into a pocket over lava');
});

test('water under the pocket\'s solid floor does not keep the bot out of a dry pocket', async () => {
	const calls = [];
	const o = () => ({ world: { dimension: 'minecraft:overworld' }, player: { x: 299.4, y: 15, z: -261.5, yaw: 90, health: 20, food: 20, onGround: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1, remainingDurability: 100 }] },
		blocks: [{ blockId: 'minecraft:iron_ore', x: 298, y: 14, z: -262 }, { blockId: 'minecraft:stone', x: 298, y: 12, z: -262 }, { blockId: 'minecraft:water', x: 298, y: 11, z: -262 }] });
	const body = { observe: async () => o(), stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type, args) => { calls.push([type, args]); return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; },
		mine: async () => ({ state: 'SUCCEEDED', reasonCode: 'VEIN_MINED', message: 'mined: 2 minecraft:iron_ore in 4 s' }),
		search: async () => ({ reasonCode: 'FIND_NOT_FOUND' }), missPlace: () => {} };
	let t = 0;
	await runObtain({ item: 'raw_iron', count: 2, timeoutMs: 600_000 }, body, { now: () => (t += 100) });
	assert.ok(calls.some(([type, args]) => type === 'travel_to' && args.tolerance < 1), 'steps into the dry pocket');
});
