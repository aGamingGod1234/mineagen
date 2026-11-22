// What hit the bot in a practice room: the Watcher's damage rows (arena-watch/<agentId>-danger.jsonl, written when the
// server runs with -Dmineagen.watch=true; see the "Danger rows" section of scripts/quality/README.md), folded per room
// row by attacker. finishRun attaches the fold as row.hits; a room without danger files gets no hits (unknown).
import { readFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA = 1;
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
	let files = 0, dropped = 0;
	const rows = [], seen = new Set();
	for (const dir of await watchDirs(root)) {
		for (const name of (await readdir(dir).catch(() => [])).filter(name => name.endsWith('-danger.jsonl')).sort()) {
			files++;
			const text = await readFile(path.join(dir, name), 'utf8').catch(() => '');
			for (const line of text.split('\n')) {
				if (!line.trim()) continue;
				let row;
				try { row = JSON.parse(line); } catch { dropped++; continue; }
				if (row?.schema !== SCHEMA) { dropped++; continue; }
				if (row.type !== 'damage') continue;
				const key = JSON.stringify([row.agentId, row.atMs, row.gameTime, row.attackerId, row.damageType, row.amount, row.lethal]);
				if (seen.has(key)) continue;
				seen.add(key);
				rows.push(row);
			}
		}
	}
	return { files, rows, dropped };
}

const round = value => Math.round(value * 100) / 100;
/** Who hit: the attacking entity type, else the damage type (lava, fall, fire), else the scan kind. */
const attackerOf = row => row.attacker ?? row.damageType ?? row.kind ?? 'unknown';

/**
 * The hits from `from` to `to` (epoch ms, inclusive), by attacker: { hits, taken, blocked, lethal, agents, byAttacker }.
 * taken is health and absorption lost after armour and shield; the lethal hit has no taken, so it is counted in lethal
 * and its amount (before armour) in lethalAmount.
 */
export function foldHits(rows, { from = -Infinity, to = Infinity } = {}) {
	const empty = () => ({ hits: 0, taken: 0, blocked: 0, lethal: 0, lethalAmount: 0 });
	const total = empty(), byAttacker = {}, agents = new Set();
	for (const row of rows) {
		if (!Number.isFinite(row.atMs) || row.atMs < from || row.atMs > to) continue;
		agents.add(row.agentId);
		for (const into of [total, byAttacker[attackerOf(row)] ??= empty()]) {
			into.hits++;
			if (Number.isFinite(row.taken)) into.taken = round(into.taken + row.taken);
			if (row.blocked) into.blocked++;
			if (row.lethal) { into.lethal++; if (Number.isFinite(row.amount)) into.lethalAmount = round(into.lethalAmount + row.amount); }
		}
	}
	return { ...total, agents: agents.size, byAttacker };
}

/**
 * Each row with its own epoch-ms startedAt and finishedAt and no hits of its own gets row.hits (source 'watch') from the
 * danger rows under root that fall in its time window. With no danger file under root the rows are left alone: no watch,
 * no claim. Several bodies on one server add up (hits.agents says how many were hit).
 */
export async function attachHits(rows, root) {
	const danger = await readDangerRows(root);
	if (!danger.files) return { files: 0, attached: 0 };
	let attached = 0;
	for (const row of rows) {
		// A fold this function made earlier is made again: the server may have written more rows since.
		if (!row || typeof row !== 'object' || (row.hits !== undefined && row.hits?.source !== 'watch')) continue;
		if (!(row.startedAt > 1e12) || !(row.finishedAt >= row.startedAt)) continue;
		row.hits = { source: 'watch', ...foldHits(danger.rows, { from: row.startedAt, to: row.finishedAt }) };
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
