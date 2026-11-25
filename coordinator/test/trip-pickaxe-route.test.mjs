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

test('a trip takes 32 plain blocks, after the food, and any plain kind counts', () => {
	const bare = rows => routeLine({ observation: { ready: true, observedAtEpochMs: 10, position: { x: 0, y: 64, z: 0 }, player: { health: 20 }, world: { dimension: 'minecraft:overworld' },
		inventory: { items: rows.map(([id, count, slot]) => ({ itemId: `minecraft:${id}`, count, ...(slot ? { slot } : {}) })) } }, known: known(), memory, evaluate: evaluatePlanCheck });
	const kit = [['shield', 1, 'offhand'], ['iron_chestplate', 1, 'chest'], ['iron_boots', 1, 'feet'], ['iron_pickaxe', 1]];
	assert.match(bare([...kit, ['bread', 8], ['cobblestone', 5]]), /^usual next step: obtain cobblestone count 32 \(plain blocks 5\/32; kit before the Nether\)$/);
	assert.match(bare([...kit, ['cobblestone', 5]]), /food 0\/3; kit before the Nether/);
	assert.match(bare([...kit, ['bread', 8], ['dirt', 20], ['andesite', 12]]), RETURN);
});

test('the prep cap lets the bot go in short after 15 minutes, once per life and dimension', async () => {
	const { cappedRoute, kitPrep, KIT_PREP_MS } = await import('../src/skill-fits.mjs');
	const rows = [['iron_pickaxe', 1], ['cobblestone', 32], ['bread', 8]];
	const draw = over => routeLine({ observation: { ready: true, observedAtEpochMs: 10, position: { x: 0, y: 64, z: 0 }, player: { health: 20 }, world: { dimension: 'minecraft:overworld' },
		inventory: { items: rows.map(([id, count]) => ({ itemId: `minecraft:${id}`, count })) } }, known: known(), memory, kitPrepOver: over, evaluate: evaluatePlanCheck });
	const key = 'w|0|minecraft:overworld';
	let step = cappedRoute(draw, null, { key, at: 0 });
	assert.match(step.line, /kit before the Nether\)$/);
	step = cappedRoute(draw, step.gate, { key, at: KIT_PREP_MS - 1 });
	assert.match(step.line, /kit before the Nether\)$/);
	step = cappedRoute(draw, step.gate, { key, at: KIT_PREP_MS });
	assert.match(step.line, RETURN);
	// Over stays over for that key, even after a line with no kit step; a death or a new dimension restarts the clock.
	assert.match(cappedRoute(draw, step.gate, { key, at: KIT_PREP_MS + 5 }).line, RETURN);
	assert.equal(kitPrep(step.gate, 'usual next step: return via known Overworld portal', { key, at: KIT_PREP_MS + 9 }).over, true);
	assert.match(cappedRoute(draw, step.gate, { key: 'w|1|minecraft:overworld', at: KIT_PREP_MS + 10 }).line, /kit before the Nether\)$/);
});

test('with gold held, one gold piece goes on before the Nether: a carried one first, else a helmet from 5 gold', () => {
	const go = extra => route([['iron_pickaxe', 1], ...extra]);
	assert.match(go([['golden_helmet', 1]]), /^usual next step: equip_item golden_helmet to head \(golden_helmet carried, piglins spare gold; kit before the Nether\)$/);
	assert.match(go([['gold_ingot', 5]]), /^usual next step: obtain golden_helmet, then equip_item it to head \(gold 5 held/);
	assert.match(go([['gold_ingot', 4]]), RETURN);
	assert.match(go([['golden_helmet', 1, 'head']]), RETURN);
	assert.match(route([['iron_pickaxe', 1], ['gold_ingot', 5]], new Set(['minecraft:golden_helmet'])), RETURN);
});

test('past the prep cap a carried shield or piece still goes on, and a hand-back only counts in its own prep window', () => {
	const draw = (rows, extra = {}) => routeLine({ observation: { ready: true, observedAtEpochMs: 10, position: { x: 0, y: 64, z: 0 }, player: { health: 20 }, world: { dimension: 'minecraft:overworld' },
		inventory: { items: rows.map(([id, count, slot]) => ({ itemId: `minecraft:${id}`, count, ...(slot ? { slot } : {}) })) } }, known: known(), memory, evaluate: evaluatePlanCheck, ...extra });
	const base = [['iron_pickaxe', 1], ['cobblestone', 32], ['bread', 8]];
	assert.match(draw([...base, ['shield', 1]], { kitPrepOver: true }), /^usual next step: equip_item shield to offhand \(shield carried, not worn; kit before the Nether\)$/);
	assert.match(draw([...base, ['shield', 1, 'offhand'], ['iron_chestplate', 1]], { kitPrepOver: true }), /^usual next step: equip_item minecraft:iron_chestplate to chest|^usual next step: equip_item iron_chestplate to chest/);
	assert.match(draw([...base, ['shield', 1, 'offhand']], { kitPrepOver: true }), RETURN);
	// The life's hand-back set no longer releases the gate; only the window's does.
	const all = new Set(['minecraft:iron_chestplate']);
	assert.match(draw([...base, ['shield', 1, 'offhand']], { kitHandedBack: all, prepHandedBack: new Set() }), /^usual next step: obtain iron_chestplate/);
	assert.doesNotMatch(draw([...base, ['shield', 1, 'offhand']], { kitHandedBack: all, prepHandedBack: all }), /iron_chestplate/);
});
