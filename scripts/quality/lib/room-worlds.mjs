// A room's saved worlds once it is home. Their region files (*.mca, *.mcc: terrain, entities, points of interest) were
// most of what a room brought back, and nothing at home reads them; they are kept for replaying a run that did not pass.
// runBatch calls slimRoom as each room lands, so a batch's folder stops growing by a world per passing run.
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { otherEvidence } from './benchmark-score.mjs';
import { roomVerdict } from './fixture-run.mjs';
import { armRows } from './room-batch-core.mjs';

// A line that asks its fixture to keep its world (ARENA_FIXTURE_KEEP, KEEP_WORLDS, BUILD_KEEP, KEEP, ...) keeps it here too.
const KEEP_SWITCH = /(^|_)KEEP(_WORLDS?)?$/;
export const asksKeep = env => Object.entries(env ?? {}).some(([key, value]) => KEEP_SWITCH.test(key) && value !== '' && value !== '0');

/**
 * Why an arm keeps its worlds, or null when it shows a pass. It judges the way benchmark-score.mjs collectRuns does
 * (finishRun's rows and summary, else the exit code and the fixture's own JSON), but without the room's benchmark
 * definition, so it keeps on any death or failure mark: the exceptions are a passWhen bar and a survival room with no
 * death record, which only the definition can fail.
 */
export async function keepReason(dir, run) {
	if (!run || run.exit !== 0 || run.timedOut || run.signal || run.error) return 'did not exit 0';
	const found = await armRows(dir);
	if (found.rows.length || found.problem || found.file) {
		if (found.problem) return found.problem;
		const own = found.summary;
		if (!own || typeof own !== 'object' || !Number.isInteger(own.planned)) return 'missing or corrupt summary';
		const rows = found.rows.filter(row => row && typeof row === 'object');
		if (own.planned <= 0 || rows.length < own.planned) return 'a planned row is missing';
		const failed = rows.map(row => roomVerdict(row)).find(verdict => verdict.verdict !== 'PASS');
		return failed ? `row ${failed.verdict}` : null;
	}
	const evidence = await otherEvidence(dir);
	if (evidence.integrity.length && roomVerdict({ integrity: evidence.integrity }).verdict !== 'PASS') return 'integrity';
	if (evidence.corrupt.length) return 'corrupt JSON';
	if (evidence.error) return 'error.txt';
	if (evidence.deathsUnread) return 'death counter unreadable';
	if (evidence.deaths > 0) return 'died';
	if (evidence.failed || evidence.failedPass) return `${evidence.failed ?? 'pass'} false`;
	return null;
}

export async function regionFiles(dir) {
	const found = [];
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...await regionFiles(full));
		else if (entry.isFile() && /\.mc[ac]$/.test(entry.name)) found.push(full);
	}
	return found;
}

/**
 * Drops the region files of every arm of roomDir that shows a pass, unless keepWorlds or the arm's line asks to keep
 * them. Returns per arm { files, bytes, kept: reason } or { files, bytes, dropped }; never throws.
 */
export async function slimRoom({ roomDir, done, lines = [], keepWorlds = false }) {
	const worlds = {};
	for (const [arm, run] of Object.entries(done?.arms ?? {})) {
		try {
			const dir = path.join(roomDir, arm);
			const files = await regionFiles(dir);
			if (!files.length) continue;
			const bytes = (await Promise.all(files.map(file => stat(file).then(info => info.size, () => 0)))).reduce((sum, size) => sum + size, 0);
			const kept = keepWorlds ? 'keepWorlds' : asksKeep(lines.find(line => line.arm === arm)?.env) ? 'keep switch' : await keepReason(dir, run);
			if (!kept) for (const file of files) await rm(file, { force: true });
			worlds[arm] = kept ? { files: files.length, bytes, kept } : { files: files.length, bytes, dropped: files.length };
		} catch (error) { worlds[arm] = { error: error.message }; }
	}
	return worlds;
}
