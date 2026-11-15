import { randomUUID, createHash } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { BestEffortDiagnosticQueue } from './best-effort-diagnostic-queue.mjs';
import { sanitizeDiagnosticText, sanitizeDiagnosticValue, truncateDiagnosticUtf8 } from './diagnostic-sanitizer.mjs';
import { preparePrivateArtifact } from './private-artifact-permissions.mjs';
import { RotatingJsonlSink } from './rotating-jsonl-sink.mjs';

const MiB = 1024 * 1024;
const MAX_ROW_BYTES = MiB;
const MAX_TEXT_BYTES = 512 * 1024;
const clean = value => sanitizeDiagnosticValue(value, { maxDepth: 32, maxEntries: 4096, maxNodes: 65536, maxStringBytes: Number.MAX_SAFE_INTEGER, redactPaths: false, preserveWhitespace: true, redactPrompts: false });
const text = (value) => typeof value !== 'string' ? JSON.stringify(clean(value)) ?? '' : sanitizeDiagnosticText(value, {
 maxBytes: Number.MAX_SAFE_INTEGER, redactPaths: false, preserveWhitespace: true, redactPrompts: false,
});
const short = (value, maxBytes = 240) => sanitizeDiagnosticText(value, { maxBytes, redactPaths: false });
const parsed = (value) => { try { return JSON.parse(value); } catch { return value; } };
function actionText(name, args) {
 if (args === null || typeof args !== 'object') return short(`${name} ${args ?? ''}`, 400);
 const keys = [...new Set(['x','y','z','target','position','item','itemId','block','blockId','count','quantity','mode','dimension','durationTicks','purpose', ...Object.keys(args)])];
 const compact = Object.fromEntries(keys.filter(key => Object.hasOwn(args,key) && !['source','program','code'].includes(key)).slice(0, 10).map(key => [key, args[key]]));
 return short(`${name} ${JSON.stringify(compact)}`, 400);
}
const limitMap = (map, size) => { while (map.size > size) map.delete(map.keys().next().value); };

/** Local diagnostics. No writes are on the provider/action critical path. */
export class DecisionLog {
 #directory; #session; #enabled; #now; #rotation; #queue; #sinks = new Map(); #latest = new Map();
 #links = new Map(); #turns = new Set(); #sequence = 0; #ready; #closed = false;
 constructor({ directory, enabled = true, now = Date.now, sessionId = randomUUID(), rotation = {}, ...queueOptions } = {}) {
  this.#directory = directory; this.#enabled = enabled; this.#now = now; this.#rotation = rotation;
  this.#session = `${now()}-${sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64)}`;
  this.#ready = enabled ? this.#prune().catch(() => {}) : Promise.resolve();
  this.#queue = new BestEffortDiagnosticQueue({ ...queueOptions, ready: this.#ready, maxPending: 64, retainTimedOutOperation: true });
 }
 pathFor(agentId) {
  const safe = String(agentId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const hash = createHash('sha256').update(String(agentId)).digest('hex').slice(0, 8);
  return path.join(this.#directory, `decision-${this.#session}--${safe}-${hash}.jsonl`);
 }
 latest(agentId, goalRevision, runningAction = null) {
  const view = this.#latest.get(agentId);
  const current = view?.goalRevision === goalRevision ? { ...view } : null;
  if (!runningAction || !current) return current;
  return { ...current, action: actionText(runningAction.actionType, runningAction.arguments) };
 }
 #view(record, change) {
  const previous = this.latest(record.agentId, record.goalRevision) ?? { goalRevision: record.goalRevision, reasoning: null, action: '', purpose: '' };
  this.#latest.set(record.agentId, { ...previous, ...change }); limitMap(this.#latest, 16);
 }
 begin(record, { traceId = null } = {}) {
  const turnId = `${this.#session}:${++this.#sequence}`;
  const calls = new Map(); let inputs = []; let finished = false;
  this.#view(record, { reasoning: null, action: '' });
  const save = (call, type = 'decision') => {
   const { texts, saved, ...row } = call;
   row.reasoning = [...texts.values()].filter(e => e.kind === 'reasoning').map(e => e.text).join('\n') || null;
   row.assistant = [...texts.values()].filter(e => e.kind === 'output').map(e => e.text).join('\n');
   row.endedAt = this.#now();
   this.#write(record.agentId, { type, ...row }); call.saved = true;
  };
  const observe = (event) => {
   if (finished) return;
   if (event.type === 'input') {
    if (event.kind === 'tool_result') this.toolResult(record, event.callId, event.text, event.success);
    if (inputs.length < 64) inputs.push({ kind: event.kind, at: event.at, callId: event.callId ?? null, text: this.#bounded(event.text) });
    return;
   }
   if (event.type === 'call') {
    calls.set(event.index, { decisionId: `${turnId}:${event.index}`, time: inputs[0]?.at ?? event.at, agentId: record.agentId,
     provider: record.provider, model: record.model, effort: record.reasoningEffort, serviceTier: record.serviceTier,
     goalRevision: record.goalRevision, traceId, turnId, messageId: event.messageId ?? null,
     inputs, toolCalls: [], texts: new Map(), saved: false }); inputs = [];
    limitMap(calls, 4); return;
   }
   const call = calls.get(event.index); if (!call) return;
   if (event.type === 'call_end') { if (!call.saved) save(call); return; }
   if (event.type === 'text') {
    const key = `${event.kind}:${event.itemId ?? 'message'}`;
    if (!call.texts.has(key) && call.texts.size >= 64) return;
    const previous = call.texts.get(key)?.text ?? '';
    const value = this.#bounded(event.delta ? previous + event.text : event.text);
    if (previous === value) return;
    call.texts.set(key, { kind: event.kind, text: value });
    if (event.kind === 'reasoning') this.#view(record, { reasoning: short([...call.texts.values()].filter(e => e.kind === 'reasoning').map(e => e.text).join(' '), 320) || null });
   } else if (event.type === 'tool') {
    const args = clean(typeof event.arguments === 'string' ? parsed(event.arguments) : event.arguments);
    call.toolCalls.push({ callId: event.callId, name: event.name, arguments: args, at: event.at });
    this.#links.set(`${record.agentId}:call:${event.callId}`, { decisionId: call.decisionId, callId: event.callId }); limitMap(this.#links, 4096);
    this.#view(record, { action: actionText(event.name, args), purpose: short(args?.purpose ?? args?.intent?.why ?? args?.reason ?? this.latest(record.agentId, record.goalRevision)?.purpose ?? '') });
   }
   // Late authoritative item text replaces a streamed fallback after a tool-result boundary.
   if (call.saved && !event.delta) save(call, 'decision_update');
   else if (event.type === 'tool') save(call);
  };
  const finish = () => {
   if (finished) return;
   for (const call of calls.values()) if (!call.saved) save(call);
   finished = true; this.#turns.delete(finish);
  };
  this.#turns.add(finish);
  return { onEvent: observe, finish };
 }
 #bounded(value) {
  const safe = text(value);
  return Buffer.byteLength(safe) > MAX_TEXT_BYTES ? `${truncateDiagnosticUtf8(safe, MAX_TEXT_BYTES)}...[truncated]` : safe;
 }
 toolResult(record, callId, content, success) {
  const link = this.#links.get(`${record.agentId}:call:${callId}`) ?? { decisionId: null, callId };
  const result = clean(parsed(content));
  // Native tool responses can wrap a receipt in a result or action object.
  const actionId = result?.actionId ?? result?.action?.actionId ?? result?.result?.actionId ?? null;
  if (actionId) { this.#links.set(`${record.agentId}:action:${actionId}`, link); limitMap(this.#links, 4096); }
  this.#write(record.agentId, { type: 'tool_result', time: this.#now(), agentId: record.agentId, ...link, actionId, success, result });
 }
 linkAction({ agentId, callId, actionId }) {
  const link = this.#links.get(`${agentId}:call:${callId}`) ?? { decisionId: null, callId };
  this.#links.set(`${agentId}:action:${actionId}`, link); limitMap(this.#links, 4096);
  this.#write(agentId, { type: 'action_link', time: this.#now(), agentId, ...link, actionId });
 }
 actionResult(agentId, result) {
  const actionId = result?.actionId ?? null;
  const link = this.#links.get(`${agentId}:action:${actionId}`) ?? { decisionId: null, callId: null };
  this.#write(agentId, { type: 'action_result', time: this.#now(), agentId, ...link, actionId, result });
 }
 /** ArenaScript providers return a single structured decision rather than native tool items. */
 record(fields) {
  if (fields.capture || fields.agentId == null) return;
  const turn = this.begin({ ...fields, serviceTier: fields.serviceTier ?? fields.executionSettings?.requested?.serviceTier, reasoningEffort: fields.reasoningEffort }, { traceId: fields.traceId });
  turn.onEvent({ type: 'input', kind: 'turn_input', text: fields.input, at: this.#now() });
  turn.onEvent({ type: 'call', index: 0, at: this.#now() });
  if (fields.reasoning) turn.onEvent({ type: 'text', index: 0, kind: 'reasoning', itemId: 'summary', text: fields.reasoning, delta: false });
  turn.onEvent({ type: 'text', index: 0, kind: 'output', text: fields.output, delta: false });
  const decision = parsed(fields.output);
  if (decision?.action) turn.onEvent({ type: 'tool', index: 0, name: decision.action.type ?? decision.action.kind ?? 'action', arguments: decision.action, callId: null, at: this.#now() });
  turn.finish();
 }
 #write(agentId, row) {
  if (!this.#enabled || this.#closed) return;
  let encoded = JSON.stringify(clean(row));
  if (Buffer.byteLength(encoded) > MAX_ROW_BYTES) {
   // Explicit omission preserves valid JSON and correlation even for a pathological provider payload.
   encoded = JSON.stringify({ type: row.type, time: row.time, agentId, decisionId: row.decisionId, callId: row.callId,
    actionId: row.actionId, truncated: true, content: truncateDiagnosticUtf8(encoded, MAX_ROW_BYTES / 2) });
  }
  this.#queue.submit(async () => {
   let sink = this.#sinks.get(agentId);
   if (!sink) {
    if (this.#sinks.size >= 16) throw new Error('Decision agent limit reached');
    const file = this.pathFor(agentId); await preparePrivateArtifact(file);
    sink = new RotatingJsonlSink(file, { maxFileBytes: 4 * MiB, retainedGenerations: 2, ...this.#rotation }); this.#sinks.set(agentId, sink);
   }
   await sink.append(`${encoded}\n`, { encoding: 'utf8', mode: 0o600 });
  });
 }
 async #prune() {
  let names; try { names = await readdir(this.#directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const files = names.filter(n => /^decision-\d+-[a-zA-Z0-9-]+--[a-zA-Z0-9_-]+\.jsonl(?:\.[12])?$/.test(n));
  const sessions = [...new Set(files.map(n => n.slice(9, n.indexOf('--'))))].sort((a,b) => Number(b.split('-')[0]) - Number(a.split('-')[0]));
  const keep = new Set([this.#session, ...sessions.filter(s => s !== this.#session).slice(0, 3)]);
  for (const name of files) if (!keep.has(name.slice(9, name.indexOf('--')))) {
   const file = path.join(this.#directory, name);
   // Only old session artifacts owned by this feature; never gameplay traces.
   if ((await stat(file)).isFile()) await unlink(file);
  }
 }
 statusSnapshot() { return this.#queue.statusSnapshot('decision_log'); }
 async close() { for (const finish of this.#turns) finish(); this.#closed = true; await this.#queue.close(); }
}
