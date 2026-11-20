#!/usr/bin/env node
// Export only committed, individually reviewed files. Never copy Git metadata, local build state or uncommitted edits.
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || output === root || root.startsWith(output + path.sep)) throw Error('Supply a separate empty output directory');
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw Error('Output must be empty; choose a fresh folder');
// Line-ending settings on this machine must not change the published bytes.
const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '--literal-pathspecs', ...args], { cwd: root, maxBuffer: 2 ** 30 });
const committed = new Map(git('ls-tree', '-r', '-z', 'HEAD').toString().split('\0').filter(Boolean).map(row => [row.slice(row.indexOf('\t') + 1), row.slice(0, 6)]));
// The allowlist is read from the same commit as the files it names.
const paths = git('show', 'HEAD:scripts/export-public.allowlist').toString().split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
for (const name of paths) {
 if (path.isAbsolute(name) || name.split('/').some(s => s === '..' || s === '.git')) throw Error('Unsafe allowlist entry: ' + name);
 if (!['100644', '100755'].includes(committed.get(name))) throw Error('Only committed regular files allowed: ' + name);
}
// The files come from the HEAD commit, not the working tree, so an uncommitted edit can never be published.
// Batches keep each command line under the Windows length limit.
for (let at = 0; at < paths.length; at += 200) execFileSync('tar', ['-x', '-C', output], { input: git('archive', '--format=tar', 'HEAD', '--', ...paths.slice(at, at + 200)) });
// The private repository picks its own runners. In the public copy a Linux job runs on Boat, the rented VM runner,
// when the run comes from the repository itself, and on GitHub's runner for a pull request from a fork: Boat takes
// only the owner's runs, so a fork's job that asked for it would wait for ever. The gate accepts exactly this text.
const forkAwareRunner = "    runs-on: ${{ (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && 'boat' || 'ubuntu-latest' }}\n";
// The public repository's own tree is already projected: its coordinator job names the fork-aware runner and it has no
// private steps, comments, runner lines or markers left. Exporting from it expects none of them; exporting from the
// private tree still expects every one.
const alreadyPublic = (await readFile(path.join(output, '.github/workflows/coordinator.yml'), 'utf8')).includes(forkAwareRunner);
// Both trees share the availability-aware runner; no package projection is needed.
// The public history has no private benchmark baseline; its dependent test is in the omission manifest.
const workflows = ['.github/workflows/coordinator.yml', '.github/workflows/reliability.yml'];
for (const name of workflows) {
 const workflowPath = path.join(output, name);
 const workflow = await readFile(workflowPath, 'utf8');
 let historicalFetches = 0;
 const publicWorkflow = workflow.replace(/^      - name: Fetch pinned successor benchmark baseline\n(?:        (?:#|if:).*\n)*        run: git fetch[^\n]*\n/gm, () => { historicalFetches++; return ''; });
 if (historicalFetches !== (alreadyPublic ? 0 : 1)) throw Error('Review the public workflow projection: expected one private baseline fetch step in ' + name);
 await writeFile(workflowPath, publicWorkflow);
}
// Workflow comments tagged as private (a hash, a space, then "Private" and a colon, with "#   " continuation lines)
// describe the private runners only. The tag is assembled here so this file does not carry it.
for (const [name, privateExpected] of [['.github/workflows/coordinator.yml', 2], ['.github/workflows/reliability.yml', 2]]) {
 const expected = alreadyPublic ? 0 : privateExpected;
 const file = path.join(output, name);
 let privateComments = 0;
 const publicWorkflow = (await readFile(file, 'utf8')).replace(new RegExp('^ *# ' + 'Private:.*\\n(?: *#   .*\\n)*', 'gm'), () => { privateComments++; return ''; });
 if (privateComments !== expected) throw Error('Review the private comments in ' + name + ': expected ' + expected + ', found ' + privateComments);
 await writeFile(file, publicWorkflow);
}
const coordinatorPath = path.join(output, '.github/workflows/coordinator.yml');
let privateRunnerLines = 0;
const publicCoordinator = (await readFile(coordinatorPath, 'utf8'))
 .replace(/^    runs-on: \$\{\{ github\.event\.repository\.private && [^\n]*\n/m, () => { privateRunnerLines++; return forkAwareRunner; });
if (privateRunnerLines !== (alreadyPublic ? 0 : 1) || /self-hosted|COORDINATOR_RUNS_ON/.test(publicCoordinator)) throw Error('Review the public workflow projection: the coordinator job must name only the fork-aware runner');
await writeFile(coordinatorPath, publicCoordinator);
// The mod builds run on Boat in the private repository; the public copy sends a fork's pull request to GitHub's runner.
const reliabilityPath = path.join(output, '.github/workflows/reliability.yml');
let rentedRunners = 0;
const publicReliability = (await readFile(reliabilityPath, 'utf8')).replace(/^    runs-on: boat\n/gm, () => { rentedRunners++; return forkAwareRunner; });
if (rentedRunners !== (alreadyPublic ? 0 : 1)) throw Error('Review the public workflow projection: expected one rented-runner job in reliability.yml');
await writeFile(reliabilityPath, publicReliability);
// Text between the private markers names files and routines that stay private; the public copy drops it.
const open = '<!-- ' + 'private -->', close = '<!-- /' + 'private -->';
const marked = { 'AGENTS.md': 5, 'docs/gameplay-friction/README.md': 1, 'scripts/decision-eval/README.md': 2, 'scripts/quality/README.md': 1 };
for (const name of paths.filter(name => name.endsWith('.md'))) {
 const file = path.join(output, name);
 const text = await readFile(file, 'utf8');
 if (!text.includes(open) && !(name in marked)) continue;
 let blocks = 0;
 const publicText = text.split(open).map((part, index) => {
  if (index === 0) return part;
  const end = part.indexOf(close);
  if (end < 0) throw Error('Unclosed private marker in ' + name);
  blocks++; return part.slice(end + close.length);
 }).join('').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
 const expected = alreadyPublic ? 0 : marked[name] ?? 0;
 if (blocks !== expected || publicText.includes(close)) throw Error('Review the private markers in ' + name + ': expected ' + expected + ' blocks, found ' + blocks);
 await writeFile(file, publicText);
}
console.log('Exported ' + paths.length + ' files; no repository history copied.');
