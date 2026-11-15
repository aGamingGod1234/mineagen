#!/usr/bin/env node
// Model-free verification of one checkpoint in a fresh disposable world. Launch under slot.sh live.
// node scripts/quality/test-savepoints-live.mjs CHECKPOINT OUT [JAR]
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {boot} from './watch-replay.mjs';
import {applyQualitySetup,activateQualitySetup} from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import {parseInventory,parseEquipment} from '../../coordinator/src/benchmark/checkpoint.mjs';
import {Observer} from './run-scenarios.mjs';
const [file,out,jar=process.env.ARENA_JAR ?? 'build/libs/arena-agents-0.2.0.jar',mode]=process.argv.slice(2);
if(!file||!out||!process.env.SLOT_PORT_BASE)throw new Error('CHECKPOINT OUT [JAR], under slot.sh live');
await mkdir(out,{recursive:true});if((await readdir(out)).length)throw new Error('Use a fresh output directory');
const bytes=await readFile(file),cp=JSON.parse(bytes),AGENT='Probe',OW='minecraft:overworld',spawnControl=mode==='--spawn-control';
const r={checkpoint:path.basename(file),sha256:createHash('sha256').update(bytes).digest('hex'),seed:cp.seed,jar,modelCalls:0,startedAt:new Date().toISOString()};
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const number=text=>Number(String(text).match(/(?:entity data:\s*|time is |has )(-?\d+(?:\.\d+)?)/)?.[1]??String(text).match(/(-?\d+(?:\.\d+)?)[fdb]?\s*$/)?.[1]);
const pos=text=>String(text).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number);
let s;
try{
 s=await boot(out,{jar:path.resolve(jar),template:process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port:Number(process.env.SLOT_PORT_BASE),seed:cp.seed,spawnMonsters:true});
 s.bridge.on('message',e=>{const revision=e.payload.goalRevision??e.payload.record?.goalRevision??e.payload.control?.goalRevision;if(s.record&&e.agentId===s.record.agentId&&Number.isInteger(revision))s.record.goalRevision=Math.max(s.record.goalRevision,revision);});
 const command=async text=>({text:await s.command(text)});
 const loaded=async (dim,x,z)=>{for(let i=0;i<100;i++){if(/time is \d+/i.test(await s.command(`execute in ${dim} if loaded ${x} 100 ${z} run time query gametime`)))return;await sleep(200);}throw new Error('Verification chunk did not load');};
 let e;
 for(let attempt=0;attempt<3&&!e;attempt++){
  const registered=s.inbox.wait('agent_registered',()=>true,45000).catch(()=>null);
  r.summon=await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${AGENT}`);
  e=await registered;
 }
 if(!e)throw new Error(`Agent never registered: ${r.summon}`);
 s.record={...(e.payload.record??e.payload),agentId:e.agentId};
 await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 const started=s.inbox.wait('goal_control',g=>g.payload.operation==='start');await s.command(`codex start ${AGENT} Survive for 1200 seconds.`);s.record.goalRevision=(await started).payload.goalRevision;
 await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 const receipt=await applyQualitySetup({...cp.setup,randomSalt:380038},command,AGENT);
 await activateQualitySetup(receipt,command,{stage:'goal-start'});await activateQualitySetup(receipt,command,{stage:'first-decision'});
 await s.command('tick unfreeze');
 r.setup={pos:pos(await s.command(`data get entity ${AGENT} Pos`)),dimension:await s.command(`data get entity ${AGENT} Dimension`),bedReceipt:receipt.receipts.find(x=>x.command==='used bed respawn receipt')??null};
 const counts=items=>{const c={};for(const i of items)c[i.id]=(c[i.id]??0)+i.count;return c;};
 const expected=counts(cp.setup.inventory.map(i=>({id:i.item.replace(/\[.*$/,''),count:i.count??1})));
 const actual=counts(parseInventory(await s.command(`data get entity ${AGENT} Inventory`)));
 const equipment=parseEquipment(await s.command(`data get entity ${AGENT}`));
 r.kit={expected,actual,equipment,pass:Object.entries(expected).every(([k,v])=>(actual[k]??0)>=v)&&Object.entries(cp.setup.armour??{}).every(([slot,item])=>equipment[slot]?.id===item.replace(/\[.*$/,''))};
 if(cp.lavaPool){const [x,y,z]=cp.lavaPool.edge;r.naturalPool={sources:0};for(let dx=-3;dx<=0;dx++)for(let dz=-2;dz<=2;dz++){if(/time is \d+/i.test(await s.command(`execute in ${OW} if block ${x+dx} ${y} ${z+dz} minecraft:lava[level=0] run time query gametime`)))r.naturalPool.sources++;}if(r.naturalPool.sources<cp.lavaPool.minimumSources)throw new Error('Natural casting pool was damaged by camp preparation');}
 if(mode==='--micro-start-only'){
  const observer=new Observer(out,{protocolAudit:'',providerTurns:''},{id:'LONG'},{});
  observer.agent=AGENT;observer.rcon={command};
  await observer.samplePlayer(true);
  r.firstSample=JSON.parse((await readFile(path.join(out,'quality-samples.jsonl'),'utf8')).trim());
  r.kit.exact=Object.entries(actual).every(([id,n])=>expected[id]===n)&&Object.entries(expected).every(([id,n])=>actual[id]===n);
  const at=cp.setup.position;
  r.position={expected:at,actual:r.setup.pos,pass:r.setup.pos&&Math.hypot(...at.map((n,i)=>n-r.setup.pos[i]))<1};
  r.dimension={expected:cp.setup.dimension,actual:r.setup.dimension,pass:r.setup.dimension.includes(cp.setup.dimension)};
  const floor=[Math.floor(at[0]),Math.floor(at[1])-1,Math.floor(at[2])];
  r.standing={floor,pass:/time is \d+/i.test(await s.command(`execute in ${cp.setup.dimension} unless block ${floor.join(' ')} minecraft:air unless block ${floor.join(' ')} minecraft:cave_air unless block ${floor.join(' ')} minecraft:lava run time query gametime`))};
  r.mobs=[];
  for(const mob of cp.setup.mobs??[]){
   const text=await s.command(`execute at ${AGENT} run data get entity @e[type=${mob.id},tag=${mob.tag},sort=nearest,limit=1] Pos`);
   const found=pos(text),distance=found&&Math.hypot(found[0]-r.setup.pos[0],found[1]-r.setup.pos[1],found[2]-r.setup.pos[2]);
   r.mobs.push({id:mob.id,position:found,distance,pass:found&&distance<=20&&(!mob.id.endsWith('enderman')||distance>=8&&distance<=12)});
  }
  const block=async(dim,where,id)=>/time is \d+/i.test(await s.command(`execute in ${dim} if block ${where.join(' ')} minecraft:${id} run time query gametime`));
  r.blocks=[];
  const expect=async(dim,where,id)=>r.blocks.push({dimension:dim,position:where,id,pass:await block(dim,where,id)});
  if(cp.milestone.startsWith('micro-fortress'))await expect('minecraft:the_nether',[84,73,92],'spawner');
  if(cp.milestone==='micro-fortress-bridge')await expect('minecraft:the_nether',[70,69,92],'nether_bricks');
  if(cp.milestone==='micro-lava-half-frame')for(const p of cp.initialObsidian)await expect(OW,p,'obsidian');
  if(cp.milestone==='micro-nether-return'){
   // Assert the scenario contract independently of the fixture's configured dimension.
   r.returnStart={pass:r.firstSample.dimension===OW&&r.firstSample.inventoryNbt==='[]'&&r.firstSample.health>0&&Math.hypot(r.firstSample.position.x-546.5,r.firstSample.position.y-64,r.firstSample.position.z-500.5)<1&&Boolean(r.setup.bedReceipt?.response.includes(OW))};
   for(const x of [543,544])for(const y of [64,65,66])await expect(OW,[x,y,498],'nether_portal');
   await expect(OW,[544,64,500],'red_bed');
   await expect(OW,[545,64,500],'red_bed');
   await expect(OW,[543,64,501],'chest');
   const chest=await s.command('execute in minecraft:overworld run data get block 543 64 501 Items');
   const kit=counts(parseInventory(chest));
   r.spareKit={chest,actual:kit,pass:(cp.spareKit??[]).every(([id,n])=>kit[`minecraft:${id}`]===n)};
  }
  // Coverage save points: evaluator-only targets and stage contracts (the scorer holds the same targets).
  r.coverage=[];const NE='minecraft:the_nether',END='minecraft:the_end',at3=cp.setup.position.join(' ');
  const located=async(dim,id,want)=>{const text=await s.command(`execute in ${dim} positioned ${at3} run locate structure ${id}`);const m=String(text).match(/\[\s*(-?\d+)\s*,\s*~?-?\d*\s*,\s*(-?\d+)\s*\]/);const got=m&&[Number(m[1]),Number(m[2])];r.coverage.push({check:`locate ${id}`,receipt:text,got,want,pass:Boolean(got&&Math.hypot(got[0]-want[0],got[1]-want[1])<=16)});};
  const held=id=>r.firstSample.inventoryNbt.includes(`"minecraft:${id}"`);
  const adv=a=>(r.firstSample.advancements??[]).some(x=>x.endsWith(a));
  if(cp.milestone==='micro-tools-forest')r.coverage.push({check:'empty inventory, no pickaxe',pass:r.firstSample.inventoryNbt==='[]'});
  if(cp.milestone==='micro-iron-bucket')r.coverage.push({check:'no iron or bucket at start',pass:!['bucket','water_bucket','lava_bucket','iron_ingot','raw_iron','iron_ore'].some(held)});
  if(cp.milestone==='micro-descend-123456789'){const y=r.firstSample.position.y;r.coverage.push({check:'surface start above -45 with lava pool below',y,pass:y>=60&&!held('lava_bucket')});
   let sources=0;for(let dx=-3;dx<=0;dx++)for(let dz=-2;dz<=2;dz++)if(/time is \d+/i.test(await s.command(`execute in ${OW} if block ${-21+dx} -55 ${62+dz} minecraft:lava[level=0] run time query gametime`)))sources++;r.coverage.push({check:'natural lava pool at (-21,-55,62)',sources,pass:sources>=10});}
  if(cp.milestone==='micro-find-fortress-20261024'){r.coverage.push({check:'find_fortress not yet held',advancements:r.firstSample.advancements,pass:!adv('find_fortress')});await located(NE,'minecraft:fortress',[272,-80]);}
  if(cp.milestone==='micro-stronghold-triangulate')await located(OW,'minecraft:stronghold',[256,2544]);
  if(cp.milestone==='micro-portal-room'){
   const frames=[[331,2551],[332,2551],[333,2551],[330,2552],[330,2553],[334,2552],[334,2553],[334,2554],[331,2555],[332,2555],[333,2555],[330,2554]];
   let empty=0;for(const [x,z] of frames)if(await block(OW,[x,-26,z],'end_portal_frame[eye=false]'))empty++;
   let portal=0;for(let x=331;x<=333;x++)for(let z=2552;z<=2554;z++)if(await block(OW,[x,-26,z],'end_portal'))portal++;
   r.coverage.push({check:'12 empty frames, no portal',empty,portal,pass:empty===12&&portal===0});
   // Vanilla body activation: use 12 eyes on the frames from the room centre, then the formed portal takes the body to the End.
   await s.command(`item replace entity ${AGENT} weapon.mainhand with minecraft:ender_eye 12`);
   await s.command(`execute in ${OW} run tp ${AGENT} 332.5 -26 2553.5`);await sleep(500);
   for(const [x,z] of frames){await s.command(`player ${AGENT} look at ${x+.5} -25.2 ${z+.5}`);await s.command(`player ${AGENT} use once`);await sleep(350);}
   let placed=0;for(const [x,z] of frames)if(await block(OW,[x,-26,z],'end_portal_frame[eye=true]'))placed++;
   let arrived=null;for(let i=0;i<40&&!arrived;i++){await sleep(250);const d=await s.command(`data get entity ${AGENT} Dimension`);if(d.includes(END))arrived=d;}
   r.coverage.push({check:'vanilla 12-eye activation reaches the End',placed,arrived,pass:placed===12&&Boolean(arrived)});
  }
  if(cp.milestone==='micro-dragon-low'){
   // Force-load every spike so an unloaded crystal cannot hide from the check (fixture world only).
   await s.command(`execute in ${END} run forceload add -64 -64 64 64`);for(const [x,z] of [[-48,0],[48,0],[0,-48],[0,48]])await loaded(END,x,z);await sleep(5000);
   const crystals=/time is \d+/i.test(await s.command(`execute in ${END} if entity @e[type=minecraft:end_crystal] run time query gametime`));
   const healthText=await s.command(`execute in ${END} run data get entity @e[type=minecraft:ender_dragon,limit=1] Health`);
   const health=number(healthText);
   r.coverage.push({check:'no end crystals, dragon at <=60 health',crystals,healthText,health,pass:!crystals&&health>0&&health<=60});
  }
  r.pass=Boolean(r.coverage.every(x=>x.pass)&&r.kit.pass&&r.kit.exact&&r.position.pass&&r.dimension.pass&&r.standing.pass&&r.mobs.every(x=>x.pass)&&r.blocks.every(x=>x.pass)&&(!r.spareKit||r.spareKit.pass)&&(!r.returnStart||r.returnStart.pass)&&(!cp.lavaPool||r.naturalPool.sources>=cp.lavaPool.minimumSources));
  if(!r.pass)throw new Error('Micro start state mismatch');
 }else{
 if(cp.endRecovery){r.endRecovery={bridgeBlocks:0,ladderBlocks:0};for(let x=48;x<=100;x++){const text=await s.command(`execute in minecraft:the_end unless block ${x} 48 0 minecraft:air if block ${x} 49 0 minecraft:air if block ${x} 50 0 minecraft:air run time query gametime`);if(x===48)continue;if(!/time is \d+/i.test(text))throw new Error('End arrival bridge is obstructed or missing');r.endRecovery.bridgeBlocks++;}for(let y=49;y<60;y++){if(!/time is \d+/i.test(await s.command(`execute in minecraft:the_end if block 48 ${y} 0 minecraft:ladder[facing=east] run time query gametime`)))throw new Error('End shelter surface ladder is missing');r.endRecovery.ladderBlocks++;}for(let x=54;x<=97;x++)for(const z of [-1,1])if(!/time is \d+/i.test(await s.command(`execute in minecraft:the_end if block ${x} 49 ${z} minecraft:end_stone run time query gametime`)))throw new Error('End bridge guard is missing');}
 if(cp.netherExit){const [x,y,z]=cp.netherExit;const text=await s.command(`execute in minecraft:the_nether if block ${x} ${y} ${z} minecraft:air if block ${x} ${y+1} ${z} minecraft:air unless block ${x} ${y-1} ${z} #minecraft:replaceable unless block ${x} ${y-1} ${z} minecraft:lava run time query gametime`);r.naturalExit={pass:/time is \d+/i.test(text),receipt:text};if(!r.naturalExit.pass)throw new Error('Nether shelter does not open onto natural standing ground');}

 if(cp.fixtureVersion===2&&cp.variantOf?.startsWith('6-')){
  const hazards=JSON.parse(await readFile(new URL('../../evals/d38-savepoints/portal-room-truth.json',import.meta.url),'utf8'));r.portalRoom={oldLavaCells:hazards.lava.length,oldSpawners:hazards.spawner.length,remaining:[]};
  for(const [type,positions] of Object.entries(hazards))for(const p of positions){const text=await s.command(`execute in ${OW} if block ${p.join(' ')} minecraft:${type} run time query gametime`);if(/time is \d+/i.test(text))r.portalRoom.remaining.push({type,position:p});}
  if(r.portalRoom.remaining.length)throw new Error('Portal-room lava or silverfish spawner remains');
 }
 r.safety={samples:[],wallMs:0,ticks:0};const begin=Date.now(),tick0=number(await s.command('time query gametime'));
 while(!spawnControl&&(Date.now()-begin<60000||r.safety.ticks<1200)){
  const health=number(await s.command(`data get entity ${AGENT} Health`));const deaths=number(await s.command(`scoreboard players get ${AGENT} qo_death`))||0;
  r.safety.samples.push({ms:Date.now()-begin,health,deaths,pos:pos(await s.command(`data get entity ${AGENT} Pos`))});
  if(!health||deaths)throw new Error('Unsafe start: body died during 60-second idle');
  r.safety.ticks=number(await s.command('time query gametime'))-tick0;if(Date.now()-begin>180000)throw new Error('Safety window did not advance 1200 ticks');await sleep(2000);
 }
 if(spawnControl){await sleep(5000);r.safety.skipped='Spawn-control baseline only';}
 r.safety.wallMs=Date.now()-begin;r.safety.minHealth=Math.min(...r.safety.samples.map(x=>x.health));r.safety.pass=r.safety.minHealth===20;
 if(cp.fixtureVersion===2&&/^(2b-|9-nether-entry-sol)/.test(path.basename(file))){
  const portals={};for(const c of cp.setup.commands){const m=c.match(/^execute in (minecraft:[a-z_]+) run fill (-?\d+) (-?\d+) (-?\d+) .* minecraft:nether_portal/);if(m)portals[m[1]]=m.slice(2,5).map(Number);}
  const NE='minecraft:the_nether',ow=portals[OW],ne=portals[NE];if(!ow||!ne)throw new Error('Missing linked portal pair');
  const arrive=async(dim,at)=>{for(let i=0;i<160;i++){if((await s.command(`data get entity ${AGENT} Dimension`)).includes(dim)){const actual=pos(await s.command(`data get entity ${AGENT} Pos`));if(actual&&Math.hypot(...actual.map((n,j)=>n-at[j]))<5)return actual;}await sleep(250);}throw new Error('Portal did not link to its prepared counterpart');};
  const cooldown=async()=>{for(let i=0;i<160;i++){const text=await s.command(`data get entity ${AGENT} PortalCooldown`);if(/Found no elements/i.test(text)||number(text)===0)return;await sleep(250);}throw new Error('Vanilla portal cooldown did not expire');};
  await cooldown();await s.command(`execute in ${NE} run tp ${AGENT} ${ne[0]+1.5} ${ne[1]} ${ne[2]+.5}`);
  r.portalRoundTrip={overworld:await arrive(OW,ow)};
  await s.command(`execute in ${OW} run tp ${AGENT} ${ow[0]+.5} ${ow[1]} ${ow[2]-.5}`);await cooldown();
  await s.command(`execute in ${OW} run tp ${AGENT} ${ow[0]+1.5} ${ow[1]} ${ow[2]+.5}`);
  r.portalRoundTrip.nether=await arrive(NE,ne);r.portalRoundTrip.health=number(await s.command(`data get entity ${AGENT} Health`));if(r.portalRoundTrip.health!==20)throw new Error('Portal round trip damaged the body');r.portalRoundTrip.pass=true;
  await s.command(`execute in ${NE} run tp ${AGENT} ${cp.setup.position.join(' ')}`);
 }
 const bed=cp.bedSpawn.position,[bx,by,bz]=bed;
 await s.command(`execute in ${OW} run forceload add ${bx} ${bz}`);await loaded(OW,bx,bz);
 r.respawnConfig=await s.command(`data get entity ${AGENT} respawn`);
 const respawn=async()=>{
  // Dimension changes and respawns give the fake vanilla client 60 game ticks of load immunity.
  // Under chunk-generation load, four wall seconds can contain fewer than 60 ticks.
  const loadTick=number(await s.command('time query gametime'));
  while(number(await s.command('time query gametime'))-loadTick<65)await sleep(250);
  const dead=s.inbox.wait('goal_control',g=>g.payload.operation==='dead',20000).catch(()=>null);
  await s.command(`kill ${AGENT}`);if(!(await dead))throw new Error('Death not captured');await sleep(1000);
  const action=await s.act('respawn',{});
  // The current body cancels its action receipt when respawn changes DEAD to STARTING.
  // Judge the actual new vanilla player and record that receipt, rather than treating it as a second death.
  await sleep(1500);
  await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
  const health=number(await s.command(`data get entity ${AGENT} Health`));if(!(health>0))throw new Error('Respawn did not create a living body');
  return {pos:pos(await s.command(`data get entity ${AGENT} Pos`)),dimension:await s.command(`data get entity ${AGENT} Dimension`),health,action:action.state,reasonCode:action.reasonCode};
 };
 r.bedRespawn=await respawn();r.bedRespawn.pass=/overworld/.test(r.bedRespawn.dimension)&&r.bedRespawn.pos&&Math.hypot(r.bedRespawn.pos[0]-(bx+1),r.bedRespawn.pos[1]-by,r.bedRespawn.pos[2]-(bz+.5))<=3;
 const chest=await s.command(`execute in ${OW} run data get block ${bx-1} ${by} ${bz+1} Items`);
 const table=await s.command(`execute in ${OW} if block ${bx+2} ${by} ${bz-1} minecraft:crafting_table run time query gametime`);
 const chestItems=[...chest.matchAll(/\{[^{}]*\}/g)].map(m=>({id:m[0].match(/id: "([^"]+)"/)?.[1],count:Number(m[0].match(/count: (\d+)/)?.[1])}));
 r.spareKit={chest,table,pass:(cp.spareKit??[]).every(([id,count])=>chestItems.some(i=>i.id===`minecraft:${id}`&&i.count>=count))&&/time is \d+/i.test(table)};
 r.route={pass:true,kind:cp.recoveryRoute?.kind??'surface-camp',checks:0};
 const test=async text=>{const response=await s.command(text);r.route.checks++;if(!/time is \d+/i.test(response))throw new Error(`Route check failed: ${text}: ${response}`);};
 if(cp.recoveryRoute){
  const {bottom:[x,y,z],top:[,top]}=cp.recoveryRoute;
  for(let h=y;h<top;h++)await test(`execute in ${OW} if block ${x} ${h} ${z} minecraft:ladder[facing=west] if block ${x+1} ${h} ${z} minecraft:cobblestone run time query gametime`);
  await test(`execute in ${OW} if block ${x} ${top} ${z} minecraft:air if block ${x} ${top+1} ${z} minecraft:air run time query gametime`);
  for(let a=bx;a<x;a++)await test(`execute in ${OW} if block ${a} ${by} ${z} minecraft:air if block ${a} ${by+1} ${z} minecraft:air run time query gametime`);
  // Ascend the actual ladder with vanilla inputs in survival, after collecting no special recovery equipment.
  await s.command(`execute in ${OW} run tp ${AGENT} ${x+.5} ${by} ${z+.5} -90 0`);
  await s.command(`player ${AGENT} move forward`);
  const until=Date.now()+Math.max(30000,(top-by)*550);let at;
  while(Date.now()<until){at=pos(await s.command(`data get entity ${AGENT} Pos`));if(at?.[1]>=top-.3)break;await sleep(700);}
  await s.command(`player ${AGENT} stop`);r.route.climbedTo=at;r.route.pass=at?.[1]>=top-.3;
  if(!r.route.pass)throw new Error('Vanilla ladder ascent did not reach the surface');
 }
 // A distinctive, safe world spawn in the disposable copy proves fallback even for beds beside natural world spawn.
 await s.command(`execute in ${OW} run forceload add 4096 4096`);await loaded(OW,4096,4096);
 await s.command(`execute in ${OW} run fill 4092 299 4092 4100 299 4100 minecraft:cobblestone`);
 await s.command(`execute in ${OW} run fill 4092 300 4092 4100 319 4100 minecraft:air`);
 await s.command('setworldspawn 4096 300 4096');await s.command('gamerule minecraft:respawn_radius 0');
 await s.command(`execute in ${OW} run setblock ${bx} ${by} ${bz} minecraft:air`);await s.command(`execute in ${OW} run setblock ${bx+1} ${by} ${bz} minecraft:air`);
 await sleep(4000);r.brokenBedRespawn=await respawn();r.brokenBedRespawn.expectedWorldSpawn=[4096.5,300,4096.5];r.brokenBedRespawn.pass=/overworld/.test(r.brokenBedRespawn.dimension)&&r.brokenBedRespawn.pos&&Math.hypot(...r.brokenBedRespawn.pos.map((n,i)=>n-r.brokenBedRespawn.expectedWorldSpawn[i]))<3;
 r.pass=[r.kit,r.safety,r.spareKit,r.route,r.bedRespawn,r.brokenBedRespawn].every(x=>x.pass);
 }
}catch(error){r.error=String(error.stack??error);r.pass=false;}finally{await s?.stop().catch(()=>{});}
r.finishedAt=new Date().toISOString();await writeFile(path.join(out,'result.json'),JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({checkpoint:r.checkpoint,pass:r.pass,error:r.error}));process.exitCode=r.pass?0:1;
