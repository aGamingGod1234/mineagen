import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));
// Assembled so this test file does not trip the gate it tests.
const privatePath = '/home/' + 'agaming' + 'god/notes.txt';

function repository() {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-tracked-'));
	const git = (...args) => {
		const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
	};
	git('init', '-q');
	mkdirSync(path.join(dir, 'scripts'));
	for (const name of ['check-public-tree.mjs', 'public-tree-exemptions.json']) copyFileSync(path.join(scripts, name), path.join(dir, 'scripts', name));
	writeFileSync(path.join(dir, 'README.md'), 'clean\n');
	writeFileSync(path.join(dir, 'gone.md'), 'deleted later\n');
	git('add', '.');
	git('commit', '-q', '-m', 'init');
	return { dir, git, gate: (...args) => spawnSync(process.execPath, ['scripts/check-public-tree.mjs', ...args], { cwd: dir, encoding: 'utf8' }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('--tracked ignores untracked build output that the folder scan flags', () => {
	const { dir, gate, cleanup } = repository();
	try {
		mkdirSync(path.join(dir, 'libs'));
		writeFileSync(path.join(dir, 'libs/upstream.jar'), 'binary');
		writeFileSync(path.join(dir, 'untracked.log'), privatePath + '\n');
		unlinkSync(path.join(dir, 'gone.md'));
		const folder = gate('.');
		assert.equal(folder.status, 1);
		assert.match(folder.stdout, /libs\/upstream\.jar:1: FAIL library binary/);
		const tracked = gate('--tracked');
		assert.equal(tracked.status, 0, tracked.stdout);
		assert.match(tracked.stdout, /Scanned 3 files: 0 failures, 0 review findings\./);
	} finally { cleanup(); }
});

test('--tracked scans the working copy of tracked files, so an uncommitted private detail fails', () => {
	const { dir, gate, cleanup } = repository();
	try {
		writeFileSync(path.join(dir, 'README.md'), `see ${privatePath}\n`);
		const result = gate('--tracked');
		assert.equal(result.status, 1);
		assert.match(result.stdout, /README\.md:1: FAIL personal path/);
	} finally { cleanup(); }
});

test('--tracked fails a tracked symlink as the folder scan does', { skip: process.platform === 'win32' && 'symlinks need extra rights on Windows' }, () => {
	const { dir, git, gate, cleanup } = repository();
	try {
		symlinkSync('README.md', path.join(dir, 'link.md'));
		git('add', 'link.md');
		const result = gate('--tracked');
		assert.equal(result.status, 1);
		assert.match(result.stdout, /link\.md:1: FAIL symlink/);
	} finally { cleanup(); }
});
