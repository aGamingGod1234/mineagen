// The Nether fortress legs of a find search (searchFor in find-search.mjs): the walk along seen fortress floor toward a
// spawner, and the gate that says when the surface legs are a Nether crossing. find-search.mjs owns the search and its
// legs; it hands this file the live search (current observation, leg, look, settle, hand-back and limits).
import { corridorFloor, witherOnLeg, withersSeen } from './fortress-approach.mjs';

// c8861: masonry alone sent compass building legs through rock and away from the fortress.
// A visible top face is a destination to try, not proof of reachable floor; walking navigation owns that check.
export const fortressSpawnerSearch = (profile, observation) => profile.kind === 'block' && profile.ids.has('minecraft:spawner')
	&& observation?.world?.dimension === 'minecraft:the_nether'
	&& (!observation?.continuity?.rememberedSections?.includes('blocks')
		&& (observation?.blocks ?? []).some((row) => row.blockId === 'minecraft:nether_bricks') || platformsSeen(observation).length > 0);

/** Far sight's name for a fortress's raised, fence-ringed blaze spawner platform (FarSight.platformRows). */
export const SPAWNER_PLATFORM = 'nether fortress spawner platform';

/** Spawner platforms in the current view or the last survey, nearest first: the spawner stands on top of one. */
export function platformsSeen(observation) {
	const rows = [...(observation?.sighted?.structures ?? []), ...(observation?.survey?.structures ?? [])];
	return rows.filter((row) => row?.structure === SPAWNER_PLATFORM && [row.x, row.y, row.z].every(Number.isFinite))
		.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
}

// Spawner exploration has its own fortress-floor policy; leave its generic fallback unchanged too.
export const netherCrossing = (profile, observation) => observation?.world?.dimension === 'minecraft:the_nether'
	&& !(profile.kind === 'block' && profile.ids.has('minecraft:spawner'));

// A walkway seen at a distance (the far rays of a look round) is a leg of its own up to this far; floor in arm's
// reach keeps the shorter building leg. Base1 games (25 Nov): the floor walk read only the few blocks next to the body
// and handed back FIND_BLOCKED within 0-12 s 17 times in 4 games while far rays showed fortress brick 7-62 blocks away.
export const FAR_FLOOR_LEG = 48;
const BRICK = 'minecraft:nether_bricks';
const BLAZE = 'minecraft:blaze';

/** Blazes the body saw or heard (a heard mob is an entity row perceived by sound): they spawn at the spawner, so a player
 * walks toward them to find it. */
export function blazesSeen(observation, sweepHostiles = []) {
	const rows = [...(observation?.entities ?? []), ...sweepHostiles];
	return rows.filter(row => (row?.type ?? row?.entityType) === BLAZE)
		.map(row => row.position ?? row).filter(at => [at?.x, at?.z].every(Number.isFinite));
}

/**
 * Walks seen fortress floor until the target is seen or the search hands back; every path returns a search result.
 * `search.observation()` reads the search's current observation, which each leg and look replaces.
 */
export async function walkFortressFloor(search) {
	const { profile, observation, bodyAt, cellOf, insideBoundary, left, leg, settle, look, handBack, minLegMs, buildLeg, buildBudget } = search;
	const farSeen = search.farSeen ?? (() => []), sweepHostiles = search.sweepHostiles ?? (() => []);
	const attempted = new Set(), visited = [bodyAt(observation())], lookedFrom = [];
	let travelled = 0;
	const platformsTried = new Set();
	while (left() >= minLegMs) {
		const at = bodyAt(observation());
		// A seen spawner platform is where a player heads: the spawner on top shows only from the platform's own level.
		const platform = platformsSeen(observation()).find((row) => !platformsTried.has(`${row.x},${row.y},${row.z}`) && insideBoundary(row));
		if (platform !== undefined) {
			platformsTried.add(`${platform.x},${platform.y},${platform.z}`);
			const trip = await leg('to the seen spawner platform', 'travel_to', { x: platform.x + 0.5, y: platform.y + 1, z: platform.z + 0.5, tolerance: 3, build: true, stopWhenSeen: profile.stopId });
			const ended = await settle(trip);
			if (ended !== null) return ended;
			const after = bodyAt(observation());
			visited.push(after);
			lookedFrom.push(after);
			const view = await look(0);
			if (view.interrupted || view.seen || view.ended) return settle(view);
			continue;
		}
		const remembered = observation()?.continuity?.rememberedSections?.includes('blocks');
		const seenBlocks = remembered ? [] : (observation()?.blocks ?? []);
		const top = (row, far) => { const cell = cellOf(row); return cell === null ? null : { x: cell.x + 0.5, y: cell.y + 1, z: cell.z + 0.5, far }; };
		const near = seenBlocks.filter(row => row.blockId === BRICK && row.placeableFaces?.includes('up')).map(row => top(row, false));
		const landmarks = remembered ? [] : [...(observation()?.landmarks ?? observation()?.world?.landmarks ?? []), ...farSeen()];
		const far = landmarks.filter(row => row?.blockId === BRICK).map(row => top(row, true));
		const reach = row => Math.min(row.far ? FAR_FLOOR_LEG : buildLeg, buildBudget - travelled);
		const reachable = [...near, ...far]
			.filter(row => row !== null && insideBoundary(row) && !attempted.has(`${row.x},${row.y},${row.z}`)
				&& Math.hypot(row.x - at.x, row.y - at.y, row.z - at.z) <= reach(row)
				&& visited.every(spot => Math.hypot(row.x - spot.x, row.y - spot.y, row.z - spot.z) > 2));
		// Wall breaker rods (b): no floor leg past a seen wither skeleton (they killed most on open walkways).
		const withers = withersSeen(observation());
		// Toward the blazes when any were seen or heard (the floor nearest one first), else the farthest new floor.
		const blazes = blazesSeen(observation(), sweepHostiles());
		const toBlaze = row => Math.min(...blazes.map(b => Math.hypot(b.x - row.x, b.z - row.z)));
		const floors = reachable.filter(row => witherOnLeg(at, row, withers) === null)
			.sort((a, b) => (blazes.length ? toBlaze(a) - toBlaze(b) : 0) || Math.hypot(b.x - at.x, b.z - at.z) - Math.hypot(a.x - at.x, a.z - at.z));
		const floor = floors[0];
		if (floor === undefined && reachable.length > 0) {
			const near = reachable.map(row => witherOnLeg(at, row, withers)).filter(Boolean).sort((a, b) => a.distance - b.distance)[0];
			return handBack('FAILED', 'WITHER_ON_DECK', `Every visible fortress floor leg passes a wither skeleton (nearest ${Math.round(near.distance)} blocks away at ${Math.floor(near.x)},${Math.floor(near.y)},${Math.floor(near.z)}); 2.4 tall, it cannot enter a two-high gap: wait in cover, tunnel 2-high, or fight it from a 2-high doorway`);
		}
		// Nothing new in arm's reach or in the last look's far rays: look round once from here before giving up on it.
		if (floor === undefined && lookedFrom.every(spot => Math.hypot(at.x - spot.x, at.y - spot.y, at.z - spot.z) > 2)) {
			lookedFrom.push(at);
			const view = await look(0);
			if (view.interrupted || view.seen || view.ended) return settle(view);
			continue;
		}
		if (floor === undefined) return handBack('FAILED', 'FIND_BLOCKED', 'No new visible fortress floor reachable by walking found here; choose the next walkway or vantage point');
		attempted.add(`${floor.x},${floor.y},${floor.z}`);
		// A seen corridor (brick walls both sides) may be reached across a gap with carried blocks.
		const bricks = new Set(seenBlocks.filter(row => row.blockId === BRICK).map(row => cellOf(row)).filter(Boolean).map(c => `${c.x},${c.y},${c.z}`));
		const { far: distant, ...spot } = floor;
		const trip = await leg('along observed fortress floor', 'travel_to', { ...spot, tolerance: distant ? 2 : 1, build: corridorFloor(spot, bricks), stopWhenSeen: profile.stopId });
		const ended = await settle(trip);
		if (ended !== null) return ended;
		const after = bodyAt(observation());
		travelled += Math.hypot(after.x - at.x, after.y - at.y, after.z - at.z);
		visited.push(after);
		lookedFrom.push(after);
		const view = await look(0);
		if (view.interrupted || view.seen || view.ended) return settle(view);
	}
	return handBack('TIMED_OUT', 'FIND_BUDGET', 'The search time ran out');
}
