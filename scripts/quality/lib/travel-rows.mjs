// The finishRun row of one travel course (scripts/quality/test-travel-live.mjs), so a room batch can judge a course:
// pass is arrival with no death, and the wear travel spends is pickaxe uses per 100 blocks gained toward the target.
const round = value => Math.round(value * 10) / 10;

/** Pickaxe uses per 100 blocks gained toward the target; null when either is unknown or the course gained nothing. */
export function pickaxeUsesPer100(run) {
	return Number.isFinite(run.pickaxeUses) && Number.isFinite(run.progressBlocks) && run.progressBlocks > 0 ? round(100 * run.pickaxeUses / run.progressBlocks) : null;
}

/**
 * The course's run as a finishRun row. A run with an error stays an error (INVALID). maxPickaxeUsesPer100 (from the course,
 * else the courses file) is an optional per-run cap: over it the row misses its bar, and so does any pickaxe use on a
 * course that gained nothing. Without a cap there is no bar; an A/B compares the per-100 figure between arms.
 */
export function travelRow(run, { maxPickaxeUsesPer100 = null } = {}) {
	// minutes: the course's own wall time, which ai-room-report.mjs reads before it falls back to the whole arm's.
	const row = { ...run, name: run.id, startedAt: run.startedAt ?? run.startedAtEpochMs ?? null, finishedAt: run.finishedAt ?? run.endedAtEpochMs ?? null,
		minutes: Number.isFinite(run.wallSeconds) ? run.wallSeconds / 60 : null };
	if (run.error) return row;
	row.pickaxeUsesPer100Blocks = pickaxeUsesPer100(run);
	// An unknown death count is missing evidence (INVALID), never a measured miss or a pass.
	if (!Number.isFinite(run.deaths)) row.integrity = [...(Array.isArray(run.integrity) ? run.integrity : []), { file: 'scoreboard', error: 'death count unknown' }];
	const arrived = run.arrived === true, alive = run.deaths === 0;
	row.pass = arrived && alive;
	if (row.pass) row.passReason = run.targetSeen !== undefined ? `target seen: ${run.targetSeen}` : `arrived, ${run.endDistance} blocks from the target`;
	else row.failReason = [arrived ? null : `not arrived: ${run.endDistance} of ${run.startDistance} blocks left${run.gaveUp ? ` (${run.gaveUp})` : ''}`,
		alive || !Number.isFinite(run.deaths) ? null : `${run.deaths} death${run.deaths === 1 ? '' : 's'}`].filter(Boolean).join('; ');
	if (Number.isFinite(maxPickaxeUsesPer100) && Number.isFinite(run.pickaxeUses)) {
		const per100 = row.pickaxeUsesPer100Blocks;
		row.pickaxeBar = maxPickaxeUsesPer100;
		row.bar = per100 === null ? run.pickaxeUses === 0 : per100 <= maxPickaxeUsesPer100;
		if (!row.bar) row.barReason = per100 === null ? `${run.pickaxeUses} pickaxe uses with no blocks gained` : `${per100} pickaxe uses per 100 blocks gained, over ${maxPickaxeUsesPer100}`;
	}
	return row;
}
