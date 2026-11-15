#!/usr/bin/env node
// Export only tracked, individually reviewed files. Never copy Git metadata or local build state.
import { readFile, mkdir, copyFile, writeFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || output === root || root.startsWith(output + path.sep)) throw Error('Supply a separate empty output directory');
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw Error('Output must be empty; choose a fresh folder');
const paths = (await readFile(path.join(root, 'scripts/export-public.allowlist'), 'utf8')).split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
for (const name of paths) {
 if (path.isAbsolute(name) || name.split('/').some(s => s === '..' || s === '.git')) throw Error('Unsafe allowlist entry: ' + name);
 const source = path.join(root, name);
 if (!(await lstat(source)).isFile()) throw Error('Only regular files allowed: ' + name);
 await mkdir(path.dirname(path.join(output, name)), { recursive: true });
 await copyFile(source, path.join(output, name));
}
// Only the exported package changes its default command; private npm test is untouched.
const packagePath = path.join(output, 'coordinator/package.json');
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
pkg.scripts.test = 'node scripts/run-public-suite.mjs';
await writeFile(packagePath, JSON.stringify(pkg, null, '\t') + '\n');
// The public history has no private benchmark baseline; its dependent test is in the omission manifest.
const workflowPath = path.join(output, '.github/workflows/reliability.yml');
const workflow = await readFile(workflowPath, 'utf8');
let historicalFetches = 0;
const publicWorkflow = workflow.replace(/^      - name: Fetch pinned successor benchmark baseline\n(?:        #.*\n)*        run: git fetch[^\n]*\n/gm, () => { historicalFetches++; return ''; });
if (historicalFetches !== 2) throw Error('Review the public workflow projection: expected two private baseline fetch steps');
await writeFile(workflowPath, publicWorkflow);
console.log('Exported ' + paths.length + ' files; no repository history copied.');
