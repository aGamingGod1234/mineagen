import { damageTakenBetween } from '../../../coordinator/src/benchmark/quality-metrics.mjs';

/** Vanilla statistic is in tenths of HP; regeneration cannot erase an earlier hit. */
export async function damageCounter(command, agent, objective = 'arena_damage') {
	if (!/^\w+$/.test(agent) || !/^\w+$/.test(objective)) throw new Error('Invalid damage counter selector');
	await command(`scoreboard objectives add ${objective} minecraft.custom:minecraft.damage_taken`);
	return async () => {
		const reply = String(await command(`scoreboard players get ${agent} ${objective}`));
		const match = /has (-?\d+) \[([^\]]+)\]/.exec(reply);
		if (match?.[2] === objective) return Number(match[1]);
		if (reply.includes('none is set')) return 0;
		return null;
	};
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
