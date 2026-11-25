import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { script, setup, posixOnly } from './checkpoint-batch-fixture.mjs';

// How scripts/quality/checkpoint-batch.mjs keeps its cleanup inside the signal budget when ssh or a drop stalls after SIGTERM,
// against the fake boat CLI in checkpoint-batch-fixture.mjs.

test('checkpoint batch keeps the first cleanup pass inside the signal\'s budget when ssh stalls after SIGTERM', posixOnly, async () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'HANG'), '');
	const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
		env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_SIGNAL_BUDGET_MS: '12000' }, stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '';
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no game started: ${out}`)), 60_000);
			child.stdout.on('data', chunk => { out += chunk; if ((out.match(/started nether/g) ?? []).length >= 2) { clearTimeout(timer); resolve(); } });
		});
		// Both games are running, so the first cleanup pass starts by ending their sessions, and that ssh stalls.
		writeFileSync(path.join(root, 'STALLSSH'), '');
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		await exited;
		const took = Date.now() - signalledAt;
		assert.ok(took < 25_000, `the cleanup stayed inside the 12 s signal budget (${took} ms)`);
		const log = readFileSync(path.join(root, 'out/batch.log'), 'utf8');
		assert.match(log, /could not end the game sessions on bx_aaaaaaaa/);
		assert.match(log, /could not end the game sessions on bx_bbbbbbbb/);
		// The stalled steps left the deletion its share of the budget: both machines are gone, sign-ins with them.
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
	} finally {
		child.kill('SIGKILL');
		for (const pattern of [`${root}/bin/boat`, '^sleep 300[.]5$', `${root}/bx_`]) { try { execFileSync('pkill', ['-f', pattern]); } catch {} }
		rmSync(root, { recursive: true, force: true });
	}
});

test('checkpoint batch cuts a stalled retirement on SIGTERM and still deletes the machines inside the budget', posixOnly, async () => {
	const root = setup();
	writeFileSync(path.join(root, 'STALL_AT_SIGNOFF'), '');
	const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
		env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_SIGNAL_BUDGET_MS: '12000' }, stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		const exited = new Promise(resolve => child.on('exit', resolve));
		// Every game ends quickly, so a machine with no further game is retired, and its sign-in removal stalls.
		for (let i = 0; i < 600 && !existsSync(path.join(root, 'stalled.log')); i++) await new Promise(r => setTimeout(r, 100));
		assert.ok(existsSync(path.join(root, 'stalled.log')), 'a retirement stalled');
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		await exited;
		const took = Date.now() - signalledAt;
		assert.ok(took < 25_000, `the stalled retirement did not hold back the cleanup (${took} ms)`);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
	} finally {
		child.kill('SIGKILL');
		for (const pattern of [`${root}/bin/boat`, '^sleep 300[.]5$', `${root}/bx_`]) { try { execFileSync('pkill', ['-f', pattern]); } catch {} }
		rmSync(root, { recursive: true, force: true });
	}
});

test('checkpoint batch cuts a stalled drop of a lost machine on SIGTERM and still deletes the machines inside the budget', posixOnly, async () => {
	const root = setup();
	// bx_bbbbbbbb's launches end without a done file, so it is dropped mid-batch; its sign-in removal there stalls.
	// bx_aaaaaaaa's game runs for minutes, so no retirement (or the end of the batch) gets there first.
	writeFileSync(path.join(root, 'bx_bbbbbbbb/BROKEN'), ''); writeFileSync(path.join(root, 'bx_aaaaaaaa/HANG'), '');
	writeFileSync(path.join(root, 'STALL_AT_SIGNOFF'), '');
	const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
		env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_SIGNAL_BUDGET_MS: '12000' }, stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		let code = null;
		const exited = new Promise(resolve => child.on('exit', c => { code = c; resolve(); }));
		const stalled = () => existsSync(path.join(root, 'stalled.log')) && readFileSync(path.join(root, 'stalled.log'), 'utf8').includes('bx_bbbbbbbb');
		for (let i = 0; i < 600 && !stalled(); i++) await new Promise(r => setTimeout(r, 100));
		assert.ok(stalled(), 'the drop of bx_bbbbbbbb stalled at its sign-in removal');
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /dropping bx_bbbbbbbb: 2 launches in a row/);
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		// Without the signal on the drop's calls, the runner waits out the stalled ssh (up to two minutes) before cleaning up.
		let timer;
		await Promise.race([exited, new Promise(r => { timer = setTimeout(r, 40_000); })]);
		clearTimeout(timer);
		const took = Date.now() - signalledAt;
		assert.notEqual(code, null, 'the runner exited after SIGTERM');
		assert.ok(took < 25_000, `the stalled drop did not hold back the cleanup (${took} ms)`);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
	} finally {
		child.kill('SIGKILL');
		for (const pattern of [`${root}/bin/boat`, '^sleep 300[.]5$', `${root}/bx_`]) { try { execFileSync('pkill', ['-f', pattern]); } catch {} }
		rmSync(root, { recursive: true, force: true });
	}
});
