#!/usr/bin/env node
// Model-free body fixtures. Run under B/api/fix-slot.sh with JAVA_TOOL_OPTIONS=-XX:ActiveProcessorCount=2.
// Operator commands create each room and kit; the actual skill owns every break, move, drop and placement.
// FIXTURE_TICK_RATE runs each dig_to faster: the room, kit and the settle after the teleport stay at 20 TPS (that wait
// follows forceload and a teleport, so it is chunk loading, wall-clock work), and only the action runs at the raised rate
// (its timeoutMs is game time). Rows record seconds (game), wallSeconds and rates.
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { boot, unshownTickRate } from './watch-replay.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { damageCounter, recordDamageEvidence, deathCounter, recordDeathEvidence } from './lib/damage-counter.mjs';
const out = resolve(process.argv[2]);
const jar = resolve(process.argv[3] ?? MOD_JAR);
assert.ok(process.env.SLOT_PORT_BASE && process.env.ARENA_HEADLESS_SERVER_TEMPLATE && process.env.JAVA_HOME);
await mkdir(out, { recursive: false });
const rows = [];
const s = await boot(out, { jar, template: process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port: Number(process.env.SLOT_PORT_BASE), world: null, seed: '20261018', tickRate: unshownTickRate('it already fails at 20 TPS, so an A/B cannot show the same game at 60') });
const sleep = ms => new Promise(done => setTimeout(done, ms));
const A = 'Probe';
try {
 const registered = s.inbox.wait('agent_registered');
 await s.command(`forceload add 0 0`);
 await s.command(`fill -3 57 -3 12 65 12 minecraft:stone`);
 await s.command(`setblock 0 65 0 minecraft:stone`);
 await s.command(`execute positioned 0.5 66 0.5 run mineagen summon gpt-6.1-sol low ${A}`);
 const e = await registered;
 s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 const started = s.inbox.wait('goal_control', e => e.payload.operation === 'start');
 await s.command(`mineagen start ${A} Survive for 1200 seconds.`);
 s.record.goalRevision = (await started).payload.goalRevision;
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 await s.command('difficulty peaceful');
 // Harm evidence for the lava and water rooms: vanilla's cumulative damage and death counters.
 const readDamage = await damageCounter(text => s.command(text), A);
 const deaths = () => deathCounter(text => s.command(text), A, { objective: 'deaths', unsetIsZero: true });
 const cases = [
  { name: 'cave-default-small', cave: 'small', args: {}, expect: 'DIG_GOAL_REACHED' },
  { name: 'cave-false', cave: 'small', args: { throughCaves: false }, expect: 'DIG_GOAL_REACHED' },
  { name: 'drop-false', drop: 2, args: { throughCaves: false }, expect: 'CAVE_OPENING' },
  { name: 'cave-explicit-small', cave: 'small', args: { throughCaves: 'small' }, expect: 'DIG_GOAL_REACHED' },
  { name: 'cave-large-default', cave: 'large', args: {}, expect: 'DIG_GOAL_REACHED' },
  { name: 'cave-large-true', cave: 'large', args: { throughCaves: true }, expect: 'DIG_GOAL_REACHED' },
  { name: 'full-default', full: true, args: {}, expect: 'INVENTORY_FULL' },
  { name: 'full-discard', full: true, args: { discard: ['cobblestone'] }, expect: 'DIG_GOAL_REACHED' },
  { name: 'full-unlisted', full: true, args: { discard: ['tuff'] }, expect: 'INVENTORY_FULL' },
  { name: 'water-default', fluid: 'water', args: {}, expect: 'DIG_GOAL_REACHED' },
  { name: 'water-noseal', fluid: 'water', args: { sealFluids: false }, expect: 'WATER_AHEAD' },
  { name: 'water-seal', fluid: 'water', args: { sealFluids: true }, expect: 'DIG_GOAL_REACHED' },
  { name: 'water-seal-no-caves', fluid: 'water', args: { throughCaves: false, sealFluids: true }, expect: 'DIG_GOAL_REACHED' },
  { name: 'lava-drop', lavaDrop: true, drop: 5, args: { sealFluids: true }, expect: ['LAVA_AHEAD', 'CAVE_OPENING'] },
  { name: 'deep-drop-default', drop: 5, args: {}, expect: 'CAVE_OPENING' },
  { name: 'lava-hidden-seal', hidden: true, args: { sealFluids: true }, expect: 'LAVA_AHEAD' },
  { name: 'lava-default', fluid: 'lava', args: {}, expect: 'LAVA_AHEAD' },
  { name: 'lava-seal', fluid: 'lava', args: { sealFluids: true }, expect: 'LAVA_AHEAD' },
  { name: 'lava-purpose', fluid: 'lava', args: { sealFluids: true, stopWhenSeen: 'minecraft:lava' }, expect: ['LAVA_AHEAD', 'TARGET_SEEN'] },
 ].filter(c => !process.env.DIG_OPTION_CASES || process.env.DIG_OPTION_CASES.split(',').includes(c.name));
 for (const [i, c] of cases.entries()) {
  await s.normalRate();
  const z = i * 20;
  await s.command(`gamemode creative ${A}`);
  await s.command(`forceload add -4 ${z - 4} 14 ${z + 10}`);
  await s.command(`tp ${A} 0.5 70 ${z + 0.5}`);
  await s.command(`fill -3 56 ${z - 3} 12 68 ${z + 9} minecraft:stone`);
  await s.command(`fill 0 60 ${z} 0 61 ${z} minecraft:air`);
  if (c.cave) await s.command(`fill 2 60 ${z + 1} ${c.cave === 'large' ? 7 : 3} ${c.cave === 'large' ? 64 : 61} ${z + (c.cave === 'large' ? 6 : 2)} minecraft:air`);
  if (c.drop) await s.command(`fill 2 ${60 - c.drop} ${z - 1} 6 61 ${z + 1} minecraft:air`);
  if (c.lavaDrop) await s.command(`fill 2 54 ${z - 1} 6 54 ${z + 1} minecraft:lava`);
  if (c.hidden) await s.command(`setblock 2 60 ${z + 2} minecraft:lava`);
  if (c.fluid) await s.command(`setblock 2 60 ${z + 1} minecraft:${c.fluid}`);
  await s.command(`clear ${A}`);
  await s.command(`item replace entity ${A} hotbar.0 with minecraft:iron_pickaxe`);
  await s.command(`item replace entity ${A} hotbar.1 with minecraft:cobblestone ${c.full ? 64 : 32}`);
  if (c.fluid === 'lava') {
   await s.command(`item replace entity ${A} weapon.offhand with minecraft:water_bucket`);
   await s.command(`item replace entity ${A} hotbar.2 with minecraft:bucket`);
  }
  if (c.full) for (let slot = 2; slot < 36; slot++) await s.command(`item replace entity ${A} container.${slot} with minecraft:diamond 64`);
  await s.command(`tp ${A} 0.5 60 ${z + 0.5} -90 0`);
  await s.command(`gamemode survival ${A}`);
  await s.command(`effect give ${A} minecraft:saturation 2 10 true`);
  await sleep(1200);
  if (c.hidden) await s.command(`playsound minecraft:block.lava.ambient master ${A} 2 60 ${z + 2} 1 1`);
  await s.observe();
  const args = { pattern: 'tunnel', x: 6, z, heading: 'east', timeoutMs: 30000, ...c.args };
  const damageBefore = await readDamage(), deathsBefore = await deaths().catch(() => null);
  await s.fastRate();
  const t0 = s.clock.now(), wall0 = Date.now(), timer = await s.gameTimer();
  const result = await s.act('dig_to', args);
  const tick = { seconds: Math.round((s.clock.now() - t0) / 1000), wallSeconds: Math.round((Date.now() - wall0) / 1000), gameSeconds: Math.round((await timer.elapsed()) / 1000), rates: await timer.rates().catch(() => null) };
  await s.normalRate();
  recordDamageEvidence(tick, damageBefore, await readDamage());
  recordDeathEvidence(tick, deathsBefore, await deaths().catch(() => null));
  const inventory = await s.command(`data get entity ${A} Inventory`);
  const items = await s.command(`execute at ${A} as @e[type=minecraft:item,distance=..12] run data get entity @s Item`);
  const row = { name: c.name, args, expect: c.expect, result, inventory, items, position: await s.command(`data get entity ${A} Pos`), ...tick };
  row.pass = [c.expect].flat().includes(result.reasonCode);
  if (c.name === 'full-discard') row.pass &&= /Q-dropped cobblestone\*64/.test(result.message) && /cobblestone/.test(items);
  if (c.name === 'full-default') row.pass &&= /candidate junk stacks: cobblestone\*64 slot 1/.test(result.message) && /discard:/.test(result.message);
  // Sealing is on by default and carries on only past water; a lava plug hands the turn back with the cast offer.
  if (c.fluid === 'water' && c.args.sealFluids !== false) row.pass &&= /sealed fluids with/.test(result.message);
  if (c.name === 'lava-seal') row.pass &&= /plugged it with cobblestone at 2,60,/.test(result.message) && /cast_obsidian/.test(result.message);
  // A cave beside the tunnel is noted and passed, whatever throughCaves says; only a drop under the cut stops it.
  if (c.name === 'cave-false' || c.name === 'cave-large-default') row.pass &&= /dug past caves at 2,6/.test(result.message);
  if (c.name === 'lava-default') row.pass &&= /water bucket held/.test(result.message) && /cast_obsidian \{x:2,y:60,z:/.test(result.message);
  if (c.lavaDrop) row.pass &&= !/sealed fluids with/.test(result.message);
  // One covered lava source is too small to cast a portal from, so it is plugged like a spill.
  if (c.name === 'lava-purpose') row.pass &&= /a pocket too small for a portal cast/.test(result.message) && /plugged it with cobblestone/.test(result.message);
  rows.push(row);
  await writeFile(join(out, 'results.json'), JSON.stringify(rows, null, 2));
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${c.name}: ${result.reasonCode}`);
 }
 await writeFile(join(out, 'manifest.json'), JSON.stringify({ modelCalls: 0, fixtureSetupUsesOperatorCommands: true, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), passed: rows.filter(x => x.pass).length, total: rows.length, tickRate: s.tickRate, held: await s.tickReport() }, null, 2));
 assert.ok(rows.every(x => x.pass), 'fixture failures; see results.json');
} finally {
 await s.stop();
 await rm(join(out, 'server/world'), { recursive: true, force: true });
 await rm(join(out, 'server/world_nether'), { recursive: true, force: true });
 await rm(join(out, 'server/world_the_end'), { recursive: true, force: true });
}
