// Provider-free travel-out-of-water check: node scripts/quality/test-water-live.mjs OUT_DIR JAR [runs]
// One fresh server (seed 1) per JAR. Each trial builds a fixture on untouched land and calls travel_to toward dry land:
//   lake   the body at the bottom of a 15x15, 5-deep pool (stone floor), target 20 blocks east of its centre.
//   stair  the body at the bottom of an 8-step staircase cut into a stone block and flooded, target 12 blocks west of the top.
//   widelake  a 37x21 pool; the body at the bottom near the west bank, the target just past the east bank (the field case).
//   roofed  the body at the bottom of a 6-deep pit open to the sky, its air run down to about 4 s; a roofed, flooded
//           passage leads 7 blocks east to a dry chamber whose floor is level with the body (the low bank). Target east.
//   waterfall  the body afloat in a walled pool whose east edge spills into a 25-block waterfall; no bank to climb
//           within 10 blocks; the target past the fall. narrowfall: the same through a one-block gap (a one-wide fall).
// Reports per trial: state, reason, seconds, blocks left to the target, health lost, death. Launch under slot.sh live with
// ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME. No model call; the fixture is built with operator commands.
// A trial passes with no death and no health lost (after the call too, for detour); lake, stair, widelake and at: spots
// must also arrive (SUCCEEDED). roofed, detour, waterfall and narrowfall pass on a safe stop: the body rises to air or
// stops at the edge and hands the choice back. Exit code (strict, the default): 0 all passed, 1 a trial failed,
// 2 invalid evidence (a trial errored, health could not be read, or trials are missing). --descriptive reports only.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { boot } from './watch-replay.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';

const USAGE = 'Usage: test-water-live.mjs OUT_DIR JAR [runs] [fixture;fixture...] [seed] [--strict|--descriptive] under slot.sh live';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const [outArg, jarArg, runsArg, fixturesArg, seedArg] = cli.filter(arg => !['--strict', '--descriptive'].includes(arg));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !jarArg || !template || !port) { console.error(USAGE); process.exit(2); }
const runs = Number(runsArg ?? 3);
const fixtures = (fixturesArg ?? 'lake;stair;widelake').split(';');
const ARRIVE = new Set(['lake', 'stair', 'widelake']);
// A bridge error (state ERROR) means the harness lost the call: invalid evidence, not a failed trial.
const judge = (row) => {
	if (row.state === 'ERROR') row.error = `travel_to never returned: ${row.reasonCode}`;
	return !row.died && row.healthLost === 0 && (row.healthLostAfter ?? 0) === 0
		&& (ARRIVE.has(row.fixture) || row.fixture.startsWith('at:') ? row.state === 'SUCCEEDED' : true);
};
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
const sleep = ms => new Promise(done => setTimeout(done, ms));
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdbsL]?\s*$/.exec(String(text).trim()) ?? [])[1]);
// A fresh name each run: a body registered on an earlier server rejoins under its old name and blocks a new summon.
const NAME = `Sw${process.pid % 100000}`;
const rows = [];
let s;
try {
	s = await boot(path.join(out, 'server'), { jar: path.resolve(jarArg), template, port, world: null, seed: seedArg ?? '1', spawnMonsters: false, goalTicks: 2_000_000 });
	await s.command('difficulty peaceful');
	await s.command('gamerule minecraft:advance_time false').catch(() => {});
	await s.command('time set 1000');
	const registered = s.inbox.wait('agent_registered', () => true, 60_000);
	await s.command('forceload add 0 0');
	await s.command(`execute positioned 0 0 0 positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${NAME}`);
	const e = await registered;
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start', 120_000);
	await s.command(`mineagen start ${NAME} Survive for 36000 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const pos = async () => String(await s.command(`data get entity ${NAME} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const health = async () => number(await s.command(`data get entity ${NAME} Health`));
	const airLeft = async () => number(await s.command(`data get entity ${NAME} Air`));
	let n = 0;
	for (const fixture of fixtures) for (let run = 0; run < runs; run++) {
		const startedAt = Date.now();
		// at:x,y,z>tx,tz replays a recorded spot in the seed's own natural water (no fixture built), as in the matrix logs.
		if (fixture.startsWith('at:')) {
			const [from, to] = fixture.slice(3).split('>');
			const [sx, sy, sz] = from.split(',').map(Number), [tx, tz] = to.split(',').map(Number);
			await s.command(`forceload add ${Math.floor(sx) - 32} ${Math.floor(sz) - 32} ${Math.floor(sx) + 32} ${Math.floor(sz) + 32}`);
			for (let i = 0; i < 60 && !/time is/i.test(await s.command(`execute if loaded ${Math.floor(sx)} 0 ${Math.floor(sz)} run time query gametime`)); i++) await sleep(1000);
			await s.command(`tp ${NAME} ${sx} ${sy} ${sz} 90 0`);
			await s.command(`effect give ${NAME} minecraft:instant_health 1 10 true`);
			await sleep(3000);
			const before = await health(), t0 = Date.now();
			if (!Number.isFinite(before)) throw new Error(`${fixture} ${run}: health unreadable before the call`);
			let minHealth = before, sampling = true;
			const sampler = (async () => { while (sampling) { const h = await health().catch(() => NaN); if (Number.isFinite(h)) minHealth = Math.min(minHealth, h); await sleep(500); } })();
			const result = await s.act('travel_to', { x: tx, z: tz, tolerance: 3, timeoutMs: 90_000 }, 100_000).catch(error => ({ state: 'ERROR', reasonCode: error.message }));
			sampling = false; await sampler;
			const end = await pos();
			const row = { fixture, run, state: result.state, reasonCode: result.reasonCode, seconds: Math.round((Date.now() - t0) / 1000),
				left: end ? Math.round(Math.hypot(end[0] - tx, end[2] - tz) * 10) / 10 : null, healthLost: Math.max(0, before - minHealth), died: minHealth <= 0,
				message: String(result.message ?? '').slice(0, 240), startedAt, finishedAt: Date.now() };
			row.pass = judge(row);
			rows.push(row);
			console.log(`[${fixture} ${run}] ${row.state} ${row.reasonCode} ${row.seconds}s left=${row.left} hpLost=${row.healthLost}${row.died ? ' DIED' : ''} | ${row.message.slice(0, 140)}`);
			if (row.died) { await s.command(`mineagen respawn ${NAME}`).catch(() => {}); await sleep(3000); }
			continue;
		}
		const X = 200 + 80 * n++, Z = 200;
		await s.command(`forceload add ${X - 24} ${Z - 24} ${X + 24} ${Z + 24}`);
		for (let i = 0; i < 60 && !/time is/i.test(await s.command(`execute if loaded ${X} 0 ${Z} run time query gametime`)); i++) await sleep(1000);
		// A flat stone pad round the fixture, so the land around it is the same in every trial.
		await s.command(`execute positioned ${X} 0 ${Z} positioned over motion_blocking_no_leaves run tp ${NAME} ~0.5 ~ ~0.5`);
		await sleep(1500);
		const F = Math.floor((await pos())[1]);
		await s.command(`fill ${X - 16} ${F - 12} ${Z - 16} ${X + 24} ${F - 1} ${Z + 16} minecraft:stone`);
		await s.command(`fill ${X - 16} ${F} ${Z - 16} ${X + 24} ${F + 6} ${Z + 16} minecraft:air`);
		let start, target, drain = 0, facing = 90, afterMs = 0;
		if (fixture === 'lake') {
			await s.command(`fill ${X - 7} ${F - 5} ${Z - 7} ${X + 7} ${F - 1} ${Z + 7} minecraft:water`);
			start = [X + 0.5, F - 5, Z + 0.5]; target = { x: X + 20.5, z: Z + 0.5 };
		} else if (fixture === 'roofed') {
			await s.command(`fill ${X - 1} ${F - 6} ${Z - 1} ${X + 1} ${F - 1} ${Z + 1} minecraft:water`);
			await s.command(`fill ${X + 2} ${F - 6} ${Z} ${X + 8} ${F - 5} ${Z} minecraft:water`);
			await s.command(`fill ${X + 9} ${F - 6} ${Z - 1} ${X + 11} ${F - 4} ${Z + 1} minecraft:air`);
			// Facing down the passage, so the bank at its end is seen (an unseen bank is never chosen).
			start = [X + 0.5, F - 6, Z + 0.5]; target = { x: X + 20.5, z: Z + 0.5 }; drain = 4_000; facing = -90;
		} else if (fixture === 'detour') {
			// A solid block over the body's cell; the way to air is the flooded shaft beside it going up 10 (11 cells), on
			// about 4 s of air: above the reserve, short of what the breath rule allows for 11 cells.
			await s.command(`fill ${X} ${F - 11} ${Z} ${X} ${F - 10} ${Z} minecraft:water`);
			await s.command(`fill ${X + 1} ${F - 11} ${Z} ${X + 1} ${F - 1} ${Z} minecraft:water`);
			start = [X + 0.5, F - 11, Z + 0.5]; target = { x: X + 20.5, z: Z + 0.5 }; drain = 8_750; facing = -90; afterMs = 6_000;
		} else if (fixture === 'waterfall' || fixture === 'narrowfall') {
			await s.command(`fill ${X + 4} ${F - 26} ${Z - 12} ${X + 24} ${F - 26} ${Z + 12} minecraft:stone`);
			await s.command(`fill ${X + 4} ${F - 25} ${Z - 12} ${X + 24} ${F + 6} ${Z + 12} minecraft:air`);
			await s.command(`fill ${X - 7} ${F} ${Z - 4} ${X + 3} ${F + 1} ${Z + 4} minecraft:stone`);
			await s.command(`fill ${X - 6} ${F} ${Z - 3} ${X + 3} ${F + 1} ${Z + 3} minecraft:air`);
			await s.command(`fill ${X - 6} ${F - 2} ${Z - 3} ${X + 3} ${F - 1} ${Z + 3} minecraft:water`);
			// narrowfall: the east edge walled but for one block, so the fall is a one-wide column a swimmer can overshoot.
			if (fixture === 'narrowfall') {
				await s.command(`fill ${X + 3} ${F - 2} ${Z - 3} ${X + 3} ${F + 1} ${Z + 3} minecraft:stone`);
				await s.command(`fill ${X + 3} ${F - 2} ${Z} ${X + 3} ${F - 1} ${Z} minecraft:water`);
			}
			await sleep(3000);
			start = [X - 2.5, F - 1, Z + 0.5]; target = { x: X + 20.5, z: Z + 0.5 }; facing = -90;
		} else if (fixture === 'widelake') {
			await s.command(`fill ${X - 16} ${F - 5} ${Z - 10} ${X + 20} ${F - 1} ${Z + 10} minecraft:water`);
			start = [X - 10.5, F - 5, Z + 0.5]; target = { x: X + 22.5, z: Z + 0.5 };
		} else {
			for (let i = 0; i < 8; i++) await s.command(`fill ${X + i} ${F - 1 - i} ${Z} ${X + i} ${Math.min(F - 1, F + 1 - i)} ${Z} minecraft:water`);
			start = [X + 7.5, F - 8, Z + 0.5]; target = { x: X - 12.5, z: Z + 0.5 };
		}
		// Breath back in full first (a body moved straight from one underwater spot to the next keeps its spent air).
		await s.command(`tp ${NAME} ${X + 0.5} ${F} ${Z - 10.5} ${facing} 0`); await sleep(6000);
		await s.command(`tp ${NAME} ${start[0]} ${start[1]} ${start[2]} ${facing} 0`);
		await s.command(`effect give ${NAME} minecraft:instant_health 1 10 true`);
		await sleep(2000 + drain);
		const before = await health(), airBefore = await airLeft(), t0 = Date.now();
		if (!Number.isFinite(before)) throw new Error(`${fixture} ${run}: health unreadable before the call`);
		let minHealth = before, minAir = airBefore, maxX = -Infinity, sampling = true;
		const sampler = (async () => { while (sampling) {
			const h = await health().catch(() => NaN), a = await airLeft().catch(() => NaN), p = await pos().catch(() => null);
			if (Number.isFinite(h)) minHealth = Math.min(minHealth, h);
			if (Number.isFinite(a)) minAir = Math.min(minAir, a);
			if (p && p[1] < start[1] + 4) maxX = Math.max(maxX, p[0] - start[0]);
			await sleep(250);
		} })();
		const result = await s.act('travel_to', { x: target.x, z: target.z, tolerance: 3, timeoutMs: 90_000 }, 100_000).catch(error => ({ state: 'ERROR', reasonCode: error.message }));
		// afterMs: what happens to the body in the seconds after travel_to returns (a stop under water is the model's turn).
		const minAtResult = minHealth;
		if (afterMs > 0) await sleep(afterMs);
		sampling = false; await sampler;
		const end = await pos();
		const row = { fixture, run, state: result.state, reasonCode: result.reasonCode, seconds: Math.round((Date.now() - t0 - afterMs) / 1000),
			...(afterMs > 0 ? { healthLostAfter: Math.max(0, minAtResult - minHealth) } : {}),
			left: end ? Math.round(Math.hypot(end[0] - target.x, end[2] - target.z) * 10) / 10 : null, healthLost: Math.max(0, before - minAtResult), died: minHealth <= 0,
			airBefore, minAir, deepEast: Number.isFinite(maxX) ? Math.round(maxX * 10) / 10 : null, endY: end ? Math.round((end[1] - start[1]) * 10) / 10 : null,
			message: String(result.message ?? '').slice(0, 240), startedAt, finishedAt: Date.now() };
		row.pass = judge(row);
		rows.push(row);
		console.log(`[${fixture} ${run}] ${row.state} ${row.reasonCode} ${row.seconds}s left=${row.left} hpLost=${row.healthLost} air ${row.airBefore}->${row.minAir} east(low)=${row.deepEast} dy=${row.endY}${row.healthLostAfter !== undefined ? ` hpLostNext${afterMs / 1000}s=${row.healthLostAfter}` : ''}${row.died ? ' DIED' : ''} | ${row.message.slice(0, 140)}`);
		if (row.died) { await s.command(`mineagen respawn ${NAME}`).catch(() => {}); await sleep(3000); }
	}
} catch (error) {
	// Recorded as an invalid row: the trials it cut short are missing too.
	rows.push({ fixture: 'harness', error: String(error?.stack ?? error).slice(0, 1200) });
	console.log(`[water] ERROR ${String(error?.message ?? error).split('\n')[0]}`);
} finally {
	try { await s?.stop(); } catch (error) { rows.push({ fixture: 'cleanup', error: String(error?.message ?? error) }); }
}
const report = await finishRun(rows, { file: path.join(out, 'result.json'), planned: fixtures.length * runs, strict });
console.log(JSON.stringify(report));
process.exit(report.exitCode);
