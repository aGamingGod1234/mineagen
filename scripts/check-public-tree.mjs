#!/usr/bin/env node
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const exemptions = JSON.parse(await readFile(new URL('./public-tree-exemptions.json', import.meta.url), 'utf8'));
let exempted = 0;
function finding(file, lineNumber, rule, line, review = false) {
 const hash = line === null ? null : createHash('sha256').update(line).digest('hex');
 const allowed = exemptions.find(e => e.file === file && e.rule === rule && (line === null ? e.sha256 === undefined : e.sha256 === hash));
 if (allowed) {
  console.log(file + ':' + lineNumber + ': EXEMPT ' + rule + ' (' + allowed.reason + ')');
  exempted++; return;
 }
 console.log(file + ':' + lineNumber + ': ' + (review ? 'REVIEW ' : 'FAIL ') + rule);
 if (review) reviews++; else failures++;
}
const root = path.resolve(process.argv[2] ?? '.');
let files = 0, failures = 0, reviews = 0;
const personal = ['agaming' + 'god', 'User', 'aGaming' + 'God'];
const hosts = ['mini' + 'pc', 'desktop' + '-lan', 'SAN' + 'PEDRO', 'lucas' + 'toh'];
const rules = [
 ['personal path', new RegExp('/home/' + personal[0] + '|C:[\\\\/]+Users[\\\\/]+(?:' + personal.join('|') + ')', 'i')],
 ['private host', new RegExp(hosts.join('|'), 'i')],
 ['private network', /\b(?:100|192\.168)\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b|[\w.-]+\.ts\.net\b|\btailscale\b/i],
 ['private link', new RegExp('postplan' + '\\.dev|claude' + '\\.ai/artifact', 'i')],
 ['recorded usage', /"(?:costUsd|totalCostUsd|inputTokens|outputTokens|cachedInputTokens|cacheWriteInputTokens|contextTokens)"\s*:\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)/i],
];
async function walk(dir) {
 for (const entry of await readdir(dir, { withFileTypes: true })) {
  const file = path.join(dir, entry.name), rel = path.relative(root, file).split(path.sep).join('/');
  if (entry.isSymbolicLink()) { console.log(rel + ':1: FAIL symlink'); failures++; continue; }
  if (entry.isDirectory()) { await walk(file); continue; }
  files++;
  const stat = await lstat(file);
  for (const reason of [stat.size > 2_000_000 ? 'file exceeds 2 MB' : '', /^libs\/.*\.jar$/i.test(rel) ? 'library binary' : ''].filter(Boolean)) { finding(rel, 1, reason, null); }
  const data = await readFile(file);
  // Latin-1 also exposes ASCII identifiers in binary assets.
  const lines = data.toString(data.includes(0) ? 'latin1' : 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
   for (const [reason, pattern] of rules) if (pattern.test(line)) { finding(rel, i+1, reason, line); }
   const emails = line.replace(/:\/\/[^/\s@]+:[^/\s@]+@/g, '://').match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
   if (emails.some(e => !/@(?:example\.(?:com|org|net|invalid|test)|localhost\.localdomain|test\.invalid)$/i.test(e))) { finding(rel, i+1, 'email', line); }
   // Review all capitalized device words; context may be ordinary UI/platform terminology.
   if (/\b(?:Mini PC|Laptop|Desktop)\b/.test(line)) { finding(rel, i+1, 'device-word context', line, true); }
   if (rel !== 'LICENSE' && new RegExp('\\bluc' + 'as\\b', 'i').test(line)) { finding(rel, i+1, 'personal name', line, true); }
  });
 }
}
await walk(root);
console.log('Applied ' + exempted + ' exact exemptions.');
console.log('Scanned ' + files + ' files: ' + failures + ' failures, ' + reviews + ' review findings.');
process.exitCode = failures || reviews ? 1 : 0;
