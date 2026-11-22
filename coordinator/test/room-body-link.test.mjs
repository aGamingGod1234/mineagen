import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { InspectionClient } from '../src/inspection-client.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { goalSpecFingerprint } from '../src/goal-spec.mjs';
import { followGoalRevision, inspectionObserve, respawnBody } from '../../scripts/quality/room-body-link.mjs';

// A server stand-in that answers inspections as MultiplexedServerBridge.acceptInspectionRequest does: a sample taken for
// the request at the body's current revision, or a STALE_REVISION error when the request's revision is behind.
function fakeServer({ revision = 3 } = {}) {
	const server = { revision, sequence: 10, sent: [] };
	const inspections = new InspectionClient({ send: async (type, agentId, payload) => {
		server.sent.push([type, agentId, payload]);
		queueMicrotask(() => inspections.accept({ agentId, payload: payload.goalRevision === server.revision
			? { requestId: payload.requestId, goalRevision: payload.goalRevision, result: { eventSequence: ++server.sequence, observation: { ready: true, position: { x: 1, y: 64, z: 2 }, view: { yaw: 0, pitch: 0 }, player: { health: 20 }, inventory: { items: [], selectedItem: 'minecraft:air' }, entities: [], items: [], blocks: [], landmarks: [], world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime: 1000, dayTime: 1000, raining: false, thundering: false } } } }
			: { requestId: payload.requestId, goalRevision: payload.goalRevision, error: { code: 'STALE_REVISION', message: 'Inspection goal revision is stale' } } }));
	} });
	return { server, inspections };
}

test('the room observes by inspection: each call gets a newer server sample the runtime accepts', async () => {
	const { server, inspections } = fakeServer();
	const fields = { originalRequest: 'Survive for 36000 seconds.', predicate: { type: 'survive_duration', ticks: 720_000 }, createdAtTick: 10 };
	const record = { agentId: 'agent-a', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default', goalRevision: 3,
		currentGoal: fields.originalRequest, currentGoalSpec: { ...fields, fingerprint: goalSpecFingerprint(fields) } };
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (...args) => sent.push(args) }, requestObservation: inspectionObserve(inspections, record) });
	// The published sample is older than the call: the runtime asks for a fresh one before each look step.
	runtime.updateObservation(record, { world: { dimension: 'minecraft:overworld' } }, { eventSequence: 1 });
	const pending = runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'look', callId: 'look-1', tool: { kind: 'lookAround', centerYaw: 0, pitch: 0, steps: 2, ticksPerStep: 2 } }, record);
	for (let step = 0; step < 2; step++) {
		for (let spins = 0; sent.length <= step; spins++) {
			if (spins > 10_000) assert.fail(`no body action for look step ${step}: ${JSON.stringify(await Promise.race([pending, new Promise((resolve) => setImmediate(() => resolve('pending')))]))}`);
			await new Promise((resolve) => setImmediate(resolve));
		}
		runtime.onActionResult(record, { actionId: sent[step][2].actionId, state: 'SUCCEEDED', reasonCode: '' });
	}
	const result = await pending;
	assert.equal(result.state, 'SUCCEEDED');
	assert.deepEqual(server.sent.map(([type, , payload]) => [type, payload.goalRevision, payload.query.section]), [['inspection_request', 3, 'observation'], ['inspection_request', 3, 'observation']]);
	assert.deepEqual(result.samples.map((sample) => sample.eventSequence), [11, 12]);
});

test('a refused observation shows the refusal at once instead of a stale sample after 10 s', async () => {
	const { inspections } = fakeServer({ revision: 4 });
	const started = Date.now();
	await assert.rejects(inspectionObserve(inspections, { agentId: 'agent-a', goalRevision: 3 })(), (error) => error.code === 'STALE_REVISION');
	assert.ok(Date.now() - started < 1_000);
});

test('the room follows every newer revision the server sends and answers agent_ready', async () => {
	const bridge = new EventEmitter();
	const ready = [];
	bridge.send = async (type, agentId, payload) => { ready.push([type, agentId, payload.goalRevision]); };
	const record = { agentId: 'agent-a', goalRevision: 3 };
	followGoalRevision(bridge, record);
	// A low-health hand-back moves the revision with no goal_control; queue controls and other bodies do not count.
	bridge.emit('message', { type: 'goal_control', agentId: 'agent-a', payload: { operation: 'queue', goalRevision: 9 } });
	bridge.emit('message', { type: 'observation', agentId: 'agent-b', payload: { goalRevision: 9 } });
	bridge.emit('message', { type: 'agent_registered', agentId: 'agent-a', payload: { record: { goalRevision: 4 } } });
	// A respawn keeps its revision: respawnBody sends that agent_ready itself, so the follower adds no second one.
	bridge.emit('message', { type: 'goal_control', agentId: 'agent-a', payload: { operation: 'respawn', goalRevision: 4 } });
	bridge.emit('message', { type: 'goal_control', agentId: 'agent-a', payload: { operation: 'start', goalRevision: 5 } });
	await Promise.resolve();
	assert.equal(record.goalRevision, 5);
	assert.deepEqual(ready, [['agent_ready', 'agent-a', 4], ['agent_ready', 'agent-a', 5]]);
});

test('a respawned body goes on without waiting for a start the server refuses', async () => {
	const commands = [], sent = [];
	let alive = false;
	const record = { agentId: 'agent-a', goalRevision: 6 };
	const body = {
		command: async (text) => { commands.push(text); if (text.startsWith('mineagen respawn')) setTimeout(() => { alive = true; }, 5); if (text.startsWith('mineagen start')) throw new Error('refused while STARTING'); return ''; },
		health: async () => (alive ? 20 : 0),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
		send: async (...args) => { sent.push(args); },
	};
	const started = Date.now();
	assert.equal(await respawnBody(body, record, 'Ob0'), true);
	assert.ok(Date.now() - started < 1_000, 'no 60 s wait for a start event');
	assert.deepEqual(commands, ['mineagen respawn Ob0', 'mineagen start Ob0 Survive for 36000 seconds.']);
	assert.deepEqual(sent, [['agent_ready', 'agent-a', { goalRevision: 6, reconciled: false }]]);
});
