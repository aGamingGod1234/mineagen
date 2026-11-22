import test from 'node:test';
import assert from 'node:assert/strict';
import { eyeBracket, eyeLeg, intersectEyes } from '../src/find-eyes.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { checkedSearchBody, searchFor } from './helpers/checked-body.mjs';
const flight = (extra = {}) => ({ type: 'eye_of_ender_flight', flightId: 17, from: { x: 0, y: 70, z: 0 }, to: { x: -12, y: 75, z: 0 }, yaw: 90, vertical: 'rose', flewBlocks: 12, outcome: 'shattered', ...extra });
function fake({ eyes = 16, event = flight(), skyOpen = true, filled = [] } = {}) {
	let clock = 0;
	const o = { player: { x: 0, y: 70, z: 0, health: 20, skyOpen, threats: [] }, world: { dimension: 'minecraft:overworld' },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:ender_eye', count: eyes, slot: 11 }] }, perception: { events: [] }, blocks: filled };
	const calls = [];
	const body = checkedSearchBody({ calls, o, eyeSearchState: {}, now: () => clock, observe: async () => structuredClone(o),
		look: async () => ({ survey: {} }), progress: () => {},
		act: async (type, args, options) => {
			calls.push({ type, args }); clock += ['control', 'look_at'].includes(type) ? 100 : 1000;
			if (type === 'use_item') { o.inventory.items[0].count--; }
			if (type === 'wait') o.perception.events.push(event);
			if (type === 'travel_to') { o.player.x = args.x ?? o.player.x; o.player.z = args.z ?? o.player.z; }
			if (type === 'dig_to') {
				o.player.y = args.y;
				if (args.pattern === 'stairs_up') o.player.skyOpen = true;
				else o.blocks = [{ blockId: 'minecraft:stone_bricks', x: 0, y: args.y, z: 0 }];
			}
			if (type === 'pick_up_item') o.inventory.items[0].count++;
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED', ...(options?.watch?.(o) ? { seen: options.watch(o) } : {}) };
		},
	});
	return body;
}
const target = { structure: 'stronghold', throwCap: 1 };
test('two nonparallel seen headings intersect ahead at the stronghold', () => {
	assert.deepEqual(intersectEyes({ from: { x: 0, z: 0 }, yaw: -45 }, { from: { x: 100, z: 0 }, yaw: 45 }), { x: 50, z: 50 });
	assert.equal(intersectEyes(flight(), flight()), null);
});
test('level eye shortens leg; incomplete short sighting never claims overhead', () => {
	assert.equal(eyeLeg(flight()), 120); assert.equal(eyeLeg(flight({ vertical: 'level' })), 24);
	assert.equal(eyeLeg(flight({ lostFromView: true, flewBlocks: 1 })), 120);
});
test('downward and nearly overhead eyes switch to staircase descent and stop at seen blocks', async () => {
	for (const event of [flight({ vertical: 'sank' }), flight({ flewBlocks: 1 })]) {
		const b = fake({ event }); const r = await searchFor(target, b);
		assert.equal(r.reasonCode, 'FIND_SEEN');
		assert.equal(b.calls.find(c => c.type === 'dig_to').args.pattern, 'steep_down');
		assert.equal(b.calls.some(c => c.args.pattern === 'shaft'), false);
	}
});
test('reserve keeps eleven, accounts for filled frames, and accepts explicit override', async () => {
	const twelve = fake({ eyes: 12 }); await searchFor(target, twelve);
	assert.equal(twelve.calls.filter(c => c.type === 'use_item').length >= 1, true, 'exactly 12 eyes may throw');
	const b = fake({ eyes: 11 }); assert.equal((await searchFor(target, b)).find.eyes.stoppedBy, 'Eye reserve reached');
	assert.equal(b.calls.length, 0);
	const override = fake({ eyes: 11 }); await searchFor({ ...target, allowEyeReserveUse: true }, override);
	assert.equal(override.calls.filter(c => c.type === 'use_item').length, 1);
	const filled = fake({ eyes: 12 }); filled.o.blocks = []; filled.known = () => ({ blocks: [{ blockId: 'minecraft:end_portal_frame', x: 1, y: 30, z: 1, blockState: '{"eye":"true"}' }] });
	await searchFor(target, filled); assert.equal(filled.calls.filter(c => c.type === 'use_item').length, 1);
});
test('walk to visible dropped eye and pick it up before travelling onward', async () => {
	const b = fake({ event: flight({ outcome: 'dropped', droppedAt: { x: -12, y: 70, z: 0 } }) });
	b.o.items = [{ itemId: 'minecraft:ender_eye', stableId: '00000000-0000-4000-8000-000000000001', x: -12, y: 70, z: 0 }];
	const r = await searchFor(target, b);
	assert.equal(r.find.eyes.eyesLeft, 16); assert.equal(r.find.eyes.throws[0].eyesAfterPickup, 16);
	assert.equal(b.calls.find(c => c.type === 'travel_to').args.x, -12);
	assert.ok(b.calls.find(c => c.type === 'pick_up_item'));
});
test('find flags normalize without adding a tool or verb', () => {
	const call = normalizeMinecraftToolCall('do_step', { verb: 'find', target: { ...target, allowEyeReserveUse: true }, why: 'stronghold' });
	assert.equal(call.arguments.throwCap, 1); assert.equal(call.arguments.allowEyeReserveUse, true);
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'find', target: { ...target, throwCap: 0 }, why: 'x' }));
});
test('unseen flight hands back unknown and never chooses a generic heading', async () => {
	const b = fake();
	const original = b.act;
	b.act = async (...args) => { const result = await original(...args); b.o.perception.events = []; return result; };
	const r = await searchFor(target, b);
	assert.equal(r.reasonCode, 'FIND_BLOCKED'); assert.match(r.message, /heading unknown/);
	assert.equal(b.calls.some(c => c.type === 'travel_to'), false);
});
test('stronghold route states the skill inside ROUTE_BYTES', async () => {
	const { routeLine, ROUTE_BYTES } = await import('../src/skill-fits.mjs');
	const b = fake(); b.o.inventory.items.push({ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:cooked_beef', count: 20 }, { itemId: 'minecraft:bow', count: 1 }, { itemId: 'minecraft:arrow', count: 32 });
	const line = routeLine({ observation: { ...b.o, ready: true, observedAtEpochMs: 10 }, known: {}, evaluate: () => ({ ok: true }) });
	assert.match(line, /find structure stronghold follows thrown eyes and digs down/);
	assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES);
});
test('eye collected during an interrupted recovery is recognized on the next find', async () => {
	const b = fake({ event: flight({ outcome: 'dropped', droppedAt: { x: -12, y: 70, z: 0 } }) });
	b.o.items = [{ itemId: 'minecraft:ender_eye', stableId: '00000000-0000-4000-8000-000000000001', x: -12, y: 70, z: 0 }];
	const original = b.act; let interrupted = false;
	b.act = async (...args) => {
		const r = await original(...args);
		if (args[0] === 'travel_to' && !interrupted) {
			interrupted = true; b.o.inventory.items[0].count++;
			return { state: 'FAILED', reasonCode: 'NO_ROUTE' };
		}
		return r;
	};
	// The blocked walk collected the eye: the find goes on, counts it back and never walks to that drop again.
	const r = await searchFor(target, b);
	assert.equal(r.reasonCode, 'FIND_BUDGET');
	assert.equal(r.find.eyes.throws[0].eyesAfterPickup, 16); assert.equal(r.find.eyes.eyesLeft, 16);
	assert.equal(b.calls.filter(c => c.type === 'travel_to' && c.args.x === -12).length, 1);
	assert.equal(b.calls.some(c => c.type === 'pick_up_item'), false);
});
test('a drop the body cannot reach is left behind and the find goes on along the heading', async () => {
	const b = fake({ event: flight({ outcome: 'dropped', droppedAt: { x: -12, y: 69, z: 0 } }) });
	b.o.items = [{ itemId: 'minecraft:ender_eye', stableId: '00000000-0000-4000-8000-000000000001', x: -12, y: 69, z: 0 }];
	const original = b.act;
	b.act = async (...args) => {
		if (args[0] === 'travel_to' && args[1].x === -12 && args[1].y === 69) { b.calls.push({ type: args[0], args: args[1] }); return { state: 'FAILED', reasonCode: 'NO_ROUTE' }; }
		return original(...args);
	};
	const r = await searchFor(target, b);
	assert.equal(r.reasonCode, 'FIND_BUDGET'); assert.equal(r.find.eyes.stoppedBy, 'Throw cap reached');
	assert.equal(r.find.eyes.throws[0].recovery, 'not_reached'); assert.equal(r.find.eyes.eyesLeft, 15);
	assert.equal(b.calls.some(c => c.type === 'pick_up_item'), false, 'no pickup from 12 blocks off');
	assert.ok(b.calls.some(c => c.type === 'travel_to' && c.args.x < -50), 'walks the next leg');
});
test('an eye on leaves above that neither the walk nor the pickup can reach is left behind after one step and one pickup try', async () => {
	const b = fake({ event: flight({ outcome: 'dropped', droppedAt: { x: -12, y: 74, z: 0 } }) });
	b.o.items = [{ itemId: 'minecraft:ender_eye', stableId: '00000000-0000-4000-8000-000000000001', x: -12, y: 74, z: 0 }];
	const original = b.act;
	b.act = async (...args) => {
		if (args[0] === 'travel_to' && args[1].y === 74) { b.calls.push({ type: args[0], args: args[1] }); b.o.player.x = -12; return { state: 'FAILED', reasonCode: 'CAVE_OPENING' }; }
		if (args[0] === 'pick_up_item') { b.calls.push({ type: args[0], args: args[1] }); return { state: 'FAILED', reasonCode: 'NO_SEEN_ROUTE' }; }
		return original(...args);
	};
	const r = await searchFor(target, b);
	assert.equal(r.reasonCode, 'FIND_BUDGET'); assert.equal(r.find.eyes.throws[0].recovery, 'not_reached');
	assert.equal(b.calls.filter(c => c.type === 'move_to').length, 1, 'one step onto the spot');
	assert.equal(b.calls.filter(c => c.type === 'pick_up_item').length, 1, 'the pickup by the eye id is tried once before leaving it');
	assert.equal(b.calls.find(c => c.type === 'travel_to' && c.args.y === 74).args.tolerance, 2, 'the walk goes near the eye, not into its cell');
});
test('an eye on leaves above that the walk falls short of is still picked up by its id', async () => {
	const b = fake({ event: flight({ outcome: 'dropped', droppedAt: { x: -12, y: 74, z: 0 } }) });
	b.o.items = [{ itemId: 'minecraft:ender_eye', stableId: '00000000-0000-4000-8000-000000000001', x: -12, y: 74, z: 0 }];
	const original = b.act;
	b.act = async (...args) => {
		if (args[0] === 'travel_to' && args[1].y === 74) { b.calls.push({ type: args[0], args: args[1] }); b.o.player.x = -12; return { state: 'FAILED', reasonCode: 'CAVE_OPENING' }; }
		return original(...args);
	};
	const r = await searchFor(target, b);
	assert.ok(b.calls.find(c => c.type === 'pick_up_item'), 'picked up by id after the walk fell short');
	assert.notEqual(r.find.eyes.throws[0].recovery, 'not_reached');
});
test('a leg out of blocks at water swims the rest, and a flooded tunnel backed out of after ground covered is a leg', async () => {
	const b = fake({ event: flight({ outcome: 'shattered' }) });
	const original = b.act;
	// A lake from x -1 to x -30: travel cannot bridge it with no blocks left; move_to swims across it at the surface.
	b.act = async (...args) => {
		if (args[0] === 'travel_to' && Math.abs(args[1].x) > 50 && b.o.player.x > -30) { b.calls.push({ type: args[0], args: args[1] }); return { state: 'FAILED', reasonCode: 'OUT_OF_BLOCKS' }; }
		if (args[0] === 'move_to') { b.calls.push({ type: args[0], args: args[1] }); b.o.player.x = args[1].x; b.o.player.inWater = b.o.player.x > -30; return { state: 'SUCCEEDED', reasonCode: 'DESTINATION_REACHED' }; }
		return original(...args);
	};
	const r = await searchFor(target, b);
	assert.equal(r.reasonCode, 'FIND_BUDGET', r.message);
	assert.equal(b.calls.filter(c => c.type === 'move_to').length, 4, 'swims 8-block hops until out of the water');
	assert.equal(b.calls.at(-1).type === 'travel_to' || b.calls.some(c => c.type === 'travel_to' && c.args.x === -120 && b.calls.indexOf(c) > b.calls.findIndex(m => m.type === 'move_to')), true);
	const flood = fake({ event: flight({ outcome: 'shattered' }) });
	const plain = flood.act;
	flood.act = async (...args) => {
		if (args[0] === 'travel_to' && Math.abs(args[1].x) > 50) { flood.calls.push({ type: args[0], args: args[1] }); flood.o.player.x -= 40; return { state: 'FAILED', reasonCode: 'TUNNEL_FLOODED' }; }
		return plain(...args);
	};
	const dry = await searchFor(target, flood);
	assert.equal(dry.reasonCode, 'FIND_BUDGET', dry.message);
});
test('swim hops stay inside the search circle', async () => {
	const b = fake({ event: flight({ outcome: 'shattered' }) });
	b.o.player.x = -25; b.o.player.inWater = true;
	const original = b.act;
	b.act = async (...args) => {
		if (args[0] === 'travel_to' && Math.abs(args[1].x) > 30) { b.calls.push({ type: args[0], args: args[1] }); return { state: 'FAILED', reasonCode: 'OUT_OF_BLOCKS' }; }
		if (args[0] === 'move_to') { b.calls.push({ type: args[0], args: args[1] }); b.o.player.x = args[1].x; b.o.player.z = args[1].z; return { state: 'SUCCEEDED', reasonCode: 'DESTINATION_REACHED' }; }
		return original(...args);
	};
	b.eyeSearchState = { origin: { x: 0, y: 70, z: 0 } };
	await searchFor(target, b, { within: 32 });
	const hops = b.calls.filter(c => c.type === 'move_to');
	assert.ok(hops.length >= 1);
	for (const h of hops) assert.ok(Math.hypot(h.args.x, h.args.z) <= 30.001, `hop to ${h.args.x},${h.args.z} leaves the circle`);
});
test('with no open sky seen yet the body steps out from under cover before digging up', async () => {
	const b = fake({ skyOpen: false });
	const original = b.act;
	b.act = async (...args) => { const r = await original(...args); if (args[0] === 'travel_to' && args[1].z === 6) b.o.player.skyOpen = true; return r; };
	await searchFor(target, b);
	const moves = b.calls.filter(c => c.type === 'travel_to').slice(0, 2).map(c => [c.args.x, c.args.z, c.args.build]);
	assert.deepEqual(moves, [[6, 0, false], [0, 6, false]]);
	assert.equal(b.calls.some(c => c.type === 'dig_to' && c.args.pattern === 'stairs_up'), false);
	assert.equal(b.calls.filter(c => c.type === 'use_item').length, 1);
	// Open sky remembered only right here (seen before a teleport) still steps out first.
	const here = fake({ skyOpen: false }); here.openSky = () => ({ x: 1, y: 75, z: 0 });
	const plain = here.act;
	here.act = async (...args) => { const r = await plain(...args); if (args[0] === 'travel_to' && args[1].x === 6) here.o.player.skyOpen = true; return r; };
	await searchFor(target, here);
	assert.equal(here.calls.some(c => c.type === 'dig_to' && c.args.pattern === 'stairs_up'), false);
});
test('a pickup with no way to the eye leaves it behind and the find goes on', async () => {
	const b = fake({ event: flight({ outcome: 'dropped', droppedAt: { x: -12, y: 73, z: 0 } }) });
	b.o.items = [{ itemId: 'minecraft:ender_eye', stableId: '00000000-0000-4000-8000-000000000001', x: -12, y: 73, z: 0 }];
	const original = b.act;
	b.act = async (...args) => {
		if (args[0] === 'pick_up_item') { b.calls.push({ type: args[0], args: args[1] }); return { state: 'FAILED', reasonCode: 'NO_SEEN_ROUTE' }; }
		return original(...args);
	};
	const r = await searchFor(target, b);
	assert.equal(r.reasonCode, 'FIND_BUDGET', r.message); assert.equal(r.find.eyes.throws[0].recovery, 'not_reached');
	assert.equal(b.calls.filter(c => c.type === 'pick_up_item').length, 1);
});
test('a walk to an eye whose tunnel floods, backed out of dry, leaves the eye instead of ending the find as danger', async () => {
	const b = fake({ event: flight({ outcome: 'dropped', droppedAt: { x: -12, y: 69, z: 0 } }) });
	b.o.items = [{ itemId: 'minecraft:ender_eye', stableId: '00000000-0000-4000-8000-000000000001', x: -12, y: 69, z: 0 }];
	const original = b.act;
	b.act = async (...args) => {
		if (args[0] === 'travel_to' && args[1].y === 69) { b.calls.push({ type: args[0], args: args[1] }); return { state: 'FAILED', reasonCode: 'TUNNEL_FLOODED' }; }
		return original(...args);
	};
	const r = await searchFor(target, b);
	assert.equal(r.reasonCode, 'FIND_BUDGET', r.message); assert.equal(r.find.eyes.throws[0].recovery, 'not_reached');
});
test('a leg that covered ground before water it cannot bridge still counts as a leg', async () => {
	const b = fake({ event: flight({ outcome: 'shattered' }) });
	const original = b.act;
	b.act = async (...args) => {
		const from = b.o.player.x, result = await original(...args);
		if (args[0] === 'wait') b.o.perception.events = [flight({ outcome: 'shattered', flightId: 17 + b.calls.filter(c => c.type === 'use_item').length, from: { x: from, y: 70, z: 0 }, to: { x: from - 12, y: 75, z: 0 } })];
		// Every leg stops 40 blocks on, at the shore.
		if (args[0] === 'travel_to' && Math.abs(args[1].x - from) > 50) { b.o.player.x = from - 40; return { state: 'FAILED', reasonCode: 'BUILD_FAILED' }; }
		return result;
	};
	const r = await searchFor({ ...target, throwCap: 2 }, b);
	assert.equal(r.reasonCode, 'FIND_BUDGET', r.message); assert.equal(r.find.eyes.throwsMade, 2);
	assert.equal(r.find.eyes.throws[1].from.x, -40);
	const stuck = fake({ event: flight({ outcome: 'shattered' }) });
	stuck.act = async (type, args) => { stuck.calls.push({ type, args }); if (type === 'use_item') stuck.o.inventory.items[0].count--; if (type === 'wait') stuck.o.perception.events.push(flight({ outcome: 'shattered' }));
		return type === 'travel_to' ? { state: 'FAILED', reasonCode: 'BUILD_FAILED' } : { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; };
	const blocked = await searchFor({ ...target, throwCap: 2 }, stuck);
	assert.equal(blocked.reasonCode, 'FIND_BLOCKED', 'a leg that went nowhere still hands back');
});

test('opposed bearings bracket the dig area and later rising legs shorten', () => {
 assert.equal(eyeLeg({ vertical: 'rose' }, 2), 64);
 assert.deepEqual(eyeBracket(null, { from: { x: 0, z: 0 }, yaw: 90 }, { from: { x: -32, z: 0 }, yaw: -90 }), { a: { x: 0, z: 0 }, b: { x: -32, z: 0 } });
});
