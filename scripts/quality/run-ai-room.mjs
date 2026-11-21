#!/usr/bin/env node
// One AI room: a practice room played by the real model through the production coordinator.
//   node scripts/quality/run-ai-room.mjs ROOMS.json ROOM_ID OUT_DIR JAR [--model M] [--effort E] [--service-tier T]
// ROOMS.json is a scenario file (scripts/quality/ai-rooms.json): seed, goal text, setup, durationBudgetMs (the time
// cap) and successCheck, plus aiRoom { standIn, pass: { noDamage } }. The room plays through run-ladder.mjs, the same
// runner the route ladder uses: run-scenarios.mjs starts a fresh fixed-seed server, applies the setup, launches the
// coordinator with the Codex provider, starts the goal and samples the player once a second; ladder-evaluator.mjs
// judges the check and stops the room as soon as it holds. Ports come from SLOT_PORT_BASE (bridge, RCON, game).
// The room plays at 20 ticks per second: provider timeouts are wall time, so a raised tick rate would give the model
// less game time per call than a player has. FIXTURE_TICK_RATE other than 20 is refused.
// Writes OUT/result.json and OUT/result-summary.json through finishRun, one row: pass when the check held with no
// death (and no damage when aiRoom.pass.noDamage), with deaths, damageTaken (vanilla damage_taken, HP), modelCalls,
// playMinutes and minutesToGoal. A row is INVALID, never a pass or a fail, when the run was not fully measured, the
// model made no call, or the death or damage counter is missing. The ladder's own output stays in OUT/ladder.
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ladderRow, parseLadderArgs, runLadder } from './run-ladder.mjs';
import { finishRun } from './lib/fixture-run.mjs';

export const CODEX_CLI_VERSION = '0.171.0';

/** Puts a signed-in codex CLI within reach of the coordinator; returns what to undo and what was found. */
export async function prepareCodex(env = process.env, { exec = execFileSync } = {}) {
	env.PATH = [path.join(os.homedir(), '.local', 'bin'), env.PATH].filter(Boolean).join(path.delimiter);
	const version = () => { try { return exec('codex', ['--version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
	let cli = version();
	const wanted = env.CODEX_CLI_VERSION ?? CODEX_CLI_VERSION;
	if (!cli || (env.CODEX_CLI_VERSION && !cli.endsWith(wanted))) {
		exec('npm', ['install', '-g', '--prefix', path.join(os.homedir(), '.local'), `@openai/codex@${wanted}`], { env, stdio: ['ignore', 'ignore', 'inherit'], timeout: 5 * 60_000 });
		cli = version();
		if (!cli) throw new Error(`codex CLI ${wanted} did not install`);
	}
	let home = null;
	if (env.CODEX_AUTH_FILE) {
		home = await mkdtemp(path.join(os.tmpdir(), 'ai-room-codex-'));
		await chmod(home, 0o700);
		await copyFile(env.CODEX_AUTH_FILE, path.join(home, 'auth.json'));
		await chmod(path.join(home, 'auth.json'), 0o600);
		env.CODEX_HOME = home;
	}
	for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
	return { cli, home, cleanup: () => home ? rm(home, { recursive: true, force: true }) : Promise.resolve() };
}

const USAGE = `Usage: run-ai-room.mjs ROOMS.json ROOM_ID OUT_DIR JAR [--model gpt-6.2-sol] [--effort low] [--service-tier default]
	Plays one AI room with the Codex provider. Requires JAVA_HOME, ARENA_HEADLESS_SERVER_TEMPLATE, SLOT_PORT_BASE and a
	signed-in codex CLI on PATH. Exit 1 = the room was failed, exit 2 = invalid evidence; --descriptive exits 0.`;

/** The room's row from the ladder's run: pass, counters, and every reason the evidence is not complete. */
export function aiRoomRow(room, run, { startedAt, finishedAt }) {
	const ladder = ladderRow(run), m = run.metrics ?? {};
	const integrity = [];
	if (run.measurementStatus !== 'MEASURED') integrity.push({ file: 'measurement', error: `status ${run.measurementStatus ?? 'unknown'} (${run.termination ?? 'no termination'})` });
	if (!(m.modelCalls > 0)) integrity.push({ file: 'provider', error: 'the model made no call' });
	if (!Number.isFinite(m.deaths)) integrity.push({ file: 'deaths', error: 'no death counter' });
	if (!Number.isFinite(m.damageTaken)) integrity.push({ file: 'damage_taken', error: 'no damage counter' });
	if (run.evaluation?.status !== 'EVALUATED') integrity.push({ file: 'evaluation', error: `check not evaluated (${run.evaluation?.status ?? 'none'})` });
	const noDamage = room.aiRoom?.pass?.noDamage === true;
	const checkHeld = ladder.result === 'PASS';
	const pass = checkHeld && m.deaths === 0 && (!noDamage || m.damageTaken === 0);
	const failReason = pass ? null : !checkHeld ? `check not met: ${ladder.progressText ?? room.successCheck}` : m.deaths ? `died ${m.deaths}x` : `took ${m.damageTaken} damage`;
	return { name: room.name, room: room.name, scenario: room.id, player: 'model', provider: run.profile?.provider ?? null, model: run.profile?.model ?? null, effort: run.profile?.reasoningEffort ?? null,
		pass, ...(failReason ? { failReason } : {}), ...(integrity.length ? { integrity } : {}), check: room.successCheck, checkHeld, noDamage,
		deaths: Number.isFinite(m.deaths) ? m.deaths : null, damageTaken: Number.isFinite(m.damageTaken) ? m.damageTaken : null,
		modelCalls: Number.isFinite(m.modelCalls) ? m.modelCalls : null, playModelCalls: m.playModelCalls ?? null, costEstimateUsd: m.costEstimateUsd ?? null,
		playMinutes: ladder.observedMinutes, minutesToGoal: ladder.minutesToGoal, capMinutes: room.durationBudgetMs / 60000, progress: ladder.progressText,
		termination: run.termination ?? null, runnerTermination: run.runnerTermination ?? null, measurementStatus: run.measurementStatus ?? null, observerErrors: run.observerErrors ?? [],
		tickRate: 20, startedAt, finishedAt };
}

export function aiRoomLadderArgs({ rooms, id, out, jar, model = 'gpt-6.2-sol', effort = 'low', serviceTier = 'default', env = process.env }) {
	return ['--scenario-file', rooms, '--scenarios', id, '--provider', 'codex', '--model', model, '--effort', effort, '--service-tier', serviceTier,
		'--jar', jar, '--out', path.join(out, 'ladder'), '--port-base', String(env.SLOT_PORT_BASE),
		'--java', path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '--server-template', env.ARENA_HEADLESS_SERVER_TEMPLATE];
}

async function main(args) {
	if (args.includes('--help')) { console.log(USAGE); return; }
	const descriptive = args.includes('--descriptive'), argv = args.filter(arg => arg !== '--descriptive');
	const [rooms, id, out, jar, ...rest] = argv;
	const flags = {};
	for (let i = 0; i < rest.length; i += 2) {
		if (!['--model', '--effort', '--service-tier'].includes(rest[i]) || !rest[i + 1]) throw new Error(`unexpected argument ${rest[i]}\n${USAGE}`);
		flags[rest[i].slice(2).replace(/-(\w)/g, (_, ch) => ch.toUpperCase())] = rest[i + 1];
	}
	if (!rooms || !id || !out || !jar) throw new Error(USAGE);
	if (!process.env.JAVA_HOME || !process.env.ARENA_HEADLESS_SERVER_TEMPLATE || !process.env.SLOT_PORT_BASE) { console.error(`JAVA_HOME, ARENA_HEADLESS_SERVER_TEMPLATE and SLOT_PORT_BASE are required\n${USAGE}`); process.exitCode = 2; return; }
	if ((process.env.FIXTURE_TICK_RATE ?? '20') !== '20') { console.error('AI rooms play at 20 ticks per second: provider timeouts are wall time. Unset FIXTURE_TICK_RATE.'); process.exitCode = 2; return; }
	const data = JSON.parse(await readFile(rooms, 'utf8'));
	const room = data.scenarios.find(s => s.id === id || s.name === id);
	if (!room) throw new Error(`no room ${id} in ${rooms}`);
	const startedAt = Date.now();
	let row, codex = null;
	try {
		codex = await prepareCodex();
		const options = parseLadderArgs(aiRoomLadderArgs({ rooms: path.resolve(rooms), id: room.id, out: path.resolve(out), jar: path.resolve(jar), ...flags }));
		const [run] = await runLadder(options);
		row = { ...aiRoomRow(room, run, { startedAt, finishedAt: Date.now() }), codexCli: codex.cli };
	} catch (error) {
		row = { name: room.name, room: room.name, scenario: room.id, player: 'model', pass: false, error: error.message, deaths: null, damageTaken: null, modelCalls: null, startedAt, finishedAt: Date.now() };
	} finally { await codex?.cleanup().catch(() => {}); }
	console.log(JSON.stringify(row, null, 2));
	await finishRun([row], { file: path.join(path.resolve(out), 'result.json'), strict: !descriptive });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
}
