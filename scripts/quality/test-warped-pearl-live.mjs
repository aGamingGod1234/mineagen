#!/usr/bin/env node
// Test-only stand-in. All hunting/building decisions use production player observations.
// No operator-spawned endermen, forced loot, hidden terrain, or routine exposed to Sol.
// CHECKPOINT OUT JAR [repeat=1] [gameTicks=24000], under slot.sh live.
// FIXTURE_TICK_RATE runs the window faster: setup stays at 20 TPS, and the window (already counted in game ticks), the
// stand-in's waits (THINK_MS too: the body idles that much game time) and its cooldowns and seconds are game time on the
// fixture clock (s.clock), so a raised rate plays the same game. wallSeconds is wall time; gameSeconds, rates, tick and
// vanilla damageTaken are recorded beside it.
import {readFile,writeFile,mkdir,readdir,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {boot,fixtureTickRate} from './watch-replay.mjs';
import {damageCounter,recordDamageEvidence} from './lib/damage-counter.mjs';
import {applyQualitySetup,activateQualitySetup} from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import {adaptObservation} from '../../coordinator/src/observation-adapter.mjs';
import {validateAction} from '../../coordinator/src/schema.mjs';
import {normalizeReflexEntries,DEFAULT_REFLEXES} from '../../coordinator/src/reflexes.mjs';
import {finishRun,EDIT_LOOP_HELP,FIXTURE_OUTCOME_HELP} from './lib/fixture-run.mjs';
// The room's verdict goes through finishRun into room.json and room-summary.json (one row); result.json stays the
// detailed report. PASS: at least PEARL_BAR (6) pearls held inside the window, no death, no error.
const USAGE='Usage: [STANDIN=roof|until|count] [PEARL_BAR=6] [DEFAULTS=1] test-warped-pearl-live.mjs CHECKPOINT OUT JAR [salt=1] [gameTicks=24000] [--strict|--descriptive] under slot.sh live';
const cli=process.argv.slice(2);
if(cli.includes('--help')){console.log(USAGE+'\n'+EDIT_LOOP_HELP+'\n'+FIXTURE_OUTCOME_HELP);process.exit(0);}
const strict=!cli.includes('--descriptive');
const [checkpointFile,outArg,jarArg,repeatArg='1',ticksArg='24000']=cli.filter(a=>!['--strict','--descriptive'].includes(a));
if(!process.env.SLOT_PORT_BASE||!process.env.ARENA_HEADLESS_SERVER_TEMPLATE||!process.env.JAVA_HOME||!checkpointFile||!outArg||!jarArg){console.error(USAGE);process.exit(2);}
const cp=JSON.parse(await readFile(checkpointFile,'utf8')),out=path.resolve(outArg),jar=path.resolve(jarArg),repeat=Number(repeatArg),ticks=Number(ticksArg);
await mkdir(out,{recursive:true});if((await readdir(out)).length)throw Error('Fresh output required');
if(cp.fixtureVersion!==2||cp.setup.expectedBiome!=='minecraft:warped_forest')throw Error('Prepared v2 forest checkpoint required');
const result={checkpointSha256:createHash('sha256').update(await readFile(checkpointFile)).digest('hex'),seed:cp.seed,repeat,requestedGameTicks:ticks,providerCalls:0,naturalSpawns:true,controllerSha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),jarSha256:createHash('sha256').update(await readFile(jar)).digest('hex'),actions:{},refusals:{},fights:[],sightings:0};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),seen=new Set(),cooldown=new Map();
let s,facts,dead=false,active=false,started=0,wall0=0,center,rules=[],lastSave=0,startTicks,timer=null,readDamage=null,damage0=null;
// Game time on the fixture clock once the server is up (plain wall time at 20 TPS); started is on it, wall0 is wall time.
const now=()=>s?.clock?s.clock.now():Date.now();
const save=()=>writeFile(path.join(out,'result.json'),JSON.stringify({...result,dead,wallSeconds:wall0?(Date.now()-wall0)/1000:0,sightings:seen.size},null,2)+'\n');
async function observe(){
 const at=Date.now(),next=s.inbox.wait('observation',e=>e.agentId===s.record.agentId&&(e.payload.observedAtEpochMs??0)>=at-50,15000);
 await s.bridge.send('request_observation',s.record.agentId,{goalRevision:s.record.goalRevision});const raw=(await next).payload;s.observation=raw;
 if(!raw.ready){if(raw.status==='PLAYER_DEAD')dead=true;return facts;}
 facts=adaptObservation(raw);
 const gt=facts.world?.gameTime;
 if(startTicks!==undefined&&Number.isFinite(gt)&&gt-startTicks<=ticks&&!dead){result.pearlsInWindow=facts.inventory.items.filter(i=>i.itemId==='minecraft:ender_pearl').reduce((n,i)=>n+i.count,0);result.windowObservedTicks=gt-startTicks;}
 for(const e of facts.entities)if(e.type==='minecraft:enderman'&&e.visible!==false&&e.perceivedBy!=='sound')seen.add(e.stableId);
 return facts;
}
// STANDIN=until (d41 fight-until): no pocket and no gaze rule; one fight_until call (enderman -> one more pearl, sword)
// repeated after each hand-back, eating when hungry. Results go to result.untilCalls.
// STANDIN=roof (d41 fight-count): one count-mode call with roof:true for the whole window: fight_target on the nearest
// seen enderman (untilItem ender_pearl, untilCount held+16), else fight_until on endermen; re-called after a hand-back.
// FLEE_AT (default 8; the live model passed 14 on every hunt), CALL_TIMEOUT_MS=none (the model's untimed call: fight_until
// runs its own default, fight_target the coordinator's 30 s), THINK_MS (a model turn between calls, default 0) and
// the untimed call takes the schema's own default (schema.mjs: 540 s for an enderman pearl fight_until on this branch,
// 180 s on base). Every call is capped at the window left. Scoring is by game tick: pearlsInWindow is the count the last
// observation inside startGameTicks+gameTicks showed; a death fails the run (pass false, pearlsInWindow 0).
const STANDIN=process.env.STANDIN??'script';
// DEFAULTS=1: the until, roof and count stand-ins play with the coordinator's default reflexes armed (leave lava, step off
// fire, shield and the rest), as every model game does; without it they play with none.
const DEFAULTS=process.env.DEFAULTS==='1';
const gaze={id:'gaze',kind:'trigger',priority:9,when:{type:'enderman_gaze',within:64},do:{type:'look_away'},maxS:2,ttlS:3600};
async function setRules(next){rules=next;await s.setReflexes(rules);}
async function act(type,args){
 validateAction({type,...args});if(s.observation?.reflexes?.firing&&rules.length)await s.bridge.send('reflex_update',s.record.agentId,{revision:s.revision,rules:normalizeReflexEntries(rules),yield:true});
 result.actions[type]=(result.actions[type]??0)+1;const at=now(),r=await s.act(type,args,type==='fight_until'||args.untilItem?Math.max(args.timeoutMs??0,180000)+20000:65000);
 if(r.state!=='SUCCEEDED')result.refusals[r.reasonCode]=(result.refusals[r.reasonCode]??0)+1;
 await appendFile(path.join(out,'actions.jsonl'),JSON.stringify({seconds:started?(at-started)/1000:0,type,args,state:r.state,reason:r.reasonCode,message:r.message,ms:now()-at})+'\n');await observe();return r;
}
async function select(itemId){const item=facts.inventory.items.find(i=>i.itemId===itemId&&i.count>0);if(!item)return false;
 if(item.slot>8)await act('select_tool',{sourceSlot:item.slot,hotbarSlot:8,expectedItemId:itemId,minRemainingDurability:0});await act('select_item',{itemId});return true;}
async function scan(){const p=facts.player;for(let i=0;i<8&&!dead;i++){const a=i*Math.PI/4;await act('look_at',{x:p.x+24*Math.cos(a),y:p.y+.15,z:p.z+24*Math.sin(a)});await s.clock.sleep(100);}}
async function go(at){return act('navigate_to',{x:at.x+.5,y:at.y,z:at.z+.5,tolerance:.18,sprint:false,timeoutMs:5000});}
function seenLava(feet){
 const rows=(facts.blocks??[]).filter(b=>b.blockId==='minecraft:lava').map(b=>({x:b.x,y:b.y,z:b.z}));
 for(const t of facts.player.lavaSeen??[]){const m=String(t).match(/\((-?\d+),(-?\d+),(-?\d+)\)/);if(m)rows.push({x:+m[1],y:+m[2],z:+m[3]});}
 return rows;
}
// Seen lava rows on a lava-sea shore crowd every site, so only lava right under the pocket floor rules a site out up
// front; the body's own LAVA_BEHIND refusal while digging rules out the rest.
const inFootprint=(b,feet)=>b.x===feet.x&&b.z===feet.z&&b.y-feet.y>=-2&&b.y-feet.y<=-1;
async function canopy(){
 // Warped-forest floors are rarely flat and often border lava seas, so the stand-in makes a dug pocket where it stands,
 // as a player does on uneven ground: step away from seen lava, fill lower neighbouring floor cells, roof the 3x3 at head
 // height (each roof block placed on a temporary block beneath it, removed afterwards, because a top face above the eyes
 // or a far-side face cannot take a block), then dig out its own floor and drop in: a 2-high pocket an enderman cannot
 // enter, with 1-high gaps to hit its legs through. Occupancy comes from placement refusals, not operator block queries.
 const attempts=result.coverAttempts=[];
 for(let attempt=0;attempt<6&&!dead;attempt++){
  await scan();const p=facts.player,feet={x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)};
  const all=seenLava(feet),lava=all.filter(b=>inFootprint(b,feet)),row={site:{...feet},lavaSeen:all.length,lavaInFootprint:lava.length,lavaCells:all.slice(0,16).map(b=>[b.x-feet.x,b.y-feet.y,b.z-feet.z])};attempts.push(row);
  const away=async(from)=>{const dx=feet.x-from.x,dz=feet.z-from.z,yaw=(dx||dz)?Math.atan2(-dx,dz)*180/Math.PI:Math.random()*360-180;
   await act('travel_to',{yaw:Math.max(-180,Math.min(180,yaw)),distance:8,tolerance:1,timeoutMs:20000});};
  if(lava.length){const c=all.reduce((a,b)=>({x:a.x+b.x/all.length,z:a.z+b.z/all.length}),{x:0,z:0});row.outcome='LAVA_NEAR';await away(c);continue;}
  try{await buildPocket(feet,row);row.outcome='BUILT';result.site={...feet};result.coverBuilt=true;result.coverBuiltAfterSeconds=(now()-started)/1000;await save();return;}
  catch(error){row.outcome=error.message;const near=seenLava(feet).filter(b=>inFootprint(b,feet));await away(near.length?near[0]:{x:feet.x+Math.random()-.5,z:feet.z+Math.random()-.5});}
 }
 // No site took a pocket (a lava-sea crust refuses every dig): hunt in the open from here, as a player would.
 await observe();const q=facts.player;center={x:Math.floor(q.x),y:Math.floor(q.y),z:Math.floor(q.z)};
 result.coverBuilt=false;result.openHunt=true;result.site={...center};await select('minecraft:iron_sword');await save();
}
async function buildPocket(feet,row){
 await go(feet);const cover=row.cover=result.cover={filled:0,occupied:0,gaps:[],roof:0,scaffolds:0};
 const place=async(x,y,z)=>{
  await act('look_at',{x:x+.5,y:y+.5,z:z+.5});
  const r=await act('place_block',{x,y,z,face:'up',itemId:'minecraft:cobblestone'});
  if(r.state==='SUCCEEDED'){cover.filled++;return 'placed';}if(r.reasonCode==='TARGET_OCCUPIED'){cover.occupied++;return 'occupied';}
  if(r.reasonCode==='LAVA_BEHIND'||/lava/i.test(r.message??''))throw Error('LAVA_AT_SITE');return null;
 };
 const dig=async(x,y,z)=>{await select('minecraft:iron_pickaxe');await act('look_at',{x:x+.5,y:y+.5,z:z+.5});const r=await act('break_block',{x,y,z,timeoutMs:8000});
  if(r.reasonCode==='LAVA_BEHIND')throw Error('LAVA_AT_SITE');return r.state==='SUCCEEDED';};
 const ring=[];for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)if(dx||dz)ring.push({x:feet.x+dx,z:feet.z+dz});
 for(const c of ring)if(!(await place(c.x,feet.y-1,c.z)||(await place(c.x,feet.y-2,c.z)&&await place(c.x,feet.y-1,c.z))))cover.gaps.push(c);
 // Corners first: edge roof blocks would hide a corner scaffold's top face from the eye, while a corner roof block's
 // near face then supports each edge roof block.
 for(const c of [...ring].sort((a,b)=>(b.x!==feet.x&&b.z!==feet.z)-(a.x!==feet.x&&a.z!==feet.z))){
  if(await place(c.x,feet.y+1,c.z)){cover.roof++;continue;}
  const scaffold=await place(c.x,feet.y,c.z);if(!scaffold)continue;
  if(await place(c.x,feet.y+1,c.z))cover.roof++;
  if(scaffold==='placed'){cover.scaffolds++;await dig(c.x,feet.y,c.z);}
 }
 if(cover.roof<8)throw Error(`ROOF_INCOMPLETE_${cover.roof}`);
 if(!await dig(feet.x,feet.y-1,feet.z))throw Error('POCKET_DIG_FAILED');
 await s.clock.sleep(600);await observe();center={x:feet.x,y:feet.y-1,z:feet.z};await go(center);
 if(!await place(feet.x,feet.y+1,feet.z))throw Error('POCKET_UNROOFED');cover.roof++;await select('minecraft:iron_sword');
}
// Leaving the pocket for a seen pearl: open the edge cell facing it (its roof and floor), so the body can step up and out
// of an unroofed 1x1 hole; on return the roof is placed again. Refusals here are recorded, not fatal.
async function openExit(item){
 const edges=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>({x:center.x+dx,z:center.z+dz})).sort((a,b)=>Math.hypot(a.x+.5-item.x,a.z+.5-item.z)-Math.hypot(b.x+.5-item.x,b.z+.5-item.z));
 const e=edges[0];await select('minecraft:iron_pickaxe');
 for(const y of [center.y+2,center.y]){await act('look_at',{x:e.x+.5,y:y+.5,z:e.z+.5});await act('break_block',{x:e.x,y,z:e.z,timeoutMs:8000});}
 return e;
}
async function closeExit(e){
 await go(center);await select('minecraft:cobblestone');await act('look_at',{x:e.x+.5,y:center.y+2.5,z:e.z+.5});
 const r=await act('place_block',{x:e.x,y:center.y+2,z:e.z,face:'up',itemId:'minecraft:cobblestone'});
 if(r.state!=='SUCCEEDED'&&r.reasonCode!=='TARGET_OCCUPIED')result.exitsLeftOpen=(result.exitsLeftOpen??0)+1;
 await select('minecraft:iron_sword');
}
async function fight(e){
 await go(center);await select('minecraft:iron_sword');const row={atSeconds:(now()-started)/1000,targetId:e.stableId,targetType:e.type,alreadyAngry:!!(e.targetingAgent||e.appearance?.screaming)};
 if(!row.alreadyAngry){
  // This is the stand-in's explicit choice of exactly one target. Scans retain the higher-priority gaze rule.
  await setRules([]);await act('look_at',{x:e.x,y:e.y+2.55,z:e.z});await s.clock.sleep(1100);await observe();
  await act('look_at',{x:facts.player.x,y:facts.player.y-.5,z:facts.player.z+1});await setRules([gaze]);
 }
 // Shield stance only with a shield in the offhand; re-equip a carried one first (a broken shield is gone).
 const shields=facts.inventory.items.filter(i=>i.itemId==='minecraft:shield');let held=shields.some(i=>i.slot==='offhand'||i.slot===40);
 if(!held&&shields.length){await act('equip_item',{sourceSlot:shields[0].slot,targetSlot:'offhand',expectedItemId:'minecraft:shield'});held=facts.inventory.items.some(i=>i.itemId==='minecraft:shield'&&(i.slot==='offhand'||i.slot===40));}
 const r=await act('fight_target',{targetId:e.stableId,pursue:false,shield:held,fleeAtHealth:10,timeoutMs:20000});
 Object.assign(row,{state:r.state,reason:r.reasonCode,message:r.message});result.fights.push(row);cooldown.set(e.stableId,now()+45000);await save();
}
async function gameTicks(){const text=await s.command('time query gametime');const m=text.match(/time is (\d+)/i);if(!m)throw Error('GAME_CLOCK_UNAVAILABLE');return Number(m[1]);}
try{
 s=await boot(out,{jar,template:process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port:Number(process.env.SLOT_PORT_BASE),world:null,seed:cp.seed,spawnMonsters:true,goalTicks:150000,tickRate:fixtureTickRate()});
 await s.normalRate();
 const registered=s.inbox.wait('agent_registered',()=>true,45000);
 let summon;for(let i=0;i<20;i++){
  summon=await s.command('execute positioned 0.5 200 0.5 run mineagen summon gpt-6.1-sol low Probe');if(!summon.includes('MODEL_CATALOG_UNAVAILABLE'))break;
  await s.bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Model-free warped forest',reasoningEfforts:['low'],serviceTiers:['default']}]});await sleep(100);
 }
 if(!summon.includes('Creating')){registered.catch(()=>{});throw Error('SUMMON_REFUSED');}
 const e=await registered;s.record={...(e.payload.record??e.payload),agentId:e.agentId};await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 const start=s.inbox.wait('goal_control',e=>e.payload.operation==='start');await s.command('mineagen start Probe Survive for 7000 seconds.');s.record.goalRevision=(await start).payload.goalRevision;await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 const setup=await applyQualitySetup({...cp.setup,randomSalt:repeat},async command=>({text:await s.command(command)}),'Probe');
 await activateQualitySetup(setup,async command=>({text:await s.command(command)}),{stage:'goal-start'});await activateQualitySetup(setup,async command=>({text:await s.command(command)}),{stage:'first-decision'});
 s.bridge.on('observation',e=>{
  if(!active||e.agentId!==s.record.agentId)return;
  if(e.payload.status==='PLAYER_DEAD'){dead=true;return;}
  // Pearls are counted from every sample in the window, also those that arrive while a long fight runs.
  if(!e.payload.ready||dead)return;
  try{const f=adaptObservation(e.payload),gt=f.world?.gameTime;
   if(startTicks!==undefined&&Number.isFinite(gt)&&gt-startTicks<=ticks){result.pearlsInWindow=f.inventory.items.filter(i=>i.itemId==='minecraft:ender_pearl').reduce((n,i)=>n+i.count,0);result.windowObservedTicks=gt-startTicks;}
  }catch{}
 });
 await s.command('tick unfreeze');await s.command('difficulty normal');await observe();
 const shield=facts.inventory.items.find(i=>i.itemId==='minecraft:shield');if(shield)await act('equip_item',{sourceSlot:shield.slot,targetSlot:'offhand',expectedItemId:'minecraft:shield'});
 // The window is play: raised to the fixture rate until it ends (see finally).
 readDamage=await damageCounter(text=>s.command(text),'Probe');damage0=await readDamage();
 await s.fastRate();wall0=Date.now();timer=await s.gameTimer();
 if(DEFAULTS&&['until','roof','count'].includes(STANDIN)){
  // All of them, as the coordinator arms them (more than the 12 a model may set, so not through setRules).
  s.revision+=1;await s.bridge.send('reflex_update',s.record.agentId,{revision:s.revision,rules:DEFAULT_REFLEXES.map(rule=>({...structuredClone(rule),coordinatorDefault:true})),yield:false});
  let armed=false;for(let i=0;i<40&&!armed;i++){armed=(await s.observe()).reflexes?.revision===s.revision;if(!armed)await sleep(100);}
  if(!armed)throw Error(`default reflexes (revision ${s.revision}) never echoed`);
 }
 result.defaultReflexes=DEFAULTS;
 if(STANDIN==='until'){
  startTicks=await gameTicks();started=now();active=true;result.startedAt=new Date(Date.now()).toISOString();result.startGameTicks=startTicks;result.untilCalls=[];
  await select('minecraft:iron_sword');
  while(!dead&&(await gameTicks())-startTicks<ticks){
   await observe();if(dead)break;
   if(facts.player.foodLevel<18&&await select('minecraft:cooked_beef')){await act('use_item',{durationMs:1800,expectedItemId:'minecraft:cooked_beef'});await select('minecraft:iron_sword');}
   const held=facts.inventory.items.filter(i=>i.itemId==='minecraft:ender_pearl').reduce((n,i)=>n+i.count,0);
   const leftMs=Math.max(1000,Math.min(600000,(ticks-((await gameTicks())-startTicks))*50));
   const r=await act('fight_until',{mob:'minecraft:enderman',untilItem:'minecraft:ender_pearl',untilCount:held+1,weapon:'sword',fleeAtHealth:8,timeoutMs:leftMs});
   result.untilCalls.push({atSeconds:(now()-started)/1000,pearlsBefore:held,state:r.state,reason:r.reasonCode,message:String(r.message??'').slice(0,1500)});await save();
   if(r.reasonCode==='AGENT_DEAD')break;
   if(r.reasonCode==='LOW_HEALTH_BAILOUT'&&await select('minecraft:cooked_beef')){await act('use_item',{durationMs:1800,expectedItemId:'minecraft:cooked_beef'});await select('minecraft:iron_sword');}
  }
 }
 if(STANDIN==='roof'){
  startTicks=await gameTicks();started=now();active=true;result.startedAt=new Date(Date.now()).toISOString();result.startGameTicks=startTicks;result.untilCalls=[];
  const food=()=>facts.inventory.items.find(i=>['minecraft:cooked_beef','minecraft:bread'].includes(i.itemId))?.itemId;
  await select('minecraft:iron_sword');
  while(!dead&&(await gameTicks())-startTicks<ticks){
   await observe();if(dead)break;
   if((facts.player.foodLevel<18||facts.player.health<12)&&food()&&await select(food())){await act('use_item',{durationMs:1800,expectedItemId:food()});await select('minecraft:iron_sword');}
   const held=facts.inventory.items.filter(i=>i.itemId==='minecraft:ender_pearl').reduce((n,i)=>n+i.count,0);
   const leftMs=Math.max(1000,Math.min(600000,(ticks-((await gameTicks())-startTicks))*50));
   const e=facts.entities.filter(x=>x.type==='minecraft:enderman'&&x.visible!==false&&x.perceivedBy!=='sound'&&x.distance<=24).sort((a,b)=>a.distance-b.distance)[0];
   const untimed=process.env.CALL_TIMEOUT_MS==='none';
   const common={untilItem:'minecraft:ender_pearl',untilCount:held+16,fleeAtHealth:Number(process.env.FLEE_AT??8),roof:true,...(untimed?{}:{timeoutMs:leftMs})};
   let [type,args]=e?['fight_target',{targetId:e.stableId,...common,...(untimed?{timeoutMs:30000}:{})}]:['fight_until',{mob:'minecraft:enderman',...common}];
   if(untimed&&type==='fight_until'){const normalized=validateAction({type,...args});args={...args,timeoutMs:normalized.timeoutMs};}
   args={...args,timeoutMs:Math.min(args.timeoutMs??180000,leftMs)};
   if(Number(process.env.THINK_MS??0)>0)await s.clock.sleep(Number(process.env.THINK_MS));
   const r=await act(type,args);
   result.untilCalls.push({atSeconds:(now()-started)/1000,type,pearlsBefore:held,state:r.state,reason:r.reasonCode,message:String(r.message??'').slice(0,1800)});await save();
   if(r.reasonCode==='AGENT_DEAD')break;
   if(['ROOF_BLOCKS_MISSING','ROOF_NOT_BUILT'].includes(r.reasonCode)&&(result.roofStops=(result.roofStops??0)+1)>=3)break;
   if(['NO_TARGET_SEEN','AREA_CLEARED'].includes(r.reasonCode))await scan();
  }
 }
 if(STANDIN==='count'){
  // d41-pearls-263: the live model's pattern. Each call waits THINK_MS first (a model turn: the body is idle), eats under
  // 12 health, then fight_target in count mode on the nearest seen enderman (pursue default, roof off), else fight_until.
  // CALL_TIMEOUT_MS / FLEE_AT (d41-big-pearls): the live model's short calls (15-30 s) and fleeAtHealth 10-12.
  startTicks=await gameTicks();started=now();active=true;result.startedAt=new Date(Date.now()).toISOString();result.startGameTicks=startTicks;result.untilCalls=[];
  const think=Number(process.env.THINK_MS??5000),food=()=>facts.inventory.items.find(i=>['minecraft:cooked_beef','minecraft:bread'].includes(i.itemId))?.itemId;
  await select('minecraft:iron_sword');
  while(!dead&&(await gameTicks())-startTicks<ticks){
   await s.clock.sleep(think);await observe();if(dead)break;
   if((facts.player.foodLevel<18||facts.player.health<12)&&food()&&await select(food())){await act('use_item',{durationMs:1800,expectedItemId:food()});await select('minecraft:iron_sword');if(dead)break;}
   const held=facts.inventory.items.filter(i=>i.itemId==='minecraft:ender_pearl').reduce((n,i)=>n+i.count,0);
   const leftMs=Math.max(1000,Math.min(600000,(ticks-((await gameTicks())-startTicks))*50));
   const e=facts.entities.filter(x=>x.type==='minecraft:enderman'&&x.visible!==false&&x.perceivedBy!=='sound'&&x.distance<=24).sort((a,b)=>a.distance-b.distance)[0];
   const callMs=Number(process.env.CALL_TIMEOUT_MS??0),common={untilItem:'minecraft:ender_pearl',untilCount:held+16,fleeAtHealth:Number(process.env.FLEE_AT??8),timeoutMs:callMs>0?Math.min(leftMs,callMs):leftMs};
   const [type,args]=e?['fight_target',{targetId:e.stableId,pursue:true,...common}]:['fight_until',{mob:'minecraft:enderman',...common}];
   const r=await act(type,args);
   result.untilCalls.push({atSeconds:(now()-started)/1000,type,pearlsBefore:held,health:facts.player.health,state:r.state,reason:r.reasonCode,message:String(r.message??'').slice(0,1800)});await save();
   if(r.reasonCode==='AGENT_DEAD')break;
   if(['NO_TARGET_SEEN','AREA_CLEARED'].includes(r.reasonCode))await scan();
  }
 }
 if(STANDIN!=='until'&&STANDIN!=='roof'&&STANDIN!=='count'){await setRules([gaze]);startTicks=await gameTicks();started=now();active=true;result.startedAt=new Date(Date.now()).toISOString();result.startGameTicks=startTicks;await canopy();}
 while(STANDIN!=='until'&&STANDIN!=='roof'&&STANDIN!=='count'&&!dead&&(await gameTicks())-startTicks<ticks){
  await observe();if(dead)break;
  const pearl=facts.items.find(i=>i.itemId==='minecraft:ender_pearl'&&i.distance<8);
  if(pearl){const exit=result.openHunt?null:await openExit(pearl);await act('pick_up_item',{targetSelector:pearl.stableId});if(exit)await closeExit(exit);else await go(center);continue;}
  // Anything attacking the body is fought first: forest starts wear no gold, so wandering piglins attack too.
  const angry=facts.entities.filter(e=>(e.type==='minecraft:enderman'&&(e.targetingAgent||e.appearance?.screaming))||(e.targetingAgent&&/^minecraft:(piglin|piglin_brute|hoglin|zombified_piglin|magma_cube|skeleton|wither_skeleton)$/.test(e.type)&&e.distance<8)).sort((a,b)=>a.distance-b.distance)[0];
  if(angry){await fight(angry);continue;}
  if(facts.player.foodLevel<18&&await select('minecraft:cooked_beef')){await act('use_item',{durationMs:1800,expectedItemId:'minecraft:cooked_beef'});await select('minecraft:iron_sword');}
  const next=facts.entities.filter(e=>e.type==='minecraft:enderman'&&e.visible!==false&&e.perceivedBy!=='sound'&&[e.x,e.y,e.z].every(Number.isFinite)&&e.distance>=5&&e.distance<=48&&Math.abs(e.y-center.y)<3&&(cooldown.get(e.stableId)??0)<now()).sort((a,b)=>a.distance-b.distance)[0];
  if(next){await fight(next);continue;}
  await scan();await s.clock.sleep(300);if(Date.now()-lastSave>10000){lastSave=Date.now();await save();}
 }
 result.elapsedGameTicks=(await gameTicks())-startTicks;result.completedWindow=result.elapsedGameTicks>=ticks&&!dead;result.endPearls=dead?0:facts.inventory.items.filter(i=>i.itemId==='minecraft:ender_pearl').reduce((n,i)=>n+i.count,0);await s.command('save-all flush');
}catch(error){
 if(dead&&started){
  result.stoppedBecause='PLAYER_DEAD';result.endPearls=0;
  try{result.elapsedGameTicks=(await gameTicks())-startTicks;result.completedWindow=true;}catch(clockError){result.error=String(clockError.stack??clockError);}
 }else result.error=String(error.stack??error);
}
finally{
 active=false;
 if(timer){
  try{result.gameSeconds=Math.round((await timer.elapsed())/1000);result.rates=await timer.rates().catch(()=>null);await s.normalRate();
   recordDamageEvidence(result, damage0,await readDamage());result.tick={rate:s.tickRate,held:await s.tickReport()};}
  catch(error){result.tickError=String(error.message??error);
   // No damage evidence read: the room has no verdict, never a pass.
   (result.integrity??=[]).push({file:'damage_taken',error:`teardown failed before the damage counter was read: ${result.tickError}`});}
 }
 await s?.stop().catch(()=>{});
}
let statsRead=false;
for(const f of await readdir(path.join(out,'server/world/players/stats')).catch(()=>[])){statsRead=true;
 const stats=JSON.parse(await readFile(path.join(out,'server/world/players/stats',f),'utf8')).stats??{};result.stats=stats;
 result.endermenKilled=stats['minecraft:killed']?.['minecraft:enderman']??0;result.pearlsPickedUp=stats['minecraft:picked_up']?.['minecraft:ender_pearl']??0;result.deaths=stats['minecraft:custom']?.['minecraft:deaths']??0;
}
if(dead)result.pearlsInWindow=0;
// Shelters built and kills, from every hunt receipt (ServerFightUntilController: "shelters built: N", "N kill(s)").
let shelters=0,kills=0;for(const c of result.untilCalls??[]){const m=String(c.message);shelters+=Number(/shelters built: (\d+)/.exec(m)?.[1]??0);kills+=Number(/: (\d+) kills?,/.exec(m)?.[1]??0);}
Object.assign(result,{sheltersBuilt:shelters,receiptKills:kills,sheltersPerKill:kills?shelters/kills:null,pass:!dead&&!(result.deaths>0)&&!result.error&&(result.pearlsInWindow??0)>=Number(process.env.PEARL_BAR??6)});
// Hand-back codes and main's pass-over of unreachable endermen ("out of reach: passed over N times ... (M let back in)").
const handBacks={};let passedOver=0,letBackIn=0;
for(const c of result.untilCalls??[]){handBacks[c.reason]=(handBacks[c.reason]??0)+1;const m=/out of reach: passed over (\d+) times? .*?\((\d+) let back in\)/.exec(String(c.message));if(m){passedOver+=Number(m[1]);letBackIn+=Number(m[2]);}}
Object.assign(result,{handBacks,passedOver,letBackIn});
await save();console.log(JSON.stringify(result));
const bar=Number(process.env.PEARL_BAR??6),pearls=result.pearlsInWindow??0;
const row={name:`pearl-${cp.seed}-salt${repeat}`,startedAt:started||undefined,finishedAt:Date.now(),seed:cp.seed,salt:repeat,standin:STANDIN,
 pearlsInWindow:pearls,endPearls:result.endPearls??null,endermenKilled:result.endermenKilled??null,pearlsPickedUp:result.pearlsPickedUp??null,
 deaths:statsRead?result.deaths:null,dead,receiptKills:kills,sheltersBuilt:shelters,handBacks,passedOver,letBackIn,calls:(result.untilCalls??[]).length,
 elapsedGameTicks:result.elapsedGameTicks??null,completedWindow:result.completedWindow??false,pass:result.pass};
if(result.error)row.error=result.error;
// No player stats file: deaths and kills are unknown, never 0.
// Missing or corrupt evidence (an unreadable or falling damage counter, missing player stats) is no verdict, never a pass.
if(Array.isArray(result.integrity)&&result.integrity.length)row.integrity=[...result.integrity];
if(!statsRead&&!result.error)row.integrity=[...(row.integrity??[]),{file:'server/world/players/stats',error:'missing player stats: deaths and kills unknown'}];
if(!started&&!result.error)row.notExercised='the hunt never started';
if(row.pass)row.passReason=`${pearls} pearls in ${ticks} game ticks, no death`;
else row.failReason=[pearls<bar?`${pearls} of ${bar} pearls in ${ticks} game ticks`:null,dead||result.deaths>0?'died':null].filter(Boolean).join('; ')||'pass false';
await finishRun([row],{file:path.join(out,'room.json'),strict});
