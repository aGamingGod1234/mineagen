// A plan's early stop (checkpoint-batch.mjs "stopWhen"): ends a game once its question is answered or the bot is stuck,
// so the machine takes the next queued game instead of playing out the window.
//   { "advancement": "nether/obtain_blaze_rod" }        any of these advancements (a string or a list), namespace optional
//   { "items": { "minecraft:ender_pearl": 12 } }         every listed item held at once in at least that count, and
//                                                        more than the game started with (a save point's 12 pearls do not answer)
//   { "stallMinutes": 20 }                               no new advancement, item kind or dimension for that long
// Keys combine: the first that holds ends the game. Only play after the goal started counts, so a save point's own
// inventory and the advancements it gives back at setup never answer the question by themselves.
// The batch copies this file to each machine and runs it there each pass (it imports only node: modules, so it works with
// any arm): node stop-when.mjs GAME_DIR SPEC_BASE64. It reads the game's protocol journal from where it last stopped
// (state in GAME_DIR/stop-when-state.json), and when the stop holds it writes GAME_DIR/report/operator-stop.json, the
// reason run-long.mjs reports for an external stop, and prints STOP and the reason. Otherwise it prints PLAY.
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = id => String(id).includes(':') ? String(id) : `minecraft:${id}`;

/** The checked spec, or a thrown error naming what is wrong. */
export function parseStopWhen(spec) {
	if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('stopWhen must be an object');
	const unknown = Object.keys(spec).filter(k => !['advancement', 'items', 'stallMinutes'].includes(k));
	if (unknown.length) throw new Error(`stopWhen: unknown key ${unknown.join(', ')} (advancement, items, stallMinutes)`);
	const out = {};
	if (spec.advancement !== undefined) {
		const list = Array.isArray(spec.advancement) ? spec.advancement : [spec.advancement];
		if (!list.length || list.some(a => typeof a !== 'string' || !/^([a-z0-9_.-]+:)?[a-z0-9_]+\/[a-z0-9_/]+$/.test(a))) throw new Error('stopWhen.advancement takes advancement ids such as nether/obtain_blaze_rod');
		out.advancement = list.map(name);
	}
	if (spec.items !== undefined) {
		const entries = spec.items && typeof spec.items === 'object' && !Array.isArray(spec.items) ? Object.entries(spec.items) : [];
		if (!entries.length || entries.some(([id, n]) => !/^([a-z0-9_.-]+:)?[a-z0-9_/]+$/.test(id) || !Number.isInteger(n) || n < 1)) throw new Error('stopWhen.items maps item ids to counts, such as { "minecraft:ender_pearl": 12 }');
		out.items = Object.fromEntries(entries.map(([id, n]) => [name(id), n]));
	}
	if (spec.stallMinutes !== undefined) {
		if (!(Number.isFinite(spec.stallMinutes) && spec.stallMinutes >= 1)) throw new Error('stopWhen.stallMinutes must be a number of minutes, at least 1');
		out.stallMinutes = spec.stallMinutes;
	}
	if (!Object.keys(out).length) throw new Error('stopWhen needs advancement, items or stallMinutes');
	return out;
}

export const freshState = () => ({ offset: 0, goalAt: null, agentId: null, advancements: [], kinds: [], dimensions: [], baseline: null, progressAt: null, answer: null });

const at = row => { const e = row.envelope ?? row, p = e.payload ?? {}; return p.observedAtEpochMs ?? p.updatedAtEpochMs ?? row.observedAtMs ?? null; };

/** Folds protocol rows into the state: the goal start, then every advancement, held item kind and dimension after it. */
export function feed(state, rows, spec) {
	for (const row of rows) {
		const e = row.envelope ?? row, p = e.payload ?? {};
		if (state.goalAt === null) {
			if (e.type === 'goal_control' && p.operation === 'start') { state.goalAt = at(row) ?? Date.now(); state.agentId = e.agentId ?? null; state.progressAt = state.goalAt; }
			continue;
		}
		if (state.agentId && e.agentId && e.agentId !== state.agentId) continue;
		const when = at(row) ?? Date.now();
		const progress = () => { state.progressAt = Math.max(state.progressAt ?? when, when); };
		if (e.type === 'advancement_granted' && typeof p.advancementId === 'string') {
			const id = name(p.advancementId);
			if (!id.includes(':recipes/') && !state.advancements.includes(id)) { state.advancements.push(id); progress(); }
			if (!state.answer && spec.advancement?.includes(id)) state.answer = `advancement ${id}`;
		}
		if (e.type === 'observation') {
			const dimension = p.dimension ?? p.world?.dimension;
			if (dimension && !state.dimensions.includes(dimension)) {
				// The first observation is where the goal started, not progress.
				if (state.dimensions.length) progress();
				state.dimensions.push(dimension);
			}
			const held = {};
			for (const item of p.inventory?.items ?? []) if (item?.count > 0 && typeof item.itemId === 'string') held[item.itemId] = (held[item.itemId] ?? 0) + item.count;
			// The first observation after the goal start is what the game started with (empty in a fresh world): its items
			// are no progress, and an item count it already holds does not answer the question.
			const first = state.baseline === null;
			if (first) state.baseline = held;
			for (const id of Object.keys(held)) if (!state.kinds.includes(id)) { state.kinds.push(id); if (!first) progress(); }
			if (!state.answer && spec.items && Object.entries(spec.items).every(([id, n]) => (held[id] ?? 0) >= Math.max(n, (state.baseline[id] ?? 0) + 1)))
				state.answer = `items ${Object.entries(spec.items).map(([id, n]) => `${n} ${id}`).join(', ')}`;
		}
	}
	return state;
}

/** The stop reason once the game should end, else null. "QUESTION_ANSWERED" scores as the goal, "STALL" as a stall. */
export function verdict(state, spec, now = Date.now()) {
	if (state.answer) return `QUESTION_ANSWERED: ${state.answer}`;
	if (spec.stallMinutes && state.goalAt !== null && now - state.progressAt >= spec.stallMinutes * 60_000)
		return `STALL: no new advancement, item kind or dimension for ${spec.stallMinutes} min`;
	return null;
}

/** Reads whole lines appended since `offset` (at most `limit` bytes), returning the parsed rows and the new offset. */
export function readFrom(file, offset, limit = 256 * 1024 * 1024) {
	if (!existsSync(file)) return { rows: [], offset };
	const size = statSync(file).size;
	if (size < offset) offset = 0;
	const length = Math.min(size - offset, limit);
	if (length <= 0) return { rows: [], offset };
	const buffer = Buffer.alloc(length), fd = openSync(file, 'r');
	try { readSync(fd, buffer, 0, length, offset); } finally { closeSync(fd); }
	const end = buffer.lastIndexOf(10);
	if (end < 0) return { rows: [], offset };
	const rows = [];
	for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) { if (!line) continue; try { rows.push(JSON.parse(line)); } catch { /* a damaged line is skipped */ } }
	return { rows, offset: offset + end + 1 };
}

/** One pass for GAME_DIR: returns { stop, reason }. Writes the state, and operator-stop.json on a stop. */
export function check(gameDir, spec, now = Date.now()) {
	const stateFile = path.join(gameDir, 'stop-when-state.json');
	const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : freshState();
	const log = existsSync(path.join(gameDir, 'run.log')) ? readFileSync(path.join(gameDir, 'run.log'), 'utf8') : '';
	const raw = [...log.matchAll(/^Running [^:]*: (.+)$/gm)].at(-1)?.[1]?.trim();
	// The whole backlog is read before the verdict, so progress later in it cannot be missed by a stall check.
	if (raw) for (;;) {
		const read = readFrom(path.join(raw, 'quality-protocol.jsonl'), state.offset, 64 * 1024 * 1024);
		if (read.offset === state.offset) break;
		feed(state, read.rows, spec); state.offset = read.offset;
	}
	const reason = verdict(state, spec, now);
	writeFileSync(`${stateFile}.tmp`, JSON.stringify(state)); renameSync(`${stateFile}.tmp`, stateFile);
	if (!reason) return { stop: false };
	// The schema of operator-stop.mjs, written here since older arms may lack it; run-long keeps it on the SIGTERM.
	const report = path.join(gameDir, 'report'), file = path.join(report, 'operator-stop.json');
	if (existsSync(report) && !existsSync(file)) {
		const record = { schemaVersion: 1, kind: 'operator-stop', status: 'stopped', at: now, stoppedAt: new Date(now).toISOString(), reason, signal: 'SIGTERM', requestedBy: 'checkpoint-batch stopWhen',
			censoring: { remainder: 'unobserved', censored: true, preservesObservedFailures: true } };
		writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + '\n'); renameSync(`${file}.tmp`, file);
	}
	return { stop: true, reason };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [gameDir, encoded] = process.argv.slice(2);
	const result = check(gameDir, parseStopWhen(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))));
	console.log(result.stop ? `STOP ${result.reason}` : 'PLAY');
}
