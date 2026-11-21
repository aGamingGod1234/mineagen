import { damageTakenBetween } from '../../../coordinator/src/benchmark/quality-metrics.mjs';

/** Vanilla statistic is in tenths of HP; regeneration cannot erase an earlier hit. */
export async function damageCounter(command, agent, objective = 'arena_damage') {
	if (!/^\w+$/.test(agent) || !/^\w+$/.test(objective)) throw new Error('Invalid damage counter selector');
	return statCounter(command, agent, objective, 'minecraft.custom:minecraft.damage_taken');
}

/**
 * The number a command reply ends with: an entity data value with its NBT type suffix (Air is a short, `300s`; Health a
 * float, `20.0f`), or a scoreboard reply (`Probe has 2 [deaths]`). NaN when the reply holds none.
 */
export function replyNumber(text) {
	const reply = String(text ?? '').trim();
	const score = /has (-?\d+) \[[^\]]+\]$/.exec(reply);
	if (score) return Number(score[1]);
	return Number((/(-?\d+(?:\.\d+)?(?:E-?\d+)?)[bsilfd]?$/i.exec(reply) ?? [])[1]);
}

export function damageEvidence(before, after, healthBefore, healthAfter) {
	const damageTaken = damageTakenBetween(before, after);
	return {
		damageTaken, netHealthChange: Number.isFinite(healthBefore) && Number.isFinite(healthAfter) ? healthAfter - healthBefore : null,
		...(damageTaken === null ? { integrity: [{ file: 'damage_taken', error: 'Missing or decreasing vanilla damage counter' }] } : {}),
	};
}

/** Only the setup-owned deathCount objective can establish a death baseline. */
export async function deathCounter(command, agent) {
	if (!/^\w+$/.test(agent)) throw new Error('Invalid death counter selector');
	const match = /has (\d+) \[qo_death\]$/.exec(String(await command(`scoreboard players get ${agent} qo_death`)).trim());
	return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
}

export function deathEvidence(before, after) {
	const valid = [before, after].every(n => Number.isSafeInteger(n) && n >= 0) && after >= before;
	return { before, after, valid, deaths: valid ? after - before : null };
}

/** Deliberate-damage fixtures declare an exact result; unspecified fixtures still require zero damage. */
export function matchesDamageExpectation(row, expected = 0) {
	if (!Number.isFinite(expected) || expected < 0) throw new Error('expectDamageTaken must be a finite nonnegative HP value');
	return Number.isFinite(row.damageTaken) && row.damageTaken === expected
		&& Number.isFinite(row.healthLost) && row.healthLost >= 0 && row.healthLost <= expected;
}

/** Reader for a vanilla statistic objective: a number, 0 when the player has no score yet, null when unreadable. */
export async function statCounter(command, agent, objective, criterion) {
	if (!/^\w+$/.test(agent) || !/^\w+$/.test(objective)) throw new Error('Invalid stat counter selector');
	await command(`scoreboard objectives add ${objective} ${criterion}`);
	return async () => {
		const reply = String(await command(`scoreboard players get ${agent} ${objective}`));
		const match = /has (-?\d+) \[([^\]]+)\]/.exec(reply);
		if (match?.[2] === objective) return Number(match[1]);
		if (reply.includes('none is set')) return 0;
		return null;
	};
}

/**
 * Shield blocked share per arm from vanilla counters in tenths of HP. Each case holds the four counter reads around it.
 * Pass: the drawn arm blocks at least minShare of the damage and more than the arrow-only arm. A missing or decreasing
 * read makes the whole run invalid evidence (integrity rows), never a zero.
 */
export function shieldShareVerdict(cases, minShare) {
	const arms = { arrowOnly: { blocked: 0, taken: 0, cases: [] }, drawn: { blocked: 0, taken: 0, cases: [] } };
	const integrity = [];
	const delta = (before, after) => Number.isSafeInteger(before) && Number.isSafeInteger(after) && after >= before ? after - before : null;
	for (const { arm, blocked0, blocked1, taken0, taken1, ...rest } of cases) {
		const blocked = delta(blocked0, blocked1), taken = delta(taken0, taken1);
		arms[arm].cases.push({ ...rest, blocked, taken });
		if (blocked === null || taken === null) { integrity.push({ arm, ...rest, error: 'Missing or decreasing vanilla shield or damage counter' }); continue; }
		arms[arm].blocked += blocked; arms[arm].taken += taken;
	}
	if (integrity.length) return { arms, shareArrowOnly: null, shareDrawn: null, minShare, pass: false, integrity };
	const share = (arm) => arms[arm].blocked + arms[arm].taken > 0 ? arms[arm].blocked / (arms[arm].blocked + arms[arm].taken) : null;
	const shareArrowOnly = share('arrowOnly'), shareDrawn = share('drawn');
	return { arms, shareArrowOnly, shareDrawn, minShare, pass: shareDrawn !== null && shareDrawn >= minShare && shareDrawn > (shareArrowOnly ?? 0) };
}
