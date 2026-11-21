// Eye guidance uses only the thrower's visible-flight receipts, never a server structure lookup.
const EYE = 'minecraft:ender_eye';
export const STRONGHOLD_BLOCKS = ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'iron_bars', 'end_portal_frame'].map(id => `minecraft:${id}`);
export const eyesHeld = o => (o.inventory?.items ?? []).filter(r => r.itemId === EYE).reduce((n, r) => n + r.count, 0);
export const eyeTarget = target => /^(minecraft:)?stronghold$/.test(target.structure ?? '');
const point = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]));
const direction = yaw => ({ x: -Math.sin(yaw * Math.PI / 180), z: Math.cos(yaw * Math.PI / 180) });
export function intersectEyes(a, b) {
	if (!Number.isFinite(a?.yaw) || !Number.isFinite(b?.yaw) || Math.hypot(a.from.x - b.from.x, a.from.z - b.from.z) < 8) return null;
	const u = direction(a.yaw), v = direction(b.yaw), cross = u.x * v.z - u.z * v.x;
	if (Math.abs(cross) < Math.sin(Math.PI / 180)) return null;
	const dx = b.from.x - a.from.x, dz = b.from.z - a.from.z;
	const t = (dx * v.z - dz * v.x) / cross, s = (dx * u.z - dz * u.x) / cross;
	return t > 0 && s > 0 ? { x: Math.round(a.from.x + t * u.x), z: Math.round(a.from.z + t * u.z) } : null;
}
// Two throws locate the stronghold well enough to stop throwing when they stood this far apart and their headings cross at
// this angle or more: a 1 degree heading error then moves the crossing by a few blocks per 100, not hundreds.
export const TRUSTED_BASE_BLOCKS = 24;
export const TRUSTED_CROSS_DEGREES = 8;
// Close enough to a trusted crossing to dig down there (the eye targets the stronghold's start, its rooms spread ~50 blocks).
export const ESTIMATE_DIG_BLOCKS = 16;
// A dropped eye out of view is searched for once, and only this near: the body walks to where it dropped and looks.
export const DROP_SEARCH_BLOCKS = 24;
// How far a thrown eye flies along its heading before it drops or breaks (vanilla: about 12 blocks).
export const EYE_FLIGHT_BLOCKS = 12;
// Where the body looks while an eye flies: this far along its heading and a little above, so the end of the flight and the
// drop below it stay inside the view cone.
export const EYE_WATCH_BLOCKS = 10;
// A leg that ends with one of these after covering ground still counts as a leg: the next eye is thrown from there.
export const SOFT_LEG_CODES = new Set(['TRAVEL_TIMEOUT', 'NO_ROUTE', 'TRAVEL_STALLED', 'STALLED_IN_PLACE', 'BUILD_FAILED', 'OUT_OF_BLOCKS', 'NO_FLOOR', 'NO_STANDABLE_PATH']);
export function trustedCross(a, b) {
	if (!Number.isFinite(a?.yaw) || !Number.isFinite(b?.yaw) || !point(a.from) || !point(b.from)) return false;
	if (Math.hypot(a.from.x - b.from.x, a.from.z - b.from.z) < TRUSTED_BASE_BLOCKS) return false;
	const angle = Math.abs(((a.yaw - b.yaw) % 360 + 540) % 360 - 180);
	return angle >= TRUSTED_CROSS_DEGREES && angle <= 180 - TRUSTED_CROSS_DEGREES && intersectEyes(a, b) !== null;
}
export function eyeLeg(flight, throwNumber = 1) {
	if (flight.vertical === 'sank' || (flight.lostFromView !== true && Number.isFinite(flight.flewBlocks) && flight.flewBlocks < 3)) return 0;
	// A rising eye says only "that way": the first leg is long, later ones shorter so a pass over the stronghold is small
	// (staged scout 4f75f: the second 120-block leg began 76 blocks short of the stronghold and went 44 past it).
	return flight.vertical === 'level' ? 24 : throwNumber <= 1 ? 120 : 64;
}
/** Two throws whose headings oppose have the stronghold between them: the next throw goes from the middle of that span. */
export function eyeBracket(bracket, previous, last) {
	if (!Number.isFinite(last?.yaw)) return bracket;
	const d = direction(last.yaw);
	if (bracket) {
		const towardA = d.x * (bracket.a.x - last.from.x) + d.z * (bracket.a.z - last.from.z) > 0;
		return towardA ? { a: bracket.a, b: { x: last.from.x, z: last.from.z } } : { a: { x: last.from.x, z: last.from.z }, b: bracket.b };
	}
	if (!Number.isFinite(previous?.yaw)) return null;
	const p = direction(previous.yaw);
	return p.x * d.x + p.z * d.z < -0.17 ? { a: { x: previous.from.x, z: previous.from.z }, b: { x: last.from.x, z: last.from.z } } : null;
}
const flights = o => (o.perception?.events ?? []).filter(e => e.type === 'eye_of_ender_flight' && point(e.from));

export async function followEyes(target, body, { observation: initial, deadline, within, dangerCodes, dangerNow, seenAtOf, discard }) {
	let o = initial, survey = null;
	const state = body.eyeSearchState ?? (body.eyeSearchState = {});
	state.origin ??= { ...o.player };
	state.throws ??= [];
	state.walked ??= 0;
	state.filled ??= [];
	state.phase ??= 'throw';
	const left = () => deadline - body.now();
	const refresh = async () => {
		o = await body.observe();
		const last = state.throws.at(-1);
		const update = last?.flightId == null ? null : flights(o).findLast(e => e.flightId === last.flightId);
		if (update && update.sequence > (last.sequence ?? -1)) Object.assign(last, update);
		for (const r of [...(o.blocks ?? []), ...(o.landmarks ?? []), ...(survey?.blocks ?? []), ...(body.known?.(o, /^minecraft:end_portal_frame$/)?.blocks ?? [])]) {
			if (r.blockId === 'minecraft:end_portal_frame' && ([true, 'true'].includes(r.state?.eye) || /["\[]eye["=:\s]+(?:"?true)/.test(r.blockState ?? ''))) {
				const key = `${r.x},${r.y},${r.z}`;
				if (!state.filled.includes(key)) state.filled.push(key);
			}
		}
	};
	const seen = sample => {
		if (sample?.continuity?.rememberedSections?.includes('blocks')) return null;
		return [...(sample?.blocks ?? []), ...(sample?.sighted?.blocks ?? [])].find(r => STRONGHOLD_BLOCKS.includes(r.blockId) && point(r)) ?? null;
	};
	const arrival = () => seen(o) ?? seen({ blocks: survey?.blocks });
	// One eye may break on the way: a body holding exactly 12 could otherwise never throw (staged twelve-eyes start), and a
	// portal has a filled frame more often than not (each frame 1 in 10). Below 11 minus filled frames takes the flag.
	const reserve = () => Math.max(0, 11 - Math.min(11, state.filled.length));
	const finish = (reasonCode, stop, found = null) => {
		const left = state.throws.filter(t => t.recovery === 'not_found').map(t => t.droppedAt ?? t.estimatedDrop).filter(point);
		const facts = { throwsMade: state.throws.length, eyesLeft: eyesHeld(o), throws: structuredClone(state.throws), lastHeading: state.throws.at(-1)?.yaw ?? null,
			...(left.length ? { eyesLeftBehind: left.map(at => ({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) })) } : {}),
			estimatedStronghold: state.estimate ?? null, travelled: Math.round(state.walked), stoppedBy: stop, reserve: reserve(), allowEyeReserveUse: target.allowEyeReserveUse === true, phase: state.phase };
		const bearings = state.throws.map((t, i) => `#${i + 1} at ${['x', 'y', 'z'].map(k => Math.round(t.from[k])).join(',')}: ${t.yaw ?? '?'} degrees, ${t.eyesAfter ?? '?'} eyes after throw`).join('; ');
		return { state: reasonCode === 'FIND_SEEN' ? 'SUCCEEDED' : 'FAILED', reasonCode,
			message: `${stop}; throws ${facts.throwsMade}, eyes left ${facts.eyesLeft}; ${bearings || 'no headings yet'}; estimated stronghold ${state.estimate ? `${state.estimate.x},${state.estimate.z}${state.estimateTrusted && !state.estimateRejected ? ' (two throws cross)' : ''}` : 'unknown'}; ${left.length ? `eye left at ${left.map(at => ['x', 'y', 'z'].map(k => Math.floor(at[k])).join(',')).join('; ')}; ` : ''}travelled ${facts.travelled} blocks. Reserve ${reserve()} (11 minus known filled frames; the portal takes 12 minus its filled frames); throwing below reserve requires allowEyeReserveUse:true.`,
			find: { target: 'stronghold', eyes: facts, covered: { walked: facts.travelled }, ...(found ? { seen: { ...found, id: found.blockId, via: 'eye search' } } : {}) } };
	};
	const safety = () => {
		const p = o.player;
		return p.health <= 8 ? 'LOW_HEALTH' : p.inLava || p.hazard === 'lava' ? 'IN_LAVA' : p.onFire ? 'ON_FIRE' : p.underWater && (p.air < 60 || p.airSecondsLeft < 3) ? 'AIR_RESERVE_REACHED' : dangerNow(o);
	};
	const act = async (type, args, { soft = false } = {}) => {
		if (left() < 1000) return finish('FIND_BUDGET', 'timeoutMs exhausted');
		const unsafe = safety();
		if (unsafe) return finish('FIND_DANGER', unsafe);
		const before = { ...o.player };
		const timed = ['travel_to', 'dig_to', 'pick_up_item'].includes(type);
		survey = null;
		const result = await body.act(type, { ...args, ...(timed ? { timeoutMs: Math.floor(Math.min(left(), type === 'travel_to' ? 150_000 : 60_000)) } : {}) },
			['travel_to', 'dig_to'].includes(type) ? { watch: seen } : {});
		await refresh();
		if (type === 'use_item') state.throws.at(-1).eyesAfter = eyesHeld(o);
		state.walked += Math.hypot(o.player.x - before.x, o.player.z - before.z);
		if (result?.interruptedBy || dangerCodes.has(result?.reasonCode) || safety()) return finish('FIND_DANGER', dangerCodes.has(result?.reasonCode) ? result.reasonCode : safety() ?? result?.interruptedBy ?? 'interrupted');
		const found = result?.seen ?? arrival();
		if (found) return finish('FIND_SEEN', `Stronghold blocks seen at ${found.x},${found.y},${found.z}`, found);
		if (result?.reasonCode === 'TARGET_SEEN') {
			const at = seenAtOf(result.message);
			if (at) return finish('FIND_SEEN', result.message, { ...at, blockId: 'minecraft:stone_bricks' });
		}
		// A leg cut short by its time or by water with ground covered is still a leg: throw again from here.
		// So is one that covered ground and then stopped at water or a gap it could not bridge: a player throws again from the
		// shore (eye rooms: legs ended BUILD_FAILED and OUT_OF_BLOCKS at the same lakes after 20-100 blocks walked).
		if (soft && SOFT_LEG_CODES.has(result?.reasonCode) && Math.hypot(o.player.x - before.x, o.player.z - before.z) >= 8) return null;
		if (result?.state !== 'SUCCEEDED') return finish('FIND_BLOCKED', result?.reasonCode ?? 'action did not complete');
		return null;
	};
	const bounded = args => ({ ...args, boundaryX: state.origin.x, boundaryZ: state.origin.z, boundaryRadius: within });
	const ingest = flight => {
		const t = state.throws.at(-1);
		Object.assign(t, flight);
		for (const earlier of state.throws.slice(0, -1).reverse()) {
			const cross = intersectEyes(earlier, t);
			if (cross) { state.estimate = cross; state.estimateTrusted = trustedCross(earlier, t); break; }
		}
		// An eye lost from view still ends about 12 blocks along its heading and drops there 4 times in 5 (vanilla): it is
		// searched for there (live eye fixture: 2 of 3 throws ended "unseen", and both eyes stayed on the ground).
		if (!t.droppedAt && t.outcome === 'unseen' && Number.isFinite(t.yaw) && point(t.from)) {
			const d = direction(t.yaw);
			t.estimatedDrop = { x: t.from.x + d.x * EYE_FLIGHT_BLOCKS, y: t.from.y, z: t.from.z + d.z * EYE_FLIGHT_BLOCKS };
		}
		state.phase = flight.droppedAt || t.estimatedDrop ? 'recover' : 'leg';
	};
	await refresh();
	if (!safety() && left() >= 2000 && body.look) {
		const look = await body.look({ pitch: 0, survey: { include: ['blocks', 'poi'] } });
		survey = look?.survey ?? null;
		await refresh();
	}
	while (left() >= 1000) {
		const unsafe = safety();
		if (unsafe) return finish('FIND_DANGER', unsafe);
		if (arrival()) return finish('FIND_SEEN', `Stronghold blocks seen at ${arrival().x},${arrival().y},${arrival().z}`, arrival());
		const last = state.throws.at(-1);
		if (state.phase === 'flight') {
			const event = flights(o).find(e => !state.beforeFlights.includes(e.flightId ?? e.sequence));
			if (event) { ingest(event); continue; }
			// Flight receipts are published at the end. Turn through visible space during the flight,
			// then keep the seen eye in view so its final height and drop are observable.
			if ((state.scanTurns ?? 0) < 4) {
				const eye = (o.entities ?? []).find(r => r.type === 'minecraft:eye_of_ender' && point(r));
				const from = last.from, gone = eye ? Math.hypot(eye.x - from.x, eye.z - from.z) : 0;
				// Just thrown, the eye is still at the hand: looking there pitches the view down at the body's own feet, and
				// the eye is out of sight once it is 2 blocks off (live eye rooms: every throw seen for 1.9 blocks only).
				// Let it move a little first; from then its heading from the throw point is its heading to the stronghold.
				if (eye && gone < 0.3 && (state.eyeWaits ?? 0) < 4) {
					state.eyeWaits = (state.eyeWaits ?? 0) + 1;
					const end = await act('wait', { durationMs: 100 });
					if (end) return end;
					continue;
				}
				if (eye) {
					state.scanTurns = 4;
					// Watch where it goes, as a player does: look along its heading, above where it ends and drops.
					const ahead = gone >= 0.3 ? { x: (eye.x - from.x) / gone, z: (eye.z - from.z) / gone } : direction(o.player.yaw ?? 0);
					const end = await act('look_at', { x: from.x + ahead.x * EYE_WATCH_BLOCKS, y: from.y + 4, z: from.z + ahead.z * EYE_WATCH_BLOCKS });
					if (end) return end;
				} else {
					const yaw = [-180, -90, 0, 90][state.scanTurns ?? 0];
					state.scanTurns = (state.scanTurns ?? 0) + 1;
					const end = await act('control', { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false,
						yaw, pitch: -15, selectedSlot: o.inventory.selectedSlot ?? 0, hand: 'main', ticks: 2 });
					if (end) return end;
				}
				continue;
			}
			if (state.waited) return finish('FIND_BLOCKED', 'Eye flight not observed; heading unknown');
			state.waited = true;
			const end = await act('wait', { durationMs: Math.min(5000, left()) });
			if (end) return end;
			continue;
		}
		if (state.phase === 'recover') {
			// Walking can collect the eye even when that leg stops in water or is interrupted.
			// A later find must not retrace the old drop after inventory proves recovery.
			if (Number.isFinite(last.eyesAfter) && eyesHeld(o) > last.eyesAfter) {
				last.eyesAfterPickup = eyesHeld(o);
				state.phase = 'leg';
				continue;
			}
			// droppedAt may be an airborne end marker. Only a currently seen item justifies recovery travel.
			// Read each time: a receipt lost from view can turn into a drop once the walk brings the eye back in sight.
			const visibleDrop = () => {
				const dropAt = last.droppedAt ?? last.estimatedDrop, near = last.droppedAt ? 4 : 6;
				return (o.items ?? []).find(r => r.itemId === EYE && point(r) && r.stableId
					&& (last.dropId ? r.stableId === last.dropId : Math.hypot(r.x - dropAt.x, r.z - dropAt.z) < near));
			};
			let dropAt = last.droppedAt ?? last.estimatedDrop;
			let current = visibleDrop();
			// Lost from view in flight: look where it should have dropped before walking there (the drop then reads as seen).
			if (!current && !last.dropId && !last.lookedAtDrop && !last.droppedAt && point(dropAt)) {
				last.lookedAtDrop = true;
				const end = await act('look_at', { x: dropAt.x, y: dropAt.y - 1, z: dropAt.z });
				if (end) return end;
				dropAt = last.droppedAt ?? last.estimatedDrop;
				current = visibleDrop();
			}
			// Out of view (it fell behind a rise or into grass): walk once to where it dropped and look, when that is near.
			// A walk there that fails is not the end of the search: the eye is then named as left behind.
			// Not for an item already tracked by id (gone from view means taken or despawned), nor from where it dropped.
			const gap = point(dropAt) ? Math.hypot(dropAt.x - o.player.x, dropAt.z - o.player.z) : Infinity;
			if (!current && !last.dropId && !last.searchedDrop && gap > 4 && gap <= DROP_SEARCH_BLOCKS) {
				last.searchedDrop = true;
				const end = await act('travel_to', bounded({ x: dropAt.x, z: dropAt.z, tolerance: last.droppedAt ? 1 : 2, build: true }));
				if (end && end.reasonCode !== 'FIND_BLOCKED') return end;
				if (Number.isFinite(last.eyesAfter) && eyesHeld(o) > last.eyesAfter) continue;
				current = visibleDrop();
			}
			// Standing where it dropped and still not in view: look up (it came to rest on leaves or a ledge above the walk;
			// live eye rooms: eyes lay 8 and 12 blocks above the search point), then down into a dip, as a player looks around.
			if (!current && last.searchedDrop && !last.lookedAround && point(dropAt)) {
				last.lookedAround = true;
				for (const dy of [5, -2]) {
					const end = await act('look_at', { x: dropAt.x, y: dropAt.y + dy, z: dropAt.z });
					if (end) return end;
					current = visibleDrop();
					if (current) break;
				}
			}
			// A drop it saw land and cannot pick out now (in grass, at its feet): step onto the spot, as a player walks over an
			// item to take it (eye rooms: a seen drop 2 blocks off was named left behind and still lay there at the end).
			const landed = last.droppedAt;
			if (!current && point(landed) && !last.steppedOn && Math.hypot(landed.x - o.player.x, landed.z - o.player.z) <= 4) {
				last.steppedOn = true;
				const end = await act('move_to', { x: landed.x, y: Math.abs(landed.y - o.player.y) <= 2 ? landed.y : o.player.y, z: landed.z, tolerance: 0.5, sprint: false });
				if (end && end.reasonCode !== 'FIND_BLOCKED') return end;
				if (Number.isFinite(last.eyesAfter) && eyesHeld(o) > last.eyesAfter) continue;
				current = visibleDrop();
			}
			if (!current) {
				last.recovery = last.searchedDrop ? 'not_found' : 'not_visible';
				state.phase = 'leg';
				continue;
			}
			last.dropId = current.stableId;
			const end = await act('travel_to', bounded({ x: current.x, y: current.y, z: current.z, tolerance: 1, build: true }));
			const reach = () => Math.hypot(current.x - o.player.x, current.z - o.player.z);
			if (end && end.reasonCode !== 'FIND_BLOCKED') return end;
			// A walk to the eye that fails leaves the eye behind and the find goes on along its heading, as a player gives up
			// on an eye that fell where they cannot get to (eye rooms: walks to a seen drop a block down or on leaves above
			// ended NO_ROUTE and CAVE_OPENING and handed back the whole find). Close by, it first steps onto the spot once.
			// A pickup that fails with the eye in view still hands back, so the next find retries it.
			const leave = () => {
				last.eyesAfterPickup = eyesHeld(o);
				if (!(Number.isFinite(last.eyesAfter) && eyesHeld(o) > last.eyesAfter)) last.recovery = 'not_reached';
				state.phase = 'leg';
			};
			if (end && reach() > 4) { leave(); continue; }
			let drop = visibleDrop(), failed = null;
			// Arrived and the eye neither came to hand nor stays in view (it lies a block below the feet, in a dip or water):
			// step onto it, as a player walks over an item (eye rooms: 5 of 13 lost eyes were walked to and left there).
			if ((end || !drop) && eyesHeld(o) <= last.eyesAfter && !last.steppedOn && reach() <= 4) {
				last.steppedOn = true;
				const at = drop ?? current;
				const stepped = await act('move_to', { x: at.x, y: Math.abs(at.y - o.player.y) <= 2 ? at.y : o.player.y, z: at.z, tolerance: 0.5, sprint: false });
				if (stepped && stepped.reasonCode !== 'FIND_BLOCKED') return stepped;
				drop = visibleDrop();
			}
			if (end) { leave(); continue; }
			if (drop?.stableId && eyesHeld(o) <= last.eyesAfter) {
				failed = await act('pick_up_item', { targetSelector: drop.stableId });
				if (failed && failed.reasonCode !== 'FIND_BLOCKED') return failed;
				drop = visibleDrop();
			}
			// The pickup failed with the eye still in view (it rolled or fell into a hole): walk to where it is now and try once more.
			if (failed && drop?.stableId && eyesHeld(o) <= last.eyesAfter) {
				const end = await act('travel_to', bounded({ x: drop.x, y: drop.y, z: drop.z, tolerance: 1, build: true }));
				if (end && end.reasonCode !== 'FIND_BLOCKED') return end;
				if (end) { leave(); continue; }
				if (eyesHeld(o) <= last.eyesAfter && visibleDrop()) {
					failed = await act('pick_up_item', { targetSelector: drop.stableId });
					if (failed && failed.reasonCode !== 'FIND_BLOCKED') return failed;
				}
			}
			// Still not regained after a failed pickup: hand back in the recovery phase, so the next find tries it again.
			if (failed && eyesHeld(o) <= last.eyesAfter) return failed;
			last.eyesAfterPickup = eyesHeld(o);
			state.phase = 'leg';
			continue;
		}
		if (state.phase === 'leg') {
			// Two throws that cross well place the stronghold: stop throwing, walk to the crossing and dig down there.
			if (state.estimateTrusted && !state.estimateRejected && point({ ...state.estimate, y: 0 }) && eyeLeg(last, state.throws.length) !== 0) {
				const near = () => Math.hypot(state.estimate.x - o.player.x, state.estimate.z - o.player.z) <= ESTIMATE_DIG_BLOCKS;
				if (!near()) {
					const end = await act('travel_to', bounded({ x: state.estimate.x, z: state.estimate.z, build: true, tolerance: 3 }), { soft: true });
					if (end) return end;
				}
				if (near()) { state.phase = 'dig'; state.digAt = { ...state.estimate }; }
				continue;
			}
			state.bracket = eyeBracket(state.bracket, state.throws.at(-2), last) ?? state.bracket;
			if (state.bracket && eyeLeg(last, state.throws.length) !== 0) {
				const { a, b } = state.bracket, middle = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
				const end = await act('travel_to', bounded({ ...middle, build: true, tolerance: 2 }), { soft: true });
				if (end) return end;
				state.phase = Math.hypot(a.x - b.x, a.z - b.z) <= 24 ? 'dig' : 'throw';
				continue;
			}
			const distance = eyeLeg(last, state.throws.length);
			if (distance === 0) {
				if (point(last.to)) {
					const end = await act('travel_to', bounded({ x: last.to.x, z: last.to.z, tolerance: 2, build: true }));
					if (end) return end;
				}
				state.phase = 'dig'; continue;
			}
			if (!Number.isFinite(last.yaw)) return finish('FIND_BLOCKED', 'Eye heading not observed');
			const d = direction(last.yaw);
			state.destination ??= { x: last.from.x + d.x * distance, z: last.from.z + d.z * distance };
			const end = await act('travel_to', bounded({ ...state.destination, build: true, tolerance: 3 }), { soft: true });
			if (end) return end;
			delete state.destination;
			state.phase = 'throw';
			continue;
		}
		if (state.phase === 'dig') {
			if (o.player.y <= -54) {
				// A crossing that led nowhere is dropped: the next find climbs to open sky and throws again.
				if (state.digAt) { state.estimateRejected = true; delete state.digAt; state.phase = 'throw'; }
				return finish('FIND_NOT_FOUND', 'Staircase reached y-54 without stronghold blocks');
			}
			const before = o.player.y;
			const end = await act('dig_to', bounded({ pattern: 'stairs_down', heading: state.digWest ? 'west' : 'east', y: Math.max(-54, Math.floor(before) - 8), maxBlocks: 32,
				throughCaves: 'small', stopWhenSeen: 'minecraft:stone_bricks', discard }));
			if (end) return end;
			state.digWest = !state.digWest;
			if (o.player.y >= before - 1) return finish('FIND_BLOCKED', 'Staircase made no downward progress');
			continue;
		}
		if (o.player.skyOpen !== true) {
			const sky = body.openSky?.();
			const before = o.player.y;
			const end = sky && Math.hypot(sky.x - o.player.x, sky.z - o.player.z) > 3
				? await act('travel_to', bounded({ ...sky, retrace: true, build: true, tolerance: 2 }))
				: await act('dig_to', bounded({ pattern: 'stairs_up', y: Math.floor(before) + 16, maxBlocks: 64, throughCaves: 'small', discard }));
			if (end) return end;
			if (o.player.skyOpen !== true && o.player.y <= before) return finish('FIND_BLOCKED', 'Open sky not reached');
			continue;
		}
		if (state.throws.length >= (target.throwCap ?? 8)) return finish('FIND_BUDGET', 'Throw cap reached');
		if (eyesHeld(o) < 1 || (target.allowEyeReserveUse !== true && eyesHeld(o) - 1 < reserve())) return finish('FIND_BLOCKED', 'Eye reserve reached');
		const eye = (o.inventory?.items ?? []).find(r => r.itemId === EYE && r.count > 0);
		const end = await act(Number.isInteger(eye.slot) && eye.slot >= 9 ? 'select_tool' : 'select_item', Number.isInteger(eye.slot) && eye.slot >= 9
			? { sourceSlot: eye.slot, hotbarSlot: o.inventory.selectedSlot ?? 0, expectedItemId: EYE, minRemainingDurability: 0 } : { itemId: EYE });
		if (end) return end;
		// Face the way the last eye flew, a little up, so this one flies into view from the hand.
		const previous = state.throws.at(-1);
		if (Number.isFinite(previous?.yaw)) {
			const faced = await act('control', { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false,
				yaw: previous.yaw, pitch: -20, selectedSlot: o.inventory.selectedSlot ?? 0, hand: 'main', ticks: 2 });
			if (faced) return faced;
		}
		if (left() < 1000) return finish('FIND_BUDGET', 'timeoutMs exhausted before throw');
		state.scanTurns = 0;
		state.eyeWaits = 0;
		state.beforeFlights = flights(o).map(e => e.flightId ?? e.sequence);
		state.throws.push({ from: { x: o.player.x, y: o.player.y, z: o.player.z } });
		state.phase = 'flight';
		state.waited = false;
		const thrown = await act('use_item', { expectedItemId: EYE, mode: 'once', hand: 'main', durationMs: Math.min(250, left()) });
		state.throws.at(-1).eyesAfter = eyesHeld(o);
		body.progress?.({ label: `Eye throw ${state.throws.length}: ${eyesHeld(o)} eyes held` });
		if (thrown) return thrown;
	}
	return finish('FIND_BUDGET', 'timeoutMs exhausted');
}
