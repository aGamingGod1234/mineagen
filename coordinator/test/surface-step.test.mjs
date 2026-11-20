import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runObtain } from '../src/obtain-runner.mjs';
import { runSurfaceStep } from '../src/surface-step.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import * as off from '../src/native-minecraft-tools.mjs';

// The switch is read once, when the tools module loads: a second copy of the module loaded with it set is the "on" side.
async function loadOn() {
	const before = process.env.MINEAGEN_SURFACE_STEP;
	process.env.MINEAGEN_SURFACE_STEP = '1';
	try { return await import('../src/native-minecraft-tools.mjs?surface-step=on'); }
	finally { if (before === undefined) delete process.env.MINEAGEN_SURFACE_STEP; else process.env.MINEAGEN_SURFACE_STEP = before; }
}
const on = await loadOn();
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

const SKY_Y = 60;
const climbCalls = (calls) => calls.filter(([type, args]) => (type === 'dig_to' && args.pattern === 'stairs_up') || (type === 'travel_to' && args.retrace));

/** Under rock until SKY_Y: each stairs_up leg rises up to perLeg blocks (never past its asked y). */
function rock({ startY = 20, perLeg = 24, sky = SKY_Y, code = null } = {}) {
	let y = startY;
	const calls = [];
	const sample = () => ({ world: { dimension: 'minecraft:overworld' }, player: { x: 0.5, y, z: 0.5, health: 20, yaw: 0, onGround: true, skyOpen: y >= sky },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0, damage: 0, maxDamage: 131 }] }, blocks: [], entities: [], items: [] });
	const act = async (type, args) => {
		calls.push([type, args]);
		if (type === 'dig_to' && args.pattern === 'stairs_up') {
			const rose = Math.max(0, Math.min(perLeg, args.y - y));
			y += rose;
			if (code !== null) return { state: 'FAILED', reasonCode: code, message: `${code} at the stair` };
			return rose > 0 ? { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' } : { state: 'FAILED', reasonCode: 'NO_STANCE', message: 'no stance up from here' };
		}
		if (type === 'travel_to' && args.retrace) return { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen leg gets closer' };
		return { state: 'SUCCEEDED' };
	};
	return { calls, sample, act, y: () => y };
}

/** The same rock as obtain's body: obtain needs logs, so it climbs first; its gather then hands back. */
function obtainBody(world) {
	return {
		observe: async () => world.sample(), act: world.act, stopped: () => false, interrupted: () => false, note: () => {},
		moveTo: async () => ({ state: 'SUCCEEDED' }), mine: async () => ({ state: 'SUCCEEDED' }),
		gather: async (args) => { world.calls.push(['gather', args]); return { state: 'FAILED', reasonCode: 'NO_SOURCE', message: 'test stops here' }; },
		search: async (target) => { world.calls.push(['search', target]); return { state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'test stops here' }; },
	};
}

const stepBody = (world, { openSky = null } = {}) => {
	let t = 0;
	return { observe: async () => world.sample(), act: world.act, openSky: () => openSky, now: () => (t += 100) };
};

test('from under rock at y 20 the surface step ends under open sky with the climb obtain makes', async () => {
	const forObtain = rock();
	await runObtain({ item: 'stick', count: 4 }, obtainBody(forObtain), { now: (() => { let t = 0; return () => (t += 100); })() });
	const obtainClimb = climbCalls(forObtain.calls);
	assert.ok(forObtain.y() >= SKY_Y, `obtain climbed to y ${forObtain.y()}`);

	const forStep = rock();
	const result = await runSurfaceStep(stepBody(forStep));
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(result.reasonCode, 'OPEN_SKY');
	assert.equal(result.surface.y, 68);
	assert.equal(result.surface.startY, 20);
	assert.equal(result.surface.skyOpen, true);
	assert.match(result.message, /Under open sky at y 68 \(from y 20\) after 2 stair leg\(s\)/);
	assert.deepEqual(forStep.calls, obtainClimb, 'the same stairs_up legs, in the same order, with the same arguments');
	assert.deepEqual(forStep.calls.map(([, args]) => args), [
		{ pattern: 'stairs_up', y: 44, maxBlocks: 80, throughCaves: 'small', timeoutMs: 120_000 },
		{ pattern: 'stairs_up', y: 68, maxBlocks: 80, throughCaves: 'small', timeoutMs: 120_000 },
	]);
});

test('the surface step goes back the way the body came first, then stairs up when that way is shut', async () => {
	const world = rock();
	const result = await runSurfaceStep(stepBody(world, { openSky: { x: 10.5, y: 64, z: -3.5 } }));
	assert.equal(result.reasonCode, 'OPEN_SKY', result.message);
	assert.deepEqual(world.calls.map(([type, args]) => [type, args.retrace ?? args.pattern]), [['travel_to', true], ['dig_to', 'stairs_up'], ['dig_to', 'stairs_up']]);
	assert.deepEqual(world.calls[0][1], { x: 10.5, y: 64, z: -3.5, retrace: true, tolerance: 3, timeoutMs: 120_000 });
	assert.match(result.message, /after 2 stair leg\(s\) after the way back/);
	// An open-sky spot no higher than the body is no way up: straight to the stairs.
	const level = rock();
	await runSurfaceStep(stepBody(level, { openSky: { x: 10.5, y: 21, z: -3.5 } }));
	assert.equal(level.calls[0][0], 'dig_to');
});

test('the surface step says why it stopped: blocked, danger, out of legs, out of time, no sky, already out', async () => {
	const blocked = await runSurfaceStep(stepBody(rock({ perLeg: 0 })));
	assert.deepEqual([blocked.state, blocked.reasonCode, blocked.surface.y], ['FAILED', 'SURFACE_BLOCKED', 20]);
	assert.match(blocked.message, /stopped at y 20 under cover after 1 stair leg\(s\) \(NO_STANCE: no stance up from here\)/);

	const lava = rock({ code: 'LAVA_AHEAD', perLeg: 3 });
	const danger = await runSurfaceStep(stepBody(lava));
	assert.deepEqual([danger.state, danger.reasonCode, danger.surface.y], ['FAILED', 'SURFACE_DANGER', 23]);
	assert.equal(lava.calls.length, 1, 'no second leg toward lava');
	assert.match(danger.message, /Stopped for danger at y 23 under cover \(LAVA_AHEAD/);

	const legs = await runSurfaceStep(stepBody(rock({ startY: -58, perLeg: 3 })));
	assert.deepEqual([legs.state, legs.reasonCode, legs.legs], ['FAILED', 'SURFACE_OUT_OF_LEGS', 6]);
	assert.match(legs.message, /Still under cover at y -40 after 6 stair leg\(s\)/);

	const slow = rock();
	let t = 0;
	const timed = await runSurfaceStep({ observe: async () => slow.sample(), act: async (type, args) => { t += 100_000; return slow.act(type, args); }, openSky: () => null, now: () => t }, { timeoutMs: 60_000 });
	assert.deepEqual([timed.state, timed.reasonCode], ['TIMED_OUT', 'SURFACE_TIMED_OUT']);
	assert.equal(slow.calls[0][1].timeoutMs, 60_000, 'no call outlives the step');

	const nether = rock();
	const noSky = await runSurfaceStep({ ...stepBody(nether), observe: async () => ({ ...nether.sample(), world: { dimension: 'minecraft:the_nether' } }) });
	assert.deepEqual([noSky.reasonCode, nether.calls.length], ['SURFACE_NO_SKY', 0]);

	const outside = rock({ startY: 70 });
	const already = await runSurfaceStep(stepBody(outside));
	assert.deepEqual([already.reasonCode, outside.calls.length], ['OPEN_SKY', 0]);
	// Unknown sky is not outside: the body climbs.
	const unknown = rock();
	const sampled = unknown.sample;
	unknown.sample = () => { const o = sampled(); if (unknown.calls.length === 0) delete o.player.skyOpen; return o; };
	await runSurfaceStep(stepBody(unknown));
	assert.ok(unknown.calls.length > 0);
});

test('switch off: do_step dig_to until "open_sky" is still a label on a background dig, and the tools are unchanged', () => {
	const call = off.normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { pattern: 'stairs_up', y: 70 }, why: 'back up', until: 'open_sky' });
	assert.equal(call.kind, 'start_action');
	assert.equal(call.actionType, 'dig_to');
	assert.deepEqual(call.step, { verb: 'dig_to', why: 'back up', until: 'open_sky' });
	assert.match(off.MINECRAFT_DYNAMIC_TOOLS.find((entry) => entry.name === 'do_step').description, /until "seen:<block id>" is executable: travel_to and dig_to stop on sight; other background verbs wake you; other until is a label\./);
	assert.doesNotMatch(JSON.stringify(off.MINECRAFT_DYNAMIC_TOOLS), /open_sky/);
	// Any value but 1 is off.
	const script = "import('./src/native-minecraft-tools.mjs').then((m) => process.stdout.write(JSON.stringify(m.MINECRAFT_DYNAMIC_TOOLS)))";
	const cwd = new URL('../', import.meta.url);
	const unset = execFileSync(process.execPath, ['-e', script], { cwd, env: { ...process.env, MINEAGEN_SURFACE_STEP: '' } }).toString();
	const zero = execFileSync(process.execPath, ['-e', script], { cwd, env: { ...process.env, MINEAGEN_SURFACE_STEP: '0' } }).toString();
	assert.equal(unset, JSON.stringify(off.MINECRAFT_DYNAMIC_TOOLS));
	assert.equal(zero, unset);
});

test('switch on: only the do_step until claim changes, within the tool byte budgets', () => {
	const changed = on.MINECRAFT_DYNAMIC_TOOLS.filter((entry, i) => JSON.stringify(entry) !== JSON.stringify(off.MINECRAFT_DYNAMIC_TOOLS[i]));
	assert.deepEqual(changed.map((entry) => entry.name), ['do_step']);
	const before = off.MINECRAFT_DYNAMIC_TOOLS.find((entry) => entry.name === 'do_step');
	assert.deepEqual(changed[0].inputSchema, before.inputSchema, 'the schema itself is the same; only the description names open_sky');
	assert.match(changed[0].description, /dig_to "open_sky" climbs to sky, returns; else a label\./);
	assert.ok(Buffer.byteLength(changed[0].description) <= Buffer.byteLength(before.description));
	// The same two ceilings the off tools are held to (token-budget and portal-cast-hand tests), measured with the switch on.
	const script = "Promise.all([import('./src/benchmark/token-budget.mjs'), import('./src/native-minecraft-tools.mjs')]).then(([b, m]) => process.stdout.write(JSON.stringify([b.measureTokenBudget().toolSchemaBytes, Buffer.byteLength(JSON.stringify(m.MINECRAFT_DYNAMIC_TOOLS)), m.MINECRAFT_DYNAMIC_TOOLS.find((t) => t.name === 'do_step').description.includes('open_sky')])))";
	const [schemaBytes, payloadBytes, named] = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: new URL('../', import.meta.url), env: { ...process.env, MINEAGEN_SURFACE_STEP: '1' } }).toString());
	assert.equal(named, true);
	assert.ok(schemaBytes <= 38_900, `tool schemas ${schemaBytes} bytes`);
	assert.ok(payloadBytes <= 39_476, `tool payload ${payloadBytes} bytes`);
});

test('switch on: do_step dig_to until "open_sky" is the surface step; other verbs and overlap options refuse', () => {
	const call = on.normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: {}, why: 'back up for logs', until: 'open_sky' });
	assert.deepEqual(call, { kind: 'surface', arguments: { timeoutMs: 540_000 }, step: { verb: 'dig_to', why: 'back up for logs', until: 'open_sky' } });
	assert.equal(on.normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { pattern: 'stairs_up', timeoutMs: 90_000 }, why: 'up', until: 'open_sky' }).arguments.timeoutMs, 90_000);
	for (const [args, message] of [
		[{ verb: 'travel_to', target: { x: 1, y: 70, z: 1 }, why: 'up', until: 'open_sky' }, /climbs with verb dig_to, not travel_to/],
		[{ verb: 'dig_to', target: { y: 70 }, why: 'up', until: 'open_sky' }, /unexpected argument 'y'/],
		[{ verb: 'dig_to', target: { pattern: 'tunnel' }, why: 'up', until: 'open_sky' }, /digs stairs_up; omit pattern/],
		[{ verb: 'dig_to', target: {}, why: 'up', until: 'open_sky', keepGoing: true }, /after and keepGoing do not apply/],
		[{ verb: 'dig_to', target: {}, why: 'up', until: 'open_sky', after: 'native:a:1' }, /after and keepGoing do not apply/],
		[{ verb: 'dig_to', target: { timeoutMs: 600_000 }, why: 'up', until: 'open_sky' }, /timeoutMs/],
	]) assert.throws(() => on.normalizeMinecraftToolCall('do_step', args), message);
	// Every other until reads as before.
	const seen = on.normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { pattern: 'stairs_up', y: 70 }, why: 'up', until: 'seen:oak_log' });
	assert.equal(seen.arguments.stopWhenSeen, 'minecraft:oak_log');
	assert.equal(on.normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { pattern: 'stairs_up', y: 70 }, why: 'up', until: 'sky' }).kind, 'start_action');
});

/** The production runtime with only the bridge's replies injected: each stairs_up command raises the body. */
async function runtimeClimb({ interrupt = false } = {}) {
	const record = { agentId: 'surface-agent', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' };
	let y = 20, sequence = 0, runtime;
	const moves = [];
	const sample = () => ({ world: { dimension: 'minecraft:overworld' }, player: { x: 0.5, y, z: 0.5, yaw: 0, health: 20, onGround: true, skyOpen: y >= SKY_Y },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1 }] }, blocks: [] });
	runtime = new NativeToolRuntime({
		requestObservation: async () => ({ eventSequence: ++sequence, observation: sample() }),
		inspectObservation: async () => ({ survey: {} }),
		bridge: { send: async (type, _agent, p) => {
			if (type !== 'action_command' || p.actionType === 'control') {
				if (type === 'action_command') queueMicrotask(() => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'CONTROL_SEGMENT_COMPLETED', executionStarted: true, physicalAttempted: true }));
				return;
			}
			moves.push({ actionType: p.actionType, ...p.arguments });
			queueMicrotask(() => {
				if (interrupt) { assert.equal(runtime.interruptBlockingTool(record.agentId, 'danger'), true); return; }
				y = Math.min(p.arguments.y, y + 24);
				runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED', executionStarted: true, physicalAttempted: true });
			});
		} },
	});
	try {
		runtime.updateObservation(record, sample(), { eventSequence: ++sequence });
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'surface', callId: 'surface',
			tool: on.normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: {}, why: 'back up to the surface', until: 'open_sky' }) }, record);
		return { result, moves };
	} finally { await runtime.dispose(record.agentId, 'test_complete'); }
}

test('through the production runtime, one do_step call climbs from y 20 to open sky and returns its result', async () => {
	const { result, moves } = await runtimeClimb();
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(result.reasonCode, 'OPEN_SKY');
	assert.equal(result.surface.y, 68);
	assert.deepEqual(result.step, { verb: 'dig_to', why: 'back up to the surface', until: 'open_sky' }, 'returned, not started in the background');
	assert.deepEqual(moves.map(({ actionType, pattern, y }) => `${actionType} ${pattern} y${y}`), ['dig_to stairs_up y44', 'dig_to stairs_up y68']);
});

test('through the production runtime, danger during a leg hands the climb back with the leg still running', async () => {
	const { result, moves } = await runtimeClimb({ interrupt: true });
	assert.equal(moves.length, 1);
	assert.equal(result.reasonCode, 'SURFACE_DANGER');
	assert.equal(result.state, 'RUNNING');
	assert.ok(result.actionId);
	assert.match(result.message, /Danger stopped the climb at y 20; the leg still runs/);
});
