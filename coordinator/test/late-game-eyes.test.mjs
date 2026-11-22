import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFor } from '../src/find-search.mjs';
import { DROP_SEARCH_BLOCKS, trustedCross } from '../src/find-eyes.mjs';
import { EYE_PLAN, FRAME_EYES, PEARL_PLAN, ROD_PLAN } from '../src/eye-plan.mjs';
import { planObtain } from '../src/obtain-plan.mjs';
import { routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

// The late-game contract, part A: eye margin, eye pickup and stop-throwing (wall-breakers late-game-contract.md).
const STRONGHOLD = { x: 300, z: 120 };
const yawTo = (from, to) => Math.atan2(-(to.x - from.x), to.z - from.z) * 180 / Math.PI;
const EYE_ID = '00000000-0000-4000-8000-0000000000e1';

/** A body whose thrown eyes fly toward STRONGHOLD from wherever it stands; `flight` overrides fields of each flight. */
function body({ eyes = 16, flight = () => ({}), onAct = () => null } = {}) {
	let clock = 0, flights = 0;
	const o = { player: { x: 0, y: 70, z: 0, health: 20, skyOpen: true, threats: [] }, world: { dimension: 'minecraft:overworld' },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:ender_eye', count: eyes, slot: 0 }] }, perception: { events: [] }, blocks: [], items: [] };
	const calls = [];
	const b = { calls, o, eyeSearchState: {}, now: () => clock, observe: async () => structuredClone(o), look: async () => ({ survey: {} }), progress: () => {},
		act: async (type, args, options) => {
			normalizeMinecraftToolCall('act', { actionType: type, arguments: args });
			calls.push({ type, args }); clock += ['control', 'look_at'].includes(type) ? 100 : 1000;
			const custom = onAct(type, args, o, calls);
			if (custom) return custom;
			if (type === 'use_item') o.inventory.items[0].count--;
			if (type === 'wait') {
				const from = { x: o.player.x, y: o.player.y, z: o.player.z };
				o.perception.events.push({ type: 'eye_of_ender_flight', flightId: ++flights, sequence: flights, from, to: { x: from.x, y: 75, z: from.z }, yaw: Math.round(yawTo(from, STRONGHOLD) * 10) / 10,
					vertical: 'rose', flewBlocks: 12, outcome: 'shattered', ...flight(flights, from) });
			}
			if (type === 'travel_to') { o.player.x = args.x ?? o.player.x; o.player.z = args.z ?? o.player.z; }
			if (type === 'dig_to') {
				o.player.y = args.y;
				if (args.pattern === 'stairs_up') o.player.skyOpen = true;
				else if (Math.hypot(o.player.x - STRONGHOLD.x, o.player.z - STRONGHOLD.z) <= 40) o.blocks = [{ blockId: 'minecraft:stone_bricks', x: o.player.x, y: args.y, z: o.player.z }];
			}
			if (type === 'pick_up_item') o.inventory.items[0].count++;
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED', ...(options?.watch?.(o) ? { seen: options.watch(o) } : {}) };
		},
	};
	return b;
}
const eyesHeld = b => b.o.inventory.items[0].count;

test('the eye plan gathers a margin over the frame: 15 eyes, 8 rods, 15 pearls', () => {
	assert.equal(FRAME_EYES, 12);
	assert.ok(EYE_PLAN >= 14 && EYE_PLAN <= 16);
	assert.equal(ROD_PLAN, 8);
	assert.ok(ROD_PLAN * 2 >= EYE_PLAN);
	assert.equal(PEARL_PLAN, EYE_PLAN);
});

test('obtain kill ways follow the current dimension, only the eye hunts away from the Overworld', () => {
	assert.deepEqual(planObtain({ ids: ['blaze_rod'], count: 8 }, { dimension: 'minecraft:the_nether' }).needs.map(n => n.mobs), [['blaze']]);
	assert.deepEqual(planObtain({ ids: ['ender_pearl'], count: 3 }, { dimension: 'minecraft:the_nether' }).needs.map(n => n.mobs), [['enderman']]);
	assert.deepEqual(planObtain({ ids: ['blaze_rod'], count: 1 }, { dimension: 'minecraft:overworld' }).unreachable, ['blaze_rod']);
	assert.deepEqual(planObtain({ ids: ['beef'], count: 1 }, { dimension: 'minecraft:the_nether' }).unreachable, ['beef']);
	assert.deepEqual(planObtain({ ids: ['beef'], count: 1 }, { dimension: 'minecraft:overworld' }).needs.map(n => n.mobs), [['cow']]);
	// Coal or gold in the Nether never becomes a wither skeleton, ghast or piglin hunt.
	for (const id of ['coal', 'gunpowder', 'gold_ingot']) {
		const mobs = planObtain({ ids: [id], count: 1 }, { dimension: 'minecraft:the_nether' }).needs.flatMap(n => n.mobs);
		assert.deepEqual(mobs.filter(m => !['blaze', 'enderman'].includes(m)), [], id);
	}
});

test('trusted crossing needs a real baseline and angle', () => {
	assert.equal(trustedCross({ from: { x: 0, y: 0, z: 0 }, yaw: -45 }, { from: { x: 100, y: 0, z: 0 }, yaw: 45 }), true);
	assert.equal(trustedCross({ from: { x: 0, y: 0, z: 0 }, yaw: -45 }, { from: { x: 10, y: 0, z: 0 }, yaw: 45 }), false, 'baseline under 24 blocks');
	assert.equal(trustedCross({ from: { x: 0, y: 0, z: 0 }, yaw: -60 }, { from: { x: 0, y: 0, z: 100 }, yaw: -63 }), false, 'crossing under 8 degrees');
	assert.equal(trustedCross({ from: { x: 0, y: 0, z: 0 }, yaw: -45 }, { from: { x: 100, y: 0, z: 0 }, yaw: -45 }), false, 'parallel');
});

test('two throws that cross well stop the throwing: walk to the crossing and dig down there', async () => {
	// The first leg ends 60 blocks off the line (a detour), so the second throw's heading crosses the first.
	let legs = 0;
	const b = body({ onAct: (type, args, o) => {
		if (type === 'travel_to' && ++legs === 1) { o.player.x = args.x; o.player.z = args.z + 60; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
		return null;
	} });
	const r = await searchFor({ structure: 'stronghold', throwCap: 6 }, b);
	assert.equal(r.reasonCode, 'FIND_SEEN');
	assert.equal(b.calls.filter(c => c.type === 'use_item').length, 2, 'no third throw once two cross');
	const toEstimate = b.calls.filter(c => c.type === 'travel_to')[1].args;
	assert.ok(Math.hypot(toEstimate.x - STRONGHOLD.x, toEstimate.z - STRONGHOLD.z) <= 3, JSON.stringify(toEstimate));
	assert.equal(b.calls.at(-1).type, 'dig_to');
	assert.equal(b.calls.at(-1).args.pattern, 'steep_down');
	assert.equal(eyesHeld(b), 14);
});

test('a crossing that leads nowhere is dropped: the next find climbs and throws again', async () => {
	let legs = 0;
	const b = body({ onAct: (type, args, o) => {
		if (type === 'travel_to' && ++legs === 1) { o.player.x = args.x; o.player.z = args.z + 60; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
		// No stronghold under the crossing: the staircase finds nothing.
		if (type === 'dig_to' && args.pattern === 'steep_down') { o.player.y = args.y; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
		if (type === 'dig_to') { o.player.y = args.y; o.player.skyOpen = true; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
		return null;
	} });
	b.o.player.skyOpen = true;
	const first = await searchFor({ structure: 'stronghold', throwCap: 6 }, b);
	assert.equal(first.reasonCode, 'FIND_NOT_FOUND');
	assert.equal(b.eyeSearchState.estimateRejected, true);
	assert.equal(b.eyeSearchState.phase, 'throw');
	const throws = b.calls.filter(c => c.type === 'use_item').length;
	b.o.player.skyOpen = false;
	await searchFor({ structure: 'stronghold', throwCap: 6 }, b);
	const after = b.calls.slice(b.calls.findLastIndex(c => c.type === 'dig_to' && c.args.pattern === 'steep_down') + 1);
	assert.ok(b.calls.some(c => c.type === 'dig_to' && c.args.pattern === 'stairs_up'), 'climbs back to open sky');
	assert.ok(b.calls.filter(c => c.type === 'use_item').length > throws, 'throws again');
	assert.ok(after.length >= 0);
});

test('an eye that dropped out of view nearby is searched for once and picked up', async () => {
	const b = body({ flight: () => ({ outcome: 'dropped', droppedAt: { x: -12, y: 70, z: 0 } }), onAct: (type, args, o) => {
		if (type === 'travel_to' && args.x === -12 && args.y === undefined) { o.player.x = -12; o.player.z = 0; o.items = [{ itemId: 'minecraft:ender_eye', stableId: EYE_ID, x: -12.3, y: 64, z: 0.2 }]; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
		if (type === 'pick_up_item') { o.items = []; o.inventory.items[0].count++; return { state: 'SUCCEEDED', reasonCode: 'PICKED_UP' }; }
		return null;
	} });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(r.find.eyes.throws[0].eyesAfterPickup, 16);
	assert.equal(b.calls.filter(c => c.type === 'pick_up_item').length, 1);
	assert.equal(r.find.eyes.eyesLeftBehind, undefined);
});

test('an out-of-view drop farther than the search radius is not walked to', async () => {
	const far = DROP_SEARCH_BLOCKS + 6;
	const b = body({ flight: () => ({ outcome: 'dropped', droppedAt: { x: -far, y: 70, z: 0 } }) });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(r.find.eyes.throws[0].recovery, 'not_visible');
	assert.equal(b.calls.some(c => c.type === 'travel_to' && c.args.x === -far), false);
});

test('an eye not found where it dropped is named as left behind and the search goes on', async () => {
	const b = body({ flight: () => ({ outcome: 'dropped', droppedAt: { x: -12, y: 70, z: 0 } }) });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	const t = r.find.eyes.throws[0];
	assert.equal(t.recovery, 'not_found');
	assert.equal(t.searchedDrop, true);
	assert.deepEqual(r.find.eyes.eyesLeftBehind, [{ x: -12, y: 70, z: 0 }]);
	assert.match(r.message, /eye left at -12,70,0/);
	assert.equal(b.calls.filter(c => c.type === 'travel_to' && c.args.x === -12).length, 1, 'searched once');
	assert.ok(b.calls.filter(c => c.type === 'travel_to').length >= 2, 'the bearing leg follows');
});

test('the recovery walk stops for danger', async () => {
	const b = body({ flight: () => ({ outcome: 'dropped', droppedAt: { x: -12, y: 70, z: 0 } }), onAct: (type, args, o) => {
		if (type === 'travel_to' && args.x === -12) { o.player.health = 6; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
		return null;
	} });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(r.reasonCode, 'FIND_DANGER');
	assert.equal(b.calls.at(-1).type, 'travel_to');
});

test('a failed pickup walks to where the eye lies now and tries once more', async () => {
	let pickups = 0;
	const b = body({ flight: () => ({ outcome: 'dropped', droppedAt: { x: -12, y: 64, z: 0 } }), onAct: (type, args, o) => {
		// The first pickup fails: the eye rolled into a hole below.
		if (type === 'pick_up_item' && ++pickups === 1) { o.items[0].y = 61; return { state: 'FAILED', reasonCode: 'PATH_BLOCKED' }; }
		if (type === 'pick_up_item') { o.items = []; o.inventory.items[0].count++; return { state: 'SUCCEEDED', reasonCode: 'PICKED_UP' }; }
		return null;
	} });
	b.o.items = [{ itemId: 'minecraft:ender_eye', stableId: EYE_ID, x: -12, y: 64, z: 0 }];
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(r.find.eyes.throws[0].eyesAfterPickup, 16);
	assert.equal(pickups, 2);
	assert.ok(b.calls.some(c => c.type === 'travel_to' && c.args.y === 61), 'walked to where it lies now');
	assert.notEqual(r.reasonCode, 'FIND_BLOCKED');
});

test('a pickup that fails twice hands back in the recovery phase, so the next find tries again', async () => {
	const b = body({ flight: () => ({ outcome: 'dropped', droppedAt: { x: -12, y: 64, z: 0 } }), onAct: type => type === 'pick_up_item' ? { state: 'FAILED', reasonCode: 'PATH_BLOCKED' } : null });
	b.o.items = [{ itemId: 'minecraft:ender_eye', stableId: EYE_ID, x: -12, y: 64, z: 0 }];
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(r.reasonCode, 'FIND_BLOCKED');
	assert.equal(b.calls.filter(c => c.type === 'pick_up_item').length, 2);
	assert.equal(b.eyeSearchState.phase, 'recover');
});

test('an eye lost from view is searched for 12 blocks along its heading, where vanilla drops it', async () => {
	const b = body({ flight: () => ({ outcome: 'unseen', lostFromView: true, flewBlocks: undefined }), onAct: (type, args, o) => {
		if (type === 'travel_to' && args.y === undefined && Math.abs(Math.hypot(args.x, args.z) - 12) < 0.01) {
			o.player.x = args.x; o.player.z = args.z;
			o.items = [{ itemId: 'minecraft:ender_eye', stableId: EYE_ID, x: args.x + 1, y: 66, z: args.z }];
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
		}
		if (type === 'pick_up_item') { o.items = []; o.inventory.items[0].count++; return { state: 'SUCCEEDED', reasonCode: 'PICKED_UP' }; }
		return null;
	} });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	const t = r.find.eyes.throws[0];
	assert.ok(t.estimatedDrop, 'an estimated drop point');
	assert.equal(t.eyesAfterPickup, 16);
	assert.equal(b.calls.filter(c => c.type === 'pick_up_item').length, 1);
});

test('an eye lost from view and not found at its estimated drop is named as left behind', async () => {
	const b = body({ flight: () => ({ outcome: 'unseen', lostFromView: true }) });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(r.find.eyes.throws[0].recovery, 'not_found');
	assert.equal(r.find.eyes.eyesLeftBehind.length, 1);
});

test('the Overworld crafts the margin it brought home, not only the 12 the frame needs', () => {
	const known = emptyKnown(); known.visitedDimensions.push('minecraft:the_nether');
	const route = (items) => routeLine({ observation: { ready: true, observedAtEpochMs: 10, world: { worldId: 'w', dimension: 'minecraft:overworld' }, position: { x: 0, y: 64, z: 0 },
		player: { health: 20, foodLevel: 20 }, inventory: { items: [['iron_pickaxe', 1], ['cooked_beef', 16], ...items].map(([id, count]) => ({ itemId: `minecraft:${id}`, count })) }, entities: [], blocks: [] },
		known, evaluate: evaluatePlanCheck });
	assert.match(route([['blaze_rod', 8], ['ender_pearl', 15]]), /^usual next step: craft 15 ender_eyes/);
	assert.match(route([['blaze_rod', 7], ['ender_pearl', 12]]), /^usual next step: craft 12 ender_eyes/);
	assert.match(route([['blaze_rod', 7], ['ender_pearl', 13]]), /^usual next step: craft 13 ender_eyes/);
	// Twelve made, makings for three more held: those too, before the search.
	assert.match(route([['ender_eye', 12], ['ender_pearl', 3], ['blaze_powder', 4]]), /^usual next step: craft 3 spare ender_eyes/);
	assert.match(route([['ender_eye', 15], ['ender_pearl', 1], ['blaze_powder', 1]]), /^usual next step: find structure stronghold/);
	assert.match(route([['ender_eye', 12]]), /^usual next step: find structure stronghold/);
});

test('a receipt that turns from unseen to dropped during the search walk is followed to where it dropped', async () => {
	let walked = false;
	const b = body({ flight: () => ({ outcome: 'unseen', lostFromView: true }), onAct: (type, args, o) => {
		if (type === 'travel_to' && !walked && args.y === undefined && Math.abs(Math.hypot(args.x, args.z) - 12) < 0.01) {
			walked = true;
			o.player.x = args.x; o.player.z = args.z;
			// The eye came back in sight on the walk: its receipt now says where it dropped, 8 blocks past the estimate.
			const flight = o.perception.events.at(-1);
			const droppedAt = { x: flight.from.x + (args.x - flight.from.x) * 20 / 12, y: 66, z: flight.from.z + (args.z - flight.from.z) * 20 / 12 };
			o.perception.events.push({ ...flight, sequence: flight.sequence + 100, outcome: 'dropped', droppedAt });
			o.items = [{ itemId: 'minecraft:ender_eye', stableId: EYE_ID, ...droppedAt }];
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
		}
		if (type === 'pick_up_item') { o.items = []; o.inventory.items[0].count++; return { state: 'SUCCEEDED', reasonCode: 'PICKED_UP' }; }
		return null;
	} });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(r.find.eyes.throws[0].outcome, 'dropped');
	assert.equal(r.find.eyes.throws[0].eyesAfterPickup, 16);
});

test('a thrown eye is watched along its heading, never at the hand where it starts', async () => {
	const b = body({ eyes: 16, onAct: (type, args, o) => {
		const eye = (o.entities ?? [])[0];
		if (type === 'use_item') {
			o.inventory.items[0].count--;
			// The first sample after the throw sees the eye at the hand, on the body itself.
			o.entities = [{ type: 'minecraft:eye_of_ender', x: o.player.x, y: o.player.y + 0.9, z: o.player.z }];
			return { state: 'SUCCEEDED', reasonCode: 'USE_INPUT_CONFIRMED' };
		}
		if (type === 'wait' && args.durationMs === 100 && eye) {
			const d = Math.hypot(STRONGHOLD.x, STRONGHOLD.z);
			eye.x += 0.5 * STRONGHOLD.x / d; eye.z += 0.5 * STRONGHOLD.z / d;
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		}
		if (type === 'wait') o.entities = [];
		return null;
	} });
	await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	const look = b.calls.find(c => c.type === 'look_at');
	assert.ok(look, 'the body turns to watch the flight');
	const out = Math.hypot(look.args.x, look.args.z);
	assert.ok(out > 8, `looks well ahead of the hand, not at it (${out.toFixed(1)} blocks)`);
	assert.ok(Math.abs(yawTo({ x: 0, z: 0 }, look.args) - yawTo({ x: 0, z: 0 }, STRONGHOLD)) < 2, 'along the eye heading');
	assert.ok(look.args.y > 72, 'above the throw height, where the eye flies and drops');
	assert.ok(b.calls.findIndex(c => c.type === 'wait' && c.args.durationMs === 100) < b.calls.indexOf(look), 'waits for the eye to leave the hand first');
});

test('the next throw faces the way the last eye flew, a little up', async () => {
	const b = body({ eyes: 16 });
	await searchFor({ structure: 'stronghold', throwCap: 2 }, b);
	const throws = b.calls.map((c, i) => [c, i]).filter(([c]) => c.type === 'use_item').map(([, i]) => i);
	assert.equal(throws.length, 2);
	const facing = b.calls.slice(throws[0], throws[1]).filter(c => c.type === 'control').at(-1);
	assert.ok(facing, 'turns before the second throw');
	assert.ok(Math.abs(facing.args.yaw - yawTo({ x: 0, z: 0 }, STRONGHOLD)) < 0.2);
	assert.ok(facing.args.pitch < 0, 'looks up');
	assert.equal(b.calls.slice(0, throws[0]).some(c => c.type === 'control' && c.args.pitch === -20), false, 'no heading to face before the first throw');
});

test('an eye lost from view is looked for where it should drop before any walk, and a drop seen there is picked up', async () => {
	let looked = false;
	const b = body({ flight: () => ({ outcome: 'unseen', lostFromView: true, flewBlocks: undefined }), onAct: (type, args, o) => {
		if (type === 'look_at' && !looked && Math.abs(Math.hypot(args.x, args.z) - 12) < 0.01) {
			looked = true;
			const flight = o.perception.events.at(-1);
			const droppedAt = { x: args.x, y: 69, z: args.z };
			o.perception.events.push({ ...flight, sequence: flight.sequence + 100, outcome: 'dropped', droppedAt });
			o.items = [{ itemId: 'minecraft:ender_eye', stableId: EYE_ID, ...droppedAt }];
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		}
		if (type === 'pick_up_item') { o.items = []; o.inventory.items[0].count++; return { state: 'SUCCEEDED', reasonCode: 'PICKED_UP' }; }
		return null;
	} });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.ok(looked, 'looks at the estimated drop');
	const lookAt = b.calls.findIndex(c => c.type === 'look_at' && Math.abs(Math.hypot(c.args.x, c.args.z) - 12) < 0.01);
	const firstWalk = b.calls.findIndex(c => c.type === 'travel_to');
	assert.ok(firstWalk === -1 || lookAt < firstWalk, 'the look comes before any walk');
	assert.equal(r.find.eyes.throws[0].outcome, 'dropped');
	assert.equal(r.find.eyes.throws[0].eyesAfterPickup, 16);
	assert.equal(r.find.eyes.throws[0].searchedDrop, undefined, 'no blind search walk was needed');
});

test('standing where a lost eye should lie and not seeing it, the body looks up into the leaves above before giving it up', async () => {
	let shown = false;
	const b = body({ flight: () => ({ outcome: 'unseen', lostFromView: true, flewBlocks: undefined }), onAct: (type, args, o) => {
		// The eye rests on leaves 8 blocks above where it should have dropped: only a look up shows it.
		if (type === 'look_at' && !shown && args.y >= o.player.y + 4 && Math.hypot(args.x - o.player.x, args.z - o.player.z) < 4) {
			shown = true;
			o.items = [{ itemId: 'minecraft:ender_eye', stableId: EYE_ID, x: args.x, y: 78, z: args.z }];
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		}
		if (type === 'pick_up_item') { o.items = []; o.inventory.items[0].count++; return { state: 'SUCCEEDED', reasonCode: 'PICKED_UP' }; }
		return null;
	} });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.ok(shown, 'looked up at the drop point after the search walk');
	assert.equal(r.find.eyes.throws[0].eyesAfterPickup, 16);
	assert.notEqual(r.find.eyes.throws[0].recovery, 'not_found');
	const climb = b.calls.find(c => c.type === 'travel_to' && c.args.y === 78);
	assert.ok(climb, 'walks (and builds) up to where it lies');
});

test('a drop seen landing but not picked out after the walk is stepped onto, which collects it', async () => {
	const b = body({ flight: (n, from) => ({ outcome: 'dropped', droppedAt: { x: from.x + 12, y: 70, z: from.z } }), onAct: (type, args, o) => {
		// Hidden in grass: never in the item list; walking over the cell collects it.
		if (type === 'move_to') {
			o.player.x = args.x; o.player.z = args.z;
			if (args.tolerance <= 0.5) o.inventory.items[0].count++;
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
		}
		return null;
	} });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	const step = b.calls.find(c => c.type === 'move_to');
	assert.ok(step, 'steps onto where it landed');
	assert.equal(step.args.x, 12);
	assert.equal(r.find.eyes.throws[0].eyesAfterPickup, 16);
	assert.equal(r.find.eyes.eyesLeftBehind, undefined);
});

test('a seen eye walked to but lying a block below the feet is stepped onto, not left there', async () => {
	const b = body({ flight: (n, from) => ({ outcome: 'dropped', droppedAt: { x: from.x + 6, y: 69, z: from.z } }), onAct: (type, args, o) => {
		if (type === 'travel_to' && args.y !== undefined) {
			// Arrived beside it; from here it is out of view in the dip below.
			o.player.x = args.x - 0.8; o.player.z = args.z; o.items = [];
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
		}
		if (type === 'move_to') { o.player.x = args.x; o.player.z = args.z; if (args.tolerance <= 0.5 && args.y === 69) o.inventory.items[0].count++; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
		return null;
	} });
	// The drop is in view from the throw point.
	const realAct = b.act;
	b.act = async (type, args, options) => {
		const r = await realAct(type, args, options);
		if (type === 'wait' && args.durationMs > 1000) b.o.items = [{ itemId: 'minecraft:ender_eye', stableId: EYE_ID, x: 6, y: 69, z: 0 }];
		return r;
	};
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.ok(b.calls.some(c => c.type === 'move_to' && c.args.y === 69), 'steps down onto it');
	assert.equal(r.find.eyes.throws[0].eyesAfterPickup, 16);
});

// A villager or a door at eye level takes the use click: the receipt says the use was accepted, yet no eye leaves the hand
// and no flight follows. `taken` decides which use_item calls that happens to.
function takenBody(taken, options = {}) {
	let uses = 0, blockedNow = false;
	return body({ ...options, onAct: (type, args, o, calls) => {
		if (type === 'use_item') {
			blockedNow = taken(++uses);
			if (blockedNow) return { state: 'SUCCEEDED', reasonCode: 'USE_INPUT_CONFIRMED', message: 'Held use for 1 server ticks; accepted interactions=1' };
		}
		// No eye was thrown, so no flight is ever published.
		if (type === 'wait' && blockedNow) return { state: 'SUCCEEDED', reasonCode: 'WAITED' };
		return options.onAct?.(type, args, o, calls) ?? null;
	} });
}
const uses = b => b.calls.filter(c => c.type === 'use_item').length;

test('a throw whose use click a villager took is not a throw: it looks up past it and throws again', async () => {
	const b = takenBody(n => n === 1);
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(uses(b), 2, 'throws again in the same find');
	const between = b.calls.slice(b.calls.findIndex(c => c.type === 'use_item') + 1, b.calls.findLastIndex(c => c.type === 'use_item'));
	assert.ok(between.some(c => c.type === 'control' && c.args.pitch <= -60), 'looks well up before the second try');
	assert.equal(r.find.eyes.throwsMade, 1, 'the taken click is not counted as a throw');
	assert.equal(r.find.eyes.throws[0].eyesAfter, 15);
	assert.equal(Number.isFinite(r.find.eyes.throws[0].yaw), true, 'the real throw has its heading');
	assert.doesNotMatch(r.message, /Eye flight not observed/);
});

test('a throw taken every time hands back in the throw phase, and the next find throws', async () => {
	let blocking = true;
	const b = takenBody(() => blocking);
	const first = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(first.reasonCode, 'FIND_BLOCKED');
	assert.match(first.message, /Eye not thrown/);
	assert.equal(b.eyeSearchState.phase, 'throw');
	assert.equal(b.eyeSearchState.throws.length, 0);
	assert.equal(uses(b), 3);
	assert.ok(b.calls.some(c => c.type === 'travel_to' && c.args.build === false), 'steps back from what took the click');
	assert.equal(eyesHeld(b), 16);
	blocking = false;
	const second = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(uses(b), 4, 'a later find throws');
	assert.equal(eyesHeld(b), 15);
	assert.equal(second.find.eyes.throwsMade, 1);
	assert.doesNotMatch(second.message, /Eye flight not observed/);
});

test('a use refused outright throws no eye and is tried again', async () => {
	let refused = 0;
	const b = body({ onAct: type => type === 'use_item' && ++refused === 1 ? { state: 'FAILED', reasonCode: 'USE_NOT_ACCEPTED' } : null });
	const r = await searchFor({ structure: 'stronghold', throwCap: 1 }, b);
	assert.equal(uses(b), 2);
	assert.equal(r.find.eyes.throwsMade, 1);
	assert.equal(eyesHeld(b), 15);
});

test('an eye that left the hand but was never seen in flight does not stop later finds from throwing', async () => {
	let unseen = true;
	const b = body({ onAct: type => type === 'wait' && unseen ? { state: 'SUCCEEDED', reasonCode: 'WAITED' } : null });
	const first = await searchFor({ structure: 'stronghold', throwCap: 2 }, b);
	assert.equal(first.reasonCode, 'FIND_BLOCKED');
	assert.match(first.message, /Eye flight not observed/);
	assert.equal(b.eyeSearchState.phase, 'throw');
	assert.equal(first.find.eyes.throwsMade, 1, 'the eye did leave the hand');
	unseen = false;
	await searchFor({ structure: 'stronghold', throwCap: 2 }, b);
	assert.equal(uses(b), 2, 'the next find throws again');
});
