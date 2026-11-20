#!/usr/bin/env node
// Provider-free blaze spawner fixture (wall breaker rods): node scripts/quality/test-spawner-hold-live.mjs OUT_DIR
// A fortress spawner room is built with operator commands in the Nether of each seed (so the room is the same on every
// seed): a 15x15 nether-brick room with 5-high walls, a blaze spawner on a raised block in its middle, its west side open
// onto a 5-wide railed bridge over open air (a netherrack floor 9 blocks below catches falls). The body starts on the
// bridge 13.5 blocks from the spawner (inside the spawner's 16-block activation range), facing it, with iron armour, an
// iron sword, a bow, 64 arrows, a shield, 64 cobblestone and 16 bread, full health.
// The stand-in makes only calls a model makes, the same on every jar: look at the spawner once, then fight_until
// mob:blaze untilItem:blaze_rod untilCount:UNTIL fleeAtHealth:6 timeoutMs up to 600 s, reissued after every hand-back;
// eat bread below 10 health. The coordinator's default reflexes run with its automatic stance (ReflexBook, instincts on).
// Variants: plain; withers (two wither skeletons summoned on the approach, between the bridge and the spawner).
// ARM=old feeds the stance resolver observations without wither skeletons (the old coordinator had no fortress stance).
// Per run: rods held at the end of the window (0 after a death), game minutes to UNTIL rods, deaths, hand-back codes.
// Pass bar (contract): UNTIL (7) rods within RUN_MIN (25) game minutes on 3 of 4 runs of a variant, at most 1 death.
// Env: ARENA_JAR, SEEDS (comma list), VARIANTS (plain,withers), RUN_MIN, UNTIL, ARM (new|old), FIXTURE_TICK_RATE.
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot, fixtureTickRate } from './watch-replay.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-spawner-hold-live.mjs OUT_DIR under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME (ARENA_JAR, SEEDS, VARIANTS, RUN_MIN, UNTIL, ARM, FIXTURE_TICK_RATE)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const out = path.resolve(cli[0] ?? 'runtime/spawner-hold-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, 'build/libs/mineagen-0.2.0.jar'));
if (!existsSync(jar)) { console.error(`no jar at ${jar}`); process.exit(2); }
const SEEDS = (process.env.SEEDS ?? '20261119,20261120,20261121,20261122').split(',');
const VARIANTS = (process.env.VARIANTS ?? 'plain,withers').split(',');
const RUN_MIN = Number(process.env.RUN_MIN ?? 25), UNTIL = Number(process.env.UNTIL ?? 7), ARM = process.env.ARM ?? 'new';
// The mod reads the instincts arm from its environment; the server inherits this process's.
process.env.MINEAGEN_INSTINCTS = 'instincts';
// The hold is off by default until it passes this fixture; the new arm turns it on.
if (ARM === 'new') process.env.REPLAY_JAVA_OPTS = `${process.env.REPLAY_JAVA_OPTS ?? ''} -Dmineagen.fight.spawnerHold=true`.trim();
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jar: path.basename(jar), jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), arm: ARM, seeds: SEEDS, variants: VARIANTS, runMin: RUN_MIN, until: UNTIL,
	tickRate: fixtureTickRate(), naturalMobSpawning: false, primaryScore: 'rods held at the end of the window; 0 after a death', node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Rods';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
// "Rods has 1 [deaths]": the score is the number after "has".
const deathCount = async s => Number(/has (\d+)/.exec(String(await s.command(`scoreboard players get ${AGENT} deaths`)))?.[1] ?? 0);
const NETHER = 'execute in minecraft:the_nether run';
// The room: spawner at SX,SY,SZ; floor top at FLOOR (feet y); the bridge runs west from the room's open side.
const SX = 1000, SZ = 1000, FLOOR = 80, SY = FLOOR + 1;
const START = [SX - 13.5, FLOOR, SZ + 0.5];
const WITHERS = [[SX - 6.5, FLOOR, SZ - 2.5], [SX - 5.5, FLOOR, SZ + 3.5]];

const runs = [];
const planned = SEEDS.length * VARIANTS.length;

async function build(s) {
	const c = cmd => s.command(`${NETHER} ${cmd}`);
	await c(`forceload add ${SX - 48} ${SZ - 32} ${SX + 24} ${SZ + 24}`);
	// Clear the volume (two fills: a fill is capped at 32768 blocks), then the safety floor 9 blocks under the deck.
	await c(`fill ${SX - 40} ${FLOOR - 9} ${SZ - 15} ${SX + 15} ${FLOOR + 2} ${SZ + 15} minecraft:air`);
	await c(`fill ${SX - 40} ${FLOOR + 3} ${SZ - 15} ${SX + 15} ${FLOOR + 15} ${SZ + 15} minecraft:air`);
	await c(`fill ${SX - 40} ${FLOOR - 10} ${SZ - 15} ${SX + 15} ${FLOOR - 10} ${SZ + 15} minecraft:netherrack`);
	// Room floor, walls (5 high) with the west side open 5 wide, the raised spawner block.
	await c(`fill ${SX - 7} ${FLOOR - 1} ${SZ - 7} ${SX + 7} ${FLOOR - 1} ${SZ + 7} minecraft:nether_bricks`);
	await c(`fill ${SX - 7} ${FLOOR} ${SZ - 7} ${SX + 7} ${FLOOR + 4} ${SZ + 7} minecraft:nether_bricks hollow`);
	await c(`fill ${SX - 6} ${FLOOR} ${SZ - 6} ${SX + 6} ${FLOOR + 4} ${SZ + 6} minecraft:air`);
	await c(`fill ${SX - 6} ${FLOOR + 5} ${SZ - 6} ${SX + 6} ${FLOOR + 5} ${SZ + 6} minecraft:air`);
	await c(`fill ${SX - 7} ${FLOOR} ${SZ - 2} ${SX - 7} ${FLOOR + 3} ${SZ + 2} minecraft:air`);
	await c(`setblock ${SX} ${FLOOR} ${SZ} minecraft:nether_bricks`);
	const spawner = await c(`setblock ${SX} ${SY} ${SZ} minecraft:spawner{SpawnData:{entity:{id:"minecraft:blaze"}}}`);
	// The bridge: a 5-wide deck with fence rails, over open air.
	await c(`fill ${SX - 30} ${FLOOR - 1} ${SZ - 2} ${SX - 8} ${FLOOR - 1} ${SZ + 2} minecraft:nether_bricks`);
	await c(`fill ${SX - 30} ${FLOOR} ${SZ - 3} ${SX - 8} ${FLOOR} ${SZ - 3} minecraft:nether_brick_fence`);
	await c(`fill ${SX - 30} ${FLOOR} ${SZ + 3} ${SX - 8} ${FLOOR} ${SZ + 3} minecraft:nether_brick_fence`);
	await c(`fill ${SX - 31} ${FLOOR - 1} ${SZ - 3} ${SX - 31} ${FLOOR + 2} ${SZ + 3} minecraft:nether_bricks`);
	const check = await c(`data get block ${SX} ${SY} ${SZ} SpawnData`);
	if (!/blaze/.test(check)) throw new Error(`spawner not set: ${spawner} / ${check}`);
}

async function register(s) {
	let e = null, reply = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 30000).catch(() => null);
		const summon = () => s.command(`execute in minecraft:the_nether positioned ${START[0]} ${START[1]} ${START[2]} run mineagen summon gpt-6.1-sol low ${AGENT}`);
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

function follow(s) {
	s.bridge.on('message', (event) => {
		const registered = ['agent_registered', 'registry_entry'].includes(event.type) ? { goalRevision: event.payload.goalRevision ?? event.payload.record?.goalRevision } : null;
		const control = registered ?? (event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null);
		if (control == null || event.agentId !== s.record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= s.record.goalRevision) return;
		if (['queue', 'dequeue'].includes(control.operation)) return;
		s.record.goalRevision = control.goalRevision;
		s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
	});
	const rawObserve = s.observe;
	s.observe = async () => {
		for (let attempt = 0; ; attempt++) {
			try { return await rawObserve(); } catch (error) {
				const current = /current revision (\d+)/.exec(String(error?.message))?.[1];
				if (current && attempt < 3) { s.record.goalRevision = Number(current); await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {}); continue; }
				if (/TIMEOUT observation/.test(String(error?.message)) && attempt < 2) continue;
				throw error;
			}
		}
	};
}

const rodsHeld = o => (o?.inventory?.items ?? []).filter(i => i.itemId === 'minecraft:blaze_rod').reduce((n, i) => n + (i.count ?? 0), 0);
const breadHeld = o => (o?.inventory?.items ?? []).filter(i => i.itemId === 'minecraft:bread').reduce((n, i) => n + (i.count ?? 0), 0);

async function kit(s) {
	await s.command(`clear ${AGENT}`);
	for (const [slot, item] of [['hotbar.0', 'iron_sword'], ['hotbar.1', 'bow'], ['hotbar.2', 'cobblestone 64'], ['hotbar.3', 'bread 16'], ['inventory.0', 'arrow 64'],
		['weapon.offhand', 'shield'], ['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']])
		await s.command(`item replace entity ${AGENT} ${slot} with minecraft:${item}`);
	await s.command(`effect clear ${AGENT}`);
	await s.command(`effect give ${AGENT} minecraft:instant_health 1 10 true`);
	await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
	await s.command(`extinguish ${AGENT}`).catch(() => {});
}

/** The coordinator's default reflexes with its automatic stance; sent again whenever the stance moves. */
function stanceKeeper(s) {
	const book = new ReflexBook({ instincts: true });
	return async (observation) => {
		const seen = ARM === 'old' ? { ...observation, entities: (observation.entities ?? []).filter(e => e.type !== 'minecraft:wither_skeleton') } : observation;
		if (!book.observeContext(s.record.agentId, seen)) return book.stance(s.record.agentId);
		await s.bridge.send('reflex_update', s.record.agentId, { ...book.payload(s.record.agentId), yield: false }).catch(() => {});
		return book.stance(s.record.agentId);
	};
}

async function oneRun(s, seed, variant, keepStance) {
	const startedAt = Date.now();
	await s.normalRate();
	await s.command(`${NETHER} kill @e[type=!minecraft:player,x=${SX},y=${SY},z=${SZ},distance=..64]`);
	for (let attempt = 0; attempt < 10 && !((await health(s).catch(() => 0)) > 0); attempt++) {
		await s.bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free spawner fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] }).catch(() => {});
		await s.act('respawn', {}).catch(() => {});
		await s.gameSleep(1500);
	}
	await build(s);
	await s.command(`${NETHER} tp ${AGENT} ${START[0]} ${START[1]} ${START[2]} -90 0`);
	await kit(s);
	await s.idleSleep(3500);
	await s.command(`${NETHER} kill @e[type=!minecraft:player,x=${SX},y=${SY},z=${SZ},distance=..64]`);
	await s.command(`${NETHER} tp ${AGENT} ${START[0]} ${START[1]} ${START[2]} -90 0`);
	await kit(s);
	if (variant === 'withers') for (const [x, y, z] of WITHERS) await s.command(`${NETHER} summon minecraft:wither_skeleton ${x} ${y} ${z} {PersistenceRequired:1b}`);
	await keepStance(await s.observe());
	const deathsBefore = await deathCount(s);
	// The coordinator re-reads the stance on every observation, also while a long fight_until runs.
	const stanceTimer = setInterval(() => { if (s.observation) keepStance(s.observation).catch(() => {}); }, 500);
	await s.fastRate();
	const timer = await s.gameTimer({ worldTicks: true });
	const window = RUN_MIN * 60_000;
	const row = { seed, variant, arm: ARM, rodsAtEnd: 0, maxRods: 0, reachedMin: null, deaths: 0, minHealth: 20, calls: {}, codes: {}, messages: [], stances: {}, startedAt };
	const look = await s.act('look_at', { x: SX + 0.5, y: SY + 0.5, z: SZ + 0.5 }).catch(e => ({ reasonCode: String(e.message) }));
	row.look = look.reasonCode;
	let dead = false, stale = 0;
	while ((await timer.elapsed()) < window) {
		const o = await s.observe().catch(() => null);
		if (o === null) { await sleep(200); continue; }
		const stance = await keepStance(o);
		row.stances[stance ?? 'none'] = (row.stances[stance ?? 'none'] ?? 0) + 1;
		const h = o.player?.health ?? 20;
		row.minHealth = Math.min(row.minHealth, h);
		if ((await deathCount(s)) > deathsBefore || h <= 0 || o.player?.dead || (await health(s).catch(() => 1)) <= 0) { dead = true; break; }
		const rods = rodsHeld(o);
		row.maxRods = Math.max(row.maxRods, rods);
		if (rods >= UNTIL) { row.reachedMin ??= +((await timer.elapsed()) / 60_000).toFixed(1); break; }
		const left = window - (await timer.elapsed());
		let type, args;
		if (h < 10 && breadHeld(o) > 0 && (o.player?.food ?? o.player?.foodLevel ?? 0) < 20) {
			await s.act('select_item', { itemId: 'minecraft:bread' }).catch(() => {});
			type = 'use_item'; args = { durationMs: 1700, expectedItemId: 'minecraft:bread' };
		} else if (h <= 6) {
			// Hurt and full: wait to regrow above the call's 6-health floor, as a model would, rather than reissue at once.
			type = 'wait'; args = { durationMs: 2000 };
		} else {
			type = 'fight_until'; args = { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: UNTIL, fleeAtHealth: 6, timeoutMs: Math.max(1000, Math.min(600_000, left)) };
		}
		// The mod can move the goal revision on (a low-health hand-back) with no goal_control the fixture follows: adopt it.
		if (Number.isSafeInteger(o.goalRevision) && o.goalRevision > s.record.goalRevision) {
			s.record.goalRevision = o.goalRevision;
			await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
		}
		const result = await s.act(type, args, Math.max(65_000, left + 30_000)).catch(e => ({ state: 'ERROR', reasonCode: 'FIXTURE_ERROR', message: String(e.message) }));
		if (result.reasonCode === 'STALE_REVISION') {
			if (++stale > 60) throw new Error(`STALE_REVISION loop: fixture revision ${s.record.goalRevision}, observed ${o.goalRevision}`);
			const fresh = await s.observe().catch(() => null);
			if (Number.isSafeInteger(fresh?.goalRevision) && fresh.goalRevision > s.record.goalRevision) s.record.goalRevision = fresh.goalRevision;
			await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
			await s.gameSleep(1000);
			continue;
		}
		stale = 0;
		row.calls[type] = (row.calls[type] ?? 0) + 1;
		if (type === 'fight_until') {
			row.codes[result.reasonCode] = (row.codes[result.reasonCode] ?? 0) + 1;
			row.messages.push(`${((await timer.elapsed()) / 60_000).toFixed(1)}m ${result.reasonCode}: ${String(result.message ?? '').slice(0, 900)}`);
		}
		if (result.reasonCode === 'AGENT_DEAD') { dead = true; break; }
		if (['NO_TARGET_SEEN', 'FIXTURE_ERROR', 'AREA_CLEARED'].includes(result.reasonCode)) await s.gameSleep(1000);
	}
	clearInterval(stanceTimer);
	row.gameMin = +((await timer.elapsed()) / 60_000).toFixed(1);
	row.tick = await timer.rates();
	await s.normalRate();
	if (s.observation?.currentAction?.active) await s.bridge.send('action_cancel', s.record.agentId, { goalRevision: s.record.goalRevision, actionId: s.lastActionId }).catch(() => {});
	row.deaths = (await deathCount(s)) - deathsBefore;
	if (dead && row.deaths === 0) row.deaths = 1;
	const last = await s.observe().catch(() => null);
	row.rodsAtEnd = row.deaths > 0 ? 0 : Math.max(rodsHeld(last), row.reachedMin !== null ? UNTIL : 0);
	row.withersLeft = (String(await s.command(`${NETHER} execute if entity @e[type=minecraft:wither_skeleton,x=${SX},y=${SY},z=${SZ},distance=..64]`)).match(/(\d+)/) ?? [0, 0])[1];
	row.bar = row.reachedMin !== null && row.deaths === 0;
	row.pass = row.bar;
	row.finishedAt = Date.now();
	return row;
}

const health = async s => { const text = await s.command(`data get entity ${AGENT} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };

for (const seed of SEEDS) {
	let s = null;
	try {
		s = await boot(path.join(out, `seed-${seed}`), { jar, template, port, world: null, seed, goalTicks: 72_000, tickRate: fixtureTickRate(), worldCache: true });
		follow(s);
		await s.command('difficulty normal');
		await s.command('gamerule minecraft:spawn_mobs false');
		await build(s);
		await register(s);
		const keepStance = stanceKeeper(s);
		for (const variant of VARIANTS) {
			const row = await oneRun(s, seed, variant, keepStance).catch(error => ({ seed, variant, arm: ARM, error: String(error?.stack ?? error).slice(0, 1500), startedAt: Date.now(), finishedAt: Date.now() }));
			runs.push(row);
			console.log(`[spawner-hold] ${ARM} seed ${seed} ${variant}: rods ${row.rodsAtEnd ?? '-'} (max ${row.maxRods ?? '-'}), ${row.reachedMin === null || row.reachedMin === undefined ? `no ${UNTIL} in ${row.gameMin ?? '-'} min` : `${UNTIL} at ${row.reachedMin} min`}, deaths ${row.deaths ?? '-'}, min hp ${row.minHealth ?? '-'}, codes ${JSON.stringify(row.codes ?? {})}${row.error ? ` ERROR ${row.error.slice(0, 300)}` : ''}`);
			await writeFile(path.join(out, 'runs.json'), JSON.stringify(runs, null, 1));
		}
	} catch (error) {
		runs.push({ seed, arm: ARM, error: String(error?.stack ?? error).slice(0, 1500) });
		console.error(error);
	} finally {
		await s?.stop().catch(() => {});
	}
}
const summary = Object.fromEntries(VARIANTS.map(variant => {
	const rows = runs.filter(r => r.variant === variant && !r.error);
	return [variant, { arm: ARM, runs: rows.length, reachedUntil: rows.filter(r => r.reachedMin !== null && r.reachedMin !== undefined).length, deaths: rows.reduce((a, r) => a + (r.deaths ?? 0), 0),
		rods: rows.map(r => r.rodsAtEnd), minutesTo: rows.map(r => r.reachedMin), passBar: rows.filter(r => r.bar).length >= 3 && rows.reduce((a, r) => a + (r.deaths ?? 0), 0) <= 1 }];
}));
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
const report = await finishRun(runs, { file: path.join(out, 'result.json'), planned, strict: false });
process.exit(report.exitCode);
