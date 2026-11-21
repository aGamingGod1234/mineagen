import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { terminalCounter, finishRun, fixtureSummary } from '../../scripts/quality/lib/fixture-run.mjs';
import { damageCounter, damageEvidence, replyNumber, deathCounter, deathEvidence, matchesDamageExpectation, statCounter, shieldShareVerdict } from '../../scripts/quality/lib/damage-counter.mjs';

test('a healed hit remains damage, and missing or reset counters cannot prove safety', async () => {
	assert.deepEqual(damageEvidence(10, 40, 20, 20), { damageTaken: 3, netHealthChange: 0 });
	for (const [before, after] of [[null, 40], [10, null], [40, 10]]) {
		const row = damageEvidence(before, after, 20, 20);
		assert.equal(row.damageTaken, null);
		assert.equal(row.integrity.length, 1);
	}
	const commands = [], replies = ['created', 'Probe has 40 [arena_damage]', 'No score for Probe is set (none is set)', 'unknown objective'];
	const read = await damageCounter(async text => { commands.push(text); return replies.shift(); }, 'Probe');
	assert.equal(await read(), 40);
	assert.equal(await read(), 0);
	assert.equal(await read(), null);
	assert.match(commands[0], /minecraft.custom:minecraft.damage_taken/);
});

test('review of PR #197: command replies read with their NBT suffix, so Air (a short) and a scoreboard count are numbers', () => {
	assert.equal(replyNumber('Probe has the following entity data: 300s'), 300);
	assert.equal(replyNumber('Probe has the following entity data: 0s'), 0);
	assert.equal(replyNumber('Probe has the following entity data: -20s'), -20);
	assert.equal(replyNumber('Probe has the following entity data: 20.0f'), 20);
	assert.equal(replyNumber('Probe has 2 [deaths]'), 2);
	assert.ok(Number.isNaN(replyNumber('No entity was found')));
	assert.ok(Number.isNaN(replyNumber("Can't get value of deaths for Probe; none is set")));
});

test('deliberate fall damage must match its declared HP exactly, including healed hits', async () => {
	const fixtures = JSON.parse(await readFile(new URL('../../scripts/quality/d41-dig-fixtures.json', import.meta.url), 'utf8'));
	const expected = fixtures.find(spot => spot.name === 'stairs-drop4-default').expectDamageTaken;
	assert.equal(expected, 1, 'default four-block descent deliberately costs one HP');
	const healedFall = { ...damageEvidence(0, 10, 20, 20), healthLost: 0 };
	assert.equal(matchesDamageExpectation(healedFall), false, 'ordinary fixtures still reject a healed hit');
	assert.equal(matchesDamageExpectation(healedFall, expected), true);
	for (const damageTaken of [0, 0.5, 1.1, 2, null, NaN]) {
		assert.equal(matchesDamageExpectation({ damageTaken, healthLost: 0 }, expected), false);
	}
	assert.equal(matchesDamageExpectation({ damageTaken: 1, healthLost: 1 }, expected), true);
	assert.equal(matchesDamageExpectation({ damageTaken: 1, healthLost: 2 }, expected), false);
	for (const invalid of [null, -1, '1', Infinity]) assert.throws(() => matchesDamageExpectation(healedFall, invalid), /finite nonnegative/);
});

test('terminal counts ignore observation echoes, deduplicate receipts, and retain conflicts', () => {
	const counter = terminalCounter();
	const result = { type: 'action_result', agentId: 'a', payload: { actionId: 'one', goalRevision: 1, state: 'FAILED', reasonCode: 'WATER_AHEAD' } };
	counter.accept(result);
	for (let i = 0; i < 199; i++) counter.accept({ type: 'observation', payload: { lastResult: result.payload } });
	counter.accept({ envelope: result });
	counter.accept({ ...result, payload: { ...result.payload, reasonCode: 'OTHER' } });
	assert.deepEqual(counter.snapshot(), { terminalResults: 1, byReason: { WATER_AHEAD: 1 }, duplicates: 2, missingActionIds: 0, conflicts: 1, refused: 0 });
});

test('planned and cancelled-before-start cases never inflate completed or started counts', () => {
	const summary = fixtureSummary([{ startedAt: 1, finishedAt: 2, pass: true }, { cancelledBeforeStart: true }], { planned: 4 });
	assert.equal(summary.planned, 4);
	assert.equal(summary.started, 1);
	assert.equal(summary.completed, 1);
	assert.equal(summary.cancelledBeforeStart, 1);
	assert.equal(summary.notStarted, 2);
	assert.equal(summary.status, 'INVALID');
});

test('strict fixture reports preserve rows and expose real command exit codes', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'fixture-finish-'));
	try {
		const file = path.join(dir, 'result.json');
		const report = await finishRun([{ startedAt: 1, finishedAt: 2, pass: false }], { file, setExitCode: false });
		assert.equal(report.exitCode, 1);
		assert.equal(JSON.parse(await readFile(file))[0].pass, false);
		assert.equal(JSON.parse(await readFile(path.join(dir, 'result-summary.json'))).status, 'FAIL');
		for (const [row, code] of [[{ pass: true }, 0], [{ pass: false }, 1], [{ error: 'bad evidence' }, 2]]) {
			const script = `import {finishRun} from ${JSON.stringify(new URL('../../scripts/quality/lib/fixture-run.mjs', import.meta.url).href)}; await finishRun([${JSON.stringify(row)}]);`;
			assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', script]).status, code);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('production incident help and invalid setup finish without Java or a live slot', () => {
	const script = fileURLToPath(new URL('../../scripts/quality/run-incident.mjs', import.meta.url));
	const env = { ...process.env, JAVA_HOME: '', ARENA_HEADLESS_SERVER_TEMPLATE: '', SLOT_PORT_BASE: '' };
	const help = spawnSync(process.execPath, [script, '--help'], { env, encoding: 'utf8', timeout: 10000 });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /production coordinator/);
	const invalid = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 10000 });
	assert.equal(invalid.status, 2, invalid.stderr);
	assert.match(invalid.stderr, /live slot are required/);
});


test('death scoring requires real initialized baseline and final counters, never healthy synthetic zero', async () => {
	for (const reply of ['none is set', 'No entity was found', '', 'Probe has 0 [deaths]', '20.0f']) {
		const count = await deathCounter(async () => reply, 'Probe');
		assert.equal(count, null);
		for (const [before, after] of [[count, 0], [0, count], [count, count]]) {
			const evidence = deathEvidence(before, after);
			assert.equal(evidence.deaths, null);
			assert.equal(evidence.valid, false);
			assert.equal(fixtureSummary([{ pass: false, integrity: [{ file: 'qo_death' }] }]).status, 'INVALID');
		}
	}
	assert.equal(await deathCounter(async () => 'Probe has 0 [qo_death]', 'Probe'), 0);
	assert.deepEqual(deathEvidence(2, 2), { before: 2, after: 2, valid: true, deaths: 0 });
	assert.equal(deathEvidence(2, 3).deaths, 1);
	assert.equal(deathEvidence(3, 2).valid, false);
});

test('review of PR #30: an unreadable shield or damage counter is invalid evidence, never a zero that passes', async () => {
	const replies = ['created', 'Reflex has 40 [blk]', 'Reflex has 0 [blk]', 'No score for Reflex is set (none is set)', 'unknown objective', 'Reflex has 7 [other]'];
	const read = await statCounter(async () => replies.shift(), 'Reflex', 'blk', 'minecraft.custom:minecraft.damage_blocked_by_shield');
	assert.equal(await read(), 40);
	assert.equal(await read(), 0);
	assert.equal(await read(), 0);
	assert.equal(await read(), null);
	assert.equal(await read(), null);
	const arrowOnly = { arm: 'arrowOnly', repeat: 0, distance: 4, blocked0: 0, blocked1: 10, taken0: 0, taken1: 30 };
	const unreadableDamage = shieldShareVerdict([arrowOnly, { arm: 'drawn', repeat: 0, distance: 4, blocked0: 0, blocked1: 40, taken0: null, taken1: null }], 0.8);
	assert.equal(unreadableDamage.pass, false);
	assert.equal(unreadableDamage.shareDrawn, null);
	assert.equal(unreadableDamage.integrity.length, 1);
	assert.equal(unreadableDamage.arms.drawn.cases[0].taken, null);
	const readable = shieldShareVerdict([arrowOnly, { arm: 'drawn', repeat: 0, distance: 4, blocked0: 5, blocked1: 45, taken0: 30, taken1: 35 }], 0.8);
	assert.deepEqual([readable.pass, readable.shareArrowOnly, readable.shareDrawn, readable.integrity], [true, 0.25, 40 / 45, undefined]);
});

test('review of PR #30: an arm that took no arrow damage is unmeasured, so the drawn arm cannot pass against it', () => {
	const idle = { arm: 'arrowOnly', repeat: 0, distance: 10, blocked0: 0, blocked1: 0, taken0: 0, taken1: 0 };
	const unexercised = shieldShareVerdict([idle, { arm: 'drawn', repeat: 0, distance: 10, blocked0: 0, blocked1: 40, taken0: 0, taken1: 0 }], 0.8);
	assert.equal(unexercised.pass, false);
	assert.equal(unexercised.shareArrowOnly, null);
	assert.deepEqual(unexercised.integrity.map(row => row.arm), ['arrowOnly']);
	const idleDrawn = shieldShareVerdict([{ ...idle, blocked1: 10, taken1: 30 }, { ...idle, arm: 'drawn' }], 0.8);
	assert.deepEqual([idleDrawn.pass, idleDrawn.integrity.map(row => row.arm)], [false, ['drawn']]);
});
