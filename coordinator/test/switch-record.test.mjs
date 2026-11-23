import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { coordinatorSwitches, mergeSwitchRecords, serverSwitchLines, switchRecord } from '../../scripts/quality/lib/switch-record.mjs';
import { finishRun } from '../../scripts/quality/lib/fixture-run.mjs';
import { mergeArms } from '../../scripts/quality/lib/room-batch-core.mjs';
import { logSwitches } from '../src/dynamic-main.mjs';

const SERVER = 'switches instincts=off travel.walkAround=off fight.chargeGuard=on fight.recover=off@property fight.spawnerHold=on fight.spawnerHoldOpen=on fight.forestHunt=off fight.skipUnreachable=on killPosition=on watch=on@property';

async function scratch(t) {
	const dir = await mkdtemp(path.join(tmpdir(), 'switch-record-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test('the coordinator half resolves the environment, and a refused value is recorded, not thrown', () => {
	const ok = coordinatorSwitches({ MINEAGEN_CAVE_FIRST: 'on' });
	assert.match(ok.line, /^switches find\.caveFirst=on@env /);
	assert.deepEqual(ok.record['find.caveFirst'], { value: true, source: 'env' });
	assert.deepEqual(coordinatorSwitches({ MINEAGEN_EXPERIENCE: 'maybe' }), { error: 'MINEAGEN_EXPERIENCE must be one of off, lessons' });
});

test('the server half is the line the mod logged at start, read from any server log under the run folder', async (t) => {
	const dir = await scratch(t);
	await mkdir(path.join(dir, 'spot-13', 'logs'), { recursive: true });
	await writeFile(path.join(dir, 'spot-13', 'server.log'), `[08:01:02] [Server thread/INFO]: Starting\n[08:01:09] [Server thread/INFO]: [mineagen] ${SERVER}\r\n[08:02:00] [Server thread/INFO]: [mineagen] ${SERVER}\n`);
	await writeFile(path.join(dir, 'spot-13', 'logs', 'latest.log'), `[08:03:00] [Server thread/INFO]: [mineagen] ${SERVER.replace('watch=on@property', 'watch=off')}\n`);
	await writeFile(path.join(dir, 'r1.log'), `[mineagen] switches not=a-server-log\n`);
	assert.deepEqual(await serverSwitchLines(dir), [SERVER, SERVER.replace('watch=on@property', 'watch=off')]);
	assert.deepEqual(await serverSwitchLines(path.join(dir, 'missing')), []);
	const record = await switchRecord(dir, {});
	assert.equal(record.server.length, 2);
	assert.match(record.coordinator.line, /^switches find\.caveFirst=off /);
});

test('finishRun writes the switch set into the summary; a merge passes its own', async (t) => {
	const dir = await scratch(t);
	await writeFile(path.join(dir, 'server.log'), `[mineagen] ${SERVER}\n`);
	const rows = [{ name: 'a', pass: true, startedAt: 1, finishedAt: 2, deaths: 0, damageTaken: 0 }];
	const summary = await finishRun(rows, { file: path.join(dir, 'result.json'), strict: false, setExitCode: false, hits: false });
	assert.deepEqual(summary.switches.server, [SERVER]);
	const written = JSON.parse(await readFile(path.join(dir, 'result-summary.json'), 'utf8'));
	assert.deepEqual(written.switches, summary.switches);
	const given = { coordinator: ['switches x=on'], server: [], unrecorded: 0 };
	assert.deepEqual((await finishRun(rows, { file: path.join(dir, 'b.json'), strict: false, setExitCode: false, hits: false, switches: given })).switches, given);
});

test('an arm merged from its rooms carries the rooms\' switch lines, never the merging machine\'s environment', async (t) => {
	const out = await scratch(t);
	const one = { coordinator: { line: 'switches instincts=on@env', record: {} }, server: [SERVER] };
	const two = { coordinator: { line: 'switches instincts=on@env', record: {} }, server: [SERVER.replace('instincts=off', 'instincts=on@env')] };
	for (const [room, switches] of [['r-a', one], ['r-b', two]]) {
		const dir = path.join(out, 'rooms', room, 'on');
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, 'result.json'), JSON.stringify([{ name: room, pass: true, startedAt: 1, finishedAt: 2, deaths: 0, damageTaken: 0 }]));
		await writeFile(path.join(dir, 'result-summary.json'), JSON.stringify({ status: 'PASS', planned: 1, switches }));
	}
	const rooms = ['r-a', 'r-b', 'r-lost'].map((room) => ({ room, lines: [], planned: 1 }));
	const outcomes = [{ room: 'r-a', arms: { on: { exit: 0 } } }, { room: 'r-b', arms: { on: { exit: 0 } } }, { room: 'r-lost', lost: true, reason: 'test' }];
	const merged = await mergeArms({ out, rooms, arms: ['on'], outcomes });
	assert.deepEqual(merged.on.summary.switches, { coordinator: ['switches instincts=on@env'], server: [SERVER, SERVER.replace('instincts=off', 'instincts=on@env')], unrecorded: 0 });
	assert.deepEqual(mergeSwitchRecords([null, merged.on.summary.switches]).unrecorded, 1);
});

test('the coordinator logs its switch line at start, and an unreadable set without stopping', () => {
	const said = [];
	const written = [];
	const switches = logSwitches({ MINEAGEN_KIT_HABIT: 'off' }, { write: (event, fields) => written.push([event, fields]) }, (text) => said.push(text));
	assert.match(said[0], /^\[coordinator\] switches .*kit\.habit=off@env /);
	assert.equal(written[0][0], 'switches');
	assert.equal(written[0][1].line, switches.line);
	assert.equal(logSwitches({ MINEAGEN_EXPERIENCE: 'maybe' }, null, (text) => said.push(text)), null);
	assert.equal(said[1], '[coordinator] switches unreadable: MINEAGEN_EXPERIENCE must be one of off, lessons');
});
