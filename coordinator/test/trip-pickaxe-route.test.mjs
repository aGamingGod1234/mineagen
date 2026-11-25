import assert from 'node:assert/strict';
import test from 'node:test';
import { routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';

// The kit before a trip (skill-fits.mjs kitBefore) includes a pickaxe with uses left to dig back out: a worn-out one is
// replaced first, by iron when 3 iron is held, else by stone.
const known = () => { const k = emptyKnown(); k.visitedDimensions.push('minecraft:the_nether'); return k; };
const memory = { position: { x: 0, y: 64, z: 0 }, known: { sightings: [{ what: 'minecraft:nether_portal', kind: 'portal', x: 30, y: -20, z: 7, tick: 100 }], blocks: [] } };
const KIT = [['shield', 1, 'offhand'], ['iron_chestplate', 1, 'chest'], ['iron_boots', 1, 'feet'], ['bread', 8], ['furnace', 1], ['cobblestone', 32]];
const route = (rows, kitHandedBack = new Set()) => routeLine({ observation: { ready: true, observedAtEpochMs: 10, position: { x: 0, y: 64, z: 0 }, player: { health: 20 },
	world: { dimension: 'minecraft:overworld' }, inventory: { items: [...KIT, ...rows].map(([id, count, slot, extra]) => ({ itemId: `minecraft:${id}`, count, ...(slot ? { slot } : {}), ...extra })) } },
known: known(), memory, evaluate: evaluatePlanCheck, kitHandedBack });
const RETURN = /^usual next step: return via known Overworld portal at 30,-20,7 to the Nether/;

test('a worn pickaxe is replaced before the trip, and a sound one goes as it is', () => {
	assert.match(route([['iron_pickaxe', 1, null, { damage: 240, maxDamage: 250 }]]), /^usual next step: obtain stone_pickaxe count 1 \(pickaxe 10 uses left; kit before the Nether\)$/);
	assert.match(route([['iron_pickaxe', 1, null, { usesLeft: 10 }], ['iron_ingot', 3]]), /^usual next step: obtain iron_pickaxe count 2 \(pickaxe 10 uses left; kit before the Nether\)$/);
	assert.match(route([['iron_pickaxe', 1, null, { usesLeft: 200 }]]), RETURN);
	// A spare in the pack counts: the best pickaxe held sets the uses left.
	assert.match(route([['iron_pickaxe', 1, null, { usesLeft: 10 }], ['stone_pickaxe', 1, null, { usesLeft: 131 }]]), RETURN);
	// An obtain that handed the pickaxe back does not loop.
	assert.match(route([['iron_pickaxe', 1, null, { usesLeft: 10 }]], new Set(['minecraft:stone_pickaxe'])), RETURN);
});

test('a trip takes 16 plain blocks, after the food, and any plain kind counts', () => {
	const bare = rows => routeLine({ observation: { ready: true, observedAtEpochMs: 10, position: { x: 0, y: 64, z: 0 }, player: { health: 20 }, world: { dimension: 'minecraft:overworld' },
		inventory: { items: rows.map(([id, count, slot]) => ({ itemId: `minecraft:${id}`, count, ...(slot ? { slot } : {}) })) } }, known: known(), memory, evaluate: evaluatePlanCheck });
	const kit = [['shield', 1, 'offhand'], ['iron_chestplate', 1, 'chest'], ['iron_boots', 1, 'feet'], ['iron_pickaxe', 1]];
	assert.match(bare([...kit, ['bread', 8], ['cobblestone', 5]]), /^usual next step: obtain cobblestone count 16 \(plain blocks 5\/16; kit before the Nether\)$/);
	assert.match(bare([...kit, ['cobblestone', 5]]), /food 0\/4; kit before the Nether/);
	assert.match(bare([...kit, ['bread', 8], ['dirt', 10], ['andesite', 6]]), RETURN);
});
