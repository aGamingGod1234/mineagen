#!/usr/bin/env node
// Provider-free End refill room: after the End enderman default's feet pour (#191), a player that follows the dragon
// fact's water hint picks the water back up with use_item, and the bucket is full again.
//   node scripts/quality/lib/with-jar.mjs JAR scripts/quality/test-end-refill-live.mjs OUT
// The pour is the default's own act (the water bucket emptied at the feet onto end stone). The player then stands 2 or
// 3 blocks off in a random direction, as it does after moving on in a fight, reads combatFacts as the model sees them
// beside a dragon, and aims the empty bucket at the centre of the cell the fact names. Exit 0 PASS (a water bucket in
// hand), 1 FAIL, 2 INVALID (no source was poured, or the room could not run). Always launch under slot.sh live; ports come from SLOT_PORT_BASE.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { installTickRate, unshownTickRate } from './watch-replay.mjs';
import { damageCounter, recordDamageEvidence } from './lib/damage-counter.mjs';
import { combatFacts } from '../../coordinator/src/combat-facts.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { finishRun, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';

if(process.argv.includes('--help')){console.log('Usage: test-end-refill-live.mjs OUT_DIR (jar from lib/with-jar.mjs)\n'+FIXTURE_OUTCOME_HELP);process.exit(0);}

const root=fileURLToPath(new URL('../..',import.meta.url));
const out=resolve(process.argv[2] ?? 'runtime/end-refill-live');
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if(!template || !process.env.SLOT_PORT_BASE || !process.env.JAVA_HOME){console.error('Set JAVA_HOME and ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');process.exit(2);}
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
const agent='Refill';
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
// The play's game and wall seconds, the rates the server held, and vanilla's damage counter over it.
async function endPlay(){
  const p=play;p.done=true;
  // elapsed() reads the world tick first, so the clock is anchored on it when seconds is read.
  const gameMs=await p.timer.elapsed();
  const tick={tickRate:rate.tickRate,seconds:Math.round((rate.clock.now()-p.t0)/1000),wallSeconds:Math.round((Date.now()-p.wall0)/1000),
    gameSeconds:Math.round(gameMs/1000),rates:await p.timer.rates().catch(()=>null)};
  await rate.normalRate();
  tick.held=await rate.tickReport();
  recordDamageEvidence(tick, p.damage0,await p.damage().catch(()=>null));
  return tick;
}
const row={name:'end-refill'};
try {
  for(let i=0;i<150;i++){try{rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,connectTimeoutMs:500,commandTimeoutMs:5000});await rcon.connect();break}catch(e){await rcon?.close();if(i===149)throw e;await sleep(1000)}}
  // Water spreads on game ticks and the player is pushed by it, so the room plays at 20 like bucket-aim.
  rate=installTickRate({command:text=>command(text)},unshownTickRate('water spread and push timing, as bucket-aim'));
  bridge=new MultiplexedServerBridge({port,secret},{});inbox=new Inbox(bridge);
  bridge.on('observation',e=>{rate.clock.observe(e.payload?.world?.gameTime);if(e.agentId===record?.agentId&&e.payload.ready){observation=e.payload}});
  bridge.on('goal_spec_request',e=>{bridge.send('goal_spec_proposal',e.agentId,{requestId:e.payload.requestId,summary:'Controlled live mechanics fixture',predicate:{type:'survive_duration',ticks:12000}}).catch(()=>{});});
  const ready=inbox.wait('ready');bridge.start();await ready;
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free End refill fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
  await command('difficulty peaceful');await command('gamerule minecraft:send_command_feedback false');await command('time set noon');
  await command('forceload add -16 -16 32 32');await sleep(2000);
  await command('fill -12 75 -12 12 90 12 minecraft:air');await command('fill -4 79 -4 2 79 4 minecraft:stone');
  const registered=inbox.wait('agent_registered');console.log(await command(`execute positioned 0.5 80 0.5 run mineagen summon gpt-6.1-sol low ${agent}`));
  const e=await registered;record={...(e.payload.record??e.payload),agentId:e.agentId};
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  const started=inbox.wait('goal_control',e=>e.payload.operation==='start');await command(`mineagen start ${agent} Survive for 600 seconds.`);record.goalRevision=(await started).payload.goalRevision;
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  await command('fill -4 79 -4 5 79 8 minecraft:stone');
  await command(`gamemode survival ${agent}`);
  async function act(type,args){
    const id=`refill-${++ordinal}`;
    const r=await executeAction({actionId:id,action:{type,arguments:args},provenance:{traceId:id,programId:'refill-fixture',stepId:id,eventSequence:observation.eventSequence}});
    return r;
  }
  // An end stone deck wide enough that the poured water (7 cells of flow) stays on it.
  await command('fill -10 79 -10 10 79 10 minecraft:end_stone');
  const results={};
  const is=async(x,y,z,id)=>/passed/i.test(await command(`execute if block ${x} ${y} ${z} minecraft:${id}`));
  const holds=async id=>/passed/i.test(await command(`execute if items entity ${agent} weapon.mainhand minecraft:${id}`));
  const damage=await damageCounter(command,agent);
  play={damage0:await damage(),damage};
  await rate.fastRate();
  play.t0=rate.clock.now();play.wall0=Date.now();play.timer=await rate.gameTimer();
  // The #191 default's pour: a water bucket emptied at the feet, looking straight down.
  await command(`item replace entity ${agent} weapon.mainhand with minecraft:water_bucket`);
  await command(`tp ${agent} 0.5 80 0.5 0 90`);await rate.clock.sleep(600);await observe();
  let r=await act('use_item',{mode:'once',durationMs:250,expectedItemId:'minecraft:water_bucket',aimX:0.5,aimY:80.0,aimZ:0.5});
  results.pour={state:r.state,reasonCode:r.reasonCode,message:r.message,source:await is(0,80,0,'water[level=0]')};
  if(!results.pour.source||!await holds('bucket')){
    row.notExercised='the feet pour left no water source at 0,80,0';
  } else {
    await rate.clock.sleep(2500);
    // Moved on: 2 or 3 blocks off along an axis, or 2 diagonally (within a bucket's reach of the pour), facing it.
    const dirs=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
    const [dx,dz]=dirs[Math.floor(Math.random()*dirs.length)],d=dx&&dz?2:2+Math.floor(Math.random()*2);
    const x=0.5+dx*d,z=0.5+dz*d,yaw=Math.atan2(-(0.5-x),0.5-z)*180/Math.PI;
    results.stand={x,z,yaw:Math.round(yaw)};
    await command(`tp ${agent} ${x} 80 ${z} ${yaw.toFixed(1)} 35`);await rate.clock.sleep(800);
    const seen=await observe();
    // The dragon fact as the model reads it beside the dragon: the room has no dragon, so one is added to the entity list.
    // The coordinator's reflex book sees the #191 default's firing report for this pour (the mod's detail wording) and
    // hands the remembered cells to the fact, as dynamic-main does for a wake; a book without pours names none.
    const book=new ReflexBook();book.observeContext(agent,seen);
    book.observe(agent,{revision:0,rules:[],events:[{seq:1,id:'default-ender-water',outcome:'done',ms:50,detail:'placed minecraft:water_bucket at feet 0,80,0; the source stays until scooped'}]});
    const ownPours=book.pours?.(agent,seen)??[];
    results.ownPours=ownPours;
    const facts=combatFacts({...seen,entities:[...(seen.entities??[]),{type:'minecraft:ender_dragon',distance:60,alive:true}]},{ownPours})??'';
    const hint=facts.match(/Water (?:source )?(?:seen|you poured) at (-?\d+),(-?\d+),(-?\d+)/);
    results.fact=hint?hint[0]:null;
    results.waterRows=(seen.blocks??[]).filter(b=>b.blockId==='minecraft:water').length;
    if(hint){
      const [hx,hy,hz]=hint.slice(1).map(Number);
      results.hintSource=await is(hx,hy,hz,'water[level=0]');
      r=await act('use_item',{mode:'once',durationMs:250,expectedItemId:'minecraft:bucket',aimX:hx+0.5,aimY:hy+0.5,aimZ:hz+0.5});
      results.refill={state:r.state,reasonCode:r.reasonCode,message:r.message};
    }
    results.full=await holds('water_bucket');
    row.tick=results.tick=await endPlay();
    row.pass=results.full;
    if(!results.full)row.failReason=`no water bucket after the refill: ${results.fact??'no water hint'}; ${results.refill?.reasonCode??''} ${results.refill?.message??''}`;
  }
  row.results=results;
  await writeFile(join(out,'refill.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} catch(error) {
  row.error=String(error?.stack??error);
} finally {
  if(play&&!play.done)await endPlay().then(tick=>writeFile(join(out,'tick.json'),JSON.stringify(tick,null,2))).catch(()=>{});
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
const summary=await finishRun([row],{file:join(out,'result.json')});
console.log(summary.line);
