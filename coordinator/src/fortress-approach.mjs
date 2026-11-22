/**
 * Wall breaker rods (b): the walk to a fortress spawner watches for wither skeletons. Staged fortress runs lost 12 of 28
 * deaths to them, most on open walkways; a wither skeleton (2.4 tall) cannot follow into a two-high corridor, so floor
 * legs that pass one are not taken, and legs into a seen corridor may place blocks to cross a gap.
 */
export const WITHER_NEAR_FLOOR = 16;
export const WITHER_NEAR_PATH = 6;

/** Wither skeletons the body perceives now (sight or sound, not memory), with positions. */
export function withersSeen(observation) {
	if (observation?.continuity?.rememberedSections?.includes('entities')) return [];
	return (observation?.entities ?? []).filter((e) => e?.type === 'minecraft:wither_skeleton' && e.alive !== false)
		.map((e) => ({ x: e.x ?? e.position?.x, y: e.y ?? e.position?.y, z: e.z ?? e.position?.z }))
		.filter((e) => [e.x, e.y, e.z].every(Number.isFinite));
}

function segmentDistance(p, a, b) {
	const ab = [b.x - a.x, b.y - a.y, b.z - a.z], ap = [p.x - a.x, p.y - a.y, p.z - a.z];
	const length = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
	const t = length === 0 ? 0 : Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / length));
	return Math.hypot(p.x - a.x - t * ab[0], p.y - a.y - t * ab[1], p.z - a.z - t * ab[2]);
}

/** The nearest seen wither skeleton to a floor leg from `from` to `floor`, or null when the leg is clear of them. */
export function witherOnLeg(from, floor, withers) {
	let worst = null;
	for (const wither of withers) {
		const toFloor = Math.hypot(wither.x - floor.x, wither.y - floor.y, wither.z - floor.z);
		const toPath = segmentDistance(wither, from, floor);
		if (toFloor <= WITHER_NEAR_FLOOR || toPath <= WITHER_NEAR_PATH) {
			const distance = Math.hypot(wither.x - from.x, wither.y - from.y, wither.z - from.z);
			if (worst === null || distance < worst.distance) worst = { ...wither, distance, toFloor, toPath };
		}
	}
	return worst;
}

/**
 * A corridor floor: nether bricks beside the feet cell on both sides along one axis (the walls of a fortress corridor),
 * where a wither skeleton cannot walk abreast and a gap may be bridged. `bricks` holds 'x,y,z' keys of seen bricks.
 */
export function corridorFloor(floor, bricks) {
	const x = Math.floor(floor.x), y = Math.floor(floor.y), z = Math.floor(floor.z);
	const brick = (dx, dz) => bricks.has(`${x + dx},${y},${z + dz}`) || bricks.has(`${x + dx},${y + 1},${z + dz}`);
	return brick(1, 0) && brick(-1, 0) || brick(0, 1) && brick(0, -1);
}
