import test from 'node:test';
import assert from 'node:assert/strict';
import { nightFor, nightMoveStop } from '../src/night-cover.mjs';
import { checkedSearchBody, searchFor } from './helpers/checked-body.mjs';

const at = (dayTime, player = {}, dimension = 'minecraft:overworld') => ({ world: { dimension, dayTime },
	player: { x: 0.5, y: 70, z: 0.5, yaw: 0, health: 20, armor: 0, skyOpen: true, ...player } });

test('night is from dusk to sunrise for an unarmoured body in the Overworld, with a minute of dusk before it', () => {
	assert.equal(nightFor(at(6_000)), null);
	assert.equal(nightFor(at(11_000)), 'dusk');
	assert.equal(nightFor(at(13_000)), 'night');
	assert.equal(nightFor(at(24_000 + 18_000)), 'night', 'any day');
	assert.equal(nightFor(at(23_600)), null, 'sunrise burns the mobs');
	assert.equal(nightFor(at(13_000, { armor: 15 })), null, 'full iron takes the night');
	assert.equal(nightFor(at(13_000, {}, 'minecraft:the_nether')), null);
});

test('from-scratch game 14: under cover at dusk, a climb to the surface for gravel waits for morning', () => {
	const below = at(11_500, { y: 30, skyOpen: false });
	assert.match(nightMoveStop(below, 'dig_to', { pattern: 'stairs_up', y: 54 }), /staying under cover/, 'a 24-block leg is no pocket exit');
	assert.match(nightMoveStop(below, 'travel_to', { x: 0, y: 70, z: 0, retrace: true }), /staying under cover/);
	assert.equal(nightMoveStop(below, 'dig_to', { pattern: 'tunnel', heading: 'west' }), null, 'working down here goes on');
	assert.equal(nightMoveStop(below, 'dig_to', { pattern: 'stairs_down', y: 16 }), null);
	assert.equal(nightMoveStop(at(11_500, { y: 30, skyOpen: false, underWater: true }), 'travel_to', { x: 0, y: 70, z: 0, retrace: true }), null, 'breath first');
	assert.equal(nightMoveStop(at(6_000, { y: 30, skyOpen: false }), 'dig_to', { pattern: 'stairs_up', y: 54 }), null, 'by day it climbs');
});

test('review of #117: a short climb out of a mined pocket deep underground is allowed at night; a climb to the surface is not', () => {
	const pocket = at(15_000, { y: 13, skyOpen: false });
	const sky = { openSky: { x: 0.5, y: 70, z: 0.5 } };
	assert.equal(nightMoveStop(pocket, 'dig_to', { pattern: 'stairs_up', y: 16, maxBlocks: 12 }, sky), null, 'obtain back to the level it mined from');
	assert.equal(nightMoveStop(pocket, 'dig_to', { pattern: 'stairs_up', y: 16 }), null, 'with no open sky known');
	assert.match(nightMoveStop(pocket, 'dig_to', { pattern: 'stairs_up' }, sky), /staying under cover/, 'no height: stairs to the surface');
	assert.match(nightMoveStop(pocket, 'dig_to', { pattern: 'stairs_up', y: 37 }, sky), /staying under cover/, 'a leg of 24 up is a climb out');
	const nearTop = at(15_000, { y: 62, skyOpen: false });
	assert.match(nightMoveStop(nearTop, 'dig_to', { pattern: 'stairs_up', y: 67 }, sky), /staying under cover/, 'ends near the open sky above');
	assert.match(nightMoveStop(pocket, 'travel_to', { x: 0.5, y: 70, z: 0.5, retrace: true }, sky), /staying under cover/, 'a retrace is always the way out');
});

test('from-scratch games 5 and 13: on open ground at night a long walk is refused, a step to cover and a way down are not', () => {
	const open = at(14_000);
	assert.match(nightMoveStop(open, 'travel_to', { x: 84, y: 62, z: -122 }), /rest/);
	assert.match(nightMoveStop(open, 'travel_to', { yaw: 90, distance: 24 }), /rest/);
	assert.equal(nightMoveStop(open, 'travel_to', { x: 4, y: 70, z: 3 }), null, 'a few blocks to cover');
	assert.equal(nightMoveStop(open, 'travel_to', { x: 30, y: 40, z: 0 }), null, 'down into a cave');
	assert.equal(nightMoveStop(at(11_500), 'travel_to', { x: 84, y: 62, z: -122 }), null, 'before dark the walk goes on');
	assert.equal(nightMoveStop(open, 'flee_from', { targetId: 'z' }), null, 'never a reflex or a flee');
});

test('a find for gravel from under cover at dusk hands back FIND_NIGHT without climbing', async () => {
	const calls = [];
	let clock = 0;
	const observation = { ...at(11_500, { y: 30, skyOpen: false }), inventory: { items: [] } };
	const body = checkedSearchBody({
		now: () => clock, progress: () => {}, observe: async () => structuredClone(observation),
		look: async () => { clock += 2_000; return { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => { calls.push({ actionType, args }); clock += 30_000; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; },
		frontier: () => null, known: () => null, places: async () => [], openSky: () => ({ x: 0.5, y: 70, z: 0.5, dimension: 'minecraft:overworld' }),
	});
	const result = await searchFor({ block: 'minecraft:oak_log' }, body);
	assert.equal(result.reasonCode, 'FIND_NIGHT');
	assert.match(result.message, /staying under cover/);
	assert.equal(calls.some((call) => call.actionType === 'dig_to' && call.args.pattern === 'stairs_up' || call.args?.retrace === true), false, 'no climb was sent');
});

test('PORTAL-LAVA-8: deep underground at night the gate names what works there, not a rest that hands back at once', () => {
	const sky = { openSky: { x: 0.5, y: 70, z: 0.5 } };
	// y-54 under 124 blocks of ground: rest returns UNDERGROUND at once (ServerRestController.underground, > 4 over the eyes).
	const deep = nightMoveStop(at(15_000, { y: -54, skyOpen: false }), 'dig_to', { pattern: 'stairs_up' }, sky);
	assert.match(deep, /staying under cover/);
	assert.doesNotMatch(deep, /\brest\b/);
	assert.match(deep, /craft/);
	assert.match(deep, /mine on/);
	assert.match(deep, /wait for dawn/);
	assert.doesNotMatch(nightMoveStop(at(15_000, { y: -54, skyOpen: false }), 'dig_to', { pattern: 'stairs_up' }), /\brest\b/, 'no open sky known to measure from');
	// Just under a roof near the surface (2.4 blocks over the eyes) rest still seals the way up.
	assert.match(nightMoveStop(at(15_000, { y: 66, skyOpen: false }), 'dig_to', { pattern: 'stairs_up' }, sky), /rest \(it seals the way up\)/);
	// rest's own cut: 4 blocks of ground over the eyes still seals, any more is underground.
	assert.match(nightMoveStop(at(15_000, { y: 64.38, skyOpen: false }), 'dig_to', { pattern: 'stairs_up' }, sky), /rest \(it seals/);
	assert.doesNotMatch(nightMoveStop(at(15_000, { y: 64.3, skyOpen: false }), 'dig_to', { pattern: 'stairs_up' }, sky), /\brest\b/);
	// The open-ground line is unchanged: rest is what works there.
	assert.match(nightMoveStop(at(14_000), 'travel_to', { x: 84, y: 62, z: -122 }), /rest \(bed, walls or a dug hole\)/);
});
