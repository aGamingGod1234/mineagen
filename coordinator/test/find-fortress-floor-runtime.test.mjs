import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const saved = JSON.parse(readFileSync(new URL('./fixtures/fortress-spawner/c8861.json', import.meta.url)));
// Actual recorded facts enter the production native runtime. Only bridge replies/physics are injected.
async function replay(index, reasonCode = 'NO_ROUTE', change = () => {}) {
	const observation = structuredClone(saved.windows[index].observation);
	change(observation);
	const record = { agentId: 'floor-replay', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' };
	let runtime, sequence = 0;
	const moves = [];
	runtime = new NativeToolRuntime({
		requestObservation: async () => ({ eventSequence: ++sequence, observation: structuredClone(observation) }),
		inspectObservation: async () => ({ survey: {} }),
		bridge: { send: async (type, _agent, p) => {
			if (type !== 'action_command') return;
			const moving = p.actionType !== 'control';
			if (moving) moves.push({ actionType: p.actionType, ...p.arguments });
			queueMicrotask(() => {
				if (moving && reasonCode === 'INTERRUPT') {
					assert.equal(runtime.interruptBlockingTool(record.agentId, 'danger'), true);
					return;
				}
				if (moving && reasonCode === 'CANCEL') { void runtime.dispose(record.agentId, 'explicit_model_cancel'); return; }
				runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1,
					state: moving ? 'FAILED' : 'SUCCEEDED', reasonCode: moving ? reasonCode : 'CONTROL_SEGMENT_COMPLETED', executionStarted: true, physicalAttempted: true });
			});
		} },
	});
	const keepAlive = setInterval(() => {}, 1000);
	try {
		runtime.updateObservation(record, observation, { eventSequence: ++sequence });
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'replay', callId: 'find',
			tool: normalizeMinecraftToolCall('do_step', { verb: 'find', target: { block: 'spawner', within: 96, timeoutMs: 60000 }, why: 'search observed fortress flooring' }) }, record);
		return { result, moves };
	} finally { await runtime.dispose(record.agentId, 'test_complete'); clearInterval(keepAlive); }
}

test('c8861 visible floor is approached instead of bridging northeast through rock', async () => {
	const { result, moves } = await replay(1);
	assert.equal(moves.length, 1);
	assert.equal(moves[0].actionType, 'travel_to');
	assert.deepEqual([moves[0].x, moves[0].y, moves[0].z], [9.5, 67, 113.5]);
	assert.equal(moves[0].build, false);
	assert.equal(moves[0].tolerance, 1);
	assert.equal(moves[0].stopWhenSeen, 'minecraft:spawner');
	assert.equal(moves[0].fightThrough, undefined);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.equal(result.find.seen, undefined);
});

test('c8861 initial underside masonry has no visible top and does not justify blind travel', async () => {
	const { result, moves } = await replay(0);
	assert.equal(moves.length, 0);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
});

test('native floor interruption hands the running action back without another leg', async () => {
	const { result, moves } = await replay(1, 'INTERRUPT');
	assert.equal(moves.length, 1);
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.equal(result.state, 'RUNNING');
	assert.ok(result.actionId);
});

test('explicit model cancellation stops the floor search', async () => {
	await assert.rejects(replay(1, 'CANCEL'), { code: 'NATIVE_ACTION_CANCELLED' });
});

for (const code of ['LAVA_AHEAD', 'VOID_EDGE', 'LOW_HEALTH', 'TRAVEL_DAMAGED', 'NO_TOOL', 'TOOL_WORN']) {
	test(`native floor search preserves ${code} handback`, async () => {
		const { result, moves } = await replay(1, code);
		assert.equal(moves.length, 1);
		assert.equal(moves[0].build, false);
		assert.equal(result.reasonCode, ['NO_TOOL', 'TOOL_WORN'].includes(code) ? 'FIND_BLOCKED' : 'FIND_DANGER');
	});
}

// Wall breaker rods (b): no floor leg past a seen wither skeleton.
test('rods (b): a wither skeleton by the only visible floor stops the search with WITHER_ON_DECK and no leg', async () => {
	const { result, moves } = await replay(1, 'NO_ROUTE', (observation) => {
		observation.entities = [{ type: 'minecraft:wither_skeleton', stableId: 'w1', x: 9.5, y: 67, z: 110.5, distance: 12, alive: true, perceivedBy: 'sight' }];
	});
	assert.equal(moves.length, 0, 'no walk onto the deck');
	assert.equal(result.reasonCode, 'WITHER_ON_DECK');
	assert.match(result.message ?? JSON.stringify(result), /wither skeleton/);
});

test('rods (b): a wither skeleton far from the floor and its line does not stop the leg', async () => {
	const { result, moves } = await replay(1, 'NO_ROUTE', (observation) => {
		const p = observation.player;
		observation.entities = [{ type: 'minecraft:wither_skeleton', stableId: 'w1', x: p.x - 30, y: p.y, z: p.z - 30, distance: 42, alive: true, perceivedBy: 'sight' }];
	});
	assert.equal(moves.length, 1);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
});

// Far sight's spawner platform row (FarSight.platformRows): the spawner stands on top, hidden from the bridges below,
// so a seen platform is walked to before any floor leg.
test('a seen spawner platform is the first leg, building allowed, stopping when the spawner is seen', async () => {
	const { moves } = await replay(1, 'NO_ROUTE', (observation) => {
		const p = observation.player;
		observation.sighted = { ...(observation.sighted ?? {}), structures: [
			{ structure: 'nether fortress', x: Math.floor(p.x) + 5, y: Math.floor(p.y), z: Math.floor(p.z) + 5, distance: 7, size: 20 },
			{ structure: 'nether fortress spawner platform', x: Math.floor(p.x) + 30, y: Math.floor(p.y) + 3, z: Math.floor(p.z) - 10, distance: 32, size: 9 }] };
	});
	assert.ok(moves.length >= 1);
	assert.equal(moves[0].actionType, 'travel_to');
	assert.equal(moves[0].build, true);
	assert.equal(moves[0].stopWhenSeen, 'minecraft:spawner');
	const p = saved.windows[1].observation.player;
	assert.deepEqual([moves[0].x, moves[0].y, moves[0].z], [Math.floor(p.x) + 30.5, Math.floor(p.y) + 4, Math.floor(p.z) - 9.5]);
	// The platform is tried once; later legs are the ordinary floor walk.
	assert.ok(moves.slice(1).every((move) => move.build !== true || move.x !== moves[0].x));
});

// The row's cell is the platform block the sight line hit, so it moves as the body does: still one platform.
test('a platform seen at a different block after the approach is not walked to again', async () => {
	let views = 0;
	const { moves } = await replay(1, 'NO_ROUTE', (observation) => {
		const p = observation.player, base = { x: Math.floor(p.x) + 30, y: Math.floor(p.y) + 3, z: Math.floor(p.z) - 10 };
		const structures = observation.sighted?.structures ?? [];
		Object.defineProperty(observation.sighted ??= {}, 'structures', { enumerable: true, get: () => {
			const shift = views++ % 4;
			return [...structures, { structure: 'nether fortress spawner platform', x: base.x + shift, y: base.y + (shift % 2), z: base.z - shift, distance: 32, size: 9 }];
		} });
	});
	assert.ok(views > 1);
	assert.equal(moves.filter((move) => move.tolerance === 3 && move.build === true).length, 1);
});

test('no platform leg past a seen wither skeleton', async () => {
	const { moves } = await replay(1, 'NO_ROUTE', (observation) => {
		const p = observation.player, platform = { x: Math.floor(p.x) + 30, y: Math.floor(p.y) + 3, z: Math.floor(p.z) - 10 };
		observation.sighted = { ...(observation.sighted ?? {}), structures: [{ structure: 'nether fortress spawner platform', ...platform, distance: 32, size: 9 }] };
		observation.entities = [...(observation.entities ?? []), { type: 'minecraft:wither_skeleton', x: platform.x - 2, y: platform.y + 1, z: platform.z + 1 }];
	});
	assert.ok(moves.every((move) => move.tolerance !== 3));
});

test('without a platform row the floor walk is unchanged', async () => {
	const { moves } = await replay(1);
	assert.deepEqual([moves[0].x, moves[0].y, moves[0].z], [9.5, 67, 113.5]);
});
