import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { nextKitStep } from '../src/kit-habit.mjs';
import { immutableGoalSpec } from './fixtures/dynamic-main-fixture.mjs';

// kit.armourGate: in the 10 fresh games of 27 Nov the route said "obtain iron_chestplate" in 93 wakes and the model acted
// on it 0 times; 7 games never wore an iron piece and 15 of 19 deaths were at armour 0. A portal call (cast or build the
// frame, walk into a lit portal) with no chestplate now runs that obtain first, once per life.

const record = { agentId: 'armour-gate', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', goalRevision: 1 };
const sample = (extra = {}) => ({ ready: true, observedAtEpochMs: Date.now(), world: { worldId: 'w', dimension: 'minecraft:overworld' },
	player: { x: 10.5, y: -50, z: 20.5, health: 20, foodLevel: 20, skyOpen: false, onGround: true }, position: { x: 10.5, y: -50, z: 20.5 },
	inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_pickaxe', slot: 0, count: 1 }, { itemId: 'minecraft:iron_ingot', slot: 1, count: 6 }] },
	blocks: [], items: [], entities: [], ...extra });
const STOCK = { item: 'iron_chestplate', count: 1, portals: [{ x: 40, y: 64, z: 12, lit: true, dimension: 'minecraft:overworld' }], worldId: 'w', deaths: 0 };
const step = (verb, target) => normalizeMinecraftToolCall('do_step', { verb, target, why: 'go to the Nether' });

async function harness(t, { stock = () => STOCK, gate, observation = sample(), slow = false } = {}) {
	const before = process.env.MINEAGEN_ARMOUR_GATE;
	if (gate === undefined) delete process.env.MINEAGEN_ARMOUR_GATE; else process.env.MINEAGEN_ARMOUR_GATE = gate;
	const commands = [], traces = [];
	let runtime, n = 0;
	// slow: each body step and look takes a minute on the clock, so a turned obtain that fails has run past the free window.
	if (slow) { try { t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); } catch (error) { if (error?.code !== 'ERR_INVALID_STATE') throw error; } }
	runtime = new NativeToolRuntime({ registry: { get: () => record }, armourStock: stock,
		trace: (event, fields) => traces.push({ event, ...fields }),
		bridge: { send: async (type, agentId, payload) => {
			commands.push({ type, payload });
			// Every body step ends at once with no way on, so an obtain hands back quickly.
			if (type === 'action_command') setTimeout(() => runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: 1,
				state: 'FAILED', reasonCode: 'NO_ROUTE', executionStarted: true, physicalAttempted: true }), 1);
		} },
		requestObservation: async () => (slow && t.mock.timers.tick(61_000), { observation: { ...observation, observedAtEpochMs: Date.now() }, eventSequence: ++n + 1 }) });
	runtime.updateObservation(record, observation, { eventSequence: 1 });
	t.after(async () => {
		await runtime.dispose(record.agentId, 'test_complete');
		if (before === undefined) delete process.env.MINEAGEN_ARMOUR_GATE; else process.env.MINEAGEN_ARMOUR_GATE = before;
	});
	let call = 0;
	const leases = [];
	const run = async (tool) => {
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: `t${++call}`, callId: `c${call}`, tool, extendLease: ms => leases.push(ms) }, record);
		if (result?.state === 'RUNNING' && result.actionId) {
			await new Promise(resolve => setTimeout(resolve, 10));
			return runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: `s${call}`, callId: `s${call}`, tool: { kind: 'action_status', actionId: result.actionId } }, record);
		}
		return result;
	};
	const turned = () => traces.filter(row => row.event === 'native_armour_gate_turned');
	const sent = type => commands.filter(row => row.type === 'action_command' && row.payload.actionType === type).length;
	return { run, commands, traces, turned, sent, leases };
}

test('a portal cast with no chestplate runs obtain iron_chestplate instead, and says so', async t => {
	const h = await harness(t);
	const result = await h.run(step('cast_obsidian', { frame: true, x: 12, y: -52, z: 20, axis: 'x' }));
	assert.equal(h.sent('cast_obsidian'), 0);
	assert.match(result.stockedFirst, /^Armour first: no chestplate worn, so the cast_obsidian call became obtain iron_chestplate/);
	assert.equal(h.turned().length, 1);
	assert.ok(h.leases.some(ms => ms >= 360_000), JSON.stringify(h.leases));
	assert.equal(result.stockedTool?.kind, 'obtain');
	assert.equal(result.stockedTool?.arguments?.item, 'iron_chestplate');
	assert.equal(result.stockedTool?.arguments?.timeoutMs, 360_000);
	assert.doesNotMatch(JSON.stringify(result), /stockedTool/);
});

test('build nether_portal and walks into a lit portal or to the Nether are turned; other walks and digs are not', async t => {
	const build = await harness(t);
	await build.run(step('build', { structure: 'nether_portal' }));
	assert.equal(build.turned().at(-1)?.actionType, 'build');
	const walk = await harness(t);
	await walk.run(step('travel_to', { x: 41, y: 64, z: 13 }));
	assert.equal(walk.turned().at(-1)?.actionType, 'travel_to');
	const nether = await harness(t);
	await nether.run(step('travel_to', { x: 0, y: 30, z: 0, dimension: 'minecraft:the_nether', retrace: true }));
	assert.equal(nether.turned().length, 1);
	const free = await harness(t);
	await free.run(step('travel_to', { x: 100, y: 64, z: 100 }));
	await free.run(step('dig_to', { y: -55, heading: 'east' }));
	await free.run(normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'bucket', count: 2 }, why: 'kit' }));
	assert.equal(free.turned().length, 0, JSON.stringify(free.turned()));
});

test('one turn per life once its obtain has run, then the portal call goes as asked; no stock, an attack and the off arm go as asked', async t => {
	const h = await harness(t, { slow: true });
	for (let i = 0; i < 2; i++) await h.run(step('cast_obsidian', { frame: true, x: 12, y: -52, z: 20, axis: 'x' }));
	assert.equal(h.turned().length, 1);
	assert.equal(h.sent('cast_obsidian'), 1);
	// A new life (a death since) gets one more turn.
	const lives = [STOCK, STOCK, { ...STOCK, deaths: 1 }];
	const respawned = await harness(t, { slow: true, stock: () => lives.shift() ?? { ...STOCK, deaths: 1 } });
	for (let i = 0; i < 3; i++) await respawned.run(step('build', { structure: 'nether_portal' }));
	assert.equal(respawned.turned().length, 2);
	const worn = await harness(t, { stock: () => null });
	await worn.run(step('cast_obsidian', { frame: true, x: 12, y: -52, z: 20, axis: 'x' }));
	assert.equal(worn.sent('cast_obsidian'), 1);
	const attacked = await harness(t, { observation: sample({ threats: [{ uuid: 'z', type: 'minecraft:skeleton', distance: 9, targeting: true }] }) });
	await attacked.run(step('cast_obsidian', { frame: true, x: 12, y: -52, z: 20, axis: 'x' }));
	assert.equal(attacked.turned().length, 0);
	const off = await harness(t, { gate: 'off' });
	await off.run(step('cast_obsidian', { frame: true, x: 12, y: -52, z: 20, axis: 'x' }));
	assert.equal(off.sent('cast_obsidian'), 1);
	assert.equal(off.turned().length, 0);
});

test('an obtain that fails within a minute gives the turn back, up to 3 turned obtains per life', async t => {
	// Room ai-armour-gate g1: the turned obtain found no iron ore and would not climb at night at armour 0 (3 s), the
	// one turn was spent and the next cast went into the Nether bare.
	const h = await harness(t);
	for (let i = 0; i < 4; i++) await h.run(step('cast_obsidian', { frame: true, x: 12, y: -52, z: 20, axis: 'x' }));
	assert.equal(h.turned().length, 3);
	assert.equal(h.traces.filter(row => row.event === 'native_armour_gate_refunded').length, 3);
	assert.equal(h.sent('cast_obsidian'), 1);
});

test('the view owes a chestplate in the Overworld with a stone pickaxe, never with one worn or carried', async () => {
	const spec = immutableGoalSpec('beat the game', { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true });
	const r = { agentId: 'armour-view', currentGoal: 'beat the game', currentGoalSpec: spec, goalRevision: 1 };
	const it = (id, count = 1, slot) => ({ itemId: `minecraft:${id}`, count, ...(slot === undefined ? {} : { slot }) });
	const at = (ms, items, extra = {}) => ({ ...sample(), observedAtEpochMs: ms, inventory: { items }, ...extra });
	const view = async (items, extra) => { const v = new LiveTaskViews(); await v.observe(r, at(1000, items, extra)); return v.armourStock(r); };
	assert.deepEqual([(await view([it('iron_pickaxe'), it('iron_ingot', 6)]))?.item, (await view([it('stone_pickaxe')]))?.count], ['iron_chestplate', 1]);
	assert.equal(await view([it('wooden_pickaxe'), it('iron_ingot', 9)]), null);
	assert.equal(await view([it('iron_pickaxe'), it('iron_chestplate', 1, 'chest')]), null);
	assert.equal(await view([it('iron_pickaxe'), it('golden_chestplate', 1, 'chest')]), null);
	assert.equal(await view([it('iron_pickaxe'), it('iron_chestplate', 1, 7)]), null);
	assert.equal(await view([it('iron_pickaxe')], { world: { worldId: 'w', dimension: 'minecraft:the_nether' } }), null);
	assert.equal(await view([it('iron_pickaxe')], { player: { ...sample().player, health: 6 } }), null);
	const other = { ...r, currentGoal: 'get wood', currentGoalSpec: immutableGoalSpec('get wood', { type: 'inventory_contains', itemId: 'minecraft:oak_log', count: 1 }) };
	const v = new LiveTaskViews(); await v.observe(other, at(1000, [it('iron_pickaxe')]));
	assert.equal(v.armourStock(other), null);
});

test('the kit habit puts on the chestplate the turned obtain hands back', () => {
	const o = sample({ inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_pickaxe', slot: 0, count: 1 }, { itemId: 'minecraft:iron_chestplate', slot: 9, count: 1 }] } });
	assert.deepEqual(nextKitStep(o, { reserved: { ids: ['minecraft:iron_chestplate'], count: 1 } }), { kind: 'equip', sourceSlot: 9, targetSlot: 'chest', itemId: 'minecraft:iron_chestplate' });
});
