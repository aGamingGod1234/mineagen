// The gameplay switch set a room or game played with, for its result file (coordinator/src/switches.mjs).
// Two halves: the coordinator's, resolved from this process's environment (the server's -D switches read `?` there),
// and the mod's own line, which it logs at every server start ("[mineagen] switches ...") and which is read back from
// the server logs under the run's folder.
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describeSwitches, resolveSwitches } from '../../../coordinator/src/switches.mjs';

const SERVER_LINE = /\[mineagen\] (switches(?: \S+)*)\s*$/;
const LOG_NAME = /(^|[-_.])(server|latest|debug)\.log$|^server.*\.log$/;
// A log larger than this is read from its start only: the line is written once, at server start.
const HEAD_BYTES = 4 << 20;

/** The coordinator half from an environment: { line, record }, or { error } when a reader would refuse a value. */
export function coordinatorSwitches(environment = process.env) {
	try {
		const { line, record } = describeSwitches(resolveSwitches(environment));
		return { line, record };
	} catch (error) {
		return { error: error.message };
	}
}

async function head(file) {
	const handle = await open(file, 'r');
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
		return buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
}

/** Every distinct switch line the mod logged in a server log under dir (searched depth levels down), in first-seen order. */
export async function serverSwitchLines(dir, { depth = 4 } = {}) {
	const lines = [];
	const walk = async (at, left) => {
		let entries;
		try { entries = await readdir(at, { withFileTypes: true }); } catch { return; }
		// Files before folders, each by name, so the order is the same on every machine.
		entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name));
		for (const entry of entries) {
			const file = path.join(at, entry.name);
			if (entry.isDirectory()) { if (left > 0) await walk(file, left - 1); continue; }
			if (!entry.isFile() || !LOG_NAME.test(entry.name)) continue;
			let text;
			try { text = await head(file); } catch { continue; }
			for (const raw of text.split('\n')) {
				const match = SERVER_LINE.exec(raw.replace(/\r$/, ''));
				if (match && !lines.includes(match[1])) lines.push(match[1]);
			}
		}
	};
	if (dir) await walk(dir, depth);
	return lines;
}

/** One run's switch record: { coordinator: { line, record } | { error }, server: [line, ...] }. */
export async function switchRecord(dir, environment = process.env) {
	return { coordinator: coordinatorSwitches(environment), server: await serverSwitchLines(dir) };
}

/**
 * Many runs' records as one (an arm's rooms, a benchmark's batch): the distinct coordinator and server lines, so a mixed
 * arm shows more than one line. A record that is missing counts in `unrecorded`.
 */
export function mergeSwitchRecords(records) {
	const coordinator = [], server = [];
	let unrecorded = 0;
	for (const record of records) {
		if (!record || typeof record !== 'object') { unrecorded++; continue; }
		const lines = Array.isArray(record.coordinator) ? record.coordinator
			: [record.coordinator?.line ?? (record.coordinator?.error ? `unreadable: ${record.coordinator.error}` : null)];
		for (const line of lines) if (typeof line === 'string' && !coordinator.includes(line)) coordinator.push(line);
		for (const line of Array.isArray(record.server) ? record.server : []) if (typeof line === 'string' && !server.includes(line)) server.push(line);
	}
	return { coordinator, server, unrecorded };
}
