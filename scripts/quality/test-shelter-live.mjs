#!/usr/bin/env node
// Provider-free construction checks on an open platform, separate from the real-spawner acceptance bar.
// FIXTURE_TICK_RATE runs each case faster: the kit and platform stay at 20 TPS, and from the build on (build, fire set
// 800 ms into the build, fight, diagnostic drops, wait) the case runs at the raised rate, its fire timer on the fixture
// clock (s.clock). Each case records seconds (game), wallSeconds and rates.
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { boot, fixtureTickRate } from './watch-replay.mjs';
import { damageCounter, damageEvidence, deathCounter, deathEvidence } from './lib/damage-counter.mjs';
const out=resolve(process.argv[2]), jar=resolve(process.env.ARENA_JAR), template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
const hash=createHash('sha256');for await(const chunk of createReadStream(jar))hash.update(chunk);
await mkdir(out,{recursive:true});
const results={kind:'provider-free construction mechanics; no combat acceptance claim',jarSha256:hash.digest('hex'),tickRate:fixtureTickRate(),cases:[]};
let s;
try {
 s=await boot(out,{jar,template,port:Number(process.env.SLOT_PORT_BASE),seed:20261009,tickRate:fixtureTickRate()});
 await s.command('gamerule minecraft:spawn_mobs false');
 await s.command('difficulty normal');
 await s.command('forceload add -16 -16 32 32');
 await s.command('fill -8 100 -8 24 100 8 minecraft:stone');
 await s.command('fill -8 101 -8 24 106 8 minecraft:air');
 const cases=[['north','minecraft:cobblestone',true],['east','minecraft:nether_bricks',true],['south','minecraft:cobbled_deepslate',true],['west','minecraft:cobblestone',false]];
 for(let i=0;i<cases.length;i++){
  await s.normalRate();
  if(i===0){
  const registered=s.inbox.wait('agent_registered');await s.command('mineagen summon gpt-6.1-sol low Probe');
  const e=await registered;s.record={...(e.payload.record??e.payload),agentId:e.agentId};
  await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
  const started=s.inbox.wait('goal_control',g=>g.payload.operation==='start');await s.command('mineagen start Probe Survive for 1200 seconds.');
  s.record.goalRevision=(await started).payload.goalRevision;
  await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
  await s.command('gamemode survival Probe');
  }
  const [opening,itemId,roof]=cases[i],x=i*5;
  await s.command('kill @e[type=minecraft:blaze]');
  await s.command(`tp Probe ${x+0.5} 101 0.5 0 0`);
  await s.command('clear Probe');
  await s.command(`give Probe ${itemId} 48`);
  await s.command('give Probe minecraft:iron_pickaxe');
  if(i===1)await s.command(`setblock ${x} 102 -1 minecraft:nether_brick_fence`);
  await s.idleSleep(500);
  const before=await s.observe();
  const floor=await s.command(`execute if block ${x} 100 0 minecraft:stone run time query gametime`);
  if(!/time is/i.test(floor)||Math.hypot(before.position.x-x-0.5,before.position.y-101,before.position.z-0.5)>1.0)throw new Error('Invalid construction fixture setup '+JSON.stringify({floor,position:before.position}));
  // Harm evidence (the fire case): vanilla's cumulative damage and death counters.
  const readDamage=await damageCounter(text=>s.command(text),'Probe'),deaths=()=>deathCounter(text=>s.command(text),'Probe',{objective:'deaths',unsetIsZero:true});
  const damageBefore=await readDamage(),deathsBefore=await deaths();
  await s.fastRate();
  const t0=s.clock.now(),wall0=Date.now(),timer=await s.gameTimer();
  // Fire 800 ms of game time into the build (wall time at 20 TPS), unless the build ended first.
  let ignition,built=false;if(i===2)s.clock.sleep(800).then(()=>{if(!built)ignition=s.command(`setblock ${x} 101 0 minecraft:fire`);});
  const result=await s.act('build_shelter',{x,y:101,z:0,opening,itemId,roof,timeoutMs:60000});
  built=true;await ignition;
  let o=await s.observe();
  const row={opening,itemId,roof,result,startPosition:before.position,position:o.position};
  if(result.state==='SUCCEEDED'){
   const [dx,dz]={north:[0,-1],east:[1,0],south:[0,1],west:[-1,0]}[opening];
   await s.command(`give Probe minecraft:iron_sword`);
   await s.command(`summon minecraft:blaze ${x+0.5+dx*2} 102 ${0.5+dz*2} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`);
   await s.act('look_at',{x:x+0.5+dx*2,y:102.9,z:0.5+dz*2});
   o=await s.observe();
   const blaze=o.entities?.find(e=>e.type==='minecraft:blaze'&&e.alive!==false);
   row.fight=blaze?await s.act('fight_target',{targetId:blaze.uuid,pursue:false,timeoutMs:8000}):{state:'ERROR',reasonCode:'FIXTURE_BLAZE_NOT_SEEN'};
   await s.command('kill @e[type=minecraft:item]');
   o=await s.observe();
   row.rodsBeforeDiagnosticDrops=(o.inventory?.items??[]).filter(i=>i.itemId==='minecraft:blaze_rod').reduce((n,i)=>n+i.count,0);
   // Diagnostic drops only: this checks vanilla pickup inside and on the sill, not natural-loot yield.
   await s.command(`summon minecraft:item ${x+0.5} 101.2 0.5 {Item:{id:"minecraft:blaze_rod",count:1},PickupDelay:0s}`);
   await s.command(`summon minecraft:item ${x+0.5+dx*0.8} 102.2 ${0.5+dz*0.8} {Item:{id:"minecraft:blaze_rod",count:1},PickupDelay:0s}`);
   await s.act('wait',{durationMs:1000});o=await s.observe();
   row.rodsAfterDiagnosticDrops=(o.inventory?.items??[]).filter(i=>i.itemId==='minecraft:blaze_rod').reduce((n,i)=>n+i.count,0);
  }
  Object.assign(row,{seconds:Math.round((s.clock.now()-t0)/1000),wallSeconds:Math.round((Date.now()-wall0)/1000),gameSeconds:Math.round((await timer.elapsed())/1000),rates:await timer.rates().catch(()=>null)});
  await s.normalRate();
  {const {damageTaken,integrity}=damageEvidence(damageBefore,await readDamage(),null,null);Object.assign(row,{damageTaken,...(integrity?{integrity}:{}),deaths:deathEvidence(deathsBefore,await deaths()).deaths});}
  results.cases.push(row);
  await writeFile(join(out,'shelter.json'),JSON.stringify(results,null,2));
  console.log(opening,roof,result.state,result.reasonCode,result.message);
 }
 results.tick={rate:s.tickRate,held:await s.tickReport()};
} finally {await s?.stop().catch(()=>{});await writeFile(join(out,'shelter.json'),JSON.stringify(results,null,2));}
if(results.cases.length!==4||results.cases.some(c=>c.result.state!=='SUCCEEDED'||c.fight?.state!=='SUCCEEDED'||c.rodsAfterDiagnosticDrops-c.rodsBeforeDiagnosticDrops<2))process.exitCode=1;
