import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DecisionLog } from '../src/decision-log.mjs';
import { NativeCallLog } from '../src/native-call-log.mjs';
import { resolveDynamicCliRuntime } from '../src/dynamic-main.mjs';
import { timeline } from '../scripts/read-decisions.mjs';

const record = { agentId: 'agent-a', provider: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'low', serviceTier: 'default', goalRevision: 3 };
async function fixture(t, options = {}) {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'aa-decision-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 // These tests read the file after close, so close must wait for every write. Its 1 s shutdown bound is shorter than the
 // first write on Windows, which sets the owner-only ACL through PowerShell before appending.
 const log = new DecisionLog({ directory, closeTimeoutMs: 30_000, ...options }); t.after(() => log.close());
 return { directory, log, file: log.pathFor(record.agentId) };
}
function call(log, args = { x: 12, y: 64, z: 3, purpose: 'Reach water' }) {
 const turn = log.begin(record, { traceId: 'wake-1' });
 const native = new NativeCallLog({ onEvent: turn.onEvent });
 native.input('turn_input', '  wake\nlean input as sent\n');
 native.reasoningDelta('r1', 'Need water.'); native.reasoning('Need water.', 'r1');
 native.output('I will reach the river.', null, 'm1');
 native.toolCall({ callId: 'c1', name: 'walk_to', arguments: args });
 native.toolResult('c1', JSON.stringify({ actionId: 'a1', state: 'RUNNING' }), { success: true });
 native.output('At the river.', null, 'm2');
 turn.finish();
 return native;
}

test('decision rows preserve sent input, full arguments, summary, assistant and result links', async t => {
 const { log, file } = await fixture(t);
 call(log, { x: 12, purpose: 'Reach water', source: 'a'.repeat(40_000) });
 log.actionResult(record.agentId, { actionId: 'a1', state: 'SUCCEEDED', message: 'Arrived' });
 await log.close();
 const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
 const decisions = rows.filter(r => r.type === 'decision');
 assert.equal(decisions.length, 2);
 const first = decisions[0];
 assert.equal(first.agentId, record.agentId); assert.equal(first.provider, 'codex');
 assert.equal(first.model, record.model); assert.equal(first.effort, 'low'); assert.equal(first.serviceTier, 'default');
 assert.equal(first.inputs[0].text, '  wake\nlean input as sent\n');
 assert.equal(first.toolCalls[0].arguments.source.length, 40_000);
 assert.equal(first.reasoning, 'Need water.'); assert.equal(first.assistant, 'I will reach the river.');
 assert.equal(rows.find(r => r.type === 'action_result').decisionId, first.decisionId);
 assert.match(timeline(rows), /walk_to.*Reach water/); assert.match(timeline(rows), /SUCCEEDED/);
 // Windows has no POSIX mode bits; its owner-only ACL is checked by the private artifact tests.
 if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('all capture surfaces redact API, bridge, voice and authorization secrets including escaped values', async t => {
 const { log, file } = await fixture(t);
 const before = { ...process.env };
 const secrets = ['api-secret-1234', 'bridge-secret-1234', 'voice-secret-1234', 'auth-secret-1234', 'escaped-"secret-1234'];
 Object.assign(process.env, { TEST_API_KEY: secrets[0], ARENA_AGENT_BRIDGE_SECRET: secrets[1], ARENA_AGENT_VOICE_SECRET: secrets[2], TEST_AUTH_TOKEN: secrets[3], SECOND_API_KEY: secrets[4] });
 t.after(() => { for (const key of ['TEST_API_KEY','ARENA_AGENT_BRIDGE_SECRET','ARENA_AGENT_VOICE_SECRET','TEST_AUTH_TOKEN','SECOND_API_KEY']) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } });
 const turn = log.begin(record); const native = new NativeCallLog({ onEvent: turn.onEvent });
 const leaked = secrets.join('\n') + '\nAuthorization: Bearer unknown-auth-token';
 native.input('turn_input', leaked); native.reasoning(leaked); native.output(leaked);
 native.toolCall({ callId: 'c1', name: 'test', arguments: { apiKey: 'unknown-api-key', password: 'unknown-password', credentials: { nested: 'nested-credential-value' }, authorization: { token: 'nested-token-value' }, note: leaked } });
 native.toolResult('c1', JSON.stringify({ message: leaked })); turn.finish();
 log.actionResult(record.agentId, { actionId: 'a1', message: leaked });
 await log.close(); const source = await readFile(file, 'utf8');
 for (const secret of [...secrets, 'unknown-api-key', 'unknown-password', 'unknown-auth-token', 'nested-credential-value', 'nested-token-value']) assert.ok(!source.includes(secret), secret);
 for (const line of source.trim().split('\n')) JSON.parse(line);
 assert.ok(!JSON.stringify(log.latest(record.agentId, 3)).includes(secrets[0]));
});

test('rotation keeps two generations and offline reader combines call and late result', async t => {
 const { log, file, directory } = await fixture(t, { rotation: { maxFileBytes: 1800, retainedGenerations: 2 } });
 for (let i = 0; i < 12; i++) call(log);
 await log.close(); const names = await readdir(directory);
 assert.equal(names.length, 3); assert.ok(names.includes(path.basename(file) + '.2'));
 for (const name of names) { const source = await readFile(path.join(directory, name), 'utf8'); for (const line of source.trim().split('\n')) JSON.parse(line); }
});

test('switch disables all disk writes while live action and no-summary fallback remain available', async t => {
 const { log, directory } = await fixture(t, { enabled: false });
 call(log); await log.close(); assert.deepEqual(await readdir(directory), []);
 assert.match(log.latest(record.agentId, 3).action, /walk_to/);
 assert.equal(log.latest(record.agentId, 4), null);
 assert.equal(resolveDynamicCliRuntime({ ARENA_DECISION_LOG: '0' }).decisionLogEnabled, false);
 assert.equal(resolveDynamicCliRuntime({}).decisionLogEnabled, true);
});

test('legacy provider logs the actual prompt, null summary and structured action', async t => {
 const { log, file } = await fixture(t);
 log.record({ ...record, provider: 'gemini', input: 'system\n\nfull wake', output: JSON.stringify({ action: { type: 'wait', purpose: 'Wait for daylight' } }) });
 await log.close(); const row = JSON.parse((await readFile(file, 'utf8')).trim());
 assert.equal(row.reasoning, null); assert.equal(row.inputs[0].text, 'system\n\nfull wake');
 assert.equal(row.toolCalls[0].name, 'wait');
});

test('new sessions retain only four sessions and leave ordinary traces alone', async t => {
 const { directory, log } = await fixture(t);
 for (let i = 1; i <= 5; i++) await writeFile(path.join(directory, `decision-${i}-old--a-12345678.jsonl`), '{}\n');
 await writeFile(path.join(directory, 'coordinator.jsonl'), 'keep');
 const next = new DecisionLog({ directory, closeTimeoutMs: 30_000 }); call(next); await next.close(); await log.close();
 const names = await readdir(directory);
 assert.equal(names.filter(n => n.startsWith('decision-')).length, 4); assert.ok(names.includes('coordinator.jsonl'));
});

test('real Codex adapter and planner route summary items, exact wake, calls and late action results to disk', async t => {
 const { SharedCodexAgent } = await import('../src/codex-service.mjs');
 const { AgentPlanner } = await import('../src/agent-planner.mjs');
 const { FakeSharedTransport } = await import('./fixtures/codex-service-fixture.mjs');
 const { log, file } = await fixture(t);
 const transport = new FakeSharedTransport(); transport.autoComplete = false;
 const agent = new SharedCodexAgent(record, 'thread-1', transport, { controlProtocol: 'native_tools' });
 const registry = { assertCurrentRevision: () => record, setState() {}, get: () => record };
 const planner = new AgentPlanner({ registry, decisionLog: log,
  scheduler: { schedule: (_id, operation) => operation({ signal: new AbortController().signal }), cancel() { return false; } },
  codexService: { async createAgent() { return agent; }, getAgent() { return agent; }, async removeAgent() { return false; } },
 });
 const turn = planner.requestNativeTurn({ agentId: record.agentId, goalRevision: 3, input: 'wake: lean as sent',
  executeTool: async request => {
   assert.equal(request.callId, 'native-1');
   log.linkAction({ agentId: record.agentId, callId: request.callId, actionId: 'body-1' });
   // Receipt can arrive before the provider receives its tool response.
   log.actionResult(record.agentId, { actionId: 'body-1', state: 'SUCCEEDED' });
   return { state: 'SUCCEEDED', actionId: 'body-1' };
  },
 });
 for (let i = 0; i < 20 && !transport.calls.some(c => c.method === 'turn/start'); i++) await new Promise(r => setImmediate(r));
 const submitted = transport.calls.find(c => c.method === 'turn/start').params;
 assert.equal(submitted.effort, 'low'); assert.equal(submitted.serviceTier, 'default'); assert.equal(submitted.summary, 'detailed');
 transport.emit('notification', { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id:'r1', type:'reasoning', summary:[{text:'Reach the river for water.'}] } } });
 transport.emit('serverRequest', { id:71, method:'item/tool/call', params:{ threadId:'thread-1', turnId:'turn-1', callId:'native-1', tool:'say', arguments:{message:'Water next.'} } });
 await new Promise(r => setImmediate(r));
 transport.complete('thread-1', 'turn-1'); await turn; await log.close();
 const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
 const decision = rows.find(r => r.type === 'decision');
 assert.equal(decision.inputs[0].text, 'wake: lean as sent'); assert.equal(decision.reasoning, 'Reach the river for water.');
 assert.equal(decision.toolCalls[0].arguments.message, 'Water next.');
 assert.equal(rows.find(r => r.type === 'action_result').decisionId, decision.decisionId);
 assert.match(log.latest(record.agentId,3).reasoning, /river/);
});

test('Live task-view wire payload carries only the selected revision and bounded decision text', async t => {
 const { start, eventually } = await import('./fixtures/dynamic-main-fixture.mjs');
 const { validateProtocolV2Payload } = await import('../src/protocol-v2.mjs');
 const { log } = await fixture(t, { enabled:false });
 const run = await start({ decisionLog:log }); t.after(() => run.coordinator.stop());
 const current = run.registry.get('agent-a');
 const decision = log.begin({ ...current, serviceTier:'default' });
 decision.onEvent({type:'call',index:0,at:1});
 decision.onEvent({type:'text',index:0,kind:'reasoning',itemId:'r',text:'Need a bucket for water.',delta:false});
 decision.onEvent({type:'tool',index:0,name:'walk_to',callId:'c',arguments:{x:12,y:64,z:3,purpose:'Reach water'},at:2});
 decision.finish();
 run.bridge.emit('task_view_request',{agentId:current.agentId,payload:{goalRevision:current.goalRevision}});
 await eventually(() => run.bridge.sent.some(m => m.type === 'task_view'));
 const view = run.bridge.sent.find(m => m.type === 'task_view').payload;
 validateProtocolV2Payload('task_view',view);
 assert.equal(view.decision.reasoning,'Need a bucket for water.'); assert.match(view.decision.action,/"x":12/);
 assert.equal(view.decision.purpose,'Reach water');
 assert.throws(() => validateProtocolV2Payload('task_view',{...view,decision:{...view.decision,reasoning:'x'.repeat(321)}}));
});

test('late completed summaries replace streamed text without duplicates and authored intent supplies purpose', async t => {
 const { log, file } = await fixture(t);
 const turn = log.begin(record); const native = new NativeCallLog({ onEvent:turn.onEvent });
 native.input('turn_input','wake');
 native.reasoningDelta('r1','Need water'); native.reasoning('Need water for the portal.','r1');
 native.toolCall({callId:'intent',name:'task_plan',arguments:{operation:'intent',intent:{step:'water',why:'Fill the bucket to cast obsidian.'}}});
 native.toolResult('intent','{}'); native.output('next');
 native.toolCall({callId:'walk',name:'walk_to',arguments:{x:12,y:64,z:3}});
 assert.equal(log.latest(record.agentId,3).purpose,'Fill the bucket to cast obsidian.');
 turn.finish(); await log.close();
 const rows=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows.find(r=>r.type==='decision').reasoning,'Need water for the portal.');
});

test('oversized provider payloads stay bounded with explicit omission and valid correlation', async t => {
 const {log,file}=await fixture(t);
 call(log,{source:'x'.repeat(1_200_000)}); await log.close();
 const lines=(await readFile(file,'utf8')).trim().split('\n');
 for(const line of lines) assert.ok(Buffer.byteLength(line)<=1024*1024);
 const row=lines.map(JSON.parse).find(r=>r.type==='decision');assert.equal(row.truncated,true);assert.ok(row.decisionId);
});

test('decision capture continues across the legacy 1000-call in-memory history bound', async t => {
 const {log}=await fixture(t,{enabled:false});const turn=log.begin(record);const native=new NativeCallLog({onEvent:turn.onEvent});
 for(let i=0;i<1010;i++){native.input('turn_input',`wake ${i}`);native.output(`answer ${i}`);}
 native.toolCall({callId:'last',name:'walk_to',arguments:{x:1010}});turn.finish();
 assert.match(log.latest(record.agentId,3).action,/1010/);
});
