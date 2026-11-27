import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { immutableGoalSpec } from './fixtures/dynamic-main-fixture.mjs';

// stock.descentGate: in 6 of 7 fresh games of 27 Nov the route said "obtain cooked meat ... before going down" on the
// surface and the model went down anyway (one game with its kit held at 63 of 320 points: obtain iron_pickaxe; another
// for the kit's iron at 3 points: obtain iron_ingot), built the portal underground where stock.portalGate is off, and
// entered the Nether with 1 to 8 food. A call that goes down now runs the food obtain first, twice per life at most.

const record = { agentId: 'descent-gate', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', goalRevision: 1 };
const sample = (extra = {}) => ({ ready: true, observedAtEpochMs: Date.now(), world: { worldId: 'w', dimension: 'minecraft:overworld' },
	player: { x: 10.5, y: 64, z: 20.5, health: 20, foodLevel: 20, skyOpen: true, onGround: true }, position: { x: 10.5, y: 64, z: 20.5 },
	inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1 }, { itemId: 'minecraft:cooked_beef', slot: 1, count: 2 }] },
	blocks: [], items: [], entities: [], ...extra });
const STOCK = { line: 'usual next step: obtain cooked_beef count 26 using a furnace, taking every cow in view, before going down (food 26/320 points (minimum, not a cap); 4 in view)',
	item: 'cooked_beef', count: 26, y: 64, worldId: 'w', deaths: 0 };
const step = (verb, target) => normalizeMinecraftToolCall('do_step', { verb, target, why: 'go down for lava' });

async function harness(t, { stock = () => STOCK, gate, observation = sample() } = {}) {
	const before = process.env.MINEAGEN_DESCENT_STOCK_GATE;
	if (gate === undefined) delete process.env.MINEAGEN_DESCENT_STOCK_GATE; else process.env.MINEAGEN_DESCENT_STOCK_GATE = gate;
	const commands = [], traces = [];
	let runtime, n = 0;
	runtime = new NativeToolRuntime({ registry: { get: () => record }, descentStock: stock,
		trace: (event, fields) => traces.push({ event, ...fields }),
		bridge: { send: async (type, agentId, payload) => {
			commands.push({ type, payload });
			// Every body step ends at once with no way on, so a hunt hands back quickly.
			if (type === 'action_command') setTimeout(() => runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: 1,
				state: 'FAILED', reasonCode: 'NO_ROUTE', executionStarted: true, physicalAttempted: true }), 1);
		} },
		requestObservation: async () => ({ observation, eventSequence: ++n + 1 }) });
	runtime.updateObservation(record, observation, { eventSequence: 1 });
	t.after(async () => {
		await runtime.dispose(record.agentId, 'test_complete');
		if (before === undefined) delete process.env.MINEAGEN_DESCENT_STOCK_GATE; else process.env.MINEAGEN_DESCENT_STOCK_GATE = before;
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
	const turned = () => traces.filter(row => row.event === 'native_descent_stock_turned');
	const digsDown = () => commands.filter(row => row.type === 'action_command' && row.payload.actionType === 'dig_to' && row.payload.arguments?.y < 48).length;
	return { run, commands, traces, turned, digsDown, leases };
}

test('a dig down from the surface below the minimum runs the food obtain instead, and says so', async t => {
	const h = await harness(t);
	const result = await h.run(step('dig_to', { y: -55, heading: 'east' }));
	assert.equal(h.digsDown(), 0);
	assert.match(result.stockedFirst, /^Stock food first on the surface: obtain cooked_beef count 26 /);
	assert.equal(h.turned().length, 1);
	assert.ok(h.leases.some(ms => ms >= 360_000), JSON.stringify(h.leases));
	// The food hand-back reads the obtain that ran; the model is not shown it.
	assert.equal(result.stockedTool?.kind, 'obtain');
	assert.equal(result.stockedTool?.arguments?.timeoutMs, 360_000);
	assert.doesNotMatch(JSON.stringify(result), /stockedTool/);
});

test('the obtains and finds that mine underground are turned; surface crafts and level tunnels are not', async t => {
	const h = await harness(t);
	await h.run(normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'iron_ingot', count: 11 }, why: 'kit iron' }));
	assert.equal(h.turned().at(-1)?.kind, 'obtain');
	const other = await harness(t);
	await other.run(normalizeMinecraftToolCall('do_step', { verb: 'find', target: { block: 'lava' }, why: 'lava for the portal' }));
	assert.equal(other.turned().at(-1)?.kind, 'find');
	const free = await harness(t);
	await free.run(normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'stone_sword' }, why: 'weapon' }));
	await free.run(step('dig_to', { pattern: 'tunnel', heading: 'north', maxBlocks: 10 }));
	await free.run(step('dig_to', { y: 72 }));
	await free.run(step('travel_to', { x: 0, y: 30, z: 0, dimension: 'minecraft:the_nether', retrace: true }));
	await free.run(step('travel_to', { x: 40, y: 66, z: 12 }));
	assert.equal(free.turned().length, 0, JSON.stringify(free.turned()));
	// A walk to a cave floor below y 48 is going down.
	await free.run(step('travel_to', { x: 30, y: 12, z: 40 }));
	assert.equal(free.turned().at(-1)?.kind, 'travel_to');
});

test('two turns per life, then the bot goes down short; a met minimum, an attack and the off arm go down as asked', async t => {
	const h = await harness(t);
	for (let i = 0; i < 3; i++) await h.run(step('dig_to', { y: -55, heading: 'east' }));
	assert.equal(h.turned().length, 2);
	assert.equal(h.digsDown(), 1);
	const met = await harness(t, { stock: () => null });
	await met.run(step('dig_to', { y: -55 }));
	assert.equal(met.digsDown(), 1);
	const attacked = await harness(t, { observation: sample({ threats: [{ uuid: 'z', type: 'minecraft:zombie', distance: 3, targeting: true }] }) });
	await attacked.run(step('dig_to', { y: -55 }));
	assert.equal(attacked.turned().length, 0);
	const off = await harness(t, { gate: 'off' });
	await off.run(step('dig_to', { y: -55 }));
	assert.equal(off.digsDown(), 1);
	assert.equal(off.turned().length, 0);
});

test('the view asks only for the food row on the surface with a stone pickaxe, and lets go below ground or after a short hunt', async () => {
	const spec = immutableGoalSpec('beat the game', { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true });
	const r = { agentId: 'descent-view', currentGoal: 'beat the game', currentGoalSpec: spec, goalRevision: 1 };
	const it = (id, count = 1) => ({ itemId: `minecraft:${id}`, count });
	const cow = { type: 'minecraft:cow', distance: 8, alive: true };
	const at = (ms, items, extra = {}) => ({ ...sample(), observedAtEpochMs: ms, entities: [], inventory: { items }, ...extra });
	const views = new LiveTaskViews();
	// Wooden pickaxe only: the first stone tools are never held up.
	await views.observe(r, at(1000, [it('wooden_pickaxe'), it('cooked_beef', 2)], { entities: [cow] }));
	assert.match(views.continuity(r).route, /before going down/);
	assert.equal(views.descentStock(r), null);
	await views.observe(r, at(2000, [it('stone_pickaxe'), it('cooked_beef', 2)], { entities: [cow] }));
	assert.match(views.continuity(r).route, /^usual next step: obtain cooked_beef count \d+ .*before going down/);
	const stock = views.descentStock(r);
	assert.equal(stock?.item, 'cooked_beef');
	assert.ok(stock.count > 2, JSON.stringify(stock));
	// No animal in view: the look-for step searches for the meat held, counted to the 320 floor.
	await views.observe(r, at(3000, [it('stone_pickaxe'), it('cooked_beef', 2)]));
	assert.match(views.continuity(r).route, /^usual next step: look for .* before going down/);
	assert.equal(views.descentStock(r)?.item, 'cooked_beef');
	// A hunt that came back short with nothing in view releases the row, and the gate with it.
	assert.equal(views.noteFoodHandback(r, { kind: 'obtain', arguments: { item: 'cooked_beef', count: stock.count } }, { state: 'TIMED_OUT', reasonCode: 'OBTAIN_TIMEOUT' }), true);
	await views.observe(r, at(4000, [it('stone_pickaxe'), it('cooked_beef', 2)]));
	assert.equal(views.descentStock(r), null);
	// Down a mine the route lets go: no climb back for food.
	const below = new LiveTaskViews();
	const mine = { player: { x: 10.5, y: 20, z: 20.5, health: 20, foodLevel: 20, skyOpen: false, onGround: true }, position: { x: 10.5, y: 20, z: 20.5 } };
	await below.observe(r, at(1000, [it('stone_pickaxe'), it('cooked_beef', 2)], { entities: [cow], ...mine }));
	assert.equal(below.descentStock(r), null);
	// The minimum met: the wood row's "before going down" is not the gate's.
	const fed = new LiveTaskViews();
	await fed.observe(r, at(1000, [it('stone_pickaxe'), it('cooked_beef', 40)], { entities: [cow] }));
	assert.doesNotMatch(fed.continuity(r).route ?? '', /obtain cooked_/);
	assert.equal(fed.descentStock(r), null);
});
