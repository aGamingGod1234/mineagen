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
// model made no call, or the death or damage counter is missing. The ladder's own output stays in OUT/ladder, and the
// run's artifacts (coordinator and model logs, samples) are copied to OUT/artifacts without the world (server/), the
// Codex workspace (it holds a copy of the sign-in) and the RCON password.
// Codex: with CODEX_AUTH_FILE set (room-batch --player model sends the sign-in as a batch input), the room copies it
// into a fresh private CODEX_HOME beside that file (on a batch machine: ~/batch/inputs, outside OUT and inside the folder
// the warm pool wipes on every lease and return, so even a room killed with -9 leaves no copy on a reusable machine) and
// deletes it after. A machine without the codex CLI gets @openai/codex@CODEX_CLI_VERSION (default below) under ~/.local.
// When Codex rewrote the sign-in during the room, the room exits 4 and says so; room-batch stops the batch on it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ladderRow, parseLadderArgs, runLadder } from './run-ladder.mjs';
import { finishRun } from './lib/fixture-run.mjs';

const SKIP_ARTIFACTS = new Set(['server', 'provider-workspaces', 'rcon-password.txt', 'auth.json']);
/** Copies a run's artifact folder into the room's output, leaving out the world and anything that holds a credential. */
export function copyArtifacts(from, to) {
	return cp(from, to, { recursive: true, filter: source => source === from || !SKIP_ARTIFACTS.has(path.basename(source)) });
}

/** Copies the run's evidence into OUT/artifacts; returns why it could not, or null. */
export async function keepArtifacts(run, out) {
	if (!run?.artifacts) return 'the run left no artifacts';
	return copyArtifacts(run.artifacts, path.join(out, 'artifacts')).then(() => null, error => error.message);
}

const sha256 = async file => { try { return createHash('sha256').update(await readFile(file)).digest('hex'); } catch { return null; } };
/**
 * Whether Codex rewrote the sign-in during the run: a refresh rotates the token and can sign out every other copy, so a
 * batch must stop at once. Compares the sent file with the run's private home and the coordinator's workspace copy.
 */
export async function signInChanged(sentHash, files) {
	for (const file of files) { const now = await sha256(file); if (now !== null && now !== sentHash) return file; }
	return null;
}

export const CODEX_CLI_VERSION = '0.171.0';
export const SIGN_IN_REFRESHED_EXIT = 4;

// Windows runs codex and npm through their .cmd shims, which only a shell can start; the arguments here are fixed words.
const runTool = (exec, platform) => (command, args, options) => platform === 'win32' ? exec(command, args, { ...options, shell: true }) : exec(command, args, options);

/** Puts a signed-in codex CLI within reach of the coordinator; returns what to undo and what was found. */
export async function prepareCodex(env = process.env, { exec = execFileSync, platform = process.platform } = {}) {
	env.PATH = [path.join(os.homedir(), '.local', 'bin'), env.PATH].filter(Boolean).join(path.delimiter);
	const run = runTool(exec, platform);
	const wanted = env.CODEX_CLI_VERSION ?? CODEX_CLI_VERSION;
	if (!/^[0-9A-Za-z.+-]+$/.test(wanted)) throw new Error(`CODEX_CLI_VERSION must be a version, got ${wanted}`);
	const version = () => { try { return run('codex', ['--version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
	let cli = version();
	if (!cli || (env.CODEX_CLI_VERSION && !cli.endsWith(wanted))) {
		run('npm', ['install', '-g', '--prefix', path.join(os.homedir(), '.local'), `@openai/codex@${wanted}`], { env, stdio: ['ignore', 'ignore', 'inherit'], timeout: 5 * 60_000 });
		cli = version();
		if (!cli) throw new Error(`codex CLI ${wanted} did not install`);
	}
	let home = null;
	if (env.CODEX_AUTH_FILE) {
		home = await mkdtemp(path.join(path.dirname(path.resolve(env.CODEX_AUTH_FILE)), '.ai-room-codex-'));
		await chmod(home, 0o700);
		await copyFile(env.CODEX_AUTH_FILE, path.join(home, 'auth.json'));
		await chmod(path.join(home, 'auth.json'), 0o600);
		env.CODEX_HOME = home;
	}
	for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
	const sentHash = env.CODEX_AUTH_FILE ? await sha256(env.CODEX_AUTH_FILE) : null;
	return { cli, home, sentHash, cleanup: () => home ? rm(home, { recursive: true, force: true }) : Promise.resolve() };
}

const USAGE = `Usage: run-ai-room.mjs ROOMS.json ROOM_ID OUT_DIR JAR [--model gpt-6.2-sol] [--effort low] [--service-tier default]
	Plays one AI room with the Codex provider. Requires JAVA_HOME, ARENA_HEADLESS_SERVER_TEMPLATE, SLOT_PORT_BASE and a
	signed-in codex CLI on PATH. Exit 1 = the room was failed, exit 2 = invalid evidence; --descriptive exits 0.`;

/** The room's row from the ladder's run: pass, counters, and every reason the evidence is not complete. */
export function aiRoomRow(room, run, { startedAt, finishedAt }) {
	const ladder = ladderRow(run), m = run.metrics ?? {};
	const integrity = [];
	// A room the evaluator stops early often ends while the last call's token row is still open, so per-call token rows
	// fall short of the thread totals and run-scenarios marks the run INCOMPLETE. That is token bookkeeping, not game
	// evidence: such a run stays valid and says its token counts are approximate. Any other gap is INVALID.
	const tokensOnly = run.measurementStatus === 'INCOMPLETE' && m.tokenReconciliation?.complete === false && !(run.observerErrors ?? []).length && !(m.coverage?.jsonlDroppedLines > 0);
	if (run.measurementStatus !== 'MEASURED' && !tokensOnly) integrity.push({ file: 'measurement', error: `status ${run.measurementStatus ?? 'unknown'} (${run.termination ?? 'no termination'})` });
	// Goal translation counts in modelCalls; only a gameplay call shows the model played the room (reflexes alone can
	// survive the skeleton room).
	if (!(m.playModelCalls > 0)) integrity.push({ file: 'provider', error: 'the model made no gameplay call' });
	if (!Number.isFinite(m.deaths)) integrity.push({ file: 'deaths', error: 'no death counter' });
	if (!Number.isFinite(m.damageTaken)) integrity.push({ file: 'damage_taken', error: 'no damage counter' });
	// The totals are the highest reading over the samples, so a counter that went unread later (a death or a hit after
	// the last good reading) would still show 0. Any sample without a counter leaves deaths or damage unknown.
	const gaps = m.coverage?.scoreboardGaps;
	if (!gaps) integrity.push({ file: 'scoreboard', error: 'no counter coverage recorded' });
	else for (const [counter, missing] of Object.entries({ deaths: gaps.deaths, damage_taken: gaps.damageTaken })) {
		if (missing !== 0) integrity.push({ file: counter, error: `${missing ?? 'unknown'} samples without the counter` });
	}
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
		tokensReconciled: m.tokenReconciliation?.complete ?? null, termination: run.termination ?? null, runnerTermination: run.runnerTermination ?? null, measurementStatus: run.measurementStatus ?? null, observerErrors: run.observerErrors ?? [],
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
		const refreshed = codex.sentHash ? await signInChanged(codex.sentHash, [path.join(codex.home, 'auth.json'), ...(run?.artifacts ? [path.join(run.artifacts, 'provider-workspaces', 'minecraft-agent', '.codex-home', 'auth.json')] : [])]) : null;
		// The run's own artifacts sit outside OUT on a machine the batch wipes, so a room whose copy failed has no evidence.
		const copyError = await keepArtifacts(run, path.resolve(out));
		row = { ...aiRoomRow(room, run, { startedAt, finishedAt: Date.now() }), codexCli: codex.cli, signInRefreshed: Boolean(refreshed) };
		if (copyError) (row.integrity ??= []).push({ file: 'artifacts', error: `evidence not kept: ${copyError}` });
		if (refreshed) {
			(row.integrity ??= []).push({ file: 'sign-in', error: 'Codex refreshed the sign-in during this room: stop the batch, the other copies may be signed out' });
			console.error('SIGN-IN REFRESHED: Codex rewrote auth.json during this room; stop the batch.');
		}
	} catch (error) {
		row = { name: room.name, room: room.name, scenario: room.id, player: 'model', pass: false, error: error.message, deaths: null, damageTaken: null, modelCalls: null, startedAt, finishedAt: Date.now() };
	} finally { await codex?.cleanup().catch(() => {}); }
	console.log(JSON.stringify(row, null, 2));
	await finishRun([row], { file: path.join(path.resolve(out), 'result.json'), strict: !descriptive });
	if (row.signInRefreshed) process.exitCode = SIGN_IN_REFRESHED_EXIT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
}
