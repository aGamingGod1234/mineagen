// find {structure: fortress} in the Nether: the body owns the search loop. Fortresses and bastions share one grid of
// 432-block regions (nether-regions.mjs), so instead of the generic sweep's straight legs on the least covered heading,
// each leg heads for the nearest start ground no one has seen yet, re-read from observed memory before every leg, so a
// search resumed after a respawn or a portal trip skips what was already seen. Legs walk first and bridge, pillar or
// tunnel (build) only where walking gets nowhere, the way a player crosses a lava sea; a look round with a structure survey after each leg
// names a fortress from its nether bricks out to the 96-block fog.
//
// Audit (2026-11-18): 3 of 13 Nether games found a fortress, none through find; each find structure fortress ran the
// generic sweep for 0-4.5 min. The region order itself was measured on 30 seeds against /locate (nether-regions.mjs).

import { knownRegions, searchRegions } from './nether-regions.mjs';
import { SEARCH_LOW_HEALTH } from './search-danger.mjs';

/** Longest leg toward a region target: about the fog's half-depth, so each look covers new ground. */
export const FORTRESS_LEG = 48;
const MIN_LEG = 8;
/** A building leg on the bearing, tried only after walking legs at every turn got less than half way. */
export const BUILD_LEG = 24;
/** Building blocks a leg needs to be allowed to bridge or pillar. */
export const MIN_BUILD_BLOCKS = 8;
/** Route failures in a row (five walks and a build at each of three targets) before the search hands back NO_WAY_ON. */
export const MAX_FAILED_LEGS = 18;
// Stops that say nothing about the way: a mob met on the leg (settle fought or passed it), or a hit taken.
const NOT_THE_WAY = new Set(['HOSTILE_NEAR', 'TARGET_ESCAPED', 'TARGET_UNREACHABLE', 'APPROACH_BLOCKED', 'NO_SEEN_ROUTE', 'FIGHT_TIMED_OUT',
	'TRAVEL_DAMAGED', 'NAVIGATION_DAMAGED', 'DAMAGE_TAKEN']);
/** A vantage counts only this far from every earlier look point. */
const VANTAGE_NEW = 48;
/** Walking headings tried toward one target, off its bearing: 45 degrees each way, then 90. */
export const TURNS = Object.freeze([0, 45, -45, 90, -90]);
const HIGH_GROUND_RISE = 5;
const HIGH_GROUND_REACH = 32;
// Look points kept across find calls in this dimension (the trail only keeps 128 16-block sectors).
const MAX_LOOKS = 256;
const BUILD_BLOCKS = new Set(['minecraft:cobblestone', 'minecraft:cobbled_deepslate', 'minecraft:dirt', 'minecraft:stone', 'minecraft:deepslate',
	'minecraft:andesite', 'minecraft:diorite', 'minecraft:granite', 'minecraft:tuff', 'minecraft:netherrack', 'minecraft:blackstone', 'minecraft:basalt']);

/** Whether a find target is a Nether fortress sought in the Nether. */
export function fortressSearch(profile, observation) {
	return profile?.kind === 'structure' && /\bfortress\b/.test(profile.label ?? '') && observation?.world?.dimension === 'minecraft:the_nether';
}

export const yawToward = (dx, dz) => Math.round(Math.atan2(-dx, dz) * 180 / Math.PI);
const wrap = (yaw) => ((yaw + 180) % 360 + 360) % 360 - 180;

export function buildingBlocks(observation) {
	return (observation?.inventory?.items ?? []).reduce((n, item) =>
		n + (BUILD_BLOCKS.has(item?.itemId) && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0);
}

/**
 * The next place to head for: a remembered fortress sighting first, else the nearest unseen start ground of the region
 * whose unseen ground is nearest on average. Null when no region within two of the body's has unseen ground left.
 */
export function nextFortressTarget(position, known, looks = [], sighted = []) {
	const regions = knownRegions([...(known?.sightings ?? []), ...sighted], position);
	const fortress = [...regions.values()].filter((region) => region.kind === 'fortress').sort((a, b) => a.distance - b.distance)[0];
	if (fortress !== undefined) return { kind: 'remembered', x: fortress.row.x, z: fortress.row.z, y: fortress.row.y, distance: fortress.distance };
	const trail = [...(Array.isArray(known?.trail) ? known.trail : []), ...looks];
	const row = searchRegions(position, regions, 1, trail)[0];
	return row === undefined ? null : { kind: 'region', rx: row.rx, rz: row.rz, x: row.target.x, z: row.target.z, distance: row.target.distance, unseen: row.unseen };
}

/**
 * The loop. ctx carries searchFor's own closures, so danger, fights, sightings and hand-backs are judged exactly as in
 * every other find: observation() (the latest sample), leg(how, type, args), settle(outcome), look(pitch),
 * handBack(state, code, why, extra), left() (ms of the call's budget), minLegMs, and the runtime body.
 */
export async function searchNetherFortress(ctx) {
	const { body, leg, settle, look, handBack, left, minLegMs } = ctx;
	const state = body.eyeSearchState ?? {};
	const looks = state.fortressLooks ??= [];
	// Targets every turn failed to reach: their ground counts as seen, so the next region's ground is the target.
	const unreachable = state.fortressUnreachable ??= [];
	const at = () => { const p = ctx.observation()?.player; return [p?.x, p?.y, p?.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null; };
	const noteLook = () => { const p = at(); if (p !== null) { looks.push({ x: Math.floor(p.x), z: Math.floor(p.z) }); if (looks.length > MAX_LOOKS) looks.shift(); } };
	const stop = (stateName, code, why, stopCode) => {
		const back = handBack(stateName, code, why);
		if (stopCode !== undefined) back.find.stopCode = stopCode;
		return back;
	};
	// The first look of the call (searchFor's) already happened where the body stands.
	noteLook();
	let failed = 0, targetFails = 0, targetKey = null;
	while (left() >= minLegMs) {
		const observation = ctx.observation();
		const here = at();
		if (here === null) return stop('FAILED', 'FIND_BLOCKED', 'The body position is unknown', 'NO_POSITION');
		const health = observation?.player?.health;
		if (Number.isFinite(health) && health <= SEARCH_LOW_HEALTH) {
			return stop('FAILED', 'FIND_DANGER', `Health ${health} is at or below ${SEARCH_LOW_HEALTH}: eat or recover before searching on`, 'LOW_HEALTH');
		}
		const sighted = Array.isArray(observation?.sighted?.structures)
			? observation.sighted.structures.map((row) => ({ ...row, what: row?.structure ?? `built:${(row?.blocks ?? []).join('+')}` })) : [];
		const target = nextFortressTarget(here, body.known?.(observation) ?? null, [...looks, ...unreachable], sighted);
		if (target === null) return stop('FAILED', 'FIND_NOT_FOUND', 'Every region within two of here has had its start ground seen, and no fortress was among them');
		const bearing = yawToward(target.x - here.x, target.z - here.z);
		// Per target: walk at each turn (the bearing, 45 each way, 90 each way); only when all five walks get nowhere, build
		// on the bearing; when that fails too, the target's ground is ruled out. Live round 2: building after one failed
		// walk still tunnelled ~120 cells of netherrack in 3 minutes and wore out the only iron pickaxe.
		const key = `${target.kind}:${Math.round(target.x)},${Math.round(target.z)}`;
		if (key !== targetKey) { targetKey = key; targetFails = 0; }
		const build = targetFails >= TURNS.length;
		const yaw = build ? bearing : wrap(bearing + TURNS[targetFails]);
		const distance = build ? BUILD_LEG : Math.max(MIN_LEG, Math.min(FORTRESS_LEG, Math.round(target.distance)));
		const toward = target.kind === 'remembered' ? `the fortress seen at ${Math.round(target.x)},${Math.round(target.z)}`
			: `unseen start ground of region ${target.rx},${target.rz} (${Math.round(target.distance)} blocks)`;
		if (build && buildingBlocks(observation) < MIN_BUILD_BLOCKS) {
			return stop('FAILED', 'FIND_BLOCKED', `Out of building blocks (${buildingBlocks(observation)} held) and walking has no way on toward ${Math.round(target.x)},${Math.round(target.z)} at any of ${TURNS.length} headings: mine netherrack or cobblestone, then find again`, 'OUT_OF_BLOCKS');
		}
		const outcome = await leg(`${build ? 'build' : 'walk'} toward ${toward}`, 'travel_to', { yaw, distance, build });
		const ended = await settle(outcome);
		if (ended !== null) return ended;
		const after = at() ?? here;
		const moved = Math.hypot(after.x - here.x, after.z - here.z);
		const code = outcome.result?.reasonCode;
		if (code !== 'ARRIVED' && moved < distance / 2 && NOT_THE_WAY.has(code)) {
			// A mob or a hit stopped the leg (settle answered it): neither progress nor a closed way.
			if (moved < 2) continue;
		} else if (code !== 'ARRIVED' && moved < distance / 2) {
			failed += 1;
			targetFails += 1;
			if (code === 'OUT_OF_BLOCKS' && buildingBlocks(ctx.observation()) < MIN_BUILD_BLOCKS) {
				return stop('FAILED', 'FIND_BLOCKED', `Out of building blocks while bridging toward ${Math.round(target.x)},${Math.round(target.z)}: mine netherrack or cobblestone, then find again`, 'OUT_OF_BLOCKS');
			}
			if (targetFails > TURNS.length) {
				if (target.kind === 'remembered') {
					return stop('FAILED', 'FIND_BLOCKED', `The fortress seen at ${Math.round(target.x)},${target.y ?? '?'},${Math.round(target.z)} could not be reached: ${targetFails} legs toward it got less than half way`, 'FORTRESS_UNREACHABLE');
				}
				unreachable.push({ x: Math.round(target.x), z: Math.round(target.z) });
				if (unreachable.length > MAX_LOOKS) unreachable.shift();
				targetKey = null;
			}
			if (failed >= MAX_FAILED_LEGS) {
				return stop('FAILED', 'FIND_BLOCKED', `No way on: ${failed} legs in a row got less than half way (last ${code ?? outcome.result?.state}: ${String(outcome.result?.message ?? '').slice(0, 160)})`, 'NO_WAY_ON');
			}
			if (moved < 2) continue;
		} else {
			failed = 0;
			targetFails = 0;
		}
		// A vantage: high ground in sight close by shows more of the fog's 96 blocks than the floor of a valley.
		const high = (body.frontier?.(ctx.observation())?.candidates ?? [])
			.filter((row) => Number.isFinite(row.dy) && row.dy >= HIGH_GROUND_RISE && row.distance <= HIGH_GROUND_REACH && row.blocked !== true
				// Ahead toward the target, and new: not the hill the last look was already taken from.
				&& (row.x - after.x) * (target.x - after.x) + (row.z - after.z) * (target.z - after.z) > 0
				&& looks.every((point) => Math.hypot(point.x - row.x, point.z - row.z) > VANTAGE_NEW))
			.sort((a, b) => b.dy - a.dy)[0];
		if (high !== undefined && left() >= minLegMs) {
			const climb = await leg('up to a vantage', 'travel_to', { x: high.x + 0.5, y: high.y, z: high.z + 0.5, tolerance: 2, build: false });
			const stopped = await settle(climb);
			if (stopped !== null) return stopped;
		}
		const view = await look(-5);
		noteLook();
		if (view.interrupted || view.seen || view.ended) return settle(view);
	}
	return stop('TIMED_OUT', 'FIND_BUDGET', 'The search time ran out; find again to go on from the regions already seen');
}
