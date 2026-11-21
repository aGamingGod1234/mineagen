#!/usr/bin/env node
// Provider-free check that the seen portal frame row reports frame cells, blockers and lighting from real observations.
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
// FIXTURE_TICK_RATE (test only): the frame reads and the bucket actions run at 20 TPS: between a pour and its scoop the
// harness reads blocks and swaps items while the lava's 30-tick spread delay runs, and at 60 TPS those steps take three
// times as many ticks. Settling waits and the 3 s spread watch after the scoop pass at the fixture rate (rate.idleSleep).
// frames.json's tick holds the rates over the run.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { handRolledTickRate } from './lib/fixture-play.mjs';
import { unshownTickRate } from './watch-replay.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const out=resolve(process.argv[2] ?? 'runtime/portal-frame-live');
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
let rcon,bridge,record,observation,rate;
const agent='Frame';
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
try {
  for(let i=0;i<150;i++){try{rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,connectTimeoutMs:500,commandTimeoutMs:5000});await rcon.connect();break}catch(e){await rcon?.close();if(i===149)throw e;await sleep(1000)}}
  bridge=new MultiplexedServerBridge({port,secret},{});inbox=new Inbox(bridge);
  rate=handRolledTickRate(text=>command(text),bridge, agent, { tickRate: unshownTickRate('it already fails at 20 TPS, so an A/B cannot show the same game at 60') });
  bridge.on('observation',e=>{if(e.agentId===record?.agentId&&e.payload.ready){observation=e.payload}});
  bridge.on('goal_spec_request',e=>{bridge.send('goal_spec_proposal',e.agentId,{requestId:e.payload.requestId,summary:'Controlled live mechanics fixture',predicate:{type:'survive_duration',ticks:12000}}).catch(()=>{});});
  const ready=inbox.wait('ready');bridge.start();await ready;
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free portal frame fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
  await command('difficulty peaceful');await command('gamerule minecraft:send_command_feedback false');await command('time set noon');
  await command('forceload add -16 -16 32 32');await rate.idleSleep(2000);
  await command('fill -5 75 -5 20 90 10 minecraft:air');await command('fill -4 79 -4 2 79 4 minecraft:stone');
  const registered=inbox.wait('agent_registered');console.log(await command(`execute positioned 0.5 80 0.5 run mineagen summon gpt-6.1-sol low ${agent}`));
  const e=await registered;record={...(e.payload.record??e.payload),agentId:e.agentId};
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  const started=inbox.wait('goal_control',e=>e.payload.operation==='start');await command(`mineagen start ${agent} Survive for 600 seconds.`);record.goalRevision=(await started).payload.goalRevision;
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  await command('fill -4 79 -4 5 79 8 minecraft:stone');
  await command(`gamemode survival ${agent}`);
  const frame=row=>row.sighted?.portalFrames?.[0];
  async function act(type,args,{refusal=false}={}){
    const id=`frame-${++ordinal}`;
    const r=await executeAction({actionId:id,action:{type,arguments:args},provenance:{traceId:id,programId:'frame-fixture',stepId:id,eventSequence:observation.eventSequence}});
    if(r.state!=='SUCCEEDED'&&!refusal)throw new Error(JSON.stringify(r));
    return r;
  }
  const look=async yaw=>{await command(`tp ${agent} 0.5 80 0.5 ${yaw} 10`);await rate.idleSleep(600);return observe();};
  const t0=rate.clock.now(),wall0=Date.now(),timer=await rate.gameTimer();
  const results={};
  // Bottom two and the left pillar of a 2x3 interior at x0..1 y81..83 z4; the top row (y84) is above the block rows' window.
  for(const [x,y] of [[0,80],[1,80],[-1,81],[-1,82],[-1,83]]) await command(`setblock ${x} ${y} 4 minecraft:obsidian`);
  let o=await look(0);results.partial=frame(o);
  if(!results.partial||results.partial.obsidian!==5||results.partial.missing.length!==5)throw new Error(`partial ${JSON.stringify(results.partial)}`);
  for(const [x,y] of [[2,81],[2,82],[2,83],[0,84],[1,84]]) await command(`setblock ${x} ${y} 4 minecraft:obsidian`);
  await command('setblock 1 82 4 minecraft:cobblestone');
  o=await look(0);results.blocked=frame(o);
  if(results.blocked?.obsidian!==10||results.blocked.missing.length!==0||results.blocked.blocked.length!==1)throw new Error(`blocked ${JSON.stringify(results.blocked)}`);
  if(!(o.blocks??[]).every(b=>b.y<=83))results.note='block rows reach above +3';
  await command('setblock 1 82 4 minecraft:air');
  o=await look(0);results.complete=frame(o);
  if(results.complete?.missing.length!==0||results.complete.blocked.length!==0||results.complete.lit)throw new Error(`complete ${JSON.stringify(results.complete)}`);
  o=await look(180);results.away=frame(o)??null;
  if(results.away)throw new Error(`frame reported while facing away ${JSON.stringify(results.away)}`);
  await command('setblock 0 81 4 minecraft:fire');await rate.idleSleep(500);
  o=await look(0);results.lit=frame(o);
  if(!results.lit?.lit)throw new Error(`lit ${JSON.stringify(results.lit)}`);
  // Casting facts through real bucket actions: water beside or above converts a poured lava source at once; water only
  // below does not; an unconverted source can be scooped back before it spreads.
  const is=async(x,y,z,id)=>/passed/i.test(await command(`execute if block ${x} ${y} ${z} minecraft:${id}`));
  await command('fill -4 80 -4 5 86 3 minecraft:air');
  await command(`tp ${agent} 0.5 80 -2.5 0 30`);await rate.idleSleep(500);await observe();
  const pour=async(x,y,z,extra={},options={})=>{await command(`item replace entity ${agent} weapon.mainhand with minecraft:lava_bucket`);await rate.idleSleep(200);await observe();
    return act('interact_block',{x,y:y-1,z,face:'up',hand:'main',expectedItemId:'minecraft:lava_bucket',...extra},options);};
  await command('setblock -2 80 0 minecraft:cobblestone');await command('setblock -1 80 0 minecraft:cobblestone');await command('setblock -1 81 0 minecraft:water');
  await pour(-2,81,0);results.waterBeside=await is(-2,81,0,'obsidian');
  await command('fill -4 80 -1 4 82 1 minecraft:air');
  await command('setblock 2 80 0 minecraft:cobblestone');await command('setblock 2 79 0 minecraft:water');
  await pour(2,81,0);results.waterOnlyBelowStaysLava=await is(2,81,0,'lava');
  await command('setblock 2 81 0 minecraft:air');await command('setblock 2 79 0 minecraft:stone');
  await command('setblock 0 80 1 minecraft:cobblestone');
  // This pour's flow would reach the body: the lava safety rule refuses it unless the caller accepts the risk.
  const guarded=await pour(0,81,1,{},{refusal:true});results.pourAtBodyRefused=guarded.reasonCode==='LAVA_POUR_AT_BODY'&&!(await is(0,81,1,'lava'));
  await pour(0,81,1,{acceptLavaRisk:true});results.noWaterIsLava=await is(0,81,1,'lava');
  await command(`item replace entity ${agent} weapon.mainhand with minecraft:bucket`);await rate.idleSleep(200);await observe();
  await act('interact_block',{x:0,y:81,z:1,face:'north',hand:'main',expectedItemId:'minecraft:bucket'});
  await rate.idleSleep(3000);
  results.scoopedBack=await is(0,81,1,'air');
  results.noSpread=!(await is(0,81,0,'lava'))&&!(await is(1,81,1,'lava'))&&!(await is(-1,81,1,'lava'))&&!(await is(0,80,0,'lava'));
  if(!results.waterBeside||!results.waterOnlyBelowStaysLava||!results.pourAtBodyRefused||!results.noWaterIsLava||!results.scoopedBack||!results.noSpread)throw new Error(`casting ${JSON.stringify(results)}`);
  results.tick={tickRate:rate.tickRate,rates:await timer.rates().catch(()=>null),seconds:Math.round((rate.clock.now()-t0)/1000),gameSeconds:Math.round((await timer.elapsed())/1000),wallSeconds:Math.round((Date.now()-wall0)/1000),held:await rate.tickReport()};
  await writeFile(join(out,'frames.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
  console.log('Portal frame variants and casting facts recorded');
} finally {
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
