#!/usr/bin/env node
// Provider-free lone blaze fixture: node scripts/quality/test-lone-blaze-live.mjs OUT_DIR
// Does a shielded sword fight close on one blaze that hovers 3-7 blocks off, one block above or below the body's deck?
// A blaze that sees the player sinks to its level but only shoots; it never comes into sword reach. Real fortress fights
// held the deck behind the shield and landed 0-1 hits. The body carries what it really reaches a fortress with: a stone
// sword, a shield, cobblestone and food, no armour. The default reflexes are armed as the coordinator arms them
// (ReflexBook). The stand-in only calls fight_target on the blaze (pursue, shield) until it dies or CALLS run out.
// Cases (CASES, comma list), each on a flat stone floor with the body's walking surface at feet 101:
//   up     the body on the floor; a nether-brick deck one block higher starts 2 blocks ahead; the blaze over it 5 off.
//   down   the body on a pad one block up; the floor ahead is one lower; the blaze over the floor 5 off.
//   drop2  control: the body on a pad two blocks up; the blaze below 5 off. The fight must not step off the pad.
// BLAZE_AI=0 summons the blaze with NoAI (it neither moves nor shoots), so the geometry stays exact; the default keeps
// vanilla's AI, as in a fortress. Per trial: kill, blaze health lost, sword hits (from the fight result), rods picked,
// deaths and damage taken (vanilla counters), lowest feet y, and whether the body left its pad in drop2 (droppedTwo).
// Env: ARENA_JAR, CASES (default up,down,drop2), TRIALS (default 5), CALLS (default 4), BLAZE_AI, DIST (default 5).
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set.
// A trial passes when the blaze dies (up, down) or the body stays on its pad (drop2); result.json carries the verdicts.
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
const USAGE = 'usage: node scripts/quality/test-lone-blaze-live.mjs OUT_DIR [--descriptive] (under slot.sh live, ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const outArg = cli.find(arg => !arg.startsWith('--'));
if (!outArg || !process.env.ARENA_HEADLESS_SERVER_TEMPLATE || !process.env.SLOT_PORT_BASE || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const out = resolve(outArg), jar = resolve(process.env.ARENA_JAR ?? join(root, MOD_JAR));
const TICK_RATE = unshownTickRate('a new fixture, not yet in a 20 vs 60 TPS A/B');
const CASES = (process.env.CASES ?? 'up,down,drop2').split(',').filter(Boolean);
const TRIALS = Number(process.env.TRIALS ?? 5), CALLS = Number(process.env.CALLS ?? 4), DIST = Number(process.env.DIST ?? 5);
const BLAZE_AI = process.env.BLAZE_AI !== '0';
// Body deck feet y and blaze feet y per case. The blaze hovers half a block over its level.
const GEOMETRY = { up: { body: 101, blaze: 102 }, down: { body: 102, blaze: 101 }, drop2: { body: 103, blaze: 101 } };
for (const c of CASES) if (!GEOMETRY[c]) throw new Error(`unknown case ${c}`);
const hash = createHash('sha256'); for await (const chunk of createReadStream(jar)) hash.update(chunk);
await mkdir(out, { recursive: true });
const results = { kind: 'provider-free lone blaze sword fight', jar, jarSha256: hash.digest('hex'), blazeAI: BLAZE_AI, dist: DIST, tickRate: TICK_RATE, trials: [] };
const save = () => writeFile(join(out, 'lone-blaze.json'), JSON.stringify(results, null, 1));
const number = text => { const m = /(-?[\d.]+)[fd]?\s*$/.exec(String(text ?? '').trim()); return m ? Number(m[1]) : null; };
let s;
const blazeHealth = async () => number(await s.command('data get entity @e[type=minecraft:blaze,tag=lone,limit=1] Health')) ?? 0;
const feetY = async () => number(await s.command('data get entity Probe Pos[1]'));
// "Found 2 matching item(s) on player Probe": the first number; "No items were found" has none.
const rods = async () => Number(/(\d+)/.exec(String(await s.command('clear Probe minecraft:blaze_rod 0') ?? ''))?.[1] ?? 0);
try {
 s = await boot(out, { jar, template: process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port: Number(process.env.SLOT_PORT_BASE), seed: 20261125, tickRate: TICK_RATE });
 await s.command('gamerule minecraft:spawn_mobs false'); await s.command('difficulty hard');
 await s.command('time set noon'); await s.command('gamerule minecraft:advance_time false');
 await s.command('forceload add -16 -16 32 16');
 const registered = s.inbox.wait('agent_registered'); await s.command('mineagen summon gpt-6.1-sol low Probe');
 const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start'); await s.command('mineagen start Probe Survive for 3600 seconds.');
 s.record.goalRevision = (await started).payload.goalRevision;
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 await s.command('gamemode survival Probe');
 const readDamage = await damageCounter(text => s.command(text), 'Probe');
 const deaths = () => deathCounter(text => s.command(text), 'Probe', { objective: 'deaths', unsetIsZero: true });
 // The default rules as the coordinator arms them on a body's first live sample (as test-ledge-blaze-live.mjs).
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
  const g = GEOMETRY[kase];
  for (let trial = 0; trial < TRIALS; trial++) {
   await s.normalRate();
   await s.setReflexes([]);
   for (const type of ['blaze', 'small_fireball', 'item']) await s.command(`kill @e[type=minecraft:${type}]`);
   // Room: stone floor (walking surface feet 101), open air above, then the case's deck or pad.
   await s.command('fill -12 100 -8 20 100 8 minecraft:stone');
   await s.command('fill -12 101 -8 20 110 8 minecraft:air');
   if (kase === 'up') await s.command('fill 2 101 -3 9 101 3 minecraft:nether_bricks');
   else await s.command(`fill -3 101 -2 0 ${g.body - 1} 2 minecraft:nether_bricks`);
   if (await s.command('execute if entity Probe[gamemode=spectator]').then(t => /passed/.test(t)).catch(() => false)) await s.command('gamemode survival Probe');
   await s.command(`tp Probe -0.5 ${g.body} 0.5 -90 0`);
   await s.command('clear Probe'); await s.command('effect clear Probe');
   await s.command('effect give Probe minecraft:instant_health 1 4 true'); await s.command('effect give Probe minecraft:saturation 1 20 true');
   await s.command('item replace entity Probe hotbar.0 with minecraft:stone_sword');
   await s.command('item replace entity Probe hotbar.1 with minecraft:cobblestone 64');
   await s.command('item replace entity Probe hotbar.2 with minecraft:cooked_beef 4');
   await s.command('item replace entity Probe weapon.offhand with minecraft:shield');
   await s.observe();
   const bx = -0.5 + DIST;
   await s.command(`summon minecraft:blaze ${bx} ${g.blaze + 0.5} 0.5 {Tags:["lone"],PersistenceRequired:1b${BLAZE_AI ? '' : ',NoAI:1b'}}`);
   await arm();
   const row = { name: `${kase}-${trial + 1}`, kase, trial, calls: [], deaths: 0, startedAt: Date.now() };
   const damageBefore = await readDamage(), deathsBefore = await deaths().catch(() => null), rodsBefore = await rods();
   const startHealth = await blazeHealth();
   await s.fastRate();
   const t0 = s.clock.now();
   let lowest = await feetY();
   const sampler = setInterval(() => { feetY().then(y => { if (y !== null && (lowest === null || y < lowest)) lowest = y; }).catch(() => {}); }, 250);
   try {
    for (let call = 0; call < CALLS; call++) {
     if (await blazeHealth() <= 0) break;
     const o = await s.observe();
     if (o.player?.dead || (o.player?.health ?? 20) <= 0) break;
     const target = (o.entities ?? []).find(x => x.type === 'minecraft:blaze');
     if (!target) { row.lostTarget = true; break; }
     await s.act('select_item', { itemId: 'minecraft:stone_sword' }).catch(() => {});
     const r = await s.act('fight_target', { targetId: target.uuid, pursue: true, shield: true, fleeAtHealth: 6, collect: true, timeoutMs: 15000 }, 30000);
     const msg = r.message ?? '';
     row.calls.push({ state: r.state, reasonCode: r.reasonCode, hits: Number((/(\d+) hit\(s\)/.exec(msg) ?? /hits (\d+)/.exec(msg) ?? [])[1] ?? 0), message: msg.slice(0, 600) });
    }
   } finally { clearInterval(sampler); }
   row.seconds = Math.round((s.clock.now() - t0) / 1000);
   await s.normalRate();
   const endHealth = await blazeHealth();
   row.kill = endHealth <= 0; row.blazeHealthLost = Math.round((startHealth - Math.max(0, endHealth)) * 10) / 10;
   row.hits = row.calls.reduce((n, c) => n + c.hits, 0);
   row.rodsPicked = Math.max(0, (await rods()) - rodsBefore);
   row.lowestFeetY = lowest;
   row.droppedTwo = kase === 'drop2' && lowest !== null && lowest < g.body - 0.5;
   // No feet reading at all is no evidence the body stayed on its pad: finishRun marks the trial INVALID.
   if (kase === 'drop2' && lowest === null) (row.integrity ??= []).push({ file: 'feet', error: 'no feet position read during the trial' });
   recordDamageEvidence(row, damageBefore, await readDamage());
   recordDeathEvidence(row, deathsBefore, await deaths().catch(() => null));
   row.pass = kase === 'drop2' ? !row.droppedTwo : row.kill;
   if (!row.pass) row.failReason = kase === 'drop2' ? `dropped to feet ${lowest}` : `blaze alive, ${row.hits} hit(s), lost ${row.blazeHealthLost}`;
   row.finishedAt = Date.now();
   results.trials.push(row); await save();
   console.log(JSON.stringify({ kase, trial, kill: row.kill, hits: row.hits, lost: row.blazeHealthLost, rods: row.rodsPicked, deaths: row.deaths, damage: row.damageTaken, lowest, droppedTwo: row.droppedTwo, codes: row.calls.map(c => c.reasonCode) }));
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
 // An unread damage or death counter is unknown, not zero: those totals become null and the count of such trials shows.
 const unknown = k => rows.filter(t => t[k] === null || t[k] === undefined).length;
 const known = (k, v) => unknown(k) ? null : v;
 summary[kase] = { trials: rows.length, kills: rows.filter(t => t.kill).length, hits: sum('hits'), blazeHealthLost: Math.round(sum('blazeHealthLost') * 10) / 10,
  rodsPicked: sum('rodsPicked'), deaths: known('deaths', sum('deaths')), damageTaken: known('damageTaken', Math.round(sum('damageTaken') * 10) / 10),
  unknownDeaths: unknown('deaths'), unknownDamage: unknown('damageTaken'), droppedTwo: rows.filter(t => t.droppedTwo).length };
}
results.summary = summary;
await save(); console.log(JSON.stringify(summary));
const rows = results.error && !results.trials.length ? [{ name: 'boot', error: results.error, startedAt: Date.now(), finishedAt: Date.now() }] : results.trials;
const report = await finishRun(rows, { file: join(out, 'result.json'), planned: CASES.length * TRIALS, strict });
console.log(`[lone-blaze] ${report.line}`);
process.exit(report.exitCode);
