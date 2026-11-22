import assert from 'node:assert/strict';
import test from 'node:test';

import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';

// The body counts its time limits in game ticks; a program's deadline is wall time. On a lagging server the deadline
// moves out by the wall time the server fell behind, so the body's own timeout still comes first.
const record = () => ({ agentId: 'agent-a', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'standard', goalRevision: 3, currentGoal: 'beat the game' });
const until = async (predicate, label) => { for (let index = 0; index < 200; index += 1) { if (predicate()) return; await new Promise((done) => setTimeout(done, 5)); } assert.fail(`timed out waiting for ${label}`); };

const wire = (epochMs, gameTime) => ({ ready: true, observedAtEpochMs: epochMs, position: { x: 0.5, y: 64, z: 0.5 }, view: { yaw: 0, pitch: 0 },
	player: { health: 20, maxHealth: 20, foodLevel: 20, onFire: false, inLava: false, air: 300, maxAir: 300, onGround: true, fallDistance: 0 },
	inventory: { selectedSlot: 0, items: [] }, entities: [], blocks: [], items: [],
	world: { dimension: 'minecraft:overworld', gameTime, dayTime: gameTime % 24000, raining: false, thundering: false } });

async function program(samples) {
	const traces = [];
	let sequence = 1, current = wire(1_000_000, 1000);
	const runtime = new NativeToolRuntime({
		trace: (event, fields) => traces.push({ event, ...fields }),
		bridge: { send: async (type, _agentId, payload) => {
			if (type === 'action_cancel') queueMicrotask(() => runtime.onActionResult(record(), { actionId: payload.actionId, state: 'CANCELLED', reasonCode: 'CANCELLED', executionStarted: true }));
		} },
		requestObservation: async () => ({ observation: adaptObservation(current), eventSequence: ++sequence }),
		onProgramEvent: () => {},
	});
	const observe = (observation) => { current = observation; runtime.updateObservation(record(), adaptObservation(observation), { eventSequence: ++sequence }); };
	observe(current);
	const handle = await runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn-1', callId: 'call-1',
		tool: { kind: 'run_program', background: true, timeoutMs: 60_000, source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait({ durationMs: 50000 });' } }, record());
	await until(() => traces.some(({ event }) => event === 'native_program_started'), 'the program');
	const status = () => runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn-1', callId: `status-${++sequence}`, tool: { kind: 'program_status', programId: handle.programId } }, record());
	const before = (await status()).deadlineEpochMs;
	for (const sample of samples) {
		if (sample === 'pause' || sample === 'resume') { runtime.serverPaused(sample === 'pause'); continue; }
		const [epochMs, gameTime] = sample;
		observe(wire(epochMs, gameTime));
	}
	const after = (await status()).deadlineEpochMs;
	await runtime.dispose('agent-a', 'test_complete');
	return { movedMs: after - before, credits: traces.filter(({ event }) => event === 'lag_time_credited') };
}

test('a server at 8 TPS moves the program deadline out by the wall time it fell behind', async () => {
	// 20 wall seconds at 8 TPS: 160 ticks, 8 s of game time, 12 s behind.
	const samples = Array.from({ length: 21 }, (_, second) => [1_000_000 + second * 1000, 1000 + second * 8]);
	const { movedMs, credits } = await program(samples);
	assert.equal(movedMs, 12_000);
	assert.equal(credits.at(-1).behindMs, 12_000);
});

test('a server at 20 TPS with tick jitter, or one running faster, earns no credit', async () => {
	const jitter = Array.from({ length: 40 }, (_, second) => [1_000_000 + second * 1000 + (second % 2 ? 45 : -45), 1000 + second * 20]);
	assert.equal((await program(jitter)).movedMs, 0);
	const fast = Array.from({ length: 20 }, (_, second) => [1_000_000 + second * 1000, 1000 + second * 80]);
	assert.equal((await program(fast)).movedMs, 0);
});

test('a 50 s travel in a 60 s program on an 8 TPS server keeps its own timeout first', async () => {
	// The body times the travel out after 1000 ticks: 125 wall s at 8 TPS. The deadline must still be later than that.
	const samples = Array.from({ length: 126 }, (_, second) => [1_000_000 + second * 1000, 1000 + second * 8]);
	const { movedMs } = await program(samples);
	assert.equal(movedMs, 75_000);
	assert.ok(60_000 + movedMs > 125_000);
});

test('lag credit has its own bound: three program timeouts', async () => {
	// A server at 1 TPS for 300 wall seconds falls 285 s behind; at most 3 x 60 s is credited.
	const samples = Array.from({ length: 301 }, (_, second) => [1_000_000 + second * 1000, 1000 + second]);
	assert.equal((await program(samples)).movedMs, 180_000);
});

test('a frozen world earns nothing: the body\'s clock counts server ticks, which go on under tick freeze', async () => {
	const samples = Array.from({ length: 30 }, (_, second) => [1_000_000 + second * 1000, 1000]);
	assert.equal((await program(samples)).movedMs, 0);
});

test('a same-tick re-stamp keeps the anchor, so the wall time before it is still credited', async () => {
	// 5 TPS (200 ms ticks): each second a sample and a second one 150 ms later in the same tick. 19 s at 5 TPS is 95
	// ticks, 4.75 s of game time: 14.25 s behind. Re-anchoring on the re-stamp would drop 150 ms a second (11.4 s).
	const samples = Array.from({ length: 20 }, (_, second) => [[1_000_000 + second * 1000, 1000 + second * 5], [1_000_150 + second * 1000, 1000 + second * 5]]).flat();
	assert.equal((await program(samples)).movedMs, 14_250);
});

test('an out-of-order sample is ignored', async () => {
	const samples = Array.from({ length: 11 }, (_, second) => [1_000_000 + second * 1000, 1000 + second * 8]);
	samples.splice(6, 0, [1_000_000 + 2500, 1000 + 20]);
	assert.equal((await program(samples)).movedMs, 6000);
});

test('a single-player pause is not credited again as server lag after the resume', async () => {
	// The pause already moved the deadline by its own length; game time stood still for 60 wall seconds, so without a
	// re-anchor the first sample after it would add those 60 s again and use up the lag budget.
	const samples = [[1_000_000, 1000], [1_001_000, 1020], 'pause', 'resume', [1_061_000, 1040], [1_062_000, 1060], [1_063_000, 1080]];
	const { movedMs, credits } = await program(samples);
	assert.equal(credits.length, 0, 'no lag credit for the paused minute');
	assert.ok(movedMs < 1_000, `the deadline moved only by the real pause length, ${movedMs} ms`);
});
