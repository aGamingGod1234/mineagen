// Provider-free gather check: node scripts/quality/test-gather-live.mjs SPOTS.json OUT_DIR [JAR]
// SPOTS.json: [{ name, seed, x?, z?, inventory?, fixture?, gather: { itemId, count, blockIds?, radius?, timeoutMs? } }], one fresh
// server per spot. The body stands on the surface at x/z with the given kit; fixture commands ({x}/{y}/{z}+-n at the start
// feet cell) build the trees. The real NativeToolRuntime runs the gather tool against the server: the same coordinator
// code a model call reaches, fed by the wire adapter's live-shaped samples. No model call is made; operator commands
// build the fixture only. Reports per spot: result, held count, blocks broken, drops picked, steps, seconds, health
// lost and deaths. Each spot's world is deleted when it stops (server.log stays); ARENA_FIXTURE_KEEP=1 keeps it, saved.
// Launch under fix-slot.sh with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME.
// A spot passes when the call SUCCEEDED (or ended with the spot's `expectCode`, one code or a list, for a spot built to
// fail, such as no tree in reach) with no death and no health lost. Exit code (strict, the default): 0 all passed, 1 a spot failed,
// 2 invalid evidence (a spot errored or never ran). --descriptive reports without an acceptance exit code.
import { readFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { NativeToolRuntime } from '../../coordinator/src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../../coordinator/src/native-minecraft-tools.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { InspectionClient } from '../../coordinator/src/inspection-client.mjs';
import { warmBoots } from './fixture-servers.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { MOD_JAR } from './mod-jar.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-gather-live.mjs SPOTS.json OUT_DIR [JAR] [--strict|--descriptive] under fix-slot.sh with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const [spotsFile, outArg, jarArg] = cli.filter(arg => !['--strict', '--descriptive'].includes(arg));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!spotsFile || !outArg || !template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const spots = JSON.parse(await readFile(spotsFile, 'utf8'));
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Probe';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const results = [];

// Each spot gets its own server and world; the next one boots while this one plays, from the seed's cached world.
for await (const { item: [, spot], server: s, error: bootError } of warmBoots([...spots.entries()], ([index, spot]) => ({ dir: path.join(out, `spot-${index}`),
	options: { jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), template, port, world: null, seed: String(spot.seed), worldCache: true } }))) {
	const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const health = async () => number(await s.command(`data get entity ${AGENT} Health`));
	const deaths = async () => number(await s.command(`scoreboard players get ${AGENT} deaths`)) || 0;
	const row = { name: spot.name, seed: spot.seed };
	results.push(row);
	try {
		row.startedAt = Date.now();
		if (!s) throw bootError;
		const [fx, fz] = [spot.x ?? 0, spot.z ?? 0];
		let e = null;
		for (let attempt = 0; attempt < 3 && !e; attempt++) {
			const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
			await s.command(`forceload add ${fx} ${fz}`);
			for (let wait = 0; wait < 60 && !/time is/i.test(await s.command(`execute if loaded ${fx} 0 ${fz} run time query gametime`)); wait++) await sleep(1000);
			await s.command(`execute positioned ${fx} 0 ${fz} positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${AGENT}`);
			e = await registered;
		}
		if (!e) throw new Error('agent never registered');
		s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start', 120_000);
		await s.command(`mineagen start ${AGENT} Survive for 1200 seconds.`);
		s.record.goalRevision = (await started).payload.goalRevision;
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		const command = async text => ({ text: await s.command(text) });
		const setup = { dimension: 'minecraft:overworld', inventory: spot.inventory ?? [{ item: 'minecraft:bread', count: 4 }], mobs: [], commands: [],
			freezeUntilGoalStart: true, generality: true, groundBelowCanopy: true, position: [fx + 0.5, 100, fz + 0.5], surface: true };
		const receipt = await applyQualitySetup(setup, command, AGENT);
		await activateQualitySetup(receipt, command, { stage: 'goal-start' });
		await activateQualitySetup(receipt, command, { stage: 'first-decision' });
		await s.command('tick unfreeze').catch(() => {});
		await s.command('difficulty peaceful');
		const [x0, y0, z0] = (await pos()).map(Math.floor);
		for (const text of spot.fixture ?? []) {
			const at = { x: x0, y: y0, z: z0 };
			row.fixture = [...(row.fixture ?? []), await s.command(text.replace(/\{([xyz])([+-]\d+)?\}/g, (_, axis, offset) => String(at[axis] + Number(offset ?? 0))))];
		}
		await sleep(2000);
		// The coordinator's runtime, fed as the live coordinator feeds it: wire samples through the adapter.
		const commands = new Set();
		const inspections = new InspectionClient({ send: (type, agentId, payload) => s.bridge.send(type, agentId, payload) });
		s.bridge.on('inspection_result', message => { inspections.accept(message); });
		const runtime = new NativeToolRuntime({
			bridge: { send: async (type, agentId, payload) => {
				if (type === 'action_command') commands.add(payload.actionId);
				return s.bridge.send(type, agentId, payload);
			} },
			requestObservation: async () => { const payload = await s.observe(); return { eventSequence: payload.eventSequence, observation: adaptObservation(payload) }; },
			// Surveys go to the server as the coordinator sends them (InspectionClient over the bridge).
			inspectObservation: async (rec, query) => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await inspections.request(rec, query) }),
		});
		const record = { ...s.record, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
		s.bridge.on('observation', ev => { if (ev.agentId === record.agentId && ev.payload.ready) runtime.updateObservation(record, adaptObservation(ev.payload), { eventSequence: ev.payload.eventSequence }); });
		s.bridge.on('action_result', ev => {
			if (ev.agentId !== record.agentId || !commands.has(ev.payload.actionId)) return;
			runtime.onActionResult(record, ev.payload);
			s.bridge.send('action_result_ack', record.agentId, { goalRevision: record.goalRevision, actionId: ev.payload.actionId }).catch(() => {});
		});
		await s.observe();
		row.start = await pos();
		const healthBefore = await health(), deathsBefore = await deaths(), t0 = Date.now();
		if (!Number.isFinite(healthBefore)) throw new Error('health unreadable before the call');
		// spot.tool runs any tool instead (e.g. moveTo past trees); "{x+8}"-style strings are coordinates from the start feet.
		const at = { x: x0, y: y0, z: z0 };
		const resolve = value => typeof value === 'string' && /^\{[xyz]([+-]\d+)?\}$/.test(value)
			? at[value[1]] + Number(value.slice(2, -1) || 0) + (value[1] === 'y' ? 0 : 0.5)
			: Array.isArray(value) ? value.map(resolve) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)])) : value;
		const call = spot.tool ? { name: spot.tool.name, arguments: resolve(spot.tool.arguments) } : { name: 'gather', arguments: spot.gather };
		// The body's height through the call: a walk over a tree crown climbs 4+ blocks above the start.
		const heights = [];
		let sampling = true;
		const visited = [];
		const sampler = (async () => { while (sampling) { const p = await pos().catch(() => null); if (p) { heights.push(p[1]); visited.push(p); } await sleep(250); } })();
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: 'gather-live', callId: 'gather-1',
			tool: normalizeMinecraftToolCall(call.name, call.arguments) }, record);
		sampling = false; await sampler;
		row.maxRise = heights.length ? Math.round((Math.max(...heights) - y0) * 10) / 10 : null;
		// spot.watch {x:[lo,hi]} (blocks from the start x): whether the body stood a block up inside that strip (on a hedge).
		if (spot.watch) row.onWatched = visited.filter(([px, py]) => px - x0 >= spot.watch.x[0] && px - x0 < spot.watch.x[1] + 1 && py - y0 >= 0.9).length;
		row.seconds = Math.round((Date.now() - t0) / 1000);
		row.result = { state: result?.state, reasonCode: result?.reasonCode, message: String(result?.message ?? '').slice(0, 400), held: result?.held, broken: result?.broken, picked: result?.picked, steps: result?.steps };
		row.end = await pos();
		row.healthLost = Math.max(0, healthBefore - (await health()));
		row.deaths = (await deaths()) - deathsBefore;
		if (!Number.isFinite(row.healthLost)) throw new Error('health unreadable after the call');
		row.inventory = String(await s.command(`data get entity ${AGENT} Inventory`)).slice(0, 600);
		row.finishedAt = Date.now();
		const expected = [spot.expectCode].flat().filter(Boolean);
		const met = expected.length ? expected.includes(row.result.reasonCode) : row.result.state === 'SUCCEEDED';
		row.pass = Boolean(met && row.deaths === 0 && row.healthLost === 0);
		console.log(`[${spot.name}] ${row.result.state} ${row.result.reasonCode} held=${row.result.held} broken=${row.result.broken} picked=${row.result.picked} steps=${row.result.steps} ${row.seconds}s maxRise=${row.maxRise}${spot.watch ? ` onWatched=${row.onWatched}` : ''} healthLost=${row.healthLost} deaths=${row.deaths} PASS=${row.pass}`);
		console.log(`  ${row.result.message}`);
	} catch (error) {
		row.error = String(error?.stack ?? error).slice(0, 1200);
		console.log(`[${spot.name}] ERROR ${row.error.split('\n')[0]}`);
	} finally {
		try { await s?.stop(); } catch (error) { (row.integrity ??= []).push({ file: 'cleanup', error: error.message }); }
		await finishRun(results, { file: path.join(out, 'result.json'), planned: spots.length, strict });
	}
}
const report = await finishRun(results, { file: path.join(out, 'result.json'), planned: spots.length, strict });
console.log(JSON.stringify(report));
process.exit(report.exitCode);
