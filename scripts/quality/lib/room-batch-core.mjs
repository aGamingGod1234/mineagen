// Pure parts of room-batch.mjs: the commands file, the shared room queue with one re-queue after a lost machine, and
// the per-arm merge through finishRun. No machine, network or boat call happens here, so all of it is unit-tested.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeExitRun } from './benchmark-score.mjs';
import { finishRun, roomVerdict } from './fixture-run.mjs';
import { mergeSwitchRecords } from './switch-record.mjs';

const ROOM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Shell-style words: single and double quotes group, a backslash escapes the next character outside single quotes. */
export function splitWords(line) {
	const words = [];
	let word = null, quote = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote === "'") { if (ch === "'") quote = null; else word += ch; continue; }
		if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === '\\' && i + 1 < line.length) word += line[++i];
			else word += ch;
			continue;
		}
		if (/\s/.test(ch)) { if (word !== null) words.push(word); word = null; continue; }
		word ??= '';
		if (ch === "'" || ch === '"') quote = ch;
		else if (ch === '\\' && i + 1 < line.length) word += line[++i];
		else word += ch;
	}
	if (quote) throw new Error(`unclosed ${quote} in: ${line}`);
	if (word !== null) words.push(word);
	return words;
}

/**
 * Commands file -> rooms. One line per room, run once per arm with $JAR standing for that arm's jar and $OUT for a fresh
 * output folder:   @ROOM [VAR=value ...] node scripts/quality/test-x-live.mjs SPOTS.json $OUT $JAR --descriptive
 * A line "@ROOM:ARM ..." gives that arm its own command instead. Blank lines and lines starting with # are skipped.
 */
export function parseCommands(text, arms) {
	if (!arms.length) throw new Error('give at least one arm (--arm NAME=JAR)');
	const rooms = new Map();
	let index = 0;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		index++;
		let label = `c${String(index).padStart(2, '0')}`, rest = line;
		if (line.startsWith('@')) [label, rest] = [line.slice(1).split(/\s+/, 1)[0], line.slice(1).replace(/^\S+\s*/, '')];
		const [room, arm] = label.split(':');
		if (!ROOM_NAME.test(room)) throw new Error(`room name must be letters, digits, ., _ or -: ${label}`);
		if (arm !== undefined && !arms.includes(arm)) throw new Error(`line for ${label} names an unknown arm (arms: ${arms.join(', ')})`);
		const words = splitWords(rest), env = {};
		while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { const [key, ...value] = words.shift().split('='); env[key] = value.join('='); }
		if (words[0] !== 'node' || words.length < 2) throw new Error(`only "node SCRIPT ..." commands run in a room: ${line}`);
		if (!words.includes('$OUT')) throw new Error(`the command needs $OUT as its output folder: ${line}`);
		const entry = rooms.get(room) ?? { room, shared: null, own: {} };
		const command = { env, args: words.slice(1) };
		if (arm === undefined) { if (entry.shared) throw new Error(`room ${room} appears twice`); entry.shared = command; }
		else { if (entry.own[arm]) throw new Error(`room ${room} arm ${arm} appears twice`); entry.own[arm] = command; }
		rooms.set(room, entry);
	}
	return [...rooms.values()].map(({ room, shared, own }) => {
		const lines = arms.map(arm => {
			const command = own[arm] ?? shared;
			if (!command) throw new Error(`room ${room} has no command for arm ${arm}`);
			return { arm, env: { ...command.env }, args: [...command.args] };
		});
		return { room, lines, planned: plannedOf(lines[0].env), plannedByArm: Object.fromEntries(lines.map(line => [line.arm, plannedOf(line.env)])) };
	});
}

/** Rows a room is expected to write: the count its selector names (BUILD_ONLY=a,b is 2), else 1 (an empty selector too). */
export function plannedOf(env) {
	const selector = Object.entries(env).find(([key]) => /(_ONLY|^SPOTS|^CASES)$/.test(key));
	return Math.max(1, selector ? selector[1].split(',').filter(Boolean).length : 1);
}

/**
 * The shared queue. Every worker pulls the next room and plays both of its arms; attempt(worker, room, n) resolves to
 * { lost: false, ... } when the room finished on that worker (whatever its verdict), or { lost: true, reason } when the
 * worker died under it. A lost worker takes no more rooms; its room goes back to the front of the queue once, for a
 * different worker, then is reported lost. replace(), when given, may bring up a new worker for a lost one; release(),
 * when given, is called for a worker that finds the queue empty, and that worker leaves. arrivals are promises of
 * workers still coming up (null for one that never did): each starts pulling rooms the moment it resolves, so no room
 * waits for the slowest machine.
 */
export async function runQueue({ rooms, workers, arrivals = [], attempt, maxAttempts = 2, replace = null, release = null, more = null, log = () => {} }) {
	const queue = rooms.map(room => ({ room, tries: 0, triedOn: new Set() }));
	const all = [...rooms];
	// more(room, outcome) -> rooms to add (top-ups): they join the queue before this worker looks for its next room.
	let settling = 0;
	const settle = async (room, outcome) => {
		if (!more) return;
		settling++;
		try {
			const extra = await Promise.resolve().then(() => more(room, outcome)).catch(error => { log(`top-up after ${room.room} failed: ${error.message}`); return []; });
			for (const added of extra ?? []) { all.push(added); queue.push({ room: added, tries: 0, triedOn: new Set() }); }
		} finally { settling--; wake(); }
	};
	// With top-ups on, a room still playing or being counted may add rooms, so an idle machine is kept until none is.
	const mayAddRooms = worker => Boolean(more) && (settling > 0 || [...live].some(other => other !== worker && other.busy));
	const results = new Map(), live = new Set(), running = [];
	let waiting = [];
	const wake = () => { const list = waiting; waiting = []; for (const done of list) done(); };
	const take = worker => {
		const at = queue.findIndex(item => !item.triedOn.has(worker.id));
		return at < 0 ? null : queue.splice(at, 1)[0];
	};
	const loop = async worker => {
		live.add(worker);
		try {
			while (true) {
				const item = take(worker);
				if (!item) {
					// With nothing left to queue, release() lets the machine go now instead of idling to the end; a room
					// re-queued later goes to a replacement.
					if (release && !queue.length && !mayAddRooms(worker)) { await Promise.resolve().then(() => release(worker)).catch(error => log(`release of ${worker.id} failed: ${error.message}`)); return; }
					// A busy worker may still lose its room back to the queue; otherwise nothing is left for this one.
					if (![...live].some(other => other !== worker && other.busy) && !mayAddRooms(worker)) return;
					await new Promise(done => waiting.push(done));
					continue;
				}
				item.tries++; item.triedOn.add(worker.id); worker.busy = true;
				let outcome;
				try { outcome = await attempt(worker, item.room, item.tries); }
				catch (error) { outcome = { lost: true, reason: String(error?.message ?? error) }; }
				if (!outcome?.lost) { results.set(item.room.room, { ...outcome, lost: false, room: item.room.room, worker: worker.id, attempts: item.tries }); await settle(item.room, results.get(item.room.room)); worker.busy = false; wake(); continue; }
				worker.busy = false;
				// requeue: the machine stopped the room for a planned reason (its cutoff), so the try does not count.
				if (outcome.requeue) { item.tries--; log(`room ${item.room.room} back in the queue from ${worker.id}: ${outcome.reason}`); queue.unshift(item); }
				else {
					log(`room ${item.room.room} lost on ${worker.id} (try ${item.tries}): ${outcome.reason}`);
					if (item.tries < maxAttempts) queue.unshift(item);
					else { results.set(item.room.room, { lost: true, reason: outcome.reason, room: item.room.room, worker: worker.id, attempts: item.tries }); await settle(item.room, results.get(item.room.room)); }
				}
				live.delete(worker);
				wake();
				if (replace && queue.length) {
					const fresh = await Promise.resolve().then(() => replace(worker, outcome)).catch(error => { log(`no replacement for ${worker.id}: ${error.message}`); return null; });
					if (fresh) running.push(loop(fresh));
				}
				return;
			}
		} finally { live.delete(worker); worker.busy = false; wake(); }
	};
	for (const worker of workers) running.push(loop(worker));
	for (const arrival of arrivals) running.push(Promise.resolve(arrival).then(worker => { if (worker) running.push(loop(worker)); }, () => {}));
	for (let i = 0; i < running.length; i++) await running[i];
	// Rooms no worker could take (every machine that could was lost) are reported lost, never silently dropped.
	for (const item of queue) results.set(item.room.room, { lost: true, reason: item.tries ? 'no other machine left' : 'no machine left', room: item.room.room, attempts: item.tries });
	return all.map(room => results.get(room.room));
}

/**
 * What a room's archive leaves on the machine, as tar --exclude patterns (GNU tar on boat, bsdtar on Windows; both match
 * them at any depth). secret.txt is a throwaway per-run RCON secret. A fixture's server folder holds its copy of the
 * server template (server.jar, libraries, versions, mods: about 140 MB per run) and .fabric, Fabric's cache of the mods
 * remapped at start (about 40 jars, regenerated every boot). Nothing at home reads either; .fabric alone was 106,845
 * files in one 300-room batch. Logs, arena-watch, properties, worlds and the results come back; runBatch then drops a
 * passing arm's world region files (lib/room-worlds.mjs).
 */
export const PACK_EXCLUDES = ['secret.txt', '.fabric', '*/server/server.jar', '*/server/libraries', '*/server/versions', '*/server/mods'];

/**
 * A pool's fetch: download(localTgz) copies the room's archive here; it is unpacked into a staging folder and moved into
 * roomsDir/ROOM only once its done.json reads, so a failed copy never leaves rows the merge could count and a retry never
 * inherits an earlier attempt's files. Returns the done.json.
 */
export async function stageRoom({ roomsDir, room, download }) {
	await mkdir(roomsDir, { recursive: true });
	const staging = await mkdtemp(path.join(roomsDir, `.staging-${room}-`));
	try {
		const local = path.join(staging, `${room}.tgz`);
		await download(local);
		await new Promise((resolve, reject) => {
			const tar = spawn('tar', ['-xzf', local, '-C', staging], { stdio: 'inherit' });
			tar.on('error', reject);
			tar.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
		});
		const done = JSON.parse(await readFile(path.join(staging, room, 'done.json'), 'utf8'));
		if (done.room !== room || typeof done.arms !== 'object') throw new Error(`done.json of ${room} does not describe it`);
		await rm(path.join(roomsDir, room), { recursive: true, force: true });
		await rename(path.join(staging, room), path.join(roomsDir, room));
		return done;
	} finally { await rm(staging, { recursive: true, force: true }); }
}

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }

/**
 * An arm's rows: the NAME.json list finishRun wrote beside its NAME-summary.json. Most fixtures name it result, but some
 * keep result.json for their own report (an object) and give finishRun another name (acceptance.json, runs.json), so the
 * pair is found by its summary, preferring result. Several other pairs are a problem, never a silent pick.
 */
export async function armRows(dir) {
	const names = await readdir(dir).catch(() => []);
	const pairs = [];
	for (const base of names.filter(name => name.endsWith('-summary.json')).map(name => name.slice(0, -'-summary.json'.length)).filter(base => names.includes(`${base}.json`)).sort()) {
		const rows = await readJson(path.join(dir, `${base}.json`)).catch(() => null);
		if (Array.isArray(rows)) pairs.push({ base, rows });
	}
	// A result.json row list without its summary is a rows file too (a fixture that died before finishRun wrote the
	// summary); next to another pair it makes the pick ambiguous, so a failing result.json never loses to a passing pair.
	const bare = !pairs.some(pair => pair.base === 'result') && names.includes('result.json') ? await readJson(path.join(dir, 'result.json')).catch(() => null) : null;
	if (Array.isArray(bare)) {
		if (pairs.length) return { rows: [], summary: null, file: null, problem: `several row files (result.json without its summary, ${pairs.map(pair => `${pair.base}.json`).join(', ')})` };
		return { rows: bare, summary: null, file: 'result.json', problem: null };
	}
	const pick = pairs.find(pair => pair.base === 'result') ?? (pairs.length === 1 ? pairs[0] : null);
	// A finishRun summary whose rows file is gone: the fixture ran on finishRun, so it is no exit-code room.
	const orphanSummary = !pick && !pairs.length ? names.find(name => name.endsWith('-summary.json')) ?? null : null;
	if (!pick) return { rows: [], summary: null, file: null, problem: pairs.length > 1 ? `several row files (${pairs.map(pair => `${pair.base}.json`).join(', ')}), none named result.json` : null, orphanSummary };
	return { rows: pick.rows, summary: await readJson(path.join(dir, `${pick.base}-summary.json`)).catch(() => null), file: `${pick.base}.json`, problem: null };
}

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const finishRunScripts = new Map();
/**
 * Whether a line's fixture script writes finishRun rows, read as the batch played it: at the batch's code ref when the
 * script is in the repository (the machines play that ref), else from disk. An unreadable script counts as yes.
 */
const writesRows = (script, code = null) => {
	if (!script) return true;
	const key = `${code ?? ''}:${script}`;
	if (!finishRunScripts.has(key)) {
		const inRepo = !path.isAbsolute(script) ? path.posix.normalize(script.replaceAll('\\', '/')) : null;
		let text = null;
		if (code && inRepo) try { text = execFileSync('git', ['show', `${code}:${inRepo}`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* not at that ref */ }
		if (text === null) try { text = readFileSync(path.resolve(REPO, script), 'utf8'); } catch { /* unknown script */ }
		finishRunScripts.set(key, text === null || /\bfinishRun\b/.test(text));
	}
	return finishRunScripts.get(key);
};
/** The fixture script an arm's line runs: `node SCRIPT ...`, or the script after `node lib/with-jar.mjs JAR SCRIPT ...`. */
export const lineScript = (room, arm) => {
	const args = (room.lines?.find(line => line.arm === arm) ?? room.lines?.[0])?.args ?? [];
	return args.find(arg => /\.m?js$/.test(arg) && !/(^|[\\/])with-jar\.mjs$/.test(arg)) ?? args[0] ?? null;
};
/**
 * An exit-code room: its arm wrote no finishRun rows file at all, its line plans one run, and its fixture script is one
 * that never calls finishRun (the lava, rest, enderman rooms). A fixture that does call finishRun and wrote nothing
 * crashed, so its planned rows stay INVALID, never one exit-code verdict; so does a summary left without its rows file.
 */
const exitOnly = (found, { linePlanned = 1, script = null, code = null } = {}) => !found.file && !found.problem && !found.orphanSummary && !found.rows.length
	&& (linePlanned ?? 1) <= 1 && !writesRows(script, code);
/** A room's benchmark definition (its bar) by room name, or by its repeat group (ROOM.c3 is ROOM). */
const roomBar = (meta, name) => meta?.[name] ?? meta?.[repeatGroup(name)] ?? null;

/**
 * Per arm, the rows of every room folder (OUT/rooms/ROOM/ARM/result.json) go through finishRun into OUT/ARM/result.json.
 * planned counts every room's rows, and each row a lost or crashed room did not bring back is an INVALID row of that
 * room that never started (so it shows in invalid and in notStarted): the arm reads INVALID, never short.
 * A room whose fixture writes no finishRun rows file at all (an exit-code room) is one row judged by its exit code and
 * its own JSON, as the benchmark scorer judges it (judgeExitRun); meta, by room name or repeat group, gives its bar, and
 * code (the batch's ref) is where its fixture script is read.
 */
export async function mergeArms({ out, rooms, arms, outcomes, meta = {}, code = null }) {
	const byRoom = new Map(outcomes.map(outcome => [outcome.room, outcome]));
	const merged = {};
	for (const arm of arms) {
		const rows = [], perRoom = [], switchRecords = [];
		let planned = 0;
		for (const room of rooms) {
			const outcome = byRoom.get(room.room) ?? { lost: true, reason: 'not run' };
			const dir = path.join(out, 'rooms', room.room, arm);
			// A lost room counts no rows, whatever a partial copy left behind; it is all notStarted.
			// The rows and their summary are the NAME.json / NAME-summary.json pair finishRun wrote (armRows).
			const found = outcome.lost ? { rows: [], summary: null, problem: null } : await armRows(dir);
			const run = outcome.arms?.[arm] ?? {};
			// Rows an arm wrote before the room timeout, a signal or a launch error killed it are not a finished run.
			const killed = run.timedOut ? 'room timeout' : run.signal ? `signal ${run.signal}` : run.error ? `launch error: ${run.error}` : null;
			if (!outcome.lost && exitOnly(found, { linePlanned: room.plannedByArm?.[arm] ?? room.planned, script: lineScript(room, arm), code })) {
				const judged = await judgeExitRun(dir, { run, killed, log: path.join(out, 'rooms', room.room, `${arm}.log`), meta: roomBar(meta, room.room) });
				planned += 1;
				switchRecords.push(null);
				// An arm that launched started its row, on the run's own clock from 0; one that never launched did not.
				const launched = !run.error && (Number.isInteger(run.exit) || run.timedOut || run.signal);
				rows.push({ name: room.room, room: room.room, host: outcome.worker ?? null, attempts: outcome.attempts ?? 0, cantKeepUp: run.cantKeepUp ?? null, exitOnly: true,
					pass: judged.verdict === 'PASS' ? true : judged.verdict === 'FAIL' ? false : null,
					...(judged.verdict === 'INVALID' ? { measurementStatus: 'INVALID', measurementReason: judged.reason } : judged.verdict === 'FAIL' ? { failReason: judged.reason } : {}),
					startedAt: launched ? 0 : null, finishedAt: launched && !killed && Number.isFinite(run.seconds) ? run.seconds * 1000 : null, deaths: judged.deaths, damageTaken: judged.damage });
				perRoom.push({ room: room.room, lost: false, reason: null, rows: 1, planned: 1, exit: run.exit ?? null, seconds: run.seconds ?? null, timedOut: !!run.timedOut, cantKeepUp: run.cantKeepUp ?? null });
				continue;
			}
			const own = found.summary;
			const ownValid = Boolean(own && typeof own === 'object' && Number.isInteger(own.planned));
			if (!outcome.lost) switchRecords.push(ownValid ? own.switches ?? null : null);
			// A room whose summary is INVALID but that wrote rows needs no room-wide verdict: its invalid rows read INVALID
			// themselves and its missing ones count as notStarted, so one errored course never voids the courses beside it
			// (as collectRuns in benchmark-score.mjs reads it). With no rows at all the summary's INVALID is the only evidence.
			const roomInvalid = outcome.lost ? null
				: found.problem ? found.problem
				: !ownValid ? 'missing or corrupt room summary'
				: own.status === 'INVALID' && !found.rows.length ? 'room summary INVALID'
				: own.planned <= 0 ? 'room planned 0 rows'
				: null;
			const basePlanned = ownValid ? own.planned : (room.plannedByArm?.[arm] ?? room.planned);
			// A lost or invalid room always plans at least one row, so it can never leave the arm reading as a clean PASS.
			const roomPlanned = outcome.lost || roomInvalid ? Math.max(basePlanned, 1) : basePlanned;
			planned += roomPlanned;
			const roomRows = found.rows;
			const roomFlags = [...(killed ? [`arm killed (${killed})`] : []), ...(roomInvalid ? [roomInvalid] : [])];
			for (const row of roomRows) rows.push({ ...row, ...(roomFlags.length ? { integrity: [...(Array.isArray(row.integrity) ? row.integrity : []), ...roomFlags] } : {}),
				room: room.room, host: outcome.worker ?? null, attempts: outcome.attempts ?? 0, cantKeepUp: run.cantKeepUp ?? null });
			// Every row a room planned but did not bring back is an INVALID row of that room (a lost room's rows too), so no
			// other room's extra rows can make up for them in the arm's count. Such a row never started, so it counts in
			// notStarted as well as invalid: notStarted is the part of invalid that never ran. (collectRuns, which scores
			// benchmarks, counts a lost room as one LOST run per arm instead.)
			for (let i = roomRows.length; i < roomPlanned; i++) {
				const why = outcome.lost ? `room lost: ${outcome.reason ?? 'unknown'}` : roomInvalid && !roomRows.length ? roomInvalid : `planned row ${i + 1} of ${roomPlanned} never written`;
				rows.push({ name: roomPlanned > 1 ? `${room.room} row ${i + 1}` : room.room, room: room.room, host: outcome.worker ?? null, attempts: outcome.attempts ?? 0, cantKeepUp: run.cantKeepUp ?? null,
					pass: false, error: why, integrity: roomFlags, startedAt: null, finishedAt: null, deaths: null, damageTaken: null, ...(outcome.lost ? { lost: true } : {}) });
			}
			perRoom.push({ room: room.room, lost: !!outcome.lost, reason: outcome.reason ?? null, rows: roomRows.length, planned: roomPlanned, exit: run.exit ?? null, seconds: run.seconds ?? null, timedOut: !!run.timedOut, cantKeepUp: run.cantKeepUp ?? null });
		}
		await mkdir(path.join(out, arm), { recursive: true });
		// The arm's switch set is its rooms' (each room's fixture recorded its own), never this machine's environment.
		const summary = await finishRun(rows, { file: path.join(out, arm, 'result.json'), planned, strict: false, setExitCode: false, switches: mergeSwitchRecords(switchRecords) });
		merged[arm] = { summary, rows, perRoom };
	}
	return merged;
}

const sum = values => values.reduce((total, value) => total + value, 0);
/** Totals over rows that ran; a row without a number makes the total unknown instead of reading as zero. */
export function armTotals({ summary, rows, perRoom }) {
	const ran = rows.filter(row => Number.isFinite(row.startedAt) && !row.skipped);
	// Unknown, never 0, when a row lacks the counter or a room wrote fewer rows than planned.
	const missing = perRoom.some(room => room.rows < room.planned);
	const known = key => !missing && ran.every(row => Number.isFinite(row[key])) ? sum(ran.map(row => row[key])) : null;
	// The scorer's own predicate: a safe run that missed its bar (pass: true, bar: false) is a fail, not a pass.
	const passed = rows.filter(row => roomVerdict(row).verdict === 'PASS').length;
	return {
		pass: passed, fail: summary.failed, invalid: summary.invalid, notStarted: summary.notStarted, status: summary.status,
		lostRooms: perRoom.filter(room => room.lost).map(room => room.room),
		deaths: known('deaths'), damage: known('damageTaken'), unknownDamageRows: ran.filter(row => !Number.isFinite(row.damageTaken)).length,
		roomSeconds: sum(perRoom.map(room => room.seconds ?? 0)), cantKeepUp: sum(perRoom.map(room => room.cantKeepUp ?? 0)),
	};
}

const clock = seconds => `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
export function formatSummary({ batch, merged, arms, wallSeconds, vms, rooms }) {
	const lines = [`${batch.name}: ${rooms.length} rooms x ${arms.length} arms on ${vms} machines, code ${batch.code.slice(0, 8)}, wall ${clock(wallSeconds)}`];
	lines.push('arm        status   pass fail invalid notStarted lost deaths damage  room-time  cant-keep-up');
	for (const arm of arms) {
		const t = armTotals(merged[arm]);
		const damage = t.damage === null ? `unknown(${t.unknownDamageRows})` : String(t.damage);
		lines.push(`${arm.padEnd(10)} ${t.status.padEnd(8)} ${String(t.pass).padStart(4)} ${String(t.fail).padStart(4)} ${String(t.invalid).padStart(7)} ${String(t.notStarted).padStart(10)} ${String(t.lostRooms.length).padStart(4)} ${String(t.deaths ?? 'unknown').padStart(6)} ${damage.padStart(6)}  ${clock(t.roomSeconds).padStart(9)}  ${String(t.cantKeepUp).padStart(12)}`);
	}
	// Each arm's switch set as its rooms recorded it: one line per distinct coordinator set and per distinct server set.
	for (const arm of arms) {
		const played = merged[arm].summary?.switches;
		if (!played || typeof played !== 'object') continue;
		for (const line of played.coordinator ?? []) lines.push(`${arm} coordinator ${line}`);
		for (const line of played.server ?? []) lines.push(`${arm} server ${line}`);
		if (played.unrecorded) lines.push(`${arm}: ${played.unrecorded} room${played.unrecorded === 1 ? '' : 's'} recorded no switch set`);
	}
	lines.push('room: ' + arms.join(' | '));
	for (const room of rooms) {
		const cells = arms.map(arm => {
			const entry = merged[arm].perRoom.find(item => item.room === room.room);
			if (entry.lost) return `LOST (${entry.reason})`;
			const rows = merged[arm].rows.filter(row => row.room === room.room);
			if (!rows.length) return `no rows (exit ${entry.exit})`;
			return rows.map(row => `${({ PASS: 'pass', FAIL: 'fail', INVALID: 'INVALID', SKIPPED: 'skipped' })[roomVerdict(row).verdict]} d=${row.deaths ?? '?'} dmg=${row.damageTaken ?? '?'}`).join(', ') + ` ${clock(entry.seconds ?? 0)}`;
		});
		lines.push(`${room.room}: ${cells.join(' | ')}`);
	}
	return lines.join('\n');
}

/** A room's repeat group: its name without a trailing repeat label (.c3 or -r4), so ROOM.c1..c10 top up together. */
export const repeatGroup = name => String(name).replace(/(?:\.c\d+|-r\d+)$/, '');

/**
 * One arm of a fetched room: { valid, rows }. valid counts its PASS or FAIL rows, as the merge counts them (none when the
 * arm was killed, its rows file is ambiguous, or its summary is missing, corrupt or plans no rows; an exit-code room is
 * one run, judged with its bar as the merge judges it); rows is how many runs a copy of the room plays (its summary's planned), or null when that is unknown.
 */
export async function armValidRuns(dir, run = {}, { linePlanned = 1, script = null, code = null, bar = null } = {}) {
	const found = await armRows(dir);
	const planned = Number.isInteger(found.summary?.planned) && found.summary.planned > 0 ? found.summary.planned : null;
	// A killed arm counts no valid run, but the runs its summary planned still size the copies.
	if (run.timedOut || run.signal || run.error) return { valid: 0, rows: planned };
	// An exit-code room (no rows file at all) is one run, valid when its exit code and own JSON judge it PASS or FAIL.
	if (exitOnly(found, { linePlanned, script, code })) return { valid: ['PASS', 'FAIL'].includes((await judgeExitRun(dir, { run, meta: bar })).verdict) ? 1 : 0, rows: 1 };
	if (found.problem || planned === null) return { valid: 0, rows: null };
	return { valid: found.rows.filter(row => row && typeof row === 'object' && ['PASS', 'FAIL'].includes(roomVerdict(row).verdict)).length, rows: found.summary.planned };
}

/**
 * --valid N: plays more copies of a repeat group (both arms side by side, so the arms stay paired) until every arm has N
 * valid runs, never past 2N planned runs an arm. Runs a copy plays are the line's selector count until a copy's own
 * summary says how many it planned. Copies still queued or playing count toward N, so a group never asks for more than
 * its shortfall at once. more(room, outcome) is runQueue's hook; added lists the copies it made.
 */
export function topUp({ rooms, arms, valid, out, meta = {}, code = null, countValid = armValidRuns }) {
	if (!Number.isInteger(valid) || valid < 1) throw new Error('--valid wants a whole number of 1 or more');
	const groups = new Map(), names = new Set(rooms.map(room => room.room)), added = [];
	for (const room of rooms) {
		const key = repeatGroup(room.room);
		// Runs a copy plays: the most any arm's line selects (an arm's own line can select more cases than the first arm's).
		const lineRows = Math.max(1, room.planned ?? 1, ...Object.values(room.plannedByArm ?? {}).filter(Number.isFinite));
		const group = groups.get(key) ?? { template: room, copies: 0, pending: 0, perCopy: lineRows, valid: Object.fromEntries(arms.map(arm => [arm, 0])),
			next: 1, style: /-r\d+$/.test(room.room) ? '-r' : '.c' };
		group.copies++; group.pending++;
		groups.set(key, group);
	}
	const more = async (room, outcome) => {
		const key = repeatGroup(room.room), group = groups.get(key);
		if (!group) return [];
		// Every count is read before the group changes, so two copies finishing together never lose one another's runs.
		const counts = outcome?.lost ? arms.map(() => ({ valid: 0, rows: null }))
			: await Promise.all(arms.map(arm => countValid(path.join(out, 'rooms', room.room, arm), outcome.arms?.[arm] ?? {}, { linePlanned: room.plannedByArm?.[arm] ?? room.planned, script: lineScript(room, arm), code, bar: roomBar(meta, room.room) })));
		group.pending--;
		arms.forEach((arm, i) => { group.valid[arm] += counts[i].valid; });
		const seen = Math.max(0, ...counts.map(count => count.rows ?? 0));
		if (seen) group.perCopy = Math.max(group.perCopy, seen);
		const extra = [];
		let short = Math.max(...arms.map(arm => valid - group.valid[arm])) - group.pending * group.perCopy;
		while (short > 0 && (group.copies + 1) * group.perCopy <= 2 * valid) {
			let name;
			// Copies go on numbering the group's own way (ROOM.cK or ROOM-rK), so the benchmark scorer folds ROOM.cK into its room.
			do name = `${key}${group.style}${group.next++}`; while (names.has(name));
			names.add(name);
			const copy = { ...group.template, room: name, lines: group.template.lines.map(line => ({ ...line, env: { ...line.env }, args: [...line.args] })), topUpOf: key };
			group.copies++; group.pending++; short -= group.perCopy;
			extra.push(copy); added.push(copy);
		}
		return extra;
	};
	const report = () => [...groups].map(([name, group]) => ({ group: name, copies: group.copies, perCopy: group.perCopy, planned: group.copies * group.perCopy, valid: { ...group.valid }, short: arms.filter(arm => group.valid[arm] < valid) }));
	return { more, added, report };
}
