import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

// kit.ironTripArmour through the production obtain path: after an iron kit obtain down a mine, the kit habit runs a
// nested obtain for the chestplate's raw iron, at most once per IRON_TOPUP_SPACING_MS per agent. This replay has no ore,
// so the top-up's search gives out; what is checked is who opens a top-up, how often, and what the model is told.
async function session({ clock = undefined, hurt = () => false } = {}) {
	const record = { agentId: 'trip-agent', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
	let sequence = 1;
	const traces = [];
	const observation = { world: { dimension: 'minecraft:overworld' },
		player: { x: 0.5, y: 20, z: 0.5, yaw: 0, health: 20, air: 300, maxAir: 300, onGround: true, skyOpen: false },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_pickaxe', slot: 'mainhand', count: 1 }, { itemId: 'minecraft:shield', slot: 'offhand', count: 1 },
			{ itemId: 'minecraft:iron_ingot', slot: 10, count: 6 }, { itemId: 'minecraft:oak_planks', slot: 11, count: 8 }, { itemId: 'minecraft:crafting_table', slot: 1, count: 1 }, { itemId: 'minecraft:flint', slot: 12, count: 1 }] }, blocks: [] };
	for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) observation.blocks.push({ blockId: 'minecraft:stone', x, y: 19, z, placeableFaces: ['up'] });
	const take = (itemId, count) => {
		const row = observation.inventory.items.find(item => item.itemId === itemId);
		row.count -= count;
		observation.inventory.items = observation.inventory.items.filter(item => item.count > 0);
	};
	const runtime = new NativeToolRuntime({ kitHabit: true, ...(clock ? { clock } : {}), registry: { get: () => record }, trace: (event, fields) => { traces.push({ event, ...fields }); },
		requestObservation: async () => ({ observation: structuredClone(observation), eventSequence: ++sequence }),
		inspectObservation: async (_r, q) => ({ section: q.section, entries: observation.blocks, coverage: { hasMore: false }, eventSequence: ++sequence }),
		bridge: { send: async (type, _a, p) => {
			if (type !== 'action_command') return;
			const a = p.arguments;
			if (p.actionType === 'place_block') { observation.blocks.push({ blockId: a.itemId, x: a.x, y: a.y, z: a.z }); take(a.itemId, 1); }
			if (p.actionType === 'break_block') {
				const table = block => block.x === a.x && block.y === a.y && block.z === a.z && block.blockId === 'minecraft:crafting_table';
				if (observation.blocks.some(table)) observation.inventory.items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 });
				observation.blocks = observation.blocks.filter(block => !table(block));
			}
			if (p.actionType === 'craft_table' || p.actionType === 'craft_inventory') {
				assert.ok(['minecraft:bucket', 'minecraft:flint_and_steel'].includes(a.recipeId), `unexpected recipe ${a.recipeId}`);
				take('minecraft:iron_ingot', a.recipeId === 'minecraft:bucket' ? 3 : 1);
				if (a.recipeId === 'minecraft:flint_and_steel') take('minecraft:flint', 1);
				observation.inventory.items.push({ itemId: a.recipeId, slot: 5, count: 1 });
			}
			// The search finds nothing: every leg ends at once with no ore seen.
			const crafting = ['craft_table', 'craft_inventory', 'place_block', 'break_block', 'equip_item', 'select_tool'].includes(p.actionType);
			// hurt(): a mob hits the body as the top-up's search digs (kit.ironTripResume), as a creeper stopped A/B game ab2 freshd19.
			const state = crafting ? 'SUCCEEDED' : 'FAILED';
			const reasonCode = crafting ? 'ACTION_COMPLETED' : hurt() && p.actionType === 'dig_to' ? 'DAMAGE_TAKEN' : 'NO_PATH';
			queueMicrotask(() => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state, reasonCode, executionStarted: true }));
		} } });
	runtime.updateObservation(record, structuredClone(observation), { eventSequence: sequence });
	const obtain = async (item) => runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 't', callId: `c-${item}`,
		tool: normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item, timeoutMs: 60000 }, why: 'iron trip armour acceptance' }) }, record);
	return { obtain, traces, dispose: () => runtime.dispose(record.agentId, 'test_complete') };
}

test('an iron kit obtain down a mine opens one top-up; the next iron kit obtain soon after does not', { timeout: 60_000 }, async () => {
	const { obtain, traces, dispose } = await session();
	try {
		const first = await obtain('bucket');
		assert.equal(first.state, 'SUCCEEDED', JSON.stringify(first));
		assert.equal(traces.filter(row => row.event === 'native_iron_topup').length, 1);
		assert.match(first.message, /kit: mining the iron_chestplate's iron stopped \(/);
		const second = await obtain('flint_and_steel');
		assert.equal(second.state, 'SUCCEEDED', JSON.stringify(second));
		assert.equal(traces.filter(row => row.event === 'native_iron_topup').length, 1, 'spaced out: no second top-up within 5 minutes');
	} finally { await dispose(); }
});

test('with MINEAGEN_IRON_TRIP_ARMOUR=off the iron kit obtain hands back with no top-up', { timeout: 60_000 }, async () => {
	process.env.MINEAGEN_IRON_TRIP_ARMOUR = 'off';
	const { obtain, traces, dispose } = await session();
	try {
		const result = await obtain('bucket');
		assert.equal(result.state, 'SUCCEEDED', JSON.stringify(result));
		assert.equal(traces.filter(row => row.event === 'native_iron_topup').length, 0);
		assert.doesNotMatch(result.message, /iron_chestplate/);
	} finally { delete process.env.MINEAGEN_IRON_TRIP_ARMOUR; await dispose(); }
});

// kit.ironTripResume: a top-up stopped for danger (or night, or its cap) re-arms a minute later, twice per window; one that
// ran dry keeps the 5 min.
function fakeClock() {
	// Wall time plus a skip the test adds (clock.t += ms moves it on), so waits inside a step stay real.
	let skip = 0;
	const clock = { now: () => Date.now() + skip, sleep: (ms) => new Promise(resolve => { setTimeout(resolve, ms); }) };
	Object.defineProperty(clock, 't', { get: () => clock.now(), set: (value) => { skip += value - clock.now(); } });
	return clock;
}

// A mob on the search's legs stops the top-up for danger while gate.danger is on.
async function stalling() {
	const clock = fakeClock();
	const gate = { danger: true };
	const run = await session({ clock, hurt: () => gate.danger });
	const obtain = async (item, wait = 0) => { clock.t += wait; return run.obtain(item); };
	return { ...run, obtain, clock, gate };
}

test('kit.ironTripResume: a top-up stopped for danger re-arms after a minute, twice per window; a dry one waits the spacing', { timeout: 60_000 }, async () => {
	const { obtain, traces, dispose, gate } = await stalling();
	const tops = () => traces.filter(row => row.event === 'native_iron_topup');
	const armed = () => traces.filter(row => row.event === 'native_iron_topup_resume_armed');
	try {
		await obtain('bucket');
		assert.equal(tops().length, 1);
		assert.equal(armed().length, 1, JSON.stringify(traces.filter(row => row.event === 'native_obtain_step').map(row => row.text).slice(-3)));
		assert.equal(armed()[0].stoppedBy, 'DANGER');
		await obtain('flint_and_steel', 30_000);
		assert.equal(tops().length, 1, 'not within the minute');
		await obtain('flint_and_steel', 31_000);
		assert.equal(tops().length, 2, 'a minute on, the next iron kit obtain resumes it');
		assert.equal(tops()[1].resume, 1);
		await obtain('flint_and_steel', 61_000);
		assert.equal(tops().length, 3);
		assert.equal(tops()[2].resume, 2);
		assert.equal(armed().length, 2, 'the second resume stopped too and arms nothing after it');
		await obtain('flint_and_steel', 61_000);
		assert.equal(tops().length, 3, 'two resumes per window');
		// A full spacing on, a new window: this top-up runs dry (no ore, no mob) and keeps the 5 minutes.
		gate.danger = false;
		await obtain('flint_and_steel', 300_000);
		assert.equal(tops().length, 4);
		assert.equal(tops()[3].resume, 0);
		assert.equal(armed().length, 2);
		await obtain('flint_and_steel', 61_000);
		assert.equal(tops().length, 4, 'a dry top-up is not resumed');
	} finally { await dispose(); }
});

test('with MINEAGEN_IRON_TRIP_RESUME=off a top-up stopped for danger waits the full spacing', { timeout: 60_000 }, async () => {
	process.env.MINEAGEN_IRON_TRIP_RESUME = 'off';
	const { obtain, traces, dispose } = await stalling();
	try {
		await obtain('bucket');
		await obtain('flint_and_steel', 61_000);
		assert.equal(traces.filter(row => row.event === 'native_iron_topup').length, 1);
		assert.equal(traces.filter(row => row.event === 'native_iron_topup_resume_armed').length, 0);
	} finally { delete process.env.MINEAGEN_IRON_TRIP_RESUME; await dispose(); }
});
