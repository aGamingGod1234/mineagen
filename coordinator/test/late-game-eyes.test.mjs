import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFor } from '../src/find-search.mjs';
import { DROP_SEARCH_BLOCKS, trustedCross } from '../src/find-eyes.mjs';
import { EYE_PLAN, FRAME_EYES, PEARL_PLAN, ROD_PLAN } from '../src/eye-plan.mjs';
import { planObtain } from '../src/obtain-plan.mjs';
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
	assert.equal(b.calls.at(-1).args.pattern, 'stairs_down');
	assert.equal(eyesHeld(b), 14);
});

test('a crossing that leads nowhere is dropped: the next find climbs and throws again', async () => {
	let legs = 0;
	const b = body({ onAct: (type, args, o) => {
		if (type === 'travel_to' && ++legs === 1) { o.player.x = args.x; o.player.z = args.z + 60; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
		// No stronghold under the crossing: the staircase finds nothing.
		if (type === 'dig_to' && args.pattern === 'stairs_down') { o.player.y = args.y; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
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
	const after = b.calls.slice(b.calls.findLastIndex(c => c.type === 'dig_to' && c.args.pattern === 'stairs_down') + 1);
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
