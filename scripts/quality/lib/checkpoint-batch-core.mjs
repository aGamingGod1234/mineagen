// Pure parts of checkpoint-batch.mjs: plan checks, the game list, the start gate and scoring. No I/O here.
import { randomInt } from 'node:crypto';

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Checks a plan and expands it into games. Every repeat of a save point draws one loot salt shared by all arms, so the
 * arms of a repeat play the same world with the same loot rolls and differ only in their build. Games are ordered
 * repeat by repeat, with the arm listed first alternating, so both arms of a repeat start in the same wave.
 */
export function expandPlan(plan, { salt = () => randomInt(-2147483648, 2147483647) } = {}) {
	const errors = [];
	const need = (ok, message) => { if (!ok) errors.push(message); };
	need(Number.isInteger(plan.minutes) && plan.minutes >= 1 && plan.minutes <= 240, 'minutes must be an integer 1..240');
	need(!Number.isNaN(Date.parse(plan.deadline ?? '')), 'deadline must be an ISO time with its offset');
	need(typeof plan.codexHome === 'string' && plan.codexHome.length > 0, 'codexHome names the folder holding the Codex sign-in (auth.json)');
	const arms = Object.entries(plan.arms ?? {});
	need(arms.length >= 1, 'arms needs at least one arm');
	for (const [name, arm] of arms) {
		need(NAME.test(name), `arm name ${name} must be lower-case letters, digits and dashes`);
		need(typeof arm.root === 'string' && typeof arm.ref === 'string' && typeof arm.jar === 'string', `arm ${name} needs root, ref and jar`);
		for (const key of Object.keys(arm.env ?? {})) need(/^[A-Z][A-Z0-9_]*$/.test(key), `arm ${name}: env name ${key} is not a plain variable name`);
	}
	const points = Object.entries(plan.savepoints ?? {});
	need(points.length >= 1, 'savepoints needs at least one save point');
	for (const [name, point] of points) {
		need(NAME.test(name), `save point name ${name} must be lower-case letters, digits and dashes`);
		need(typeof point.file === 'string', `save point ${name} needs file`);
		need(Number.isInteger(point.repeats) && point.repeats >= 1, `save point ${name} needs repeats >= 1`);
		need(Array.isArray(point.targets) && point.targets.length >= 1, `save point ${name} needs targets (long-run milestone ids it should reach)`);
	}
	if (errors.length) throw new Error(`bad plan:\n  ${errors.join('\n  ')}`);
	const armNames = arms.map(([name]) => name);
	const games = [];
	const maxRepeats = Math.max(...points.map(([, p]) => p.repeats));
	let flip = 0;
	for (let repeat = 1; repeat <= maxRepeats; repeat++) {
		for (const [name, point] of points) {
			if (repeat > point.repeats) continue;
			const shared = point.salt ?? salt();
			const order = flip++ % 2 ? [...armNames].reverse() : armNames;
			for (const arm of order) games.push({ id: `${name}-r${repeat}-${arm}`, savepoint: name, repeat, arm, salt: shared, attempts: 0, state: 'queued' });
		}
	}
	return games;
}

/** A game may start only when its whole window, plus setup and copy-back, ends before the deadline. */
export function canStart(nowMs, plan, setupMinutes = 10) {
	return nowMs + (plan.minutes + setupMinutes) * 60_000 <= Date.parse(plan.deadline);
}

/** The next queued game, preferring one whose repeat already has an arm running so pairs stay together. */
export function nextGame(games) {
	const queued = games.filter(g => g.state === 'queued');
	if (!queued.length) return null;
	const started = new Set(games.filter(g => g.state !== 'queued').map(g => `${g.savepoint}#${g.repeat}`));
	return queued.find(g => started.has(`${g.savepoint}#${g.repeat}`)) ?? queued[0];
}

/** A game lost with its machine goes back to the front of the queue once; a second loss marks it lost. */
export function loseGame(games, id, reason) {
	const game = games.find(g => g.id === id);
	game.lostReasons = [...(game.lostReasons ?? []), reason];
	if (game.attempts < 2) { game.state = 'queued'; games.splice(games.indexOf(game), 1); games.unshift(game); }
	else game.state = 'lost';
	return game;
}

/**
 * Scores one game from its long-run.json. A target counts only when it was first seen more than `inheritedMs` after
 * the goal started: anything held at the first sample came with the save point. A missing report is unknown, never 0.
 */
export function scoreGame(report, targets, { inheritedMs = 30_000 } = {}) {
	const timeline = report?.timeline ?? report;
	if (!timeline || !Array.isArray(timeline.milestones)) return { known: false, targets: Object.fromEntries(targets.map(t => [t, null])), deaths: null };
	const byId = new Map(timeline.milestones.map(m => [m.id, m]));
	const result = {};
	const inherited = [];
	for (const id of targets) {
		const m = byId.get(id);
		if (!m) { result[id] = null; continue; }
		if (m.reached && Number.isFinite(m.elapsedMs) && m.elapsedMs <= inheritedMs) { inherited.push(id); result[id] = null; continue; }
		result[id] = m.reached ? Math.round(m.elapsedMs / 600) / 100 : false;
	}
	const deaths = Array.isArray(timeline.deaths) ? timeline.deaths.length + (timeline.unexplainedDeaths ?? 0) : null;
	return { known: true, targets: result, inherited, deaths, deathCauses: (timeline.deaths ?? []).map(d => d.cause), playedMinutes: Number.isFinite(timeline.playedMs) ? Math.round(timeline.playedMs / 600) / 100 : null,
		stopReason: timeline.stopReason ?? null, furthest: timeline.furthestMilestone ?? null, calls: timeline.totals?.calls ?? null };
}

/** Per save point and arm: games, games with a known report, and for each target how many reached it and their minutes. */
export function summarize(games, plan) {
	const rows = [];
	for (const [name, point] of Object.entries(plan.savepoints)) {
		for (const arm of Object.keys(plan.arms)) {
			const mine = games.filter(g => g.savepoint === name && g.arm === arm);
			const known = mine.filter(g => g.score?.known);
			const row = { savepoint: name, arm, games: mine.length, known: known.length, lost: mine.filter(g => g.state === 'lost').length, targets: {} };
			for (const target of point.targets) {
				const minutes = known.map(g => g.score.targets[target]).filter(v => typeof v === 'number').sort((a, b) => a - b);
				row.targets[target] = { reached: minutes.length, of: known.filter(g => g.score.targets[target] !== null).length, minutes };
			}
			const deaths = known.map(g => g.score.deaths).filter(Number.isFinite);
			row.deaths = deaths.length ? deaths.reduce((a, b) => a + b, 0) : null;
			row.deathsPerGame = deaths.length ? Math.round(row.deaths / deaths.length * 100) / 100 : null;
			rows.push(row);
		}
	}
	return rows;
}

export function summaryText(rows) {
	const lines = [];
	for (const r of rows) {
		const targets = Object.entries(r.targets).map(([t, v]) => `${t} ${v.reached}/${v.of}${v.minutes.length ? ` (min ${v.minutes.join(', ')})` : ''}`).join('; ');
		lines.push(`${r.savepoint} / ${r.arm}: ${r.known}/${r.games} games scored${r.lost ? `, ${r.lost} lost` : ''}; ${targets}; deaths ${r.deaths ?? 'unknown'}${r.deathsPerGame === null ? '' : ` (${r.deathsPerGame} per game)`}`);
	}
	return lines.join('\n');
}
