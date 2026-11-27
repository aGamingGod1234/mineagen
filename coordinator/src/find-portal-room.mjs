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
	const reachable = p => !floor || p.frame || p.y <= o.player.y + STEP_UP;
	const left = () => deadline - body.now();
	const rows = () => [...freshRows(o), ...(survey?.blocks ?? []), ...(survey?.poi ?? [])].filter(point);
	const safety = () => o.player.health <= 8 ? 'LOW_HEALTH' : o.player.inLava || o.player.hazard === 'lava' ? 'IN_LAVA'
		: o.player.onFire ? 'ON_FIRE' : o.player.underWater && (o.player.air < 60 || o.player.airSecondsLeft < 3) ? 'AIR_RESERVE_REACHED' : dangerNow(o);
	const nearFrame = sample => freshRows(sample).find(r => r.blockId === FRAME && distance(r, sample.player) <= 4) ?? null;
	const arrival = () => nearFrame(o) ?? rows().find(r => r.blockId === FRAME && distance(r, o.player) <= 4);
	const finish = (reasonCode, stoppedBy, seen = null, approach = null) => ({ state: reasonCode === 'FIND_SEEN' ? 'SUCCEEDED' : 'FAILED', reasonCode,
		message: `${stoppedBy}; portal search walked ${Math.round(s.walked)} blocks, ${s.pending.length} observed destinations left. Resume with find block end_portal_frame after handling the stop; no more eye throws.`,
		find: { target: 'end_portal_frame', covered: { walked: Math.round(s.walked) },
			portal: { origin: { ...s.origin }, visited: s.visited.length, pending: structuredClone(s.pending.slice(0, 6)), pendingCount: s.pending.length,
				...(skip ? { failed: s.failed.length } : {}), stoppedBy, ...(approach ? { approach } : {}) },
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
			...blocks.filter(r => r.blockId === FRAME).map(r => ({ ...r, frame: true }))];
		for (const p of candidates) {
			if (!point(p) || !inside(p) || (!p.frame && visited(p)) || failedNear(p)) continue;
			if (!p.frame && (solid.has(key(p)) || solid.has(key({ ...p, y: p.y + 1 })))) continue;
			if (!s.pending.some(q => key(q) === key(p))) s.pending.push(p);
		}
		s.pending = s.pending.filter(p => p.frame || (!visited(p) && !failedNear(p))).slice(-256);
	};
	const act = async args => {
		if (left() < 1000) return { end: finish('FIND_BUDGET', 'timeoutMs exhausted') };
		if (safety()) return { end: finish('FIND_DANGER', safety()) };
		const before = { ...o.player };
		survey = null;
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
			const look = await body.look({ pitch: 15, survey: { include: ['blocks', 'poi', 'blocks:minecraft:end_portal_frame'] } });
			survey = look?.survey ?? null;
			o = await body.observe();
		}
		if (safety()) return finish('FIND_DANGER', safety());
		if (arrival()) return finish('FIND_SEEN', 'Portal room reached', arrival());
		collect();
		const next = s.pending.filter(p => inside(p) && distance(p, o.player) > 2 && reachable(p))
			.sort((a, b) => Number(!!b.frame) - Number(!!a.frame) || distance(a, o.player) - distance(b, o.player))[0];
		if (!next) return finish('FIND_BLOCKED', 'No unvisited observed passage; inspect the doorway or stair here, then resume');
		const dest = next;
		const { end, result, before } = await act({ x: dest.x, y: dest.y, z: dest.z, build: false, tolerance: dest.frame ? 3 : 1,
			boundaryX: s.origin.x, boundaryZ: s.origin.z, boundaryRadius: within });
		if (end) return end;
		if (result?.state !== 'SUCCEEDED' && !['NO_ROUTE', 'TRAVEL_TIMEOUT', 'TRAVEL_STALLED', 'STALLED_IN_PLACE'].includes(result?.reasonCode)) return finish('FIND_BLOCKED', result?.reasonCode ?? 'Walking stopped');
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
		body.progress?.({ label: `Portal room search: ${Math.round(s.walked)} blocks walked, ${s.pending.length} observed destinations` });
	}
	return finish('FIND_BUDGET', 'Portal search work/time budget exhausted');
}
