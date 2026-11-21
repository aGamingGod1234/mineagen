// find {structure: fortress} in the Nether: the body owns the search loop, searching the way a player does. It keeps one
// heading along z (fortresses string out in z), kept across find calls, and each leg walks to the farthest seen ground
// ahead (a lava shore, a ridge, the far side of a cavern), with a look round from high ground after each leg; the
// structure survey names a fortress from its nether bricks out to the 96-block fog. It bridges or digs (build) only
// where every walk gets nowhere, and turns to the side when even that fails. Fortresses and bastions share one grid of
// 432-block regions (nether-regions.mjs): the first unseen region's start ground picks the heading's sign, and a search
// with every region near it seen hands back.
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
/** Route failures in a row (three seen footings, five walks and a build on each of four headings) before NO_WAY_ON. */
export const MAX_FAILED_LEGS = 36;
// Stops that say nothing about the way: a mob met on the leg (settle fought or passed it), or a hit taken.
const NOT_THE_WAY = new Set(['HOSTILE_NEAR', 'TARGET_ESCAPED', 'TARGET_UNREACHABLE', 'APPROACH_BLOCKED', 'NO_SEEN_ROUTE', 'FIGHT_TIMED_OUT',
	'TRAVEL_DAMAGED', 'NAVIGATION_DAMAGED', 'DAMAGE_TAKEN']);
/** A vantage counts only this far from every earlier look point. */
const VANTAGE_NEW = 48;
/** Walking headings tried toward one target, off its bearing: 45 degrees each way, then 90. */
export const TURNS = Object.freeze([0, 45, -45, 90, -90]);
/**
 * Walking headings tried on the kept heading before a build: straight on and 45 each way. A walk 90 off cannot move the
 * farthest point on (live round 1: those took 20-50 s each and slid the body sideways or back down its own tunnel).
 */
export const SEARCH_TURNS = Object.freeze([0, 45, -45]);
const HIGH_GROUND_RISE = 5;
const HIGH_GROUND_REACH = 32;
// Look points kept across find calls in this dimension (the trail only keeps 128 16-block sectors).
const MAX_LOOKS = 256;
const BUILD_BLOCKS = new Set(['minecraft:cobblestone', 'minecraft:cobbled_deepslate', 'minecraft:dirt', 'minecraft:stone', 'minecraft:deepslate',
	'minecraft:andesite', 'minecraft:diorite', 'minecraft:granite', 'minecraft:tuff', 'minecraft:netherrack', 'minecraft:blackstone', 'minecraft:basalt']);

/**
 * Whether a find target is a Nether fortress sought in the Nether. MINEAGEN_FORTRESS_SEARCH=off keeps the generic sweep
 * instead, so a practice-room batch can play both side by side on the same code.
 */
export function fortressSearch(profile, observation, env = process.env) {
	if (env.MINEAGEN_FORTRESS_SEARCH === 'off') return false;
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

/** A footing counts as ahead only this far along the heading, within 45 degrees of it. */
export const AHEAD_MIN = 12;
/** Footings far below or high above the feet are cliffs and roof ledges, not the way on. */
const FOOTING_DROP = 16, FOOTING_RISE = 10;
/** Headings tried in turn when every walk and a build on one fail: the heading, then each side, then back. */
export const HEADING_TURNS = Object.freeze([0, 90, -90, 180]);
const MAX_TRIED = 256;
/** Unreachable seen footings tried on one heading before walking it by compass. */
const MAX_FOOTING_FAILS = 3;
/** Blocks a leg must move the farthest point on along the heading to count as a way on. */
export const MIN_GAIN = 8;
/** Land the last look saw at least this far one way counts as open ground to walk to before any dig. */
export const OPEN_VIEW = 24;
/** Tunnel legs in a row that never open into walkable ground before the search walks back and turns. */
export const MAX_DIGS = 2;
/** Blocks a build leg must have tunnelled to count as a dig. */
const DIG_BLOCKS = 8;
/** Mob stops in a row that left the body in place before that way counts as closed. */
const MAX_MOB_STOPS = 3;
const unit = (yaw) => ({ x: -Math.sin(yaw * Math.PI / 180), z: Math.cos(yaw * Math.PI / 180) });
const footingKey = (row) => `${row.x},${row.y},${row.z}`;

/**
 * The seen ground to walk to next: the frontier footing (a seen surface not yet stood on) that gets farthest along the
 * heading, within 45 degrees of it, not far below or above the feet, and not tried already. A player looks along a lava
 * shore or a ridge and walks to the far end of what is in sight, rather than walking a compass line into a wall.
 */
export function footingAhead(candidates, here, yaw, tried = []) {
	const u = unit(yaw), skip = new Set(tried);
	let best = null;
	for (const row of candidates ?? []) {
		if (![row?.x, row?.y, row?.z].every(Number.isFinite) || row.blocked === true || row.visited === true || row.footing === 'stood' || skip.has(footingKey(row))) continue;
		const dx = row.x + 0.5 - here.x, dz = row.z + 0.5 - here.z, dy = row.y - here.y;
		const along = dx * u.x + dz * u.z, side = Math.abs(dx * u.z - dz * u.x);
		if (along < AHEAD_MIN || side > along || dy < -FOOTING_DROP || dy > FOOTING_RISE) continue;
		const score = along - side / 2 - Math.max(0, Math.abs(dy) - 4);
		if (best === null || score > best.score) best = { ...row, along, score, distance: Math.hypot(dx, dz) };
	}
	return best;
}

/**
 * The most open way the last look showed, within 90 degrees of the heading: the view with land seen farthest, at least
 * OPEN_VIEW blocks, not tried from this front. A player walled in at a cavern's end turns along the open side rather than
 * digging on (smoke rooms 22 Nov: three walks failed at a tunnel face, then another 21-block tunnel, over and over).
 */
export function openView(views, heading, tried = new Set()) {
	let best = null;
	for (const view of Array.isArray(views) ? views : []) {
		if (!Number.isFinite(view?.yaw) || !(view.farthestLand >= OPEN_VIEW)) continue;
		const off = Math.abs(wrap(view.yaw - heading));
		if (off > 90 || tried.has(viewKey(view.yaw))) continue;
		const score = view.farthestLand - off / 6;
		if (best === null || score > best.score) best = { yaw: Math.round(view.yaw), farthestLand: view.farthestLand, score };
	}
	return best;
}
const viewKey = (yaw) => Math.round(wrap(yaw) / 15);

/** The heading a new search keeps: along z toward the first unseen region's start ground (fortresses string out in z). */
export function startHeading(here, target) {
	return target !== null && target.z < here.z ? 180 : 0;
}

/**
 * The loop. ctx carries searchFor's own closures, so danger, fights, sightings and hand-backs are judged exactly as in
 * every other find: observation() (the latest sample), leg(how, type, args), settle(outcome), look(pitch),
 * handBack(state, code, why, extra), left() (ms of the call's budget), minLegMs, and the runtime body.
 *
 * A player's search: keep one heading along z, kept across find calls; each leg walks to the farthest seen ground ahead
 * (a lava shore, a ridge, the far side of a cavern); with none in sight, walk the heading and 45 and 90 degrees off it;
 * only when all of those get nowhere, build (bridge a gap, or dig through the wall) a short way on the heading; when that
 * fails too, turn to the side, then back. Look round from high ground ahead after each leg.
 */
export async function searchNetherFortress(ctx) {
	const { body, leg, settle, look, handBack, left, minLegMs } = ctx;
	const state = body.eyeSearchState ?? {};
	const looks = state.fortressLooks ??= [];
	// Seen footings a walk failed to reach, kept across calls: never the next target again.
	const tried = state.fortressTried ??= [];
	const at = () => { const p = ctx.observation()?.player; return [p?.x, p?.y, p?.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null; };
	const noteLook = () => { const p = at(); if (p !== null) { looks.push({ x: Math.floor(p.x), z: Math.floor(p.z) }); if (looks.length > MAX_LOOKS) looks.shift(); } };
	const stop = (stateName, code, why, stopCode) => {
		const back = handBack(stateName, code, why);
		if (stopCode !== undefined) back.find.stopCode = stopCode;
		return back;
	};
	// The first look of the call (searchFor's) already happened where the body stands.
	noteLook();
	let failed = 0, turn = 0, footFails = 0, headingTurn = 0, digs = 0, mobStops = 0;
	// Open views walked from the current front, and the last place a walk (not a dig) made way: a walled-in search walks
	// back there before it turns.
	const triedViews = new Set();
	const start = at();
	let lastOpen = start === null ? null : { x: start.x, y: Math.floor(start.y + 1e-3), z: start.z };
	// The farthest point reached along the current heading. A leg counts as progress only when it moves this forward:
	// live round 1, a side walk that failed dragged the body 20 blocks back down its own tunnel, and the build leg after
	// it walked the tunnel forward again and counted as a way on, over and over (1,032 blocks walked, 11 net).
	let front = null;
	const alongOf = (p) => (front === null ? 0 : (p.x - front.origin.x) * front.u.x + (p.z - front.origin.z) * front.u.z);
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
		const target = nextFortressTarget(here, body.known?.(observation) ?? null, looks, sighted);
		if (target === null) return stop('FAILED', 'FIND_NOT_FOUND', 'Every region within two of here has had its start ground seen, and no fortress was among them');
		const remembered = target.kind === 'remembered';
		state.fortressHeading ??= startHeading(here, target);
		// Toward a remembered fortress the bearing is its own; otherwise the kept heading.
		const heading = remembered ? yawToward(target.x - here.x, target.z - here.z) : wrap(state.fortressHeading + HEADING_TURNS[headingTurn]);
		if (front === null || front.heading !== heading) front = { heading, u: unit(heading), origin: here, point: here, along: 0 };
		// Seen ground ahead of the farthest point, not just ahead of where a failed walk left the body.
		const ahead = turn === 0 && footFails < MAX_FOOTING_FAILS ? footingAhead(body.frontier?.(observation)?.candidates, front.point, heading, tried) : null;
		const turns = remembered ? TURNS : SEARCH_TURNS;
		let build = turn >= turns.length;
		// Before a dig: the open side the last look showed from here, walked as a player turns along a cavern wall.
		const seen = ctx.ground?.() ?? null;
		const open = build && !remembered && ahead === null && seen !== null && Math.hypot(seen.at.x - here.x, seen.at.z - here.z) <= 4
			? openView(seen.views, heading, triedViews) : null;
		if (open !== null) build = false;
		// Walled in: two digs in a row never opened into walkable ground. Back to the last open ground, then the next heading.
		if (build && digs >= MAX_DIGS && !remembered) {
			digs = 0; turn = 0; footFails = 0; failed += 1;
			headingTurn = (headingTurn + 1) % HEADING_TURNS.length;
			if (headingTurn === 0) state.fortressHeading = wrap(state.fortressHeading + 90);
			front = null;
			triedViews.clear();
			if (lastOpen !== null && Math.hypot(lastOpen.x - here.x, lastOpen.z - here.z) > 4) {
				const back = await leg(`back to open ground at ${Math.floor(lastOpen.x)},${Math.floor(lastOpen.y)},${Math.floor(lastOpen.z)}: rock all the way on`, 'travel_to',
					{ x: lastOpen.x, y: lastOpen.y, z: lastOpen.z, tolerance: 2, build: false });
				const stopped = await settle(back);
				if (stopped !== null) return stopped;
			}
			if (failed >= MAX_FAILED_LEGS) return stop('FAILED', 'FIND_BLOCKED', `No way on: ${failed} legs in a row got no farther, walled in by rock on every heading`, 'NO_WAY_ON');
			continue;
		}
		let args, distance, how;
		if (open !== null) {
			distance = Math.min(FORTRESS_LEG, open.farthestLand);
			args = { yaw: open.yaw, distance, build: false };
			how = `walk toward open ground seen ${open.farthestLand} blocks off at yaw ${open.yaw}`;
		} else if (ahead !== null) {
			distance = ahead.distance;
			args = { x: ahead.x + 0.5, y: ahead.y, z: ahead.z + 0.5, tolerance: 3, build: false };
			how = `walk to seen ground ${Math.round(ahead.along)} blocks ahead at ${ahead.x},${ahead.y},${ahead.z}`;
		} else {
			const yaw = build ? heading : wrap(heading + turns[turn]);
			distance = build ? BUILD_LEG : remembered ? Math.max(MIN_LEG, Math.min(FORTRESS_LEG, Math.round(target.distance))) : FORTRESS_LEG;
			// A build leg aims past the farthest point: the way back to it is known ground, so only new rock is dug.
			args = build ? { x: Math.floor(front.point.x + front.u.x * BUILD_LEG) + 0.5, y: Math.floor(front.point.y + 1e-3), z: Math.floor(front.point.z + front.u.z * BUILD_LEG) + 0.5, tolerance: 3, build }
				: { yaw, distance, build };
			how = `${build ? 'build' : 'walk'} ${remembered ? `toward the fortress seen at ${Math.round(target.x)},${Math.round(target.z)}` : `on heading ${Math.round(yaw)}`}`;
		}
		if (build && buildingBlocks(observation) < MIN_BUILD_BLOCKS) {
			return stop('FAILED', 'FIND_BLOCKED', `Out of building blocks (${buildingBlocks(observation)} held) and walking has no way on at heading ${Math.round(heading)}: mine netherrack or cobblestone, then find again`, 'OUT_OF_BLOCKS');
		}
		const outcome = await leg(how, 'travel_to', args);
		const ended = await settle(outcome);
		if (ended !== null) return ended;
		const after = at() ?? here;
		const moved = Math.hypot(after.x - here.x, after.z - here.z);
		const gain = alongOf(after) - front.along;
		if (gain > 0) { front.along += gain; front.point = after; }
		const code = outcome.result?.reasonCode;
		// A side walk toward open ground makes way by getting there, not by moving the front along the heading.
		const progress = open !== null ? moved >= MIN_GAIN : gain >= Math.min(MIN_GAIN, distance / 2);
		const tunnelled = Number(/tunnelled (\d+)/.exec(String(outcome.result?.message ?? ''))?.[1] ?? 0);
		if (gain >= MIN_GAIN) triedViews.clear();
		// A side walk that got there moves the front to it, and the way back the other side is not taken next.
		if (progress && open !== null) { front.point = after; triedViews.add(viewKey(open.yaw + 180)); }
		mobStops = !progress && NOT_THE_WAY.has(code) && moved < 2 ? mobStops + 1 : 0;
		if (mobStops >= MAX_MOB_STOPS) {
			// Mobs keep the body in place: deal with them first (smoke room 22 Nov: eight stops for magma cubes on one
			// footing while they closed in, then death).
			return stop('FAILED', 'FIND_DANGER', `Mobs stopped ${mobStops} legs in a row with the body in place (last ${code}: ${String(outcome.result?.message ?? '').slice(0, 120)}): fight or back away, then find again`, 'MOBS_IN_THE_WAY');
		}
		if (!progress && NOT_THE_WAY.has(code)) {
			// A mob or a hit stopped the leg (settle answered it): neither progress nor a closed way.
			if (moved < 2) continue;
		} else if (!progress) {
			failed += 1;
			if (open !== null) triedViews.add(viewKey(open.yaw));
			else if (ahead !== null) { footFails += 1; tried.push(footingKey(ahead)); if (tried.length > MAX_TRIED) tried.shift(); }
			else turn += 1;
			if (code === 'OUT_OF_BLOCKS' && buildingBlocks(ctx.observation()) < MIN_BUILD_BLOCKS) {
				return stop('FAILED', 'FIND_BLOCKED', `Out of building blocks while bridging on heading ${Math.round(heading)}: mine netherrack or cobblestone, then find again`, 'OUT_OF_BLOCKS');
			}
			if (turn > turns.length) {
				// Walled in on this heading even building: turn to the side, then the other side, then back.
				if (remembered) {
					return stop('FAILED', 'FIND_BLOCKED', `The fortress seen at ${Math.round(target.x)},${target.y ?? '?'},${Math.round(target.z)} could not be reached: no walk or build toward it got any farther`, 'FORTRESS_UNREACHABLE');
				}
				turn = 0;
				footFails = 0;
				headingTurn = (headingTurn + 1) % HEADING_TURNS.length;
				if (headingTurn === 0) state.fortressHeading = wrap(state.fortressHeading + 90);
			}
			if (failed >= MAX_FAILED_LEGS) {
				return stop('FAILED', 'FIND_BLOCKED', `No way on: ${failed} legs in a row got no farther (last ${code ?? outcome.result?.state}: ${String(outcome.result?.message ?? '').slice(0, 160)})`, 'NO_WAY_ON');
			}
			if (moved < 2) continue;
		} else {
			failed = 0;
			turn = 0;
			footFails = 0;
			// A dig that got through counts as a way on, but only walking proves open ground: digs in a row are capped.
			if (build && tunnelled >= DIG_BLOCKS) digs += 1;
			else { digs = 0; lastOpen = { x: Math.floor(after.x) + 0.5, y: Math.floor(after.y + 1e-3), z: Math.floor(after.z) + 0.5 }; }
			// A side heading that went somewhere becomes the kept one.
			if (headingTurn !== 0 && !remembered) { state.fortressHeading = heading; headingTurn = 0; }
		}
		// A vantage: high ground in sight close by shows more of the fog's 96 blocks than the floor of a valley.
		const u = unit(heading);
		const high = (body.frontier?.(ctx.observation())?.candidates ?? [])
			.filter((row) => Number.isFinite(row.dy) && row.dy >= HIGH_GROUND_RISE && row.distance <= HIGH_GROUND_REACH && row.blocked !== true
				// Ahead on the heading, and new: not the hill the last look was already taken from.
				&& (row.x - after.x) * u.x + (row.z - after.z) * u.z > 0
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
	return stop('TIMED_OUT', 'FIND_BUDGET', 'The search time ran out; find again to go on from the ground already seen');
}
