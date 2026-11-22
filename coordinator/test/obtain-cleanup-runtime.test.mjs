import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { checkedObtainBody, runObtain } from './helpers/checked-body.mjs';

const keepAlive = setInterval(() => {}, 1000);
// A stop the coordinator makes for a fork, not for danger (Step 3: fork stops keep their own codes).
const FORK = { reasonCode: 'LOW_HEALTH', message: 'Health 7: recover first' };
test.after(() => clearInterval(keepAlive));
// Independent review's production setup: real normalization, runtime and station placement;
// inert bridge inventory effects establish terminal completion, not Minecraft physics.
async function replay(scenario) {
	const record = { agentId: 'cleanup-agent', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' };
	let sequence = 1, crafted = false, samples = 0, craftFailures = 0, failureSamples = 0;
	const commands = [];
	const observation = { world: { dimension: 'minecraft:overworld' },
		player: { x: 0.5, y: 64, z: 0.5, yaw: 0, health: 20, air: 300, maxAir: 300, onGround: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_ingot', slot: 0, count: 3 }, { itemId: 'minecraft:crafting_table', slot: 1, count: 1 }] }, blocks: [] };
	for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) observation.blocks.push({ blockId: 'minecraft:stone', x, y: 63, z, placeableFaces: ['up'] });
	let runtime;
	runtime = new NativeToolRuntime({ registry: { get: () => record }, requestObservation: async () => {
		if (craftFailures >= 2 && ++failureSamples >= 2 && scenario === 'failed-fresh-danger') observation.player.air = 90;
		if (crafted && ++samples >= 2 && scenario === 'cancelled') {
			runtime.interruptBlockingTool(record.agentId);
			await runtime.dispose(record.agentId, 'explicit_test_cancellation');
		}
		if (crafted && samples >= 2 && scenario === 'fresh-danger') { observation.player.air = 90; observation.player.underWater = true; }
		const sample = structuredClone(observation);
		if (crafted && samples === 1 && scenario === 'transient-terminal-danger') sample.player.air = 90;
		if (crafted && samples === 3 && scenario === 'cleanup-observation-error') throw new Error('Fresh cleanup observation unavailable');
		return { observation: sample, eventSequence: ++sequence };
	}, inspectObservation: async (_r, q) => ({ section: q.section, entries: observation.blocks, coverage: { hasMore: false }, eventSequence: ++sequence }),
	bridge: { send: async (type, _a, p) => {
		commands.push({ type, ...p });
		if (type !== 'action_command') return;
		assert.ok(commands.length < 60, 'bounded production replay');
		if (p.actionType === 'place_block') { observation.blocks.push({ blockId: p.arguments.itemId, x: p.arguments.x, y: p.arguments.y, z: p.arguments.z }); observation.inventory.items.splice(1, 1); }
		if (p.actionType === 'craft_table' && scenario === 'craft-fork') { queueMicrotask(() => runtime.interruptBlockingTool(record.agentId, { forkStop: FORK })); return; }
		if (p.actionType === 'craft_table' && scenario.startsWith('failed-')) {
			craftFailures++;
			queueMicrotask(() => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state: 'FAILED', reasonCode: 'CRAFT_FAILED', executionStarted: true }));
			return;
		}
		if (p.actionType === 'craft_table') { if (scenario === 'after-move-danger') observation.player.x = 8; crafted = true; observation.inventory.items.push({ itemId: 'minecraft:bucket', slot: 2, count: 1 }, { itemId: 'minecraft:water_bucket', slot: 3, count: 1 }); }
		if (p.actionType === 'navigate_to' && scenario === 'after-move-danger') observation.player.onFire = true;
		if (p.actionType === 'break_block') {
			if (scenario === 'running' || scenario === 'failed-running') { queueMicrotask(() => runtime.interruptBlockingTool(record.agentId)); return; }
			if (scenario === 'running-fork') { queueMicrotask(() => runtime.interruptBlockingTool(record.agentId, { forkStop: FORK })); return; }
			if (scenario === 'ordinary') observation.inventory.items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 });
			if (scenario === 'after-break-danger') { observation.player.onFire = true; }
			if (scenario === 'inventory-loss') observation.inventory.items = [];
		}
		queueMicrotask(() => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED', executionStarted: true }));
	} } });
	runtime.updateObservation(record, structuredClone(observation), { eventSequence: sequence });
	try {
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: scenario, callId: scenario,
			tool: normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'water_bucket', timeoutMs: 60000 }, why: 'cleanup acceptance' }) }, record);
		return { result, commands: structuredClone(commands) };
	} finally { await runtime.dispose(record.agentId, 'test_complete'); }
}

test('production cleanup interruption returns the current live break without premature cancellation', async () => {
	const { result, commands } = await replay('running');
	assert.equal(result.reasonCode, 'DANGER');
	assert.equal(result.state, 'INTERRUPTED');
	assert.equal(result.stations.left, 1);
	const actions = commands.filter(c => c.type === 'action_command');
	assert.equal(actions.at(-1).actionType, 'break_block');
	assert.equal(result.running.actionId, actions.at(-1).actionId);
	assert.equal(commands.filter(c => c.type === 'action_cancel').length, 0);
});
for (const scenario of ['craft-fork', 'running-fork']) test(`production ${scenario}: a fork stop ends obtain with its own code and line, not DANGER`, async () => {
	const { result, commands } = await replay(scenario);
	assert.equal(result.state, 'INTERRUPTED');
	assert.equal(result.reasonCode, 'LOW_HEALTH', JSON.stringify(result));
	assert.match(result.message, /Health 7: recover first/);
	assert.doesNotMatch(result.message, /danger/i);
	const actions = commands.filter(c => c.type === 'action_command');
	assert.equal(actions.at(-1).actionType, scenario === 'craft-fork' ? 'craft_table' : 'break_block');
	assert.equal(result.running.actionId, actions.at(-1).actionId, 'the leg the fork cut short is handed back');
	assert.equal(commands.filter(c => c.type === 'action_cancel').length, 0);
});
for (const scenario of ['fresh-danger', 'after-break-danger']) test(`production ${scenario} stops cleanup dispatch and retains stations`, async () => {
	const { result, commands } = await replay(scenario);
	assert.equal(result.reasonCode, 'DANGER');
	assert.equal(result.stations.left, 1);
	const actions = commands.filter(c => c.type === 'action_command');
	assert.equal(actions.filter(c => c.actionType === 'break_block').length, scenario === 'fresh-danger' ? 0 : 1);
	assert.equal(actions.at(-1).actionType, scenario === 'fresh-danger' ? 'craft_table' : 'break_block');
});
test('production ordinary cleanup still breaks the station and finishes', async () => {
	const { result, commands } = await replay('ordinary');
	assert.equal(result.reasonCode, 'OBTAINED');
	assert.equal(result.stations.left, 0);
	assert.equal(commands.filter(c => c.actionType === 'break_block').length, 1);
});
test('production inventory loss during cleanup remains not obtained', async () => {
	const { result } = await replay('inventory-loss');
	assert.equal(result.reasonCode, 'OBTAIN_LOST');
	assert.equal(result.held, 0);
});

for (const scenario of ['failed-fresh-danger', 'failed-running']) test(`production ${scenario}: danger overrides earlier capability failure`, async () => {
	const { result, commands } = await replay(scenario);
	assert.equal(result.reasonCode, 'DANGER', JSON.stringify(result));
	assert.equal(result.stations.left, 1);
	const actions = commands.filter(c => c.type === 'action_command');
	assert.equal(actions.filter(c => c.actionType === 'craft_table').length, 2);
	assert.equal(actions.filter(c => c.actionType === 'break_block').length, scenario === 'failed-running' ? 1 : 0);
	if (scenario === 'failed-running') assert.equal(result.running.actionId, actions.at(-1).actionId);
	assert.equal(commands.filter(c => c.type === 'action_cancel').length, 0);
});

// Caller-owned ledgers are private in NativeToolRuntime; assert both arrays directly as well.
test('cleanup cancellation outranks raw danger and retains station/load ledgers', async () => {
	for (const cancelled of [false, true]) {
		const placed = [{ kind: 'furnace', x: 0, y: 64, z: 1 }], loads = [{ x: 0, y: 64, z: 1, output: 'iron_ingot', want: 3 }];
		let stopped = false, interrupted = false, breaks = 0;
		const result = await runObtain({ item: 'water_bucket' }, checkedObtainBody({
			observe: async () => ({ player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [{ itemId: 'minecraft:water_bucket', count: 1 }] } }),
			stopped: () => stopped, interrupted: () => interrupted, note: () => {},
			act: async () => { breaks++; stopped = cancelled; interrupted = true; return { state: 'RUNNING', actionId: 'live-cleanup' }; },
		}), { placed, loads });
		assert.equal(result.reasonCode, cancelled ? 'CANCELLED' : 'DANGER');
		assert.equal(result.running.actionId, 'live-cleanup');
		assert.equal(breaks, 1);
		assert.equal(placed.length, 1);
		assert.equal(loads.length, 1);
	}
});


test('production fresh danger after cleanup movement prevents the break and retains the station', async () => {
	const { result, commands } = await replay('after-move-danger');
	assert.equal(result.reasonCode, 'DANGER', JSON.stringify(result));
	assert.equal(result.stations.left, 1);
	const actions = commands.filter(c => c.type === 'action_command');
	assert.equal(actions.at(-1).actionType, 'navigate_to');
	assert.equal(actions.filter(c => c.actionType === 'break_block').length, 0);
});
test('production explicit lifecycle cancellation outranks simultaneous raw interruption at finalization', async () => {
	const { result, commands } = await replay('cancelled');
	assert.equal(result.reasonCode, 'CANCELLED', JSON.stringify(result));
	assert.equal(result.state, 'CANCELLED');
	assert.equal(result.stations.left, 1);
	assert.equal(commands.filter(c => c.actionType === 'break_block').length, 0);
});

for (const scenario of ['transient-terminal-danger', 'cleanup-observation-error']) test(`production ${scenario} stays latched through a healthy final sample`, async () => {
	const { result, commands } = await replay(scenario);
	assert.equal(result.reasonCode, scenario === 'transient-terminal-danger' ? 'DANGER' : 'OBSERVATION_UNAVAILABLE');
	assert.notEqual(result.state, 'SUCCEEDED');
	assert.equal(result.stations.left, 1);
	assert.deepEqual(commands.filter(c => c.type === 'action_command').map(c => c.actionType), ['place_block', 'craft_table']);
	assert.equal(commands.filter(c => c.type === 'action_cancel').length, 0);
});

// Two calls exercise the same runtime-owned station ledger: interruption leaves the
// table, then a gather call encounters missing cleanup evidence before canopy work.
test('production nonterminal cleanup stops canopy actions after an observation fault', async () => {
	const record = { agentId: 'cleanup-canopy', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' };
	let sequence = 1, phase = 1, crafted = false, samples = 0, broken = false, faulted = false, commandsAtFault = 0;
	const commands = [];
	const observation = { world: { dimension: 'minecraft:overworld' }, player: { x: 0.5, y: 64, z: 0.5, health: 20, air: 300, maxAir: 300, onGround: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_ingot', slot: 0, count: 3 }, { itemId: 'minecraft:crafting_table', slot: 1, count: 1 }] }, blocks: [] };
	for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) observation.blocks.push({ blockId: 'minecraft:stone', x, y: 63, z, placeableFaces: ['up'] });
	let runtime;
	runtime = new NativeToolRuntime({ registry: { get: () => record }, requestObservation: async () => {
		if (crafted) samples++;
		if (phase === 2 && broken && !faulted) { faulted = true; commandsAtFault = commands.length; throw new Error('Cleanup observation unavailable'); }
		const sample = structuredClone(observation);
		if (phase === 1 && samples === 1) sample.player.air = 90;
		return { observation: sample, eventSequence: ++sequence };
	}, inspectObservation: async (_r, q) => ({ section: q.section, entries: observation.blocks, coverage: { hasMore: false }, eventSequence: ++sequence }),
	bridge: { send: async (type, _a, payload) => {
		commands.push({ type, ...payload });
		if (type !== 'action_command') return;
		assert.ok(commands.length < 50, 'bounded production replay');
		if (payload.actionType === 'place_block') { observation.blocks.push({ blockId: payload.arguments.itemId, ...payload.arguments }); observation.inventory.items.splice(1, 1); }
		if (payload.actionType === 'craft_table') { crafted = true; observation.inventory.items.push({ itemId: 'minecraft:bucket', slot: 2, count: 1 }, { itemId: 'minecraft:water_bucket', slot: 3, count: 1 }); }
		if (payload.actionType === 'break_block') broken = true;
		queueMicrotask(() => runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED', executionStarted: true }));
	} } });
	runtime.updateObservation(record, structuredClone(observation), { eventSequence: sequence });
	const obtain = item => runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'canopy', callId: item,
		tool: normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item, timeoutMs: 60000 }, why: 'cleanup stop acceptance' }) }, record);
	try {
		const first = await obtain('water_bucket');
		assert.equal(first.reasonCode, 'DANGER');
		assert.equal(first.stations.left, 1);
		phase = 2;
		observation.blocks.find(b => b.x === 0 && b.y === 63 && b.z === 0).blockId = 'minecraft:oak_leaves';
		const next = await obtain('oak_log');
		assert.equal(faulted, true);
		assert.equal(next.reasonCode, 'OBSERVATION_UNAVAILABLE');
		assert.equal(next.stations.left, 1);
		assert.deepEqual(commands.slice(commandsAtFault).filter(c => c.type === 'action_command'), []);
	} finally { await runtime.dispose(record.agentId, 'test_complete'); }
});
