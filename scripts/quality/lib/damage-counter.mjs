import { damageTakenBetween } from '../../../coordinator/src/benchmark/quality-metrics.mjs';

/** Vanilla statistic is in tenths of HP; an unreadable sample is null. */
export async function damageCounter(command, agent, objective = 'arena_damage') {
	if (!/^\w+$/.test(agent) || !/^\w+$/.test(objective)) throw new Error('Invalid damage counter selector');
	const read = await statCounter(command, agent, objective, 'minecraft.custom:minecraft.damage_taken');
	return () => read().catch(() => null);
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

/** Keep the counter's integrity alongside the number, including in multi-leg results. */
export function recordDamageEvidence(row, before, after, field = 'damageTaken') {
	const { damageTaken, integrity } = damageEvidence(before, after);
	row[field] = damageTaken;
	if (integrity) (row.integrity ??= []).push(...integrity);
}

/**
 * The vanilla death count from a deathCount objective, or null when the reply holds none: the reply ends "has 1 [qo_death]",
 * which a trailing-number parse reads as NaN (and `|| 0` then turned every death into 0). Only the setup-owned qo_death
 * objective (applyQualitySetup sets it to 0) can establish a baseline, so an unset score is null. A fixture whose own
 * objective is created before the body exists (boot() adds `deaths`) passes { objective: 'deaths', unsetIsZero: true }:
 * vanilla leaves a score unset until the first death.
 */
export async function deathCounter(command, agent, { objective = 'qo_death', unsetIsZero = false } = {}) {
	if (!/^\w+$/.test(agent) || !/^\w+$/.test(objective)) throw new Error('Invalid death counter selector');
	return scoreboardCounter(command, agent, objective, { unsetIsZero });
}

/** Read a nonnegative count from an existing objective. */
export async function scoreboardCounter(command, agent, objective, { unsetIsZero = false } = {}) {
	const reply = String(await command(`scoreboard players get ${agent} ${objective}`)).trim();
	const match = /has (\d+) \[([^\]]+)\]$/.exec(reply);
	if (match?.[2] === objective && Number.isSafeInteger(Number(match[1]))) return Number(match[1]);
	return unsetIsZero && /none is set/i.test(reply) ? 0 : null;
}

export function deathEvidence(before, after) {
	const valid = [before, after].every(n => Number.isSafeInteger(n) && n >= 0) && after >= before;
	return { before, after, valid, deaths: valid ? after - before : null };
}

/** Keep an unreadable death count distinct from a run with zero deaths. */
export function recordDeathEvidence(row, before, after, field = 'deaths') {
	const evidence = deathEvidence(before, after);
	row[field] = evidence.deaths;
	if (!evidence.valid) (row.integrity ??= []).push({ file: 'deaths', error: 'Missing or decreasing vanilla death counter' });
	return evidence;
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
 * Pass: the drawn arm blocks at least minShare of the damage and more than the arrow-only arm (when {@code ran} has it). A missing or decreasing
 * read, or an arm that no arrow hit or was blocked in, makes the whole run invalid evidence (integrity rows), never a zero.
 */
export function shieldShareVerdict(cases, minShare, ran = ['arrowOnly', 'drawn']) {
	const arms = Object.fromEntries(ran.map(arm => [arm, { blocked: 0, taken: 0, cases: [] }]));
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
	const shareArrowOnly = arms.arrowOnly ? share('arrowOnly') : null, shareDrawn = share('drawn');
	// An arm no arrow hit or was blocked in measured nothing: the comparison is invalid evidence, not a 0% baseline.
	const unmeasured = Object.keys(arms).filter(arm => share(arm) === null).map(arm => ({ arm, error: 'No arrow damage taken or blocked in this arm' }));
	if (unmeasured.length) return { arms, shareArrowOnly, shareDrawn, minShare, pass: false, integrity: unmeasured };
	// Without the arrow-only arm (RULE_ARMS=drawn) the drawn arm answers to the floor alone.
	return { arms, shareArrowOnly, shareDrawn, minShare, pass: shareDrawn >= minShare && (!arms.arrowOnly || shareDrawn > shareArrowOnly) };
}
