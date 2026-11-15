import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { skillFitsLine, SKILL_FITS_BYTES } from '../src/skill-fits.mjs';
import { workNotices } from '../src/work-notices.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { ModelObservationViews, encodeNativeEventInput, decodeModelFacts } from '../src/model-fact-encoding.mjs';

const r = () => ({ agentId: 'intent-player', currentGoal: 'Beat Minecraft', goalRevision: 1 });
const item = (name, usesLeft) => ({ itemId: `minecraft:${name}`, count: 1, ...(usesLeft === undefined ? {} : { usesLeft }) });
const sample = (extra = {}) => ({ ready: true, observedAtEpochMs: 1000, position: { x: 0, y: 64, z: 0 }, player: { x: 0, y: 64, z: 0, health: 20 }, world: { worldId: 'intent-world', dimension: 'minecraft:overworld' }, inventory: { items: [item('water_bucket'), item('iron_pickaxe')] }, blocks: [], ...extra });
const step = (id, check, detail = '') => ({ id, label: id, check, detail, status: 'pending', kind: 'manual', dependsOn: [], evidence: null });
const plan = (v, rec, steps) => v.operate(rec, { operation: 'replace', plan: { steps } });
const intent = (v, rec, value) => v.operate(rec, { operation: 'intent', intent: value });
const parse = input => decodeModelFacts(JSON.parse(input.slice(input.indexOf('\n') + 1)));

test('Doing carries model-authored objective, reason, destination and last stop across handbacks until changed or complete', async () => {
 const v = new LiveTaskViews(), rec = r();
 await v.observe(rec, sample());
 await plan(v, rec, [step('obsidian', 'has:minecraft:obsidian*10'), step('nether', 'in:minecraft:the_nether')]);
 await intent(v, rec, { step: 'obsidian', why: 'make a portal frame', via: 'lava pool @3,64,0' });
 await v.actionReceipt(rec, { actionId: 'dig', actionType: 'dig_to', goalRevision: 1, state: 'FAILED', reasonCode: 'LAVA_AHEAD', arguments: { heading: 'east', y: -54 } });
 assert.match(v.doingLine(rec), /^Doing: obsidian: make a portal frame; via lava pool @3,64,0; last: dig_to LAVA_AHEAD$/);
 await v.observe(rec, sample({ observedAtEpochMs: 2000 }));
 assert.match(v.doingLine(rec), /make a portal frame.*lava pool/);
 await intent(v, rec, { step: 'nether', why: 'enter after lighting the frame' });
 assert.match(v.doingLine(rec), /nether: enter after lighting/);
 await intent(v, rec, { step: 'obsidian', why: 'finish frame' });
 await v.observe(rec, sample({ inventory: { items: [item('obsidian'), { itemId: 'minecraft:obsidian', count: 9 }] } }));
 assert.doesNotMatch(v.doingLine(rec), /Doing: obsidian|finish frame/);
 assert.equal(v.doingLine({ ...rec, currentGoal: '' }), null);
});

test('Doing falls back to the model plan and keeps the chosen heading through a look result; fresh world clears it', async () => {
 const v = new LiveTaskViews(), rec = r();
 await v.observe(rec, sample());
 await plan(v, rec, [step('lava', 'lava:10', 'find lava for the frame')]);
 await v.actionReceipt(rec, { actionId: 'travel', actionType: 'travel_to', goalRevision: 1, state: 'FAILED', reasonCode: 'PROGRESS_STUCK', arguments: { x: 40, y: 60, z: 5 } });
 await v.actionReceipt(rec, { actionId: 'look', actionType: 'look', goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'LOOKED' });
 assert.match(v.doingLine(rec), /Doing: lava: find lava for the frame; heading @40,60,5; last: look LOOKED/);
 await v.actionReceipt(rec, { actionId: 'forward', actionType: 'travel_to', goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'DISTANCE_REACHED', arguments: { yaw: 0, distance: 80 } });
 assert.match(v.doingLine(rec), /heading yaw 0 for 80 blocks/);
 await v.observe(rec, sample({ world: { worldId: 'another', dimension: 'minecraft:overworld' } }));
 assert.equal(v.doingLine(rec), 'Doing: Beat Minecraft');
});

test('Doing and skill facts survive full and lean encoding on consecutive wakes, including planning wakes, within a short byte budget', async () => {
 const v = new LiveTaskViews(), rec = r(), previous = process.env.ARENA_LEAN_INPUT;
 const o = sample({ blocks: [{ blockId: 'minecraft:lava', x: 3, y: 64, z: 0, state: { level: '0' } }] });
 await v.observe(rec, o);
 await plan(v, rec, [step('obsidian', 'has:minecraft:obsidian*10')]);
 await intent(v, rec, { step: 'obsidian', why: 'frame for Nether', via: 'lava pool @3,64,0' });
 const doing = v.doingLine(rec), skillFits = v.skillLine(rec);
 assert.ok(Buffer.byteLength(doing) <= 320);
 assert.ok(Buffer.byteLength(skillFits) <= SKILL_FITS_BYTES);
 try {
  for (const lean of ['0','1']) {
   process.env.ARENA_LEAN_INPUT = lean;
   const views = new ModelObservationViews();
   for (let n = 0; n < 2; n++) {
    const input = buildNativeEventInput(rec, { event: 'observation', observation: o, doing, skillFits });
    const encoded = encodeNativeEventInput(input, views), out = parse(encoded);
    assert.equal(out.doing, doing);
    assert.match(out.skillFits, /cast_obsidian.*water_bucket/);
    assert.ok(encoded.indexOf('"doing"') < encoded.indexOf('"observation"'));
    const without = encodeNativeEventInput(buildNativeEventInput(rec, { event: 'observation', observation: o, skillFits }), new ModelObservationViews());
    if (n === 0) assert.ok(Buffer.byteLength(encoded) - Buffer.byteLength(without) <= 360);
   }
   const planning = parse(buildNativeEventInput(rec, { event: 'program_planning_due', observation: o, doing }));
   assert.equal(planning.doing, doing);
  }
 } finally { if (previous === undefined) delete process.env.ARENA_LEAN_INPUT; else process.env.ARENA_LEAN_INPUT = previous; }
});

test('iron-step anchors name the ore and break_block only with a live suitable carried pickaxe and nearby visible ore', async () => {
 const o = sample({ inventory: { items: [item('stone_pickaxe')] }, blocks: [{ blockId: 'minecraft:iron_ore', x: 2, y: 64, z: 0 }] });
 const needs = [{ id: 'minecraft:iron_ingot', have: 0, need: 3, step: 'iron' }];
 assert.match(skillFitsLine({ observation: o, needs }), /break_block x:2 y:64 z:0 with stone_pickaxe.*for iron/);
 for (const bad of [sample({ blocks: o.blocks, inventory: { items: [item('wooden_pickaxe')] } }), { ...o, continuity: { rememberedSections: ['blocks'] } }, { ...o, blocks: [{ ...o.blocks[0], visible: false }] }, { ...o, blocks: [{ ...o.blocks[0], x: 30 }] }, { ...o, inventory: { items: [item('iron_pickaxe', 0)] } }]) assert.equal(skillFitsLine({ observation: bad, needs }), null);
 const v = new LiveTaskViews(), rec = r();
 await v.observe(rec, o);
 await plan(v, rec, [step('iron', 'tool:pickaxe:iron+')]);
 assert.match(v.skillLine(rec), /break_block.*for iron/);
});

test('distant owned stations share one portability notice; crafting an inferior tool reports usable higher gear in wakes and action results', () => {
 const o = sample({ leftBehind: [{ blockId: 'minecraft:crafting_table', x: 80, y: 64, z: 0 }, { blockId: 'minecraft:furnace', x: 81, y: 64, z: 0 }] });
 assert.equal(workNotices(o).length, 1);
 assert.match(workNotices(o)[0], /80 blocks away.*Can mine and carry/);
 const receipt = { actionType: 'craft_table', state: 'SUCCEEDED', reasonCode: 'CRAFT_CONFIRMED', message: 'Crafted 1 minecraft:stone_pickaxe through visible menu clicks' };
 o.lastResult = receipt;
 assert.match(workNotices(o).join('\n'), /already carrying higher-tier iron_pickaxe/);
 const result = new ModelObservationViews().prepare({ ...receipt, postAction: { freshness: { fresh: true }, observation: o } }, { kind: 'action', actionType: 'craft_table' }).value;
 assert.match(result.notice.join('\n'), /already carrying higher-tier iron_pickaxe/);
 assert.equal(result.notice.filter(s => s.startsWith('Your placed')).length, 1);
 for (const bad of [item('iron_pickaxe', 0), item('stone_pickaxe')]) assert.doesNotMatch(workNotices({ ...o, inventory: { items: [bad] } }).join('\n'), /higher-tier/);
 assert.doesNotMatch(workNotices({ ...o, continuity: { rememberedSections: ['inventory'] } }).join('\n'), /higher-tier/);
});


test('the model active step anchors a wake ahead of an earlier reopened step; heading survives plan reload', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-wake-'));
 const rec = r();
 try {
  const v = new LiveTaskViews({ directory });
  await v.observe(rec, sample());
  await plan(v, rec, [step('bed', 'spawn:bed'), { ...step('lava', 'lava:10', 'find a pool for the portal'), status: 'active' }]);
  assert.match(v.doingLine(rec), /^Doing: lava: find a pool/);
  assert.match(v.goalLine(rec), /next: lava/);
  await v.actionReceipt(rec, { actionId: 'descend', actionType: 'dig_to', goalRevision: 1, state: 'FAILED', reasonCode: 'LAVA_AHEAD', arguments: { heading: 'east', y: -54 } });
  await v.observe(rec, sample({ observedAtEpochMs: 2000, player: { x: 0, y: 64, z: 0, dead: true } }));
  assert.match(v.doingLine(rec), /^Doing: lava: find a pool/, 'a death changes facts, not the model authored focus');
  await v.flush();
  const restored = new LiveTaskViews({ directory });
  await restored.observe(rec, sample());
  assert.match(restored.doingLine(rec), /Doing: lava.*heading east to y-54/);
  await intent(restored, rec, { step: 'lava', why: '界'.repeat(100), via: '界'.repeat(100) });
  assert.ok(Buffer.byteLength(restored.doingLine(rec)) <= 320);
  await restored.actionReceipt(rec, { actionId: 'stop', actionType: 'dig_to', goalRevision: 1, state: 'FAILED', reasonCode: 'LAVA_AHEAD' });
  assert.match(restored.doingLine(rec), /last: dig_to LAVA_AHEAD$/, 'UTF-8 intent clipping preserves the last result');
  await restored.flush();
 } finally { await rm(directory, { recursive: true, force: true }); }
});
