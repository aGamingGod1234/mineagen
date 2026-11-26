import test from 'node:test';
import assert from 'node:assert/strict';
import { routeLine } from '../src/skill-fits.mjs';
import { bedSpawnOption, netherReadiness } from '../src/need-sources.mjs';
import { sleepLine, spawnLine } from '../src/wake-body-facts.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';
// These cases are the stock.foodFloor off arm (the route before the food floor); food-floor-route.test.mjs has the on arm.
process.env.MINEAGEN_FOOD_FLOOR = 'off';

const sample = (items = [], extra = {}) => ({ ready: true, observedAtEpochMs: 1,
 player: { health: 20, foodLevel: 20 }, world: { dimension: 'minecraft:overworld', dayTime: 14000 },
 inventory: { items: items.map(([id, count = 1]) => ({ itemId: `minecraft:${id}`, count })) }, blocks: [], entities: [], ...extra });
const kit = [['iron_pickaxe'], ['shield'], ['bucket', 2], ['flint_and_steel'], ['cobblestone', 64]];

test('round1 lit-portal detour: healthy player has an entry suggestion, not food stocks or a bed hunt', () => {
 const known = emptyKnown(); known.frames.push({ dimension: 'minecraft:overworld', x: 0, y: 64, z: 0, lit: true, obsidian: 10 });
 const portalView = { sighted: { portalFrames: [{ lit: true }] }, blocks: [{ blockId: 'minecraft:nether_portal', x: 0, y: 64, z: 0 }] };
 // Three matching wool held is the one preparation the route asks for at a lit portal (C33): a bed from them, no hunt.
 assert.match(routeLine({ observation: sample([...kit, ['white_wool', 3]], portalView), known, evaluate: evaluatePlanCheck }), /^usual next step: obtain white_bed, then place_block it by the portal at 0,64,0/);
 const o = sample([...kit, ['white_wool', 2]], portalView);
 assert.equal(routeLine({ observation: o, known, evaluate: evaluatePlanCheck }), 'usual next step: enter the Nether through the lit portal now (no bed, 3 matching wool or sheep in reach: no portal bed; food stocks are optional unless health or hunger is low)');
 assert.equal(bedSpawnOption(o, 'nether'), null);
 assert.equal(spawnLine(o), null);
 assert.equal(sleepLine(o), null);
 assert.doesNotMatch(netherReadiness(o), /food is scarce|food there early/);
 for (const player of [{ health: 20, foodLevel: 14 }, { health: 14, foodLevel: 20 }]) {
  const hurt = { ...o, player };
  // Round 2 composition: #351's entry line carries the low-health/hunger exception; netherReadiness gives the food fact.
  assert.match(routeLine({ observation: hurt, known, evaluate: evaluatePlanCheck }), /unless health or hunger is low/);
  assert.match(netherReadiness(hurt), /food is scarce/);
 }
});

test('quick bed advice uses fresh visible opportunities, never a wool search from an empty or partial inventory', () => {
 for (const o of [sample(), sample([['white_wool', 2]]), sample([['white_wool', 2], ['black_wool']]),
  sample([], { entities: [{ type: 'minecraft:sheep', perceivedBy: 'sound' }] }),
  sample([], { entities: [{ type: 'minecraft:sheep' }], continuity: { rememberedSections: ['entities'] } })]) {
  assert.equal(bedSpawnOption(o, 'nether'), null);
  assert.equal(spawnLine(o), null);
  assert.equal(sleepLine(o), null);
 }
 for (const o of [sample([['white_bed']]), sample([['white_wool', 3]]), sample([], { entities: [{ type: 'minecraft:sheep' }] })]) {
  assert.match(bedSpawnOption(o, 'nether'), /after the available stage/);
  assert.match(spawnLine(o), /after the available stage/);
  assert.match(sleepLine(o), /after the available stage/);
 }
});

test('fresh portal landmarks suppress every automatic bed presenter', () => {
 for (const blockId of ['minecraft:nether_portal', 'minecraft:end_portal']) {
  const o = sample([['white_bed']], { landmarks: [{ blockId, x: 0, y: 64, z: 0 }] });
  for (const render of [o => bedSpawnOption(o, 'end'), sleepLine, spawnLine]) assert.equal(render(o), null);
  const stale = { ...o, continuity: { rememberedSections: ['blocks'] } };
  assert.match(bedSpawnOption(stale, 'end'), /after the available stage/);
 }
});

test('low-health casting advice respects its UTF-8 route budget including the ellipsis', () => {
 const o = sample([['iron_pickaxe'], ['shield'], ['bucket'], ['water_bucket'], ['flint_and_steel'], ['cooked_mutton', 8]]);
 o.inventory.items.find(i => i.itemId === 'minecraft:shield').slot = 'offhand';
 for (const player of [{ health: 14, foodLevel: 20 }, { health: 20, foodLevel: 14 }, { health: 14, foodLevel: 14 }]) {
  const line = routeLine({ observation: { ...o, player }, known: emptyKnown(), evaluate: evaluatePlanCheck });
  assert.ok(Buffer.byteLength(line) <= 220, `${Buffer.byteLength(line)}: ${line}`);
  assert.match(line, /low hunger\/health/);
 }
});
