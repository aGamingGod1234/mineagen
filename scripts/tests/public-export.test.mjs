import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const gate = path.join(root, 'scripts/check-public-tree.mjs');
const forkAware = "${{ (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && 'boat' || 'ubuntu-latest' }}";
test('publication gate reports file and line for private evidence and rejects oversize files', async () => {
 const dir = await mkdtemp(path.join(root, '.public-gate-test-'));
 try {
  const cases = [
   '/home/' + 'agaming' + 'god/private',
   'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'User/private',
   'mini' + 'pc', 'desktop' + '-lan', 'SAN' + 'PEDRO', 'lucas' + 'toh',
   '100.' + '64.1.2', '192.' + '168.1.2', 'node.tail123' + '.ts.net',
   'private' + '@' + 'personal.org', 'postplan' + '.dev/p/test', 'claude' + '.ai/artifact/secret',
   '{"cost' + 'Usd":0.012}', '{"input' + 'Tokens":123}',
   'Mini' + ' PC', 'Lap' + 'top', 'Desk' + 'top', 'Luc' + 'as',
   'sk-' + 'proj-' + 'a'.repeat(40), 'sk-' + 'ant-' + 'b'.repeat(40), 'gh' + 'p_' + 'c'.repeat(36), 'github' + '_pat_' + 'd'.repeat(30),
   'AK' + 'IA' + 'E'.repeat(16), 'AI' + 'za' + 'f'.repeat(35), 'xox' + 'b-' + '1'.repeat(12), '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
  ];
  for (const value of cases) {
   await writeFile(path.join(dir, 'probe.txt'), 'first line\n' + value);
   const result = spawnSync(process.execPath, [gate, dir], { encoding: 'utf8' });
   assert.equal(result.status, 1, value);
   assert.match(result.stdout, /probe.txt:2: (?:FAIL|REVIEW)/);
  }
  await writeFile(path.join(dir, 'probe.txt'), 'placeholder@example.invalid\n');
  assert.match(execFileSync(process.execPath, [gate, dir], { encoding: 'utf8' }), /0 failures, 0 review/);
  await writeFile(path.join(dir, 'probe.txt'), 'kept <!-- ' + 'private -->dropped<!-- /' + 'private -->\n');
  assert.match(spawnSync(process.execPath, [gate, dir], { encoding: 'utf8' }).stdout, /probe.txt:1: FAIL private marker/);
  await writeFile(path.join(dir, 'probe.txt'), 'plain\n');
  await mkdir(path.join(dir, '.github/workflows'), { recursive: true });
  // A public workflow job names one of three labels or, exactly, the expression that sends a fork's pull request to
  // GitHub's runner. Every near miss of that expression fails.
  const fork = forkAware.slice(0, -' }}'.length);
  for (const [runner, status] of [
   ['ubuntu-latest', 0], ['windows-latest', 0], ['boat', 0], [forkAware, 0],
   ['windows-2025', 1], ['ubuntu-24.04', 1], ['ubuntu-private', 1], ['[self-hosted, lab]', 1], ['[boat]', 1], ['self-hosted', 1],
   ['${{ vars.RUNNER }}', 1], ['${{ matrix.os }}', 1], ['\n      - ubuntu-latest', 1], ['boat # rented', 1],
   [forkAware.replace('==', '!='), 1], [forkAware.replace("'ubuntu-latest'", "'self-hosted'"), 1],
   [forkAware.replace("'boat'", "vars.RUNNER"), 1], [fork + " || vars.RUNNER }}", 1], [forkAware.replace('&& ', '&&  '), 1],
   ["${{ github.event.repository.private && 'boat' || 'ubuntu-latest' }}", 1],
  ]) {
   await writeFile(path.join(dir, '.github/workflows/ci.yml'), 'jobs:\n  a:\n    runs-on: ' + runner + '\n');
   assert.equal(spawnSync(process.execPath, [gate, dir]).status, status, runner);
  }
  for (const [workflow, status] of [['jobs: {a: {runs-on: self-hosted, steps: [{run: echo probe}]}}', 1], ['jobs: {a: {runs-on: ubuntu-latest}}', 1], ['jobs:\n  a:\n    "runs-on": ubuntu-latest', 1], ['jobs:\n  a:\n    # runs-on: self-hosted was the old runner\n    runs-on: ubuntu-latest', 0]]) {
   await writeFile(path.join(dir, '.github/workflows/ci.yml'), workflow + '\n');
   assert.equal(spawnSync(process.execPath, [gate, dir]).status, status, workflow);
  }
  await rm(path.join(dir, '.github'), { recursive: true });
  await mkdir(path.join(dir, 'libs'));
  await writeFile(path.join(dir, 'libs/a.jar'), '');
  assert.equal(spawnSync(process.execPath, [gate, dir]).status, 1);
  await rm(path.join(dir, 'libs/a.jar'));
  await writeFile(path.join(dir, 'probe.txt'), Buffer.alloc(2_000_001));
  assert.equal(spawnSync(process.execPath, [gate, dir]).status, 1);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
test('release workflow runs only in the public repository, on a GitHub-hosted or Boat runner, and passes the publication gate', async () => {
 const workflow = await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8');
 assert.match(workflow, /^permissions:\n  contents: read\n/m);
 const start = workflow.search(/^jobs:\n/m);
 assert.ok(start >= 0, 'release.yml has a jobs block');
 const jobs = workflow.slice(start + 'jobs:\n'.length).split(/^(?=  [\w-]+:\n)/m).filter(block => /^  [\w-]+:\n/.test(block));
 assert.ok(jobs.length >= 4, 'tag check, JAR builds, release and Windows package');
 for (const job of jobs) {
  const name = job.slice(0, job.indexOf(':')).trim();
  // The private repository must never build or publish a release.
  assert.match(job, /^    if: github\.repository == 'aGamingGod1234\/mineagen'(?: &&[^\n]*)?$/m, name + ' is guarded to the public repository');
  // Tag pushes and manual runs only ever come from the repository itself, so a Linux job may also run on Boat.
  assert.match(job, /^    runs-on: (?:ubuntu-latest|boat|windows-latest)$/m, name + ' names a GitHub-hosted or Boat runner');
  assert.match(job, /^    timeout-minutes: \d+$/m, name + ' has a timeout');
  // A job that holds the write token runs no checkout or build code.
  if (/contents: write/.test(job)) assert.doesNotMatch(job, /actions\/checkout|gradlew|fetch-libs|npm ci/, name + ' writes the release, so it must not build');
 }
 for (const [, action] of workflow.matchAll(/^\s*(?:- )?uses: ([^\s@]+)@/gm)) assert.match(action, /^actions\//, 'GitHub-owned actions only: ' + action);
 const dir = await mkdtemp(path.join(root, '.public-gate-test-'));
 try {
  await mkdir(path.join(dir, '.github/workflows'), { recursive: true });
  await writeFile(path.join(dir, '.github/workflows/release.yml'), workflow);
  const result = spawnSync(process.execPath, [gate, dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
// Private-looking values are assembled at run time so this file stays clean.
const homePath = '/home/' + 'agaming' + 'god/notes.txt';
const hostName = 'mini' + 'pc';
const trailer = 'Co-Authored-By: Claude Opus 5.5 <noreply' + '@anthropic.com>';
const run = (args, options = {}) => spawnSync(process.execPath, [gate, ...args], { encoding: 'utf8', ...options });
test('tree scan skips the top-level .git folder or file of a plain checkout', async () => {
 const dir = await mkdtemp(path.join(root, '.public-gate-test-'));
 try {
  await writeFile(path.join(dir, 'clean.txt'), 'plain\n');
  await mkdir(path.join(dir, '.git'));
  await writeFile(path.join(dir, '.git/config'), homePath + '\n');
  assert.equal(run([dir]).status, 0);
  await rm(path.join(dir, '.git'), { recursive: true });
  // A worktree's .git is a file that holds an absolute path.
  await writeFile(path.join(dir, '.git'), 'gitdir: ' + homePath + '\n');
  assert.equal(run([dir]).status, 0);
  // Only the top level is Git metadata; a nested .git is scanned like any other file.
  await mkdir(path.join(dir, 'sub'));
  await writeFile(path.join(dir, 'sub/.git'), homePath + '\n');
  assert.match(run([dir]).stdout, /sub\/\.git:1: FAIL personal path/);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
test('text mode scans files and standard input with the gate rules and no exemptions', async () => {
 const dir = await mkdtemp(path.join(root, '.public-gate-test-'));
 try {
  await writeFile(path.join(dir, 'pull-request-title'), 'Add a clean feature\n');
  await writeFile(path.join(dir, 'commit-abc'), 'Fix a bug\n\nSeen on ' + hostName + ' first\n');
  const result = run(['--text', path.join(dir, 'pull-request-title'), path.join(dir, 'commit-abc')]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^commit-abc:3: FAIL private host$/m);
  assert.match(result.stdout, /Scanned 2 texts: 1 failures, 0 review findings/);
  // Review findings fail too, and the no-reply addresses of commit trailers pass.
  for (const [text, status] of [['Tested on the Lap' + 'top', 1], ['Thanks Luc' + 'as', 1], ['Fix it\n\n' + trailer, 0],
   ['Co-authored-by: Someone <123+someone@' + 'users.noreply.github.com>', 0], ['mail me at someone@' + 'gmail.com', 1],
   ['runs-on: self-hosted is fine in prose', 0], ['', 0]]) {
   const piped = run(['--text', '-'], { input: text });
   assert.equal(piped.status, status, text + '\n' + piped.stdout);
  }
  assert.match(run(['--text', '-'], { input: 'line one\n' + homePath }).stdout, /^message:2: FAIL personal path$/m);
  // A file named like an exempted tree file gets no exemption in text mode.
  await mkdir(path.join(dir, 'scripts'));
  const exemptLine = (await readFile(gate, 'utf8')).split('\n').find(line => line.startsWith('const hosts = '));
  await writeFile(path.join(dir, 'scripts/check-public-tree.mjs'), exemptLine + '\n');
  assert.match(run(['--text', path.join(dir, 'scripts/check-public-tree.mjs')]).stdout, /check-public-tree\.mjs:1: REVIEW personal name/);
  assert.equal(run(['--text', path.join(dir, 'missing')]).status, 2);
  assert.equal(run(['--text']).status, 2);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
async function scratchRepo() {
 const dir = await mkdtemp(path.join(root, '.public-gate-test-'));
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', ...args], { cwd: dir, encoding: 'utf8' });
 git('init', '-q');
 // Commit signing or global hooks on this machine must not change the result.
 git('config', 'commit.gpgsign', 'false');
 git('config', 'core.hooksPath', '.no-hooks');
 return { dir, git };
}
test('staged mode scans the staged content of staged files, not the working tree', async () => {
 const { dir, git } = await scratchRepo();
 const staged = () => run(['--staged'], { cwd: dir });
 try {
  await writeFile(path.join(dir, 'notes.txt'), 'clean\n');
  git('add', 'notes.txt');
  // Nothing staged before the first commit is clean; a dirty working copy that is not staged does not count.
  await writeFile(path.join(dir, 'notes.txt'), 'clean\n' + homePath + '\n');
  assert.equal(staged().status, 0, staged().stdout);
  git('add', 'notes.txt');
  await writeFile(path.join(dir, 'notes.txt'), 'clean\n');
  const dirty = staged();
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /^notes\.txt:2: FAIL personal path$/m);
  assert.match(dirty.stdout, /Scanned 1 files: 1 failures, 0 review findings/);
  git('add', 'notes.txt');
  git('commit', '-q', '-m', 'first');
  // Deleted files are not scanned; a staged workflow gets the runner rule; a staged link fails.
  git('rm', '-q', 'notes.txt');
  assert.equal(staged().status, 0);
  await mkdir(path.join(dir, '.github/workflows'), { recursive: true });
  await writeFile(path.join(dir, '.github/workflows/ci.yml'), 'jobs:\n  a:\n    runs-on: self-hosted\n');
  git('add', '.github/workflows/ci.yml');
  assert.match(staged().stdout, /ci\.yml:3: FAIL runner not GitHub-hosted/);
  git('rm', '-q', '--cached', '.github/workflows/ci.yml');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'target', encoding: 'utf8' }).trim();
  git('update-index', '--add', '--cacheinfo', '120000,' + blob + ',link');
  assert.match(staged().stdout, /^link:1: FAIL symlink$/m);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
test('hooks are executable and block a private path or host before the commit is made', async () => {
 for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
  assert.match(execFileSync('git', ['ls-files', '-s', 'scripts/hooks/' + hook], { cwd: root, encoding: 'utf8' }), /^100755 /, hook + ' is committed executable');
 }
 const { dir, git } = await scratchRepo();
 try {
  await mkdir(path.join(dir, 'scripts/hooks'), { recursive: true });
  for (const file of ['check-public-tree.mjs', 'public-tree-exemptions.json', 'hooks/pre-commit', 'hooks/commit-msg']) {
   await writeFile(path.join(dir, 'scripts', file), await readFile(path.join(root, 'scripts', file)), { mode: 0o755 });
  }
  git('add', 'scripts');
  git('commit', '-q', '-m', 'Add the gate');
  git('config', 'core.hooksPath', 'scripts/hooks');
  const commit = (...args) => spawnSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', 'commit', '-q', ...args], { cwd: dir, encoding: 'utf8' });
  // A personal author or committer email is stopped before the commit carries it.
  await writeFile(path.join(dir, 'notes.txt'), 'line\n');
  git('add', 'notes.txt');
  const personalEmail = 'private' + '@' + 'personal.org';
  const blockedAuthor = spawnSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=' + personalEmail, 'commit', '-q', '-m', 'Add notes'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(blockedAuthor.status, 0);
  assert.match(blockedAuthor.stdout + blockedAuthor.stderr, /identity:1: FAIL email/);
  const blockedCommitter = spawnSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', 'commit', '-q', '-m', 'Add notes'],
   { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_EMAIL: personalEmail } });
  assert.notEqual(blockedCommitter.status, 0);
  assert.match(blockedCommitter.stdout + blockedCommitter.stderr, /identity:2: FAIL email/);
  await writeFile(path.join(dir, 'notes.txt'), 'line\n' + homePath + '\n');
  git('add', 'notes.txt');
  const blockedFile = commit('-m', 'Add notes');
  assert.notEqual(blockedFile.status, 0);
  assert.match(blockedFile.stdout + blockedFile.stderr, /notes\.txt:2: FAIL personal path/);
  await writeFile(path.join(dir, 'notes.txt'), 'line\n');
  git('add', 'notes.txt');
  const blockedMessage = commit('-m', 'Add notes', '-m', 'Checked on ' + hostName);
  assert.notEqual(blockedMessage.status, 0);
  assert.match(blockedMessage.stdout + blockedMessage.stderr, /message:3: FAIL private host/);
  // Git keeps lines starting with # in a message given with -m or -F, so they are scanned.
  const blockedComment = commit('-m', 'Add notes', '-m', '# ' + hostName);
  assert.notEqual(blockedComment.status, 0);
  assert.match(blockedComment.stdout + blockedComment.stderr, /message:3: FAIL private host/);
  // A scissors line in a message given with -F stays in the commit, so the text below it is scanned too.
  const scissors = '# ------------------------ >8 ------------------------\n';
  await writeFile(path.join(dir, 'message'), 'Add notes\n\n' + scissors + homePath + '\n');
  const blockedScissors = commit('-F', 'message');
  assert.notEqual(blockedScissors.status, 0);
  assert.match(blockedScissors.stdout + blockedScissors.stderr, /message:4: FAIL personal path/);
  const clean = commit('-m', 'Add notes', '-m', trailer);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.equal(git('log', '-1', '--format=%B'), 'Add notes\n\n' + trailer + '\n\n');
  // Git cuts the diff of `git commit -v` below its own scissors block, so the hook does not scan it.
  const verbose = 'Add notes\n# Lines starting with # are ignored.\n' + scissors + '# Do not modify or remove the line above.\n# Everything below it will be ignored.\ndiff --git a/notes.txt b/notes.txt\n-' + homePath + '\n';
  await writeFile(path.join(dir, 'message'), verbose);
  assert.equal(run(['--commit-msg', path.join(dir, 'message')]).status, 0);
  await writeFile(path.join(dir, 'message'), verbose.replace('# Lines', '# ' + hostName));
  assert.match(run(['--commit-msg', path.join(dir, 'message')]).stdout, /^message:2: FAIL private host$/m);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
test('the pre-push hook stops a private branch name or a new commit with a personal email before anything is public', async () => {
 const { dir, git } = await scratchRepo();
 const remote = await mkdtemp(path.join(root, '.public-gate-test-remote-'));
 try {
  execFileSync('git', ['init', '-q', '--bare', remote]);
  await mkdir(path.join(dir, 'scripts/hooks'), { recursive: true });
  for (const file of ['check-public-tree.mjs', 'public-tree-exemptions.json', 'hooks/pre-push']) {
   await writeFile(path.join(dir, 'scripts', file), await readFile(path.join(root, 'scripts', file)), { mode: 0o755 });
  }
  git('add', 'scripts');
  git('commit', '-q', '-m', 'Add the gate');
  git('remote', 'add', 'origin', remote);
  git('config', 'core.hooksPath', 'scripts/hooks');
  const push = (...args) => spawnSync('git', ['push', '-q', 'origin', ...args], { cwd: dir, encoding: 'utf8' });
  const first = push('HEAD:refs/heads/main');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  // The branch name alone is enough: no commit hook ever sees it.
  git('branch', 'fix/' + hostName + '-lag');
  const blockedName = push('fix/' + hostName + '-lag');
  assert.notEqual(blockedName.status, 0);
  assert.match(blockedName.stdout + blockedName.stderr, new RegExp('ref refs/heads/fix/' + hostName + '-lag:1: FAIL private host'));
  assert.equal(execFileSync('git', ['--git-dir', remote, 'branch', '--list'], { encoding: 'utf8' }).includes(hostName), false, 'the branch never reached the remote');
  const desk = 'Desk' + 'top';
  git('branch', 'fix/' + desk + '-rooms');
  assert.match((r => r.stdout + r.stderr)(push('fix/' + desk + '-rooms')), new RegExp('REVIEW device-word context'));
  // A commit made around the commit hooks still has its emails and message read when it is pushed.
  await writeFile(path.join(dir, 'notes.txt'), 'line\n');
  git('add', 'notes.txt');
  execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=' + 'private' + '@' + 'personal.org', 'commit', '-q', '--no-verify', '-m', 'Add notes', '-m', 'Seen on ' + hostName], { cwd: dir });
  const blockedCommit = push('HEAD:refs/heads/notes');
  assert.notEqual(blockedCommit.status, 0);
  assert.match(blockedCommit.stdout + blockedCommit.stderr, /identity:1: FAIL email/);
  assert.match(blockedCommit.stdout + blockedCommit.stderr, /message:3: FAIL private host/);
  // Commits the remote already has are not read again, and a clean branch goes out.
  git('reset', '-q', '--hard', 'origin/main');
  git('checkout', '-q', '-b', 'fix/clean');
  await writeFile(path.join(dir, 'notes.txt'), 'line\n');
  git('add', 'notes.txt');
  git('commit', '-q', '--no-verify', '-m', 'Add notes');
  const clean = push('fix/clean');
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout + clean.stderr, /Scanned 3 texts: 0 failures/);
 } finally { await rm(dir, { recursive: true, force: true }); await rm(remote, { recursive: true, force: true }); }
});
test('pull request text lists the title, description, branch and every commit message from the API', async () => {
 const dir = await mkdtemp(path.join(root, '.public-gate-test-'));
 let listed = 101;
 const noreply = '1+probe@users.noreply.github.com', personalEmail = 'private' + '@' + 'personal.org';
 const commits = n => Array.from({ length: n }, (_, i) => ({ sha: i.toString(16).padStart(4, '0') + 'b'.repeat(36), commit: { message: 'Commit ' + i + (i === 100 ? '\n\nSeen on ' + hostName : ''),
  author: { name: 'Probe', email: i === 99 ? personalEmail : noreply }, committer: { name: 'GitHub', email: 'noreply@github.com' } } }));
 const server = createServer((request, response) => {
  assert.equal(request.headers.authorization, 'Bearer probe-token');
  const url = new URL(request.url, 'http://x');
  let body;
  if (url.pathname === '/repos/owner/repo/pulls/7') body = { title: 'A title', body: null, commits: 101, head: { ref: 'feature/probe' } };
  else if (url.pathname === '/repos/owner/repo/pulls/7/commits') body = commits(listed).slice((url.searchParams.get('page') - 1) * 100, url.searchParams.get('page') * 100);
  response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 // The child must run asynchronously: a synchronous spawn would block the server it talks to.
 const collect = out => new Promise(resolve => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/pull-request-text.mjs'), out], { env: {
   ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: path.join(dir, 'event.json'), GITHUB_REPOSITORY: 'owner/repo',
   GITHUB_TOKEN: 'probe-token', GITHUB_API_URL: 'http://127.0.0.1:' + server.address().port } });
  let output = '';
  child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
  child.on('close', status => resolve({ status, output }));
 });
 try {
  await writeFile(path.join(dir, 'event.json'), JSON.stringify({ pull_request: { number: 7, title: 'stale title' } }));
  const first = await collect(path.join(dir, 'out'));
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /Wrote 205 texts/);
  assert.equal(await readFile(path.join(dir, 'out/pull-request-title'), 'utf8'), 'A title\n');
  assert.equal(await readFile(path.join(dir, 'out/branch-name'), 'utf8'), 'feature/probe\n');
  const texts = await readdir(path.join(dir, 'out'));
  assert.equal(texts.length, 205);
  assert.equal(await readFile(path.join(dir, 'out/commit-0063bbbbbbbb-identity'), 'utf8'), 'author-email: ' + personalEmail + '\ncommitter-email: noreply@github.com\n');
  const scan = run(['--text', ...texts.map(name => path.join(dir, 'out', name))]);
  assert.equal(scan.status, 1);
  assert.match(scan.stdout, /^commit-0064bbbbbbbb:3: FAIL private host$/m);
  assert.match(scan.stdout, /^commit-0063bbbbbbbb-identity:1: FAIL email$/m);
  assert.match(scan.stdout, /Scanned 205 texts: 2 failures, 0 review findings/);
  // A pull request with more commits than the API lists fails instead of scanning part of it.
  listed = 100;
  const short = await collect(path.join(dir, 'short'));
  assert.equal(short.status, 1);
  assert.match(short.output, /has 101 commits but the API listed 100/);
 } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});
