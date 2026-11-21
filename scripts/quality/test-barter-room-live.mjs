#!/usr/bin/env node
// Provider-free practice room for the piglin barter job: one Nether room, one loot salt, a 10-game-minute window
// (BARTER_TICKS, default 12000) scored by game ticks, under slot.sh live:
//   test-barter-room-live.mjs ROOM SALT OUT_DIR JAR [--strict|--descriptive]
// Rooms (a sealed, lit netherrack hall in the seed's nether wastes, 41 x 41, the body at its west end):
//   held   192 gold ingots and a golden helmet carried, iron helmet worn; 5 calm piglins 28 blocks east (out of 16).
//   blocks 20 gold blocks and 6 ingots carried (bastion loot), golden boots worn; 5 piglins 20 blocks east and one
//          hoglin loose near them.
//   mine   a Nether start's gold: a golden helmet worn and no gold to trade; 39 Nether gold ores in the west wall
//          beside the start, a crafting table and iron pickaxe carried; 4 piglins 28 blocks east (mining there angers
//          none: they guard gold only within 16).
// The stand-in plays what a model can call: barter_until (ender_pearl), re-called after every hand-back, and the
// recovery a model would make on each reason code (equip carried gold armour; craft blocks or nuggets into ingots and
// a golden helmet at the carried table; mine the seen gold ore; walk toward a seen piglin; fight a hostile that is
// near; eat). Each decision waits THINK_MS (default 5000, a model turn) first. The same SALT on both arms of a repeat
// gives both the same barter sequence, so pearls follow the ingots traded.
// Row: pearls gained, ingots traded (gold spent in ingot units), deaths, damage, calls, reasons, per 10 minutes.
// Pass: alive at the end and gold traded (held, blocks: at least 40 ingots; mine: at least 1). Pearls are recorded,
// not judged: 2.1% per ingot gives none from 40 ingots 42% of the time. INVALID when the room never started
// (no piglin seen at the start, harness error).
import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { damageCounter, statCounter, replyNumber } from './lib/damage-counter.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { validateAction } from '../../coordinator/src/schema.mjs';

const USAGE = 'Usage: test-barter-room-live.mjs held|blocks|mine SALT OUT_DIR JAR [--strict|--descriptive] under slot.sh live, with JAVA_HOME and ARENA_HEADLESS_SERVER_TEMPLATE';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const [room, saltArg, outArg, jarArg] = cli.filter(arg => !['--strict', '--descriptive'].includes(arg));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
const ROOMS = ['held', 'blocks', 'mine'];
if (!ROOMS.includes(room) || !Number.isInteger(Number(saltArg)) || !outArg || !jarArg || !template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const salt = Number(saltArg), out = path.resolve(outArg), jar = path.resolve(jarArg);
const TICKS = Number(process.env.BARTER_TICKS ?? 12000), THINK_MS = Number(process.env.THINK_MS ?? 5000);
const { boot } = await import('./watch-replay.mjs');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const self = new URL(import.meta.url);
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live practice room', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	room, salt, ticks: TICKS, thinkMs: THINK_MS, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'),
	fixtureSha256: createHash('sha256').update(await readFile(self)).digest('hex'), node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Trader', NETHER = 'minecraft:the_nether', Y = 70, HALF = 20;
const row = { name: room, repeat: salt, room, salt, calls: {}, reasons: {} };
const s = await boot(out, { jar, template, port, world: null, seed: '20261009', readyTimeoutMs: 90000 });
s.bridge.on('message', (event) => {
	const control = event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null;
	if (control == null || event.agentId !== s.record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= s.record.goalRevision) return;
	if (['queue', 'dequeue'].includes(control.operation)) return;
	s.record.goalRevision = control.goalRevision;
	s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
});
const nc = text => s.command(`execute in ${NETHER} run ${text}`);
const gameTicks = async () => { const m = /time is (\d+)/i.exec(String(await s.command('time query gametime'))); if (!m) throw new Error('GAME_CLOCK_UNAVAILABLE'); return Number(m[1]); };
let facts = null, dead = false, startTicks = 0, startedAt = 0;
async function observe() {
	const raw = await s.observeOrNull();
	if (!raw) return facts;
	if (!raw.ready) { if (raw.status === 'PLAYER_DEAD') dead = true; return facts; }
	facts = adaptObservation(raw);
	return facts;
}
const items = () => facts?.inventory?.items ?? [];
const WORN = new Set(['head', 'chest', 'legs', 'feet']);
const held = id => items().filter(i => i.itemId === id && !WORN.has(i.slot)).reduce((n, i) => n + i.count, 0);
const goldUnits = () => held('minecraft:gold_ingot') + 9 * held('minecraft:gold_block') + held('minecraft:gold_nugget') / 9;
const goldWorn = () => items().some(i => WORN.has(i.slot) && /^minecraft:golden_(helmet|chestplate|leggings|boots)$/.test(i.itemId));
const seenEntities = type => (facts?.entities ?? []).filter(e => e.type === type && e.alive !== false && e.visible !== false && e.perceivedBy !== 'sound');
async function act(type, args, waitMs = 65000) {
	validateAction({ type, ...args });
	row.calls[type] = (row.calls[type] ?? 0) + 1;
	const at = Date.now(), t0 = await gameTicks();
	let r;
	// A goal revision that moved on between the read and the send is refused unrun; send it once more on the new one.
	for (let attempt = 0; attempt < 3; attempt++) {
		try { r = await s.act(type, args, waitMs); } catch (error) { r = { state: 'ERROR', reasonCode: 'HARNESS_TIMEOUT', message: String(error?.message ?? error) }; }
		if (r.reasonCode !== 'STALE_REVISION') break;
		await sleep(500);
	}
	const code = r.reasonCode ?? r.state;
	row.reasons[`${type}:${code}`] = (row.reasons[`${type}:${code}`] ?? 0) + 1;
	const entry = { atTicks: t0 - startTicks, type, args, state: r.state, reason: code, ms: Date.now() - at, message: String(r.message ?? '').slice(0, 600) };
	await appendFile(path.join(out, 'actions.jsonl'), JSON.stringify(entry) + '\n');
	if (code === 'AGENT_DEAD' || code === 'PLAYER_DEAD') dead = true;
	await observe();
	return r;
}
// A model turn: the body idles while it thinks.
const think = () => sleep(THINK_MS);
const left = async () => TICKS - ((await gameTicks()) - startTicks);
async function select(itemId) {
	const item = items().find(i => i.itemId === itemId && !WORN.has(i.slot) && i.count > 0);
	if (!item) return false;
	if (Number.isInteger(item.slot) && item.slot > 8) await act('select_tool', { sourceSlot: item.slot, hotbarSlot: 8, expectedItemId: itemId, minRemainingDurability: 0 });
	await act('select_item', { itemId });
	return true;
}
let table = null, equipRefused = false;
// The carried crafting table, placed once on the floor beside the body (as a player does), reused afterwards.
async function placeTable() {
	if (table) return table;
	if (!held('minecraft:crafting_table')) return null;
	const p = facts.player, fx = Math.floor(p.x), fz = Math.floor(p.z);
	for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]]) {
		// The cell the table goes into, clicked on the floor's top face.
		const r = await act('place_block', { x: fx + dx, y: Y, z: fz + dz, face: 'up', itemId: 'minecraft:crafting_table' });
		if (r.state === 'SUCCEEDED') { table = { x: fx + dx, y: Y, z: fz + dz }; return table; }
	}
	return null;
}
async function craftAtTable(recipeId, count) {
	const at = await placeTable();
	if (!at) return false;
	return (await act('craft_table', { recipeId, ...at, count, timeoutMs: 20000 })).state === 'SUCCEEDED';
}
// Gold the model would turn into ingots before bartering; false when there is none to convert or mine.
async function getGold() {
	const blocks = held('minecraft:gold_block'), nuggets = held('minecraft:gold_nugget');
	if (blocks > 0) return (await act('craft_inventory', { recipeId: 'minecraft:gold_ingot_from_gold_block', count: Math.min(blocks, 7), timeoutMs: 20000 })).state === 'SUCCEEDED';
	if (nuggets >= 9) return craftAtTable('minecraft:gold_ingot_from_nuggets', Math.min(64, Math.floor(nuggets / 9)));
	const seenOre = () => {
		const p = facts.player;
		return (facts.blocks ?? []).filter(b => b.blockId === 'minecraft:nether_gold_ore')
			.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z) - Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z))[0];
	};
	let ore = seenOre();
	// None in view: look around once, in four quarter turns, as a player does before giving up on gold.
	for (let turn = 0; !ore && turn < 4; turn++) {
		const p = facts.player, a = turn * Math.PI / 2;
		await act('look_at', { x: p.x + 12 * Math.cos(a), y: p.y + 1.2, z: p.z + 12 * Math.sin(a) });
		await sleep(300);
		await observe();
		ore = seenOre();
	}
	if (!ore) return false;
	await select('minecraft:iron_pickaxe');
	// The body mines only ore it sees and reaches: walk up to it, then turn to it, as the refusals tell a model to.
	if (Math.hypot(ore.x + 0.5 - facts.player.x, ore.z + 0.5 - facts.player.z) > 3.5)
		await act('navigate_to', { x: ore.x + 0.5 + Math.sign(facts.player.x - ore.x), y: Y, z: ore.z + 0.5, tolerance: 1, sprint: false, timeoutMs: 20000 }, 30000);
	await act('look_at', { x: ore.x + 0.5, y: ore.y + 0.5, z: ore.z + 0.5 });
	await act('mine_vein', { x: ore.x, y: ore.y, z: ore.z, maxBlocks: 64, timeoutMs: 120000 }, 150000);
	await collectNuggets();
	return held('minecraft:gold_nugget') > nuggets;
}
// Mined nuggets drop in the mined cells, out of touch range: pick each seen stack up.
async function collectNuggets() {
	for (let i = 0; i < 12; i++) {
		const drop = (facts.items ?? []).filter(x => x.itemId === 'minecraft:gold_nugget' && (x.distance ?? 99) <= 10).sort((a, b) => a.distance - b.distance)[0];
		if (!drop) return;
		const r = await act('pick_up_item', { targetSelector: drop.stableId, timeoutMs: 10000 }, 20000);
		if (r.state !== 'SUCCEEDED') return;
	}
}
async function wearGold() {
	const piece = items().find(i => !WORN.has(i.slot) && /^minecraft:golden_(helmet|chestplate|leggings|boots)$/.test(i.itemId));
	if (piece) {
		// A refused equip is not retried: the slot stays occupied, so the model moves on to the barter job.
		if (equipRefused) return false;
		const slot = { helmet: 'head', chestplate: 'chest', leggings: 'legs', boots: 'feet' }[/golden_(\w+)$/.exec(piece.itemId)[1]];
		const ok = (await act('equip_item', { sourceSlot: piece.slot, targetSlot: slot, expectedItemId: piece.itemId })).state === 'SUCCEEDED';
		if (!ok) equipRefused = true;
		return ok;
	}
	if (held('minecraft:gold_ingot') >= 5) return craftAtTable('minecraft:golden_helmet', 1);
	return getGold();
}
async function eat() {
	if (!(facts.player.foodLevel < 16 || facts.player.health < 12) || !held('minecraft:cooked_beef')) return false;
	await select('minecraft:cooked_beef');
	await act('use_item', { durationMs: 1800, expectedItemId: 'minecraft:cooked_beef' });
	return true;
}
async function fight(targetId) {
	await select('minecraft:iron_sword');
	return act('fight_target', { targetId, fleeAtHealth: 8, timeoutMs: 30000 }, 45000);
}
try {
	await s.command('difficulty normal');
	await s.command('gamerule minecraft:spawn_mobs false');
	// A pad under the summon point: a body summoned in the air falls to its death before the room is built.
	await s.command('forceload add 0 0');
	await s.command('fill -1 199 -1 1 199 1 minecraft:glass');
	let e = null, reply = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
		reply = await s.command(`execute positioned 0.5 200 0.5 run mineagen summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${reply}`);
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`mineagen start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${AGENT}`);
	const located = await s.command(`execute in ${NETHER} positioned 0 ${Y} 0 run locate biome minecraft:nether_wastes`);
	const m = /\[(-?\d+),\s*(?:~|-?\d+),\s*(-?\d+)\]/.exec(located);
	if (!m) throw new Error(`locate failed: ${located}`);
	const X = Number(m[1]), Z = Number(m[2]);
	row.at = [X, Y, Z];
	await nc(`forceload add ${X - HALF - 1} ${Z - HALF - 1} ${X + HALF + 1} ${Z + HALF + 1}`);
	await sleep(2000);
	await nc(`fill ${X - HALF - 1} ${Y - 1} ${Z - HALF - 1} ${X + HALF + 1} ${Y + 5} ${Z + HALF + 1} minecraft:netherrack`);
	await nc(`fill ${X - HALF} ${Y} ${Z - HALF} ${X + HALF} ${Y + 4} ${Z + HALF} minecraft:air`);
	for (let dz = -18; dz <= 18; dz += 6) await nc(`fill ${X - HALF} ${Y + 5} ${Z + dz} ${X + HALF} ${Y + 5} ${Z + dz} minecraft:glowstone`);
	if (room === 'mine') await nc(`fill ${X - HALF} ${Y} ${Z - 6} ${X - HALF} ${Y + 2} ${Z + 6} minecraft:nether_gold_ore`);
	await nc(`kill @e[type=!minecraft:player,x=${X - HALF - 1},y=${Y - 1},z=${Z - HALF - 1},dx=${2 * HALF + 2},dy=7,dz=${2 * HALF + 2}]`);
	await nc(`tp ${AGENT} ${X - HALF + 4.5} ${Y} ${Z + 0.5} -90 0`);
	await s.command(`clear ${AGENT}`);
	await s.command(`effect clear ${AGENT}`);
	await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`);
	await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
	const armour = { head: room === 'mine' ? 'golden_helmet' : 'iron_helmet', chest: 'iron_chestplate', legs: 'iron_leggings', feet: room === 'blocks' ? 'golden_boots' : 'iron_boots' };
	for (const [slot, item] of Object.entries(armour)) await s.command(`item replace entity ${AGENT} armor.${slot} with minecraft:${item}`);
	const give = { held: [['iron_sword', 1], ['iron_pickaxe', 1], ['cooked_beef', 16], ['gold_ingot', 64], ['gold_ingot', 64], ['gold_ingot', 64], ['golden_helmet', 1]],
		blocks: [['iron_sword', 1], ['iron_pickaxe', 1], ['cooked_beef', 16], ['gold_block', 20], ['gold_ingot', 6]],
		mine: [['iron_sword', 1], ['iron_pickaxe', 1], ['cooked_beef', 16], ['crafting_table', 1]] }[room];
	for (const [i, [item, count]] of give.entries()) await s.command(`item replace entity ${AGENT} ${i < 9 ? `hotbar.${i}` : `inventory.${i - 9}`} with minecraft:${item} ${count}`);
	await s.command(`random reset * ${salt}`);
	const group = { held: [[12, 0], [13, 2], [11, -2], [14, -1], [12, 3]], blocks: [[4, 0], [5, 2], [3, -2], [6, -1], [4, 3]], mine: [[12, 0], [13, 2], [11, -2], [14, -1]] }[room];
	for (const [i, [dx, dz]] of group.entries())
		await nc(`summon minecraft:piglin ${X + dx + 0.5} ${Y} ${Z + dz + 0.5} {PersistenceRequired:1b,IsImmuneToZombification:1b,Tags:["barter_room"],HandItems:[{id:"minecraft:golden_sword",count:1},{}]}`);
	if (room === 'blocks') await nc(`summon minecraft:hoglin ${X + 6.5} ${Y} ${Z + 12.5} {PersistenceRequired:1b,IsImmuneToZombification:1b,Tags:["barter_room"]}`);
	await sleep(1500);
	const damage = await damageCounter(s.command, AGENT);
	await s.command('scoreboard objectives add barter_deaths deathCount').catch(() => {});
	const damage0 = await damage();
	// Gold gained in the room: nuggets picked up (mined), in ingot units. Barter returns never include gold.
	const nuggetPickups = await statCounter(s.command, AGENT, 'barter_nug', 'minecraft.picked_up:minecraft.gold_nugget');
	const nuggets0 = await nuggetPickups();
	// The first observations can predate the kit; wait until the inventory shows the sword the setup gave.
	for (let i = 0; i < 20 && !items().some(x => x.itemId === 'minecraft:iron_sword'); i++) { await observe(); await sleep(500); }
	if (!items().some(x => x.itemId === 'minecraft:iron_sword')) throw new Error('the kit never showed in an observation');
	await act('look_at', { x: X + 10, y: Y + 1.6, z: Z + 0.5 });
	row.piglinsSeenAtStart = seenEntities('minecraft:piglin').length;
	if (row.piglinsSeenAtStart === 0) row.notExercised = 'no piglin seen from the start';
	const gold0 = goldUnits(), pearls0 = held('minecraft:ender_pearl');
	row.goldStart = gold0;
	startTicks = await gameTicks(); startedAt = Date.now(); row.startedAt = startedAt;
	let idle = 0, outOfGold = false;
	while (!dead && !row.notExercised && (await left()) > 100) {
		await think();
		await observe();
		if (dead) break;
		if (await eat()) continue;
		const threat = (facts.entities ?? []).filter(x => /^minecraft:(hoglin|piglin_brute|zoglin|zombified_piglin|magma_cube|ghast|wither_skeleton)$/.test(x.type) && x.alive !== false
			&& (x.targetingAgent === true || x.distance <= 6)).sort((a, b) => a.distance - b.distance)[0];
		if (threat) { await fight(threat.stableId); continue; }
		// equip_item refuses an occupied armour slot; then the model tries the barter job, which puts carried gold on itself.
		const carriedGold = items().some(i => !WORN.has(i.slot) && /^minecraft:golden_(helmet|chestplate|leggings|boots)$/.test(i.itemId));
		if (!goldWorn() && !(await wearGold()) && !carriedGold) { idle++; continue; }
		// Gold to convert goes to the barter job first; after it hands back OUT_OF_GOLD the model crafts it by hand.
		const convertible = held('minecraft:gold_block') > 0 || held('minecraft:gold_nugget') >= 9;
		if (held('minecraft:gold_ingot') === 0 && goldWorn() && (!convertible || outOfGold)) {
			outOfGold = false;
			if (!(await getGold())) { if (++idle > 6) { row.stopped = 'no gold left to trade, convert or mine'; break; } }
			continue;
		}
		await select('minecraft:gold_ingot');
		const timeoutMs = Math.max(5000, Math.min(300000, (await left()) * 50));
		const r = await act('barter_until', { itemId: 'minecraft:ender_pearl', count: 16, timeoutMs }, timeoutMs + 30000);
		const code = r.reasonCode;
		outOfGold = code === 'OUT_OF_GOLD';
		if (code === 'NO_PIGLIN') {
			const p = seenEntities('minecraft:piglin').filter(x => x.baby !== true).sort((a, b) => a.distance - b.distance)[0];
			if (p) await act('navigate_to', { x: p.x, y: p.y, z: p.z, tolerance: 3, sprint: false, timeoutMs: 20000 }, 30000);
			else if (++idle > 6) { row.stopped = 'no piglin in sight'; break; }
		} else if (code === 'HOSTILE_NEAR' || code === 'PIGLIN_ANGRY' || code === 'DAMAGE_TAKEN') {
			const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(r.message ?? '')?.[1];
			const named = id && (facts.entities ?? []).find(x => x.stableId === id || x.uuid === id);
			const nearest = (facts.entities ?? []).filter(x => x.targetingAgent === true).sort((a, b) => a.distance - b.distance)[0];
			const target = named ?? nearest;
			if (target) await fight(target.stableId);
		}
		idle = 0;
	}
	const endTicks = await gameTicks();
	await observe();
	const damage1 = await damage();
	const nuggetsPicked = (await nuggetPickups()) - nuggets0;
	const deaths = replyNumber(await s.command(`scoreboard players get ${AGENT} barter_deaths`));
	row.elapsedTicks = endTicks - startTicks;
	row.finishedAt = Date.now();
	row.deaths = Number.isFinite(deaths) ? deaths : dead ? 1 : 0;
	row.damageTaken = Number.isFinite(damage1) && Number.isFinite(damage0) ? (damage1 - damage0) / 10 : null;
	row.pearls = dead ? null : held('minecraft:ender_pearl') - pearls0;
	row.goldEnd = dead ? null : goldUnits();
	row.goldMined = Number.isFinite(nuggetsPicked) ? +(nuggetsPicked / 9).toFixed(2) : null;
	row.ingotsTraded = dead || row.goldMined === null ? null : +(gold0 + row.goldMined - row.goldEnd).toFixed(2);
	const alive = String(await s.command(`execute in ${NETHER} if entity @e[type=minecraft:piglin,tag=barter_room]`).catch(() => ''));
	row.piglinsAliveAtEnd = /count: (\d+)/i.test(alive) ? Number(/count: (\d+)/i.exec(alive)[1]) : /failed/i.test(alive) ? 0 : null;
	const window = Math.max(row.elapsedTicks, 1);
	row.pearlsPer10Min = row.pearls === null ? null : +(row.pearls * 12000 / window).toFixed(2);
	row.ingotsPer10Min = row.ingotsTraded === null ? null : +(row.ingotsTraded * 12000 / window).toFixed(1);
	const bar = room === 'mine' ? 1 : 40;
	row.pass = !dead && row.deaths === 0 && row.ingotsTraded >= bar;
	row.failReason = dead || row.deaths ? 'the body died' : `traded ${row.ingotsTraded} ingots (bar ${bar})${row.stopped ? `; ${row.stopped}` : ''}`;
	row.passReason = `traded ${row.ingotsTraded} ingots for ${row.pearls} pearls in ${(row.elapsedTicks / 1200).toFixed(1)} game min`;
	if (dead && !row.deaths) row.deaths = 1;
	console.log(`[barter-room] ${room} salt ${salt}: pearls ${row.pearls}, ingots traded ${row.ingotsTraded}, deaths ${row.deaths}, damage ${row.damageTaken}, calls ${JSON.stringify(row.calls)}`);
} catch (error) {
	console.error(error);
	row.error = String(error?.stack ?? error).slice(0, 1500);
} finally {
	try { await s.stop(); } catch (error) { row.cleanupError = String(error?.message ?? error); }
}
const report = await finishRun([row], { file: path.join(out, 'result.json'), planned: 1, strict });
console.log(JSON.stringify({ line: report.line }));
process.exit(report.exitCode);
