import test from 'node:test';
import assert from 'node:assert/strict';
const { NativeToolRuntime } = await import(process.env.IRON_RUNTIME ?? '../src/native-tool-runtime.mjs');
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { checkedObtainBody, runObtain } from './helpers/checked-body.mjs';

const ore = { blockId: 'minecraft:deepslate_iron_ore', x: 24, y: 4, z: 172 };
const sample = () => ({ world: { worldId: 'flood-world', dimension: 'minecraft:overworld' },
	player: { x: 27.5, y: 7, z: 181.5, health: 20, air: 300, maxAir: 300, onGround: true },
	inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1, remainingDurability: 100 }] },
	blocks: [ore, { blockId: 'minecraft:stone', x: 27, y: 6, z: 181 }] });
const flood = { state: 'FAILED', reasonCode: 'TUNNEL_FLOODED', actionId: 'flood-terminal', executionStarted: true, physicalAttempted: true };
function fixture() {
	const o = sample(), approaches = [], actions = [], misses = [];
	let stop = false, result = flood, clock = 1000;
	const body = { observe: async () => structuredClone(o), stopped: () => stop, interrupted: () => false, note: () => {},
		act: async (type, args) => { actions.push({ type, args }); return result; },
		mine: async () => { throw new Error('must not mine through flood'); },
		missPlace: (...args) => misses.push(args) };
	return { o, approaches, actions, misses, body, setResult: (r) => { result = r; }, cancel: () => { stop = true; },
		advance: (ms) => { clock += ms; },
		// A fresh checked copy each run, so an act a test puts on f.body is checked too.
		run: () => runObtain({ item: 'raw_iron', timeoutMs: 60000 }, checkedObtainBody({ ...body }), { approaches, now: () => clock }) };
}

test('runObtain retains terminal flood provenance, hands back danger, and excludes only that approach', async () => {
	const f = fixture();
	assert.equal((await f.run()).reasonCode, 'DANGER');
	assert.equal(f.actions.length, 1);
	assert.equal(f.approaches[0].actionId, 'flood-terminal');
	assert.equal(f.approaches[0].reasonCode, 'TUNNEL_FLOODED');
	assert.equal((await f.run()).reasonCode, 'DANGER');
	assert.equal(f.actions.length, 2);
	assert.equal(f.actions[1].type, 'dig_to');
	assert.ok(f.actions[1].args.heading);
	assert.equal(f.misses.length, 0, 'no global ore/vein reach failure');
	f.o.player.x += 2;
	assert.equal((await f.run()).reasonCode, 'DANGER');
	assert.equal(f.actions.length, 3, 'changed approach can reconsider ore');
});

for (const change of ['dimension', 'world', 'position', 'footing', 'water', 'expiry', 'reset']) test(`approach memory resets on ${change}`, async () => {
	const f = fixture();
	await f.run();
	if (change === 'dimension') f.o.world.dimension = 'minecraft:the_nether';
	if (change === 'world') f.o.world.worldId = 'other-world';
	if (change === 'position') f.o.player.y++;
	if (change === 'footing') f.o.blocks[1].blockId = 'minecraft:cobblestone';
	if (change === 'water') f.o.player.inWater = true;
	if (change === 'expiry') f.advance(600000);
	if (change === 'reset') f.approaches.splice(0);
	assert.equal((await f.run()).reasonCode, 'DANGER');
	assert.equal(f.actions.length, 2);
});

test('observation order, clock and subcell jitter do not manufacture a changed approach', async () => {
	const f = fixture(); await f.run();
	f.o.blocks.reverse(); f.o.player.x += 0.01; f.o.world.gameTime = 1234;
	assert.equal((await f.run()).reasonCode, 'DANGER');
	assert.equal(f.actions.length, 2);
	assert.ok(f.actions[1].args.heading);
});

test('another visible ore remains selectable even in the same vein', async () => {
	const f = fixture(); await f.run();
	f.o.blocks.push({ ...ore, x: 25 });
	assert.equal((await f.run()).reasonCode, 'DANGER');
	assert.equal(f.actions.at(-1).args.x, 25.5);
	assert.equal(f.misses.length, 0);
});

for (const code of ['TRAVEL_DAMAGED', 'HOSTILE_NEAR', 'TOOL_WORN', 'NO_TOOL', 'INVENTORY_FULL', 'CANCELLED']) test(`${code} does not become a remembered flood failure`, async () => {
	const f = fixture();
	// Stop after this diagnostic terminal so unrelated obtain recovery is outside this check.
	f.body.act = async () => { f.cancel(); return { state: code === 'CANCELLED' ? 'CANCELLED' : 'FAILED', reasonCode: code }; };
	await f.run(); assert.deepEqual(f.approaches, []); assert.deepEqual(f.misses, []);
});
for (const field of ['executionStarted', 'physicalAttempted']) test(`explicit ${field}=false is not a proven failed approach`, async () => {
	const f = fixture(); f.setResult({ ...flood, [field]: false });
	assert.equal((await f.run()).reasonCode, 'DANGER'); assert.deepEqual(f.approaches, []);
});
test('cancellation during a flood terminal does not retain an approach', async () => {
	const f = fixture(); f.body.act = async () => { f.cancel(); return flood; };
	await f.run(); assert.deepEqual(f.approaches, []);
});
test('missing dimension does not create an ambiguous exclusion', async () => {
	const f = fixture(); delete f.o.world.dimension;
	await f.run(); assert.deepEqual(f.approaches, []);
});

for (const leg of ['stairs_down', 'tunnel']) test(`a flooded ${leg} is remembered before another dispatch`, async () => {
	const f = fixture();
	if (leg === 'tunnel') f.o.player.y = 4;
	f.body.act = async (type, args) => {
		f.actions.push({ type, args });
		return type === 'travel_to' ? { state: 'FAILED', reasonCode: 'NO_ROUTE' } : flood;
	};
	assert.equal((await f.run()).reasonCode, 'DANGER');
	assert.equal(f.actions.at(-1).args.pattern, leg);
	const dispatched = f.actions.length;
	assert.equal((await f.run()).reasonCode, 'DANGER');
	assert.equal(f.actions.length, dispatched + 1);
	assert.ok(f.actions.at(-1).args.heading);
	assert.deepEqual(f.misses, []);
});
test('unproven execution is not retained', async () => {
	const f = fixture(); f.setResult({ state: 'FAILED', reasonCode: 'TUNNEL_FLOODED' });
	assert.equal((await f.run()).reasonCode, 'DANGER'); assert.deepEqual(f.approaches, []);
});
test('memory remains bounded across alternate source failures at unchanged footing', async () => {
	const f = fixture();
	for (let i = 0; i < 40; i++) {
		f.o.blocks[0] = { ...ore, x: 20 + i % 8, z: 170 + Math.floor(i / 8) };
		assert.equal((await f.run()).reasonCode, 'DANGER');
	}
	assert.equal(f.approaches.length, 32);
});

const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

for (const scenario of ['progress', 'stationary', 'blocked', 'tool', 'danger', 'cancel', 'capacity', 'late lava', 'late hostile', 'wet late lava', 'wet late hostile']) test(`production native relocation: ${scenario}`, async () => {
	const record = { agentId: 'one', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' };
	const o = sample(), commands = [];
	if (scenario.startsWith('wet ')) o.player.inWater = true;
	let sequence = 1, runtime, resumed = false, resumedSamples = 0;
	runtime = new NativeToolRuntime({ registry: { get: () => record },
		requestObservation: async () => {
			// Five safe observations reach the caller check; danger arrives in relocation's newer sample.
			if (resumed && ++resumedSamples >= 6) {
				if (scenario.endsWith('late lava')) o.player.inLava = true;
				if (scenario.endsWith('late hostile')) o.entities = [{ type: 'minecraft:zombie', hostile: true, alive: true, x: o.player.x + 1, y: o.player.y, z: o.player.z }];
			}
			return { observation: structuredClone(o), eventSequence: ++sequence };
		},
		bridge: { send: async (type, _id, p) => {
			if (type !== 'action_command') return;
			commands.push(p); assert.ok(commands.length < 15, 'bounded fixture');
			let result = resumed && scenario === 'progress' && commands.length > 2 ? { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' } : flood;
			if (resumed && p.actionType === 'dig_to' && p.arguments.heading) {
				result = { state: 'SUCCEEDED', reasonCode: 'DIG_COMPLETE', executionStarted: true, physicalAttempted: true };
				if (scenario === 'blocked') result = { state: 'FAILED', reasonCode: 'NO_ROUTE' };
				if (scenario === 'tool') result = { state: 'FAILED', reasonCode: 'TOOL_WORN' };
				if (scenario === 'danger') result = { state: 'FAILED', reasonCode: 'TRAVEL_DAMAGED' };
				if (scenario === 'capacity') result = { state: 'FAILED', reasonCode: 'INVENTORY_FULL' };
				if (scenario === 'progress') Object.assign(o.player, { x: 26.5, y: 4, z: 172.5 });
				if (scenario === 'cancel') result = { state: 'CANCELLED', reasonCode: 'CANCELLED' };
			}
			if (p.actionType === 'mine_vein') {
				o.inventory.items.push({ itemId: 'minecraft:raw_iron', slot: 1, count: 1 });
				o.blocks = o.blocks.filter(b => b !== ore && b.blockId !== ore.blockId);
				result = { state: 'SUCCEEDED', reasonCode: 'MINED', executionStarted: true, physicalAttempted: true };
			}
			queueMicrotask(() => {
				runtime.onActionResult(record, { ...result, actionId: p.actionId, goalRevision: 1 });
				if (resumed && scenario === 'cancel') void runtime.dispose(record.agentId, 'explicit_test_cancellation');
			});
		} } });
	const run = (timeoutMs = 60000) => runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: `turn-${sequence}`, callId: `call-${sequence}`,
		tool: normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'raw_iron', timeoutMs }, why: 'flood relocation acceptance' }) }, record);
	try {
		runtime.updateObservation(record, structuredClone(o), { eventSequence: ++sequence });
		assert.equal((await run()).reasonCode, 'DANGER');
		assert.equal(commands.length, 1);
		resumed = true;
		const result = await run();
		if (scenario.includes('late ')) {
			assert.ok(resumedSamples >= 6, 'fresh danger sample was delivered');
			assert.equal(result.reasonCode, 'DANGER', result.message);
			assert.equal(commands.length, 1, 'no relocation dispatch after the latest sample reports danger');
			return;
		}
		if (process.env.IRON_BEFORE) {
			assert.equal(result.reasonCode, process.env.IRON_BEFORE === 'prototype' ? 'NO_SOURCE' : 'DANGER');
			assert.equal(commands.length, process.env.IRON_BEFORE === 'prototype' ? 1 : 2);
			if (commands[1]) {
				assert.equal(commands[1].actionType, 'travel_to');
				assert.equal(commands[1].arguments.x, 24.5);
				assert.equal(commands[1].arguments.z, 172.5);
			}
			assert.equal(o.inventory.items.some(i => i.itemId === 'minecraft:raw_iron'), false);
			return;
		}
		assert.equal(commands[1].actionType, 'dig_to');
		assert.ok(commands[1].arguments.heading, 'relocate instead of original target dispatch');
		if (scenario === 'progress') {
			assert.equal(result.reasonCode, 'OBTAINED', result.message);
			assert.equal(result.held, 1);
			assert.ok(commands.some(c => c.actionType === 'mine_vein'));
		} else {
			assert.equal(commands.length, 2, 'nothing dispatched after relocation stop');
			assert.equal(result.reasonCode, ({ danger: 'DANGER', cancel: 'CANCELLED', tool: 'TOOL_WORN' })[scenario] ?? 'OBTAIN_STUCK', result.message);
		}
	} finally { await runtime.disposeAll('test_complete'); }
});
test('production native obtain: danger handback, stationary suppression, alternate ore, agents and lifecycle isolation', async () => {
	const records = new Map(['one', 'two'].map((agentId) => [agentId, { agentId, goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' }]));
	const observations = new Map([...records.keys()].map((id) => [id, sample()]));
	const commands = [];
	let sequence = 1, runtime;
	runtime = new NativeToolRuntime({ registry: { get: (id) => records.get(id) },
		requestObservation: async (record) => ({ observation: structuredClone(observations.get(record.agentId)), eventSequence: ++sequence }),
		bridge: { send: async (type, agentId, p) => {
			if (type !== 'action_command') return;
			commands.push({ agentId, ...p });
			queueMicrotask(() => runtime.onActionResult(records.get(agentId), { ...flood, actionId: p.actionId, goalRevision: 1 }));
		} } });
	const run = async (id) => runtime.execute({ agentId: id, goalRevision: 1, turnId: `turn-${sequence}`, callId: `call-${sequence}`,
		tool: normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'raw_iron', timeoutMs: 60000 }, why: 'flood acceptance' }) }, records.get(id));
	try {
		for (const [id, record] of records) runtime.updateObservation(record, structuredClone(observations.get(id)), { eventSequence: ++sequence });
		assert.equal((await run('one')).reasonCode, 'DANGER');
		assert.equal(commands.length, 1, 'immediate danger handback dispatches no digging');
		assert.equal((await run('one')).reasonCode, 'DANGER');
		assert.equal(commands.length, 2, 'same context relocates');
		assert.ok(commands[1].arguments.heading);
		assert.equal((await run('two')).reasonCode, 'DANGER');
		assert.equal(commands.length, 3, 'failure does not leak across agents');
		observations.get('one').blocks.push({ ...ore, x: 25 });
		assert.equal((await run('one')).reasonCode, 'DANGER');
		assert.equal(commands.at(-1).arguments.x, 25.5);
		observations.get('one').blocks.pop(); observations.get('one').player.x += 2;
		assert.equal((await run('one')).reasonCode, 'DANGER');
		assert.equal(commands.at(-1).arguments.x, 24.5);
		assert.equal((await run('one')).reasonCode, 'DANGER');
		await runtime.dispose('one', 'goal_respawn');
		runtime.updateObservation(records.get('one'), structuredClone(observations.get('one')), { eventSequence: ++sequence });
		assert.equal((await run('one')).reasonCode, 'DANGER', 'lifecycle reset forgets exclusion');
	} finally { await runtime.disposeAll('test_complete'); }
});


for (const stop of ['deadline', 'fresh danger', 'fresh hostile']) test(`remembered approach: ${stop} prevents relocation dispatch`, async () => {
	const f = fixture(); await f.run();
	const observe = f.body.observe;
	let samples = 0;
	f.body.observe = async () => {
		const o = await observe();
		if (++samples >= 2) {
			if (stop === 'deadline') f.advance(60001);
			if (stop === 'fresh danger') o.player.inLava = true;
			if (stop === 'fresh hostile') o.entities = [{ type: 'minecraft:zombie', hostile: true, alive: true, x: o.player.x + 1, y: o.player.y, z: o.player.z }];
		}
		return o;
	};
	assert.equal((await f.run()).reasonCode, stop === 'deadline' ? 'OBTAIN_TIMEOUT' : 'DANGER');
	assert.equal(f.actions.length, 1, 'only first flood was dispatched');
});


test('deadline during successful relocation prevents selecting or mining the ore', async () => {
	const f = fixture(); await f.run();
	f.body.act = async (type, args) => {
		f.actions.push({ type, args });
		Object.assign(f.o.player, { x: 26.5, y: 4, z: 172.5 });
		f.advance(60001);
		return { state: 'SUCCEEDED', reasonCode: 'DIG_COMPLETE' };
	};
	assert.equal((await f.run()).reasonCode, 'OBTAIN_TIMEOUT');
	assert.equal(f.actions.length, 2);
	assert.ok(f.actions[1].args.heading);
});
