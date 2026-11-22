import assert from 'node:assert/strict';
import test from 'node:test';
import { WITHER_NEAR_FLOOR, WITHER_NEAR_PATH, corridorFloor, witherOnLeg, withersSeen } from '../src/fortress-approach.mjs';

const from = { x: 0, y: 70, z: 0 }, floor = { x: 20, y: 70, z: 0 };

test('withersSeen reads live perceived wither skeletons only', () => {
	const o = { entities: [{ type: 'minecraft:wither_skeleton', x: 1, y: 2, z: 3 }, { type: 'minecraft:wither_skeleton', position: { x: 4, y: 5, z: 6 } },
		{ type: 'minecraft:wither_skeleton', x: 1, y: 2, z: 3, alive: false }, { type: 'minecraft:blaze', x: 0, y: 0, z: 0 }] };
	assert.deepEqual(withersSeen(o), [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }]);
	assert.deepEqual(withersSeen({ ...o, continuity: { rememberedSections: ['entities'] } }), [], 'remembered entities are not seen now');
});

test('a leg is unsafe with a wither skeleton near its floor or its line, safe otherwise', () => {
	assert.equal(witherOnLeg(from, floor, []), null);
	assert.ok(witherOnLeg(from, floor, [{ x: 20 + WITHER_NEAR_FLOOR - 1, y: 70, z: 0 }]), 'near the floor');
	assert.ok(witherOnLeg(from, floor, [{ x: 10, y: 70, z: WITHER_NEAR_PATH - 1 }]), 'beside the line midway');
	assert.equal(witherOnLeg(from, floor, [{ x: 2, y: 70, z: -(WITHER_NEAR_PATH + 2) }]), null, 'off the line and far from the floor');
	assert.equal(witherOnLeg(from, floor, [{ x: -20, y: 70, z: 0 }]), null, 'behind the body');
	const worst = witherOnLeg(from, floor, [{ x: 30, y: 70, z: 0 }, { x: 18, y: 70, z: 0 }]);
	assert.equal(worst.x, 18, 'the nearest one to the body is named');
});

test('corridor floor: brick walls on both sides along one axis', () => {
	const bricks = new Set(['21,70,0', '19,71,0']);
	assert.equal(corridorFloor({ x: 20.5, y: 70, z: 0.5 }, bricks), true);
	assert.equal(corridorFloor({ x: 20.5, y: 70, z: 0.5 }, new Set(['21,70,0'])), false, 'one wall is a ledge, not a corridor');
	assert.equal(corridorFloor({ x: 20.5, y: 70, z: 0.5 }, new Set(['21,70,0', '20,70,1'])), false, 'a corner is not a corridor');
	assert.equal(corridorFloor({ x: 20.5, y: 70, z: 0.5 }, new Set(['20,70,1', '20,71,-1'])), true);
});
