#!/usr/bin/env node
// Provider-free rod pickup fixture (wall breaker rods): node scripts/quality/test-rod-pickup-live.mjs OUT_DIR
// Does the body keep the rod a blaze it killed dropped? Real games (22 Nov checkpoints) killed blazes and left the rod:
// it fell off a fortress deck below the edge and the pickup walk stopped at the brink, or the kill result saw no drop.
// A nether-brick deck (feet y 80) ends at an edge; 3 blocks below it a lower floor runs on (feet y 77), out of sight from
// the deck. The body stands 1.5 blocks back from the edge with an iron sword; a still blaze (no AI, no gravity, 1 health)
// hovers just past the edge in sword reach. The stand-in makes the call a model makes: fight_target on it (pursue:false,
// timeoutMs 15000; collect:true, or collect unset in the *-clear scenarios). A blaze rod drops 0 or 1 time per kill, so
// each trial kills up to MAX_BLAZES blazes until one drops a rod (server truth), then scores that rod.
// Scenarios: edge3 (the blaze over the edge, its rod lands on the lower floor), edge3-clear (the same, collect unset),
// floor (control: the blaze over the deck, its rod lands in view on the deck).
// Per row: pass = the rod is in the inventory when the fight hands back and the body is alive. Rows that never saw a rod
// drop in MAX_BLAZES kills are errors (unknown, not a pass or a fail).
// Env: ARENA_JAR, SCENARIOS (comma list), REPEATS (trials per scenario, default 3), MAX_BLAZES (default 6).
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot, unshownTickRate } from './watch-replay.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-rod-pickup-live.mjs OUT_DIR under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME (ARENA_JAR, SCENARIOS, REPEATS, MAX_BLAZES)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const out = path.resolve(cli[0] ?? 'runtime/rod-pickup-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, MOD_JAR));
if (!existsSync(jar)) { console.error(`no jar at ${jar}`); process.exit(2); }
const SCENARIOS = (process.env.SCENARIOS ?? 'edge3,edge3-clear,floor').split(',').filter(Boolean);
const REPEATS = Number(process.env.REPEATS ?? 3), MAX_BLAZES = Number(process.env.MAX_BLAZES ?? 6);
for (const name of SCENARIOS) if (!['edge3', 'edge3-clear', 'floor'].includes(name)) { console.error(`unknown scenario ${name}`); process.exit(2); }
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const TICK_RATE = unshownTickRate('a new fixture, not yet in a 20 vs 60 TPS A/B');
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jar: path.basename(jar), jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), scenarios: SCENARIOS, repeats: REPEATS, maxBlazes: MAX_BLAZES,
	tickRate: TICK_RATE, naturalMobSpawning: false, primaryScore: 'the dropped rod is in the inventory when the fight hands back', node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Rodder';
const NETHER = 'execute in minecraft:the_nether run';
// The deck's last column is EDGE; its top is at feet y FEET. The lower floor's feet are DROP blocks lower.
const SX = 2000, SZ = 2000, FEET = 80, DROP = 3, EDGE = SX + 2;
const START = [EDGE - 0.5, FEET, SZ + 0.5];
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const deathCount = async s => Number(/has (\d+)/.exec(String(await s.command(`scoreboard players get ${AGENT} deaths`)))?.[1] ?? 0);
const health = async s => { const text = await s.command(`data get entity ${AGENT} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };
const rodsHeld = o => (o?.inventory?.items ?? []).filter(i => i.itemId === 'minecraft:blaze_rod').reduce((n, i) => n + (i.count ?? 0), 0);
// Server truth: how many blaze rod item entities lie in the room.
const rodsLying = async s => Number(/(\d+)/.exec(String(await s.command(`${NETHER} execute if entity @e[type=minecraft:item,nbt={Item:{id:"minecraft:blaze_rod"}},x=${SX},y=${FEET},z=${SZ},distance=..32]`)))?.[1] ?? 0);

async function build(s) {
	const c = cmd => s.command(`${NETHER} ${cmd}`);
	await c(`forceload add ${SX - 24} ${SZ - 24} ${SX + 24} ${SZ + 24}`);
	await c(`fill ${SX - 12} ${FEET - DROP - 3} ${SZ - 8} ${SX + 14} ${FEET + 8} ${SZ + 8} minecraft:air`);
	// The lower floor, under and past the deck's edge, and walls round it so a drop cannot roll away.
	await c(`fill ${SX - 8} ${FEET - DROP - 1} ${SZ - 5} ${SX + 10} ${FEET - DROP - 1} ${SZ + 5} minecraft:nether_bricks`);
	await c(`fill ${SX - 9} ${FEET - DROP} ${SZ - 6} ${SX + 11} ${FEET - DROP + 1} ${SZ + 6} minecraft:nether_bricks hollow`);
	await c(`fill ${SX - 8} ${FEET - DROP} ${SZ - 5} ${SX + 10} ${FEET - DROP + 1} ${SZ + 5} minecraft:air`);
	// The deck: a 5-wide nether-brick walkway at feet y FEET ending at EDGE, a solid wall of bricks under it to the floor.
	await c(`fill ${SX - 8} ${FEET - DROP} ${SZ - 2} ${EDGE} ${FEET - 1} ${SZ + 2} minecraft:nether_bricks`);
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

async function reset(s, yaw) {
	await s.command(`${NETHER} kill @e[type=!minecraft:player,x=${SX},y=${FEET},z=${SZ},distance=..32]`);
	await s.command(`clear ${AGENT}`);
	await s.command(`item replace entity ${AGENT} hotbar.0 with minecraft:iron_sword`);
	await s.command(`item replace entity ${AGENT} hotbar.1 with minecraft:cobblestone 32`);
	await s.command(`effect give ${AGENT} minecraft:instant_health 1 10 true`);
	await s.command(`${NETHER} tp ${AGENT} ${START[0]} ${START[1]} ${START[2]} ${yaw} 10`);
	await s.gameSleep(1500);
	await s.act('select_item', { itemId: 'minecraft:iron_sword' }).catch(() => {});
}

async function trial(s, scenario, repeat) {
	const startedAt = Date.now();
	const over = scenario !== 'floor';
	// Over the edge: 1.3 blocks past the deck's last column, a little above the feet; on the deck: 2.3 blocks back from the body.
	const blazeAt = over ? [EDGE + 1.3, FEET + 0.3, SZ + 0.5] : [EDGE - 2.8, FEET + 0.3, SZ + 0.5];
	const yaw = over ? -90 : 90;
	const row = { name: `${scenario}-${repeat}`, scenario, repeat, blazes: 0, dropped: false, rodsHeld: 0, rodLeft: false, deaths: 0, codes: {}, message: null, startedAt };
	const deathsBefore = await deathCount(s);
	for (let n = 1; n <= MAX_BLAZES && !row.dropped; n++) {
		await s.normalRate();
		await reset(s, yaw);
		// UUID:[I;a,b,c,d] is the hex of the four ints: aaaaaaaa-bbbb-bbbb-cccc-ccccdddddddd.
		const a = SCENARIOS.indexOf(scenario) + 1;
		const uuid = [a, 7, repeat, n];
		const hex = v => v.toString(16).padStart(8, '0');
		const id = `${hex(a)}-0000-0007-0000-${repeat.toString(16).padStart(4, '0')}${hex(n)}`;
		await s.command(`${NETHER} summon minecraft:blaze ${blazeAt.join(' ')} {NoAI:1b,NoGravity:1b,Silent:1b,Health:1f,PersistenceRequired:1b,UUID:[I;${uuid.join(',')}]}`);
		await s.gameSleep(800);
		await s.observe();
		const args = { targetId: id, pursue: false, timeoutMs: 15000, ...(scenario === 'edge3-clear' ? {} : { collect: true }) };
		await s.fastRate();
		const result = await s.act('fight_target', args, 60000).catch(e => ({ state: 'ERROR', reasonCode: 'FIXTURE_ERROR', message: String(e.message) }));
		await s.normalRate();
		row.blazes = n;
		row.codes[result.reasonCode] = (row.codes[result.reasonCode] ?? 0) + 1;
		const o = await s.observe().catch(() => null);
		const held = rodsHeld(o), lying = await rodsLying(s);
		if (held > 0 || lying > 0) {
			row.dropped = true;
			row.rodsHeld = held;
			row.rodLeft = lying > 0;
			row.message = String(result.message ?? '').slice(0, 3000);
			row.endedAt = o?.player?.position ?? o?.position ?? null;
		}
	}
	row.deaths = (await deathCount(s)) - deathsBefore;
	if (!((await health(s).catch(() => 0)) > 0) && row.deaths === 0) row.deaths = 1;
	if (!row.dropped) row.error = `no rod dropped in ${MAX_BLAZES} blaze kills`;
	row.pass = row.dropped && row.rodsHeld > 0 && row.deaths === 0;
	row.finishedAt = Date.now();
	return row;
}

const rows = [];
const planned = SCENARIOS.length * REPEATS;
let s = null;
try {
	s = await boot(path.join(out, 'server-run'), { jar, template, port, world: null, seed: '20261122', goalTicks: 72_000, tickRate: TICK_RATE, worldCache: true });
	await s.command('difficulty normal');
	await s.command('gamerule minecraft:spawn_mobs false');
	await build(s);
	await register(s);
	for (const scenario of SCENARIOS) {
		for (let repeat = 1; repeat <= REPEATS; repeat++) {
			const row = await trial(s, scenario, repeat).catch(error => ({ name: `${scenario}-${repeat}`, scenario, repeat, pass: false, error: String(error?.stack ?? error).slice(0, 1500), startedAt: Date.now(), finishedAt: Date.now() }));
			rows.push(row);
			console.log(`[rod-pickup] ${row.name}: ${row.pass ? 'PASS' : 'FAIL'} blazes ${row.blazes ?? '-'}, dropped ${row.dropped ?? '-'}, held ${row.rodsHeld ?? '-'}, left ${row.rodLeft ?? '-'}, deaths ${row.deaths ?? '-'}${row.error ? ` ERROR ${row.error.slice(0, 200)}` : ''}`);
			await writeFile(path.join(out, 'runs.json'), JSON.stringify(rows, null, 1));
		}
	}
} catch (error) {
	console.error(error);
} finally {
	await s?.stop().catch(() => {});
}
const report = await finishRun(rows, { file: path.join(out, 'result.json'), planned, strict: false });
process.exit(report.exitCode);
