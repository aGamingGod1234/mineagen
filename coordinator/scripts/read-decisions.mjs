#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sanitizeDiagnosticText } from '../src/diagnostic-sanitizer.mjs';

export function timeline(rows) {
 const calls = new Map(), links = new Map(), results = new Map();
 for (const row of rows) {
  if (row.type === 'decision' || row.type === 'decision_update') calls.set(row.decisionId, row);
  if (['tool_result', 'action_link'].includes(row.type) && row.actionId && row.callId) links.set(row.actionId, row.callId);
 }
 for (const row of rows) if (['tool_result', 'action_result'].includes(row.type)) {
  const id = row.callId ?? links.get(row.actionId) ?? row.actionId;
  const list = results.get(id) ?? []; list.push(row.result); results.set(id, list);
 }
 const safe = value => sanitizeDiagnosticText(value, { maxBytes: 1024 * 1024, redactPaths: false, redactPrompts: false });
 return [...calls.values()].sort((a,b) => a.time - b.time).map(row => {
  const lines = [`${new Date(row.time).toISOString()} ${row.agentId} ${row.provider}/${row.model} ${row.effort ?? ''}`];
  if (row.truncated) lines.push('  [oversized record omitted; see raw JSONL]');
  if (row.reasoning) lines.push(`  Thinking: ${safe(row.reasoning)}`);
  for (const tool of row.toolCalls ?? []) {
   lines.push(`  ${safe(tool.name)} ${safe(JSON.stringify(tool.arguments))} [${tool.callId ?? 'no callId'}]`);
   for (const result of results.get(tool.callId) ?? []) lines.push(`    Result: ${safe(JSON.stringify(result))}`);
  }
  if (row.assistant) lines.push(`  Assistant: ${safe(row.assistant)}`);
  return lines.join('\n');
 }).join('\n\n');
}

async function main() {
 const args = process.argv.slice(2);
 if (!args.length) { process.stderr.write('Usage: node coordinator/scripts/read-decisions.mjs <decision-...jsonl> [other files]\nRotations .2 and .1 are included automatically.\n'); process.exitCode = 2; return; }
 const files = new Set();
 for (const file of args) for (const candidate of file.endsWith('.jsonl') ? [`${file}.2`, `${file}.1`, file] : [file]) files.add(candidate);
 const rows = []; let malformed = 0;
 for (const file of files) {
  let source; try { source = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT' && /\.jsonl\.[12]$/.test(file)) continue; throw error; }
  for (const line of source.split('\n').filter(Boolean)) { try { rows.push(JSON.parse(line)); } catch { malformed++; } }
 }
 process.stdout.write(`${timeline(rows)}\n`);
 if (malformed) process.stderr.write(`Skipped ${malformed} incomplete JSONL row(s).\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error.code ?? 'READER_ERROR'}\n`); process.exitCode = 1; });
