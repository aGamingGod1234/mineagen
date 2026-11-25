import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { script, setup, run, posixOnly, leftSignIns } from './checkpoint-batch-fixture.mjs';

// How scripts/quality/checkpoint-batch.mjs rides out a boat outage without dropping machines, against the fake boat CLI in
// checkpoint-batch-fixture.mjs.

test('checkpoint batch drops no machine while boat itself is unreachable for a while', posixOnly, async () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'SLOW'), '');
	try {
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_LOST_AFTER_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '', outage = false;
		child.stdout.on('data', chunk => {
			out += chunk;
			// Boat goes away right after the first game is home (one machine idle, one mid-game) for 3 s: past LOST_AFTER_MS, inside the outage grace.
			if (!outage && /finished nether/.test(out)) { outage = true; writeFileSync(path.join(root, 'OUTAGE'), ''); setTimeout(() => rmSync(path.join(root, 'OUTAGE'), { force: true }), 3_000); }
		});
		assert.equal(await exited, 0);
		assert.ok(outage, 'the outage happened');
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.machines.every(m => !m.lost));
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch drops no machine when boat comes back in the middle of a failing launch', posixOnly, async () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'SLOW'), '');
	try {
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_LOST_AFTER_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '', outage = false;
		child.stdout.on('data', chunk => {
			out += chunk;
			// Boat goes away for at least 3 s (past LOST_AFTER_MS) and comes back exactly between a refused sign-in upload and
			// the batch asking boat about that machine: the launch's failure and the pass's failure both end in one answer.
			if (!outage && /finished nether/.test(out)) { outage = true; writeFileSync(path.join(root, 'OUTAGE'), ''); setTimeout(() => writeFileSync(path.join(root, 'OUTAGE_ENDS_AT_UPLOAD'), ''), 3_000); }
		});
		assert.equal(await exited, 0);
		assert.ok(outage && !existsSync(path.join(root, 'OUTAGE_ENDS_AT_UPLOAD')), 'the outage ended at a sign-in upload');
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.machines.every(m => !m.lost));
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch drops no machine during an outage longer than the drop wait, and plays every game once boat is back', posixOnly, async () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'SLOW'), '');
	try {
		// LOST_AFTER_MS 200 makes the drop wait during an outage 1.2 s; boat stays away for 4 s.
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_LOST_AFTER_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '', outage = false;
		child.stdout.on('data', chunk => {
			out += chunk;
			if (!outage && /finished nether/.test(out)) { outage = true; writeFileSync(path.join(root, 'OUTAGE'), ''); setTimeout(() => rmSync(path.join(root, 'OUTAGE'), { force: true }), 4_000); }
		});
		assert.equal(await exited, 0);
		assert.ok(outage, 'the outage happened');
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.machines.every(m => !m.lost));
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch keeps trying to take the sign-ins off when boat is out as the batch ends', posixOnly, () => {
	// Listed machines are kept, so only the cleanup can take their sign-ins off.
	const root = setup({ plan: { drain: undefined } });
	writeFileSync(path.join(root, 'OUTAGE_AT_SIGNOFF'), '');
	try {
		run(root);
		assert.ok(!existsSync(path.join(root, 'OUTAGE_AT_SIGNOFF')), 'the outage happened');
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /could not remove the sign-in from bx_/);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.ok(state.machines.every(m => m.signInRemoved));
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});
