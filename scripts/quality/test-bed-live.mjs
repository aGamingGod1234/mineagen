#!/usr/bin/env node
// Provider-free bed parity checks through the production bridge actions.
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { installTickRate, fixtureTickRate } from './watch-replay.mjs';
import { damageCounter, damageEvidence } from './lib/damage-counter.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const out=resolve(process.argv[2] ?? 'runtime/bed-live');
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if(!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port=Number(process.env.SLOT_PORT_BASE), server=join(out,'server');
await mkdir(out,{recursive:true});
if((await readdir(out)).length)throw new Error('Use a fresh output directory');
await writeFile(join(out,'manifest.json'),JSON.stringify({kind:'provider-free live mechanics',aiPerformanceMeasured:false,fixtureSetupUsesOperatorCommands:true,jarSha256:createHash('sha256').update(await readFile(join(root,MOD_JAR))).digest('hex'),node:process.version},null,2));
await cp(template,server,{recursive:true});
for(const name of await readdir(join(server,'mods'))) if(name.startsWith('mineagen-')) {
  const {unlink}=await import('node:fs/promises'); await unlink(join(server,'mods',name));
}
await cp(join(root,MOD_JAR),join(server,'mods/mineagen-0.2.0.jar'));
const secret=randomBytes(32).toString('hex');
await writeFile(join(out,'secret.txt'),secret,{mode:0o600});
await writeFile(join(server,'server.properties'),`online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port+2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port+1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261017\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=5\nsimulation-distance=5\npause-when-empty-seconds=-1\nmax-players=4\n`);
const {open}=await import('node:fs/promises');
const log=await open(join(out,'server.log'),'a');
const child=spawn(`${process.env.JAVA_HOME}/bin/java`,[`-Dmineagen.bridgePort=${port}`,'-Dmineagen.coordinatorAutoStart=false',`-Dmineagen.bridgeSecretFile=${join(out,'secret.txt')}`,'-Xms512M','-Xmx2G','-jar','fabric-server-launch.jar','nogui'],{cwd:server,stdio:['ignore',log.fd,log.fd]});
await writeFile(join(out,'server.pid'),String(child.pid));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Inbox {
  events=[]; waiters=[];
  constructor(bridge){bridge.on('message',e=>this.accept(e));bridge.on('ready',e=>this.accept({type:'ready',...e}));}
  accept(e){const i=this.waiters.findIndex(w=>w.type===e.type&&w.match(e));if(i>=0)this.waiters.splice(i,1)[0].done(e);else {this.events.push(e);if(this.events.length>1024)this.events.shift();}}
  wait(type,match=()=>true,ms=30000){const i=this.events.findIndex(e=>e.type===type&&match(e));if(i>=0)return Promise.resolve(this.events.splice(i,1)[0]);return new Promise((res,rej)=>{const w={type,match,done:e=>{clearTimeout(t);res(e)}};const t=setTimeout(()=>{this.waiters=this.waiters.filter(x=>x!==w);rej(new Error(`TIMEOUT ${type}`))},ms);this.waiters.push(w)});}
}
let rcon,bridge,record,observation,rate,play=null;
const agent='Night';
const command=async s=>{
  if(rcon.state==='closed'){rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,commandTimeoutMs:5000});await rcon.connect();}
  return (await rcon.command(s)).text;
};
async function observe(){const seq=observation?.eventSequence??0;const next=inbox.wait('observation',e=>e.agentId===record.agentId&&e.payload.ready&&e.payload.eventSequence>seq);await bridge.send('request_observation',record.agentId,{goalRevision:record.goalRevision});return (await next).payload;}
let ordinal=0,inbox;
const actions=[];
async function executeAction(c){
  const args=c.action.arguments;
  const payload={actionId:c.actionId,traceId:c.provenance.traceId,goalRevision:record.goalRevision,actionType:c.action.type,arguments:args,
    provenance:{provider:record.provider,model:record.model,reasoningEffort:record.reasoningEffort,serviceTier:record.serviceTier,traceId:c.provenance.traceId,programId:c.provenance.programId,programVersion:c.provenance.programVersion??1,sourceStepId:c.provenance.stepId,eventSequence:c.provenance.eventSequence}};
  const next=inbox.wait('action_result',e=>e.payload.actionId===c.actionId&&['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(e.payload.state),65000);
  await bridge.send('action_command',record.agentId,payload);
  const r=(await next).payload;
  await bridge.send('action_result_ack',record.agentId,{actionId:c.actionId,goalRevision:record.goalRevision});
  actions.push({type:c.action.type,args,state:r.state,reasonCode:r.reasonCode,message:r.message});
  await writeFile(join(out,'actions.json'),JSON.stringify(actions,null,2));
  return r;
}
// The play's game and wall seconds, the rates the server held, and vanilla's damage counter over it (tick.json).
async function endPlay(){
  const p=play;
  // elapsed() reads the world tick first, so the clock is anchored on it when seconds is read.
  const gameMs=await p.timer.elapsed();
  const tick={tickRate:rate.tickRate,seconds:Math.round((rate.clock.now()-p.t0)/1000),wallSeconds:Math.round((Date.now()-p.wall0)/1000),
    gameSeconds:Math.round(gameMs/1000),rates:await p.timer.rates().catch(()=>null)};
  await rate.normalRate();
  tick.held=await rate.tickReport();
  tick.damageTaken=damageEvidence(p.damage0,await p.damage().catch(()=>null)).damageTaken;
  return tick;
}
try {
  for(let i=0;i<150;i++){try{rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,connectTimeoutMs:500,commandTimeoutMs:5000});await rcon.connect();break}catch(e){await rcon?.close();if(i===149)throw e;await sleep(1000)}}
  // FIXTURE_TICK_RATE: setup runs at 20; from the first craft to the last bed use the server runs at the fixture rate.
  rate=installTickRate({command:text=>command(text)},fixtureTickRate());
  bridge=new MultiplexedServerBridge({port,secret},{});inbox=new Inbox(bridge);
  bridge.on('observation',e=>{rate.clock.observe(e.payload?.world?.gameTime);if(e.agentId===record?.agentId&&e.payload.ready){observation=e.payload}});
  bridge.on('goal_spec_request',e=>{bridge.send('goal_spec_proposal',e.agentId,{requestId:e.payload.requestId,summary:'Controlled live mechanics fixture',predicate:{type:'survive_duration',ticks:12000}}).catch(()=>{});});
  const ready=inbox.wait('ready');bridge.start();await ready;
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free bed fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
  await command('difficulty peaceful');await command('gamerule minecraft:send_command_feedback false');await command('time set noon');
  await command('forceload add -16 -16 32 32');await sleep(2000);
  await command('fill -5 75 -5 20 90 10 minecraft:air');await command('fill -4 79 -4 2 79 4 minecraft:stone');
  const registered=inbox.wait('agent_registered');console.log(await command(`execute positioned 0.5 80 0.5 run mineagen summon gpt-6.1-sol low ${agent}`));
  const e=await registered;record={...(e.payload.record??e.payload),agentId:e.agentId};
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  const started=inbox.wait('goal_control',e=>e.payload.operation==='start');await command(`mineagen start ${agent} Survive for 600 seconds.`);record.goalRevision=(await started).payload.goalRevision;
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  await command('fill -4 79 -4 5 79 5 minecraft:stone');
  await command('setblock 1 80 0 minecraft:crafting_table');
  await command(`clear ${agent}`);
  await command(`give ${agent} minecraft:white_wool 3`);
  await command(`give ${agent} minecraft:oak_planks 3`);
  await command('time set 14000');
  await command(`gamemode survival ${agent}`);
  async function act(type,args){
    const id=`bed-${++ordinal}`;
    const r=await executeAction({actionId:id,action:{type,arguments:args},provenance:{traceId:id,programId:'bed-fixture',stepId:id,eventSequence:observation.eventSequence}});
    if(r.state!=='SUCCEEDED')throw new Error(JSON.stringify(r));
    return r;
  }
  await observe();
  const damage=await damageCounter(command,agent);
  play={damage0:await damage(),damage};
  await rate.fastRate();
  play.t0=rate.clock.now();play.wall0=Date.now();play.timer=await rate.gameTimer();
  await act('craft_table',{x:1,y:80,z:0,recipeId:'minecraft:white_bed',count:1,timeoutMs:10000});
  await act('place_block',{x:0,y:80,z:2,face:'up',itemId:'minecraft:white_bed'});
  const placed=await observe();
  await writeFile(join(out,'placed.json'),JSON.stringify(placed,null,2));
  const bed=placed.blocks.find(b=>b.blockId==='minecraft:white_bed');
  if(!bed)throw new Error('Placed bed not observed');
  await act('interact_block',{x:bed.x,y:bed.y,z:bed.z,face:'up',hand:'main',expectedItemId:'minecraft:air'});
  await rate.clock.sleep(6000);
  const after=await observe();
  const spawn=await command(`data get entity ${agent} respawn`);
  await writeFile(join(out,'sleep-evidence.json'),JSON.stringify({before:placed.world,after:after.world,player:after.player,events:after.perception,spawn,actions},null,2));
  console.log(JSON.stringify({before:placed.world.dayTime,after:after.world.dayTime,spawn}));
  if(after.world.dayTime%24000>=12000||!/pos/.test(spawn))throw new Error('Night skip or spawn not verified');
  // Vanilla daytime use sets spawn and reports why sleep cannot start.
  await command('time set noon');
  await act('interact_block',{x:bed.x,y:bed.y,z:bed.z,face:'up',hand:'main',expectedItemId:'minecraft:air'});
  await rate.clock.sleep(250);
  const daytime=await observe();
  await writeFile(join(out,'daytime.json'),JSON.stringify(daytime,null,2));
  if(!daytime.perception.events.some(e=>e.text?.includes('only at night')))throw new Error('Missing daytime rejection');
  // A nearby monster can block sleep without preventing the spawn point update.
  await command('time set 14000');await command('difficulty normal');
  await command('summon minecraft:zombie 3.5 80 2.5 {NoAI:1b,PersistenceRequired:1b}');
  await act('interact_block',{x:bed.x,y:bed.y,z:bed.z,face:'up',hand:'main',expectedItemId:'minecraft:air'});
  await rate.clock.sleep(250);
  const monster=await observe();
  await writeFile(join(out,'monster.json'),JSON.stringify(monster,null,2));
  if(!monster.perception.events.some(e=>e.text?.includes('monsters nearby')))throw new Error('Missing monster rejection');
  if(monster.world.dayTime%24000<12000)throw new Error('Monster failed to block night skip');
  console.log('Bed crafting, placement, sleep, spawn and rejection variants recorded');
} finally {
  if(play)await endPlay().then(tick=>writeFile(join(out,'tick.json'),JSON.stringify(tick,null,2))).catch(()=>{});
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
