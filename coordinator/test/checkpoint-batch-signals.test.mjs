import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { script, setup, posixOnly, leftSignIns } from './checkpoint-batch-fixture.mjs';

// How scripts/quality/checkpoint-batch.mjs ends its games, copies them home and cleans up on SIGTERM, against the fake boat
// CLI in checkpoint-batch-fixture.mjs.

test('checkpoint batch ends its running games and cleans up at once on SIGTERM', posixOnly, async () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'HANG'), '');
	try {
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '';
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no game started: ${out}`)), 60_000);
			child.stdout.on('data', chunk => { out += chunk; if ((out.match(/started nether/g) ?? []).length >= 2) { clearTimeout(timer); resolve(); } });
		});
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		await exited;
		assert.ok(Date.now() - signalledAt < 60_000, 'the cleanup ran well inside systemd\'s 90 s stop timeout');
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state).sort(), ['not finished', 'not finished', 'not started', 'not started']);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
		assert.equal(leftSignIns(root), '0');
		// pgrep exits 1 when nothing matches.
		assert.throws(() => execFileSync('pgrep', ['-f', `${root}/bx_.*/ck/game.sh`], { encoding: 'utf8' }), 'no game process is left');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch copies the replay and world of a running game before it deletes the machine on SIGTERM', posixOnly, async () => {
	const root = setup({ record: true });
	writeFileSync(path.join(root, 'RECORD'), '');
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'HANG'), '');
	try {
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '';
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no game started: ${out}`)), 60_000);
			child.stdout.on('data', chunk => { out += chunk; if ((out.match(/started nether/g) ?? []).length >= 2) { clearTimeout(timer); resolve(); } });
		});
		child.kill('SIGTERM');
		await exited;
		assert.equal(readdirSync(path.join(root, 'out/salvage')).length, 2);
		const log = readFileSync(path.join(root, 'out/batch.log'), 'utf8');
		for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) assert.ok(log.indexOf(`from ${id} to salvage/`) >= 0 && log.indexOf(`from ${id} to salvage/`) < log.indexOf(`deleted ${id}`), `${id} was copied before it was deleted`);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch keeps a machine whose running game\'s replays could not be copied on SIGTERM, with its sign-in off', posixOnly, async () => {
	const root = setup({ record: true });
	writeFileSync(path.join(root, 'RECORD'), ''); writeFileSync(path.join(root, 'NOSALVAGE'), '');
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'HANG'), '');
	try {
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '';
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no game started: ${out}`)), 60_000);
			child.stdout.on('data', chunk => { out += chunk; if ((out.match(/started nether/g) ?? []).length >= 2) { clearTimeout(timer); resolve(); } });
		});
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		await exited;
		assert.ok(Date.now() - signalledAt < 60_000, 'the cleanup still ends inside the signal budget');
		assert.equal(existsSync(path.join(root, 'deleted.log')), false, 'no machine holding an uncopied replay is deleted');
		assert.equal(leftSignIns(root), '0');
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /batch ended; machines not deleted: .*bx_aaaaaaaa.*\(kept: copy the recordings and world from/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch cancels a long upload on SIGTERM and cleans up at once', posixOnly, async () => {
	const root = setup();
	writeFileSync(path.join(root, 'BLOCKSCP'), '');
	try {
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		// Wait until both machines are stuck uploading their arm package.
		for (let i = 0; i < 300 && (existsSync(path.join(root, 'blocked.log')) ? readFileSync(path.join(root, 'blocked.log'), 'utf8').trim().split('\n').length : 0) < 2; i++) await new Promise(r => setTimeout(r, 100));
		assert.equal(readFileSync(path.join(root, 'blocked.log'), 'utf8').trim().split('\n').length, 2, 'both uploads hung');
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		await exited;
		assert.ok(Date.now() - signalledAt < 30_000, `the cleanup did not wait for the hung uploads (${Date.now() - signalledAt} ms)`);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
		assert.equal(leftSignIns(root), '0');
		assert.equal(readFileSync(path.join(root, 'blocked.log'), 'utf8').trim().split('\n').length, 2, 'no further upload started after the signal');
	} finally { try { execFileSync('pkill', ['-f', `${root}/bin/boat`]); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch copies the replay and world again at the end when SIGTERM cuts the first copy, before it deletes the machine', posixOnly, async () => {
	const root = setup({ record: true });
	// bx_bbbbbbbb's launches end without a done file, so its replay and world are copied off; that copy hangs until SIGTERM.
	writeFileSync(path.join(root, 'RECORD'), ''); writeFileSync(path.join(root, 'bx_bbbbbbbb/BROKEN'), ''); writeFileSync(path.join(root, 'bx_aaaaaaaa/HANG'), '');
	writeFileSync(path.join(root, 'STALLSALVAGE'), '');
	const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
		env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_SIGNAL_BUDGET_MS: '20000' }, stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		const exited = new Promise(resolve => child.on('exit', resolve));
		const stalled = path.join(root, 'salvage-stalled');
		for (let i = 0; i < 600 && !existsSync(stalled); i++) await new Promise(r => setTimeout(r, 100));
		assert.ok(existsSync(stalled), 'the copy of the vanished game stalled');
		rmSync(path.join(root, 'STALLSALVAGE'));
		child.kill('SIGTERM');
		await exited;
		const log = readFileSync(path.join(root, 'out/batch.log'), 'utf8');
		assert.match(log, /from bx_bbbbbbbb to salvage\//, 'the cut copy was made again in the cleanup');
		assert.ok(log.indexOf('from bx_bbbbbbbb to salvage/') < log.indexOf('deleted bx_bbbbbbbb'), 'copied before it was deleted');
		assert.ok(readdirSync(path.join(root, 'out/salvage')).length >= 1);
		assert.equal(leftSignIns(root), '0');
	} finally {
		child.kill('SIGKILL');
		for (const pattern of [`${root}/bin/boat`, '^sleep 299$', `${root}/bx_`]) { try { execFileSync('pkill', ['-f', pattern]); } catch {} }
		rmSync(root, { recursive: true, force: true });
	}
});

test('checkpoint batch copies what a finished game already packed when SIGTERM cuts its normal copy, before it deletes the machine', posixOnly, async () => {
	const root = setup({ record: true });
	writeFileSync(path.join(root, 'RECORD'), ''); writeFileSync(path.join(root, 'bx_bbbbbbbb/HANG'), ''); writeFileSync(path.join(root, 'STALLFETCH'), '');
	// bx_aaaaaaaa's game finishes and its normal copy hangs; bx_bbbbbbbb's game runs on.
	const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
		env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_SIGNAL_BUDGET_MS: '20000' }, stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		const exited = new Promise(resolve => child.on('exit', resolve));
		const stalled = path.join(root, 'fetch-stalled');
		for (let i = 0; i < 600 && !existsSync(stalled); i++) await new Promise(r => setTimeout(r, 100));
		assert.ok(existsSync(stalled), 'the normal copy of a finished game stalled');
		rmSync(path.join(root, 'STALLFETCH'));
		child.kill('SIGTERM');
		await exited;
		const log = readFileSync(path.join(root, 'out/batch.log'), 'utf8');
		const copied = log.match(/from (bx_aaaaaaaa) to salvage\/(\S+\.tgz)/);
		assert.ok(copied, log);
		const listing = execFileSync('tar', ['-tzf', path.join(root, 'out/salvage', copied[2])], { encoding: 'utf8' });
		assert.match(listing, /recordings\.tar/); assert.match(listing, /world-headless-w\.tgz/);
		assert.ok(log.indexOf(copied[0]) < log.indexOf(`deleted ${copied[1]}`), 'copied before it was deleted');
		assert.equal(leftSignIns(root), '0');
	} finally {
		child.kill('SIGKILL');
		for (const pattern of [`${root}/bin/boat`, '^sleep 299$', `${root}/bx_`]) { try { execFileSync('pkill', ['-f', pattern]); } catch {} }
		rmSync(root, { recursive: true, force: true });
	}
});
