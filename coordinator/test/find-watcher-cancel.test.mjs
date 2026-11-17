import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

// K5 (issue #2): a watched search leg's sighting watcher sleeps between samples. The leg's end must wake that sleep, so
// the next body action starts at once instead of after the rest of a 2 s step (about 1.5 s after every failed leg).
const saved = JSON.parse(readFileSync(new URL('./fixtures/fortress-spawner/c8861.json', import.meta.url)));

test('K5: the next action after a watched find leg starts with no fake time passing', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let fakeNow = 0, sequence = 0;
	const observation = structuredClone(saved.windows[1].observation);
	const record = { agentId: 'watcher-k5', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' };
	const sent = [];
	let runtime;
	runtime = new NativeToolRuntime({
		requestObservation: async () => ({ eventSequence: ++sequence, observation: structuredClone(observation) }),
		inspectObservation: async () => ({ survey: {} }),
		bridge: { send: async (type, _agent, p) => {
			if (type !== 'action_command') return;
			const moving = p.actionType !== 'control';
			sent.push({ actionType: p.actionType, at: fakeNow });
			queueMicrotask(() => {
				if (moving) sent.at(-1).endedAt = fakeNow;
				runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state: moving ? 'FAILED' : 'SUCCEEDED',
					reasonCode: moving ? 'NO_ROUTE' : 'CONTROL_SEGMENT_COMPLETED', executionStarted: true, physicalAttempted: true });
			});
		} },
	});
	t.after(() => runtime.dispose(record.agentId, 'test_complete'));
	runtime.updateObservation(record, observation, { eventSequence: ++sequence });
	let done = false;
	const finding = runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'k5', callId: 'find',
		tool: normalizeMinecraftToolCall('do_step', { verb: 'find', target: { block: 'spawner', within: 96, timeoutMs: 60000 }, why: 'k5 fixture' }) }, record)
		.finally(() => { done = true; });
	// Let real turns of the event loop run; fake time moves only when nothing else can (at most 5 s in 100 ms steps).
	for (let spins = 0; !done && fakeNow <= 5_000; spins++) {
		const before = sent.length;
		for (let i = 0; i < 20 && !done; i++) await new Promise((resolve) => setImmediate(resolve));
		if (!done && sent.length === before) { fakeNow += 100; t.mock.timers.tick(100); }
	}
	const result = await finding;
	const leg = sent.findIndex((row) => row.actionType === 'travel_to');
	assert.ok(leg >= 0, 'the search walks one floor leg');
	const next = sent[leg + 1];
	assert.ok(next !== undefined, `an action follows the leg (${result.reasonCode})`);
	// Metric: fake ms between the leg's result and the next action command. Pass bar: 0 (it was up to 2000).
	assert.equal(next.at - sent[leg].endedAt, 0, `the next action waited ${next.at - sent[leg].endedAt} ms of the watcher's sleep`);
});
