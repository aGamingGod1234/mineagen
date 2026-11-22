// The Nether fortress legs of a find search (searchFor in find-search.mjs): the walk along seen fortress floor toward a
// spawner, and the gate that says when the surface legs are a Nether crossing. find-search.mjs owns the search and its
// legs; it hands this file the live search (current observation, leg, look, settle, hand-back and limits).
import { corridorFloor, witherOnLeg, withersSeen } from './fortress-approach.mjs';

// c8861: masonry alone sent compass building legs through rock and away from the fortress.
// A visible top face is a destination to try, not proof of reachable floor; walking navigation owns that check.
export const fortressSpawnerSearch = (profile, observation) => profile.kind === 'block' && profile.ids.has('minecraft:spawner')
	&& observation?.world?.dimension === 'minecraft:the_nether'
	&& !observation?.continuity?.rememberedSections?.includes('blocks')
	&& (observation?.blocks ?? []).some((row) => row.blockId === 'minecraft:nether_bricks');

// Spawner exploration has its own fortress-floor policy; leave its generic fallback unchanged too.
export const netherCrossing = (profile, observation) => observation?.world?.dimension === 'minecraft:the_nether'
	&& !(profile.kind === 'block' && profile.ids.has('minecraft:spawner'));

/**
 * Walks seen fortress floor until the target is seen or the search hands back; every path returns a search result.
 * `search.observation()` reads the search's current observation, which each leg and look replaces.
 */
export async function walkFortressFloor(search) {
	const { profile, observation, bodyAt, cellOf, insideBoundary, left, leg, settle, look, handBack, minLegMs, buildLeg, buildBudget } = search;
	const attempted = new Set(), visited = [bodyAt(observation())];
	let travelled = 0;
	while (left() >= minLegMs) {
		const at = bodyAt(observation());
		const seenBlocks = observation()?.continuity?.rememberedSections?.includes('blocks') ? [] : (observation()?.blocks ?? []);
		const reachable = seenBlocks
			.filter(row => row.blockId === 'minecraft:nether_bricks' && row.placeableFaces?.includes('up'))
			.map(row => { const cell = cellOf(row); return cell === null ? null : { x: cell.x + 0.5, y: cell.y + 1, z: cell.z + 0.5 }; })
			.filter(row => row !== null && insideBoundary(row) && !attempted.has(`${row.x},${row.y},${row.z}`)
				&& Math.hypot(row.x - at.x, row.y - at.y, row.z - at.z) <= Math.min(buildLeg, buildBudget - travelled)
				&& visited.every(spot => Math.hypot(row.x - spot.x, row.y - spot.y, row.z - spot.z) > 2));
		// Wall breaker rods (b): no floor leg past a seen wither skeleton (they killed most on open walkways).
		const withers = withersSeen(observation());
		const floors = reachable.filter(row => witherOnLeg(at, row, withers) === null)
			.sort((a, b) => Math.hypot(b.x - at.x, b.z - at.z) - Math.hypot(a.x - at.x, a.z - at.z));
		const floor = floors[0];
		if (floor === undefined && reachable.length > 0) {
			const near = reachable.map(row => witherOnLeg(at, row, withers)).filter(Boolean).sort((a, b) => a.distance - b.distance)[0];
			return handBack('FAILED', 'WITHER_ON_DECK', `Every visible fortress floor leg passes a wither skeleton (nearest ${Math.round(near.distance)} blocks away at ${Math.floor(near.x)},${Math.floor(near.y)},${Math.floor(near.z)}); 2.4 tall, it cannot enter a two-high gap: wait in cover, tunnel 2-high, or fight it from a 2-high doorway`);
		}
		if (floor === undefined) return handBack('FAILED', 'FIND_BLOCKED', 'No new visible fortress floor reachable by walking found here; choose the next walkway or vantage point');
		attempted.add(`${floor.x},${floor.y},${floor.z}`);
		// A seen corridor (brick walls both sides) may be reached across a gap with carried blocks.
		const bricks = new Set(seenBlocks.filter(row => row.blockId === 'minecraft:nether_bricks').map(row => cellOf(row)).filter(Boolean).map(c => `${c.x},${c.y},${c.z}`));
		const trip = await leg('along observed fortress floor', 'travel_to', { ...floor, tolerance: 1, build: corridorFloor(floor, bricks), stopWhenSeen: profile.stopId });
		const ended = await settle(trip);
		if (ended !== null) return ended;
		const after = bodyAt(observation());
		travelled += Math.hypot(after.x - at.x, after.y - at.y, after.z - at.z);
		visited.push(after);
		const view = await look(0);
		if (view.interrupted || view.seen || view.ended) return settle(view);
	}
	return handBack('TIMED_OUT', 'FIND_BUDGET', 'The search time ran out');
}
