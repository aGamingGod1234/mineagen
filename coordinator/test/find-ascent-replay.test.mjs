import test from 'node:test';
import assert from 'node:assert/strict';
const { searchFor } = await import(process.env.ASCENT_SOURCE ?? '../src/find-search.mjs');
const { NativeToolRuntime } = await import(process.env.ASCENT_RUNTIME ?? '../src/native-tool-runtime.mjs');
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { checkedSearchBody } from './helpers/checked-body.mjs';

const sample = () => ({ player: { x: 55.5, y: 19, z: -54.5, yaw: 0, health: 20, air: 300, maxAir: 300, skyOpen: false, onGround: true },
	world: { dimension: 'minecraft:overworld' }, inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1 }] }, blocks: [] });
const sky = { x: 55.5, y: 70, z: -54.5 };
function sequence(mode = 'loss') {
	const o = sample(), calls = [];
	let tunnels = 0, retraces = 0, stairs = 0, clock = 0;
	function act(type, args) {
		calls.push({ type, args, fromY: o.player.y });
		assert.ok(calls.length < 100, 'bounded offline fixture');
		clock += 1000;
		let result = { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' };
		if (type === 'dig_to' && args.pattern === 'tunnel') { tunnels++; o.player.x += 8; }
		else if (type === 'travel_to' && args.retrace) {
			retraces++;
			result = { state: 'FAILED', reasonCode: 'NO_ROUTE' };
			if (retraces === 1) o.player.y = 19;
			else if (mode === 'join' || retraces === 3 && mode === 'no-loss') { o.player.y = 70; o.player.skyOpen = true; result = { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
			else {
				if (mode !== 'no-loss') o.player.y = mode === 'net-ascent' ? o.player.y + 2 : 21;
				if (mode === 'seen') o.blocks = [{ blockId: 'minecraft:gravel', x: Math.floor(o.player.x) + 1, y: 21, z: -55 }];
				if (mode === 'unknown') result = {};
				if (mode === 'success-loss') result = { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
				if (mode === 'danger') result = { state: 'FAILED', reasonCode: 'LAVA_AHEAD' };
				if (mode === 'air') { o.player.underWater = true; o.player.air = 10; result = { state: 'FAILED', reasonCode: 'AIR_RESERVE_REACHED' }; }
				if (mode === 'tool') result = { state: 'FAILED', reasonCode: 'NO_TOOL' };
				if (mode === 'capacity') result = { state: 'FAILED', reasonCode: 'INVENTORY_FULL' };
				if (mode === 'deadline') clock += 600000;
			}
		} else if (type === 'dig_to' && args.pattern === 'stairs_up') {
			stairs++; o.player.y = args.y;
			if (mode === 'failed-detour' && stairs === 1) result = { state: 'FAILED', reasonCode: 'NO_ROUTE' };
			if (args.y > 50) o.blocks = [{ blockId: 'minecraft:gravel', x: Math.floor(o.player.x) + 1, y: args.y, z: -55 }];
		} else if (type === 'travel_to' && !args.retrace) {
			o.blocks = [{ blockId: 'minecraft:gravel', x: Math.floor(o.player.x) + 1, y: o.player.y, z: -55 }];
		}
		return result;
	}
	return { o, calls, act, now: () => clock, get tunnels() { return tunnels; } };
}
async function run(mode) {
	const f = sequence(mode);
	const body = checkedSearchBody({ now: f.now, observe: async () => structuredClone(f.o), progress: () => {},
		look: async () => ({ state: 'SUCCEEDED', survey: {} }), act: async (type, args) => f.act(type, args),
		openSky: () => sky, known: () => null, places: async () => [], frontier: () => null });
	const result = await searchFor({ block: 'minecraft:gravel' }, body, { timeoutMs: 570000 });
	return { ...f, result };
}
const ascent = f => f.calls.filter(c => c.args.retrace || c.args.pattern === 'stairs_up');
test('failed height-losing replay after successful detour retires remaining ascent replays and keeps climbing', async () => {
	const f = await run('loss');
	assert.equal(f.tunnels, 3);
	assert.deepEqual(ascent(f).map(c => c.args.retrace ? 'retrace' : `stairs:${c.args.y}`), ['retrace', 'stairs:27', 'retrace', 'stairs:45', 'stairs:69']);
	assert.equal(f.result.reasonCode, 'FIND_SEEN');
	assert.ok(f.o.player.y > 50, 'productive ascent, not earlier failure');
});
for (const mode of ['join', 'no-loss', 'unknown', 'success-loss', 'failed-detour', 'net-ascent']) test(`preserves retrace eligibility: ${mode}`, async () => {
	const f = await run(mode), moves = ascent(f);
	assert.equal(f.result.reasonCode, 'FIND_SEEN');
	assert.equal(moves.filter(c => c.args.retrace).length, mode === 'join' ? 2 : 3);
});
for (const mode of ['danger', 'air', 'tool', 'capacity', 'deadline']) test(`no further dispatch after replay stop: ${mode}`, async () => {
	const f = await run(mode);
	assert.equal(ascent(f).length, 3);
	assert.notEqual(f.result.state, 'SUCCEEDED');
});

// Real native normalization -> admission -> search -> action dispatch -> correlated
// terminal handling. Only the bridge/physics and clock are injected.
test('target seen on failed replay is returned before another move', async () => {
	const f = await run('seen');
	assert.equal(f.result.reasonCode, 'FIND_SEEN');
	assert.equal(ascent(f).length, 3);
});

const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));
for (const mode of ['loss', 'join', 'no-loss', 'danger', 'air', 'interrupt', 'cancel', 'deadline']) test(`native ascent acceptance: ${mode}`, async (t) => {
	const f = sequence(mode), record = { agentId: 'ascent', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' };
	let event = 0, runtime, pendingId;
	const epoch = Date.now();
	t.mock.method(Date, 'now', () => epoch + f.now());
	runtime = new NativeToolRuntime({ registry: { get: () => record },
		requestObservation: async () => ({ observation: structuredClone(f.o), eventSequence: ++event }),
		bridge: { send: async (type, _agent, p) => {
			if (type !== 'action_command') return;
			const result = f.act(p.actionType, p.arguments);
			const replay = ascent(f).filter(c => c.args.retrace).length === 2 && p.arguments.retrace;
			queueMicrotask(() => {
				if (replay && mode === 'interrupt') {
					pendingId = p.actionId;
					assert.equal(runtime.interruptBlockingTool(record.agentId, 'danger'), true);
				} else if (replay && mode === 'cancel') {
					void runtime.dispose(record.agentId, 'explicit_fixture_cancel');
				} else {
					assert.equal(runtime.onActionResult(record, { ...result, actionId: p.actionId, goalRevision: 1, executionStarted: true, physicalAttempted: true }), true);
				}
			});
		} } });
	try {
		// Seed actual runtime open-sky memory before the fresh underground sample.
		runtime.updateObservation(record, { ...sample(), player: { ...sample().player, ...sky, skyOpen: true } }, { eventSequence: ++event });
		runtime.updateObservation(record, structuredClone(f.o), { eventSequence: ++event });
		const tool = normalizeMinecraftToolCall('do_step', { verb: 'find', target: { block: 'minecraft:gravel', timeoutMs: 570000 }, why: 'post-detour ascent acceptance' });
		const pending = runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'ascent-turn', callId: 'ascent-call', tool }, record);
		if (mode === 'cancel') {
			await assert.rejects(pending, { code: 'NATIVE_ACTION_CANCELLED' });
			assert.equal(ascent(f).length, 3, 'cancelled search dispatches no next stair');
			return;
		}
		const result = await pending;
		assert.equal(f.tunnels, 3);
		const moves = ascent(f);
		if (['loss', 'join', 'no-loss'].includes(mode)) {
			assert.equal(result.reasonCode, 'FIND_SEEN', JSON.stringify(result));
			assert.equal(moves.filter(c => c.args.retrace).length, mode === 'no-loss' ? 3 : 2);
			if (mode === 'loss') assert.deepEqual(moves.map(c => c.args.retrace ? 'retrace' : c.args.y), ['retrace', 27, 'retrace', 45, 69]);
		} else {
			assert.equal(moves.length, 3, JSON.stringify(result));
			assert.notEqual(result.state, 'SUCCEEDED');
			if (mode === 'interrupt') {
				assert.equal(result.interruptedBy, 'danger');
				assert.equal(result.actionId, pendingId);
				assert.equal(runtime.onActionResult(record, { actionId: pendingId, goalRevision: 1, state: 'FAILED', reasonCode: 'NO_ROUTE' }), true);
				assert.equal(ascent(f).length, 3, 'late terminal does not resume the old search');
			}
		}
	} finally { await runtime.dispose(record.agentId, 'fixture_complete'); }
});
