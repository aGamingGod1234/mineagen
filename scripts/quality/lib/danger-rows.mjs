// What hit the bot in a practice room: the Watcher's damage rows (arena-watch/<agentId>-danger.jsonl, written when the
// server runs with -Dmineagen.watch=true; see the "Danger rows" section of scripts/quality/README.md), folded per room
// row by attacker. finishRun attaches the fold as row.hits; a room without danger files gets no hits (unknown).
import { existsSync } from 'node:fs';
import { readFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Schema 2 (DangerLog) added fields to damage rows and changed none this fold reads.
const SCHEMAS = new Set([1, 2]);
// World and server folders hold thousands of files and never a watch folder of their own.
const SKIP = new Set(['world', 'libraries', 'mods', 'versions', 'logs', 'config', 'crash-reports', '.fabric', 'node_modules', '.git']);

/** Every arena-watch folder at most `depth` levels below root (root/arena-watch, root/seed-1/server/arena-watch, ...). */
export async function watchDirs(root, depth = 3) {
	const found = [];
	const walk = async (dir, left) => {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === 'arena-watch') found.push(path.join(dir, entry.name));
			else if (left > 0 && !SKIP.has(entry.name) && !entry.name.startsWith('world')) await walk(path.join(dir, entry.name), left - 1);
		}
	};
	await walk(root, depth);
	return found.sort();
}

/**
 * The damage rows under root: { files, rows, dropped }. files counts the -danger.jsonl files, so a room with the watch
 * off (no file) reads as unknown, while a watched room with no hits has a file and no rows. A line that does not parse
 * (a write cut short) or another schema is dropped and counted, never mixed in. The same row seen twice (a file kept
 * beside the server's copy) counts once.
 */
export async function readDangerRows(root) {
	let files = 0, dropped = 0, unreadable = 0, lostDamage = 0;
	// Bodies watched, per server: a server folder's arena-watch and the copy boot() keeps beside it are one server.
	const rows = [], seen = new Set(), servers = new Map(), activity = new Map(), watched = new Set();
	for (const dir of await watchDirs(root)) {
		// boot(DIR) runs its server in DIR/server and keeps the copy in DIR/arena-watch: both are server DIR.
		const parent = path.dirname(dir), server = path.basename(parent) === 'server' && existsSync(path.join(path.dirname(parent), 'arena-watch')) ? path.dirname(parent) : parent;
		const bodies = servers.get(server) ?? new Set();
		servers.set(server, bodies);
		for (const name of (await readdir(dir).catch(() => [])).filter(name => name.endsWith('-danger.jsonl')).sort()) {
			files++;
			// The Watcher makes <agentId>-danger.jsonl, empty, when it starts watching a body: a file is a watched body.
			bodies.add(name.slice(0, -'-danger.jsonl'.length));
			watched.add(name.slice(0, -'-danger.jsonl'.length));
			// A file that is there but cannot be read is unknown evidence, never an empty file that reads as no hits.
			const text = await readFile(path.join(dir, name), 'utf8').catch(() => null);
			if (text === null) { unreadable++; continue; }
			for (const line of text.split('\n')) {
				if (!line.trim()) continue;
				let row;
				// A cut line could have been a hit, and so could a damage row of another schema: both leave hits unknown.
				try { row = JSON.parse(line); } catch { dropped++; lostDamage++; continue; }
				if (!SCHEMAS.has(row?.schema)) { dropped++; if (row?.type === 'damage') lostDamage++; continue; }
				// Every row of any type is evidence the server was capturing then.
				if (Number.isFinite(row.atMs)) { const span = activity.get(server) ?? [Infinity, -Infinity]; activity.set(server, [Math.min(span[0], row.atMs), Math.max(span[1], row.atMs)]); }
				if (row.type !== 'damage') continue;
				const key = JSON.stringify([row.agentId, row.atMs, row.gameTime, row.attackerId, row.damageType, row.amount, row.lethal]);
				if (seen.has(key)) continue;
				seen.add(key);
				rows.push(row);
			}
		}
	}
	// The most bodies one server watched: 1 for one body per server (travel boots one server per seed), 4 for 4 lanes.
	return { files, rows, dropped, unreadable, lostDamage, watched, servers: servers.size, activity: [...activity.values()], bodies: Math.max(0, ...[...servers.values()].map(set => set.size)) };
}

const round = value => Math.round(value * 100) / 100;
/** Who hit: the attacking entity type, else the damage type (lava, fall, fire), else the scan kind. */
const attackerOf = row => row.attacker ?? row.damageType ?? row.kind ?? 'unknown';

/**
 * A fixture's own /damage command (no attacker, damage type minecraft:generic): how rooms set a body's health before
 * play, or hurt it on cue during play (the archer-resume escape room). It is damage the room dealt, not a mob or the
 * world hitting the bot, so it is counted apart in commandDamage, never dropped.
 */
export const commandHit = row => !row.attacker && row.damageType === 'minecraft:generic';

/**
 * The hits from `from` to `to` (epoch ms, inclusive), by attacker: { hits, taken, blocked, lethal, agents, byAttacker,
 * commandDamage }. taken is health and absorption lost after armour and shield; the lethal hit has no taken, so it is
 * counted in lethal and its amount (before armour) in lethalAmount. agentId, when given, keeps only that body's rows.
 */
export function foldHits(rows, { from = -Infinity, to = Infinity, agentId = null } = {}) {
	const empty = () => ({ hits: 0, taken: 0, blocked: 0, lethal: 0, lethalAmount: 0 });
	const total = empty(), byAttacker = {}, agents = new Set();
	let commandDamage = 0;
	for (const row of rows) {
		if (!Number.isFinite(row.atMs) || row.atMs < from || row.atMs > to) continue;
		if (agentId && row.agentId !== agentId) continue;
		if (commandHit(row)) { if (Number.isFinite(row.taken)) commandDamage = round(commandDamage + row.taken); continue; }
		agents.add(row.agentId);
		for (const into of [total, byAttacker[attackerOf(row)] ??= empty()]) {
			into.hits++;
			if (Number.isFinite(row.taken)) into.taken = round(into.taken + row.taken);
			if (row.blocked) into.blocked++;
			if (row.lethal) { into.lethal++; if (Number.isFinite(row.amount)) into.lethalAmount = round(into.lethalAmount + row.amount); }
		}
	}
	return { ...total, agents: agents.size, byAttacker, commandDamage };
}

/**
 * Each row with its own epoch-ms startedAt and finishedAt and no hits of its own gets row.hits (source 'watch') from the
 * danger rows under root that fall in its time window (from row.hitsFrom instead of startedAt when the fixture marks
 * where play began). With no danger file under root the rows are left alone: no watch, no claim. A row that names its
 * body (agentId) counts only that body's hits; a row that does not, where several bodies were watched (parallel lanes on
 * one server), gets no hits, never another body's, unless it sets hitsAllBodies (one row covering every lane).
 */
export async function attachHits(rows, root) {
	const danger = await readDangerRows(root);
	if (!danger.files) return { files: 0, attached: 0 };
	const unknown = danger.unreadable ? `${danger.unreadable} danger file${danger.unreadable === 1 ? '' : 's'} could not be read`
		: danger.lostDamage ? `${danger.lostDamage} danger line${danger.lostDamage === 1 ? '' : 's'} that may be a hit could not be read` : null;
	let attached = 0;
	for (const row of rows) {
		// A fold this function made earlier is made again: the server may have written more rows since.
		if (!row || typeof row !== 'object' || (row.hits !== undefined && row.hits?.source !== 'watch')) continue;
		if (!(row.startedAt > 1e12) || !(row.finishedAt >= row.startedAt)) continue;
		const from = row.hitsFrom > 1e12 ? row.hitsFrom : row.startedAt, agentId = typeof row.agentId === 'string' ? row.agentId : null;
		const hits = foldHits(danger.rows, { from, to: row.finishedAt, agentId });
		// A row that names no body can only be read where one body was watched: with several, the hits in its window may
		// be a sibling lane's, even when only one of them was hit.
		if (unknown) { delete row.hits; row.hitsUnknown = unknown; continue; }
		// A row is read only from a capture that covers it: its own body's file, or, for a nameless row under several
		// servers, a server that wrote something in its window (another room's file proves nothing about this one).
		if (agentId && !danger.watched.has(agentId)) { delete row.hits; row.hitsUnknown = `no danger file for body ${agentId}`; continue; }
		if (!agentId && danger.servers > 1 && !danger.activity.some(([first, last]) => first <= row.finishedAt && last >= from)) {
			delete row.hits; row.hitsUnknown = `${danger.servers} servers were captured and none wrote anything in this row's window`; continue;
		}
		// hitsAllBodies: a row that stands for every body on its server (one row per seed with all lanes) takes them all.
		if (!agentId && danger.bodies > 1 && row.hitsAllBodies !== true) { delete row.hits; row.hitsUnknown = `${danger.bodies} bodies were watched on one server and the row names none`; continue; }
		delete row.hitsUnknown;
		row.hits = { source: 'watch', ...hits };
		if (danger.dropped) row.hits.droppedLines = danger.dropped;
		attached++;
	}
	return { files: danger.files, attached };
}

/** Copies the server's danger files up beside it (dir/arena-watch), so a fixture that deletes its world keeps them. */
export async function keepDangerFiles(from, to) {
	const names = (await readdir(from).catch(() => [])).filter(name => name.endsWith('-danger.jsonl'));
	if (!names.length) return 0;
	await mkdir(to, { recursive: true });
	for (const name of names) await copyFile(path.join(from, name), path.join(to, name));
	return names.length;
}
