#!/usr/bin/env node
// Used only by exported package.json; the private package keeps its full Node test command.
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = 'test/private-inputs.json';
const manifest = JSON.parse(await readFile(path.join(root, manifestPath), 'utf8'));
const skippedModules = new Set(manifest.tests.filter(e => e.test === '*').map(e => e.file));
const titles = manifest.tests.filter(e => e.test !== '*').map(e => e.test);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function walk(dir) {
 const entries = await readdir(path.join(root, dir), { withFileTypes: true });
 const nested = await Promise.all(entries.map(e => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.test\.mjs$/.test(e.name) ? [path.join(dir, e.name).split(path.sep).join('/')] : []));
 return nested.flat();
}
const discovered = (await walk('test')).sort();
for (const entry of manifest.tests) {
 if (!discovered.includes(entry.file) || !entry.inputs?.length || !entry.test) throw Error('Invalid private-input selection: ' + JSON.stringify(entry));
}
console.log(`${manifest.tests.length} tests need private fixtures and were not run (${manifestPath}).`);
console.log(`${skippedModules.size} selections omit modules that load private inputs before test discovery; the other ${titles.length} selections skip exact test titles.`);
const args = ['--test', '--test-reporter=tap', '--test-concurrency=4', '--test-timeout=900000'];
if (titles.length) args.push('--test-skip-pattern', '^(?:' + titles.map(escape).join('|') + ')$');
args.push(...process.argv.slice(2), ...discovered.filter(file => !skippedModules.has(file)));
const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
