import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { immutableGoalSpec } from './fixtures/dynamic-main-fixture.mjs';

// stock.portalGate: room ai-stock-portal of 26 Nov, an on-arm bot saw "obtain cooked_porkchop count 9 ... before entering
// the portal (food 126/256)" and walked into the portal with 8 steaks. A walk into the portal while the route still asks
// for the stock now runs that obtain instead, twice per life at most.

const record = { agentId: 'stock-gate', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', goalRevision: 1 };
const PORTAL = { dimension: 'minecraft:overworld', x: 104, y: 64, z: 695, lit: true };
const sample = () => ({ ready: true, observedAtEpochMs: Date.now(), world: { worldId: 'w', dimension: 'minecraft:overworld' },
	player: { x: 110.5, y: 64, z: 695.5, health: 20, foodLevel: 20, skyOpen: true, onGround: true }, position: { x: 110.5, y: 64, z: 695.5 },
	inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_sword', slot: 0, count: 1 }, { itemId: 'minecraft:cooked_beef', slot: 1, count: 8 }] }, blocks: [], items: [], entities: [] });
const STOCK = { line: 'usual next step: obtain cooked_porkchop count 9 using a furnace, taking every pig in view, before entering the portal (food 126/256 points (minimum, not a cap); 2 in view)',
	item: 'cooked_porkchop', count: 9, portals: [PORTAL], worldId: 'w', deaths: 0 };
const walk = (x, z) => normalizeMinecraftToolCall('do_step', { verb: 'travel_to', target: { x, y: 64, z, tolerance: 1 }, why: 'use the lit portal' });

async function harness(t, { stock = () => STOCK, gate, observation = sample } = {}) {
	const before = process.env.MINEAGEN_PORTAL_STOCK_GATE;
	if (gate === undefined) delete process.env.MINEAGEN_PORTAL_STOCK_GATE; else process.env.MINEAGEN_PORTAL_STOCK_GATE = gate;
	const commands = [], traces = [];
	let runtime, n = 0;
	runtime = new NativeToolRuntime({ registry: { get: () => record }, portalStock: stock,
		trace: (event, fields) => traces.push({ event, ...fields }),
		bridge: { send: async (type, agentId, payload) => {
			commands.push({ type, payload });
			// Every body step ends at once: the walk to the portal arrives, every hunt step finds no way on.
			const arrives = payload.actionType === 'travel_to' && Number.isFinite(payload.arguments?.x);
			if (type === 'action_command') setTimeout(() => runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: 1,
				state: arrives ? 'SUCCEEDED' : 'FAILED', reasonCode: arrives ? 'ARRIVED' : 'NO_ROUTE', executionStarted: true, physicalAttempted: true }), 1);
		} },
		requestObservation: async () => ({ observation: observation(), eventSequence: ++n + 1 }) });
	const publish = () => runtime.updateObservation(record, observation(), { eventSequence: ++n + 1 });
	publish();
	t.after(async () => {
		await runtime.dispose(record.agentId, 'test_complete');
		if (before === undefined) delete process.env.MINEAGEN_PORTAL_STOCK_GATE; else process.env.MINEAGEN_PORTAL_STOCK_GATE = before;
	});
	let call = 0;
	const leases = [];
	const step = async (tool) => {
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: `t${++call}`, callId: `c${call}`, tool, extendLease: ms => leases.push(ms) }, record);
		if (result?.state === 'RUNNING' && result.actionId) {
			await new Promise(resolve => setImmediate(resolve));
			return runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: `s${call}`, callId: `s${call}`, tool: { kind: 'action_status', actionId: result.actionId } }, record);
		}
		return result;
	};
	const walksToPortal = () => commands.filter(row => row.type === 'action_command' && row.payload.actionType === 'travel_to'
		&& Math.abs(row.payload.arguments?.x - PORTAL.x) <= 3 && Math.abs(row.payload.arguments?.z - PORTAL.z) <= 3).length;
	return { step, commands, traces, walksToPortal, leases, publish };
}

test('first entry and the next life check worn gear and cooked supplies against the live underground inventory', async t => {
	const o = sample();
	o.player.y = o.position.y = 64;
	o.player.skyOpen = false;
	o.sighted = { portalFrames: [PORTAL] };
	o.inventory.items = [
		{ itemId: 'minecraft:diamond_helmet', slot: 'head', count: 1 },
		{ itemId: 'minecraft:netherite_leggings', slot: 'legs', count: 1 },
		{ itemId: 'minecraft:iron_boots', slot: 'feet', count: 1 },
		{ itemId: 'minecraft:shield', slot: 'offhand', count: 1 },
		{ itemId: 'minecraft:iron_chestplate', slot: 11, count: 1 },
		{ itemId: 'minecraft:beef', slot: 12, count: 32 },
	];
	const h = await harness(t, { stock: () => null, observation: () => structuredClone(o) });
	const crossing = walk(104.5, 695.5);
	const gear = await h.step(crossing);
	assert.equal(h.walksToPortal(), 0);
	assert.equal(gear.stockedTool.actionType, 'equip_item');
	assert.equal(gear.stockedTool.arguments.targetSlot, 'chest');
	o.inventory.items[4].slot = 'chest';
	const food = await h.step(crossing);
	assert.equal(h.walksToPortal(), 0);
	assert.equal(food.stockedTool.arguments.item, 'cooked_beef');
	assert.equal(food.stockedTool.arguments.count, 9);
	o.inventory.items[5] = { itemId: 'minecraft:cooked_beef', slot: 12, count: 9 };
	await h.step(crossing);
	assert.equal(h.walksToPortal(), 1);
	o.status = 'PLAYER_DEAD';
	h.publish();
	delete o.status;
	o.inventory.items = o.inventory.items.filter(item => item.slot !== 'offhand');
	h.publish();
	const rekit = await h.step(crossing);
	assert.equal(h.walksToPortal(), 1);
	assert.equal(rekit.stockedTool.arguments.item, 'minecraft:shield');
});

test('two searches that find no food release the portal until the next life', async t => {
	const o = sample();
	o.sighted = { portalFrames: [PORTAL] };
	o.inventory.items = Object.entries({ head: 'iron_helmet', chest: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots', offhand: 'shield' })
		.map(([slot, id]) => ({ itemId: `minecraft:${id}`, slot, count: 1 }));
	const h = await harness(t, { stock: () => null, observation: () => structuredClone(o) });
	const crossing = walk(104.5, 695.5);
	for (const item of ['cooked_beef', 'cooked_porkchop']) {
		const search = await h.step(crossing);
		assert.equal(search.stockedTool.arguments.item, item);
		assert.equal(search.reasonCode, 'NO_SOURCE');
	}
	await h.step(crossing);
	assert.equal(h.walksToPortal(), 1);
	o.status = 'PLAYER_DEAD';
	h.publish();
	delete o.status;
	h.publish();
	const search = await h.step(crossing);
	assert.equal(search.stockedTool.arguments.item, 'cooked_beef');
	assert.equal(h.walksToPortal(), 1);
});

test('a walk into the lit portal below the minimum runs the stock obtain instead, and says so', async t => {
	const h = await harness(t);
	const result = await h.step(walk(104.5, 695.5));
	assert.equal(h.walksToPortal(), 0, JSON.stringify(h.commands.map(row => row.payload?.actionType)));
	assert.match(result.stockedFirst, /^Stock first at the portal: obtain cooked_porkchop count 9 /);
	assert.equal(h.traces.filter(row => row.event === 'native_portal_stock_turned').length, 1);
	assert.ok(h.commands.some(row => row.type === 'action_command'), 'the obtain sent its own body steps');
	// The planner's lease was sized for the walk; the room's turned obtains were cancelled 20 s in until it was extended.
	assert.ok(h.leases.some(ms => ms >= 360_000), JSON.stringify(h.leases));
	// The food hand-back reads the obtain that ran; the model is not shown it.
	assert.equal(result.stockedTool?.kind, 'obtain');
	assert.doesNotMatch(JSON.stringify(result), /stockedTool/);
});

test('the gate turns two walks per life, then lets the bot go in short', async t => {
	const h = await harness(t);
	const first = await h.step(walk(104.5, 695.5));
	const second = await h.step(walk(105, 696));
	assert.equal(h.walksToPortal(), 0);
	// The second walk comes with the body idle since the first obtain (stoodStillMs): the hand-back marker survives it.
	assert.equal(second.stoodStillMs >= 0, true, JSON.stringify(Object.keys(second)));
	for (const result of [first, second]) assert.equal(result.stockedTool?.kind, 'obtain');
	await h.step(walk(104.5, 695.5));
	assert.equal(h.walksToPortal(), 1);
	assert.equal(h.traces.filter(row => row.event === 'native_portal_stock_turned').length, 2);
});

test('a walk elsewhere, a met minimum and the off arm all walk as asked', async t => {
	const away = await harness(t);
	await away.step(walk(130, 720));
	assert.equal(away.traces.some(row => row.event === 'native_portal_stock_turned'), false);
	const met = await harness(t, { stock: () => null });
	await met.step(walk(104.5, 695.5));
	assert.equal(met.walksToPortal(), 1);
	const off = await harness(t, { gate: 'off' });
	await off.step(walk(104.5, 695.5));
	assert.equal(off.walksToPortal(), 1);
	assert.equal(off.traces.some(row => row.event === 'native_portal_stock_turned'), false);
});

test('the floor\'s look-for step at the portal gives the gate the meat held, and a short gate hunt lets the next walk in', async () => {
	// Room ai-stock-portal-25, 27 Nov: on-arm bots walked in at 158 and 237 of 256 under "look for cows/pigs/sheep/chickens
	// nearby", a step that named no item for the gate; and a gate hunt that came back short did not release the step.
	const spec = immutableGoalSpec('beat the game', { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true });
	const r = { agentId: 'stock-view', currentGoal: 'beat the game', currentGoalSpec: spec, goalRevision: 1 };
	const views = new LiveTaskViews();
	const o = { ...sample(), observedAtEpochMs: 1000, entities: [],
		inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:cooked_beef', count: 11 }, { itemId: 'minecraft:oak_log', count: 15 }] },
		sighted: { portalFrames: [{ x: 104, y: 64, z: 695, axis: 'x', obsidian: 10, needed: 10, lit: true }] } };
	await views.observe(r, o);
	assert.match(views.continuity(r).route, /^usual next step: look for .* before entering the portal \(food 174\/256/);
	const stock = views.portalStock(r);
	assert.deepEqual([stock?.item, stock?.count, stock?.portals.length], ['cooked_beef', 17, 1]);
	assert.equal(views.noteFoodHandback(r, { kind: 'obtain', arguments: { item: 'cooked_beef', count: 17 } }, { state: 'TIMED_OUT', reasonCode: 'OBTAIN_TIMEOUT' }), true);
	assert.equal(views.portalStock(r), null);
});

test('the re-kit after a death holds the walk back for food, not for the rest of the kit', async () => {
	// Review of PR 287: the re-kit asks for the food minimum "before going back", which the gate did not read, so a
	// respawned bot could walk into the Nether short.
	const spec = immutableGoalSpec('beat the game', { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true });
	const r = { agentId: 'stock-rekit', currentGoal: 'beat the game', currentGoalSpec: spec, goalRevision: 1 };
	const it = (id, count = 1) => ({ itemId: `minecraft:${id}`, count });
	const at = (ms, items, entities = []) => ({ ...sample(), observedAtEpochMs: ms, entities, inventory: { items },
		sighted: { portalFrames: [{ x: 104, y: 64, z: 695, axis: 'x', obsidian: 10, needed: 10, lit: true }] } });
	const kit = [it('iron_pickaxe'), it('shield'), it('bucket', 2), it('flint_and_steel'), it('oak_log', 15), it('iron_sword')];
	const views = new LiveTaskViews();
	await views.observe(r, at(1000, [...kit, it('cooked_beef', 20)]));
	await views.observe(r, { ...at(2000, []), player: { dead: true, health: 0 } });
	await views.observe(r, at(3000, [...kit, it('cooked_beef', 2)], [{ type: 'minecraft:cow', distance: 8, alive: true }]));
	assert.match(views.continuity(r).route, /^usual next step: obtain cooked_beef count 17 .*before going back/);
	assert.deepEqual([views.portalStock(r)?.item, views.portalStock(r)?.count], ['cooked_beef', 17]);
	await views.observe(r, at(4000, [...kit, it('cooked_beef', 2)]));
	assert.match(views.continuity(r).route, /^usual next step: look for .* before going back/);
	assert.equal(views.portalStock(r)?.item, 'cooked_beef');
	// A re-kit step that is not food walks on: the gate runs only the stock obtain.
	await views.observe(r, at(5000, [it('oak_log', 15), it('cooked_beef', 20)]));
	assert.doesNotMatch(views.continuity(r).route, /obtain cooked_/);
	assert.equal(views.portalStock(r), null);
});
