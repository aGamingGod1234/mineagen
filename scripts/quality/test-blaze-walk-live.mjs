#!/usr/bin/env node
// Provider-free blaze walk fixture: node scripts/quality/test-blaze-walk-live.mjs OUT_DIR
// Does a travel_to across an open nether-brick deck keep moving while a stray blaze shoots at the body, or halt in the
// open? Real games from fortress entrances stopped 10-12 walks a side for a blaze more than 6 blocks off, and each stop
// left the body standing while the model answered. The body carries what it really reaches a fortress with: a stone
// sword, a shield, cobblestone and food, no armour; the default reflexes are armed as the coordinator arms them.
// The stand-in calls travel_to the far end of the deck again after every stop, up to CALLS times, as a model that only
// wants to get past would. Run it twice on one jar, once with REPLAY_JAVA_OPTS=-Dmineagen.travel.passBlazes=false.
// Cases (CASES, comma list), a 48-block deck at feet 101 from x 0 to x 44:
//   side   a blaze 14 blocks off the route at its middle (x 22, z 14), 3 above the deck.
//   ahead  a blaze past the far end and off to one side (x 52, z 10), 3 above the deck.
// Per trial: arrived, travel calls, stop codes, seconds to arrive, damage taken and deaths (vanilla counters).
// Env: ARENA_JAR, CASES (default side,ahead), TRIALS (default 4), CALLS (default 8).
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set.
// A trial passes when the body reaches the far end alive; result.json carries the verdicts.
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { boot, unshownTickRate } from './watch-replay.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { damageCounter, recordDamageEvidence, deathCounter, recordDeathEvidence } from './lib/damage-counter.mjs';
import { MOD_JAR } from './mod-jar.mjs';

const root = resolve(import.meta.dirname, '../..');
const USAGE = 'usage: node scripts/quality/test-blaze-walk-live.mjs OUT_DIR [--descriptive] (under slot.sh live, ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const outArg = cli.find(arg => !arg.startsWith('--'));
if (!outArg || !process.env.ARENA_HEADLESS_SERVER_TEMPLATE || !process.env.SLOT_PORT_BASE || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const out = resolve(outArg), jar = resolve(process.env.ARENA_JAR ?? join(root, MOD_JAR));
const TICK_RATE = unshownTickRate('a new fixture, not yet in a 20 vs 60 TPS A/B');
const CASES = (process.env.CASES ?? 'side,ahead').split(',').filter(Boolean);
const TRIALS = Number(process.env.TRIALS ?? 4), CALLS = Number(process.env.CALLS ?? 8);
const BLAZE = { side: { x: 22.5, z: 14.5 }, ahead: { x: 52.5, z: 10.5 } };
for (const c of CASES) if (!BLAZE[c]) throw new Error(`unknown case ${c}`);
const END = { x: 44.5, y: 101, z: 0.5 };
const hash = createHash('sha256'); for await (const chunk of createReadStream(jar)) hash.update(chunk);
await mkdir(out, { recursive: true });
const results = { kind: 'provider-free blaze walk', jar, jarSha256: hash.digest('hex'), javaOpts: process.env.REPLAY_JAVA_OPTS ?? '', tickRate: TICK_RATE, trials: [] };
const save = () => writeFile(join(out, 'blaze-walk.json'), JSON.stringify(results, null, 1));
let s;
try {
 s = await boot(out, { jar, template: process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port: Number(process.env.SLOT_PORT_BASE), seed: 20261126, tickRate: TICK_RATE });
 await s.command('gamerule minecraft:spawn_mobs false'); await s.command('difficulty hard');
 await s.command('time set noon'); await s.command('gamerule minecraft:advance_time false');
 await s.command('forceload add -16 -24 64 24');
 const registered = s.inbox.wait('agent_registered'); await s.command('mineagen summon gpt-6.1-sol low Probe');
 const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start'); await s.command('mineagen start Probe Survive for 3600 seconds.');
 s.record.goalRevision = (await started).payload.goalRevision;
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 await s.command('gamemode survival Probe');
 const readDamage = await damageCounter(text => s.command(text), 'Probe');
 const deaths = () => deathCounter(text => s.command(text), 'Probe', { objective: 'deaths', unsetIsZero: true });
 const book = new ReflexBook();
 const arm = async () => {
  book.observeContext(s.record.agentId, await s.observe());
  const payload = book.payload(s.record.agentId);
  s.revision = Math.max((s.revision ?? 0) + 1, payload.revision);
  await s.bridge.send('reflex_update', s.record.agentId, { ...payload, revision: s.revision });
  for (let i = 0; i < 50; i++) {
   const o = await s.observe();
   if (o.reflexes?.revision === s.revision && (o.reflexes.rules ?? []).some(rule => rule.id === 'default-defend')) return;
   await s.clock.sleep(200);
  }
  throw new Error(`default reflexes (revision ${s.revision}) never echoed with default-defend`);
 };
 for (const kase of CASES) {
  const b = BLAZE[kase];
  for (let trial = 0; trial < TRIALS; trial++) {
   await s.normalRate();
   await s.setReflexes([]);
   for (const type of ['blaze', 'small_fireball', 'item']) await s.command(`kill @e[type=minecraft:${type}]`);
   // Room: a nether-brick deck (feet 101) over lava-free stone, open air above, the blaze's side open too.
   await s.command('fill -8 99 -20 60 100 20 minecraft:stone');
   await s.command('fill -8 101 -20 60 112 20 minecraft:air');
   await s.command('fill -2 100 -2 46 100 2 minecraft:nether_bricks');
   if (await s.command('execute if entity Probe[gamemode=spectator]').then(t => /passed/.test(t)).catch(() => false)) await s.command('gamemode survival Probe');
   await s.command('tp Probe 0.5 101 0.5 -90 0');
   await s.command('clear Probe'); await s.command('effect clear Probe'); await s.command('extinguish Probe').catch(() => {});
   await s.command('effect give Probe minecraft:instant_health 1 4 true'); await s.command('effect give Probe minecraft:saturation 1 20 true');
   await s.command('item replace entity Probe hotbar.0 with minecraft:stone_sword');
   await s.command('item replace entity Probe hotbar.1 with minecraft:cobblestone 64');
   await s.command('item replace entity Probe hotbar.2 with minecraft:cooked_beef 4');
   await s.command('item replace entity Probe weapon.offhand with minecraft:shield');
   await s.observe();
   await s.command(`summon minecraft:blaze ${b.x} 104 ${b.z} {Tags:["stray"],PersistenceRequired:1b}`);
   await arm();
   const row = { name: `${kase}-${trial + 1}`, kase, trial, calls: [], startedAt: Date.now() };
   const damageBefore = await readDamage(), deathsBefore = await deaths().catch(() => null);
   await s.fastRate();
   const t0 = s.clock.now();
   for (let call = 0; call < CALLS; call++) {
    const o = await s.observe();
    if (o.player?.dead || (o.player?.health ?? 20) <= 0) { row.died = true; break; }
    const r = await s.act('travel_to', { x: END.x, y: END.y, z: END.z, tolerance: 2, build: false, timeoutMs: 30000 }, 45000);
    row.calls.push({ state: r.state, reasonCode: r.reasonCode, message: String(r.message ?? '').slice(0, 400) });
    if (r.state === 'SUCCEEDED') { row.arrived = true; break; }
   }
   row.seconds = Math.round((s.clock.now() - t0) / 1000);
   await s.normalRate();
   row.stops = row.calls.filter(c => c.state !== 'SUCCEEDED').length;
   row.keptMoving = row.calls.some(c => /kept moving past/.test(c.message));
   recordDamageEvidence(row, damageBefore, await readDamage());
   recordDeathEvidence(row, deathsBefore, await deaths().catch(() => null));
   row.pass = row.arrived === true && !row.deaths;
   if (!row.pass) row.failReason = row.deaths ? 'died' : `not there after ${row.calls.length} call(s): ${row.calls.map(c => c.reasonCode).join(',')}`;
   row.finishedAt = Date.now();
   results.trials.push(row); await save();
   console.log(JSON.stringify({ kase, trial, arrived: !!row.arrived, stops: row.stops, seconds: row.seconds, damage: row.damageTaken, deaths: row.deaths, codes: row.calls.map(c => c.reasonCode) }));
   if (row.deaths) await s.act('respawn', {}, 10000).catch(() => {});
  }
 }
} catch (error) {
 console.error(error);
 results.error = String(error?.stack ?? error).slice(0, 1500);
} finally { await s?.stop().catch(() => {}); await save(); }
const summary = {};
for (const kase of CASES) {
 const rows = results.trials.filter(t => t.kase === kase), sum = k => rows.reduce((n, t) => n + (Number(t[k]) || 0), 0);
 const unknown = k => rows.filter(t => t[k] === null || t[k] === undefined).length;
 const known = (k, v) => unknown(k) ? null : v;
 summary[kase] = { trials: rows.length, arrived: rows.filter(t => t.arrived).length, stops: sum('stops'), seconds: sum('seconds'),
  deaths: known('deaths', sum('deaths')), damageTaken: known('damageTaken', Math.round(sum('damageTaken') * 10) / 10), keptMoving: rows.filter(t => t.keptMoving).length };
}
results.summary = summary;
await save(); console.log(JSON.stringify(summary));
const rows = results.error && !results.trials.length ? [{ name: 'boot', error: results.error, startedAt: Date.now(), finishedAt: Date.now() }] : results.trials;
const report = await finishRun(rows, { file: join(out, 'result.json'), planned: CASES.length * TRIALS, strict });
console.log(`[blaze-walk] ${report.line}`);
process.exit(report.exitCode);
