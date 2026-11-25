import { evaluatePlanCheck, parsePlanCheck } from './plan-checks.mjs';

// The task clocks: minutes lost on each unmet plan task with no verified progress, kept for the whole world. A death, a
// plan rewrite, a renamed step or a move to another site does not start a clock over; only progress on the task does.
// In the 8 morning measure games (25 Nov) the portal stage alone stalled in 5 of 8: one game spent 182 min across 5 lives
// looking for a lava pool (each life's own clock was short, the task's total was not), and after a 20-minute budget the
// bot stayed on the fired task 1,037 min in all. Re-earning iron after a death is not progress on the lava pool, and
// climbing back above y-45 is not a new failure of the descent.
export const TASK_BUDGET_MS = 20 * 60_000;
// Two lives lost on one task, each after real time on it, also call for a change of method (a quick death does not).
export const TASK_LIFE_MS = 5 * 60_000;
export const TASK_DEATHS = 2;
// A gap between samples longer than this is a pause (a restart, a long model turn), not time on the task.
const MAX_STEP_MS = 60_000;
// Sites are 32-block cells of the task's dimension.
const CELL = 32;
// A remembered pool this far from every tried cell is another site.
const FAR_SITE = 100;
const MAX_CLOCKS = 24, MAX_SITES = 8, MAX_MET = 96;
// Steps that are only things held: redone after a death, they are a rebuild, not time on the task ahead.
const HELD = new Set(['has', 'tool', 'worn', 'offhand']);

/**
 * The clock key of a plan check: the check with spacing removed, never the step id (a rewrite renames steps). The
 * dimension is not in the key: the walk back to a Nether task after a death in the Nether is time on that task.
 */
export function taskKey(check) {
	return typeof check === 'string' && check.trim() ? check.replace(/\s+/g, '') : null;
}

// Progress inside a task, against its best in this world: a count term rising (rods 2/6 -> 3/6), a new low on the way
// down. Climbing back to a depth already reached is not progress: the best is the deepest so far.
function score(result) {
	return (result?.terms ?? []).reduce((n, t) => !Number.isFinite(t.metric) ? n : t.better === 'higher' ? n + Math.min(t.metric, t.count ?? t.metric) : t.better === 'lower' ? n - t.metric : n, 0);
}

const cellOf = at => `${Math.floor(at.x / CELL)},${Math.floor(at.z / CELL)}`;

/**
 * The clocks after one more live sample. focus is the plan step the bot is on now; steps is the plan in order. Time goes
 * to the focus's task while its check was never met; a redone position step (back down after a climb) charges the first
 * task never met; a redone held-item step (a rebuild) charges nothing.
 */
export function noteTaskTime(ledger, { at, worldId, steps = [], focus = null, observation: o, known, budgetMs = TASK_BUDGET_MS }) {
	if (!Number.isFinite(at) || !worldId || !o || o.ready !== true || o.player?.dead === true) return ledger ?? null;
	let next = ledger?.worldId === worldId ? { ...ledger, clocks: { ...ledger.clocks }, met: [...ledger.met] } : { worldId, clocks: {}, met: [], last: null, wake: false };
	const dimension = o.world?.dimension ?? null, here = o.position ?? o.player?.position ?? o.player;
	const met = new Set(next.met), checked = steps.filter(s => typeof s?.check === 'string' && s.check);
	const results = new Map(), gained = new Set();
	for (const step of checked) {
		const key = taskKey(step.check);
		let result;
		try { result = evaluatePlanCheck(step.check, o, known); } catch { continue; }
		results.set(step, { key, result });
		if (result.ok === true && !met.has(key)) { met.add(key); delete next.clocks[key]; }
		const clock = next.clocks[key], best = score(result);
		// A count rising past its best in this world is progress: the clock starts over, its sites stay.
		if (clock && best > clock.best) { next.clocks[key] = { ...clock, best, ms: 0, lifeMs: 0, deaths: 0, netherDeaths: 0, firedAt: null }; gained.add(key); }
	}
	next.met = [...met].slice(-MAX_MET);
	const gap = Number.isFinite(next.last) ? at - next.last : 0;
	next.last = at;
	const frontier = checked.find(s => !met.has(results.get(s)?.key) && s.status !== 'complete');
	let charged = null;
	const own = focus && results.get(focus);
	if (own && !met.has(own.key) && focus.status !== 'complete') charged = focus;
	else if (own && parsePlanCheck(focus.check).terms.some(t => !HELD.has(t.type))) charged = frontier ?? null;
	else if (!own) charged = frontier ?? null;
	if (!charged || !(gap > 0)) return next;
	const key = results.get(charged).key, step = Math.min(gap, MAX_STEP_MS);
	if (gained.has(key)) return next;
	const clock = next.clocks[key] ?? { key, check: charged.check, label: charged.label ?? charged.id, ms: 0, lifeMs: 0, deaths: 0, netherDeaths: 0, lives: 0, sites: [], best: score(results.get(charged).result), firedAt: null };
	const sites = [...clock.sites];
	if (here && [here.x, here.z].every(Number.isFinite) && dimension) {
		const cell = `${dimension}:${cellOf(here)}`, row = sites.find(s => s.cell === cell);
		if (row) Object.assign(sites[sites.indexOf(row)] = { ...row }, { ms: row.ms + step });
		else sites.push({ cell, dimension, x: Math.round(here.x), z: Math.round(here.z), ms: step });
		sites.sort((a, b) => b.ms - a.ms).splice(MAX_SITES);
	}
	const updated = { ...clock, label: charged.label ?? clock.label, ms: clock.ms + step, lifeMs: clock.lifeMs + step, lifeDimension: dimension, sites };
	if (updated.firedAt == null && (updated.ms >= budgetMs || updated.deaths >= TASK_DEATHS)) { updated.firedAt = at; next.wake = true; }
	next.clocks[key] = updated;
	const keys = Object.keys(next.clocks);
	if (keys.length > MAX_CLOCKS) for (const k of keys.sort((a, b) => next.clocks[a].ms - next.clocks[b].ms).slice(0, keys.length - MAX_CLOCKS)) delete next.clocks[k];
	return next;
}

/**
 * A death in dimension: each task charged this life ends a life; it counts as a failed try only after real time on it.
 * Two such deaths fire the clock on its next charged sample.
 */
export function noteTaskDeath(ledger, dimension = null) {
	if (!ledger?.clocks) return ledger ?? null;
	const clocks = { ...ledger.clocks };
	for (const [key, clock] of Object.entries(clocks)) {
		if (!(clock.lifeMs > 0)) continue;
		const failed = clock.lifeMs >= TASK_LIFE_MS;
		clocks[key] = { ...clock, deaths: clock.deaths + (failed ? 1 : 0), netherDeaths: (clock.netherDeaths ?? 0) + (failed && dimension === 'minecraft:the_nether' ? 1 : 0), lives: clock.lives + 1, lifeMs: 0 };
	}
	return { ...ledger, clocks };
}

/** The wake for a clock that just fired, once. */
export function takeTaskWake(ledger) {
	if (!ledger?.wake) return false;
	ledger.wake = false;
	return true;
}

/** The fired clock for the task the bot is on (or the first fired one), null when none has fired. */
export function firedTask(ledger, { steps = [] } = {}) {
	if (!ledger?.clocks) return null;
	const open = steps.filter(s => s?.status !== 'complete').map(s => taskKey(s?.check)).filter(Boolean);
	return open.map(k => ledger.clocks[k]).find(c => c?.firedAt != null) ?? null;
}

/**
 * The switch line for a fired clock: what was lost, where, and a way that can still work, named from memory. The lava
 * stage goes to a remembered pool away from the tried cells, else a new site; a frame to another pool; a Nether task
 * after two deaths back to the kit first.
 */
export function taskSwitchLine(clock, { known = null, position = null, observation = null } = {}) {
	if (!clock) return null;
	const minutes = Math.round(clock.ms / 60_000), lives = clock.lives + 1;
	const dimension = observation?.world?.dimension ?? clock.lifeDimension;
	const tried = clock.sites.filter(s => !dimension || s.dimension === dimension).slice(0, 3).map(s => `${s.x},${s.z} (${Math.max(1, Math.round(s.ms / 60_000))} min)`).join(', ');
	const head = `${clock.label}: ${minutes} min${lives > 1 ? ` over ${lives} lives` : ''}${clock.deaths ? `, ${clock.deaths} death${clock.deaths > 1 ? 's' : ''}` : ''} with no gain; tried near ${tried || 'here'}`;
	const terms = parsePlanCheck(clock.check).terms;
	const far = p => clock.sites.every(s => s.dimension !== p.dimension || Math.hypot(p.x - s.x, p.z - s.z) >= FAR_SITE);
	const pools = (known?.lavaPools ?? []).filter(p => p.dimension === dimension);
	const away = pools.filter(far).sort((a, b) => position ? Math.hypot(a.x - position.x, a.z - position.z) - Math.hypot(b.x - position.x, b.z - position.z) : 0)[0];
	let way;
	if ((clock.netherDeaths ?? 0) >= TASK_DEATHS) way = 're-kit before going back in: wear armour, carry a shield and food; then the same task by a different approach';
	else if (terms.some(t => ['lava', 'y', 'frame'].includes(t.type))) way = away ? `go to the lava remembered at ${away.x},${away.y},${away.z} (${away.sources} sources), away from the tried sites, and cast there`
		: `pick a new site at least ${FAR_SITE} blocks from the tried ones and go down to y-54 there; a cave going down or lava heard through rock is the way in`;
	else way = 'a different method or site from the ones tried';
	return `${head}; switch now: ${way}. Stay only on a new fact that this site will work.`;
}
