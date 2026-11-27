import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSearchBody, searchFor } from './helpers/checked-body.mjs';
import { routeLine, ROUTE_BYTES } from '../src/skill-fits.mjs';

const target = { block: 'minecraft:end_portal_frame' };
const brick = (x = 0, y = 31, z = 0) => ({ blockId: 'minecraft:stone_bricks', x, y, z });
const frame = (x = 20, y = 32, z = 0) => ({ blockId: 'minecraft:end_portal_frame', x, y, z });
function body({ eyes = 8, x = 0, y = 32, z = 0 } = {}) {
	let clock = 0;
	const o = { player: { x, y, z, health: 20, threats: [] }, world: { dimension: 'minecraft:overworld' },
		blocks: [brick(x, y - 1, z)], inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:ender_eye', count: eyes, slot: 0 }] } };
	const b = checkedSearchBody({ o, calls: [], eyeSearchState: {}, now: () => clock, observe: async () => structuredClone(o),
		look: async () => { clock += 100; return { survey: {} }; }, frontier: () => ({ candidates: [] }), known: () => ({ blocks: [] }),
		act: async (type, args, options) => {
			b.calls.push({ type, args }); clock += 1000;
			const stop = b.stop?.(type, args);
			if (stop) return stop;
			if (type === 'travel_to') Object.assign(o.player, { x: args.x, y: args.y, z: args.z });
			b.after?.(type, args);
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED', ...(options?.watch?.(o) ? { seen: options.watch(o) } : {}) };
		},
	});
	return b;
}

test('masonry is not a portal-frame success, including without remaining eyes', async () => {
	for (const eyes of [8, 0]) {
		const b = body({ eyes });
		const r = await searchFor(target, b);
		assert.equal(r.reasonCode, 'FIND_BLOCKED'); assert.equal(r.find.target, 'end_portal_frame');
		assert.equal(r.find.seen, undefined); assert.equal(b.calls.length, 0);
	}
});
test('a far seen or remembered frame requires walking into its room and fresh sight', async () => {
	for (const fresh of [true, false]) {
		const b = body();
		b.known = () => ({ blocks: [frame()] });
		if (fresh) b.o.blocks.push(frame());
		const r = await searchFor(target, b);
		assert.equal(r.reasonCode, fresh ? 'FIND_SEEN' : 'FIND_BLOCKED');
		assert.equal(b.calls[0].type, 'travel_to');
		assert.equal(b.calls[0].args.build, false);
		assert.ok(b.calls[0].args.timeoutMs <= 20_000);
		if (fresh) assert.equal(r.find.seen.id, 'minecraft:end_portal_frame');
	}
});
test('danger retains unvisited destination for resume, with no throw or search reset', async () => {
	for (const code of ['LAVA_AHEAD', 'AIR_RESERVE_REACHED', 'LOW_HEALTH', 'HOSTILE_NEAR']) {
		const b = body(); b.known = () => ({ blocks: [frame()] });
		b.stop = () => ({ state: 'FAILED', reasonCode: code });
		const first = await searchFor(target, b);
		assert.equal(first.reasonCode, 'FIND_DANGER');
		assert.equal(first.find.portal.pending.length, 1);
		b.stop = null; b.after = () => { b.o.blocks = [frame()]; };
		const resumed = await searchFor(target, b);
		assert.equal(resumed.reasonCode, 'FIND_SEEN');
		assert.deepEqual(resumed.find.portal.origin, first.find.portal.origin);
		assert.equal(b.calls.every(c => c.type === 'travel_to'), true);
	}
});
test('fresh danger precedes nearby frame success, stale frames never certify a room', async () => {
	const b = body(); b.o.blocks.push(frame(1)); b.o.player.health = 7;
	assert.equal((await searchFor(target, b)).reasonCode, 'FIND_DANGER'); assert.equal(b.calls.length, 0);
	b.o.player.health = 20; b.o.continuity = { rememberedSections: ['blocks'] };
	assert.equal((await searchFor(target, b)).reasonCode, 'FIND_BLOCKED');
});
test('a frame seen from the passage still needs physical approach into reach', async () => {
	const b = body(); b.o.blocks.push(frame(5));
	assert.equal((await searchFor(target, b)).reasonCode, 'FIND_SEEN');
	assert.equal(b.calls[0].type, 'travel_to');
});
test('portal exploration stays inside within, skips blocked footing, and stops at budget', async () => {
	const b = body(); b.frontier = () => ({ candidates: [{ x: 100, y: 32, z: 0 }, { x: 8, y: 32, z: 0, blocked: true }] });
	assert.equal((await searchFor(target, b, { within: 16 })).reasonCode, 'FIND_BLOCKED');
	assert.equal(b.calls.length, 0);
	assert.equal((await searchFor(target, b, { timeoutMs: 500 })).reasonCode, 'FIND_BUDGET');
});
test('known masonry covering a floor prevents treating its wall as walkable footing', async () => {
	const b = body(); b.o.blocks = [brick(8), brick(8, 32), brick(8, 33), brick(8, 34)];
	assert.equal((await searchFor(target, b)).reasonCode, 'FIND_BLOCKED');
	assert.equal(b.calls.length, 0);
});
test('route tells the model to explore masonry before replacing eyes lost on the journey', () => {
	const b = body(); b.o.ready = true; b.o.observedAtEpochMs = 10;
	b.o.inventory.items.push({ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:cooked_beef', count: 20 });
	const line = routeLine({ observation: b.o, known: {}, evaluate: () => ({ ok: true }) });
	assert.match(line, /find block end_portal_frame walks observed passages/);
	assert.match(line, /resume after handling danger/);
	assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES);
});
// A twelve-eyes game handed back the same unreachable wall-top spots 3-5 times each for 87 min inside a stronghold.
async function withEnv(name, value, run) {
	const old = process.env[name];
	if (value === undefined) delete process.env[name]; else process.env[name] = value;
	try { return await run(); } finally { if (old === undefined) delete process.env[name]; else process.env[name] = old; }
}
function deadSpotBody() {
	const b = body();
	// The near spot is a wall top: every walk to it fails where it stands. The far one is a real passage.
	b.frontier = () => ({ candidates: [{ x: 3, y: 32, z: 0 }, { x: 9, y: 32, z: 0 }] });
	b.stop = (type, args) => type === 'travel_to' && Math.floor(args.x) === 3 ? { state: 'FAILED', reasonCode: 'NO_ROUTE' } : null;
	return b;
}
const triesAtDeadSpot = b => b.calls.filter(c => c.type === 'travel_to' && Math.floor(c.args.x) === 3).length;
test('a spot the walk could not reach is not offered again, and the next spot is tried in the same call', async () => {
	await withEnv('MINEAGEN_PORTAL_SKIP_FAILED', undefined, async () => {
		const b = deadSpotBody();
		await searchFor(target, b, { timeoutMs: 30_000 });
		await searchFor(target, b, { timeoutMs: 30_000 });
		assert.equal(triesAtDeadSpot(b), 1, 'the dead spot is walked to once across two finds');
		assert.ok(b.calls.some(c => c.type === 'travel_to' && Math.floor(c.args.x) === 9), 'the passage beyond it is walked in the first find');
		assert.equal(b.eyeSearchState.portal.failed.length, 1);
	});
	await withEnv('MINEAGEN_PORTAL_SKIP_FAILED', 'off', async () => {
		const b = deadSpotBody();
		const first = await searchFor(target, b, { timeoutMs: 30_000 });
		assert.equal(first.reasonCode, 'FIND_BLOCKED');
		await searchFor(target, b, { timeoutMs: 30_000 });
		assert.equal(triesAtDeadSpot(b), 2, 'off arm: each find hands back the same dead spot');
		assert.equal(first.find.portal.failed, undefined);
	});
});
test('a search hands back after a few dead spots in one call', async () => {
	await withEnv('MINEAGEN_PORTAL_SKIP_FAILED', undefined, async () => {
		const b = body();
		b.frontier = () => ({ candidates: [3, 6, 9, 12, 15, 18].map(x => ({ x, y: 32, z: 0 })) });
		b.stop = type => type === 'travel_to' ? { state: 'FAILED', reasonCode: 'NO_ROUTE' } : null;
		const r = await searchFor(target, b, { timeoutMs: 60_000 });
		assert.equal(r.reasonCode, 'FIND_BLOCKED');
		assert.equal(b.calls.filter(c => c.type === 'travel_to').length, 4);
		assert.equal(r.find.portal.failed, 4);
	});
});
