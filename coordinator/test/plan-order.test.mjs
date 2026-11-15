import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { evaluatePlanCheck, emptyKnown, planProgress } from '../src/plan-checks.mjs';
import { record, scenarios, item } from './fixtures/progress/scenarios.mjs';

// The step graph the goal translator writes for "beat the game" (ids, kinds, checks and dependencies of live plans).
const step = (id, kind, check, dependsOn = []) => ({ id, label: id, kind, check, dependsOn, status: 'pending', evidence: null, detail: '' });
const plan = () => ({ steps: [
 step('stone', 'inventory', 'tool:pickaxe:stone+'),
 step('iron', 'inventory', 'tool:pickaxe:iron+ & has:minecraft:bucket|minecraft:water_bucket|minecraft:lava_bucket*1', ['stone']),
 step('portal_respawn', 'world', 'spawn:bed'),
 step('depth', 'world', 'y<=-45', ['iron']),
 step('pool', 'world', 'lava:10', ['depth']),
 step('water', 'inventory', 'has:minecraft:water_bucket*1', ['iron']),
 step('frame', 'world', 'frame:10', ['pool', 'water']),
 step('light', 'inventory', 'has:minecraft:flint_and_steel|minecraft:fire_charge*1', ['iron']),
 step('nether', 'milestone', 'in:minecraft:the_nether', ['frame', 'light']),
 step('pearls', 'inventory', 'has:minecraft:ender_pearl|minecraft:ender_eye*12', ['iron']),
 step('gold', 'inventory', 'has:minecraft:golden_helmet|minecraft:golden_chestplate|minecraft:golden_leggings|minecraft:golden_boots*1'),
 step('bastion', 'manual', null, ['nether']),
 step('fortress', 'world', 'seen:minecraft:fortress', ['nether']),
 step('spawner', 'world', 'seen:minecraft:spawner', ['fortress']),
 step('cover', 'manual', null, ['spawner']),
 step('blaze', 'inventory', 'has:minecraft:blaze_rod*6 | has:minecraft:blaze_powder|minecraft:ender_eye*12', ['cover']),
 step('eyes', 'inventory', 'has:minecraft:ender_eye*12', ['pearls', 'blaze']),
 step('stronghold', 'world', 'seen:minecraft:stronghold', ['eyes']),
 step('end_respawn', 'world', 'spawn:bed', ['stronghold']),
 step('end', 'milestone', 'in:minecraft:the_end', ['stronghold']),
 step('crystals', 'world', 'crystals<=0', ['end']),
 step('dragon', 'milestone', 'killed:minecraft:ender_dragon', ['crystals'])
] });
let clock = 1_800_000_000_000;
const sample = (dimension, items, extra = {}) => {
 const o = structuredClone(scenarios[0].observation);
 o.world.dimension = dimension; o.inventory.items = items; o.observedAtEpochMs = (clock += 1000);
 return Object.assign(o, extra);
};
const view = async (...observations) => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, record.currentGoal, plan());
 for (const o of observations) await views.observe(record, o);
 return views;
};
const opened = line => [...line.matchAll(/(?:^|; )open ([a-z_]+)\[/g)].map(m => m[1]);

test('standing in the Nether proves the portal chain; a past visit, Overworld presence, depth and sightings stay presence-only', () => {
 const o = sample('minecraft:the_nether', []), known = { ...emptyKnown(), visitedDimensions: ['minecraft:the_nether'], structuresSeen: [{ id: 'minecraft:fortress', dimension: 'minecraft:the_nether', x: 0, z: 0 }] };
 assert.equal(evaluatePlanCheck('in:minecraft:the_nether', o, known).presenceOnly, false);
 // After a death the player respawns in the Overworld without the portal chain; a visit alone proves no gear.
 assert.equal(evaluatePlanCheck('visited:minecraft:the_nether', o, known).presenceOnly, false);
 assert.equal(evaluatePlanCheck('visited:minecraft:the_nether', sample('minecraft:overworld', []), known).presenceOnly, true);
 assert.equal(evaluatePlanCheck('in:minecraft:the_end', sample('minecraft:the_end', []), known).presenceOnly, false);
 for (const check of ['in:minecraft:overworld', 'seen:minecraft:fortress', 'y<=100']) assert.equal(evaluatePlanCheck(check, sample('minecraft:overworld', []), known).presenceOnly, true, check);
});

test('a Nether start skips the Overworld chain and leads with Nether goals, then roots, then route notes', async () => {
 for (const items of [[item('iron_sword')], [item('iron_pickaxe'), item('bucket')], [item('stone_pickaxe')]]) {
  const views = await view(sample('minecraft:the_nether', items));
  const line = views.progress(record), facts = planProgress(views.snapshot(record).plan);
  assert.deepEqual(opened(line).slice(0, 3), ['pearls', 'fortress', 'gold'], line);
  const statuses = new Map(views.snapshot(record).plan.steps.map(s => [s.id, s.status]));
  for (const id of ['stone', 'iron', 'depth', 'pool', 'water', 'frame', 'light']) assert.ok(facts.skipped[id] === 'nether' || statuses.get(id) === 'complete', id);
  // Beds explode in the Nether, so a respawn-bed step is not offered there.
  assert.doesNotMatch(line, /portal_respawn|end_respawn|early nether/);
 }
});

test('an unprovable manual step does not hold back the rods once the spawner is seen', async () => {
 const views = await view(sample('minecraft:the_nether', [item('iron_pickaxe')], { sighted: { blocks: [{ blockId: 'minecraft:spawner', x: 3, y: 60, z: 4 }] }, landmarks: [{ structure: 'nether fortress', x: 0, z: 0 }] }));
 const line = views.progress(record);
 assert.equal(opened(line)[0], 'blaze', line);
 assert.ok(planProgress(views.snapshot(record).plan).open.includes('cover'));
 // Without the spawner the rods stay closed behind it.
 assert.deepEqual(planProgress({ steps: [step('spawner', 'world', 'seen:minecraft:spawner'), step('cover', 'manual', null, ['spawner']), step('blaze', 'inventory', 'has:minecraft:blaze_rod*6', ['cover'])] }).open, ['spawner']);
});

test('the Overworld start keeps plan order and the End leads with crystals', async () => {
 const start = (await view(sample('minecraft:overworld', []))).progress(record);
 assert.deepEqual(opened(start).slice(0, 2), ['stone', 'portal_respawn'], start);
 const later = (await view(sample('minecraft:overworld', [item('stone_pickaxe')]))).progress(record);
 assert.equal(opened(later)[0], 'iron', later);
 const end = (await view(sample('minecraft:the_end', [item('iron_pickaxe')]))).progress(record);
 assert.equal(opened(end)[0], 'crystals', end);
 assert.doesNotMatch(end, /end_respawn|bastion/);
});

test('a bed set before the portal does not complete the End bed step and skip the rods, pearls and stronghold', async () => {
 const o = sample('minecraft:overworld', [item('iron_pickaxe')]);
 o.perception = { ...(o.perception ?? {}), events: [{ type: 'system_message', text: 'Respawn point set', observedAtEpochMs: o.observedAtEpochMs }] };
 const views = await view(o), steps = views.snapshot(record).plan.steps, facts = planProgress({ steps });
 assert.equal(steps.find(s => s.id === 'portal_respawn').status, 'complete');
 assert.notEqual(steps.find(s => s.id === 'end_respawn').status, 'complete');
 for (const id of ['stronghold', 'eyes', 'blaze', 'pearls']) assert.equal(facts.skipped[id], undefined, id);
 assert.ok(!facts.open.includes('end'));
});

test('after a death, standing in the Nether still proves the Nether step without re-proving its gear', async () => {
 const views = await view(sample('minecraft:the_nether', [item('flint_and_steel')]), { ready: false, player: { dead: true } }, sample('minecraft:the_nether', []));
 assert.equal(views.snapshot(record).plan.steps.find(s => s.id === 'nether').status, 'complete');
});

// The pearl step written last, as the warped-forest translator plans list it after the fortress chain.
const fortressFirst = () => { const p = plan(); const i = p.steps.findIndex(s => s.id === 'pearls'); p.steps.push(...p.steps.splice(i, 1)); return p; };
test('mobs walking in and out of view do not reorder the Nether line or restart the stall clock', async () => {
 const enderman = { id: 'e1', type: 'minecraft:enderman', distance: 12, alive: true }, blaze = { id: 'b1', type: 'minecraft:blaze', distance: 10, alive: true };
 const at = (entities, ms) => { const o = sample('minecraft:the_nether', [item('iron_pickaxe')], { entities }); o.observedAtEpochMs = ms; return o; };
 const start = (clock += 1000);
 const views = new LiveTaskViews(); views.suggest(record.agentId, record.currentGoal, fortressFirst());
 const lines = [];
 for (const [i, entities] of [[enderman, blaze], [], [enderman], [], [blaze]].entries()) { await views.observe(record, at(entities, start + i * 40_000)); lines.push(views.progress(record)); }
 const firsts = lines.map(line => opened(line)[0]);
 assert.ok(firsts.every(id => id === firsts[0]), firsts.join(','));
 // The clock kept running across the five samples (160 s): the first step shows how long it stayed unchanged.
 assert.match(lines.at(-1), new RegExp(`open ${firsts[0]}\\[[^\\]]*unchanged 2m`), lines.at(-1));
});

test('a warped forest or a partly gathered count leads the Nether line; the Overworld keeps plan order exactly', async () => {
 const warped = (await view(sample('minecraft:the_nether', [item('iron_pickaxe')], { world: { ...sample('minecraft:the_nether', []).world, biome: 'minecraft:warped_forest' } }))).progress(record);
 assert.equal(opened(warped)[0], 'pearls', warped);
 // Plan order with fortress first: rods partly held lead once the spawner is seen, wherever the player stands.
 const views = new LiveTaskViews(); views.suggest(record.agentId, record.currentGoal, fortressFirst());
 await views.observe(record, sample('minecraft:the_nether', [item('iron_pickaxe'), item('blaze_rod', 2)], { sighted: { blocks: [{ blockId: 'minecraft:spawner', x: 3, y: 60, z: 4 }] }, landmarks: [{ structure: 'nether fortress', x: 0, z: 0 }] }));
 assert.equal(opened(views.progress(record))[0], 'blaze', views.progress(record));
 for (const items of [[], [item('stone_pickaxe')], [item('iron_pickaxe'), item('bucket')]]) {
  const v = await view(sample('minecraft:overworld', items)), facts = planProgress(v.snapshot(record).plan);
  assert.deepEqual(opened(v.progress(record)), facts.open.slice(0, opened(v.progress(record)).length), items.map(i => i.itemId).join());
 }
});
