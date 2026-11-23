// Whole-game facts for stage-score.mjs: when each milestone was first seen, how each death happened (fall height, what
// was running at the top of the fall, dimension, first or repeat, where the body respawned), the End fight, the most
// rods, pearls and eyes held, and model calls and input tokens spent before each milestone.
// The scorer feeds rows from its existing passes; finish() reads only those compact rows. null always means "not
// observed": a game with no End entry has no End numbers, and a death with no height evidence has no fall height.
import { itemCount } from '../../../coordinator/src/benchmark/quality-metrics.mjs';
import { LONG_RUN_MILESTONES } from '../../../coordinator/src/benchmark/long-run.mjs';
import { classifyDeath } from './death-causes.mjs';

const finite = Number.isFinite;
const END = 'minecraft:the_end';
// A fall counts from this many blocks: lower drops are steps and stairs.
export const FALL_BLOCKS = 4;
export const LONG_FALL_BLOCKS = 20;
// How far back a death looks for the top of its fall in the samples when the coordinator's death row has no trail.
// The death row's own trail covers about the last 10 s.
const FALL_LOOKBACK_MS = 10_000;
// How long after its coordinator row the sample that first shows a death may come (stage-score SAMPLE_DEATH_BOUND_MS).
const SAMPLE_DEATH_BOUND_MS = 60_000;
// Armour points per piece, vanilla values (the agent_death row's armor field is the same total).
const ARMOUR = { leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3] };
const PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
const CRYSTAL_VIEW = 140;
const PEAK_ITEMS = { blaze_rod: 'blaze_rod', ender_pearl: 'ender_pearl', ender_eye: 'ender_eye' };
const minutes = (ms) => finite(ms) ? Math.round(ms / 6000) / 10 : null;
const round1 = (n) => finite(n) ? Math.round(n * 10) / 10 : null;
// Model latency windows: wall-clock 10-minute buckets, aligned to the epoch so concurrent games pool bucket by bucket.
export const LATENCY_BUCKET_MS = 600_000;
/** Nearest-rank quantile of an ascending list, or null when it is empty. */
export const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null;
/**
 * p50 and p90 of native_model_call totalMs over calls ({ at, totalMs }), overall and per wall-clock bucket. Each bucket
 * keeps its sorted values so a verdict can pool games that ran at the same time.
 */
export function modelLatency(calls, { startedAt = null } = {}) {
	// A call cut short by an interrupt was timed only to the interrupt: counted apart, not in the tail.
	const timed = calls.filter((c) => finite(c.totalMs) && finite(c.at) && !c.interrupted);
	const interruptedCalls = calls.filter((c) => c.interrupted).length;
	if (!timed.length) return interruptedCalls ? { calls: 0, interruptedCalls, p50Ms: null, p90Ms: null, maxMs: null, byClock10Min: [] } : null;
	const all = timed.map((c) => c.totalMs).sort((a, b) => a - b), buckets = new Map();
	// A call's bucket is when the model answered: its usage row can be traced later, after a tool ran.
	for (const c of timed) { const from = Math.floor((finite(c.endedAt) ? c.endedAt : c.at) / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS; (buckets.get(from) ?? buckets.set(from, []).get(from)).push(c.totalMs); }
	return { calls: all.length, interruptedCalls, p50Ms: quantile(all, 0.5), p90Ms: quantile(all, 0.9), maxMs: all.at(-1),
		byClock10Min: [...buckets.entries()].sort(([a], [b]) => a - b).map(([from, values]) => {
			values.sort((a, b) => a - b);
			return { fromEpochMs: from, fromMinute: finite(startedAt) ? minutes(from - startedAt) : null, calls: values.length, p50Ms: quantile(values, 0.5), p90Ms: quantile(values, 0.9), totalMs: values };
		}),
		basis: 'native_model_call totalMs in the window, one per modelCallId, interrupted calls left out: Codex times input to first tool request, Claude request to end of call; nearest-rank quantiles; buckets are wall-clock 10 minutes from the epoch, by when the model answered (endedAt, else the trace time)' };
}
const short = (dimension) => typeof dimension === 'string' ? dimension.replace(/^minecraft:(the_)?/, '') : 'unknown';

/** Armour points from a sample's equipment text, or null when the sample has none. */
export function armourPoints(equipmentNbt) {
	if (typeof equipmentNbt !== 'string' || !equipmentNbt.trim().startsWith('[')) return null;
	let total = 0;
	for (const [material, points] of Object.entries(ARMOUR)) PIECES.forEach((piece, i) => { total += points[i] * Math.min(1, itemCount(equipmentNbt, new RegExp(`^minecraft:${material}_${piece}$`))); });
	if (itemCount(equipmentNbt, /^minecraft:turtle_helmet$/) > 0) total += 2;
	return total;
}

/** The top of a fall in a list of { at, y, ... } points before a death at deathY: the highest point (earliest of ties). */
function fallTop(points, deathY) {
	let top = null;
	for (const p of points) if (finite(p.y) && (!top || p.y > top.y)) top = p;
	if (!top || !finite(deathY)) return null;
	return { ...top, blocks: round1(Math.max(0, top.y - deathY)) };
}

/**
 * One row per death: deaths are the scorer's deathRecords (at, cause evidence); trails are the coordinator's
 * agent_death rows (dimension, position, armour, the running action and reflex, and a trail of the last ~10 s).
 */
export function describeDeaths(deaths, { trails = [], samples = [], startedAt = null } = {}) {
	// A death's coordinator row is the one at its time; a death first seen in the samples is timed by that sample (up to
	// a minute after the row), so it takes the nearest earlier row in its own life that no other death took.
	const taken = new Set();
	const near = deaths.map((death) => trails.find((row) => Math.abs(row.at - death.at) < 1500) ?? null);
	near.forEach((row) => row && taken.add(row));
	const trailOf = (death) => {
		const i = deaths.indexOf(death);
		if (near[i]) return near[i];
		const row = trails.filter((t) => !taken.has(t) && t.at <= death.at && death.at - t.at <= SAMPLE_DEATH_BOUND_MS && (!finite(death.prevAt) || t.at > death.prevAt)).at(-1) ?? null;
		if (row) taken.add(row);
		return row;
	};
	return deaths.map((death, index) => {
		const trail = trailOf(death);
		// A death with evidence has the server's time. A death seen only in the samples is timed by the sample that showed
		// it (an upper bound), so only samples before that one were alive before it.
		// A matched death row carries the server's time of death, which can be earlier than a sample-timed death.
		const exact = Boolean(trail) || ['message', 'damageType', 'attacker', 'directAttacker'].some((key) => death[key] != null);
		const at = trail?.at ?? death.at;
		// Each death sees only its own life: samples after the previous death and before the next one.
		const prevAt = finite(death.prevAt) ? death.prevAt : -Infinity, nextAt = finite(death.nextAt) ? death.nextAt : Infinity;
		const before = samples.filter((s) => (exact ? s.at <= at : s.at < at) && s.at >= at - FALL_LOOKBACK_MS && s.at > prevAt && s.health > 0);
		const last = before.at(-1) ?? null;
		// The counter baseline is the last living sample before this death, even one from an earlier life.
		const baseline = samples.filter((s) => (exact ? s.at <= at : s.at < at) && s.health > 0).at(-1) ?? null;
		const stepped = (s) => s.health <= 0 || finite(s.deathCounter) && finite(baseline?.deathCounter) && s.deathCounter > baseline.deathCounter;
		// The sample that shows the body dead (health 0) inside this life, at most 10 s on.
		const dead = samples.find((s) => s.at >= (last?.at ?? at - FALL_LOOKBACK_MS) && s.at > (last?.at ?? -Infinity) && s.at <= at + FALL_LOOKBACK_MS && s.at > prevAt && s.at < nextAt && s.health <= 0) ?? null;
		const dimension = trail?.dimension ?? dead?.dimension ?? last?.dimension ?? null;
		// Without the death row, only a sample showing the body dead gives the death height; a living one would read 0.
		const position = trail?.position ?? dead?.position ?? null;
		// The coordinator's trail points carry no dimension: points from before a portal trip in the last 10 s are left out.
		// Points between the last sample elsewhere and the first sample back in this dimension are in an unknown one.
		const otherDimensionAt = before.filter((s) => s.dimension && dimension && s.dimension !== dimension).reduce((t, s) => Math.max(t, s.at), -Infinity);
		// No sample back in this dimension: no trail point is known to be in it, so the fall is unknown.
		const backAt = finite(otherDimensionAt) ? before.find((s) => s.at > otherDimensionAt && s.dimension === dimension)?.at ?? Infinity : -Infinity;
		const points = trail?.trail?.length
			? trail.trail.map((p) => ({ at: trail.at + (p.s ?? 0) * 1000, y: p.y, health: p.health ?? null, action: p.action ?? null, reflex: p.reflex ?? null })).filter((p) => p.at >= backAt)
			: before.filter((s) => s.dimension === dimension).map((s) => ({ at: s.at, y: s.position?.y, health: s.health, action: null, reflex: null }));
		const top = fallTop(points, position?.y);
		// The respawn is the first living sample after the body was seen dead (or after its death counter stepped).
		// A living sample whose death counter stepped is already the respawned body.
		const step = dead ? null : samples.find((s) => s.at >= at && (!finite(death.nextAt) || s.at < death.nextAt) && stepped(s)) ?? null;
		const deadAt = dead?.at ?? step?.at ?? null;
		const respawn = step?.health > 0 ? step : finite(deadAt) ? samples.find((s) => s.at > deadAt && s.at > at && s.health > 0 && (!finite(death.nextAt) || s.at < death.nextAt)) ?? null : null;
		const fallDistance = before.filter((s) => s.dimension === dimension).reduce((m, s) => finite(s.fallDistance) ? Math.max(m ?? 0, s.fallDistance) : m, null);
		return {
			at: death.at, minute: finite(startedAt) ? minutes(death.at - startedAt) : null, ordinal: index + 1, repeat: index > 0,
			cause: death.cause ?? classifyDeath(death).cause, dimension, position,
			armour: trail?.armor ?? last?.armour ?? null, armourBasis: finite(trail?.armor) ? 'death row' : finite(last?.armour) ? 'last living sample' : null,
			action: trail?.action ?? null, reflex: trail?.reflex ?? null,
			fall: top ? { blocks: top.blocks, secondsBeforeDeath: round1(((trail?.at ?? death.at) - top.at) / 1000), healthAtTop: round1(top.health), actionAtTop: top.action, reflexAtTop: top.reflex,
				basis: trail?.trail?.length ? 'death row trail (coordinator observations over the last ~10 s)' : 'samples over the last 10 s; running action unknown' } : null,
			maxFallDistance: round1(fallDistance),
			respawn: respawn ? { at: respawn.at, secondsAfterDeath: round1((respawn.at - (trail?.at ?? death.at)) / 1000), dimension: respawn.dimension ?? null, position: respawn.position ?? null } : null,
		};
	});
}

/**
 * Deaths by mechanism, summed over any list of described deaths (one game or many): per dimension and cause, how
 * many deaths, how many had a fall height, fell FALL_BLOCKS+ and LONG_FALL_BLOCKS+, were at full health at the top,
 * first vs repeat deaths, and what was running at the top of each fall of FALL_BLOCKS+.
 */
export function mechanismTable(deaths) {
	const rows = {};
	for (const d of deaths) {
		const key = `${short(d.dimension)} ${d.cause}`;
		const row = rows[key] ??= { dimension: d.dimension ?? null, cause: d.cause, deaths: 0, first: 0, repeat: 0, measuredFall: 0, fell4: 0, fell20: 0, fullHealthAtTop: 0, actionAtTop: {}, reflexAtTop: {}, respawnDimension: {} };
		row.deaths++; row[d.repeat ? 'repeat' : 'first']++;
		if (d.respawn) row.respawnDimension[short(d.respawn.dimension)] = (row.respawnDimension[short(d.respawn.dimension)] ?? 0) + 1;
		if (!d.fall) continue;
		row.measuredFall++;
		if (d.fall.blocks < FALL_BLOCKS) continue;
		row.fell4++;
		if (d.fall.blocks >= LONG_FALL_BLOCKS) row.fell20++;
		if (d.fall.healthAtTop >= 20) row.fullHealthAtTop++;
		const action = d.fall.actionAtTop ?? 'unknown', reflex = d.fall.reflexAtTop ?? 'none';
		row.actionAtTop[action] = (row.actionAtTop[action] ?? 0) + 1;
		row.reflexAtTop[reflex] = (row.reflexAtTop[reflex] ?? 0) + 1;
	}
	return Object.values(rows).sort((a, b) => b.deaths - a.deaths || a.cause.localeCompare(b.cause));
}

/** The facts collector. Feed it rows, then call finish() once. */
export function gameFacts() {
	const samples = [], trails = [], commands = [], progress = [], calls = [];
	let sawAdvancements = false;
	const firstSeen = {}, peak = Object.fromEntries(Object.keys(PEAK_ITEMS).map((k) => [k, null]));
	return {
		/** A quality sample after the scorer's own filters (window, agent, inventory cleared at death). */
		sample(s) {
			if (!finite(s?.at)) return;
			const nbt = typeof s.inventoryNbt === 'string' && s.inventoryNbt.trim().startsWith('[') ? s.inventoryNbt : null;
			samples.push({ at: s.at, health: s.health, deathCounter: s.deathCounter ?? null, dimension: s.dimension ?? null, position: s.position ?? null, fallDistance: s.fallDistance ?? null, armour: armourPoints(s.equipmentNbt) });
			if (Array.isArray(s.advancements)) sawAdvancements = true;
			for (const m of LONG_RUN_MILESTONES) {
				if (firstSeen[m.id] != null) continue;
				const holds = m.item ? itemCount(`${s.inventoryNbt ?? ''}${s.equipmentNbt ?? ''}`, m.item) > 0 : m.dimension ? s.dimension === m.dimension : s.advancements?.includes(m.advancement) ?? false;
				if (holds) firstSeen[m.id] = s.at;
			}
			if (nbt) for (const [key, id] of Object.entries(PEAK_ITEMS)) peak[key] = Math.max(peak[key] ?? 0, itemCount(nbt, new RegExp(`^minecraft:${id}$`)));
		},
		/** A coordinator agent_death trace row. */
		deathRow(row) {
			const at = row?.diedAtEpochMs ?? row?.at;
			if (!finite(at) || trails.some((t) => Math.abs(t.at - at) < 1500)) return;
			trails.push({ at, dimension: row.dimension ?? null, position: row.position ?? null, armor: finite(row.armor) ? row.armor : null, action: row.action?.type ?? null, reflex: row.reflex ?? null, trail: Array.isArray(row.trail) ? row.trail : [] });
		},
		/** An action_command envelope payload at its time. */
		command(at, payload) { if (finite(at) && typeof payload?.actionType === 'string') commands.push({ at, actionType: payload.actionType, actionId: payload.actionId ?? null }); },
		/** A Watcher progress row (arena-watch/<agent>-progress.jsonl). */
		progress(row) {
			if (row?.type !== 'progress' || !finite(row.atMs)) return;
			const dragon = row.targets?.dragon, crystals = row.targets?.crystals;
			if (row.dim !== END && !dragon && !crystals) return;
			// The Watcher counts crystals within 192 blocks of the body on each axis; the towers stand within about 45 blocks of
			// the island centre, so only a body within CRYSTAL_VIEW of the centre sees every one of them.
			const seesAll = finite(row.pos?.x) && finite(row.pos?.z) && Math.max(Math.abs(row.pos.x), Math.abs(row.pos.z)) <= CRYSTAL_VIEW && (!finite(row.pos?.y) || row.pos.y > -100);
			progress.push({ at: row.atMs, dimension: row.dim ?? null, dragonHealth: finite(dragon?.health) ? dragon.health : null, crystalsLeft: finite(crystals?.left) && seesAll ? crystals.left : null });
		},
		/** A coordinator native_model_call row. */
		modelCall(row) {
			if (!finite(row?.at)) return;
			// A provider can send a call's row again once its usage is reconciled (same modelCallId): the last row stands.
			// The call was made at its first row's time, so a reconciliation after a milestone stays before it.
			const same = row.modelCallId != null ? calls.findIndex((c) => c.modelCallId === row.modelCallId) : -1;
			const earlier = same >= 0 ? calls[same] : null, at = earlier ? earlier.at : row.at;
			if (same >= 0) calls.splice(same, 1);
			calls.push({ at, endedAt: finite(row.endedAt) ? row.endedAt : finite(row.requestAt) && finite(row.totalMs) ? row.requestAt + row.totalMs : earlier?.endedAt ?? null, interrupted: row.interrupted === true, totalMs: finite(row.totalMs) ? row.totalMs : earlier?.totalMs ?? null, modelCallId: row.modelCallId ?? null, inputTokens: finite(row.inputTokens) ? row.inputTokens : null, cachedInputTokens: finite(row.cachedInputTokens) ? row.cachedInputTokens : null });
		},
		/**
		 * deaths: the scorer's death records; inWindow(at) says whether a time is inside the scored window; logMilestones:
		 * { lavaSeen, portalLit } epoch ms from the decision log, or null when the run kept no decision log.
		 */
		finish({ startedAt, deaths = [], observedDeaths = null, inWindow = () => true, logMilestones = null, protocolRecords = null }) {
			// Ranged commands are counted from the protocol journal; without one they are unknown.
			const commandsSeen = protocolRecords == null ? commands.length > 0 : protocolRecords > 0;
			const at = (ms) => finite(ms) ? { at: ms, minute: finite(startedAt) ? minutes(ms - startedAt) : null } : null;
			const milestones = Object.fromEntries(LONG_RUN_MILESTONES.map((m) => [m.id, at(firstSeen[m.id] ?? null)]));
			// No decision log: lava seen and portal lit are not measured, so their keys stay out (never "not reached").
			if (logMilestones) Object.assign(milestones, { lava_seen: at(logMilestones.lavaSeen), portal_lit: at(logMilestones.portalLit) });
			const sorted = [...deaths].sort((a, b) => a.at - b.at).map((d, i, all) => ({ ...d, prevAt: all[i - 1]?.at ?? null, nextAt: all[i + 1]?.at ?? null }));
			const described = describeDeaths(sorted, { trails, samples, startedAt });
			const windowCommands = commands.filter((c) => inWindow(c.at));
			const ranged = windowCommands.filter((c) => c.actionType === 'use_ranged');
			const endAt = firstSeen.end ?? null;
			let end = null;
			if (finite(endAt)) {
				const after = progress.filter((p) => p.at >= endAt && inWindow(p.at));
				const dragon = after.map((p) => p.dragonHealth).filter(finite), crystals = after.map((p) => p.crystalsLeft).filter(finite);
				end = { enteredAt: endAt, enteredMinute: finite(startedAt) ? minutes(endAt - startedAt) : null,
					rangedCommands: commandsSeen ? ranged.filter((c) => c.at >= endAt).length : null, rangedCommandsBeforeEnd: commandsSeen ? ranged.filter((c) => c.at < endAt).length : null,
					rangedBasis: 'use_ranged commands sent to the body; one command can loose several arrows',
					dragonSeenRows: dragon.length, dragonHealthMin: dragon.length ? Math.min(...dragon) : null, dragonHealthLast: dragon.length ? dragon.at(-1) : null,
					crystalsLeftMax: crystals.length ? Math.max(...crystals) : null, crystalsLeftMin: crystals.length ? Math.min(...crystals) : null,
					crystalsGone: crystals.length ? Math.max(...crystals) - Math.min(...crystals) : null,
					deathsInEnd: described.filter((d) => d.dimension === END).length, deathsAfterEntry: described.filter((d) => d.at >= endAt).length,
					strongholdToEndMin: finite(firstSeen.stronghold) ? minutes(endAt - firstSeen.stronghold) : null,
					dragonKilled: finite(firstSeen.dragon) ? true : sawAdvancements ? false : null,
					basis: progress.length ? 'Watcher progress rows (dragon health, crystals left) after the first End sample' : 'no Watcher progress rows: dragon and crystal numbers unknown' };
				if (!progress.length) for (const key of ['dragonHealthMin', 'dragonHealthLast', 'crystalsLeftMax', 'crystalsLeftMin', 'crystalsGone']) end[key] = null;
			}
			const windowCalls = calls.filter((c) => inWindow(c.at));
			const spent = (until) => {
				const before = windowCalls.filter((c) => c.at <= until);
				// A sum over calls none of which reported tokens is unknown, not 0.
				const sum = (key) => !before.length || before.some((c) => finite(c[key])) ? before.reduce((n, c) => n + (c[key] ?? 0), 0) : null;
				return { calls: before.length, inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens') };
			};
			const modelUse = windowCalls.length ? { ...spent(Infinity), callsWithoutTokens: windowCalls.filter((c) => c.inputTokens == null).length, callsWithoutCachedTokens: windowCalls.filter((c) => c.cachedInputTokens == null).length,
				byMilestone: Object.fromEntries(Object.entries(milestones).filter(([, m]) => m).map(([id, m]) => [id, spent(m.at)])),
				basis: 'native_model_call rows in the window: calls and input tokens up to and including each milestone\'s first observation' } : null;
			return {
				milestones,
				deaths: described,
				// Deaths seen only as a counter step have no record to describe: counted here, never dropped silently.
				deathsWithoutRecord: finite(observedDeaths) ? Math.max(0, observedDeaths - described.length) : null,
				deathMechanisms: mechanismTable(described),
				end,
				peakHeld: samples.length ? peak : null,
				rangedCommands: commandsSeen ? ranged.length : null,
				modelUse,
				modelLatency: modelLatency(windowCalls, { startedAt }),
				basis: { fall: `fall height = highest point in the last ~10 s before death minus the death height; a fall is ${FALL_BLOCKS}+ blocks`, milestones: 'first sample holding the item, in the dimension, or with the advancement; lava seen and portal lit from the decision log (gate-report logMilestones)' },
			};
		},
	};
}
