// The rows of one arm of a room, whatever result files its fixture writes. Shared by ai-room-standin.mjs (which turns a
// stand-in's own files into the finishRun rows a room batch merges) and ai-room-report.mjs.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const elapsedMinutes = row => Number.isFinite(row.finishedAt) && Number.isFinite(row.startedAt) ? (row.finishedAt - row.startedAt) / 60000 : null;

/**
 * One arm's rows in a room folder. Most fixtures write finishRun rows (result.json). Two stand-ins write their own:
 * test-drawn-bow-live.mjs (acceptance.json, with arrow damage in tenths of HP per rule arm in results.json; the
 * production rule is the drawn one, and the fixture heals the body below 12 HP, so it cannot die) and
 * test-travel-live.mjs (results.json { results }: pass on arrival with no death).
 */
export async function readArmRows(dir) {
	const rows = await readJson(path.join(dir, 'result.json')).catch(() => null);
	if (Array.isArray(rows)) return rows;
	const accepted = await readJson(path.join(dir, 'acceptance.json')).catch(() => null), acceptance = Array.isArray(accepted) ? accepted[0] : accepted;
	const results = await readJson(path.join(dir, 'results.json')).catch(() => null);
	if (acceptance && typeof acceptance === 'object' && results?.drawnBow) {
		const taken = results.drawnBow.arms?.drawn?.taken;
		return [{ ...acceptance, deaths: 0, damageTaken: Number.isFinite(taken) ? taken / 10 : null, minutes: elapsedMinutes(acceptance), note: 'drawn-bow: idle body, heals below 12 HP' }];
	}
	if (Array.isArray(results?.results)) return results.results.map(run => run.error ? { name: run.id, pass: false, error: String(run.error).split('\n')[0] }
		: { name: run.id, pass: run.arrived === true && run.deaths === 0, deaths: run.deaths ?? null, damageTaken: run.damage ?? null, minutes: Number.isFinite(run.wallSeconds) ? run.wallSeconds / 60 : null,
			blocksMined: run.blocksMined ?? null, pickaxeUses: run.pickaxeUses ?? null, startedAt: run.startedAtEpochMs, finishedAt: run.endedAtEpochMs });
	return [];
}

