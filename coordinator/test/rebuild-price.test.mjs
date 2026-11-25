import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryProgressStore } from '../src/recovery-progress-wrap.mjs';
import { composeTwoCallView } from '../src/two-call-llm-wrap.mjs';
import { deathDropsLead } from '../src/live-task-view.mjs';

// After a death the wake listed the drops, the distance and the drop clock, and said a stone pick takes 0.36 min from
// logs and stone. Nothing said what the lost iron kit had cost. In three full games the bot chose to rebuild after 13 of
// 17 Overworld deaths, and getting the pickaxe and bucket back took 40-66 min when it finished at all. These states are
// rebuilt from one of those games: start at 400,79,-543, iron pickaxe first held at minute 12.9, drowned at y-39
// 64 blocks from the respawn point at minute 21.5 with the kit on it.

const OW = 'minecraft:overworld';
const T0 = 1_795_541_357_558, MIN = 60_000;
const items = (...ids) => ({ items: ids.map((id) => ({ itemId: `minecraft:${id}`, count: 1 })) });
const live = (minute, x, y, z, inventory) => ({ ready: true, observedAtEpochMs: T0 + Math.round(minute * MIN), position: { x, y, z },
	player: { dead: false, health: 20 }, world: { worldId: 'w', dimension: OW }, inventory });
const KIT = ['stone_sword', 'shield', 'stone_pickaxe', 'wooden_pickaxe', 'iron_pickaxe', 'bucket', 'water_bucket'];
const drowned = { cause: 'bot drowned', dimensionId: OW, x: 358.6, y: -38.9, z: -602.3, diedAtEpochMs: T0 + Math.round(21.5 * MIN) };

function playedToDeath(store = new RecoveryProgressStore()) {
	store.remember('a', 1, live(0, 400.5, 79, -543.5, items()));
	store.remember('a', 1, live(2.4, 398.5, 72, -550.5, items('wooden_pickaxe')));
	store.remember('a', 1, live(3.0, 397.5, 70, -552.5, items('wooden_pickaxe', 'stone_pickaxe')));
	store.remember('a', 1, live(12.9, 370.5, -20, -580.5, items('wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe')));
	store.remember('a', 1, live(21.4, 358.5, -39, -602.5, items(...KIT)));
	store.remember('a', 1, { death: drowned, observedAtEpochMs: drowned.diedAtEpochMs });
	return store;
}

test('a death with the iron pickaxe on it names what that pickaxe cost this run, in the facts and the drops lead', () => {
	const store = playedToDeath();
	const respawn = live(21.6, 390.5, 74, -546.5, items());
	const recovery = store.remember('a', 1, respawn);
	assert.deepEqual(recovery.rebuild, { itemId: 'minecraft:iron_pickaxe', minutes: 12 });
	const view = composeTwoCallView(respawn, recovery);
	assert.match(view.recovery.facts, /Making the lost iron_pickaxe took this run 12 min from its start\./);
	// The price is prose only: the model's JSON carries no second copy of it.
	assert.equal(Object.keys(view.recovery).includes('rebuild'), false);
	assert.equal(JSON.stringify(view.recovery).includes('"rebuild"'), false);
	const lead = deathDropsLead(view.recovery, { x: 390.5, y: 74, z: -546.5 }, OW, ['minecraft:iron_ingot']);
	assert.match(lead, /^death drops 64m NW dy-113 @358,-39,-603: /);
	assert.match(lead, /; making the lost iron_pickaxe took this run 12 min from its start$/);
});

test('a lost stone pickaxe is priced as cheap as it was, and picking the pickaxe back up drops the price', () => {
	const store = new RecoveryProgressStore();
	store.remember('a', 1, live(0, 0.5, 64, 0.5, items()));
	store.remember('a', 1, live(3.2, 4.5, 64, 2.5, items('stone_pickaxe', 'stone_sword')));
	store.remember('a', 1, { death: { ...drowned, x: 20, y: 60, z: 5, diedAtEpochMs: T0 + 8 * MIN }, observedAtEpochMs: T0 + 8 * MIN });
	let recovery = store.remember('a', 1, live(8.1, 0.5, 64, 0.5, items()));
	assert.match(composeTwoCallView(live(8.1, 0.5, 64, 0.5, items()), recovery).recovery.facts, /Making the lost stone_pickaxe took this run 3 min from its start\./);
	recovery = store.remember('a', 1, live(9.0, 19.5, 60, 5.5, items('stone_pickaxe', 'stone_sword')));
	assert.equal(recovery.rebuild, undefined);
	assert.doesNotMatch(composeTwoCallView(live(9.0, 19.5, 60, 5.5, items('stone_pickaxe')), recovery).recovery.facts ?? '', /Making the lost/);
});

test('gear held from the first sample, gear other than pickaxes, a void death and a new world give no price', () => {
	// A save point game starts with the kit: its cost in this run is unknown, not zero.
	const loaded = new RecoveryProgressStore();
	loaded.remember('a', 1, live(0, 0.5, 64, 0.5, items('iron_pickaxe', 'bucket')));
	loaded.remember('a', 1, live(30, 40.5, 12, 0.5, items('iron_pickaxe', 'bucket', 'shield')));
	loaded.remember('a', 1, { death: { ...drowned, diedAtEpochMs: T0 + 31 * MIN }, observedAtEpochMs: T0 + 31 * MIN });
	assert.equal(loaded.remember('a', 1, live(31.2, 0.5, 64, 0.5, items())).rebuild, undefined);
	// A shield first held at minute 30 says when it was wanted, not what it costs.
	const shieldOnly = new RecoveryProgressStore();
	shieldOnly.remember('a', 1, live(0, 0.5, 64, 0.5, items()));
	shieldOnly.remember('a', 1, live(30, 40.5, 12, 0.5, items('shield', 'bucket')));
	shieldOnly.remember('a', 1, { death: { ...drowned, diedAtEpochMs: T0 + 31 * MIN }, observedAtEpochMs: T0 + 31 * MIN });
	assert.equal(shieldOnly.remember('a', 1, live(31.2, 0.5, 64, 0.5, items())).rebuild, undefined);
	// The void keeps nothing, so there is no walk back to weigh.
	const store = playedToDeath(new RecoveryProgressStore());
	const recovery = store.remember('a', 1, live(21.6, 390.5, 74, -546.5, items()));
	const voided = composeTwoCallView(live(21.6, 390.5, 74, -546.5, items()), { ...recovery, lastDeath: { ...recovery.lastDeath, cause: 'bot fell out of the world' } });
	assert.doesNotMatch(voided.recovery.facts, /Making the lost/);
	// A new world starts its own clock.
	store.remember('a', 1, { ...live(40, 0.5, 64, 0.5, items()), world: { worldId: 'w2', dimension: OW } });
	store.remember('a', 1, { ...live(45, 0.5, 64, 0.5, items('iron_pickaxe')), world: { worldId: 'w2', dimension: OW } });
	store.remember('a', 1, { death: { ...drowned, diedAtEpochMs: T0 + 46 * MIN }, observedAtEpochMs: T0 + 46 * MIN });
	assert.deepEqual(store.remember('a', 1, { ...live(46.2, 0.5, 64, 0.5, items()), world: { worldId: 'w2', dimension: OW } }).rebuild, { itemId: 'minecraft:iron_pickaxe', minutes: 5 });
});

test('the price outlives a goal revision taken at the respawn', () => {
	const store = playedToDeath();
	const recovery = store.remember('a', 2, live(21.6, 390.5, 74, -546.5, items()));
	assert.deepEqual(recovery.rebuild, { itemId: 'minecraft:iron_pickaxe', minutes: 12 });
});

// The respawn point lands a few blocks off the trail the last body walked, and the walked-route memory joins only from a
// cell on it, so 6 of the 10 respawns that had an iron kit to fetch read "No connected walked route to these drops", and
// one game answered "the drops are deep underground with no connected route" and rebuilt.
test('a respawn off the old trail names where the walk out to the drops set off', () => {
	const store = playedToDeath();
	const respawn = { ...live(21.6, 390.5, 74, -546.5, items()), routeMemory: { connected: false, walkedCells: 412, seenResources: [] } };
	const recovery = store.remember('a', 1, respawn);
	assert.deepEqual(recovery.lastDeath.setOutFrom, { dimension: OW, x: 400.5, y: 79, z: -543.5 });
	const facts = composeTwoCallView(respawn, recovery).recovery.facts;
	assert.match(facts, /The walk out to these drops set off 10 blocks E of here @400,79,-544: the walked trail starts there, and travelTo retrace:true follows remembered steps from a cell on it\./);
	assert.doesNotMatch(facts, /No connected walked route/);
	// The next body sets out from its own respawn point.
	store.remember('a', 1, live(30, 380.5, 60, -560.5, items('stone_pickaxe')));
	store.remember('a', 1, { death: { ...drowned, x: 380.5, y: 60, z: -560.5, diedAtEpochMs: T0 + 31 * MIN }, observedAtEpochMs: T0 + 31 * MIN });
	assert.deepEqual(store.remember('a', 1, live(31.2, 395.5, 75, -546.5, items())).lastDeath.setOutFrom, { dimension: OW, x: 390.5, y: 74, z: -546.5 });
});

test('standing on the set-off point, a connected route or a death in another dimension keeps the old wording', () => {
	const store = playedToDeath();
	const at = (x, z, routeMemory) => ({ ...live(21.6, x, 74, z, items()), routeMemory });
	const factsAt = (o) => composeTwoCallView(o, store.remember('a', 1, o)).recovery.facts;
	assert.match(factsAt(at(401.5, -543.5, { connected: false, seenResources: [] })), /No connected walked route to these drops/);
	assert.match(factsAt(at(390.5, -546.5, { connected: true, length: 160, waypoints: 40, hazards: [], seenResources: [] })), /Walked retrace route: 160 blocks/);
	const nether = new RecoveryProgressStore();
	nether.remember('a', 1, live(0, 0.5, 64, 0.5, items()));
	nether.remember('a', 1, { ...live(5, 2.5, 70, 2.5, items('iron_pickaxe')), world: { worldId: 'w', dimension: 'minecraft:the_nether' } });
	nether.remember('a', 1, { death: { ...drowned, dimensionId: 'minecraft:the_nether', x: 30, y: 70, z: 2, diedAtEpochMs: T0 + 6 * MIN }, observedAtEpochMs: T0 + 6 * MIN });
	const o = { ...live(6.2, 20.5, 64, 0.5, items()), routeMemory: { connected: false, seenResources: [] } };
	assert.doesNotMatch(composeTwoCallView(o, nether.remember('a', 1, o)).recovery.facts, /set off/);
});
