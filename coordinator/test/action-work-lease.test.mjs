import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, FakeBridge, FakePlanner, FakeProvider, AgentRegistry, eventually } from './fixtures/runtime-coordinator-fixture.mjs';
import { ActiveGoalSupervisor } from '../src/active-goal-supervisor.mjs';
import { LEASE_TIMEOUTS_MS, MAX_LEASE_TIMEOUT_MS, actionLeaseTimeoutMs } from '../src/work-lease-supervisor.mjs';

const flush = async () => { for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** The goal supervisor's clock and timers, moved by hand so a 125 s lease fires without waiting 125 s. */
class LeaseClock {
	now = 0;
	#timers = new Map();
	#nextId = 0;
	clock = () => this.now;
	schedule = (callback, delay) => {
		const handle = { id: ++this.#nextId };
		this.#timers.set(handle.id, { handle, callback, dueAt: this.now + delay });
		return handle;
	};
	cancel = (handle) => { this.#timers.delete(handle?.id); };
	/** Moves to {@code at} and fires the timers due by then, in due order. */
	async advanceTo(at) {
		this.now = at;
		for (;;) {
			const due = [...this.#timers.values()].filter((timer) => timer.dueAt <= at).sort((left, right) => left.dueAt - right.dueAt)[0];
			if (due === undefined) break;
			this.#timers.delete(due.handle.id);
			due.callback();
			await flush();
		}
	}
}

/**
 * One body action through the production coordinator: a background start_action (what do_step travel_to, dig_to and
 * build become) or a foreground act the turn waits on. The model's turn stays open but makes no further call, the mod
 * sends no heartbeat and no result, and only the goal supervisor's timers move. Returns the action_cancel messages
 * sent by each checkpoint.
 */
async function bodyAction(t, { kind = 'start_action', actionType, actionArguments, step, checkpoints }) {
	const directory = await mkdtemp(join(tmpdir(), 'action-work-lease-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const registry = new AgentRegistry();
	const bridge = new FakeBridge();
	const planner = new FakePlanner(registry);
	const leases = new LeaseClock();
	const begun = [];
	let run;
	let started = null;
	let tooled = false;
	const goalSupervisor = new ActiveGoalSupervisor({
		clock: leases.clock, schedule: leases.schedule, cancelSchedule: leases.cancel,
		stuckSchedule: () => null, cancelStuckSchedule: () => {},
		requestObservation: (key, reason) => run.coordinator.requestSupervisedObservation(key, reason),
		onExpire: (event) => run.coordinator.handleLeaseExpired(event),
	});
	const begin = goalSupervisor.begin.bind(goalSupervisor);
	goalSupervisor.begin = (key, kind, options) => { begun.push({ kind, timeoutMs: options?.timeoutMs }); return begin(key, kind, options); };
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		if (!tooled) {
			tooled = true;
			const call = request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'long-action', callId: 'step',
				tool: { kind, actionType, arguments: actionArguments, ...(step === undefined ? {} : { step }) } });
			// A foreground act returns only with its result, which never comes here.
			if (kind === 'start_action') started = await call;
			else { call.catch(() => {}); started = { state: 'RUNNING' }; }
		}
		return new Promise(() => {});
	};
	run = await start({ registry, bridge, planner, codexService: new FakeProvider(), goalSupervisor, memoryDirectory: directory,
		setStatusInterval: () => null, clearStatusInterval: () => {},
		config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	try {
		bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Walk to the portal site.' } });
		bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] } } } });
		await eventually(() => started !== null && bridge.sent.some((message) => message.type === 'action_command'));
		assert.equal(started.state, 'RUNNING');
		const command = bridge.sent.find((message) => message.type === 'action_command');
		const cancels = {};
		for (const at of checkpoints) {
			await leases.advanceTo(at);
			cancels[at] = bridge.sent.filter((message) => message.type === 'action_cancel' && message.payload.actionId === command.payload.actionId).length;
		}
		return { cancels, actionLeases: begun.filter((lease) => lease.kind === 'action') };
	} finally {
		await run.coordinator.stop();
	}
}

test('the action lease covers the action\'s own timeout plus grace, within the old floor and the lease cap', () => {
	assert.equal(actionLeaseTimeoutMs(undefined), LEASE_TIMEOUTS_MS.action);
	assert.equal(actionLeaseTimeoutMs(5_000), LEASE_TIMEOUTS_MS.action);
	assert.ok(actionLeaseTimeoutMs(300_000) > 300_000);
	assert.ok(actionLeaseTimeoutMs(600_000) > 600_000);
	assert.ok(actionLeaseTimeoutMs(600_000) <= MAX_LEASE_TIMEOUT_MS);
	assert.equal(actionLeaseTimeoutMs(10_000_000), MAX_LEASE_TIMEOUT_MS);
});

test('a background travel_to that asked for 300 s is not cancelled by the work lease at 125 s', async (t) => {
	const timeoutMs = 300_000;
	const { cancels, actionLeases } = await bodyAction(t, { actionType: 'travel_to', actionArguments: { x: 400, y: 64, z: 0, timeoutMs },
		checkpoints: [LEASE_TIMEOUTS_MS.action + 1, timeoutMs] });
	assert.equal(cancels[LEASE_TIMEOUTS_MS.action + 1], 0);
	assert.equal(cancels[timeoutMs], 0, 'the lease must not end the action before its own timeout');
	assert.ok(actionLeases.some((lease) => lease.timeoutMs === actionLeaseTimeoutMs(timeoutMs)));
});

test('a background build that asked for 600 s is still running at 600 s', async (t) => {
	const timeoutMs = 600_000;
	const { cancels } = await bodyAction(t, { actionType: 'build', actionArguments: { structure: 'nether_portal', timeoutMs },
		step: { verb: 'build', why: 'Cast and light the portal by the lava pool.' },
		checkpoints: [LEASE_TIMEOUTS_MS.action + 1, timeoutMs] });
	assert.deepEqual(Object.values(cancels), [0, 0]);
});

test('a travel_to with no timeoutMs gets the longest action timeout, which the mod may use as its default', async (t) => {
	const { cancels, actionLeases } = await bodyAction(t, { actionType: 'travel_to', actionArguments: { x: 400, y: 64, z: 0 },
		checkpoints: [LEASE_TIMEOUTS_MS.action + 1] });
	assert.equal(cancels[LEASE_TIMEOUTS_MS.action + 1], 0);
	assert.ok(actionLeases.some((lease) => lease.timeoutMs === actionLeaseTimeoutMs(600_000)));
});

test('a wait is covered by its durationMs', async (t) => {
	const { cancels } = await bodyAction(t, { actionType: 'wait', actionArguments: { durationMs: 200_000 },
		checkpoints: [LEASE_TIMEOUTS_MS.action + 1, 200_000] });
	assert.deepEqual(Object.values(cancels), [0, 0]);
});

test('a foreground act the turn waits on is not cancelled at 125 s when no heartbeat renews it', async (t) => {
	const timeoutMs = 300_000;
	const { cancels } = await bodyAction(t, { kind: 'action', actionType: 'travel_to', actionArguments: { x: 400, y: 64, z: 0, timeoutMs },
		checkpoints: [LEASE_TIMEOUTS_MS.action + 1, timeoutMs] });
	assert.deepEqual(Object.values(cancels), [0, 0]);
});

test('a background action that never reports a result is still cancelled once its timeout and grace run out', async (t) => {
	const timeoutMs = 300_000;
	const leaseEnd = actionLeaseTimeoutMs(timeoutMs);
	const { cancels } = await bodyAction(t, { actionType: 'travel_to', actionArguments: { x: 400, y: 64, z: 0, timeoutMs },
		checkpoints: [leaseEnd - 1, leaseEnd] });
	assert.equal(cancels[leaseEnd - 1], 0);
	assert.equal(cancels[leaseEnd], 1);
});
