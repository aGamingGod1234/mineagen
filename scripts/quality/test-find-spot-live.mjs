// Provider-free find check at a recorded spot: node scripts/quality/test-find-spot-live.mjs OUT_DIR JAR [runs] [fixture]
// Each run boots a fresh server on the fixture's seed (peaceful, no monsters), opens the 1x2 cell the body stood in, puts
// the body there with the run's tools, and calls the real NativeToolRuntime with do_step find exactly as a model call
// would. No model call. Fixtures:
//   b1-aquifer  seed 5433312384530337025, the cell 12,58,-45 where the 4-seed check's B-1 game (obtain branch b8db7cee)
//               dug down four times, once per heading, each stopped by the aquifer under it, before moving off.
// Per run: the find result, every body action with its stop and where the body was, the digs down started from the
// start cell and how many water stopped, seconds to the first move off the spot, health lost, deaths. The world is
// deleted after each run (logs kept). Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME.
// FIXTURE_TICK_RATE runs the find faster: setup stays at 20 TPS, and the find, its health sampler and the runtime it drives
// are timed in game time (s.clock), so a raised rate plays the same game. row.seconds is game seconds, row.wallSeconds
// wall seconds, row.rates the rate asked for and reached; row.vanillaDeaths is vanilla's death counter over the find.
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { boot, fixtureTickRate } from './watch-replay.mjs';
import { gameClockFromObservations } from '../../coordinator/src/game-clock.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { damageCounter, damageEvidence, deathCounter, deathEvidence } from './lib/damage-counter.mjs';
import { NativeToolRuntime } from '../../coordinator/src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../../coordinator/src/native-minecraft-tools.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { InspectionClient } from '../../coordinator/src/inspection-client.mjs';

const FIXTURES = {
	'b1-aquifer': { seed: '5433312384530337025', cell: [12, 58, -45], target: { block: 'minecraft:iron_ore' }, timeoutMs: 180_000,
		items: [['minecraft:stone_pickaxe', 1], ['minecraft:wooden_pickaxe', 1], ['minecraft:cobblestone', 64], ['minecraft:dirt', 36], ['minecraft:andesite', 23]] },
};
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log('Usage: test-find-spot-live.mjs OUT_DIR JAR [runs] [fixture] [--strict|--descriptive]\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const [outArg, jarArg, runsArg, fixtureArg] = cli.filter(arg => !['--strict', '--descriptive'].includes(arg));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !jarArg || !template || !port || !process.env.JAVA_HOME) { console.error('Usage: OUT_DIR JAR [runs] [fixture] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME'); process.exit(2); }
const fixture = FIXTURES[fixtureArg ?? 'b1-aquifer'];
if (!fixture) throw new Error(`fixture is one of ${Object.keys(FIXTURES).join(', ')}`);
const runs = Number(runsArg ?? 3);
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const number = (text) => Number((/(-?\d+(?:\.\d+)?)[fdbsL]?\s*$/.exec(String(text).trim()) ?? [])[1]);
let current = null;
const results = [];
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void (current?.stop() ?? Promise.resolve()).finally(() => process.exit(130)); });

const [cx, cy, cz] = fixture.cell;
for (let run = 0; run < runs; run++) {
	const dir = path.join(out, `run-${run}`);
	const row = { run, fixture: fixtureArg ?? 'b1-aquifer', seed: fixture.seed, cell: fixture.cell };
	results.push(row);
	let s;
	try {
		row.startedAt = Date.now();
		s = current = await boot(dir, { jar: path.resolve(jarArg), template, port, world: null, seed: fixture.seed, spawnMonsters: false, goalTicks: 2_000_000, extraProperties: 'max-tick-time=-1\n', tickRate: fixtureTickRate() });
		await s.normalRate();
		await s.command('difficulty peaceful');
		await s.command('gamerule minecraft:advance_time false').catch(() => {});
		await s.command('time set 1000');
		await s.command(`forceload add ${cx - 48} ${cz - 48} ${cx + 48} ${cz + 48}`);
		for (let i = 0; i < 90 && !/time is/i.test(await s.command(`execute if loaded ${cx} 0 ${cz} run time query gametime`)); i++) await sleep(1000);
		const name = `Fs${run}`;
		const registered = s.inbox.wait('agent_registered', () => true, 60_000);
		await s.command(`execute positioned ${cx} 0 ${cz} positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${name}`);
		const e = await registered;
		const record = { ...(e.payload.record ?? e.payload), agentId: e.agentId, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
		s.record = record;
		await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
		const started = s.inbox.wait('goal_control', (g) => g.agentId === record.agentId && g.payload.operation === 'start', 120_000);
		await s.command(`mineagen start ${name} Survive for 36000 seconds.`);
		record.goalRevision = (await started).payload.goalRevision;
		await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
		let latest = null;
		const commands = new Map(), actions = [];
		const inspections = new InspectionClient({ send: (type, agentId, payload) => s.bridge.send(type, agentId, payload) });
		s.bridge.on('inspection_result', (message) => { if (message.agentId === record.agentId) inspections.accept(message); });
		const t0 = { at: s.clock.now() };
		const runtime = new NativeToolRuntime({
			bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') commands.set(payload.actionId, { actionType: payload.actionType, arguments: payload.arguments }); return s.bridge.send(type, agentId, payload); } },
			requestObservation: async () => {
				const before = latest?.eventSequence ?? 0;
				await s.bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision });
				for (let i = 0; i < 400 && !(latest?.eventSequence > before); i++) await sleep(25);
				return { eventSequence: latest.eventSequence, observation: adaptObservation(latest) };
			},
			inspectObservation: async (rec, query) => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await inspections.request(rec, query) }),
			// At a raised rate the runtime times find in game time too (it feeds the clock its samples).
			...(s.clock.rate === 20 ? {} : { clock: gameClockFromObservations({ tickRate: s.clock.rate }) }),
		});
		s.bridge.on('observation', (ev) => {
			if (ev.agentId !== record.agentId || !ev.payload.ready) return;
			latest = ev.payload;
			runtime.updateObservation(record, adaptObservation(ev.payload), { eventSequence: ev.payload.eventSequence });
		});
		s.bridge.on('action_result', (ev) => {
			if (ev.agentId !== record.agentId || !commands.has(ev.payload.actionId)) return;
			const sent = commands.get(ev.payload.actionId);
			const at = latest?.position;
			actions.push({ s: Math.round((s.clock.now() - t0.at) / 100) / 10, actionType: sent.actionType, args: sent.arguments, state: ev.payload.state, reasonCode: ev.payload.reasonCode,
				at: at ? [Math.floor(at.x), Math.floor(at.y + 1e-3), Math.floor(at.z)] : null, message: String(ev.payload.message ?? '').slice(0, 220) });
			runtime.onActionResult(record, ev.payload);
			s.bridge.send('action_result_ack', record.agentId, { goalRevision: record.goalRevision, actionId: ev.payload.actionId }).catch(() => {});
		});
		await s.command(`fill ${cx} ${cy} ${cz} ${cx} ${cy + 1} ${cz} minecraft:air`);
		await s.command(`clear ${name}`);
		for (const [item, count] of fixture.items) await s.command(`give ${name} ${item} ${count}`);
		await s.command(`tp ${name} ${cx + 0.5} ${cy} ${cz + 0.5} 0 0`);
		await s.command(`effect give ${name} minecraft:instant_health 1 10 true`);
		await s.idleSleep(3000);
		for (let i = 0; i < 200 && !(latest?.ready && (latest?.inventory?.items?.length ?? 0) >= fixture.items.length && Math.floor(latest.position?.y ?? 0) === cy); i++) await sleep(100);
		const health = async () => number(await s.command(`data get entity ${name} Health`));
		const readDamage = await damageCounter(text => s.command(text), name);
		const damageBefore = await readDamage();
		const deaths = () => deathCounter(text => s.command(text), name, { objective: 'deaths', unsetIsZero: true });
		const deathsBefore = await deaths();
		await s.fastRate();
		// Play is timed on the fixture clock: game time at a raised rate, plain wall time at 20 TPS.
		const now = () => s.clock.now();
		const before = await health();
		let minHealth = before, sampling = true;
		const sampler = (async () => { while (sampling) { const h = await health().catch(() => NaN); if (Number.isFinite(h)) minHealth = Math.min(minHealth, h); await s.clock.sleep(1000); } })();
		row.start = latest?.position ? [latest.position.x, latest.position.y, latest.position.z] : null;
		const wall0 = Date.now(), timer = await s.gameTimer();
		t0.at = now();
		row.playStartedAt = wall0;
		const call = normalizeMinecraftToolCall('do_step', { verb: 'find', target: { ...fixture.target, timeoutMs: fixture.timeoutMs }, why: 'iron for the pickaxe' });
		let result;
		try { result = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `find-${run}`, callId: `find-${run}`, tool: call }, record); }
		catch (error) { result = { state: 'ERROR', reasonCode: error?.code ?? 'ERROR', message: String(error?.message ?? error) }; }
		sampling = false; await sampler;
		row.seconds = Math.round((now() - t0.at) / 1000);
		row.wallSeconds = Math.round((Date.now() - wall0) / 1000);
		row.gameSeconds = Math.round((await timer.elapsed()) / 1000);
		row.rates = await timer.rates().catch(() => null);
		const healthAfter = await health();
		await s.normalRate();
		row.result = { state: result?.state, reasonCode: result?.reasonCode, message: String(result?.message ?? '').slice(0, 400), seen: result?.find?.seen ?? null };
		row.actions = actions;
		const startCell = fixture.cell.join(',');
		const fromStart = actions.filter((a) => a.actionType === 'dig_to' && /down|shaft/.test(a.args?.pattern ?? ''));
		// Digs down that water stopped with the body still in the start cell or the cell the first dig ended in.
		const firstEnd = fromStart[0]?.at?.join(',');
		row.wetDigsAtSpot = fromStart.filter((a) => a.reasonCode === 'WATER_AHEAD' && [startCell, firstEnd].includes(a.at?.join(','))).length;
		row.moveOffAtS = actions.find((a) => a.actionType === 'travel_to' && Number.isFinite(a.args?.yaw) && Number.isFinite(a.args?.distance))?.s ?? null;
		Object.assign(row, damageEvidence(damageBefore, await readDamage(), before, healthAfter));
		// Recorded beside the sampled-health death below (null when unreadable); the verdict keeps using that one.
		row.vanillaDeaths = deathEvidence(deathsBefore, await deaths()).deaths;
		row.healthDropLowerBound = Math.max(0, before - minHealth);
		row.deaths = minHealth <= 0 ? 1 : 0;
		row.finishedAt = Date.now();
		row.tick = { rate: s.tickRate, held: await s.tickReport() };
		row.pass = row.result.state === 'SUCCEEDED' && row.result.reasonCode === 'FIND_SEEN' && row.deaths === 0 && row.damageTaken === 0;
		row.end = latest?.position ? [Math.round(latest.position.x), Math.round(latest.position.y), Math.round(latest.position.z)] : null;
		console.log(`[run ${run}] ${row.result.state} ${row.result.reasonCode} ${row.seconds}s wetDigsAtSpot=${row.wetDigsAtSpot} moveOffAt=${row.moveOffAtS}s actions=${actions.length} damageTaken=${row.damageTaken ?? "unknown"} deaths=${row.deaths} end=${row.end}`);
		for (const a of actions) console.log(`   ${a.s}s ${a.actionType} ${a.args?.pattern ?? ''}${a.args?.heading ? ` ${a.args.heading}` : ''} ${a.reasonCode} at ${a.at}`);
	} catch (error) {
		row.error = String(error?.stack ?? error).slice(0, 1200);
		console.log(`[run ${run}] ERROR ${row.error.split('\n')[0]}`);
	} finally {
		let stopped = !s;
		try { if (s) await s.stop(); stopped = true; } catch (error) { (row.integrity ??= []).push({ file: 'cleanup', error: error.message }); }
		current = null;
		// Keep the logs, not the world: each run is a fresh one.
		if (stopped) await rm(path.join(dir, 'server'), { recursive: true, force: true }).catch(() => {});
		await appendFile(path.join(out, 'runs.jsonl'), `${JSON.stringify(row)}\n`);
		await finishRun(results, { file: path.join(out, 'result.json'), planned: runs, strict });
	}
}
await writeFile(path.join(out, 'done'), '');
console.log(JSON.stringify(await finishRun(results, { file: path.join(out, 'result.json'), planned: runs, strict })));
