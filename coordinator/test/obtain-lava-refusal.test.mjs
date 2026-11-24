import assert from 'node:assert/strict';
import test from 'node:test';
import { runObtain } from './helpers/checked-body.mjs';
import { lavaRefusalOnly } from '../src/obtain-runner.mjs';

// Cobblestone gathered beside a lava pool: the dig refuses one block for lava heard behind it. The body is safe, so the
// block is skipped and the obtain carries on to another, instead of ending as DANGER.

const refusal = { state: 'FAILED', reasonCode: 'LAVA_AHEAD', message: 'Stopped: Lava is heard beside this block, about 2 block(s) away; not breaking minecraft:stone at 2,63,0' };

function stoneBody() {
	let cobble = 0;
	const calls = [];
	const observe = async () => ({ ready: true, player: { x: 0.5, y: 64, z: 0.5, health: 20, maxHealth: 20, foodLevel: 20, air: 300, maxAir: 300, skyOpen: true, onGround: true },
		world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains' },
		blocks: !calls.includes('dig_to') ? [] : [{ blockId: 'minecraft:stone', x: 2, y: 63, z: 0, count: 40, distance: 2 }, { blockId: 'minecraft:stone', x: -3, y: 63, z: 1, count: 40, distance: 3 }],
		inventory: { items: [{ itemId: 'minecraft:wooden_pickaxe', count: 1, slot: 0, damage: 0, maxDamage: 59 }, ...(cobble > 0 ? [{ itemId: 'minecraft:cobblestone', count: cobble, slot: 1 }] : [])] } });
	const answer = async (kind) => {
		calls.push(kind);
		if (kind === 'dig_to' && !calls.slice(0, -1).includes('dig_to')) return refusal;
		cobble += 3;
		return { state: 'SUCCEEDED', reasonCode: 'GATHERED', broken: 3 };
	};
	return {
		calls,
		body: {
			observe, act: async (type) => (['break_block', 'dig_to', 'mine_vein'].includes(type) ? answer(type) : { state: 'SUCCEEDED' }),
			mine: async () => answer('mine'), gather: async () => answer('gather'), moveTo: async () => ({ state: 'SUCCEEDED' }),
			search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }),
			survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
		},
	};
}

test('a dig refused for lava heard behind the block, with the body safe, is not danger', () => {
	const safe = { ready: true, player: { health: 20, air: 300, maxAir: 300 } };
	assert.equal(lavaRefusalOnly(refusal, safe), true);
	assert.equal(lavaRefusalOnly(refusal, { player: { ...safe.player, inLava: true } }), false);
	assert.equal(lavaRefusalOnly(refusal, null), false);
	assert.equal(lavaRefusalOnly(refusal, { ...safe, ready: false }), false);
	assert.equal(lavaRefusalOnly(refusal, { ...safe, player: { ...safe.player, dead: true, health: 0 } }), false);
	assert.equal(lavaRefusalOnly({ ...refusal, message: 'Stopped: Lava at 2,63,1 (flowing, not a pool) beside the opened cell 2,63,0; plugged it' }, safe), false);
});

test('obtain cobblestone goes on past a block the dig refused for lava heard behind it', async () => {
	const { body, calls } = stoneBody();
	const result = await runObtain({ item: 'cobblestone', count: 3, timeoutMs: 600_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.ok(calls.includes('dig_to') && calls.lastIndexOf('gather') > calls.indexOf('dig_to'), JSON.stringify(calls));
	assert.notEqual(result.reasonCode, 'DANGER', result.message);
	assert.equal(result.state, 'SUCCEEDED', `${result.reasonCode}: ${result.message}`);
});
