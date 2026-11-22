import test from 'node:test';
import assert from 'node:assert/strict';
import { start, FakePlanner, eventually, resolveNativeSteerInput } from './fixtures/dynamic-main-fixture.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { decodeModelFacts } from '../src/model-fact-encoding.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CRIT-LEASE-1. Through the production coordinator: a 1 s program, an urgent decision 0.6 s in, answered 1.3 s in (past
// the program's own 1 s timeout). The executor holds the step for the answer and credits the 0.7 s wait, so the step
// ends at about 1.7 s on the program's own deadline. Before the fix the coordinator's work lease (1 s, never moved out
// for an urgent wait) ended the step at 1 s while the answer was on its way.
test('an urgent answer that lands after the program timeout keeps the step: the program deadline ends it, not the work lease', async (t) => {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), completions = [], traces = [];
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
	const run = await start({ registry, planner, traceWriter: { write: (event, fields) => traces.push({ event, at: Date.now(), ...fields }) }, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	t.after(async () => { await run.coordinator.stop(); for (const resolve of completions) resolve({ status: 'completed', toolCalls: 0 }); });
	// The server acknowledges a cancel with the action's result, as a live one does.
	const send = run.bridge.send.bind(run.bridge);
	let cancelSentAt = null;
	run.bridge.send = async (type, agentId, payload, options) => {
		if (type === 'action_cancel') cancelSentAt ??= Date.now();
		await send(type, agentId, payload, options);
		if (type === 'action_cancel') queueMicrotask(() => run.bridge.emit('action_result', { agentId, payload: { goalRevision: 1, actionId: payload.actionId, actionType: 'wait', state: 'CANCELLED', reasonCode: 'ACTION_CANCELLED', executionStarted: true, eventSequence: 10 } }));
	};
	const cancelled = () => run.bridge.sent.some((message) => message.type === 'action_cancel');
	const leaseExpired = () => traces.some((row) => row.event === 'work_lease_expired' && row.kind === 'program');
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Explore safely.' } });
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, attention: false, changedFacts: [], observation: { player: { x: 0, y: 64, z: 0, health: 20 } } } });
	await eventually(() => run.bridge.sent.some((message) => message.type === 'action_command'));
	await sleep(Math.max(0, 600 - (Date.now() - startedAt)));
	const urgentAt = Date.now();
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 2, attention: true, changedFacts: ['player.health'], observation: { player: { x: 0, y: 64, z: 0, health: 12 } } } });
	await eventually(() => planner.requests.length === 2);
	const request = planner.requests[1], input = request.input;
	const shown = decodeModelFacts(JSON.parse(input.slice(input.indexOf('\n') + 1))).program;
	assert.equal(shown.decision.priority, 'urgent');
	await sleep(Math.max(0, 1_300 - (Date.now() - startedAt)));
	assert.equal(cancelled(), false, 'past its 1 s timeout, the step is still held for the urgent answer');
	assert.equal(leaseExpired(), false, 'and the work lease has not ended it');
	const answeredAt = Date.now();
	await request.executeTool({ agentId: request.agentId, goalRevision: 1, turnId: 'decision', callId: 'answer',
		tool: { kind: 'respond_program', programId: shown.programId, decisionId: shown.decision.decisionId, eventSequence: shown.decision.eventSequence, directive: 'continue' } });
	const answerDoneAt = Date.now();
	await eventually(cancelled, 3_000);
	// When the cancel was sent, not when the poll saw it (a loaded runner polls late).
	const endedAt = cancelSentAt - startedAt;
	// The executor's own deadline is start + 1 s + the wait. startedAt is taken before the tool call, the wait opens
	// between urgentAt and openedAt and ends between answeredAt and answerDoneAt: the deadline lies between these bounds.
	// The wait opened when the lease was paid for it (a loaded runner may take the urgent sample late).
	const openedAt = traces.find((row) => row.event === 'urgent_wait_lease_credited')?.at;
	assert.ok(openedAt >= urgentAt, 'the lease was paid for the hold as the urgent wait opened');
	const earliest = 1_000 + (answeredAt - openedAt), latest = 1_000 + (answerDoneAt - urgentAt);
	assert.ok(endedAt >= earliest - 50, `the step keeps the urgent wait as extra time (ended ${endedAt} ms in, deadline from ${earliest} ms)`);
	assert.ok(endedAt < latest + 250, `and ends on the program's own deadline (ended ${endedAt} ms in, deadline by ${latest} ms)`);
	await eventually(() => traces.some((row) => row.event === 'native_program_ended' && row.programId === shown.programId), 3_000);
	// A lease running out after the program's own deadline already stopped it (while the cancel is acknowledged on a
	// loaded runner) changes nothing; it must not come first.
	const expiry = traces.find((row) => row.event === 'work_lease_expired' && row.kind === 'program');
	assert.ok(expiry === undefined || expiry.at >= cancelSentAt, `the work lease did not end the step (expired ${expiry?.at - startedAt} ms in)`);
	assert.equal(traces.find((row) => row.event === 'native_program_ended' && row.programId === shown.programId).reasonCode, 'PROGRAM_DEADLINE');
});
