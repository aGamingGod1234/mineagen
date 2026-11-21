import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { aiRoomCommands, selectAiRooms } from '../../scripts/quality/lib/ai-room-lines.mjs';
import { parseCommands } from '../../scripts/quality/lib/room-batch-core.mjs';
import { roomVerdict } from '../../scripts/quality/lib/fixture-run.mjs';
import { aiRoomRow, aiRoomLadderArgs, copyArtifacts, prepareCodex, signInChanged } from '../../scripts/quality/run-ai-room.mjs';
import { compareArms, formatComparison } from '../../scripts/quality/ai-room-report.mjs';
import { parseLadderArgs } from '../../scripts/quality/run-ladder.mjs';

const room = (name, extra = {}) => ({ id: name.toUpperCase(), name, seed: '1', goal: 'g', durationBudgetMs: 600000, setup: {}, successCheck: 'survive_duration: 0 ticks',
	aiRoom: { standIn: `BUILD_ONLY=${name} node scripts/quality/test-build-live.mjs scripts/quality/build-spots.json $OUT $JAR --descriptive`, ...extra } });

test('AI room lines pair each repeat of a room with its script stand-in on the same machine', () => {
	const text = aiRoomCommands({ scenarios: [room('ai-a'), room('ai-b')], roomsPath: '/x/rooms.json', repeats: 2, authFile: '/x/auth.json' });
	const rooms = parseCommands(text, ['ai', 'script']);
	assert.deepEqual(rooms.map(r => r.room), ['ai-a-r1', 'ai-a-r2', 'ai-b-r1', 'ai-b-r2']);
	const [ai, script] = rooms[0].lines;
	assert.equal(ai.arm, 'ai');
	assert.equal(ai.env.CODEX_AUTH_FILE, '/x/auth.json');
	assert.deepEqual(ai.args, ['scripts/quality/run-ai-room.mjs', '/x/rooms.json', 'AI-A', '$OUT', '$JAR', '--descriptive']);
	assert.deepEqual([script.arm, script.env.BUILD_ONLY, script.args[0]], ['script', 'ai-a', 'scripts/quality/test-build-live.mjs']);
	const solo = parseCommands(aiRoomCommands({ scenarios: [room('ai-a')], roomsPath: '/x/rooms.json', script: false, authFile: '/x/auth.json' }), ['ai']);
	assert.equal(solo[0].lines.length, 1);
});

test('AI room lines refuse a raised tick rate, a missing sign-in and unknown rooms', () => {
	assert.throws(() => aiRoomCommands({ scenarios: [room('ai-a')], roomsPath: '/r', authFile: null }), /sign-in/);
	const fast = room('ai-a'); fast.aiRoom.standIn = `FIXTURE_TICK_RATE=60 ${fast.aiRoom.standIn}`;
	assert.throws(() => aiRoomCommands({ scenarios: [fast], roomsPath: '/r', authFile: '/a' }), /20 ticks/);
	assert.throws(() => selectAiRooms([room('ai-a')], 'ai-z'), /no AI room ai-z/);
	assert.deepEqual(selectAiRooms([room('ai-a'), room('ai-b')], 'AI-B,ai-a').map(r => r.name), ['ai-b', 'ai-a']);
});

const measured = (metrics, evaluation = { status: 'EVALUATED', pass: true, source: 'samples', timeToPassMs: 120000 }) => ({ scenario: 'AI-A', profile: { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'low' },
	measurementStatus: 'MEASURED', termination: 'EVALUATOR_PASS', evaluation, metrics: { modelCalls: 12, deaths: 0, damageTaken: 0, playWallTimeMs: 150000, ...metrics } });
const times = { startedAt: 1, finishedAt: 2 };

test('an AI room passes only when the check held with no death, and no damage where the room asks for it', () => {
	assert.equal(roomVerdict(aiRoomRow(room('ai-a'), measured({}), times)).verdict, 'PASS');
	const row = aiRoomRow(room('ai-a'), measured({ deaths: 1 }), times);
	assert.deepEqual([roomVerdict(row).verdict, row.failReason], ['FAIL', 'died 1x']);
	assert.equal(roomVerdict(aiRoomRow(room('ai-a'), measured({ damageTaken: 3 }), times)).verdict, 'PASS');
	assert.equal(roomVerdict(aiRoomRow(room('ai-a', { pass: { noDamage: true } }), measured({ damageTaken: 3 }), times)).verdict, 'FAIL');
	const missed = aiRoomRow(room('ai-a'), measured({}, { status: 'EVALUATED', pass: false, source: 'samples' }), times);
	assert.equal(roomVerdict(missed).verdict, 'FAIL');
	assert.equal(aiRoomRow(room('ai-a'), measured({}), times).minutesToGoal, 2);
});

test('an AI room with no model call, a lost counter or an unmeasured run is INVALID, never a pass or a fail', () => {
	for (const [metrics, status, why] of [[{ modelCalls: 0 }, 'MEASURED', /no call/], [{ damageTaken: null }, 'MEASURED', /damage counter/], [{ deaths: undefined }, 'MEASURED', /death counter/], [{}, 'INCOMPLETE', /status INCOMPLETE/],
		[{ tokenReconciliation: { complete: false }, coverage: { jsonlDroppedLines: 2 } }, 'INCOMPLETE', /status INCOMPLETE/]]) {
		const row = aiRoomRow(room('ai-a'), { ...measured(metrics), measurementStatus: status }, times);
		const verdict = roomVerdict(row);
		assert.equal(verdict.verdict, 'INVALID');
		assert.match(verdict.reason, why);
	}
});

test('an early-stopped AI room whose only gap is token bookkeeping stays valid', () => {
	const row = aiRoomRow(room('ai-a'), { ...measured({ tokenReconciliation: { complete: false } }), measurementStatus: 'INCOMPLETE' }, times);
	assert.deepEqual([roomVerdict(row).verdict, row.tokensReconciled], ['PASS', false]);
	const lost = aiRoomRow(room('ai-a'), { ...measured({ tokenReconciliation: { complete: false } }), measurementStatus: 'INCOMPLETE', observerErrors: ['RCON closed'] }, times);
	assert.equal(roomVerdict(lost).verdict, 'INVALID');
});

test('an AI room plays through the ladder runner with Codex on the slot ports', () => {
	const args = aiRoomLadderArgs({ rooms: '/r.json', id: 'AI-A', out: '/o', jar: '/j.jar', env: { SLOT_PORT_BASE: '28100', JAVA_HOME: '/jdk', ARENA_HEADLESS_SERVER_TEMPLATE: '/t' } });
	const options = parseLadderArgs(args);
	assert.deepEqual([options.provider, options.model, options.effort, options.serviceTier, options.portBase, options.runs, options.earlyStop], ['codex', 'gpt-6.2-sol', 'low', 'default', 28100, 1, true]);
	assert.deepEqual(options.scenarios, ['AI-A']);
	assert.equal(options.out, path.resolve('/o/ladder'));
});

test('the sign-in goes into a private Codex home for the run and is gone after it', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-room-test-'));
	try {
		const auth = path.join(dir, 'auth.json');
		await writeFile(auth, '{"tokens":"x"}');
		const env = { CODEX_AUTH_FILE: auth, OPENAI_API_KEY: 'k', PATH: '/usr/bin' }, calls = [];
		const exec = (cmd, args) => { calls.push([cmd, ...args].join(' ')); if (cmd === 'codex') return 'codex-cli 0.171.0\n'; throw new Error('unexpected'); };
		const codex = await prepareCodex(env, { exec });
		assert.equal(codex.cli, 'codex-cli 0.171.0');
		assert.deepEqual(calls, ['codex --version']);
		assert.equal(await readFile(path.join(env.CODEX_HOME, 'auth.json'), 'utf8'), '{"tokens":"x"}');
		assert.equal((await stat(env.CODEX_HOME)).mode & 0o777, 0o700);
		assert.equal(env.OPENAI_API_KEY, undefined);
		await codex.cleanup();
		await assert.rejects(stat(env.CODEX_HOME));
		// No CLI on the machine: the pinned one is installed under ~/.local first.
		let installed = false;
		const bare = (cmd, args) => { if (cmd === 'npm') { installed = true; assert.match(args.join(' '), /@openai\/codex@0\.171\.0/); return ''; } if (installed) return 'codex-cli 0.171.0'; throw new Error('not found'); };
		assert.equal((await prepareCodex({ PATH: '' }, { exec: bare })).cli, 'codex-cli 0.171.0');
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the report sets the model beside the script per room and keeps invalid runs out of the rates', () => {
	const ai = [aiRoomRow(room('ai-a'), measured({}), times), aiRoomRow(room('ai-a'), measured({ deaths: 1, damageTaken: 20 }), times), aiRoomRow(room('ai-a'), measured({ modelCalls: 0 }), times)]
		.map((row, i) => ({ ...row, room: `ai-a-r${i + 1}` }));
	const script = [1, 2, 3].map(r => ({ name: 'portal', room: `ai-a-r${r}`, pass: r !== 3, deaths: 0, damageTaken: 0, startedAt: 1, finishedAt: 2 }));
	const done = Object.fromEntries([1, 2, 3].map(r => [`ai-a-r${r}`, { arms: { script: { seconds: 120 }, ai: { seconds: 300 } } }]));
	const [a] = compareArms({ arms: { ai, script }, done });
	assert.deepEqual([a.arms.ai.passed, a.arms.ai.valid, a.arms.ai.invalid, a.arms.ai.deaths, a.arms.ai.damage], [1, 2, 1, 1, 20]);
	assert.deepEqual([a.arms.script.passed, a.arms.script.valid, a.arms.script.medianMinutes], [2, 3, 2]);
	assert.equal(a.arms.ai.medianMinutes, 2.5);
	const text = formatComparison([a], ['ai', 'script']);
	assert.match(text, /\| ai-a \| 1\/2 \(\+1 invalid\) \| 1 \| 20 \| 2\.5 \| 2\/3 \| 0 \| 0 \| 2 \| 12 \|/);
	assert.match(text, /ai ai-a-r3: missing evidence: provider the model made no call/);
});

test('a room keeps its logs but never the world, the Codex workspace or the RCON password', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-room-art-'));
	try {
		const run = path.join(dir, 'run');
		for (const sub of ['server/world', 'provider-workspaces/minecraft-agent/.codex-home', 'traces']) await mkdir(path.join(run, sub), { recursive: true });
		await writeFile(path.join(run, 'provider-workspaces/minecraft-agent/.codex-home/auth.json'), 'secret');
		await writeFile(path.join(run, 'rcon-password.txt'), 'pw');
		await writeFile(path.join(run, 'coordinator.jsonl'), '{}');
		await writeFile(path.join(run, 'traces/dynamic.stderr.log'), 'log');
		await copyArtifacts(run, path.join(dir, 'out'));
		assert.deepEqual((await readdir(path.join(dir, 'out'))).sort(), ['coordinator.jsonl', 'traces']);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a sign-in Codex rewrote during the room is caught by its hash', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-room-hash-'));
	try {
		const auth = path.join(dir, 'auth.json');
		await writeFile(auth, '{"t":1}');
		const codex = await prepareCodex({ CODEX_AUTH_FILE: auth, PATH: '' }, { exec: () => 'codex-cli 0.171.0' });
		const copy = path.join(codex.home, 'auth.json');
		assert.equal(await signInChanged(codex.sentHash, [copy, path.join(dir, 'missing.json')]), null);
		await writeFile(copy, '{"t":2}');
		assert.equal(await signInChanged(codex.sentHash, [copy]), copy);
		await codex.cleanup();
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the report reads the drawn-bow and travel stand-ins in their own formats', async () => {
	const { readArmRows } = await import('../../scripts/quality/ai-room-report.mjs');
	const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-room-standin-'));
	try {
		await writeFile(path.join(dir, 'acceptance.json'), JSON.stringify([{ pass: true, startedAt: 0, finishedAt: 90000 }]));
		await writeFile(path.join(dir, 'results.json'), JSON.stringify({ drawnBow: { arms: { drawn: { taken: 40 }, arrowOnly: { taken: 110 } } } }));
		assert.deepEqual((await readArmRows(dir)).map(r => [r.pass, r.deaths, r.damageTaken, r.minutes]), [[true, 0, 4, 1.5]]);
		await rm(path.join(dir, 'acceptance.json'));
		await writeFile(path.join(dir, 'results.json'), JSON.stringify({ results: [{ id: 'ow-east200', arrived: false, deaths: 0, damage: 2, wallSeconds: 300, blocksMined: 86 }, { id: 'x', error: 'boom\nstack' }] }));
		const rows = await readArmRows(dir);
		assert.deepEqual(rows.map(r => [r.pass, r.damageTaken, r.minutes, r.blocksMined ?? null, r.error ?? null]), [[false, 2, 5, 86, null], [false, undefined, undefined, null, 'boom']]);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
