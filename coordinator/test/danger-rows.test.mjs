import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachHits, foldHits, keepDangerFiles, readDangerRows, watchDirs } from '../../scripts/quality/lib/danger-rows.mjs';
import { finishRun } from '../../scripts/quality/lib/fixture-run.mjs';
import { stopReplayServer, watchArgs } from '../../scripts/quality/watch-replay.mjs';

const T0 = 1_795_000_000_000;
// Rows shaped as DangerLog writes them (schema 1).
const hit = (atMs, attacker, taken, extra = {}) => ({ type: 'damage', schema: 1, agentId: 'a1', atMs, gameTime: atMs / 50, kind: 'melee', damageType: attacker ? 'minecraft:mob_attack' : 'minecraft:lava',
	attacker, attackerId: attacker ? `${attacker}-1` : null, amount: taken, taken, blocked: false, lethal: false, ...extra });
const lines = rows => rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n';

test('hits fold by attacker in a time window; blocked and lethal hits are counted apart', () => {
	const rows = [hit(T0 + 1_000, 'minecraft:zombie', 3), hit(T0 + 2_000, 'minecraft:zombie', 2.5), hit(T0 + 3_000, 'minecraft:skeleton', 0, { blocked: true }),
		hit(T0 + 4_000, null, 4), hit(T0 + 5_000, 'minecraft:zombie', null, { amount: 6, lethal: true }), hit(T0 + 90_000, 'minecraft:creeper', 15)];
	const folded = foldHits(rows, { from: T0, to: T0 + 60_000 });
	assert.deepEqual({ hits: folded.hits, taken: folded.taken, blocked: folded.blocked, lethal: folded.lethal, lethalAmount: folded.lethalAmount, agents: folded.agents },
		{ hits: 5, taken: 9.5, blocked: 1, lethal: 1, lethalAmount: 6, agents: 1 });
	assert.deepEqual(folded.byAttacker['minecraft:zombie'], { hits: 3, taken: 5.5, blocked: 0, lethal: 1, lethalAmount: 6 });
	assert.equal(folded.byAttacker['minecraft:skeleton'].blocked, 1);
	assert.equal(folded.byAttacker['minecraft:lava'].taken, 4, 'no attacker: the damage type names the hit');
	assert.equal(folded.byAttacker['minecraft:creeper'], undefined, 'outside the window');
});

test('danger files are found under a room folder, a cut line or another schema is dropped, and a kept copy counts once', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'danger-rows-'));
	try {
		const server = path.join(out, 'seed-7', 'server', 'arena-watch');
		await mkdir(server, { recursive: true });
		await mkdir(path.join(out, 'seed-7', 'server', 'world', 'arena-watch'), { recursive: true });
		await writeFile(path.join(server, 'a1-danger.jsonl'), lines([hit(T0 + 1_000, 'minecraft:zombie', 3), { type: 'onset', schema: 1, agentId: 'a1', atMs: T0 }, { ...hit(T0 + 1_500, 'minecraft:zombie', 1), schema: 2 }, '{"type":"damage","sch']));
		// The copy boot() keeps beside the server: the same rows.
		assert.equal(await keepDangerFiles(server, path.join(out, 'seed-7', 'arena-watch')), 1);
		assert.deepEqual((await watchDirs(out)).map(dir => path.relative(out, dir)), [path.join('seed-7', 'arena-watch'), path.join('seed-7', 'server', 'arena-watch')]);
		const read = await readDangerRows(out);
		assert.equal(read.files, 2);
		assert.equal(read.rows.length, 1, 'the kept copy and the onset row add nothing');
		assert.equal(read.dropped, 4, 'two cut lines and two rows of another schema, one of each per copy');
		assert.equal(await keepDangerFiles(path.join(out, 'nowhere'), path.join(out, 'kept')), 0);
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('finishRun gives each row the hits of its own window, and a room without the watch gets no hits at all', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'danger-finish-'));
	try {
		const rows = [{ name: 'a', pass: true, startedAt: T0, finishedAt: T0 + 10_000, deaths: 0, damageTaken: 5.5 },
			{ name: 'b', pass: false, startedAt: T0 + 20_000, finishedAt: T0 + 30_000, deaths: 1, damageTaken: 20 },
			{ name: 'c', pass: true, startedAt: 3, finishedAt: 4 }, { name: 'd', pass: true, startedAt: T0, finishedAt: T0 + 1, hits: { own: true } }];
		await finishRun(rows, { file: path.join(out, 'result.json'), setExitCode: false });
		assert.equal(rows[0].hits, undefined, 'no danger file: unknown, not zero');
		const dir = path.join(out, 'arena-watch');
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, 'a1-danger.jsonl'), lines([hit(T0 + 1_000, 'minecraft:zombie', 3), hit(T0 + 2_000, 'minecraft:zombie', 2.5), hit(T0 + 25_000, 'minecraft:skeleton', 4)]));
		await finishRun(rows, { file: path.join(out, 'result.json'), setExitCode: false });
		assert.equal(rows[0].hits.hits, 2);
		assert.equal(rows[0].hits.taken, rows[0].damageTaken, 'the hits add up to the damage the room counted');
		assert.deepEqual(Object.keys(rows[1].hits.byAttacker), ['minecraft:skeleton']);
		assert.equal(rows[2].hits, undefined, 'a row without epoch times gets none');
		assert.deepEqual(rows[3].hits, { own: true }, 'a fixture\'s own hits are kept');
		// More rows written later (the server was still up) are picked up on the next report.
		await writeFile(path.join(dir, 'a1-danger.jsonl'), lines([hit(T0 + 1_000, 'minecraft:zombie', 3), hit(T0 + 2_000, 'minecraft:zombie', 2.5), hit(T0 + 9_000, 'minecraft:spider', 1), hit(T0 + 25_000, 'minecraft:skeleton', 4)]));
		const written = JSON.parse(await readFile(path.join(out, 'result.json'), 'utf8'));
		assert.equal(written[0].hits.hits, 2);
		await finishRun(rows, { file: path.join(out, 'result.json'), setExitCode: false });
		assert.equal(rows[0].hits.hits, 3);
		assert.equal((await attachHits([{ startedAt: T0, finishedAt: T0 + 5 }], path.join(out, 'nothing'))).files, 0);
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('fixture servers run with the Watcher on unless FIXTURE_WATCH turns it off', () => {
	assert.deepEqual(watchArgs(undefined), ['-Dmineagen.watch=true']);
	assert.deepEqual(watchArgs('1'), ['-Dmineagen.watch=true']);
	for (const off of ['0', 'false', 'OFF', ' off ']) assert.deepEqual(watchArgs(off), []);
});

test('a row counts only its own body, never parallel lanes\' hits, and room setup damage is set apart', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'danger-lanes-'));
	try {
		const dir = path.join(out, 'seed-1', 'arena-watch');
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, 'a1-danger.jsonl'), lines([hit(T0 + 1_000, null, 13, { damageType: 'minecraft:generic', kind: 'other' }), hit(T0 + 2_000, 'minecraft:zombie', 3)]));
		await writeFile(path.join(dir, 'a2-danger.jsonl'), lines([hit(T0 + 3_000, null, 8, { agentId: 'a2', damageType: 'minecraft:lava', kind: 'block' })]));
		const rows = [{ name: 'lane0', agentId: 'a1', pass: true, startedAt: T0, finishedAt: T0 + 10_000 }, { name: 'lane1', agentId: 'a2', pass: true, startedAt: T0, finishedAt: T0 + 10_000 },
			{ name: 'nameless', pass: true, startedAt: T0, finishedAt: T0 + 10_000 }, { name: 'late', agentId: 'a1', pass: true, startedAt: T0, hitsFrom: T0 + 2_500, finishedAt: T0 + 10_000 }];
		await finishRun(rows, { file: path.join(out, 'result.json'), setExitCode: false });
		assert.deepEqual(Object.keys(rows[0].hits.byAttacker), ['minecraft:zombie'], 'lane 0 never gets lane 1\'s lava');
		assert.equal(rows[0].hits.taken, 3);
		assert.equal(rows[0].hits.commandDamage, 13, 'the room\'s own /damage is setup, not a hit');
		assert.deepEqual(Object.keys(rows[1].hits.byAttacker), ['minecraft:lava']);
		assert.equal(rows[2].hits, undefined, 'two bodies hit and the row names none: unknown');
		assert.match(rows[2].hitsUnknown, /2 bodies were watched/);
		// One lane never hit: its file is there, empty, and a nameless row still cannot claim the other lane's hits.
		const quiet = await mkdtemp(path.join(os.tmpdir(), 'danger-quiet-'));
		try {
			await mkdir(path.join(quiet, 'arena-watch'), { recursive: true });
			await writeFile(path.join(quiet, 'arena-watch', 'a1-danger.jsonl'), lines([hit(T0 + 1_000, 'minecraft:zombie', 3)]));
			await writeFile(path.join(quiet, 'arena-watch', 'b2-danger.jsonl'), '');
			const lanes = [{ name: 'l0', startedAt: T0, finishedAt: T0 + 5_000 }, { name: 'l1', startedAt: T0, finishedAt: T0 + 5_000 }];
			await finishRun(lanes, { file: path.join(quiet, 'result.json'), setExitCode: false });
			assert.deepEqual(lanes.map(lane => lane.hits), [undefined, undefined]);
		} finally { await rm(quiet, { recursive: true, force: true }); }
		// One body per server, several servers (travel boots one per seed): nameless rows still get their hits.
		const seeds = await mkdtemp(path.join(os.tmpdir(), 'danger-seeds-'));
		try {
			for (const [seed, agent, at] of [['seed-1', 'a1', T0 + 1_000], ['seed-2', 'b2', T0 + 20_000]]) {
				await mkdir(path.join(seeds, seed, 'server', 'arena-watch'), { recursive: true });
				await writeFile(path.join(seeds, seed, 'server', 'arena-watch', `${agent}-danger.jsonl`), lines([hit(at, 'minecraft:zombie', 2, { agentId: agent })]));
				await keepDangerFiles(path.join(seeds, seed, 'server', 'arena-watch'), path.join(seeds, seed, 'arena-watch'));
			}
			const courses = [{ name: 'c1', startedAt: T0, finishedAt: T0 + 10_000 }, { name: 'c2', startedAt: T0 + 15_000, finishedAt: T0 + 25_000 }];
			await finishRun(courses, { file: path.join(seeds, 'result.json'), setExitCode: false });
			assert.deepEqual(courses.map(course => course.hits?.hits), [1, 1]);
		} finally { await rm(seeds, { recursive: true, force: true }); }
		// Setup damage is not a hit: a body that only took the room's /damage is not counted among the bodies hit.
		assert.equal(foldHits([hit(T0, null, 13, { damageType: 'minecraft:generic' })]).agents, 0);
		assert.equal(rows[3].hits.hits, 0, 'hitsFrom starts the window after setup');
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('stopping a fixture server keeps its danger files beside the world it will delete', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'danger-stop-'));
	try {
		const from = path.join(out, 'server', 'arena-watch');
		await mkdir(from, { recursive: true });
		await writeFile(path.join(from, 'a1-danger.jsonl'), lines([hit(T0, 'minecraft:zombie', 2)]));
		await writeFile(path.join(from, 'a1-progress.jsonl'), '{}\n');
		// A server that has already exited: stop only closes the log and keeps the rows.
		await stopReplayServer({ child: { exitCode: 0, signalCode: null }, log: { close: async () => {} }, watchFrom: from, watchTo: path.join(out, 'arena-watch') });
		assert.equal(await readFile(path.join(out, 'arena-watch', 'a1-danger.jsonl'), 'utf8'), lines([hit(T0, 'minecraft:zombie', 2)]));
		await assert.rejects(readFile(path.join(out, 'arena-watch', 'a1-progress.jsonl')), /ENOENT/, 'only the danger rows are copied');
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('a danger file that cannot be read leaves hits unknown, never zero', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
	const { chmod } = await import('node:fs/promises');
	const out = await mkdtemp(path.join(os.tmpdir(), 'danger-unreadable-'));
	try {
		await mkdir(path.join(out, 'arena-watch'), { recursive: true });
		const file = path.join(out, 'arena-watch', 'a1-danger.jsonl');
		await writeFile(file, lines([hit(T0 + 1_000, 'minecraft:zombie', 3)]));
		await chmod(file, 0o000);
		const rows = [{ name: 'a', startedAt: T0, finishedAt: T0 + 5_000 }];
		await finishRun(rows, { file: path.join(out, 'result.json'), setExitCode: false });
		assert.equal(rows[0].hits, undefined);
		assert.match(rows[0].hitsUnknown, /1 danger file could not be read/);
		await chmod(file, 0o644);
	} finally { await rm(out, { recursive: true, force: true }); }
});
