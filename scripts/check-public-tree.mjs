#!/usr/bin/env node
// The publication gate. Three ways to run it:
//   node scripts/check-public-tree.mjs [folder]          every file under the folder (default: the current one); a
//                                                         top-level .git folder or file is skipped. CI runs this on
//                                                         a fresh checkout.
//   node scripts/check-public-tree.mjs --tracked         the working copy of every file Git tracks in this checkout,
//                                                         so untracked build output (node_modules, libs JARs) is not
//                                                         read; matches the CI scan of a fresh checkout of HEAD plus
//                                                         your uncommitted edits. Untracked new files are not scanned.
//   node scripts/check-public-tree.mjs --staged          the staged content of every staged file (the pre-commit hook)
//   node scripts/check-public-tree.mjs --text <file|->   text such as a commit message or a pull request description;
//                                                         - reads standard input. Exemptions never apply to text.
//   node scripts/check-public-tree.mjs --commit-msg <file>  a commit message file (the commit-msg hook)
//   node scripts/check-public-tree.mjs --identity        the author and committer email the next commit will carry
//                                                         (the commit-msg hook)
//   node scripts/check-public-tree.mjs --pre-push <remote>  the refs on standard input as Git's pre-push hook gets
//                                                         them: each branch or tag name, an annotated tag's message
//                                                         and tagger email, and the message, author email and
//                                                         committer email of every pushed commit the remote lacks
// Exit code 1 means a failure or a review finding; 2 means the gate could not run.
import { readdir, readFile } from 'node:fs/promises';
import { lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
const exemptions = JSON.parse(await readFile(new URL('./public-tree-exemptions.json', import.meta.url), 'utf8'));
let exempted = 0;
function finding(file, lineNumber, rule, line, review = false, exempt = true) {
 const hash = line === null ? null : createHash('sha256').update(line).digest('hex');
 const allowed = exempt && exemptions.find(e => e.file === file && e.rule === rule && (line === null ? e.sha256 === undefined : e.sha256 === hash));
 if (allowed) {
  console.log(file + ':' + lineNumber + ': EXEMPT ' + rule + ' (' + allowed.reason + ')');
  exempted++; return;
 }
 console.log(file + ':' + lineNumber + ': ' + (review ? 'REVIEW ' : 'FAIL ') + rule);
 if (review) reviews++; else failures++;
}
let files = 0, failures = 0, reviews = 0;
const personal = ['agaming' + 'god', 'User', 'aGaming' + 'God'];
const hosts = ['mini' + 'pc', 'desktop' + '-lan', 'SAN' + 'PEDRO', 'lucas' + 'toh'];
const rules = [
 ['personal path', new RegExp('/home/' + personal[0] + '|C:[\\\\/]+Users[\\\\/]+(?:' + personal.join('|') + ')', 'i')],
 ['private host', new RegExp(hosts.join('|'), 'i')],
 ['private network', /\b(?:100|192\.168)\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b|[\w.-]+\.ts\.net\b|\btailscale\b/i],
 ['private link', new RegExp('postplan' + '\\.dev|claude' + '\\.ai/artifact', 'i')],
 // Token and key shapes, assembled so this file does not match itself.
 ['credential', new RegExp([
  '\\bsk-' + '(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}', '\\bgh[pousr]_' + '[A-Za-z0-9]{36,}', '\\bgithub_pat_' + '[A-Za-z0-9_]{22,}',
  '\\bAKIA' + '[0-9A-Z]{16}\\b', '\\bAIza' + '[0-9A-Za-z_-]{35}', '\\bxox[baprs]-' + '[A-Za-z0-9-]{10,}',
  '-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----',
 ].join('|'))],
 ['recorded usage', /"(?:costUsd|totalCostUsd|inputTokens|outputTokens|cachedInputTokens|cacheWriteInputTokens|contextTokens)"\s*:\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)/i],
];
// Placeholder domains, and the no-reply addresses that commit trailers use.
const publicEmail = /@(?:example\.(?:com|org|net|invalid|test)|localhost\.localdomain|test\.invalid)$|^noreply@(?:anthropic|github)\.com$|^(?:\d+\+)?[\w-]+@users\.noreply\.github\.com$/i;
// Boat takes only runs started by the owner, so a pull request from a fork must name GitHub's runner instead.
const forkAwareRunner = "${{ (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && 'boat' || 'ubuntu-latest' }}";
const publicRunners = ['ubuntu-latest', 'windows-latest', 'boat', forkAwareRunner];
function scanLines(rel, text, { workflow = false, exempt = true } = {}) {
 text.split(/\r?\n/).forEach((line, i) => {
  const flag = (rule, review = false) => finding(rel, i + 1, rule, line, review, exempt);
  for (const [reason, pattern] of rules) if (pattern.test(line)) flag(reason);
  const emails = line.replace(/:\/\/[^/\s@]+:[^/\s@]+@/g, '://').match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
  if (emails.some(e => !publicEmail.test(e))) flag('email');
  // A public workflow names its runner on one `runs-on: <value>` line per job, and the value is one of the public
  // runners exactly: no variable, other expression, list, inline mapping or self-hosted label. Any other mention of
  // the key or of a self-hosted runner fails, so a form this line check cannot read is rejected instead of passed.
  const runner = line.match(/^ +runs-on: (.*?) *$/)?.[1];
  if (workflow && /runs-on|self-hosted/i.test(line.replace(/^\s*#.*$/, '')) && !publicRunners.includes(runner)) flag('runner not GitHub-hosted');
  if (new RegExp('<!-- /?' + 'private -->|# ' + 'Private:').test(line)) flag('private marker');
  // Review all capitalized device words; context may be ordinary UI/platform terminology.
  if (/\b(?:Mini PC|Laptop|Desktop)\b/.test(line)) flag('device-word context', true);
  if (rel !== 'LICENSE' && new RegExp('\\bluc' + 'as\\b', 'i').test(line)) flag('personal name', true);
 });
}
function scanFile(rel, data) {
 files++;
 for (const reason of [data.length > 2_000_000 ? 'file exceeds 2 MB' : '', /^libs\/.*\.jar$/i.test(rel) ? 'library binary' : ''].filter(Boolean)) finding(rel, 1, reason, null);
 // Latin-1 also exposes ASCII identifiers in binary assets.
 scanLines(rel, data.toString(data.includes(0) ? 'latin1' : 'utf8'), { workflow: /^\.github\/workflows\//.test(rel) });
}
async function walk(root, dir) {
 for (const entry of await readdir(dir, { withFileTypes: true })) {
  const file = path.join(dir, entry.name), rel = path.relative(root, file).split(path.sep).join('/');
  // Git metadata of a checkout: a folder, or a file in a worktree. It is never published.
  if (rel === '.git') continue;
  if (entry.isSymbolicLink()) { console.log(rel + ':1: FAIL symlink'); failures++; continue; }
  if (entry.isDirectory()) { await walk(root, file); continue; }
  scanFile(rel, await readFile(file));
 }
}
// One `git cat-file --batch` call reads every staged blob, so a small commit takes one Node start and two Git calls.
function scanStaged() {
 const git = (args, input) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { input, maxBuffer: 2 ** 30 });
 const raw = git(['diff', '--cached', '--raw', '-z', '--no-renames', '--diff-filter=ACMRT']).toString('utf8').split('\0');
 const blobs = [];
 for (let i = 0; i + 1 < raw.length; i += 2) {
  const [, mode, , sha] = raw[i].slice(1).split(' '), rel = raw[i + 1];
  if (mode === '120000') { files++; console.log(rel + ':1: FAIL symlink'); failures++; }
  else if (mode !== '160000') blobs.push({ rel, sha });
 }
 if (!blobs.length) return;
 const out = git(['cat-file', '--batch'], blobs.map(b => b.sha).join('\n') + '\n');
 let at = 0;
 for (const { rel } of blobs) {
  const header = out.toString('latin1', at, out.indexOf(10, at)), size = Number(header.split(' ')[2]);
  at = out.indexOf(10, at) + 1;
  scanFile(rel, out.subarray(at, at + size));
  at += size + 1;
 }
}
// Tracked files in their working-tree form. A tracked path deleted locally is skipped; a gitlink is skipped as in --staged.
function scanTracked() {
 const top = execFileSync('git', ['rev-parse', '--show-toplevel']).toString('utf8').trim();
 const listed = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-s', '-z'], { cwd: top, maxBuffer: 2 ** 30 }).toString('utf8').split('\0');
 const seen = new Set();
 for (const entry of listed) {
  const tab = entry.indexOf('\t');
  if (tab < 0) continue;
  const mode = entry.slice(0, entry.indexOf(' ')), rel = entry.slice(tab + 1);
  if (seen.has(rel) || mode === '160000') continue;
  seen.add(rel);
  let info;
  try { info = lstatSync(path.join(top, rel)); } catch { continue; }
  if (mode === '120000' || info.isSymbolicLink()) { files++; console.log(rel + ':1: FAIL symlink'); failures++; continue; }
  scanFile(rel, readFileSync(path.join(top, rel)));
 }
}
// Git keeps every line of a message given with -m or -F, including lines that start with # and a scissors line, so
// all of it is scanned. Only the diff that `git commit -v` puts below its own scissors block is dropped, because Git
// cuts it from the message.
async function scanCommitMessage(file) {
 if (!file) throw Error('--commit-msg needs the message file');
 const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
 const cut = lines.findIndex((line, i) => line.slice(1) === ' ------------------------ >8 ------------------------' && lines[i + 1] === line[0] + ' Do not modify or remove the line above.');
 files++;
 scanLines('message', (cut < 0 ? lines : lines.slice(0, cut)).join('\n'), { exempt: false });
}
const readStdin = () => new Promise((resolve, reject) => {
 const chunks = [];
 process.stdin.on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))).on('error', reject);
});
// Only the email of an identity is scanned: a display name is the account's public name.
const identityEmail = ident => ident.match(/<([^<>]*)>/)?.[1] ?? '';
function scanIdentity() {
 const git = name => execFileSync('git', ['var', name]).toString('utf8').trim();
 files++;
 scanLines('identity', 'author-email: ' + identityEmail(git('GIT_AUTHOR_IDENT')) + '\ncommitter-email: ' + identityEmail(git('GIT_COMMITTER_IDENT')), { exempt: false });
}
// A branch name and a commit's emails are public the moment they are pushed, and no commit hook sees a branch name.
// Commits the destination remote already has (its remote-tracking refs, or the sha it reports for the ref) went out
// before, so only new commits are read; a commit fetched from another remote is read, since that remote may never
// have run this gate. A destination with no tracking refs here excludes every remote's refs instead. A delete publishes nothing, so it is never stopped: it may be removing a leaked name.
async function scanPush(remote) {
 const zero = /^0+$/;
 const git = (args) => execFileSync('git', args, { maxBuffer: 2 ** 30 }).toString('utf8');
 const known = sha => { try { execFileSync('git', ['cat-file', '-e', sha + '^{commit}'], { stdio: 'ignore' }); return true; } catch { return false; } };
 const remotes = git(['remote']).split(/\r?\n/).filter(Boolean);
 for (const line of (await readStdin()).split(/\r?\n/).filter(Boolean)) {
  const [localRef, localSha, remoteRef, remoteSha] = line.split(' ');
  if (!localSha || zero.test(localSha)) continue;
  for (const ref of new Set([localRef, remoteRef].filter(Boolean))) {
   files++;
   scanLines('ref ' + ref, ref.replace(/^refs\/(?:heads|tags)\//, ''), { exempt: false });
  }
  // An annotated tag carries its own name, message and tagger email, and may point at another tag that carries more.
  for (let object = localSha, depth = 0; depth < 16 && git(['cat-file', '-t', object]).trim() === 'tag'; depth++) {
   const tag = git(['cat-file', '-p', object]);
   const cut = tag.indexOf('\n\n'), label = 'tag ' + object.slice(0, 12);
   files += 3;
   scanLines(label + ' name', tag.match(/^tag (.*)$/m)?.[1] ?? '', { exempt: false });
   scanLines(label + ' identity', 'tagger-email: ' + identityEmail(tag.match(/^tagger (.*)$/m)?.[1] ?? ''), { exempt: false });
   scanLines(label + ' message', cut < 0 ? '' : tag.slice(cut + 2).replace(/\n$/, ''), { exempt: false });
   object = tag.match(/^object ([0-9a-f]+)$/m)?.[1] ?? '';
   if (!object) break;
  }
  if (!known(localSha)) continue;
  // A remote with no tracking refs here (a URL, a new fork or mirror) falls back to every remote's refs: without it the
  // whole history is read, and main's squash merges already carry an account email this push cannot change.
  const own = remotes.includes(remote) && git(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/' + remote + '/']).trim();
  const exclude = [own ? '--remotes=' + remote : '--remotes', ...(remoteSha && !zero.test(remoteSha) && known(remoteSha) ? [remoteSha] : [])];
  const log = git(['log', '--format=%H%x00%ae%x00%ce%x00%B%x00', localSha + '^{commit}', '--not', ...exclude]).split('\0');
  for (let i = 0; i + 4 <= log.length; i += 4) {
   const sha = log[i].trim().slice(0, 12);
   files += 2;
   scanLines('commit ' + sha + ' identity', 'author-email: ' + log[i + 1] + '\ncommitter-email: ' + log[i + 2], { exempt: false });
   scanLines('commit ' + sha + ' message', log[i + 3].replace(/\n$/, ''), { exempt: false });
  }
 }
}
async function scanTexts(sources) {
 if (!sources.length) throw Error('--text needs a file or -');
 for (const source of sources) {
  const text = source === '-' ? await readStdin() : await readFile(source, 'utf8');
  files++;
  scanLines(source === '-' ? 'message' : path.basename(source), text, { exempt: false });
 }
}
const [mode, ...rest] = process.argv.slice(2);
try {
 if (mode === '--staged') scanStaged();
 else if (mode === '--tracked') scanTracked();
 else if (mode === '--text') await scanTexts(rest);
 else if (mode === '--commit-msg') await scanCommitMessage(rest[0]);
 else if (mode === '--identity') scanIdentity();
 else if (mode === '--pre-push') await scanPush(rest[0]);
 else if (mode?.startsWith('--')) throw Error('Unknown option ' + mode);
 else { const root = path.resolve(mode ?? '.'); await walk(root, root); }
} catch (error) {
 console.error('check-public-tree: ' + error.message);
 process.exit(2);
}
const text = ['--text', '--commit-msg', '--identity', '--pre-push'].includes(mode);
if (!text) console.log('Applied ' + exempted + ' exact exemptions.');
console.log('Scanned ' + files + (text ? ' texts: ' : ' files: ') + failures + ' failures, ' + reviews + ' review findings.');
process.exitCode = failures || reviews ? 1 : 0;
