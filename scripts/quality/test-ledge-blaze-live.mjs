#!/usr/bin/env node
// Provider-free ledge blaze fixture: node scripts/quality/test-ledge-blaze-live.mjs OUT_DIR [--descriptive]
// Does the body stay on a narrow Nether bridge while a blaze shoots it? Real games walled in on a bridge edge from a
// blaze (the default defend reflex) and the fireball knockback threw the body off into the lava sea. The default reflexes
// are armed as the coordinator arms them (ReflexBook), the stand-in sends no command, and the body holds no shield, a
// stone sword and cobblestone. The room is built above the Nether roof: a nether-brick deck with its walking surface at
// feet y FEET and a lava sea on the bedrock roof 40 blocks below, as a fortress bridge over the lava sea.
// Cases (CASES, comma list):
//   edge      a 3-wide deck; the body starts on an edge column (LEDGE_START near: the blaze side, the default; mid; far:
//             the brink away from the blaze). Blazes shoot from the side, so a hit pushes the body toward the far brink.
//   1wide     a 1-wide deck, the blazes on the side: any hit pushes toward open air.
//   corridor  control: the 3-wide deck between 3-high walls, one blaze at the far end shooting along it, so a push stays
//             on the deck; wall-in should still run and the body stay up.
// Each blaze sits in a nether-brick cage two cells tall with a one-high window toward the deck: it shoots through the
// window but cannot fly out. BLAZES (1 to 3, side cases only) adds caged blazes 5 blocks along the deck either way.
// Per row: pass = the body never went below the deck's walking surface and never touched the lava, over WATCH_S game
// seconds (default 180). A death ends the watch and is recorded apart (died, deaths): it is not the bar, since fireballs
// burn and an unshielded body may die on the deck. A row where the body took no damage and stayed up is notExercised
// (INVALID): the blaze never hit it. Rows record whether defend walled in (wallingSeen, refusal, stopped), the reflex
// firing when the body left the deck, where each hit landed it, and the blazes' nearest approach.
// Env: ARENA_JAR, CASES (default edge,1wide,corridor), REPEATS (default 1), WATCH_S, LEDGE_START, BLAZES.
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot, unshownTickRate } from './watch-replay.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { damageCounter, damageEvidence, deathCounter, recordDeathEvidence } from './lib/damage-counter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-ledge-blaze-live.mjs OUT_DIR [--descriptive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME (ARENA_JAR, CASES, REPEATS, WATCH_S, LEDGE_START, BLAZES)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const out = path.resolve(cli.find(arg => !arg.startsWith('--')) ?? 'runtime/ledge-blaze-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, MOD_JAR));
if (!existsSync(jar)) { console.error(`no jar at ${jar}`); process.exit(2); }
const CASES = (process.env.CASES ?? 'edge,1wide,corridor').split(',').filter(Boolean);
for (const name of CASES) if (!['edge', '1wide', 'corridor'].includes(name)) { console.error(`unknown case ${name}`); process.exit(2); }
const REPEATS = Number(process.env.REPEATS ?? 1), WATCH_S = Number(process.env.WATCH_S ?? 180);
const LEDGE_START = process.env.LEDGE_START ?? 'near', BLAZES = Number(process.env.BLAZES ?? 1);
if (!['near', 'mid', 'far'].includes(LEDGE_START) || ![1, 2, 3].includes(BLAZES) || !(WATCH_S > 0) || !(REPEATS >= 1)) { console.error(USAGE); process.exit(2); }
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const TICK_RATE = unshownTickRate('a new fixture, not yet in a 20 vs 60 TPS A/B');
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jar: path.basename(jar), jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), cases: CASES, repeats: REPEATS, watchS: WATCH_S, ledgeStart: LEDGE_START, blazes: BLAZES,
	tickRate: TICK_RATE, naturalMobSpawning: false, primaryScore: 'the body never went below the deck and never touched lava', node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Ledger';
const NETHER = 'execute in minecraft:the_nether run';
// The deck runs along x through (X0, Z0); its walking surface is at feet y FEET; lava lies on the bedrock roof at LAVA_Y.
const X0 = 100, Z0 = 100, FEET = 168, DECK = FEET - 1, LAVA_Y = 128;
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const deathCount = s => deathCounter(text => s.command(text), AGENT, { objective: 'deaths', unsetIsZero: true });
const health = async s => { const text = await s.command(`data get entity ${AGENT} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };
// A selector with x/y/z looks only in the dimension it runs in, so it runs in the Nether.
const pos = async (s, entity = AGENT) => (String(await s.command(`${NETHER} data get entity ${entity} Pos`)).match(/\[\s*(-?[\d.E-]+)d?,\s*(-?[\d.E-]+)d?,\s*(-?[\d.E-]+)d?\]/)?.slice(1).map(Number) ?? null);
const count = async (s, selector) => Number(/count: (\d+)/i.exec(String(await s.command(`${NETHER} execute if entity ${selector}`)))?.[1] ?? 0);
const round = v => Math.round(v * 100) / 100;

/** Where the body starts and where each caged blaze sits, per case. */
function layout(name) {
	if (name === 'corridor') return { start: [X0 + 0.5, FEET, Z0 + 0.5], yaw: -90, cages: [{ x: X0 + 10, z: Z0, window: [-1, 0] }] };
	const startZ = name === '1wide' ? Z0 : { near: Z0 + 1, mid: Z0, far: Z0 - 1 }[LEDGE_START];
	// Blazes on the +z side, 10 blocks from the deck's middle: a hit pushes the body toward -z, the far brink.
	const cages = [0, 5, -5].slice(0, BLAZES).map(dx => ({ x: X0 + dx, z: Z0 + 10, window: [0, -1] }));
	return { start: [X0 + 0.5, FEET, startZ + 0.5], yaw: 0, cages };
}

async function build(s, name) {
	const c = cmd => s.command(`${NETHER} ${cmd}`);
	await c(`fill ${X0 - 20} ${DECK - 7} ${Z0 - 12} ${X0 + 22} ${FEET + 14} ${Z0 + 16} minecraft:air`);
	await c(`kill @e[type=!minecraft:player,x=${X0},y=${FEET},z=${Z0},distance=..48]`);
	if (name === '1wide') await c(`fill ${X0 - 14} ${DECK} ${Z0} ${X0 + 14} ${DECK} ${Z0} minecraft:nether_bricks`);
	else if (name === 'edge') await c(`fill ${X0 - 14} ${DECK} ${Z0 - 1} ${X0 + 14} ${DECK} ${Z0 + 1} minecraft:nether_bricks`);
	else {
		await c(`fill ${X0 - 14} ${DECK} ${Z0 - 2} ${X0 + 6} ${DECK} ${Z0 + 2} minecraft:nether_bricks`);
		await c(`fill ${X0 - 14} ${FEET} ${Z0 - 2} ${X0 + 6} ${FEET + 2} ${Z0 - 2} minecraft:nether_bricks`);
		await c(`fill ${X0 - 14} ${FEET} ${Z0 + 2} ${X0 + 6} ${FEET + 2} ${Z0 + 2} minecraft:nether_bricks`);
	}
	// A cage: floor at FEET, two air cells above it for the blaze, a one-high window in the upper cell toward the deck.
	for (const { x, z, window: [wx, wz] } of layout(name).cages) {
		await c(`fill ${x - 1} ${FEET} ${z - 1} ${x + 1} ${FEET + 3} ${z + 1} minecraft:nether_bricks`);
		await c(`fill ${x} ${FEET + 1} ${z} ${x} ${FEET + 2} ${z} minecraft:air`);
		await c(`setblock ${x + wx} ${FEET + 2} ${z + wz} minecraft:air`);
	}
}

async function register(s) {
	const start = layout(CASES[0]).start;
	let e = null, reply = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 30000).catch(() => null);
		const summon = () => s.command(`execute in minecraft:the_nether positioned ${start.join(' ')} run mineagen summon gpt-6.1-sol low ${AGENT}`);
		reply = await summon();
		for (let n = 0; /MODEL_CATALOG_UNAVAILABLE/.test(reply) && n < 40; n++) { await sleep(250); reply = await summon(); }
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${reply}`);
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`mineagen start ${AGENT} Survive for 3600 seconds.`); s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${AGENT}`);
}

// The default rules as the coordinator arms them on a body's first live sample (as test-defend-live.mjs).
const book = new ReflexBook();
let armedRevision = 0;
async function arm(s) {
	book.observeContext(s.record.agentId, await s.observe());
	const payload = book.payload(s.record.agentId);
	// A re-send after a respawn gets a fresh revision so the mod takes it.
	armedRevision = Math.max(armedRevision + 1, payload.revision);
	await s.bridge.send('reflex_update', s.record.agentId, { ...payload, revision: armedRevision });
	for (let i = 0; i < 50; i++) {
		const o = await s.observe();
		if (o.reflexes?.revision === armedRevision && (o.reflexes.rules ?? []).some(rule => rule.id === 'default-defend')) return o.reflexes.rules.length;
		await sleep(200);
	}
	throw new Error(`default reflexes (revision ${armedRevision}) never echoed with default-defend`);
}

async function trial(s, name, repeat, readDamage) {
	const row = { name: `${name}-${repeat}`, case: name, repeat, ledgeStart: name === 'edge' ? LEDGE_START : null, blazes: layout(name).cages.length, startedAt: Date.now() };
	await s.normalRate();
	for (let attempt = 0; attempt < 10 && !((await health(s).catch(() => 0)) > 0); attempt++) {
		await s.act('respawn', {}).catch(() => null); await s.idleSleep(1500);
	}
	const { start, yaw, cages } = layout(name);
	await build(s, name);
	await s.command(`clear ${AGENT}`);
	await s.command(`item replace entity ${AGENT} hotbar.0 with minecraft:stone_sword`);
	await s.command(`item replace entity ${AGENT} hotbar.3 with minecraft:cobblestone 64`);
	await s.command(`effect clear ${AGENT}`);
	await s.command(`${NETHER} tp ${AGENT} ${start.join(' ')} ${yaw} 0`);
	// A respawn or the first arrival is a dimension change: vanilla leaves the body invulnerable for 60 ticks. Fire
	// resistance puts out a fire the last trial left; it ends before the blazes come.
	await s.command(`effect give ${AGENT} minecraft:fire_resistance 3 0 true`);
	await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`);
	await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
	await s.idleSleep(4000);
	await s.command(`${NETHER} tp ${AGENT} ${start.join(' ')} ${yaw} 0`);
	await s.act('select_item', { itemId: 'minecraft:stone_sword' }).catch(() => {});
	row.reflexRules = await arm(s);
	const deathsBefore = await deathCount(s), damageBefore = await readDamage(), start0 = await health(s);
	for (const { x, z } of cages) await s.command(`${NETHER} summon minecraft:blaze ${x + 0.5} ${FEET + 1} ${z + 0.5} {PersistenceRequired:1b}`);
	const lateral = name === 'corridor' ? at => at[0] - start[0] : at => at[2] - start[2];
	const steps = [], hits = [], track = [];
	let died = false, fell = null, lava = false, minY = FEET, fireballs = 0, fired = false, wallingSeen = false, refusal = null, stopped = null;
	let deathY = null;
	let lastFiring = null, firingAtFall = null, lastHealth = start0, blazeNearest = Infinity, blazeLeft = false, afterFall = null;
	await s.fastRate();
	const now = () => s.clock.now();
	const t0 = now(), timer = await s.gameTimer();
	let poll = 0;
	while (now() - t0 < WATCH_S * 1000) {
		await s.clock.sleep(250);
		poll++;
		const o = await s.observeOrNull();
		const h = await health(s).catch(() => null);
		// Death first: a respawn moves the body, which would read as a fall.
		if ((await deathCount(s)) > deathsBefore || h === 0) {
			died = true;
			// A fall that kills inside one poll reads as a death on the deck unless the death's own spot says otherwise.
			const where = String(await s.command(`data get entity ${AGENT} LastDeathLocation.pos`).catch(() => ''));
			const y = Number(/\[I;\s*-?\d+,\s*(-?\d+),/.exec(where)?.[1]);
			if (Number.isFinite(y)) {
				deathY = y;
				if (fell === null && y < FEET - 0.5) { fell = { atS: round((now() - t0) / 1000), lateral: null, firing: lastFiring, fromDeath: true }; firingAtFall = lastFiring; }
				if (y < LAVA_Y + 2) lava = true;
			}
			break;
		}
		const at = await pos(s);
		const firing = o?.reflexes?.firing?.id ? `${o.reflexes.firing.id}: ${String(o.reflexes.firing.detail ?? '').slice(0, 200)}` : null;
		if (firing) {
			const step = firing.replace(/-?[\d.]+/g, '#').slice(0, 160);
			if (!steps.includes(step) && steps.length < 24) steps.push(step);
		}
		const detail = o?.reflexes?.firing?.id === 'default-defend' ? String(o.reflexes.firing.detail ?? '') : '';
		if (detail) {
			fired = true;
			if (/walling in from|stepping to the middle/.test(detail)) wallingSeen = true;
			if (/not walling in: [^;]*/.test(detail)) refusal = /not walling in: [^;]*/.exec(detail)[0];
			if (/stopped walling in: [^;]*/.test(detail)) stopped = /stopped walling in: [^;]*/.exec(detail)[0];
		}
		if (at) {
			minY = Math.min(minY, at[1]);
			if (fell === null && at[1] < FEET - 0.5) {
				fell = { atS: round((now() - t0) / 1000), lateral: round(lateral(at)), firing: firing ?? lastFiring };
				firingAtFall = fell.firing;
				afterFall = now();
			}
			if (at[1] < LAVA_Y + 1.5) lava = true;
			if (h !== null && h < lastHealth - 0.5 && hits.length < 24) hits.push({ atS: round((now() - t0) / 1000), health: h, lateral: round(lateral(at)), y: round(at[1]), firing });
			if (track.length < 120 && (hits.length > 0 || poll % 8 === 0)) track.push([round((now() - t0) / 1000), round(lateral(at)), round(at[1]), firing ? firing.split(':')[0] : null]);
		}
		if (h !== null) lastHealth = h;
		lastFiring = firing ?? lastFiring;
		fireballs = Math.max(fireballs, await count(s, `@e[type=minecraft:small_fireball,x=${X0},y=${FEET},z=${Z0},distance=..40]`));
		if (poll % 4 === 0) {
			for (const { x, z } of cages) {
				const b = await pos(s, `@e[type=minecraft:blaze,x=${x + 0.5},y=${FEET + 1},z=${z + 0.5},distance=..6,limit=1,sort=nearest]`);
				if (!b) continue;
				if (at) blazeNearest = Math.min(blazeNearest, Math.hypot(b[0] - at[0], b[2] - at[2]));
				if (Math.hypot(b[0] - x - 0.5, b[2] - z - 0.5) > 1) blazeLeft = true;
			}
		}
		// After a fall, watch a few seconds more to see the lava, then stop.
		if (afterFall !== null && (lava || now() - afterFall > 6000)) break;
	}
	await s.normalRate();
	const healthEnd = await health(s).catch(() => null);
	await s.command(`${NETHER} kill @e[type=minecraft:blaze,x=${X0},y=${FEET},z=${Z0},distance=..48]`);
	Object.assign(row, { died, deathY, fell: fell !== null, fall: fell, lavaContact: lava, minY: round(minY), defendFired: fired, wallingSeen, refusal, stopped, firingAtFall,
		fireballsSeen: fireballs, hits, track, steps, blazeNearest: Number.isFinite(blazeNearest) ? round(blazeNearest) : null, blazeLeftCage: blazeLeft,
		watchedS: round((now() - t0) / 1000), gameSeconds: Math.round((await timer.elapsed()) / 1000), rates: await timer.rates().catch(() => null), tick: { rate: s.tickRate, held: await s.tickReport() } });
	Object.assign(row, damageEvidence(damageBefore, await readDamage(), start0, healthEnd));
	recordDeathEvidence(row, deathsBefore, await deathCount(s));
	row.pass = !row.fell && !lava;
	if (!row.pass) row.failReason = lava ? `fell off the deck into the lava at ${fell?.atS ?? '?'} s (firing ${firingAtFall ?? 'none'})` : `fell below the deck at ${fell?.atS ?? '?'} s (firing ${firingAtFall ?? 'none'})`;
	else if (row.damageTaken === 0) row.notExercised = `the blaze never hit the body (${fireballs} fireball(s) seen)`;
	else if (!fired) row.notExercised = 'defend never fired: the room tested nothing of the reflex';
	else row.passReason = `stayed on the deck ${row.watchedS} s${died ? ' (then died on it)' : ''}, ${hits.length} hit(s)`;
	row.finishedAt = Date.now();
	return row;
}

const rows = [];
const planned = CASES.length * REPEATS;
let s = null;
try {
	s = await boot(path.join(out, 'server-run'), { jar, template, port, world: null, seed: '20261123', goalTicks: 72_000, tickRate: TICK_RATE, worldCache: true });
	await s.command('difficulty normal');
	await s.command('gamerule minecraft:spawn_mobs false');
	await s.command(`${NETHER} forceload add ${X0 - 24} ${Z0 - 24} ${X0 + 24} ${Z0 + 24}`);
	// The lava sea on the bedrock roof, once its chunks have loaded.
	for (let i = 0; i < 30; i++) {
		const reply = String(await s.command(`${NETHER} fill ${X0 - 22} ${LAVA_Y} ${Z0 - 20} ${X0 + 24} ${LAVA_Y} ${Z0 + 20} minecraft:lava`));
		if (!/not loaded|out of the world/i.test(reply)) break;
		if (i === 29) throw new Error(`lava sea not placed: ${reply}`);
		await sleep(1000);
	}
	await register(s);
	const readDamage = await damageCounter(text => s.command(text), AGENT);
	for (const name of CASES) {
		for (let repeat = 1; repeat <= REPEATS; repeat++) {
			const row = await trial(s, name, repeat, readDamage).catch(error => ({ name: `${name}-${repeat}`, case: name, repeat, error: String(error?.stack ?? error).slice(0, 1500), startedAt: Date.now(), finishedAt: Date.now() }));
			rows.push(row);
			console.log(`[ledge-blaze] ${row.name}: ${row.error ? `ERROR ${row.error.slice(0, 200)}` : `${row.pass ? 'stayed up' : 'FELL'}${row.lavaContact ? ' into lava' : ''}, died ${row.died}, hits ${row.hits.length}, damage ${row.damageTaken}, defend ${row.defendFired}, walling ${row.wallingSeen}${row.refusal ? `, ${row.refusal}` : ''}${row.stopped ? `, ${row.stopped}` : ''}${row.firingAtFall ? `, firing at fall ${row.firingAtFall.slice(0, 120)}` : ''}${row.notExercised ? `, NOT EXERCISED ${row.notExercised}` : ''}`}`);
			await writeFile(path.join(out, 'runs.json'), JSON.stringify(rows, null, 1));
		}
	}
} catch (error) {
	console.error(error);
	await writeFile(path.join(out, 'error.txt'), String(error?.stack ?? error));
} finally {
	await s?.stop().catch(() => {});
}
const report = await finishRun(rows, { file: path.join(out, 'result.json'), planned, strict });
console.log(`[ledge-blaze] ${report.line}`);
process.exit(report.exitCode);
