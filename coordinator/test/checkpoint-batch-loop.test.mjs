import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { removeCodexSignIn } from '../../scripts/quality/lib/boat-pool.mjs';
import { setup, run, posixOnly, leftSignIns } from './checkpoint-batch-fixture.mjs';

// Drives scripts/quality/checkpoint-batch.mjs end to end against the fake boat CLI in checkpoint-batch-fixture.mjs. The other
// checkpoint-batch-*.test.mjs files hold the SIGTERM, signal budget, lost machine and boat outage tests.

test('checkpoint batch copies every game home, writes each env switch on its own line, and deletes drained machines', posixOnly, () => {
	const root = setup();
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.score.known && g.score.targets.fortress === 2 && g.score.deaths === 1));
		for (const g of state.games) {
			const listing = execFileSync('tar', ['-tzf', path.join(root, 'out/games', g.id, 'game.tgz')], { encoding: 'utf8' });
			assert.match(listing, /raw\/coordinator\.jsonl/); assert.doesNotMatch(listing, /auth\.json|\.codex-home|level\.dat/);
		}
		assert.equal(readFileSync(path.join(root, 'bx_aaaaaaaa/ck/arms/other/env'), 'utf8'), 'A_SWITCH=on\nB_SWITCH=2\n');
		// Games play on a copy of the machine's template with Lithium added; the machine's own template is left as it was.
		for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) {
			const copy = readFileSync(path.join(root, id, 'ck/server-template'), 'utf8').trim();
			assert.match(copy, /\/rooms\/template-26\.3\+lithium-[0-9a-f]{12}$/);
			assert.equal(readFileSync(path.join(copy, 'mods/lithium-fabric-0.1+mc26.3.jar'), 'utf8'), 'lithium');
			assert.deepEqual(readdirSync(path.join(root, id, 'rooms/template-26.3/mods')), []);
		}
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch records each game: the recorder goes into the template and game.tgz brings the replays and world home', posixOnly, () => {
	const root = setup({ record: true });
	writeFileSync(path.join(root, 'RECORD'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) {
			const copy = readFileSync(path.join(root, id, 'ck/server-template'), 'utf8').trim();
			assert.match(copy, /\+lithium-[0-9a-f]{12}\+rec$/);
			assert.deepEqual(readdirSync(path.join(copy, 'mods')).sort(), ['ServerReplay-1.0+26.3.jar', 'fabric-language-kotlin-1.0.jar', 'lithium-fabric-0.1+mc26.3.jar']);
			assert.equal(readFileSync(path.join(copy, 'config/server-replay/config.json'), 'utf8'), 'server-replay-config.json');
		}
		for (const g of state.games) {
			const dest = path.join(root, 'out/games', g.id);
			const listing = execFileSync('tar', ['-tzf', path.join(dest, 'game.tgz')], { encoding: 'utf8' });
			assert.match(listing, /^\.\/recordings\.tar$/m); assert.match(listing, /^\.\/world-headless-w\.tgz$/m); assert.doesNotMatch(listing, /server\.properties/);
			execFileSync('tar', ['-xzf', path.join(dest, 'game.tgz'), '-C', dest, './recordings.tar']);
			assert.match(execFileSync('tar', ['-tf', path.join(dest, 'recordings.tar')], { encoding: 'utf8' }), /recordings\/players\/agent\/r\.zip/);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch refuses to record with an arm whose launcher does not record the agent', posixOnly, () => {
	const root = setup();
	try {
		const plan = JSON.parse(readFileSync(path.join(root, 'plan.json'), 'utf8'));
		writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ ...plan, recording: path.join(root, 'kit') }));
		assert.throws(() => run(root, {}), /does not record the agent/);
		assert.equal(existsSync(path.join(root, 'out/state.json')), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch copies the replay and world of a game that ended without a done file before it plays it again', posixOnly, () => {
	const root = setup({ record: true });
	writeFileSync(path.join(root, 'RECORD'), ''); writeFileSync(path.join(root, 'NODONE'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		const salvaged = readdirSync(path.join(root, 'out/salvage'));
		assert.equal(salvaged.length, 4);
		for (const file of salvaged) {
			const listing = execFileSync('tar', ['-tzf', path.join(root, 'out/salvage', file)], { encoding: 'utf8' });
			assert.match(listing, /recordings\/players\/agent\/r\.zip/); assert.match(listing, /headless-w\/level\.dat/); assert.doesNotMatch(listing, /server\.properties/);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch keeps every machine whose copy of a vanished game\'s replay and world failed, instead of deleting it', posixOnly, () => {
	const root = setup({ record: true });
	writeFileSync(path.join(root, 'RECORD'), ''); writeFileSync(path.join(root, 'NODONE'), ''); writeFileSync(path.join(root, 'NOSALVAGE'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.equal(existsSync(path.join(root, 'deleted.log')), false, 'no machine holding an uncopied replay is deleted');
		assert.equal(leftSignIns(root), '0');
		const log = readFileSync(path.join(root, 'out/batch.log'), 'utf8');
		// Each vanished game's copy is tried once when it vanishes, and again at retirement, up to 3 failed tries a machine.
		assert.ok((log.match(/could not copy the recordings and world of .* so the machine is kept/g) ?? []).length > 4, log);
		for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) assert.match(log, new RegExp(`batch ended; machines not deleted: .*${id}.*\\(kept: copy the recordings and world from`));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch logs a refresh of the game\'s own sign-in copy and plays every game', posixOnly, () => {
	const root = setup({ refresh: true });
	try {
		run(root);
		const log = readFileSync(path.join(root, 'out/batch.log'), 'utf8');
		assert.match(log, /SIGN-IN REFRESHED on bx_[a-z]+ \(the game's own copy\): Codex refreshed it there; the batch plays on/);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch gives later games the new sign-in when it was refreshed at its source', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'SOURCE_REFRESH'), '');
	try {
		run(root);
		const log = readFileSync(path.join(root, 'out/batch.log'), 'utf8');
		assert.match(log, /SIGN-IN REFRESHED at its source \(sign-in 1\): later games take the new copy/);
		// The games launched before the refresh carry the old copy: that is no refresh on their machine.
		assert.doesNotMatch(log, /SIGN-IN REFRESHED on /);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch gives created machines a boat deadline and deletes them at the end', posixOnly, () => {
	const root = setup({ plan: { vms: [], create: 2, drain: undefined } });
	try {
		run(root);
		const news = readFileSync(path.join(root, 'new.log'), 'utf8').trim().split('\n');
		assert.equal(news.length, 2);
		for (const line of news) { assert.match(line, /--ttl 7200\b/); assert.doesNotMatch(line, /--no-auto-stop/); }
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_new0', 'bx_new1']);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch puts a game back in the queue when its launch never ran, without dropping the machine', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'NODONE'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.attempts === 2));
		assert.ok(state.machines.every(m => !m.lost));
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /wrote no done file/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch refuses to play on a warm-pool machine', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'bx_bbbbbbbb.name'), 'rbpool-abc-default-rooms-0123abcd-ff');
	try {
		assert.throws(() => run(root), /warm-pool machine/);
		assert.equal(existsSync(path.join(root, 'out/state.json')), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch keeps a machine whose launch answer was lost while its game still ran', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'bx_aaaaaaaa/DROPSTART'), '');
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'SLOW'), '');
	try {
		run(root, { CHECKPOINT_LOST_AFTER_MS: '300' });
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.machines.every(m => !m.lost));
		assert.ok(state.games.filter(g => g.machine === 'bx_aaaaaaaa').length >= 2, 'the machine took a game after the lost answer');
		assert.ok(!existsSync(path.join(root, 'bx_aaaaaaaa/DROPSTART')), 'the lost answer happened');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch never packs a game whose raw journals failed to copy, and keeps its world on the machine', posixOnly, () => {
	// Listed machines are kept to the end here, so the healthy one is still there to replay the game the broken one lost.
	const root = setup({ plan: { drain: undefined } });
	// A tar that fails to unpack the raw journals on bx_bbbbbbbb only, as on a full disk.
	const realTar = execFileSync('bash', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
	writeFileSync(path.join(root, 'bin/tar'), `#!/bin/bash\nif [ "$*" = "-C raw -xf -" ] && [ -f "$HOME/BADSTAGE" ]; then cat > /dev/null; exit 2; fi\nexec ${realTar} "$@"\n`);
	chmodSync(path.join(root, 'bin/tar'), 0o755);
	writeFileSync(path.join(root, 'bx_bbbbbbbb/BADSTAGE'), '');
	try {
		run(root, { CHECKPOINT_LOST_AFTER_MS: '1500' });
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.machine === 'bx_aaaaaaaa'), 'every scored game was packed on the healthy machine');
		assert.ok(state.games.some(g => g.attempts === 2), 'the game lost with the broken machine was played again');
		assert.equal(state.machines.find(m => m.id === 'bx_bbbbbbbb').lost, true);
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /could not pack .* \(copying its raw journals failed\)/);
		const worlds = dir => readdirSync(path.join(root, dir, 'ck/arms/runs')).filter(id => existsSync(path.join(root, dir, 'ck/arms/runs', id, 'server/level.dat')));
		assert.ok(worlds('bx_bbbbbbbb').length >= 1, 'the failed game keeps its world');
		assert.deepEqual(worlds('bx_aaaaaaaa'), []);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch replaces a machine it could not make with a spare', posixOnly, () => {
	const root = setup({ plan: { vms: [], create: 1, spares: 1, drain: undefined } });
	writeFileSync(path.join(root, 'NEWFAIL'), '');
	try {
		run(root);
		assert.equal(readFileSync(path.join(root, 'new.log'), 'utf8').trim().split('\n').length, 2);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n'), ['bx_new0']);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch ends the leftover processes of a launch that died before reusing its machine', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'NODONE'), ''); writeFileSync(path.join(root, 'LEFTOVER'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.equal(readdirSync(root).filter(f => f.startsWith('nodone-')).length, 4, 'every game\'s first launch died');
		// pgrep exits 1 when nothing matches.
		assert.throws(() => execFileSync('pgrep', ['-f', `${root}/bx_.*/ck/arms/leftover-`], { encoding: 'utf8' }), 'no leftover of a dead launch is still running');
	} finally { try { execFileSync('pkill', ['-f', `${root}/bx_`]); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch treats an empty meter reading as unreadable and plays every game', posixOnly, () => {
	const root = setup({ plan: { meter: { command: 'true', floorPercent: 10 } } });
	try {
		run(root);
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /meter unreadable: no output/);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('removing a sign-in tolerates missing files and folders but rejects a removal that fails', posixOnly, async t => {
	const root = setup();
	const home = path.join(root, 'bx_aaaaaaaa');
	const saved = { BOAT_BIN: process.env.BOAT_BIN, FAKE_BOAT_ROOT: process.env.FAKE_BOAT_ROOT };
	Object.assign(process.env, { BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root });
	const put = file => { mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); writeFileSync(path.join(home, file), '{}'); };
	try {
		// Nothing there yet: no ~/.codex/auth.json and no ~/ck.
		await removeCodexSignIn('bx_aaaaaaaa');
		for (const file of ['.codex/auth.json', 'ck/arms/runs/g1/.codex-home/auth.json', 'ck/games/g1/auth.json']) put(file);
		await removeCodexSignIn('bx_aaaaaaaa');
		assert.equal(leftSignIns(root), '0');
		if (process.getuid?.() === 0) { t.diagnostic('root ignores folder permissions: failure cases skipped'); return; }
		for (const [file, locked] of [['.codex/auth.json', '.codex'], ['ck/games/g2/auth.json', 'ck/games/g2']]) {
			put(file);
			chmodSync(path.join(home, locked), 0o555);
			try {
				await assert.rejects(removeCodexSignIn('bx_aaaaaaaa'), /command failed on bx_aaaaaaaa/, `a failed removal under ${locked} rejects`);
				assert.ok(existsSync(path.join(home, file)), `${file} is still there`);
			} finally { chmodSync(path.join(home, locked), 0o755); }
			await removeCodexSignIn('bx_aaaaaaaa');
			assert.ok(!existsSync(path.join(home, file)), `${file} goes once the folder is writable again`);
		}
	} finally {
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	}
});
