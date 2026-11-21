import { installTickRate, fixtureTickRate } from '../watch-replay.mjs';
import { damageCounter, damageEvidence, deathCounter, deathEvidence } from './damage-counter.mjs';

/**
 * FIXTURE_TICK_RATE for a hand-rolled live fixture (one that starts java itself with its own RCON client and bridge):
 * installTickRate on a bare object around the fixture's reconnecting command, with its clock fed from the bridge's
 * observations. Setup stays at 20 TPS; rate.play() raises the rate for a case's play and returns end(), which records
 * what the play ran at and goes back to 20. At the default 20 every wait is the plain wall-clock one, as before.
 * Call it once RCON is up and the bridge exists (before bridge.start()).
 */
export function handRolledTickRate(command, bridge, agent, { tickRate = fixtureTickRate() } = {}) {
	const rate = installTickRate({ command }, tickRate);
	bridge.on('observation', e => rate.clock.observe(e.payload?.world?.gameTime));
	let counters = null;
	// Vanilla's cumulative damage and death counts, so healing during play cannot hide a hit. Recorded only: no verdict reads them.
	const read = async () => {
		counters ??= Promise.all([
			damageCounter(command, agent),
			command('scoreboard objectives add fixture_deaths deathCount').then(() => () => deathCounter(command, agent, { objective: 'fixture_deaths', unsetIsZero: true })),
		]).catch(() => null);
		const pair = await counters;
		if (!pair) return { damage: null, deaths: null };
		return { damage: await pair[0]().catch(() => null), deaths: await pair[1]().catch(() => null) };
	};
	/** Raises the rate for one case's play; end() returns { tickRate, rates, gameSeconds, wallSeconds, damageTaken, deaths } and goes back to 20. */
	rate.play = async () => {
		const before = await read();
		await rate.fastRate();
		const t0 = rate.clock.now(), wall0 = Date.now(), timer = await rate.gameTimer();
		return async () => {
			const tick = { tickRate: rate.tickRate, rates: await timer.rates().catch(() => null), seconds: Math.round((rate.clock.now() - t0) / 1000),
				gameSeconds: Math.round((await timer.elapsed()) / 1000), wallSeconds: Math.round((Date.now() - wall0) / 1000) };
			await rate.normalRate();
			const after = await read();
			return { ...tick, damageTaken: damageEvidence(before.damage, after.damage).damageTaken, deaths: deathEvidence(before.deaths, after.deaths).deaths };
		};
	};
	/** What the server held (tick query), for the run's output. */
	rate.report = async () => ({ tickRate: rate.tickRate, held: await rate.tickReport() });
	return rate;
}
