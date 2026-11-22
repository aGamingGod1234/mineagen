import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, FakeBridge, FakePlanner, FakeProvider, AgentRegistry, eventually } from './fixtures/runtime-coordinator-fixture.mjs';
import { ActiveGoalSupervisor } from '../src/active-goal-supervisor.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Playtest: a single-player pause cancelled the bot's running step. Through the production coordinator, a program whose
// 300 ms deadline falls inside a 900 ms pause is still running when the game resumes, then times out on its own
// remaining time.
test('a running program keeps its deadline through a single-player pause and times out only after the resume', async (t) => {
	const path = await mkdtemp(join(tmpdir(), 'server-pause-program-'));
	t.after(() => rm(path, { recursive: true, force: true }));
	const registry = new AgentRegistry(), bridge = new FakeBridge(), planner = new FakePlanner(registry), provider = new FakeProvider();
	let run, request, handle;
	const supervisor = new ActiveGoalSupervisor({ requestObservation: (key) => run.coordinator.requestSupervisedObservation(key), onExpire: (event) => run.coordinator.handleLeaseExpired(event) });
	planner.requestNativeTurn = async (r) => {
		planner.requests.push(r);
		if (!request) {
			request = r;
			handle = await r.executeTool({ agentId: r.agentId, goalRevision: r.goalRevision, turnId: 'pause', callId: 'run',
				tool: { kind: 'run_program', background: true, timeoutMs: 300, source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(10000);' } });
		}
		return new Promise(() => {});
	};
	run = await start({ registry, bridge, planner, codexService: provider, goalSupervisor: supervisor, memoryDirectory: path,
		setStatusInterval: () => null, clearStatusInterval: () => {}, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	try {
		bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Wait.' } });
		bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] } } } });
		await eventually(() => handle && bridge.sent.some((message) => message.type === 'action_command'));
		bridge.emit('serverPause', { paused: true, tickAgeMs: 0 });
		await sleep(900);
		assert.equal(bridge.sent.some((message) => message.type === 'action_cancel'), false, 'paused past its deadline, the program is not cancelled');
		bridge.emit('serverPause', { paused: false, tickAgeMs: 0 });
		await sleep(100);
		assert.equal(bridge.sent.some((message) => message.type === 'action_cancel'), false, 'resumed, it still has the time it had left');
		await eventually(() => bridge.sent.some((message) => message.type === 'action_cancel'), 3000);
	} finally {
		await run.coordinator.stop();
	}
});

test('a program sampling the world asks for no sample while the game is paused, and samples again after', async (t) => {
	// A paused server answers no inspection; one asked for during the pause timed out after 10 s and failed the program.
	const path = await mkdtemp(join(tmpdir(), 'server-pause-sampling-'));
	t.after(() => rm(path, { recursive: true, force: true }));
	const registry = new AgentRegistry(), bridge = new FakeBridge(), planner = new FakePlanner(registry), provider = new FakeProvider();
	let run, request, handle, paused = false;
	const sample = bridge.sampleInspection.bind(bridge);
	const askedWhilePaused = [];
	bridge.sampleInspection = (message) => { if (paused) { askedWhilePaused.push(message); return; } sample(message); };
	const supervisor = new ActiveGoalSupervisor({ requestObservation: (key) => run.coordinator.requestSupervisedObservation(key), onExpire: (event) => run.coordinator.handleLeaseExpired(event) });
	planner.requestNativeTurn = async (r) => {
		planner.requests.push(r);
		if (!request) {
			request = r;
			handle = await r.executeTool({ agentId: r.agentId, goalRevision: r.goalRevision, turnId: 'pause', callId: 'run',
				tool: { kind: 'run_program', background: true, timeoutMs: 20_000, observationIntervalMs: 100, source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(10000);' } });
		}
		return new Promise(() => {});
	};
	run = await start({ registry, bridge, planner, codexService: provider, goalSupervisor: supervisor, memoryDirectory: path,
		setStatusInterval: () => null, clearStatusInterval: () => {}, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	try {
		bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Wait.' } });
		bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] } } } });
		await eventually(() => handle && bridge.sent.some((message) => message.type === 'action_command'));
		await sleep(250);
		paused = true;
		bridge.emit('serverPause', { paused: true, tickAgeMs: 0 });
		const inspectionsAtPause = bridge.sent.filter((message) => message.type === 'inspection_request').length;
		await sleep(600);
		assert.equal(bridge.sent.filter((message) => message.type === 'inspection_request').length, inspectionsAtPause, 'no sample is asked for while paused');
		paused = false;
		bridge.emit('serverPause', { paused: false, tickAgeMs: 0 });
		await eventually(() => bridge.sent.filter((message) => message.type === 'inspection_request').length > inspectionsAtPause, 3000);
		assert.equal(bridge.sent.some((message) => message.type === 'action_cancel'), false, 'the program is still running');
	} finally {
		await run.coordinator.stop();
	}
});

test('obtain, gather and find budgets run on a step clock that stands still while the game is paused', async () => {
	const { NativeToolRuntime } = await import('../src/native-tool-runtime.mjs');
	const runtime = new NativeToolRuntime({ bridge: { send: async () => {} }, onProgramEvent: () => {} });
	const before = runtime.stepClockNow();
	runtime.serverPaused(true);
	await sleep(150);
	const during = runtime.stepClockNow();
	assert.ok(during - before < 50, `paused, the step clock stands still (moved ${during - before} ms)`);
	runtime.serverPaused(false);
	const resumed = runtime.stepClockNow();
	assert.ok(resumed - before < 60, `no jump on resume (moved ${resumed - before} ms)`);
	await sleep(100);
	assert.ok(runtime.stepClockNow() - resumed >= 90, 'it runs again after the resume');
});

test('one pause event reaches every timer that can end a live step: leases, planner, programs, step clock, inspections', async (t) => {
	const { PlanningScheduler } = await import('../src/planning-scheduler.mjs');
	const path = await mkdtemp(join(tmpdir(), 'server-pause-hub-'));
	t.after(() => rm(path, { recursive: true, force: true }));
	const calls = [];
	class SpyScheduler extends PlanningScheduler { serverPaused(paused) { calls.push(['planner', paused]); return super.serverPaused(paused); } }
	class SpySupervisor extends ActiveGoalSupervisor { serverPaused(paused) { calls.push(['leases', paused]); return super.serverPaused(paused); } }
	const bridge = new FakeBridge();
	const run = await start({ bridge, scheduler: new SpyScheduler(), goalSupervisor: new SpySupervisor(), memoryDirectory: path,
		setStatusInterval: () => null, clearStatusInterval: () => {}, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	try {
		bridge.emit('serverPause', { paused: true, tickAgeMs: 0 });
		bridge.emit('serverPause', { paused: false, tickAgeMs: 0 });
		assert.deepEqual(calls.filter(([name]) => name === 'planner'), [['planner', true], ['planner', false]], 'the planner scheduler holds and resumes');
		assert.deepEqual(calls.filter(([name]) => name === 'leases'), [['leases', true], ['leases', false]], 'the work leases hold and resume');
	} finally {
		await run.coordinator.stop();
	}
});

test('a program started while the game is already paused gets only the part of the pause it lived through', async (t) => {
	const path = await mkdtemp(join(tmpdir(), 'server-pause-late-'));
	t.after(() => rm(path, { recursive: true, force: true }));
	const registry = new AgentRegistry(), bridge = new FakeBridge(), planner = new FakePlanner(registry), provider = new FakeProvider();
	let run, request, handle;
	const supervisor = new ActiveGoalSupervisor({ requestObservation: (key) => run.coordinator.requestSupervisedObservation(key), onExpire: (event) => run.coordinator.handleLeaseExpired(event) });
	planner.requestNativeTurn = async (r) => {
		planner.requests.push(r);
		if (!request) {
			request = r;
			handle = await r.executeTool({ agentId: r.agentId, goalRevision: r.goalRevision, turnId: 'late', callId: 'run',
				tool: { kind: 'run_program', background: true, timeoutMs: 300, source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(10000);' } });
		}
		return new Promise(() => {});
	};
	run = await start({ registry, bridge, planner, codexService: provider, goalSupervisor: supervisor, memoryDirectory: path,
		setStatusInterval: () => null, clearStatusInterval: () => {}, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	try {
		bridge.emit('serverPause', { paused: true, tickAgeMs: 0 });
		await sleep(700);
		bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Wait.' } });
		bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] } } } });
		await eventually(() => handle && bridge.sent.some((message) => message.type === 'action_command'));
		await sleep(150);
		bridge.emit('serverPause', { paused: false, tickAgeMs: 0 });
		const resumedAt = Date.now();
		await eventually(() => bridge.sent.some((message) => message.type === 'action_cancel'), 3000);
		const after = Date.now() - resumedAt;
		assert.ok(after >= 200, `the program keeps its own 300 ms after the resume (cancelled ${after} ms after)`);
		assert.ok(after < 650, `and is not credited the 700 ms of pause before it started (cancelled ${after} ms after the resume)`);
	} finally {
		await run.coordinator.stop();
	}
});

// The model can answer an urgent decision while the game is paused. Through the production coordinator: a 1 s program,
// an urgent decision ~0.1 s before a 1.5 s pause, answered 1 s into the pause. The step is not ended during the pause,
// and after the resume it runs on for the time it had left at the pause plus the unpaused urgent wait. The program's
// own deadline ends it: the work lease moved out when the urgent wait opened (CRIT-LEASE-1).
test('an urgent decision answered during a pause past the deadline does not end the step in the pause; after the resume it gets its remaining time', async (t) => {
	const { start: startDynamic, FakePlanner: DynamicPlanner, eventually: until, resolveNativeSteerInput } = await import('./fixtures/dynamic-main-fixture.mjs');
	const { AgentRegistry: Registry } = await import('../src/agent-registry.mjs');
	const { decodeModelFacts } = await import('../src/model-fact-encoding.mjs');
	const registry = new Registry(), planner = new DynamicPlanner(registry), completions = [];
	let startedAt = null;
	planner.steerNativeTurn = async (request) => { await resolveNativeSteerInput(request); };
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		if (planner.requests.length === 1) {
			startedAt = Date.now();
			await request.executeTool({ agentId: request.agentId, goalRevision: 1, turnId: 'initial', callId: 'program',
				tool: { kind: 'run_program', background: true, timeoutMs: 1_000,
					source: 'program.onUnhandledAttention("continue_and_notify", {survival:"continue_and_notify"}); await player.wait(100000);' } });
			return { status: 'completed', toolCalls: 1 };
		}
		return new Promise((resolve) => { completions.push(resolve); });
	};
	const traces = [];
	const run = await startDynamic({ registry, planner, traceWriter: { write: (event, fields) => traces.push({ event, at: Date.now(), ...fields }) }, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	t.after(async () => { await run.coordinator.stop(); for (const resolve of completions) resolve({ status: 'completed', toolCalls: 0 }); });
	const cancelled = () => run.bridge.sent.some((message) => message.type === 'action_cancel');
	// The server acknowledges a cancel with the action's result, as a live one does.
	const send = run.bridge.send.bind(run.bridge);
	let cancelSentAt = null;
	run.bridge.send = async (type, agentId, payload, options) => {
		if (type === 'action_cancel') cancelSentAt ??= Date.now();
		await send(type, agentId, payload, options);
		if (type === 'action_cancel') queueMicrotask(() => run.bridge.emit('action_result', { agentId, payload: { goalRevision: 1, actionId: payload.actionId, actionType: 'wait', state: 'CANCELLED', reasonCode: 'ACTION_CANCELLED', executionStarted: true, eventSequence: 10 } }));
	};
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Explore safely.' } });
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, attention: false, changedFacts: [], observation: { player: { x: 0, y: 64, z: 0, health: 20 } } } });
	await until(() => run.bridge.sent.some((message) => message.type === 'action_command'));
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 2, attention: true, changedFacts: ['player.health'], observation: { player: { x: 0, y: 64, z: 0, health: 12 } } } });
	await until(() => planner.requests.length === 2);
	const request = planner.requests[1], input = request.input;
	const shown = decodeModelFacts(JSON.parse(input.slice(input.indexOf('\n') + 1))).program;
	assert.equal(shown.decision.priority, 'urgent');
	await sleep(100);
	const pausedAt = Date.now();
	run.bridge.emit('serverPause', { paused: true, tickAgeMs: 0 });
	await sleep(1_000);
	await request.executeTool({ agentId: request.agentId, goalRevision: 1, turnId: 'decision', callId: 'answer',
		tool: { kind: 'respond_program', programId: shown.programId, decisionId: shown.decision.decisionId, eventSequence: shown.decision.eventSequence, directive: 'continue' } });
	await sleep(500);
	assert.equal(cancelled(), false, 'paused past its deadline, the step is still running');
	run.bridge.emit('serverPause', { paused: false, tickAgeMs: 0 });
	const resumedAt = Date.now();
	await until(cancelled);
	// Left at the pause, plus the urgent wait before the pause (credited when answered). startedAt is taken before the
	// tool call, so the true deadline is at or after this, less timer slack. The wait opened when the lease was paid for
	// it, and the step ended when the cancel was sent (a loaded runner takes samples and polls late).
	const openedAt = traces.find((row) => row.event === 'urgent_wait_lease_credited').at;
	const after = cancelSentAt - resumedAt, left = 1_000 - (pausedAt - startedAt) + (pausedAt - openedAt);
	assert.ok(after >= left - 50, `the step keeps the ${left} ms it had left at the pause (cancelled ${after} ms after the resume)`);
	assert.ok(after < left + 250, `and is not given the pause again on top (cancelled ${after} ms after the resume)`);
	await until(() => traces.some((row) => row.event === 'native_program_ended'));
	assert.equal(traces.some((row) => row.event === 'work_lease_expired' && row.kind === 'program'), false, 'the work lease does not end the step');
	assert.equal(traces.find((row) => row.event === 'native_program_ended').reasonCode, 'PROGRAM_DEADLINE', 'the program deadline does');
});
