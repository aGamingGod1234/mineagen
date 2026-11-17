#!/usr/bin/env node
// Writes the text a CI run must scan for private details into an empty folder, one file per piece, for
// `node scripts/check-public-tree.mjs --text <folder>/*`:
// - a pull request: its title, description, branch name and the message of every commit in it;
// - a push: the message of every pushed commit.
// The pull request is read from the API, not the event, so a rerun after an edit scans the current title and
// description. The API needs only read access, and the commits come from it, not from the shallow checkout.
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
const out = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('Usage: pull-request-text.mjs <empty folder>');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw Error('Output must be empty: ' + out);
const { GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = process.env;
const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const event = JSON.parse(await readFile(eventPath, 'utf8'));
async function get(route) {
 const response = await fetch(api + route, {
  headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'public-gate', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  signal: AbortSignal.timeout(30_000),
 });
 if (!response.ok) throw Error('GET ' + route + ' answered ' + response.status + ' ' + (await response.text()).slice(0, 200));
 return response.json();
}
const write = (name, text) => writeFile(path.join(out, name), (text ?? '') + '\n');
let pieces = 0;
if (eventName === 'pull_request') {
 const number = event.pull_request.number;
 const pull = await get(`/repos/${repository}/pulls/${number}`);
 await write('pull-request-title', pull.title);
 await write('pull-request-description', pull.body);
 await write('branch-name', pull.head.ref);
 pieces += 3;
 const commits = [];
 // The API lists at most 250 commits of a pull request.
 for (let page = 1; ; page++) {
  const batch = await get(`/repos/${repository}/pulls/${number}/commits?per_page=100&page=${page}`);
  commits.push(...batch);
  if (batch.length < 100) break;
 }
 if (commits.length !== pull.commits) throw Error(`The pull request has ${pull.commits} commits but the API listed ${commits.length}; it lists at most 250, so squash some commits`);
 for (const commit of commits) { await write('commit-' + commit.sha.slice(0, 12), commit.commit.message); pieces++; }
} else if (eventName === 'push') {
 for (const commit of event.commits ?? []) { await write('commit-' + commit.id.slice(0, 12), commit.message); pieces++; }
 if (event.head_commit && !(event.commits ?? []).some(c => c.id === event.head_commit.id)) { await write('commit-' + event.head_commit.id.slice(0, 12), event.head_commit.message); pieces++; }
} else throw Error('No text to scan for the event ' + eventName);
console.log('Wrote ' + pieces + ' texts to scan.');
