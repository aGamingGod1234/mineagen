// Walk observed stronghold passages. Coordinates come only from sight, memory and footing, never structure lookup.
import { getSwitch } from './switches.mjs';

export const skipFailed = (environment = process.env) => getSwitch('find.portalSkipFailed', environment).value;
// Spots a walk failed to reach stay failed for the whole stronghold, and so does footing this close to one: they are the
// tops of walls and ceilings the masonry rows offer as floor. One call tries this many before it hands back.
const FAILED_NEAR = 1.5;
const FAILS_PER_CALL = 4;
export const floorOnly = (environment = process.env) => getSwitch('find.portalFloorOnly', environment).value;
// A full block at the feet is wall; only a stair or slab there is a step up. A higher spot waits until the body has climbed near it.
const STEP = /^minecraft:stone_brick_(?:stairs|slab)$/;
const STEP_UP = 1.5;
export const sightPassages = (environment = process.env) => getSwitch('find.portalSight', environment).value;
// The body's block rows hold at most 8 of each kind within 6 blocks, nearest first, so inside an all-brick stronghold they end
// about 2 blocks out and no floor further on is ever seen: 30 of 57 floor-only searches handed back with every corridor open.
// The crosshair at each compass heading of the look-around shows how far the way is open there, as a player looks down a hall.
// A miss is open for the hand's 4.5-block reach, so the walk stops short of it; a wooden door or a step is a way on, past it.
const SIGHT_REACH = 3.5;
const WAY_ON = /^minecraft:(?:(?!iron_)[a-z_]+_door|[a-z_]+_(?:stairs|slab))$/;
const DOOR = /_door$/;
const compass = yaw => Math.round((Number.isFinite(yaw) ? yaw : 0) / 90) * 90;
// Minecraft yaw 0 faces +z (south), 90 faces -x (west).
const along = yaw => ({ x: Math.round(-Math.sin(yaw * Math.PI / 180)), z: Math.round(Math.cos(yaw * Math.PI / 180)) });
const COMPASS = { '0': 'S', '90': 'W', '180': 'N', '-180': 'N', '-90': 'E', '270': 'E' };
/** What each compass heading of a look showed: an open way (corridor, wooden door, step, room past a short wall) with its walk spot, or wall. */
export function sightWays(views) {
	const ways = [];
	for (const view of Array.isArray(views) ? views : []) {
		const at = view?.at, ray = view?.ray;
		if (!point(at) || !Number.isFinite(view.yaw)) continue;
		const yaw = compass(view.yaw), d = along(yaw), feet = Math.floor(at.y + 1e-3), heading = COMPASS[String(((yaw + 540) % 360) - 180)];
		const cell = (reach, y) => ({ x: Math.floor(at.x + d.x * reach) + 0.5, y, z: Math.floor(at.z + d.z * reach) + 0.5, sight: true, heading });
		if (ray?.type === 'miss') { ways.push({ heading, kind: 'corridor', spot: cell(SIGHT_REACH, feet) }); continue; }
		if (ray?.type !== 'block' || !point(ray)) continue;
		const reach = Math.abs((ray.x + 0.5 - at.x) * d.x + (ray.z + 0.5 - at.z) * d.z);
		const id = ray.blockId ?? '';
		if (WAY_ON.test(id)) ways.push({ heading, kind: DOOR.test(id) ? 'door' : 'step', block: id, spot: cell(reach + (DOOR.test(id) ? 2 : 1), DOOR.test(id) ? feet : Math.max(feet, ray.y + 1)) });
		else if (reach >= SIGHT_REACH) ways.push({ heading, kind: 'corridor', spot: cell(reach - 1, feet), wallAt: Math.round(reach) });
		else ways.push({ heading, kind: 'wall', block: id, at: Math.round(reach * 10) / 10 });
	}
	return ways;
}
export const sightSpots = views => sightWays(views).filter(w => w.spot).map(w => w.spot);
// A fork is two or more untaken ways on besides the way back. The model knows things the walker does not (where it came in,
// which doors it opened, where eyes flew), so it picks the branch: on 27 Nov main reached the portal room 2 of 3 times on one
// start by choosing after quick handbacks, while the walker choosing alone drifted 58-59 blocks the wrong way twice.
const FORK_NEAR = 4;
export const portalTarget = target => /^(minecraft:)?end_portal_frame$/.test(target.block ?? '');
const FRAME = 'minecraft:end_portal_frame';
const MASONRY = /^minecraft:(?:(?:mossy_|cracked_)?stone_bricks|stone_brick_stairs|stone_brick_slab)$/;
const point = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const freshRows = o => o?.continuity?.rememberedSections?.includes('blocks') ? []
	: [...(o?.blocks ?? []), ...(o?.sighted?.blocks ?? []), ...(o?.landmarks ?? [])].filter(point);
export const strongholdNearby = (o, body) => [...freshRows(o), ...(body.known?.(o, MASONRY)?.blocks ?? [])]
	.some(r => MASONRY.test(r.blockId) && distance(r, o.player) <= 24);

export async function findPortalRoom(body, { observation, deadline, within, dangerCodes, dangerNow }) {
	let o = observation, survey = null;
	const eyes = body.eyeSearchState ??= {};
	const s = eyes.portal ??= { origin: { x: o.player.x, y: o.player.y, z: o.player.z }, visited: [], pending: [], walked: 0 };
	// A twelve-eyes game handed back the same few unreachable spots 3-5 times each for 87 min, 40 blocks short of the room.
	const skip = skipFailed();
	s.failed ??= [];
	let failsHere = 0;
	const failedNear = p => skip && !p.frame && s.failed.some(f => distance(f, p) < FAILED_NEAR);
	// Two twelve-eyes games failed 51 and 127 walks 1-3 blocks short of wall and ceiling tops 1-4 blocks above the body.
	const floor = floorOnly();
	const feet = () => Math.floor(o.player.y + 1e-3);
	const floorBlock = r => !floor || r.y < feet() || STEP.test(r.blockId);
	const reachable = p => !floor || p.frame || p.sight || p.y <= o.player.y + STEP_UP;
	const sight = sightPassages();
	let views = null;
	s.sightWalks ??= 0; s.forks ??= [];
	// The model walked a branch from the last fork: that walk is the heading, so its way back is not offered as new.
	const fork = s.forks.at(-1), fromFork = fork && { x: o.player.x - fork.x, z: o.player.z - fork.z };
	if (sight && fromFork && Math.hypot(fromFork.x, fromFork.z) >= 1) s.heading = { x: fromFork.x / Math.hypot(fromFork.x, fromFork.z), z: fromFork.z / Math.hypot(fromFork.x, fromFork.z) };
	const left = () => deadline - body.now();
	const rows = () => [...freshRows(o), ...(survey?.blocks ?? []), ...(survey?.poi ?? [])].filter(point);
	const safety = () => o.player.health <= 8 ? 'LOW_HEALTH' : o.player.inLava || o.player.hazard === 'lava' ? 'IN_LAVA'
		: o.player.onFire ? 'ON_FIRE' : o.player.underWater && (o.player.air < 60 || o.player.airSecondsLeft < 3) ? 'AIR_RESERVE_REACHED' : dangerNow(o);
	const nearFrame = sample => freshRows(sample).find(r => r.blockId === FRAME && distance(r, sample.player) <= 4) ?? null;
	const arrival = () => nearFrame(o) ?? rows().find(r => r.blockId === FRAME && distance(r, o.player) <= 4);
	const finish = (reasonCode, stoppedBy, seen = null, approach = null, ways = null) => ({ state: reasonCode === 'FIND_SEEN' ? 'SUCCEEDED' : 'FAILED', reasonCode,
		message: `${stoppedBy}; portal search walked ${Math.round(s.walked)} blocks, ${s.pending.length} observed destinations left. Resume with find block end_portal_frame after handling the stop; no more eye throws.`,
		find: { target: 'end_portal_frame', covered: { walked: Math.round(s.walked) },
			portal: { origin: { ...s.origin }, visited: s.visited.length, pending: structuredClone(s.pending.slice(0, 6)), pendingCount: s.pending.length,
				...(skip ? { failed: s.failed.length } : {}), ...(sight ? { sightWalks: s.sightWalks } : {}), stoppedBy, ...(ways ? { ways } : {}), ...(approach ? { approach } : {}) },
			...(seen ? { seen: { ...seen, id: FRAME, via: 'portal room sight' } } : {}) } });
	const inside = p => Math.hypot(p.x - s.origin.x, p.z - s.origin.z) <= within;
	const visited = p => s.visited.some(v => distance(v, p) < 3);
	const collect = () => {
		const known = body.known?.(o, /^minecraft:(?:end_portal_frame|(?:mossy_|cracked_)?stone_bricks|stone_brick_stairs|stone_brick_slab)$/)?.blocks ?? [];
		const blocks = [...rows(), ...known].filter(point);
		const solid = new Set(blocks.filter(r => !/^minecraft:(?:air|cave_air|void_air|[a-z_]+_door)$/.test(r.blockId)).map(key));
		const candidates = [...(body.frontier?.(o)?.candidates ?? []).filter(p => !p.blocked).map(p => ({ ...p, x: p.x + 0.5, z: p.z + 0.5 })),
			...blocks.filter(r => MASONRY.test(r.blockId) && r.y <= o.player.y && r.y >= o.player.y - 8 && floorBlock(r))
				.map(r => ({ x: r.x + 0.5, y: r.y + 1, z: r.z + 0.5 })),
			...blocks.filter(r => r.blockId === FRAME).map(r => ({ ...r, frame: true })),
			...(sight ? sightSpots(views) : [])];
		for (const p of candidates) {
			if (!point(p) || !inside(p) || (!p.frame && visited(p)) || failedNear(p)) continue;
			if (!p.frame && (solid.has(key(p)) || solid.has(key({ ...p, y: p.y + 1 })))) continue;
			if (!s.pending.some(q => key(q) === key(p))) s.pending.push(p);
		}
		s.pending = s.pending.filter(p => p.frame || (!visited(p) && !failedNear(p)));
		// Masonry rows can number hundreds; the few sighted ways on and frames are never pushed out behind them.
		const kept = p => p.frame || p.sight;
		s.pending = [...s.pending.filter(kept).slice(-128), ...s.pending.filter(p => !kept(p)).slice(-256)];
	};
	const act = async args => {
		if (left() < 1000) return { end: finish('FIND_BUDGET', 'timeoutMs exhausted') };
		if (safety()) return { end: finish('FIND_DANGER', safety()) };
		const before = { ...o.player };
		survey = null; views = null;
		const result = await body.act('travel_to', { ...args, timeoutMs: Math.floor(Math.min(left(), 20_000)) }, { watch: nearFrame });
		o = await body.observe();
		s.walked += distance(before, o.player);
		if (result?.interruptedBy || dangerCodes.has(result?.reasonCode) || safety()) {
			return { end: finish('FIND_DANGER', safety() ?? result?.reasonCode ?? result.interruptedBy) };
		}
		const frame = arrival() ?? (result?.seen?.blockId === FRAME && distance(result.seen, o.player) <= 4 ? result.seen : null);
		if (frame) return { end: finish('FIND_SEEN', `Portal room reached at ${frame.x},${frame.y},${frame.z}`, frame) };
		return { result, before };
	};
	// Per-call work bound; the goal-scoped state survives a budget, danger or blocked handback.
	for (let leg = 0; leg < 64 && left() >= 1000; leg++) {
		if (safety()) return finish('FIND_DANGER', safety());
		if (arrival()) return finish('FIND_SEEN', 'Portal room reached', arrival());
		if (!visited(o.player)) s.visited.push({ x: o.player.x, y: o.player.y, z: o.player.z });
		if (body.look) {
			const look = await body.look({ pitch: 15, ...(sight ? { yaw: compass(o.player.yaw) } : {}), survey: { include: ['blocks', 'poi', 'blocks:minecraft:end_portal_frame'] } });
			survey = look?.survey ?? null;
			views = look?.sight ?? null;
			o = await body.observe();
		}
		if (safety()) return finish('FIND_DANGER', safety());
		if (arrival()) return finish('FIND_SEEN', 'Portal room reached', arrival());
		collect();
		// Straight on before the sides, the way back last: the spots a look offers all lie about the same distance out.
		const ahead = p => !sight || !s.heading ? 0 : ((p.x - o.player.x) * s.heading.x + (p.z - o.player.z) * s.heading.z) / Math.max(1, Math.hypot(p.x - o.player.x, p.z - o.player.z));
		const cost = p => distance(p, o.player) - 2 * ahead(p);
		const open = s.pending.filter(p => inside(p) && distance(p, o.player) > 2);
		const order = (a, b) => Number(!!b.frame) - Number(!!a.frame) || cost(a) - cost(b);
		const back = p => !!s.heading && ((p.x - o.player.x) * s.heading.x + (p.z - o.player.z) * s.heading.z) < -1;
		const report = () => {
			if (!sight || !views) return null;
			return sightWays(views).map(w => !w.spot ? { heading: w.heading, kind: w.kind, ...(w.block ? { block: w.block } : {}) }
				: { heading: w.heading, kind: w.kind, ...(w.block ? { block: w.block } : {}), spot: { x: w.spot.x, y: w.spot.y, z: w.spot.z },
					status: back(w.spot) ? 'way back' : failedNear(w.spot) ? 'failed' : !inside(w.spot) ? 'outside search' : visited(w.spot) ? 'walked' : 'new' });
		};
		const ways = report();
		const untaken = (ways ?? []).filter(w => w.status === 'new');
		if (untaken.length >= 2 && !open.some(p => p.frame) && !s.forks.some(f => distance(f, o.player) < FORK_NEAR)) {
			s.forks.push({ x: o.player.x, y: o.player.y, z: o.player.z });
			const list = ways.map(w => `${w.heading} ${w.kind}${w.status ? ` ${w.status}${w.status === 'new' ? ` (travel_to ${w.spot.x},${w.spot.y},${w.spot.z})` : ''}` : ''}`).join('; ');
			return finish('FIND_BLOCKED', `Fork in the stronghold: ${list}. Choose the branch most likely to lead to the portal room (away from ground already covered, toward where the eyes flew), travel_to its spot, then resume find block end_portal_frame; this fork is not handed back again`, null, null, ways);
		}
		const next = open.filter(reachable).sort(order)[0];
		if (next?.sight) s.sightWalks++;
		if (!next) return finish('FIND_BLOCKED', 'No unvisited observed passage; inspect the doorway or stair here, then resume', null, null, ways);
		const dest = next;
		const { end, result, before } = await act({ x: dest.x, y: dest.y, z: dest.z, build: false, tolerance: dest.frame ? 3 : 1,
			boundaryX: s.origin.x, boundaryZ: s.origin.z, boundaryRadius: within });
		if (end) return end;
		// A sighted way on through a door the walker could not open is one more failed spot, not the end of the search.
		const tried = ['NO_ROUTE', 'TRAVEL_TIMEOUT', 'TRAVEL_STALLED', 'STALLED_IN_PLACE', ...(sight && skip ? ['PATH_BLOCKED'] : [])];
		if (result?.state !== 'SUCCEEDED' && !tried.includes(result?.reasonCode)) return finish('FIND_BLOCKED', result?.reasonCode ?? 'Walking stopped');
		// A spot the walk did not reach is not offered again in this stronghold, whether or not the body moved on the way.
		if (skip && result?.state !== 'SUCCEEDED' && !dest.frame) {
			s.failed.push({ x: dest.x, y: dest.y, z: dest.z });
			s.pending = s.pending.filter(p => !failedNear(p));
		}
		// Another nearby target does not resolve a missing passage from this same standing spot.
		const noProgress = ['NO_ROUTE', 'STALLED_IN_PLACE'].includes(result?.reasonCode) && distance(before, o.player) < 0.5;
		// With failed spots remembered, the next spot is tried from here before the search hands back.
		if (noProgress && skip && ++failsHere < FAILS_PER_CALL) continue;
		if (noProgress) {
			const actual = { x: o.player.x, y: o.player.y, z: o.player.z };
			return finish('FIND_BLOCKED', `Walking made no progress from this standing spot. Requested floor feet y${dest.y}, stopped at y${actual.y}; inspect the observed doorway, stairs or obstruction before resuming`, null,
				{ requested: { x: dest.x, y: dest.y, z: dest.z }, actual, verticalGap: dest.y - actual.y,
					reasonCode: result.reasonCode, message: result.message });
		}
		const moved = { x: o.player.x - before.x, z: o.player.z - before.z }, length = Math.hypot(moved.x, moved.z);
		if (length >= 1) s.heading = { x: moved.x / length, z: moved.z / length };
		body.progress?.({ label: `Portal room search: ${Math.round(s.walked)} blocks walked, ${s.pending.length} observed destinations` });
	}
	return finish('FIND_BUDGET', 'Portal search work/time budget exhausted');
}
