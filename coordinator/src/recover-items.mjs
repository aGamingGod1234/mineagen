// recover_items: the player's first move after a death that left gear on the ground. Walk back to the death spot with
// travel, pick up every stack lying there, and put the armour, shield and food back where they are used. Skipped when
// the drops are gone (the void, lava) or in another dimension; when mobs did the killing, the body first stops short and
// looks, and leaves the drops to the model when a crowd still guards them.
// Before this job a respawned bot restarted from wood tools: decision tests scored every respawn moment 0% player-like,
// and 3 of 5 checked deaths left the bot without a shield for the rest of the game.

import { headingOf } from './search-coverage.mjs';
import { nextKitStep } from './kit-habit.mjs';
import { DROP_LIFETIME_SECONDS, dropClockText, dropLoss, killerMob, recoverEnabled, recoveryRoute, lostItemsText } from './respawn-recovery.mjs';

export const RECOVER_TIMEOUT_MS = 240_000;
export const RECOVER_MAX_TIMEOUT_MS = 900_000;
/** Default budget per block of flat distance to the drops (a sprint covers ~5 blocks a second; terrain halves it). */
export const RECOVER_MS_PER_BLOCK = 400;
/** Time for a stone pickaxe from nothing (tree, table, wooden pick, cobblestone), kept out of the walk's own budget. */
export const PICK_FIRST_TIMEOUT_MS = 180_000;
/** The drops lie this far below the body: a staircase dig, which needs a pickaxe unless a walked way leads there. */
export const DIG_DOWN = 4;
/** A travel leg that closes less than this is no progress; the walk back stops repeating legs. */
const LEG_PROGRESS = 8;
/** Drops scatter a few blocks from the body and can slide or fall; stacks this close to the death spot are its drops. */
export const DROP_RADIUS = 10;
/** With a mob kill, the walk stops this far short of the spot to look before going in. */
export const STAND_OFF = 16;
/** This many hostiles near the drops is a crowd: the job hands back instead of walking into it. */
export const CROWD = 3;
const MAX_PICKS = 40;
const PICK_TIMEOUT_MS = 15_000;
const MAX_EQUIPS = 6;
const LOW_HEALTH = 8;

const finite = (p) => [p?.x, p?.y, p?.z].every(Number.isFinite);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const bare = (id) => String(id ?? '').replace(/^minecraft:/, '');
const cell = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function held(o) {
	const counts = new Map();
	for (const item of o?.inventory?.items ?? []) if (item?.count > 0 && typeof item.itemId === 'string') counts.set(item.itemId, (counts.get(item.itemId) ?? 0) + item.count);
	return counts;
}

function hostilesNear(o, at, radius) {
	const rows = [...(o?.player?.threats ?? []), ...(o?.entities ?? []).filter((e) => e?.hostile === true)];
	const seen = new Set();
	return rows.filter((row) => {
		const id = row?.stableId ?? row?.uuid ?? row?.id;
		if (row?.alive === false || !finite(row) || (id !== undefined && seen.has(id))) return false;
		if (id !== undefined) seen.add(id);
		return dist(row, at) <= radius;
	});
}

/**
 * Whether recover_items has something to do from this observation: {ok:true, death, lost} or {ok:false, reasonCode, why}.
 * The respawn wake names the job only when this is ok.
 */
export function recoverable(o) {
	const death = o?.recovery?.lastDeath;
	const lost = (Array.isArray(o?.recovery?.lastLostInventory) ? o.recovery.lastLostInventory : []).filter((row) => typeof row?.itemId === 'string' && row.count > 0);
	if (!death || !finite(death) || typeof death.dimensionId !== 'string') return { ok: false, reasonCode: 'NO_DEATH_RECORD', why: 'no death is on record for this body' };
	if (lost.length === 0) return { ok: false, reasonCode: 'NOTHING_LOST', why: 'the last death left nothing that is still missing' };
	const loss = dropLoss(death);
	if (loss === 'void') return { ok: false, reasonCode: 'DROPS_DESTROYED', why: 'that death was in the void: its drops are gone' };
	if (loss === 'lava') return { ok: false, reasonCode: 'DIED_IN_LAVA', why: 'that death was in lava: drops that fell in it burned, and the way to the rest is the lava that killed you' };
	const clock = o.recovery.dropTicking;
	if (Number.isFinite(clock?.tickedSeconds) && clock.tickedSeconds >= DROP_LIFETIME_SECONDS) return { ok: false, reasonCode: 'DROPS_EXPIRED', why: 'the drops have aged 5 minutes and despawned' };
	const here = o?.world?.dimension;
	if (here !== death.dimensionId) {
		const route = recoveryRoute(death, o);
		return { ok: false, reasonCode: 'OTHER_DIMENSION', why: `the drops are in ${death.dimensionId}; travel cannot walk there by itself.${route ? ` ${route}` : ''}` };
	}
	return { ok: true, death, lost };
}

/**
 * body: { observe(), act(actionType, args), stopped(), interrupted(), note?(text) } as obtain's. now: the runtime clock.
 * Returns a tool result: SUCCEEDED (RECOVERED, or RECOVERED_PART with what is still missing), FAILED with a skip or
 * hand-back code, or the travel/pickup result that stopped it (INTERRUPTED for danger).
 */
export async function runRecoverItems(args = {}, body, { now = Date.now, environment = process.env } = {}) {
	if (!recoverEnabled(environment)) return { state: 'FAILED', reasonCode: 'RECOVER_OFF', message: 'recover_items is switched off in this run (MINEAGEN_RECOVER_ITEMS=off).' };
	const startedAt = now();
	let timeoutMs = Math.min(RECOVER_MAX_TIMEOUT_MS, Number.isSafeInteger(args?.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : RECOVER_TIMEOUT_MS);
	const left = () => timeoutMs - (now() - startedAt);
	const seconds = () => Math.round((now() - startedAt) / 1000);
	const note = (text) => { try { body.note?.(text); } catch { /* a progress note never stops the job */ } };
	let o = await body.observe();
	const start = recoverable(o);
	if (!start.ok) return { state: 'FAILED', reasonCode: start.reasonCode, message: `recover_items skipped: ${start.why}.` };
	const { death, lost } = start;
	const lostIds = new Set(lost.map((row) => row.itemId));
	const lostUnits = lost.reduce((n, row) => n + row.count, 0);
	const before = held(o);
	const spot = { x: death.x, y: death.y, z: death.z };
	const mob = killerMob(death);
	const from = o?.position ?? o?.player;
	// No timeoutMs given: the budget grows with the walk, as a player's run back does (1,800 blocks is minutes, not 4).
	if (!(Number.isSafeInteger(args?.timeoutMs) && args.timeoutMs > 0) && finite(from)) timeoutMs = Math.min(RECOVER_MAX_TIMEOUT_MS, RECOVER_TIMEOUT_MS + Math.round(flat(from, spot) * RECOVER_MS_PER_BLOCK));
	// The job runs inside the model's turn: the turn's lease must last as long as the job's own budget.
	body.budget?.(left());
	const end = (state, reasonCode, why, extra = {}) => {
		const counts = held(o);
		const back = lost.map((row) => ({ itemId: row.itemId, count: Math.min(row.count, Math.max(0, (counts.get(row.itemId) ?? 0) - (before.get(row.itemId) ?? 0))) })).filter((row) => row.count > 0);
		const units = back.reduce((n, row) => n + row.count, 0);
		const missing = lost.map((row) => ({ itemId: row.itemId, count: row.count - (back.find((b) => b.itemId === row.itemId)?.count ?? 0) })).filter((row) => row.count > 0);
		const recovered = { stacks: back.length, of: lost.length, units, ofUnits: lostUnits };
		const text = `${why}. Recovered ${units} of ${lostUnits} lost items${back.length ? ` (${lostItemsText(back)})` : ''}${missing.length ? `; still missing ${lostItemsText(missing)}` : ''}${extra.wore?.length ? `; ${extra.wore.join(', ')}` : ''}; ${seconds()} s.`;
		return { state, reasonCode, recovered, missing, ...extra, seconds: seconds(), message: text };
	};
	const stop = (result, why) => {
		if (result?.state === 'INTERRUPTED') return { ...end('INTERRUPTED', result.reasonCode ?? 'DANGER', `${why}: stopped for danger; decide, then call recover_items again`), ...(result.running ? { running: result.running } : {}) };
		return end(result?.state === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED', result?.reasonCode ?? 'TRAVEL_FAILED', `${why} ended ${result?.reasonCode ?? result?.state ?? 'without a result'}${result?.message ? ` (${String(result.message).slice(0, 160)})` : ''}`);
	};
	const position = (obs) => obs?.position ?? obs?.player;
	const travel = async (target, label) => {
		const goal = { y: spot.y, ...target };
		const gap = (obs) => { const p = position(obs); return finite(p) ? (Number.isFinite(target.y) ? dist(p, goal) : flat(p, goal)) : Infinity; };
		let result = null;
		// One travel leg is capped at 3 min; a long walk back repeats legs while each one closes real distance.
		for (let leg = 0; leg < 8 && left() > 5_000; leg += 1) {
			const retrace = o?.routeMemory?.connected === true;
			const before = gap(o);
			note(`${label}: travel to ${cell(goal)}${retrace ? ' on the walked route' : ''}${leg ? ` (leg ${leg + 1})` : ''}`);
			result = await body.act('travel_to', { ...target, tolerance: 2, ...(retrace ? { retrace: true } : {}), timeoutMs: Math.max(5_000, Math.min(left(), 180_000)) });
			o = await body.observe();
			if (result?.state === 'SUCCEEDED' || result?.state === 'INTERRUPTED' || body.stopped?.() || body.interrupted?.()) break;
			if (!(before - gap(o) >= LEG_PROGRESS)) break;
		}
		return result;
	};

	// Drops underground, no walked way down and no pickaxe: a player punches a tree and makes a stone pickaxe before going
	// back, because the staircase down to the spot needs one. Its time is added to the budget, not taken from the walk.
	const pickaxe = (obs) => (obs?.inventory?.items ?? []).some((i) => i?.count > 0 && /_pickaxe$/.test(i.itemId ?? ''));
	const walkedWay = o?.routeMemory?.connected === true;
	if (finite(from) && spot.y < from.y - DIG_DOWN && !walkedWay && !pickaxe(o) && typeof body.obtain === 'function') {
		note(`make a stone pickaxe first: the drops are ${Math.round(from.y - spot.y)} blocks down with no walked way there`);
		timeoutMs = Math.min(RECOVER_MAX_TIMEOUT_MS + PICK_FIRST_TIMEOUT_MS, timeoutMs + PICK_FIRST_TIMEOUT_MS);
		body.budget?.(left());
		const made = await body.obtain('minecraft:stone_pickaxe', 1, Math.max(60_000, Math.min(PICK_FIRST_TIMEOUT_MS, left())));
		o = await body.observe();
		if (made?.state === 'INTERRUPTED') return stop(made, 'making a stone pickaxe for the way down');
		// The drops are not lost yet: say how long they keep, so a pickaxe made later by ordinary play still leads back.
		if (!pickaxe(o)) return end('FAILED', 'NO_PICKAXE', `The drops are ${Math.round(from.y - spot.y)} blocks down with no walked way there, and making a stone pickaxe ended ${made?.reasonCode ?? made?.state ?? 'without one'}${made?.message ? ` (${String(made.message).slice(0, 160)})` : ''}. The drops: ${dropClockText(o?.recovery?.dropTicking)}; once you hold a pickaxe, call recover_items again`);
	}

	// A mob kill: stop short, look, and leave a crowd to the model (a player does not walk back into the same fight).
	const at = position(o);
	if (mob !== null && finite(at) && flat(at, spot) > STAND_OFF + 4) {
		const d = flat(at, spot), k = (d - STAND_OFF) / d;
		const result = await travel({ x: Math.round((at.x + (spot.x - at.x) * k) * 10) / 10, z: Math.round((at.z + (spot.z - at.z) * k) * 10) / 10 }, `approach (killed by ${bare(mob)})`);
		if (result?.state !== 'SUCCEEDED' && !(result?.state === 'FAILED' && flat(position(o) ?? at, spot) <= STAND_OFF + 8)) return stop(result, 'the approach');
		const guards = hostilesNear(o, spot, DROP_RADIUS);
		if (guards.length >= CROWD) {
			const kinds = [...guards.reduce((m, g) => m.set(bare(g.type ?? g.typeId ?? g.name ?? 'mob'), (m.get(bare(g.type ?? g.typeId ?? g.name ?? 'mob')) ?? 0) + 1), new Map())].map(([k2, n]) => `${k2}${n > 1 ? ` x${n}` : ''}`).join(', ');
			return end('FAILED', 'DROPS_GUARDED', `Stopped ${Math.round(flat(position(o) ?? at, spot))} blocks from the drops: ${guards.length} hostiles (${kinds}) within ${DROP_RADIUS} blocks of them. Fight them from here, wait for day, or leave the drops`);
		}
	}
	if (left() <= 0) return end('TIMED_OUT', 'RECOVER_TIMEOUT', `timeoutMs ${timeoutMs} ran out on the way`);
	if (!finite(position(o)) || dist(position(o), spot) > 3) {
		const result = await travel({ x: spot.x, y: spot.y, z: spot.z }, 'walk back');
		const p = position(o);
		// travel reports the last blocks it could not close (a drop in a hole) as a miss; a stack in reach still counts.
		if (result?.state !== 'SUCCEEDED' && !(finite(p) && dist(p, spot) <= DROP_RADIUS)) return stop(result, `the walk back (${finite(p) ? `${Math.round(flat(p, spot))} blocks ${headingOf(spot.x - p.x, spot.z - p.z)} still to go` : 'position unknown'})`);
	}

	// Pick up: the nearest stack of the lost items first, from a fresh look each time (a sample lists only so many).
	const tried = new Map();
	let picks = 0;
	for (; picks < MAX_PICKS && left() > 0; ) {
		if (body.stopped?.() || body.interrupted?.()) return end('INTERRUPTED', 'DANGER', 'Stopped for danger while picking up');
		const p = position(o);
		if (Number.isFinite(o?.player?.health) && o.player.health <= LOW_HEALTH) return end('FAILED', 'LOW_HEALTH', `Health ${o.player.health}: stopped picking up`);
		if (!finite(p)) break;
		const counts = held(o);
		const owed = lost.some((row) => (counts.get(row.itemId) ?? 0) - (before.get(row.itemId) ?? 0) < row.count);
		if (!owed) break;
		const drop = (o.items ?? []).filter((row) => lostIds.has(row?.itemId) && typeof row.stableId === 'string' && (tried.get(row.stableId) ?? 0) < 2
			&& finite(row) && dist(row, spot) <= DROP_RADIUS).sort((a, b) => dist(a, p) - dist(b, p))[0];
		if (!drop) break;
		tried.set(drop.stableId, (tried.get(drop.stableId) ?? 0) + 1);
		picks += 1;
		note(`pick up ${bare(drop.itemId)} x${drop.count ?? 1}`);
		const result = await body.act('pick_up_item', { targetSelector: drop.stableId, timeoutMs: Math.max(2_000, Math.min(PICK_TIMEOUT_MS, left())) });
		o = await body.observe();
		if (result?.state === 'INTERRUPTED') return stop(result, 'picking up');
	}

	// Wear it again: shield to the off hand, armour to its slots, food to the hotbar (the kit habit's own choices,
	// equips only: nothing is crafted here). Health is not a reason to wait: armour matters most when hurt.
	const wore = [];
	for (let n = 0; n < MAX_EQUIPS && !body.stopped?.() && !body.interrupted?.(); n += 1) {
		const step = nextKitStep({ ...o, player: { ...o.player, health: 20 } });
		if (step === null || !['equip', 'hotbar'].includes(step.kind)) break;
		const result = step.kind === 'equip'
			? await body.act('equip_item', { sourceSlot: step.sourceSlot, targetSlot: step.targetSlot, expectedItemId: step.itemId })
			: await body.act('select_tool', { sourceSlot: step.sourceSlot, hotbarSlot: step.hotbarSlot, expectedItemId: step.itemId, minRemainingDurability: 0 });
		o = await body.observe();
		if (result?.state !== 'SUCCEEDED') { wore.push(`${step.kind} ${bare(step.itemId)} stopped (${result?.reasonCode ?? result?.state ?? 'no result'})`); break; }
		wore.push(step.kind === 'equip' ? `wore ${bare(step.itemId)} (${step.targetSlot})` : `${bare(step.itemId)} to hotbar ${step.hotbarSlot}`);
	}
	const counts = held(o);
	const backUnits = lost.reduce((n, row) => n + Math.min(row.count, Math.max(0, (counts.get(row.itemId) ?? 0) - (before.get(row.itemId) ?? 0))), 0);
	const extra = { wore, picks };
	if (backUnits === 0) return end('FAILED', 'DROPS_NOT_FOUND', `At the death spot ${cell(spot)}: none of the lost items in view within ${DROP_RADIUS} blocks (despawned, burned, or carried off)`, extra);
	if (backUnits < lostUnits) return end('SUCCEEDED', 'RECOVERED_PART', `Back at the death spot ${cell(spot)}; picked up what was in view`, extra);
	return end('SUCCEEDED', 'RECOVERED', `Recovered everything at the death spot ${cell(spot)}`, extra);
}
