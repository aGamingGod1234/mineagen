#!/usr/bin/env node
// Both trees use the same private-input selections; an archive enables every selection it can supply.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = 'test/private-inputs.json';
const manifest = JSON.parse(await readFile(path.join(root, manifestPath), 'utf8'));
const archive = process.env.ARENA_PRIVATE_INPUTS;
if (archive && !existsSync(archive)) throw Error('ARENA_PRIVATE_INPUTS archive root does not exist: ' + archive);
const available = input => {
 const gitObject = input.match(/^Private Git object ([a-f0-9]{40})\b/);
 if (gitObject) return spawnSync('git', ['cat-file', '-e', gitObject[1]], { cwd: root, stdio: 'ignore' }).status === 0;
 return existsSync(path.resolve(root, '..', input));
};
// The archive holds recordings only. A selection marked source checkout reads files or Git history that only the
// private checkout has, so it stays omitted wherever those are absent, archive or not.
const omitted = manifest.tests.filter(entry => (!archive || entry.source === 'checkout') && entry.inputs.some(input => !available(input)));
const skippedModules = new Set(omitted.filter(e => e.test === '*').map(e => e.file));
const titles = omitted.filter(e => e.test !== '*').map(e => e.test);
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
console.log(`${omitted.length} tests need private fixtures and were not run (${manifestPath}).`);
for (const entry of omitted) console.log(`SKIP ${entry.file}: ${entry.test}: private input unavailable; set ARENA_PRIVATE_INPUTS to the archive root. Missing: ${entry.inputs.filter(input => !available(input)).join(', ')}`);
const args = ['--test', '--test-reporter=tap', '--test-concurrency=4', '--test-timeout=900000'];
if (titles.length) args.push('--test-skip-pattern', '^(?:' + titles.map(escape).join('|') + ')$');
const requested = process.argv.slice(2);
const files = requested.filter(arg => arg.endsWith('.test.mjs'));
const selected = (files.length ? files : discovered).filter(file => !skippedModules.has(file));
if (!selected.length) process.exit(0);
args.push(...requested.filter(arg => !files.includes(arg)), ...selected);
// A session's model override (coordinator/src/default-models.mjs) must not change the defaults tests pin.
const env = { ...process.env };
delete env.ARENA_CODEX_MODEL;
delete env.ARENA_CLAUDE_MODEL;
const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
