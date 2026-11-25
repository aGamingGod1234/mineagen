import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setup, run, posixOnly, leftSignIns } from './checkpoint-batch-fixture.mjs';

// How scripts/quality/checkpoint-batch.mjs drops machines whose games keep failing or that boat no longer knows, and where it
// plays their games next, against the fake boat CLI in checkpoint-batch-fixture.mjs.

test('checkpoint batch drops a machine whose launches end without a done file twice in a row, and plays on the rest', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'bx_bbbbbbbb/BROKEN'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.machine === 'bx_aaaaaaaa'), 'every game finished on the healthy machine');
		assert.equal(state.machines.find(m => m.id === 'bx_bbbbbbbb').lost, true);
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /dropping bx_bbbbbbbb: 2 launches in a row/);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch does not hand a game back to the machine it just died on while another machine can take it', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'bx_bbbbbbbb/BROKEN'), ''); writeFileSync(path.join(root, 'bx_aaaaaaaa/SLOW'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.machine === 'bx_aaaaaaaa' && g.attempts <= 2));
		assert.equal(state.machines.find(m => m.id === 'bx_bbbbbbbb').lost, true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch drops machines whose game launches keep failing while ssh still answers, instead of idling to the deadline', posixOnly, () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'NOAUTH'), '');
	try {
		run(root, { CHECKPOINT_LOST_AFTER_MS: '1500' });
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['not started', 'not started', 'not started', 'not started']);
		assert.ok(state.machines.every(m => m.lost && m.deleted));
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /dropping bx_aaaaaaaa: its launches keep failing/);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch drops a machine boat no longer knows and replays its game on another', posixOnly, () => {
	const root = setup({ plan: { drain: undefined } });
	writeFileSync(path.join(root, 'bx_aaaaaaaa/VANISH_ON_START'), ''); writeFileSync(path.join(root, 'bx_bbbbbbbb/SLOW'), '');
	try {
		run(root, { CHECKPOINT_LOST_AFTER_MS: '60000' });
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.machine === 'bx_bbbbbbbb'));
		assert.equal(state.machines.find(m => m.id === 'bx_aaaaaaaa').lost, true);
	} finally { try { execFileSync('pkill', ['-f', `${root}/bx_`]); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch with one machine plays a vanished game again after its copy keeps failing, and keeps the machine', posixOnly, () => {
	const root = setup({ record: true, plan: { vms: ['bx_aaaaaaaa'] } });
	writeFileSync(path.join(root, 'RECORD'), ''); writeFileSync(path.join(root, 'NODONE'), ''); writeFileSync(path.join(root, 'NOSALVAGE'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		const log = readFileSync(path.join(root, 'out/batch.log'), 'utf8');
		assert.match(log, /kept the uncopied run folder of .* on bx_aaaaaaaa as ~\/ck\/games\/.*\.held-/);
		assert.equal(existsSync(path.join(root, 'deleted.log')), false, 'the machine holding uncopied replays is kept');
		assert.match(log, /batch ended; machines not deleted: bx_aaaaaaaa .*\(kept: /);
		assert.ok(readdirSync(path.join(root, 'bx_aaaaaaaa/ck/games')).some(name => /\.held-\d+$/.test(name)), 'the old run folder is still on the machine');
	} finally { rmSync(root, { recursive: true, force: true }); }
});
