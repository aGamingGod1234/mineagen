import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverable, STAND_OFF } from '../src/recover-items.mjs';
import { runRecoverItems } from './helpers/checked-body.mjs';
import { respawnLead, dropLoss, killerMob, RECOVER_FIRST_MOVE } from '../src/respawn-recovery.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { RecoveryProgressStore } from '../src/recovery-progress-wrap.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';

const OW = 'minecraft:overworld', NETHER = 'minecraft:the_nether';
const T0 = 1_800_000_000_000;
const KIT = [
	{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:iron_sword', count: 1 }, { itemId: 'minecraft:shield', count: 1 },
	{ itemId: 'minecraft:iron_chestplate', count: 1 }, { itemId: 'minecraft:cooked_beef', count: 8 }, { itemId: 'minecraft:cobblestone', count: 32 },
];
const SPOT = { x: 120.5, y: 64, z: -40.5 };

/** A small world: the body, its inventory, the stacks on the ground and any hostiles. act moves it as the server would. */
function world({ death = {}, lost = KIT, at = { x: 0.5, y: 64, z: 0.5 }, dimension = OW, drops = lost, guards = [], travel = null } = {}) {
	const w = { at: { ...at }, dimension, slots: [], ground: drops.map((row, i) => ({ stableId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, itemId: row.itemId, count: row.count, x: SPOT.x + (i % 3) - 1, y: SPOT.y, z: SPOT.z + Math.floor(i / 3) })),
		guards, calls: [], health: 20 };
	const deathRecord = { cause: 'Probe fell from a high place', dimensionId: OW, ...SPOT, diedAtEpochMs: T0, ...death };
	w.observe = async () => ({
		world: { dimension: w.dimension }, position: { ...w.at }, player: { ...w.at, health: w.health, yaw: 0, threats: w.guards.map((g, i) => ({ stableId: `mob-${i}`, alive: true, hostile: true, ...g })) },
		inventory: { selectedSlot: 0, items: w.slots.map((item) => ({ ...item })) },
		items: w.ground.filter((row) => Math.hypot(row.x - w.at.x, row.z - w.at.z) <= 24).map((row) => ({ ...row })),
		recovery: { lastDeath: deathRecord, lastLostInventory: lost.filter((row) => !w.slots.some((s) => s.itemId === row.itemId)) },
	});
	w.act = async (type, args) => {
		w.calls.push({ type, args });
		if (type === 'travel_to') {
			if (travel) { const r = travel(w, args); if (r) return r; }
			w.at = { x: args.x, y: args.y ?? w.at.y, z: args.z };
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
		}
		if (type === 'pick_up_item') {
			const row = w.ground.find((g) => g.stableId === args.targetSelector);
			if (!row) return { state: 'FAILED', reasonCode: 'TARGET_NOT_FOUND' };
			w.ground = w.ground.filter((g) => g !== row);
			// Walking over the stack picks up its neighbours too, as in the game.
			const taken = [row, ...w.ground.filter((g) => Math.hypot(g.x - row.x, g.z - row.z) < 1.1)];
			w.ground = w.ground.filter((g) => !taken.includes(g));
			for (const t of taken) w.slots.push({ itemId: t.itemId, count: t.count, slot: w.slots.length + 1 });
			w.at = { x: row.x, y: row.y, z: row.z };
			return { state: 'SUCCEEDED', reasonCode: 'PICKED_UP' };
		}
		if (type === 'equip_item') {
			const item = w.slots.find((s) => s.slot === args.sourceSlot);
			assert.equal(item.itemId, args.expectedItemId);
			item.slot = args.targetSlot;
			return { state: 'SUCCEEDED', reasonCode: 'EQUIPPED' };
		}
		if (type === 'select_tool') {
			const item = w.slots.find((s) => s.slot === args.sourceSlot);
			item.slot = args.hotbarSlot; item.hotbar = true;
			return { state: 'SUCCEEDED', reasonCode: 'SELECTED' };
		}
		throw new Error(`unexpected ${type}`);
	};
	w.body = { observe: w.observe, act: w.act, stopped: () => false, interrupted: () => false, note: () => {} };
	return w;
}

test('a fall death: walk back, pick up every stack, wear the shield and chestplate', async () => {
	const w = world();
	const result = await runRecoverItems({}, w.body);
	assert.equal(result.state, 'SUCCEEDED');
	assert.equal(result.reasonCode, 'RECOVERED');
	assert.deepEqual(result.recovered, { stacks: 6, of: 6, units: 44, ofUnits: 44 });
	assert.deepEqual(w.calls[0], { type: 'travel_to', args: { x: SPOT.x, y: SPOT.y, z: SPOT.z, tolerance: 2, timeoutMs: 180_000 } });
	assert.ok(w.slots.some((s) => s.itemId === 'minecraft:shield' && s.slot === 'offhand'));
	assert.ok(w.slots.some((s) => s.itemId === 'minecraft:iron_chestplate' && s.slot === 'chest'));
	assert.match(result.message, /wore shield \(offhand\), wore iron_chestplate \(chest\)/);
});

test('lava, the void, another dimension and spent drops are skipped without moving', async () => {
	for (const [death, code] of [[{ cause: 'Probe tried to swim in lava', damageType: 'minecraft:lava' }, 'DIED_IN_LAVA'], [{ cause: 'Probe burned', damageType: 'minecraft:lava' }, 'DIED_IN_LAVA'],
		[{ cause: 'Probe fell out of the world', damageType: 'minecraft:out_of_world' }, 'DROPS_DESTROYED'], [{ dimensionId: NETHER }, 'OTHER_DIMENSION']]) {
		const w = world({ death });
		const result = await runRecoverItems({}, w.body);
		assert.equal(result.reasonCode, code, JSON.stringify(death));
		assert.equal(result.state, 'FAILED');
		assert.equal(w.calls.length, 0);
	}
	const w = world();
	const observe = w.observe;
	w.body.observe = async () => { const o = await observe(); Object.defineProperty(o.recovery, 'dropTicking', { value: { tickedSeconds: 300 } }); return o; };
	assert.equal((await runRecoverItems({}, w.body)).reasonCode, 'DROPS_EXPIRED');
	assert.equal(recoverable({ recovery: {} }).reasonCode, 'NO_DEATH_RECORD');
});

test('a mob kill stops short and looks; a crowd at the drops is left to the model', async () => {
	const guards = [{ type: 'minecraft:zombie' }, { type: 'minecraft:zombie' }, { type: 'minecraft:skeleton' }].map((g, i) => ({ ...g, x: SPOT.x + i, y: SPOT.y, z: SPOT.z + 2 }));
	const w = world({ death: { cause: 'Probe was slain by Zombie', attacker: 'minecraft:zombie' }, guards });
	const result = await runRecoverItems({}, w.body);
	assert.equal(result.reasonCode, 'DROPS_GUARDED');
	assert.equal(w.calls.length, 1, 'only the approach leg');
	const stop = w.calls[0].args;
	assert.equal(stop.y, undefined);
	assert.ok(Math.abs(Math.hypot(stop.x - SPOT.x, stop.z - SPOT.z) - STAND_OFF) < 0.5, `stopped ${STAND_OFF} blocks short: ${JSON.stringify(stop)}`);
	assert.match(result.message, /3 hostiles \(zombie x2, skeleton\)/);
	// One mob is a fight, not a crowd: the job goes on in.
	const one = world({ death: { cause: 'Probe was shot by Skeleton' }, guards: guards.slice(0, 1) });
	const went = await runRecoverItems({}, one.body);
	assert.equal(went.reasonCode, 'RECOVERED');
	assert.equal(one.calls.filter((c) => c.type === 'travel_to').length, 2);
});

test('danger on the way back hands the body to the model with what is still missing', async () => {
	const w = world({ travel: () => ({ state: 'INTERRUPTED', reasonCode: 'DANGER', running: { actionId: 'a1' } }) });
	const result = await runRecoverItems({}, w.body);
	assert.equal(result.state, 'INTERRUPTED');
	assert.equal(result.running.actionId, 'a1');
	assert.match(result.message, /call recover_items again/);
	assert.equal(result.missing.length, 6);
});

test('drops that are gone by arrival end as DROPS_NOT_FOUND; some picked up is RECOVERED_PART', async () => {
	const gone = world({ drops: [] });
	assert.equal((await runRecoverItems({}, gone.body)).reasonCode, 'DROPS_NOT_FOUND');
	const part = world({ drops: KIT.slice(0, 2) });
	const result = await runRecoverItems({}, part.body);
	assert.equal(result.reasonCode, 'RECOVERED_PART');
	assert.match(result.message, /still missing iron_chestplate, shield, cooked_beef x8, cobblestone x32/);
});

test('damage type and killer decide the drop loss and the careful approach', () => {
	assert.equal(dropLoss({ cause: 'Probe burned to death', damageType: 'minecraft:lava' }), 'lava');
	assert.equal(dropLoss({ cause: 'Probe died', damageType: 'minecraft:out_of_world' }), 'void');
	assert.equal(killerMob({ cause: 'Probe was slain by Zombie' }), 'minecraft:zombie');
	assert.equal(killerMob({ cause: 'Probe was shot by Skeleton', attacker: 'minecraft:skeleton' }), 'minecraft:skeleton');
	assert.equal(killerMob({ cause: 'Probe was blown up by Creeper' }), 'minecraft:creeper');
	assert.equal(killerMob({ cause: 'Probe fell from a high place' }), null);
	// The coordinator's death record keeps the receipt's damage type and killer (PR #58's fields).
	const store = new RecoveryProgressStore();
	store.remember('a', 1, { ready: true, observedAtEpochMs: T0 - 1000, world: { worldId: 'w', dimension: OW }, position: SPOT, inventory: { items: KIT.map((item, slot) => ({ ...item, slot })) } });
	store.remember('a', 1, { ready: false, observedAtEpochMs: T0, death: { cause: 'Probe was slain by Zombie', dimensionId: OW, ...SPOT, diedAtEpochMs: T0, damageType: 'minecraft:mob_attack', attacker: 'minecraft:zombie' } });
	const death = store.snapshot('a', { ready: true, world: { worldId: 'w', dimension: OW }, position: { x: 0, y: 64, z: 0 } }).lastDeath;
	assert.equal(death.damageType, 'minecraft:mob_attack');
	assert.equal(death.attacker, 'minecraft:zombie');
});

test('the respawn wake names recover_items as the first move only when it can help', () => {
	const recovery = { lastDeath: { cause: 'Probe was slain by Zombie', dimensionId: OW, ...SPOT, diedAtEpochMs: T0 }, lastLostInventory: KIT };
	const here = { ready: true, observedAtEpochMs: T0 + 5_000, world: { dimension: OW }, position: { x: 0.5, y: 64, z: 0.5 } };
	const lead = respawnLead(recovery, here);
	assert.ok(lead.includes(RECOVER_FIRST_MOVE));
	assert.match(lead, /stops 16 blocks short and looks first/);
	assert.ok(!respawnLead({ ...recovery, lastDeath: { ...recovery.lastDeath, cause: 'Probe fell from a high place' } }, here).includes('stops 16 blocks short'));
	assert.ok(!respawnLead({ ...recovery, lastDeath: { ...recovery.lastDeath, damageType: 'minecraft:lava' } }, here).includes('recover_items'));
	assert.ok(!respawnLead({ ...recovery, lastDeath: { ...recovery.lastDeath, dimensionId: NETHER } }, here).includes('recover_items'));
});

test('do_step recover_items normalizes to the foreground job and takes only timeoutMs', () => {
	const tool = normalizeMinecraftToolCall('do_step', { verb: 'recover_items', target: {}, why: 'get my kit back' });
	assert.equal(tool.kind, 'recover_items');
	assert.deepEqual(tool.arguments, {});
	assert.equal(tool.step.verb, 'recover_items');
	assert.deepEqual(normalizeMinecraftToolCall('do_step', { verb: 'recover_items', target: { timeoutMs: 120_000 }, why: 'x' }).arguments, { timeoutMs: 120_000 });
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'recover_items', target: { x: 1 }, why: 'x' }));
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'recover_items', target: { timeoutMs: 1 }, why: 'x' }));
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'recover_items', target: {}, why: 'x', keepGoing: true }));
});

test('production runtime: do_step recover_items reads the remembered death and drives body actions', async () => {
	const record = { agentId: 'probe', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' };
	const w = world();
	let seq = 0, runtime;
	const sample = (extra = {}) => ({ ready: true, observedAtEpochMs: T0 + 10_000 + seq * 50, world: { worldId: 'w', dimension: w.dimension }, position: { ...w.at },
		player: { ...w.at, health: 20, foodLevel: 20, yaw: 0 }, inventory: { selectedSlot: 0, items: w.slots.map((s) => ({ ...s })) },
		items: w.ground.map((g) => ({ ...g })), entities: w.ground.map((g) => ({ ...g, type: 'minecraft:item' })), ...extra });
	const commands = [];
	runtime = new NativeToolRuntime({ registry: { get: () => record },
		requestObservation: async () => ({ eventSequence: ++seq, observation: sample() }),
		bridge: { send: async (type, _id, payload) => {
			if (type !== 'action_command') return;
			commands.push(payload.actionType);
			const result = await w.act(payload.actionType, payload.arguments);
			// The server sends a fresh sample after each action, as the mod does.
			queueMicrotask(() => {
				runtime.updateObservation(record, sample(), { eventSequence: ++seq });
				runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: 1, executionStarted: true, ...result });
			});
		} } });
	// The life before: full kit at the death spot; then the death receipt; then the respawned body, empty-handed.
	w.at = { ...SPOT };
	w.slots = KIT.map((item, slot) => ({ ...item, slot }));
	const ground = w.ground; w.ground = [];
	runtime.updateObservation(record, sample(), { eventSequence: ++seq });
	w.slots = [];
	runtime.updateObservation(record, { death: { cause: 'Probe fell from a high place', dimensionId: OW, ...SPOT, diedAtEpochMs: T0 } }, { eventSequence: seq, force: true });
	w.at = { x: 0.5, y: 64, z: 0.5 }; w.ground = ground;
	runtime.updateObservation(record, sample(), { eventSequence: ++seq });
	const leases = [];
	const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 't', callId: 'c', extendLease: (ms) => leases.push(ms),
		tool: normalizeMinecraftToolCall('do_step', { verb: 'recover_items', target: {}, why: 'Go back for the kit.' }) }, record);
	assert.equal(result.reasonCode, 'RECOVERED', JSON.stringify(result).slice(0, 600));
	// The planner's default lease (about 2 min) would cancel the walk back; the job extends it to its own budget.
	assert.ok(leases.length >= 1 && leases[0] > 240_000, JSON.stringify(leases));
	assert.equal(commands[0], 'travel_to');
	assert.ok(commands.includes('pick_up_item') && commands.includes('equip_item'));
	assert.ok(w.slots.some((s) => s.itemId === 'minecraft:shield' && s.slot === 'offhand'));
});

test('drops deep underground with no walked way and no pickaxe: make a stone pickaxe, then dig back down to them', async () => {
	const deep = { x: 120.5, y: 14, z: -40.5 };
	const w = world({ death: deep });
	for (const row of w.ground) row.y = deep.y;
	SPOT.y = deep.y;
	try {
		const order = [];
		w.body.obtain = async (item, count, timeoutMs) => {
			order.push(['obtain', item, count]);
			assert.ok(timeoutMs >= 60_000);
			w.slots.push({ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 });
			return { state: 'SUCCEEDED', reasonCode: 'OBTAINED' };
		};
		const act = w.body.act;
		w.body.act = async (type, args) => { order.push([type]); return act(type, args); };
		const budgets = [];
		w.body.budget = (ms) => budgets.push(ms);
		const result = await runRecoverItems({}, w.body);
		assert.equal(result.reasonCode, 'RECOVERED');
		assert.deepEqual(order.slice(0, 2), [['obtain', 'minecraft:stone_pickaxe', 1], ['travel_to']]);
		assert.equal(budgets.length, 2, 'the walk budget, then the walk plus the pickaxe');
		assert.ok(budgets[1] > budgets[0] + 170_000);
		assert.equal(w.calls[0].args.y, deep.y);
	} finally { SPOT.y = 64; }
});

test('no pickaxe made for an underground walk back: hand back NO_PICKAXE without walking', async () => {
	const w = world({ death: { y: 14 } });
	w.body.obtain = async () => ({ state: 'FAILED', reasonCode: 'NO_SOURCE', message: 'no tree in reach' });
	const result = await runRecoverItems({}, w.body);
	assert.equal(result.reasonCode, 'NO_PICKAXE');
	assert.equal(w.calls.length, 0);
	assert.match(result.message, /50 blocks down/);
	assert.match(result.message, /drops: .*call recover_items again/, 'a later pickaxe still leads back');
});

test('a walked way down or a held pickaxe skips the pickaxe step; drops at the same level never need one', async () => {
	for (const setup of [(w) => { const o = w.observe; w.observe = async () => ({ ...(await o()), routeMemory: { connected: true } }); w.body.observe = w.observe; },
		(w) => { w.slots.push({ itemId: 'minecraft:wooden_pickaxe', count: 1, slot: 0 }); }]) {
		const w = world({ death: { y: 14 } });
		setup(w);
		let asked = 0;
		w.body.obtain = async () => { asked += 1; return { state: 'SUCCEEDED' }; };
		await runRecoverItems({}, w.body);
		assert.equal(asked, 0);
	}
	const flatWorld = world();
	let asked = 0;
	flatWorld.body.obtain = async () => { asked += 1; return { state: 'SUCCEEDED' }; };
	await runRecoverItems({}, flatWorld.body);
	assert.equal(asked, 0);
});

test('a long walk back repeats travel legs while they close distance, and stops repeating when one does not', async () => {
	const far = world({ at: { x: -1500.5, y: 64, z: 0.5 }, travel: (w, args) => {
		if (Math.hypot(args.x - w.at.x, args.z - w.at.z) > 400) { w.at = { ...w.at, x: w.at.x + 400 }; return { state: 'TIMED_OUT', reasonCode: 'TRAVEL_TIMEOUT' }; }
		return null;
	} });
	const result = await runRecoverItems({}, far.body);
	assert.equal(result.reasonCode, 'RECOVERED');
	assert.ok(far.calls.filter((c) => c.type === 'travel_to').length >= 4);
	const stuck = world({ at: { x: -300.5, y: 64, z: 0.5 }, travel: () => ({ state: 'FAILED', reasonCode: 'NO_ROUTE' }) });
	const r2 = await runRecoverItems({}, stuck.body);
	assert.equal(r2.reasonCode, 'NO_ROUTE');
	assert.equal(stuck.calls.filter((c) => c.type === 'travel_to').length, 1);
});

test('a live respawn wake (an observation trigger with a new context) carries the drops lead and recover_items', async () => {
	const { buildNativeEventInput } = await import('../src/dynamic-main.mjs');
	const record = { agentId: 'a', goalRevision: 1, provider: 'codex', model: 'fixture' };
	const recovery = { lastDeath: { cause: 'Probe died', dimensionId: OW, ...SPOT, diedAtEpochMs: T0, damageType: 'minecraft:generic', respawnedAt: { dimension: OW, x: 0.5, y: 64, z: 0.5 } }, lastLostInventory: KIT };
	const observation = { ready: true, observedAtEpochMs: T0 + 5_000, world: { dimension: OW }, position: { x: 0.5, y: 64, z: 0.5 }, recovery };
	const head = (options) => { const input = buildNativeEventInput(record, { event: 'observation', trigger: 'observation', observation, ...options }); return input.slice(0, input.indexOf('\n')); };
	assert.ok(head({ newContext: true }).includes(RECOVER_FIRST_MOVE));
	assert.ok(!head({ newContext: false }).includes('recover_items'), 'an ordinary wake does not repeat it');
	const away = buildNativeEventInput(record, { event: 'observation', trigger: 'observation', newContext: true, observation: { ...observation, position: { x: 30.5, y: 40, z: 0.5 } } });
	assert.ok(!away.slice(0, away.indexOf('\n')).includes('recover_items'), 'a later new context, already on the way back, does not restart it');
	const { respawnedAt: _, ...noRespawn } = recovery.lastDeath;
	const input = buildNativeEventInput(record, { event: 'observation', trigger: 'observation', newContext: true, observation: { ...observation, recovery: { ...recovery, lastDeath: noRespawn } } });
	assert.ok(!input.slice(0, input.indexOf('\n')).includes('recover_items'), 'a new goal with no respawn since the death');
});
