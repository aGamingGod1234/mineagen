import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE_BYTES, routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';
import { portalBedSource, quickBedSource } from '../src/survival-advice.mjs';

// C33: a respawn bed by the Overworld portal before the first Nether entry, only from what is in reach right now.

const KIT = [['iron_pickaxe', 1], ['water_bucket', 1], ['bucket', 1], ['shield', 1, 'offhand'], ['iron_chestplate', 1, 'chest'], ['iron_boots', 1, 'feet'], ['flint_and_steel', 1], ['cooked_beef', 10], ['cobblestone', 40]];
const sample = (items = [], extra = {}) => ({ ready: true, observedAtEpochMs: 1, position: { x: 0, y: 64, z: 0 }, player: { health: 20, foodLevel: 20 },
	world: { dimension: 'minecraft:overworld' }, inventory: { items: [...KIT, ...items].map(([id, count, slot]) => ({ itemId: `minecraft:${id}`, count, ...(slot ? { slot } : {}) })) }, ...extra });
const litKnown = (extra = {}) => { const known = { ...emptyKnown(), ...extra }; known.frames = [{ dimension: 'minecraft:overworld', x: 3, y: 60, z: 4, obsidian: 10, lit: true }]; return known; };
const route = (observation, known = litKnown()) => routeLine({ observation, known, evaluate: evaluatePlanCheck });
const sheep = (n, appearance = { woolColor: 'white' }, extra = {}) => Array.from({ length: n }, (_, i) => ({ type: 'minecraft:sheep', distance: 6 + i, x: 6 + i, y: 64, z: 0, appearance, ...extra }));
const ENTRY = 'usual next step: enter the Nether through the lit portal now';
const NO_BED = `${ENTRY} (no bed, 3 matching wool or sheep in reach: no portal bed; shield, armour and food held; eat first if health or hunger is low)`;

test('a bed held at the lit portal: place it by the portal and use it, ahead of entering', () => {
	assert.equal(route(sample([['red_bed', 1]])),
		'usual next step: place_block red_bed by the portal at 3,60,4, interact_block it until "Respawn point set" (by day too), keep it (bed held; a Nether death then respawns here)');
	// A portal block and a lit frame in view hide the other bed presenters, but not this step.
	const inView = sample([['red_bed', 1]], { blocks: [{ blockId: 'minecraft:nether_portal', x: 3, y: 61, z: 4 }], sighted: { portalFrames: [{ lit: true }] } });
	assert.equal(quickBedSource(inView), null);
	assert.match(route(inView), /^usual next step: place_block red_bed by the portal at 3,60,4/);
});

test('three matching wool held: craft the bed, then place and use it', () => {
	assert.equal(route(sample([['white_wool', 3]])),
		'usual next step: obtain white_bed, then place_block it by the portal at 3,60,4, interact_block it until "Respawn point set" (by day too), keep it (3 white_wool held)');
	// Three wool of mixed colours make no bed.
	assert.equal(route(sample([['white_wool', 2], ['black_wool', 1]])), NO_BED);
});

test('wool in view: adult unsheared sheep of a known colour and wool blocks, counted per colour', () => {
	assert.equal(route(sample([['white_wool', 1]], { entities: sheep(2) })),
		'usual next step: get white_wool from the 2 sheep in view, obtain white_bed, then place and use it by the portal (1 held, no wool search; skip if they leave)');
	assert.match(route(sample([], { blocks: [0, 1, 2].map(x => ({ blockId: 'minecraft:red_wool', x, y: 70, z: 5 })) })), /get red_wool from the 3 wool blocks in view/);
	// None of these is a sure wool: a baby, a sheared sheep, one heard not seen, an unknown colour, a remembered herd, two colours.
	for (const entities of [sheep(3, { woolColor: 'white', baby: true }), sheep(3, { woolColor: 'white', sheared: true }), sheep(3, { woolColor: 'white' }, { perceivedBy: 'sound' }),
		sheep(3, {}), [...sheep(2), ...sheep(1, { woolColor: 'black' })]]) assert.equal(route(sample([], { entities })), NO_BED);
	assert.equal(route(sample([], { entities: sheep(3), continuity: { rememberedSections: ['entities'] } })), NO_BED);
});

test('a bed in view: use it when it is by the portal, otherwise move it there', () => {
	assert.equal(route(sample([], { blocks: [{ blockId: 'minecraft:blue_bed', x: 5, y: 60, z: 4 }] })),
		'usual next step: interact_block the blue_bed at 5,60,4 until "Respawn point set" (by day too), keep it (bed by the portal)');
	assert.match(route(sample([], { blocks: [{ blockId: 'minecraft:blue_bed', x: 90, y: 66, z: 4 }] })),
		/^usual next step: break_block the blue_bed at 90,66,4, then place_block it by the portal at 3,60,4, interact_block it/);
	// A bed straight above the portal but 40 blocks up is moved, not used.
	assert.match(route(sample([], { blocks: [{ blockId: 'minecraft:blue_bed', x: 3, y: 100, z: 4 }] })),
		/^usual next step: break_block the blue_bed at 3,100,4, then place_block it by the portal at 3,60,4/);
});

test('nothing in reach: enter now and say why the bed is skipped; never a wool search', () => {
	const line = route(sample([['white_wool', 2]]));
	assert.equal(line, NO_BED);
	assert.doesNotMatch(line, /find|gather|sheep in view/);
});

test('a respawn already set by the portal needs no step; one set far away does not count', () => {
	const near = { kind: 'set', dimension: 'minecraft:overworld', x: 5, y: 60, z: 10, at: 1, source: 'used' };
	assert.equal(route(sample([['red_bed', 1]]), litKnown({ spawn: near })), `${ENTRY} (respawn set by the portal; shield, armour and food held; eat first if health or hunger is low)`);
	assert.match(route(sample([['red_bed', 1]]), litKnown({ spawn: { ...near, x: 300 } })), /^usual next step: place_block red_bed/);
	assert.match(route(sample([['red_bed', 1]]), litKnown({ spawn: { kind: 'world', at: 1, source: 'missing' } })), /^usual next step: place_block red_bed/);
	// Height counts: a surface respawn straight above an underground portal is not by it.
	const deep = known => { known.frames[0].y = -55; return known; };
	assert.match(route(sample([['red_bed', 1]], { position: { x: 3, y: -55, z: 4 } }), deep(litKnown({ spawn: { ...near, x: 3, y: 70, z: 4 } }))), /^usual next step: place_block red_bed by the portal at 3,-55,4/);
});

test('after the first entry, and in the Nether, the route has no portal bed step', () => {
	const visited = litKnown(); visited.visitedDimensions.push('minecraft:the_nether');
	for (const line of [route(sample([['red_bed', 1], ['white_wool', 3]]), visited),
		route(sample([['red_bed', 1]], { world: { dimension: 'minecraft:the_nether' } })),
		route({ ...sample([['red_bed', 1]]), advancements: ['minecraft:story/enter_the_nether'] })]) assert.doesNotMatch(line, /_bed|Respawn point set/);
	assert.equal(portalBedSource(sample([['red_bed', 1]], { world: { dimension: 'minecraft:the_nether' } })), null);
});

test('before lighting: the bed is made ready from wool or sheep in reach; a held bed needs nothing yet', () => {
	const pools = { ...emptyKnown(), lavaPools: [{ dimension: 'minecraft:overworld', x: 4, y: 60, z: 4 }] };
	const before = observation => routeLine({ observation, known: pools, evaluate: evaluatePlanCheck });
	assert.equal(before(sample([['white_wool', 3]])), 'usual next step: before lighting the portal, obtain white_bed, then carry it to the portal (3 white_wool held)');
	assert.match(before(sample([], { entities: sheep(3) })), /^usual next step: before lighting the portal, get white_wool from the 3 sheep in view, obtain white_bed, then carry it to the portal/);
	assert.match(before(sample([['red_bed', 1]])), /^usual next step: build nether_portal beside the lava pool/);
	assert.match(before(sample([['white_wool', 2]])), /^usual next step: build nether_portal beside the lava pool/);
});

test('every portal bed line fits the route budget unclipped with long colours and far coordinates', () => {
	const far = { x: -29_999_123, y: -60, z: 29_999_456 };
	const known = { ...emptyKnown(), frames: [{ dimension: 'minecraft:overworld', ...far, obsidian: 10, lit: true }] };
	const pools = { ...emptyKnown(), lavaPools: [{ dimension: 'minecraft:overworld', x: 4, y: 60, z: 4 }] };
	const many = { entities: sheep(12, { woolColor: 'light_gray' }), blocks: Array.from({ length: 12 }, (_, x) => ({ blockId: 'minecraft:light_gray_wool', x, y: 70, z: 5 })) };
	const lines = [route(sample([['light_gray_bed', 1]]), known), route(sample([['light_gray_wool', 3]]), known), route(sample([['light_gray_wool', 2]], many), known),
		route(sample([], { blocks: [{ blockId: 'minecraft:light_gray_bed', x: 29_999_000, y: -60, z: -29_999_000 }] }), known),
		routeLine({ observation: sample([['light_gray_wool', 2]], many), known: pools, evaluate: evaluatePlanCheck })];
	for (const line of lines) {
		assert.match(line, /light_gray/);
		assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES, `${Buffer.byteLength(line)}: ${line}`);
		assert.doesNotMatch(line, /…$/);
	}
});
