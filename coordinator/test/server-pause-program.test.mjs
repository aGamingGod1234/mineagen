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
