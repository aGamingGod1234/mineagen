// Playtest 22 Nov (lane 2): the bot stood on an iron ore at the end of a tunnel, mine_vein refused the block under its
// feet, and obtain wrote the ore off as unreachable; the next iron trip saw it 2.9 blocks away and tunnelled past it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { locate, runObtain } from '../src/obtain-runner.mjs';
import { checkedObtainBody } from './helpers/checked-body.mjs';

const need = { kind: 'block', blocks: ['iron_ore', 'deepslate_iron_ore'], accept: ['raw_iron'], count: 3 };
const at = (extra = {}) => ({ world: { dimension: 'minecraft:overworld' }, player: { x: 298.5, y: 15, z: -240.5, health: 20, onGround: true },
	blocks: [], ...extra });
const ore = { id: 'minecraft:iron_ore', kind: 'block', x: 298, y: 14, z: -261, count: 1, source: 'local', placed: false, dimension: 'minecraft:overworld' };

test('an ore seen earlier and out of view now is walked back to before any new search', async () => {
	let searched = 0;
	const body = { observe: async () => at({ seenResources: [ore] }), search: async () => { searched++; return { reasonCode: 'FIND_NOT_FOUND' }; } };
	const where = await locate(need, body, { budget: { failed: new Set() }, timeoutMs: 60_000 });
	assert.deepEqual([where?.x, where?.y, where?.z, where?.blockId], [298, 14, -261, 'minecraft:iron_ore']);
	assert.equal(where.remembered, true);
	assert.equal(searched, 0, 'no search while a known ore is in walking range');
});

test('a remembered ore a search found unreachable, or one this run failed at, is not walked back to', async () => {
	for (const [budget, missed] of [[{ failed: new Set(['298,14,-261']) }, []], [{ failed: new Set() }, [{ x: 298, y: 14, z: -261, why: 'unreachable' }]]]) {
		let searched = 0;
		const body = { observe: async () => at({ seenResources: [ore] }), missedPlaces: () => missed,
			search: async () => { searched++; return { reasonCode: 'FIND_NOT_FOUND' }; } };
		assert.equal(await locate(need, body, { budget, timeoutMs: 60_000 }), null);
		assert.equal(searched, 1, 'searches anew instead');
	}
});

test('a remembered ore that costs more to reach than a fresh search (far, or 60 blocks down), another ore, or a mob row is not picked', async () => {
	for (const row of [{ ...ore, z: -400 }, { ...ore, y: -45, z: -245 }, { ...ore, id: 'minecraft:gold_ore' }, { ...ore, kind: 'mob' }]) {
		const body = { observe: async () => at({ seenResources: [row] }), search: async () => ({ reasonCode: 'FIND_NOT_FOUND' }) };
		assert.equal(await locate(need, body, { budget: { failed: new Set() }, timeoutMs: 60_000 }), null, JSON.stringify(row));
	}
});

test('an ore under the body (VEIN_UNDER_BODY) is not written off as unreachable for later searches', async () => {
	const missed = [];
	const o = () => ({ world: { dimension: 'minecraft:overworld' }, player: { x: 298.5, y: 15, z: -260.5, health: 20, food: 20, onGround: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1, remainingDurability: 100 }] },
		blocks: [{ blockId: 'minecraft:iron_ore', x: 298, y: 14, z: -261 }, { blockId: 'minecraft:stone', x: 298, y: 14, z: -260 }] });
	const body = checkedObtainBody({ observe: async () => o(), stopped: () => false, interrupted: () => false, note: () => {},
		act: async () => ({ state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' }),
		mine: async () => ({ state: 'FAILED', reasonCode: 'VEIN_UNDER_BODY', message: 'every seen block lies under the body' }),
		search: async () => ({ reasonCode: 'FIND_NOT_FOUND', message: 'not found' }),
		missPlace: (place, why) => missed.push({ ...place, why }) });
	let t = 0;
	await runObtain({ item: 'raw_iron', count: 1, timeoutMs: 60_000 }, body, { now: () => (t += 1000) });
	assert.deepEqual(missed.filter((row) => row.why === 'unreachable'), [], 'the ore stays a known source');
});

test('a remembered ore is walked toward until it shows, aimed at the cell over it', async () => {
	const acts = [];
	const o = () => at({ inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1, remainingDurability: 100 }] },
		player: { x: 319.5, y: 15, z: -249.5, health: 20, food: 20, onGround: true }, seenResources: [ore] });
	const body = checkedObtainBody({ observe: async () => o(), stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type, args) => { acts.push([type, args]); return { state: 'FAILED', reasonCode: 'NO_ROUTE' }; },
		mine: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), search: async () => ({ reasonCode: 'FIND_NOT_FOUND' }), missPlace: () => {} });
	let t = 0;
	await runObtain({ item: 'raw_iron', count: 1, timeoutMs: 30_000 }, body, { now: () => (t += 1000) });
	const walk = acts.find(([type]) => type === 'travel_to')?.[1];
	assert.deepEqual([walk?.x, walk?.y, walk?.z, walk?.stopWhenSeen], [298.5, 15, -260.5, 'minecraft:iron_ore']);
});

test('review: a remembered walk that sights another block of the ore takes that one, not the old cell behind rock', async () => {
	const acts = [], mined = [], missed = [];
	let player = { x: 319.5, y: 15, z: -249.5, health: 20, food: 20, onGround: true };
	const near = { blockId: 'minecraft:iron_ore', x: 300, y: 14, z: -255 };
	const o = () => at({ inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1, remainingDurability: 100 }] },
		player, seenResources: [ore], blocks: player.x < 302 ? [near] : [] });
	const body = checkedObtainBody({ observe: async () => o(), stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type, args) => {
			acts.push([type, args]);
			if (type === 'travel_to') { player = { ...player, x: 300.5, z: -253.5 }; return { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 300,14,-255, 2 blocks away' }; }
			return { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' };
		},
		mine: async (args) => { mined.push(args); return { state: 'FAILED', reasonCode: 'HOSTILE_NEAR' }; },
		search: async () => ({ reasonCode: 'FIND_NOT_FOUND' }), missPlace: (place, why) => missed.push({ ...place, why }) });
	let t = 0;
	await runObtain({ item: 'raw_iron', count: 1, timeoutMs: 20_000 }, body, { now: () => (t += 1000) });
	assert.deepEqual([mined[0]?.x, mined[0]?.y, mined[0]?.z], [300, 14, -255], 'mines the ore the walk saw');
	assert.equal(acts.filter(([type, args]) => type === 'dig_to' && args.x === 298).length, 0, 'no dig toward the old cell');
	assert.equal(missed.filter((row) => row.x === 298 && row.z === -261).length, 0, 'the old cell is not written off');
});

test('review: a remembered ore joined to a cell a search marked unreachable is not walked back to', async () => {
	const neighbour = { ...ore, z: -262 };
	let searched = 0;
	const body = { observe: async () => at({ seenResources: [neighbour] }), missedPlaces: () => [{ x: 298, y: 14, z: -261, why: 'unreachable' }],
		search: async () => { searched++; return { reasonCode: 'FIND_NOT_FOUND' }; } };
	assert.equal(await locate(need, body, { budget: { failed: new Set() }, timeoutMs: 60_000 }), null);
	assert.equal(searched, 1);
});
