#!/usr/bin/env node
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { installTickRate, unshownTickRate } from './watch-replay.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { damageCounter, recordDamageEvidence, deathCounter, recordDeathEvidence } from './lib/damage-counter.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const jarPath=resolve(process.env.ARENA_JAR ?? join(root,MOD_JAR));
// Live check that the mod reports End crystals the agent saw destroyed: one killed, one gone without a kill whose spot is
// in view (moved to another dimension), and one live crystal that keeps its ordinary row. No model call.
const USAGE='Usage: test-end-crystal-gone-live.mjs OUT_DIR under slot.sh live (ARENA_JAR names the mod jar)';
if(process.argv.includes('--help')){console.log(USAGE+'\n'+EDIT_LOOP_HELP+'\n'+FIXTURE_OUTCOME_HELP);process.exit(0);}
if(!process.argv[2]||!process.env.ARENA_HEADLESS_SERVER_TEMPLATE||!process.env.SLOT_PORT_BASE){console.error(USAGE);process.exit(2);}
const out=resolve(process.argv[2]);
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
const port=Number(process.env.SLOT_PORT_BASE), server=join(out,'server');
await mkdir(out,{recursive:true});
if((await readdir(out)).length)throw new Error('Use a fresh output directory');
await writeFile(join(out,'manifest.json'),JSON.stringify({kind:'provider-free live mechanics',aiPerformanceMeasured:false,fixtureSetupUsesOperatorCommands:true,jarSha256:createHash('sha256').update(await readFile(jarPath)).digest('hex'),node:process.version},null,2));
await cp(template,server,{recursive:true});
for(const name of await readdir(join(server,'mods'))) if(name.startsWith('mineagen-')) {
  const {unlink}=await import('node:fs/promises'); await unlink(join(server,'mods',name));
}
await cp(jarPath,join(server,'mods/mineagen-0.2.0.jar'));
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
const agent='Watcher';
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
  recordDeathEvidence(tick, p.deaths0, await p.deaths().catch(() => null));
  return tick;
}
const rows=[];const startedAt=Date.now();
try {
  for(let i=0;i<150;i++){try{rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,connectTimeoutMs:500,commandTimeoutMs:5000});await rcon.connect();break}catch(e){await rcon?.close();if(i===149)throw e;await sleep(1000)}}
  rate=installTickRate({command:text=>command(text)},unshownTickRate('its waits are wall clock'));
  bridge=new MultiplexedServerBridge({port,secret},{});inbox=new Inbox(bridge);
  bridge.on('observation',e=>{rate.clock.observe(e.payload?.world?.gameTime);if(e.agentId===record?.agentId&&e.payload.ready){observation=e.payload}});
  bridge.on('goal_spec_request',e=>{bridge.send('goal_spec_proposal',e.agentId,{requestId:e.payload.requestId,summary:'Controlled live mechanics fixture',predicate:{type:'survive_duration',ticks:12000}}).catch(()=>{});});
  const ready=inbox.wait('ready');bridge.start();await ready;
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free bow fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
  await command('difficulty peaceful');await command('gamerule minecraft:send_command_feedback false');await command('time set noon');
  await command('execute in minecraft:the_end run forceload add 176 -32 240 32');await sleep(3000);
  await command('execute in minecraft:the_end run fill 196 79 -4 204 79 4 minecraft:stone');
  const registered=inbox.wait('agent_registered');console.log(await command(`execute in minecraft:the_end positioned 200.5 80 0.5 run mineagen summon gpt-6.1-sol low ${agent}`));
  const e=await registered;record={...(e.payload.record??e.payload),agentId:e.agentId};
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  const started=inbox.wait('goal_control',e=>e.payload.operation==='start');await command(`mineagen start ${agent} Survive for 600 seconds.`);record.goalRevision=(await started).payload.goalRevision;
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  await command(`gamemode survival ${agent}`);
  await command(`effect give ${agent} minecraft:resistance 600 4 true`);
  await command(`item replace entity ${agent} weapon.mainhand with minecraft:bow`);
  await command(`give ${agent} minecraft:arrow 64`);
  const uuid=n=>`00000000-0000-0000-0000-${n.toString(16).padStart(12,'0')}`;
  const uuidInts=n=>`[I;0,0,0,${n}]`;
  const results={};
  await command(`execute in minecraft:the_end run tp ${agent} 200.5 80 0.5 -90 0`);await sleep(1500);
  const rowsOf=async(id)=>{const o=await observe();if(o.world?.dimension!=='minecraft:the_end')throw new Error('agent not in the End: '+o.world?.dimension);return (o.entities??[]).filter(x=>x.uuid===uuid(id));};
  async function until(id,test,label){let rows;for(let i=0;i<20;i++){rows=await rowsOf(id);if(test(rows))return rows;await sleep(500);}throw new Error("never "+label+" for "+uuid(id)+" rows "+JSON.stringify(rows));}
  // (a) killed: seen standing, then killed; the next observations carry it as alive:false at its spot.
  await command('execute in minecraft:the_end run fill 210 79 0 210 79 0 minecraft:obsidian');
  await command(`execute in minecraft:the_end run summon minecraft:end_crystal 210.5 80 0.5 {ShowBottom:0b,UUID:${uuidInts(101)}}`);
  await until(101,r=>r.length===1&&r[0].alive!==false,'seen standing');
  await command(`execute in minecraft:the_end run kill @e[type=minecraft:end_crystal,x=210,y=80,z=0,distance=..2]`);
  const killed=await until(101,r=>r.length===1&&r[0].alive===false,'reported gone');
  results.killed=killed[0];
  // Still reported a few observations later, never alongside a live row of the same id.
  await sleep(2000); results.killedLater=(await rowsOf(101)).length;
  // (b) gone some other way (moved to another dimension, not killed): its spot is in plain view and empty.
  await command('execute in minecraft:the_end run fill 205 79 1 205 79 1 minecraft:obsidian');
  await command(`execute in minecraft:the_end run summon minecraft:end_crystal 205.5 80 1.5 {ShowBottom:0b,UUID:${uuidInts(102)}}`);
  await until(102,r=>r.length===1&&r[0].alive!==false,'second seen standing');
  await command(`execute in minecraft:the_end as @e[type=minecraft:end_crystal,x=205,y=80,z=1,distance=..2] in minecraft:overworld run tp @s 0.5 120 0.5`);
  const moved=await until(102,r=>r.length===1&&r[0].alive===false,'second reported gone');
  results.moved=moved[0];
  // A live crystal never gets a gone row.
  await command(`execute in minecraft:the_end run summon minecraft:end_crystal 208.5 80 -1.5 {ShowBottom:0b,UUID:${uuidInts(103)}}`);
  await sleep(1500); const live=await rowsOf(103); results.live=live;
  const ok=results.killed.alive===false && Math.abs(results.killed.position.x-210.5)<1 && results.killedLater===1 && results.moved.alive===false
    && live.length===1 && live[0].alive!==false;
  results.pass=ok;
  console.log(ok?'PASS':'FAIL',JSON.stringify(results));
  rows.push({name:'crystal-gone',startedAt,finishedAt:Date.now(),pass:ok,...(ok?{}:{failReason:'a gone crystal was not reported, or a live one was'}),results});
} catch(error){console.error(error);rows.push({name:'crystal-gone',startedAt,finishedAt:Date.now(),error:String(error?.stack??error)});}
finally {
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
const report=await finishRun(rows,{file:join(out,'result.json'),planned:1,hits:false});
process.exit(report.exitCode);
