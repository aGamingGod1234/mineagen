import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';
import { runObtain } from '../src/obtain-runner.mjs';
import { checkedObtainBody } from './helpers/checked-body.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/round2-water-worn.json', import.meta.url)));
const original = fixture.terminal;
const record = { agentId: original.agentId, goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' };
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

// Real wire adaptation and receipt fields; reconstructed source sighting and inert bridge effects.
// Generated runtime action IDs must replace the original receipt ID, never claim to replay physics.
async function replay({ code = 'TOOL_WORN', freshBucket = false, danger = false, live = false } = {}) {
	let sequence = fixture.snapshot.envelope.payload.eventSequence, travels = 0;
	let observation = adaptObservation(fixture.snapshot.envelope.payload);
	const sighting = { blockId: 'minecraft:water', x: 169, y: -4, z: -440, state: { level: '0' } };
	observation.blocks = [sighting];
	const commands = [], traces = [];
	let runtime;
	runtime = new NativeToolRuntime({ registry: { get: () => record },
		trace: (type, data) => traces.push({ type, data }),
		requestObservation: async () => ({ observation: structuredClone(observation), eventSequence: ++sequence }),
		inspectObservation: async (_r, q) => ({ section: q.section, eventSequence: ++sequence, entries: q.section === 'blocks' ? observation.blocks : [], coverage: { hasMore: false } }),
		bridge: { send: async (type, _agentId, payload) => {
			commands.push({ type, ...payload });
			if (type !== 'action_command') return;
			assert.ok(commands.length < 20, 'bounded replay dispatch');
			if (live) { queueMicrotask(() => runtime.interruptBlockingTool(record.agentId)); return; }
			if (payload.actionType === 'travel_to') {
				travels++;
				if (danger) { observation.player.air = 90; observation.player.underWater = true; }
				if (freshBucket) observation.inventory.items.push({ itemId: 'minecraft:water_bucket', slot: 35, count: 1 });
				if (code === 'NO_ROUTE') {
					// A different reachable source is visible after the failed approach.
					observation.blocks = [{ ...sighting, x: Math.floor(observation.player.x) + 1, y: Math.floor(observation.player.y), z: Math.floor(observation.player.z) }];
				}
			}
			if (payload.actionType === 'use_item') observation.inventory.items.push({ itemId: 'minecraft:water_bucket', slot: 35, count: 1 });
			queueMicrotask(() => runtime.onActionResult(record, { ...original.result,
				actionId: payload.actionId, commandId: payload.actionId, actionType: payload.actionType,
				observedAtEpochMs: Date.now(), state: payload.actionType === 'travel_to' ? 'FAILED' : 'SUCCEEDED',
				reasonCode: payload.actionType === 'travel_to' ? code : 'ACTION_COMPLETED' }));
		} } });
	runtime.updateObservation(record, structuredClone(observation), { eventSequence: sequence });
	try {
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1,
			turnId: original.decisionId, callId: original.callId,
			tool: normalizeMinecraftToolCall('do_step', original.call.arguments) }, record);
		return { result, commands: structuredClone(commands), travels, traces };
	} finally { await runtime.dispose(record.agentId, 'test_complete'); }
}

for (const code of ['TOOL_WORN', 'NO_TOOL']) test(`production b3 approach ${code}: capability handback without source poisoning or continuation`, async () => {
	const { result, commands, travels } = await replay({ code });
	assert.equal(result.state, 'FAILED', JSON.stringify(result));
	assert.equal(result.reasonCode, code);
	assert.equal(result.held, 0);
	assert.match(result.message, /replace or equip a usable tool/);
	assert.equal(travels, 1);
	assert.deepEqual(commands.filter(x => x.type === 'action_command').map(x => x.actionType), ['travel_to']);
	assert.equal(result.running, undefined, 'the original terminal receipt is not a live handle');
	assert.ok(!result.steps.some(x => /find water/.test(x)), 'no follow-up search');
});

test('production ordinary unreachable approach still retries another source and fills from fresh inventory', async () => {
	const { result, commands } = await replay({ code: 'NO_ROUTE' });
	assert.equal(result.reasonCode, 'OBTAINED', JSON.stringify(result));
	assert.equal(result.held, 1);
	assert.deepEqual(commands.filter(x => x.type === 'action_command').map(x => x.actionType), ['travel_to', 'select_item', 'use_item']);
});

test('production worn approach with a newly available filled bucket succeeds without another scoop', async () => {
	const { result, commands } = await replay({ freshBucket: true });
	assert.equal(result.reasonCode, 'OBTAINED', JSON.stringify(result));
	assert.equal(result.held, 1);
	assert.equal(commands.filter(x => x.type === 'action_command').length, 1);
});

test('production fresh danger outranks worn capability failure', async () => {
	const { result, commands } = await replay({ danger: true });
	assert.equal(result.reasonCode, 'DANGER', JSON.stringify(result));
	assert.equal(commands.filter(x => x.type === 'action_command').length, 1);
});

test('production interrupted live approach retains genuine ownership without cancelling that action', async () => {
	const { result, commands } = await replay({ live: true });
	assert.equal(result.reasonCode, 'DANGER', JSON.stringify(result));
	const actions = commands.filter(x => x.type === 'action_command');
	assert.equal(actions.length, 1);
	assert.equal(result.running.actionId, actions[0].actionId);
	assert.notEqual(result.running.actionId, original.actionId);
	assert.equal(commands.filter(x => x.type === 'action_cancel' && x.actionId === actions[0].actionId).length, 0);
});

// Keep the research's exact search reconstruction too, including failed-source bookkeeping.
for (const cancel of [false, true]) test(`retained b3 runObtain: ${cancel ? 'cancellation priority' : 'one search and no unreachable mark'}`, async () => {
	let searches = 0, acts = 0, stopped = false;
	const misses = [];
	const result = await runObtain({ item: 'water_bucket', timeoutMs: 60_000 }, checkedObtainBody({
		observe: async () => adaptObservation(fixture.snapshot.envelope.payload),
		blocksNear: async () => [], interrupted: () => false, stopped: () => stopped, note: () => {},
		missPlace: (...args) => misses.push(args),
		search: async () => { assert.equal(++searches, 1); return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', find: { seen: { x: 169, y: -4, z: -440 } } }; },
		act: async () => { assert.equal(++acts, 1); stopped = cancel; return original.result; },
	}));
	assert.equal(result.reasonCode, cancel ? 'CANCELLED' : 'TOOL_WORN');
	assert.equal(searches, 1);
	assert.equal(acts, 1);
	assert.deepEqual(misses, []);
});
