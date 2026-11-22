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
