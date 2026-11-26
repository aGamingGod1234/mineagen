import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { restsFirst } from '../src/night-cover.mjs';

const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

const at = (dayTime, player = {}) => ({ world: { dimension: 'minecraft:overworld', dayTime },
	player: { x: 0.5, y: 70, z: 0.5, yaw: 0, health: 20, armor: 0, skyOpen: true, onGround: true, ...player }, inventory: { items: [] } });
const walk = { kind: 'action', actionType: 'travel_to', arguments: { x: 40, y: 70, z: 0, timeoutMs: 30_000 } };

test('respawn.restFirst: errands rest first at night on open ground; fights, flight, ways down and day pass', () => {
	assert.equal(restsFirst(at(15_000), walk), true);
	assert.equal(restsFirst(at(15_000), { kind: 'obtain', arguments: { item: 'stone_pickaxe' } }), true, 'g6 157m: obtain a pickaxe 54 s after a night respawn');
	assert.equal(restsFirst(at(15_000), { kind: 'sequence', actions: [{ actionType: 'navigate_to', arguments: { x: 9, y: 70, z: 9 } }] }), true);
	assert.equal(restsFirst(at(15_000), { kind: 'action', actionType: 'fight_target', arguments: {} }), false, 'a fight is the body defending itself');
	assert.equal(restsFirst(at(15_000), { kind: 'action', actionType: 'flee_from', arguments: {} }), false);
	assert.equal(restsFirst(at(15_000), { kind: 'action', actionType: 'dig_to', arguments: { pattern: 'stairs_down', y: 50 } }), false, 'a way down is cover');
	assert.equal(restsFirst(at(6_000), walk), false, 'by day it goes');
	assert.equal(restsFirst(at(15_000, { skyOpen: false }), walk), false, 'under cover already');
	assert.equal(restsFirst(at(15_000, { armor: 15 }), walk), false, 'full iron takes the night');
	assert.equal(restsFirst(at(15_000, { inWater: true }), walk), false, 'out of water first');
	assert.equal(restsFirst(at(15_000), walk, { environment: { MINEAGEN_RESPAWN_REST: 'off' } }), false, 'the off arm');
});

function harness(observation) {
	const record = { agentId: 'rest-agent', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
	const sent = [];
	const results = {};
	const runtime = new NativeToolRuntime({ registry: { get: () => record },
		bridge: { send: async (type, _agent, payload) => {
			if (type !== 'action_command') return;
			sent.push(payload.actionType);
			const reply = results[payload.actionType] ?? { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
			if (reply === 'hang') return;
			queueMicrotask(() => runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: 1, executionStarted: true, ...reply }));
		} } });
	runtime.updateObservation(record, structuredClone(observation), { eventSequence: 1 });
	// A respawn's fresh body sample arrives after the lifecycle disposal, as in a game.
	const respawn = async () => { await runtime.dispose(record.agentId, 'goal_respawn'); runtime.updateObservation(record, structuredClone(observation), { eventSequence: 2 }); };
	const run = (tool, extra = {}) => runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 't', callId: `c${sent.length}`, tool, ...extra }, record);
	return { runtime, record, sent, results, run, respawn };
}

test('after a night respawn the first walk rests until morning first, then walks; the next walk goes straight', async () => {
	const { runtime, record, sent, results, run, respawn } = harness(at(15_000));
	results.rest = { state: 'SUCCEEDED', reasonCode: 'RESTED', message: 'Waited out the night in a roofed hole' };
	await respawn();
	const result = await run(walk);
	assert.deepEqual(sent, ['rest', 'travel_to']);
	assert.equal(result.state, 'SUCCEEDED');
	assert.match(result.restedFirst, /rest ran first: RESTED/);
	await run(walk);
	assert.deepEqual(sent, ['rest', 'travel_to', 'travel_to'], 'once per respawn');
	await runtime.dispose(record.agentId, 'test_complete');
});

test('a stuck rest still lets the errand go; a rest cut short hands back without the errand; no respawn, no rest', async () => {
	{
		const { runtime, record, sent, results, run, respawn } = harness(at(15_000));
		results.rest = { state: 'FAILED', reasonCode: 'REST_STUCK', message: 'no block to roof the hole with' };
		await respawn();
		await run(walk);
		assert.deepEqual(sent, ['rest', 'travel_to']);
		await runtime.dispose(record.agentId, 'test_complete');
	}
	{
		const { runtime, record, sent, results, run, respawn } = harness(at(15_000));
		results.rest = { state: 'CANCELLED', reasonCode: 'REFLEX_PREEMPTED' };
		await respawn();
		const result = await run(walk);
		assert.deepEqual(sent, ['rest']);
		assert.match(result.message, /your travel_to did not start/);
		await runtime.dispose(record.agentId, 'test_complete');
	}
	{
		const { runtime, record, sent, run } = harness(at(15_000));
		await run(walk);
		assert.deepEqual(sent, ['travel_to'], 'a night walk with no respawn is the night gate\'s, not this habit\'s');
		await runtime.dispose(record.agentId, 'test_complete');
	}
	{
		const { runtime, record, sent, run, respawn } = harness(at(15_000));
		await respawn();
		await run({ kind: 'action', actionType: 'rest', arguments: { timeoutMs: 600_000 } });
		await run(walk);
		assert.deepEqual(sent, ['rest', 'travel_to'], 'the model resting itself clears the habit');
		await runtime.dispose(record.agentId, 'test_complete');
	}
});

test('the automatic rest renews the errand\'s lease when it ends, and danger hands it back to the model early', async () => {
	{
		const { runtime, record, sent, run, respawn } = harness(at(15_000));
		const leases = [];
		await respawn();
		await run(walk, { extendLease: ms => leases.push(['extend', ms]), renewLease: () => leases.push(['renew']) });
		assert.deepEqual(sent, ['rest', 'travel_to']);
		assert.deepEqual(leases, [['extend', 600_000], ['renew']], 'the errand gets its own lease after the rest');
		await runtime.dispose(record.agentId, 'test_complete');
	}
	{
		const { runtime, record, sent, results, run, respawn } = harness(at(15_000));
		results.rest = 'hang';
		await respawn();
		const pending = run(walk);
		for (let i = 0; i < 50 && !sent.includes('rest'); i++) await new Promise(done => setTimeout(done, 10));
		assert.equal(runtime.interruptBlockingTool(record.agentId), true, 'the rest is an interruptible blocking run');
		const result = await pending;
		assert.deepEqual(sent, ['rest']);
		assert.equal(result.state, 'RUNNING');
		assert.match(result.message, /your travel_to did not start/);
		await runtime.dispose(record.agentId, 'test_complete');
	}
});
