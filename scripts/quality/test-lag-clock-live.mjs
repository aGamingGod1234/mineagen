#!/usr/bin/env node
// Provider-free check that a lagging server does not cut body actions short: node scripts/quality/test-lag-clock-live.mjs OUT_DIR
// Each case runs twice on its own authored fixture (rebuilt each time): first at 20 TPS with a generous timeout, which
// measures how much game time the action needs (D), then on a lagging server with timeoutMs = 1.5 x D. An action that
// counts its timeout in game ticks finishes the second run; one that counts wall time runs out when the server is slow.
//   travel: travel_to 48 blocks along a flat stone runway in the air.
//   dig:    dig_to tunnel east through a solid stone block, maxBlocks 16.
// LAG picks the slow server: rate:10 (/tick rate 10, a steady 100 ms tick, the default) or crowd:N (N pigs crammed into
// one forceloaded pit with entity cramming off: real lag, its achieved rate measured and reported). CASES narrows them;
// REPEATS (default 1) runs each case more times. ARENA_JAR picks the jar. Launch under slot.sh live with
// ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set; operator commands only build the fixture. No model call.
// A calibration run passes when the action ends without timing out; a lagging run passes when it ends with the same
// result code and as far (within a block) as at 20 TPS. Exit code (strict, the default): 0 every run passed, 1 a run
// failed, 2 invalid evidence (the server or a run errored, or runs are missing). --descriptive reports without one.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot } from './watch-replay.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-lag-clock-live.mjs [OUT_DIR] [--strict|--descriptive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME (CASES, LAG, REPEATS, ARENA_JAR)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const out = path.resolve(cli.filter(arg => !['--strict', '--descriptive'].includes(arg))[0] ?? 'runtime/lag-clock');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, 'build/libs/arena-agents-0.2.0.jar'));
if (!existsSync(jar)) { console.error(`no jar at ${jar}`); process.exit(2); }
const CASES = (process.env.CASES ?? 'travel,dig').split(',');
const LAG = process.env.LAG ?? 'rate:10';
const REPEATS = Number(process.env.REPEATS ?? 1);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free lagging-server timeout check', jar, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'),
	cases: CASES, lag: LAG, repeats: REPEATS, node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Lag';

const rows = [];
const planned = CASES.length * REPEATS * 2;
const finish = async () => {
	const report = await finishRun(rows, { file: path.join(out, 'result.json'), planned, strict });
	console.log(JSON.stringify(report));
	process.exit(report.exitCode);
};
const s = await boot(out, { jar, template, port, world: null, seed: '20261107', tickRate: 20 }).catch(async (error) => {
	rows.push({ case: 'boot', error: String(error?.stack ?? error).slice(0, 1200) });
	return finish();
});
s.bridge.on('message', (event) => {
	const revision = event?.payload?.goalRevision ?? event?.payload?.record?.goalRevision ?? event?.payload?.control?.goalRevision;
	if (!s.record || event.agentId !== s.record.agentId || !Number.isSafeInteger(revision) || revision <= s.record.goalRevision) return;
	if (event.type === 'goal_control' && ['queue', 'dequeue'].includes(event.payload?.operation)) return;
	s.record.goalRevision = revision;
	s.bridge.send('agent_ready', s.record.agentId, { goalRevision: revision, reconciled: false }).catch(() => {});
});
const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;

// Both fixtures sit at y 100 over x 0..70, z -4..8, forceloaded; each is rebuilt from scratch before every run.
const fixtures = {
	travel: {
		async build() {
			await s.command('fill -2 96 -4 70 110 8 minecraft:air');
			await s.command('fill -2 99 -2 60 99 6 minecraft:smooth_stone');
			await s.command(`tp ${AGENT} 0.5 100 2.5 -90 0`);
		},
		args: timeoutMs => ['travel_to', { x: 48.5, y: 100, z: 2.5, tolerance: 1, build: false, timeoutMs }],
		progress: async start => { const p = await pos(); return p && start ? +(p[0] - start[0]).toFixed(1) : null; },
	},
	dig: {
		async build() {
			await s.command('fill -2 96 -4 70 110 8 minecraft:air');
			await s.command('fill -2 99 -2 24 104 6 minecraft:stone');
			await s.command('fill 0 100 2 0 101 2 minecraft:air');
			await s.command(`tp ${AGENT} 0.5 100 2.5 -90 0`);
		},
		args: timeoutMs => ['dig_to', { pattern: 'tunnel', heading: 'east', maxBlocks: 16, timeoutMs }],
		progress: async start => { const p = await pos(); return p && start ? +(p[0] - start[0]).toFixed(1) : null; },
	},
};

let crowd = 0;
async function slow() {
	const [kind, value] = LAG.split(':');
	if (kind === 'rate') { await s.command(`tick rate ${Number(value)}`); return; }
	if (kind !== 'crowd') throw new Error(`LAG must be rate:N or crowd:N, got ${LAG}`);
	// A pit of pigs pushing on each other: entity collisions are the classic lag machine.
	if (!crowd) {
		await s.command('forceload add 300 300');
		await s.command('fill 296 99 296 304 106 304 minecraft:glass hollow');
		await s.command('gamerule minecraft:max_entity_cramming 0');
	}
	for (; crowd < Number(value); crowd++) await s.command('summon minecraft:pig 300.5 100 300.5 {NoAI:0b,PersistenceRequired:1b,Silent:1b}');
	await s.command('tick rate 20');
}
async function fast() {
	await s.command('tick rate 20');
	if (crowd) { await s.command('kill @e[type=minecraft:pig]'); crowd = 0; }
}

async function run(name, timeoutMs, condition) {
	const fixture = fixtures[name];
	await fixture.build();
	await sleep(2000);
	if (condition === 'lagging') { await slow(); await sleep(3000); }
	const start = await pos();
	const startedAt = Date.now();
	const g0 = await s.gameTicks(), w0 = Date.now();
	const [type, args] = fixture.args(timeoutMs);
	const r = await s.act(type, args, timeoutMs * 4 + 60_000).catch(error => ({ state: 'ERROR', reasonCode: error.message }));
	const g1 = await s.gameTicks(), w1 = Date.now();
	const held = condition === 'lagging' ? await s.tickReport() : null;
	const row = { case: name, condition, timeoutMs, state: r.state, reasonCode: r.reasonCode, reportedElapsedMs: r.elapsedMs ?? null,
		gameMs: g0 !== null && g1 !== null ? (g1 - g0) * 50 : null, wallMs: w1 - w0, achievedTps: g0 !== null && g1 !== null ? +((g1 - g0) / ((w1 - w0) / 1000)).toFixed(1) : null,
		progressBlocks: await fixture.progress(start), message: String(r.message ?? '').slice(0, 300), held, startedAt };
	if (condition === 'lagging') await fast();
	row.finishedAt = Date.now();
	return row;
}

try {
	await s.command('difficulty peaceful');
	await s.command('gamerule minecraft:advance_time false');
	await s.command('time set 6000');
	await s.command('forceload add -2 -4 70 8');
	let e = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45_000).catch(() => null);
		await s.command(`execute positioned 0.5 100 2.5 run codex summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error('agent never registered');
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start', 120_000);
	await s.command(`codex start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = Math.max(s.record.goalRevision, (await started).payload.goalRevision);
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${AGENT}`);
	await s.command(`item replace entity ${AGENT} container.0 with minecraft:diamond_pickaxe`);
	await s.command(`effect give ${AGENT} minecraft:saturation infinite 1 true`);
	for (let repeat = 0; repeat < REPEATS; repeat++) {
		for (const name of CASES) {
			if (!fixtures[name]) throw new Error(`unknown case ${name}`);
			const calibrate = await run(name, 120_000, 'normal');
			calibrate.pass = !['TIMED_OUT', 'ERROR'].includes(calibrate.state) && Boolean(calibrate.gameMs);
			rows.push({ repeat, ...calibrate });
			console.log(`[lag] ${name} at 20 TPS: ${calibrate.reasonCode} in ${calibrate.gameMs} game ms (${calibrate.wallMs} wall ms), ${calibrate.progressBlocks} blocks`);
			if (['TIMED_OUT', 'ERROR'].includes(calibrate.state) || !calibrate.gameMs) continue;
			const lagged = await run(name, Math.round(calibrate.gameMs * 1.5), 'lagging');
			// Finished as at 20 TPS: the same result code and as far.
			lagged.sameAsNormal = lagged.reasonCode === calibrate.reasonCode && Math.abs((lagged.progressBlocks ?? 0) - (calibrate.progressBlocks ?? 0)) <= 1;
			lagged.pass = lagged.sameAsNormal;
			rows.push({ repeat, ...lagged });
			console.log(`[lag] ${name} lagging (${LAG}, ${lagged.achievedTps} t/s) with timeoutMs ${lagged.timeoutMs}: ${lagged.state} ${lagged.reasonCode} after ${lagged.wallMs} wall ms, ${lagged.gameMs} game ms, ${lagged.progressBlocks} blocks`);
			await writeFile(path.join(out, 'rows.json'), JSON.stringify(rows, null, 1));
		}
	}
} catch (error) {
	console.error(error);
	await writeFile(path.join(out, 'error.txt'), String(error?.stack ?? error));
	rows.push({ case: 'harness', error: String(error?.stack ?? error).slice(0, 1200) });
} finally {
	await writeFile(path.join(out, 'rows.json'), JSON.stringify(rows, null, 1));
	await s.stop().catch(() => {});
	await rm(path.join(out, 'server'), { recursive: true, force: true });
}
const lagged = rows.filter(row => row.condition === 'lagging');
const summary = { lag: LAG, finishedWhileLagging: lagged.filter(row => row.sameAsNormal).length, laggingRuns: lagged.length,
	cases: lagged.map(row => `${row.case}: ${row.reasonCode} (${row.achievedTps} t/s, ${row.progressBlocks} blocks)`) };
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
await finish();
