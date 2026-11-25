import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { BED_SEARCH_MIN } from '../src/need-sources.mjs';

const T0 = 1_800_000_000_000, MIN = 60_000;
const record = { agentId: 'a1', goalRevision: 1, currentGoal: 'Beat the game', currentGoalSpec: { originalRequest: 'Beat the game', fingerprint: 'f1' } };
const step = (id, check) => ({ id, label: id, kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check });
const steps = [step('nether', 'in:minecraft:the_nether'), step('rods', 'has:minecraft:blaze_rod*6')];
const frame = { axis: 'x', interior: [2, 3], obsidian: 10, needed: 10, missing: [], blocked: [], lit: true, x: 10, y: 64, z: 10 };
const sample = (at, { dimension = 'minecraft:overworld', x = 12, z = 12, items = [], sighted = true, dead = false, spawn } = {}) => ({
	ready: !dead, observedAtEpochMs: at, world: { worldId: 'w1', dimension }, player: { x, y: 64, z, dead },
	inventory: { items }, ...(sighted && dimension === 'minecraft:overworld' ? { sighted: { portalFrames: [frame] } } : {}),
	...(spawn ? { perception: { events: [{ type: 'system_message', text: 'Respawn point set', observedAtEpochMs: at }] }, blocks: [{ blockId: 'minecraft:white_bed', ...spawn }] } : {}) });
const bed = header => (header?.options ?? '').match(/option (quick respawn bed|bed by the nether portal)[^|]*/)?.[0] ?? null;

async function visited() {
	let now = T0;
	const views = new LiveTaskViews({ now: () => now });
	await views.observe(record, sample(now));
	await views.operate(record, { operation: 'replace', plan: { steps } });
	now += MIN; await views.observe(record, sample(now, { dimension: 'minecraft:the_nether', x: 1, z: 1 }));
	return { views, at: () => now, step: async (ms, o) => { now += ms; await views.observe(record, sample(now, o)); return views.continuity(record); } };
}

test('every Overworld return to the visited portal offers the bed by it, with a bed or wool held', async () => {
	const g = await visited();
	assert.match(bed(await g.step(MIN, { items: [{ itemId: 'minecraft:white_bed', count: 1 }] })), /quick respawn bed.*the bed carried.*used by the nether portal/);
	// After a death in the Nether, back at the portal with wool: offered again.
	await g.step(MIN, { dimension: 'minecraft:the_nether', x: 1, z: 1 });
	await g.step(MIN, { dimension: 'minecraft:the_nether', dead: true });
	assert.match(bed(await g.step(MIN, { items: [{ itemId: 'minecraft:red_wool', count: 3 }] })), /matching wool held/);
	// Away from the portal (and not in view) it is not offered.
	assert.equal(bed(await g.step(MIN, { x: 400, z: 400, sighted: false, items: [{ itemId: 'minecraft:red_wool', count: 3 }] })), null);
});

test('a respawn set by the portal ends the offer', async () => {
	const g = await visited();
	await g.step(MIN, { items: [{ itemId: 'minecraft:white_bed', count: 1 }], spawn: { x: 14, y: 64, z: 9 } });
	// Walked off and back: the bed by this portal is set, so nothing more to offer.
	assert.equal(bed(await g.step(MIN, { x: 30, z: 30, items: [{ itemId: 'minecraft:red_wool', count: 3 }] })), null);
});

test('with nothing for a bed, a short sheep look is offered for a few minutes each life', async () => {
	const g = await visited();
	assert.match(bed(await g.step(MIN, {})), new RegExp(`look for sheep nearby .* at most ${BED_SEARCH_MIN} min`));
	assert.equal(bed(await g.step(BED_SEARCH_MIN * MIN, {})), null, 'the look is over this life');
	await g.step(MIN, { dimension: 'minecraft:the_nether', x: 1, z: 1 });
	await g.step(MIN, { dimension: 'minecraft:the_nether', dead: true });
	assert.match(bed(await g.step(MIN, {})), /look for sheep nearby/, 'a new life offers it again');
});
