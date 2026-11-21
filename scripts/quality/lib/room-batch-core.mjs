// Pure parts of room-batch.mjs: the commands file, the shared room queue with one re-queue after a lost machine, and
// the per-arm merge through finishRun. No machine, network or boat call happens here, so all of it is unit-tested.
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { finishRun } from './fixture-run.mjs';

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

/** Rows a room is expected to write: the count its selector names (BUILD_ONLY=a,b is 2), else 1. */
export function plannedOf(env) {
	const selector = Object.entries(env).find(([key]) => /(_ONLY|^SPOTS|^CASES)$/.test(key));
	return selector ? selector[1].split(',').filter(Boolean).length : 1;
}

/**
 * The shared queue. Every worker pulls the next room and plays both of its arms; attempt(worker, room, n) resolves to
 * { lost: false, ... } when the room finished on that worker (whatever its verdict), or { lost: true, reason } when the
 * worker died under it. A lost worker takes no more rooms; its room goes back to the front of the queue once, for a
 * different worker, then is reported lost. replace(), when given, may bring up a new worker for a lost one; release(),
 * when given, is called for a worker that finds the queue empty, and that worker leaves.
 */
export async function runQueue({ rooms, workers, attempt, maxAttempts = 2, replace = null, release = null, log = () => {} }) {
	const queue = rooms.map(room => ({ room, tries: 0, triedOn: new Set() }));
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
					if (release && !queue.length) { await Promise.resolve().then(() => release(worker)).catch(error => log(`release of ${worker.id} failed: ${error.message}`)); return; }
					// A busy worker may still lose its room back to the queue; otherwise nothing is left for this one.
					if (![...live].some(other => other !== worker && other.busy)) return;
					await new Promise(done => waiting.push(done));
					continue;
				}
				item.tries++; item.triedOn.add(worker.id); worker.busy = true;
				let outcome;
				try { outcome = await attempt(worker, item.room, item.tries); }
				catch (error) { outcome = { lost: true, reason: String(error?.message ?? error) }; }
				worker.busy = false;
				if (!outcome?.lost) { results.set(item.room.room, { ...outcome, lost: false, room: item.room.room, worker: worker.id, attempts: item.tries }); wake(); continue; }
				log(`room ${item.room.room} lost on ${worker.id} (try ${item.tries}): ${outcome.reason}`);
				if (item.tries < maxAttempts) queue.unshift(item);
				else results.set(item.room.room, { lost: true, reason: outcome.reason, room: item.room.room, worker: worker.id, attempts: item.tries });
				live.delete(worker);
				wake();
				if (replace && queue.length) {
					const fresh = await Promise.resolve().then(() => replace(worker)).catch(error => { log(`no replacement for ${worker.id}: ${error.message}`); return null; });
					if (fresh) running.push(loop(fresh));
				}
				return;
			}
		} finally { live.delete(worker); worker.busy = false; wake(); }
	};
	for (const worker of workers) running.push(loop(worker));
	for (let i = 0; i < running.length; i++) await running[i];
	// Rooms no worker could take (every machine that could was lost) are reported lost, never silently dropped.
	for (const item of queue) results.set(item.room.room, { lost: true, reason: item.tries ? 'no other machine left' : 'no machine left', room: item.room.room, attempts: item.tries });
	return rooms.map(room => results.get(room.room));
}

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
const exists = file => readdir(path.dirname(file)).then(names => names.includes(path.basename(file)), () => false);

/**
 * Per arm, the rows of every room folder (OUT/rooms/ROOM/ARM/result.json) go through finishRun into OUT/ARM/result.json.
 * planned counts every room's rows, so a lost or crashed room shows as notStarted and the arm reads INVALID, not short.
 */
export async function mergeArms({ out, rooms, arms, outcomes }) {
	const byRoom = new Map(outcomes.map(outcome => [outcome.room, outcome]));
	const merged = {};
	for (const arm of arms) {
		const rows = [], perRoom = [];
		let planned = 0;
		for (const room of rooms) {
			const outcome = byRoom.get(room.room) ?? { lost: true, reason: 'not run' };
			const dir = path.join(out, 'rooms', room.room, arm);
			// A lost room counts no rows, whatever a partial copy left behind; it is all notStarted.
			const own = outcome.lost ? null : await readJson(path.join(dir, 'result-summary.json')).catch(() => null);
			const roomPlanned = Number.isInteger(own?.planned) ? own.planned : (room.plannedByArm?.[arm] ?? room.planned);
			planned += roomPlanned;
			const run = outcome.arms?.[arm] ?? {};
			const read = !outcome.lost && await exists(path.join(dir, 'result.json')) ? await readJson(path.join(dir, 'result.json')).catch(() => []) : [];
			const roomRows = Array.isArray(read) ? read : [];
			// Rows an arm wrote before the room timeout, a signal or a launch error killed it are not a finished run.
			const killed = run.timedOut ? 'room timeout' : run.signal ? `signal ${run.signal}` : run.error ? `launch error: ${run.error}` : null;
			for (const row of roomRows) rows.push({ ...row, ...(killed ? { integrity: [...(Array.isArray(row.integrity) ? row.integrity : []), `arm killed (${killed})`] } : {}),
				room: room.room, host: outcome.worker ?? null, attempts: outcome.attempts ?? 0, cantKeepUp: run.cantKeepUp ?? null });
			perRoom.push({ room: room.room, lost: !!outcome.lost, reason: outcome.reason ?? null, rows: roomRows.length, planned: roomPlanned, exit: run.exit ?? null, seconds: run.seconds ?? null, timedOut: !!run.timedOut, cantKeepUp: run.cantKeepUp ?? null });
		}
		await mkdir(path.join(out, arm), { recursive: true });
		const summary = await finishRun(rows, { file: path.join(out, arm, 'result.json'), planned, strict: false, setExitCode: false });
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
	const passed = rows.filter(row => !row.skipped && row.pass === true && !row.error).length;
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
	lines.push('room: ' + arms.join(' | '));
	for (const room of rooms) {
		const cells = arms.map(arm => {
			const entry = merged[arm].perRoom.find(item => item.room === room.room);
			if (entry.lost) return `LOST (${entry.reason})`;
			const rows = merged[arm].rows.filter(row => row.room === room.room);
			if (!rows.length) return `no rows (exit ${entry.exit})`;
			return rows.map(row => `${row.error || row.integrity?.length ? 'INVALID' : row.pass === true ? 'pass' : row.pass === false ? 'fail' : 'unknown'} d=${row.deaths ?? '?'} dmg=${row.damageTaken ?? '?'}`).join(', ') + ` ${clock(entry.seconds ?? 0)}`;
		});
		lines.push(`${room.room}: ${cells.join(' | ')}`);
	}
	return lines.join('\n');
}
