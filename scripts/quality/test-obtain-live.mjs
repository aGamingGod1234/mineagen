// Provider-free obtain check: node scripts/quality/test-obtain-live.mjs PLAN.json OUT_DIR [JAR]
// PLAN.json: { seeds: [<seed>...], lanes: 4, items: [{ item, count?, budgetMs, at?, kit? }] }. One fresh normal-difficulty server per
// seed with monsters on. Up to `lanes` bodies work at once, each on its own queue of items; every item run starts from
// an empty inventory, full health and food, at the world spawn or on untouched soil 200+ blocks from any other run
// (rings round the spawn), and calls the real
// NativeToolRuntime with do_step obtain {item, count} exactly as a model call would (normalizeMinecraftToolCall), fed
// by the wire adapter's live samples. No model call is made. Per run: end state, seconds, held count, deaths, health
// lost, workstations placed and whether any is still standing (checked over RCON), and the outcome: held, handed_back
// (danger: the run ends there, as the model would take over) or failed. Launch under slot.sh live with
// ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME.
// A recorded spot: an item's `at: [x, y, z]` (y null: the surface) starts that run exactly there (a gate game's spawn on a tree canopy, the cell
// where its dig met an aquifer) instead of on the surface of a ringed spot, and `kit: [[itemId, count]...]` is given
// before it starts (the tools and blocks that game's body held there). `setup: [command...]` builds the spot first.
// Exit code (strict, the default): 0 every run held its item in budget with no death and no workstation left, 1 a run
// did not (a danger hand-back counts), 2 invalid evidence (a run errored, or a seed or lane never ran its items).
// PLAN `minHeldRate` (e.g. 0.8, the natural-world obtain claim) relaxes the first rule to that share of item-seed runs
// held; a death or a workstation left anywhere still exits 1.
// Night rooms: an item's `time` (daytime ticks) sets the clock just before play instead of the morning start;
// `below: Y` starts the body in a sealed stone pocket at Y under its spot (a mine at dusk);
// `respawnInto: [[mobType, dx, dz]...]` sets the body's spawn at its spot, summons that pack round it, kills the body and
// respawns it there first (a respawn into the pack that killed it); `playMs` keeps watching until that much game time
// has passed even after obtain ends, and with `survive: true` the run passes when the body is alive at the end. With
// OBTAIN_HANDBACK=answer the stand-in answers a NIGHT hand-back with do_step rest, as the night wake tells the model.
// --descriptive reports without an acceptance exit code.
// FIXTURE_TICK_RATE runs the obtains faster: the seed's setup runs at 20 TPS, and the server runs at the raised rate
// while any lane's body is in an obtain run (lanes share one server, so a lane's run setup can overlap another lane's
// play: setup waits are game time on s.clock for that reason). The obtain calls, their budgets, samplers and waits and
// the runtime each lane drives are timed in game time, so a raised rate plays the same game. row.seconds is game seconds,
// row.wallSeconds wall seconds, row.rates the rate asked for and reached; row.damageTaken is vanilla's cumulative counter.
import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeToolRuntime } from '../../coordinator/src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../../coordinator/src/native-minecraft-tools.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { InspectionClient } from '../../coordinator/src/inspection-client.mjs';
import { DEFAULT_REFLEXES } from '../../coordinator/src/reflexes.mjs';
import { boot, unshownTickRate } from './watch-replay.mjs';
import { gameClockFromObservations } from '../../coordinator/src/game-clock.mjs';
import { callObtain } from './obtain-handbacks.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { parseSavedWorldSpawn } from '../../coordinator/src/headless-world-spawn.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { damageCounter, recordDamageEvidence, deathCounter, deathEvidence } from './lib/damage-counter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-obtain-live.mjs PLAN.json OUT_DIR [JAR] [--strict|--descriptive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const [planFile, outArg, jarArg] = cli.filter(arg => !['--strict', '--descriptive'].includes(arg));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
// A run that cannot start measured nothing: invalid evidence (2), never a pass.
if (!planFile || !outArg || !template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const plan = JSON.parse(await readFile(planFile, 'utf8'));
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const sleep = ms => new Promise(done => setTimeout(done, ms));
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const SPACING = 200;
const results = [];
const lanes = Math.min(plan.lanes ?? 4, 4);
const rowsFile = path.join(out, 'runs.jsonl');
// Every seed runs every item once; a seed or lane that never started leaves rows missing, which reads as invalid.
const planned = plan.seeds.length * plan.items.length;

// One seed's broken server must not end the matrix.
process.on('unhandledRejection', (error) => console.log(`[harness] unhandled: ${String(error?.message ?? error).slice(0, 200)}`));
// A killed harness stops its server rather than leaving it running on the slot's ports.
let current = null;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void (current?.stop() ?? Promise.resolve()).finally(() => process.exit(130)); });

for (const [seedIndex, seed] of plan.seeds.entries()) {
	const dir = path.join(out, `seed-${seedIndex}`);
	await mkdir(dir, { recursive: true });
	let s;
	try {
		// Each seed on its own ports (a crashed server can hold the last ones); no watchdog, as generating far chunks on a
		// shared machine can hold one tick past its 60 s.
		const seedPort = port + (seedIndex % 20) * 4;
		s = current = await boot(dir, { jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), template, port: seedPort, world: null, seed: String(seed), spawnMonsters: true, goalTicks: 2_000_000, extraProperties: 'max-tick-time=-1\n', tickRate: unshownTickRate('not yet played in a 20 vs 60 TPS A/B: its saved world or plan is private') });
		await s.normalRate();
		// One RCON connection serves four lanes; a slow command (a far chunk generating) can time the queue out and leave
		// the client unusable. Any failure rebuilds the client and retries.
		const secret = (await readFile(path.join(dir, 'secret.txt'), 'utf8')).trim();
		const once = s.command;
		s.command = async (text) => {
			for (let attempt = 0; ; attempt++) {
				try { return await once(text); }
				catch (error) {
					if (attempt >= 2) throw error;
					await s.rcon?.close().catch(() => {});
					s.rcon = new HeadlessRconClient({ host: '127.0.0.1', port: seedPort + 1, password: secret, connectTimeoutMs: 5000, commandTimeoutMs: 120_000 });
					await s.rcon.connect().catch(() => {});
					await sleep(1000);
				}
			}
		};
		// The server runs at the fixture rate while any lane's body is in an obtain run, at 20 otherwise. Changes are queued
		// so a lane ending its run never lowers the rate under one starting its run.
		let playing = 0, rateQueue = Promise.resolve();
		s.playRate = delta => (rateQueue = rateQueue.catch(() => {}).then(() => { playing += delta; return playing > 0 ? s.fastRate() : s.normalRate(); }));
		// The world's own spawn, as a new player gets it: the first run starts there, the rest ring out around it.
		await s.command('save-all flush');
		let sx = 0, sz = 0;
		try { ({ x: sx, z: sz } = parseSavedWorldSpawn(await readFile(path.join(dir, 'server', 'world', 'level.dat')))); }
		catch (error) { console.log(`[seed ${seed}] spawn unread (${error.message}); ringing 0,0`); }
		await s.command('difficulty normal');
		await s.command('time set 0');
		const queues = Array.from({ length: lanes }, () => []);
		plan.items.forEach((item, index) => queues[index % lanes].push(item));
		let spotIndex = 0;
		const nextSpot = () => { const n = spotIndex++; if (n === 0) return [sx, sz]; const ring = Math.floor((n - 1) / 8) + 1, angle = ((n - 1) % 8) * Math.PI / 4 + ring * 0.4; return [Math.round(sx + Math.cos(angle) * SPACING * ring), Math.round(sz + Math.sin(angle) * SPACING * ring)]; };
		// Bodies join one at a time (each registration is matched to its summon), then work in parallel.
		const agents = [];
		for (let lane = 0; lane < lanes; lane++) agents.push(await joinAgent(s, lane, nextSpot).catch((error) => { console.log(`[seed ${seed}] lane ${lane} could not start: ${error.message}`); return null; }));
		// A lane that cannot start or breaks down leaves the others running.
		await Promise.all(queues.map((queue, lane) => agents[lane] === null ? null : runLane(s, agents[lane], queue, seed, seedIndex, nextSpot)
			.catch((error) => console.log(`[seed ${seed}] lane ${lane} stopped: ${String(error?.message ?? error).slice(0, 200)}`))));
	} catch (error) {
		console.log(`[seed ${seed}] ERROR ${String(error?.stack ?? error).split('\n')[0]}`);
	} finally {
		await s?.stop().catch(() => {});
		await finishRun(results, { file: path.join(out, 'result.json'), planned, strict });
	}
}
let report = await finishRun(results, { file: path.join(out, 'result.json'), planned, strict });
const minHeldRate = plan.minHeldRate ?? 1;
if (report.status === 'FAIL' && minHeldRate < 1) {
	const heldRate = results.filter(row => row.pass).length / planned;
	const safe = results.every(row => row.deaths === 0 && row.stationsLeft === 0);
	report = { ...report, heldRate, minHeldRate, ...(strict && safe && heldRate >= minHeldRate ? { status: 'PASS', exitCode: 0 } : {}) };
	await writeFile(path.join(out, 'result-summary.json'), JSON.stringify(report, null, 2) + '\n');
	process.exitCode = report.exitCode;
}
console.log(JSON.stringify(report));
// Bridge sockets and timers can outlive the last server; the exit code is the report's.
process.exit(report.exitCode);

async function surfaceAt(s, x, z) {
	await s.command(`forceload add ${x} ${z}`);
	for (let wait = 0; wait < 60 && !/time is/i.test(await s.command(`execute if loaded ${x} 0 ${z} run time query gametime`)); wait++) await sleep(1000);
	// Like a world spawn: dry land on soil (grass, dirt, podzol, moss), not water, sand or a cliff of stone.
	// Dry land of any kind: only water, lava, ice and powder snow on top are refused (a spawn is never in them).
	const top = async (test) => /passed/i.test(await s.command(`execute positioned ${x} 0 ${z} positioned over motion_blocking if block ~ ~-1 ~ ${test}`).catch(() => ''));
	const wet = await top('minecraft:water') || await top('minecraft:lava') || await top('#minecraft:ice') || await top('minecraft:powder_snow');
	return { x, z, wet };
}

async function joinAgent(s, lane, nextSpot) {
	const name = `Ob${lane}`;
	const spot = await landSpot(s, nextSpot);
	const registered = s.inbox.wait('agent_registered', () => true, 60_000);
	await s.command(`execute positioned ${spot[0]} 0 ${spot[1]} positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${name}`);
	const e = await registered;
	const record = { ...(e.payload.record ?? e.payload), agentId: e.agentId, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
	await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.agentId === record.agentId && g.payload.operation === 'start', 120_000);
	await s.command(`mineagen start ${name} Survive for 36000 seconds.`);
	record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	let latest = null;
	const commands = new Map();
	const actions = [];
	const inspections = new InspectionClient({ send: (type, agentId, payload) => s.bridge.send(type, agentId, payload) });
	s.bridge.on('inspection_result', message => { if (message.agentId === record.agentId) inspections.accept(message); });
	const log = [];
	let logStart = s.clock.now();
	const runtime = new NativeToolRuntime({
		trace: (event, fields) => { if (event === 'native_obtain_step' && fields?.agentId === record.agentId) log.push(`${Math.round((s.clock.now() - logStart) / 1000)}s ${fields.text}`); },
		bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') commands.set(payload.actionId, { actionType: payload.actionType, at: s.clock.now() }); return s.bridge.send(type, agentId, payload); } },
		requestObservation: async () => {
			const before = latest?.eventSequence ?? 0;
			await s.bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision });
			for (let i = 0; i < 400 && !(latest?.eventSequence > before); i++) await sleep(25);
			return { eventSequence: latest.eventSequence, observation: adaptObservation(latest) };
		},
		inspectObservation: async (rec, query) => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await inspections.request(rec, query) }),
		// At a raised rate the runtime times obtain and its steps in game time (it feeds the clock its samples).
		...(s.clock.rate === 20 ? {} : { clock: gameClockFromObservations({ tickRate: s.clock.rate }) }),
	});
	s.bridge.on('observation', ev => {
		if (ev.agentId !== record.agentId || !ev.payload.ready) return;
		latest = ev.payload;
		runtime.updateObservation(record, adaptObservation(ev.payload), { eventSequence: ev.payload.eventSequence });
	});
	// A death and respawn move the goal revision: follow it, as the coordinator does, so the lane goes on.
	s.bridge.on('message', ev => {
		if (ev.type !== 'goal_control' || ev.agentId !== record.agentId || !['dead', 'respawn'].includes(ev.payload?.operation)) return;
		if (Number.isSafeInteger(ev.payload.goalRevision)) record.goalRevision = ev.payload.goalRevision;
		s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
	});
	const where = () => {
		const o = latest === null ? null : adaptObservation(latest), p = o?.player;
		return p && [p.x, p.y, p.z].every(Number.isFinite) ? ` @${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} ${o?.world?.biome ?? ''}` : '';
	};
	s.bridge.on('action_result', ev => {
		if (ev.agentId !== record.agentId || !commands.has(ev.payload.actionId)) return;
		const sent = commands.get(ev.payload.actionId);
		if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(ev.payload.state)) actions.push(`${Math.round((sent.at - logStart) / 1000)}s +${Math.round((s.clock.now() - sent.at) / 1000)}s ${sent.actionType} ${ev.payload.state} ${ev.payload.reasonCode ?? ''} ${String(ev.payload.message ?? '').slice(0, 400)}${where()}`);
		runtime.onActionResult(record, ev.payload);
		s.bridge.send('action_result_ack', record.agentId, { goalRevision: record.goalRevision, actionId: ev.payload.actionId }).catch(() => {});
	});
	await s.bridge.send('reflex_update', record.agentId, { revision: 1, rules: DEFAULT_REFLEXES.map(rule => ({ ...structuredClone(rule), coordinatorDefault: true })), yield: false });
	return { name, record, runtime, spot, latest: () => latest, log, actions, resetLog: () => { log.length = 0; actions.length = 0; logStart = s.clock.now(); } };
}

async function runLane(s, agent, queue, seed, seedIndex, nextSpot) {
	const { name, record, runtime } = agent;
	const lane = Number(name.slice(2));
	let spot = agent.spot;
	const pos = async () => String(await s.command(`data get entity ${name} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const health = async () => number(await s.command(`data get entity ${name} Health`));
	const deaths = () => deathCounter(text => s.command(text), name, { objective: 'deaths', unsetIsZero: true });
	const readDamage = await damageCounter(text => s.command(text), name);
	const now = () => s.clock.now();
	let previous = null;
	for (const [index, entry] of queue.entries()) {
		if (index > 0) spot = await landSpot(s, nextSpot);
		const row = { seed: String(seed), seedIndex, lane, item: entry.item, count: entry.count ?? 1, budgetMs: entry.budgetMs, spot, startedAt: Date.now() };
		let inPlay = false;
		try {
			// A body that died after the previous run handed back (no model here to answer the danger) respawns first;
			// that death is the previous run's hand-back, recorded apart from deaths during an obtain.
			const deadAtStart = !(await health() > 0);
			if (deadAtStart) {
				const started = s.inbox.wait('goal_control', g => g.agentId === record.agentId && g.payload.operation === 'start', 60_000).catch(() => null);
				await s.command(`mineagen respawn ${name}`).catch(() => {});
				for (let i = 0; i < 60 && !(await health() > 0); i++) await sleep(500);
				await s.command(`mineagen start ${name} Survive for 36000 seconds.`).catch(() => {});
				const goal = await started;
				if (goal) record.goalRevision = goal.payload.goalRevision;
				await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
			}
			if (deadAtStart) { row.deadAtStart = true; if (previous) { previous.diedAfterHandBack = true; await appendFile(rowsFile, `${JSON.stringify({ amend: previous.item, seedIndex, lane, diedAfterHandBack: true })}\n`); } }
			// A fresh start: daytime, nothing held, full health and food, standing on the surface of untouched land. Night
			// ends for every lane when one starts a run in it (a new player starts in the morning).
			const daytime = number(await s.command('time query daytime'));
			// A timed run sets its own clock just before play (lanes of one night plan share it).
			if (!Number.isFinite(entry.time) && Number.isFinite(daytime) && daytime >= 12_000) await s.command('time set 1000');
			await s.command(`clear ${name}`);
			await s.command(`effect clear ${name}`);
			if (Array.isArray(entry.at)) {
				const [ax, ay, az] = entry.at;
				await s.command(`forceload add ${Math.floor(ax)} ${Math.floor(az)}`);
				for (let wait = 0; wait < 60 && !/time is/i.test(await s.command(`execute if loaded ${Math.floor(ax)} 0 ${Math.floor(az)} run time query gametime`)); wait++) await sleep(1000);
				spot = [Math.floor(ax), Math.floor(az)];
				row.spot = spot;
				// A built spot (a leaf canopy 26 blocks up): its commands run before the body is put there.
				for (const command of entry.setup ?? []) await s.command(command);
				// No y: the surface there (a spot whose recorded cell was dug by that game's own body).
				await s.command(ay === null ? `execute in minecraft:overworld positioned ${ax} 0 ${az} positioned over motion_blocking_no_leaves run tp ${name} ~ ~ ~` : `tp ${name} ${ax} ${ay} ${az}`);
			} else await s.command(`execute in minecraft:overworld positioned ${spot[0]} 0 ${spot[1]} positioned over motion_blocking_no_leaves run tp ${name} ~0.5 ~ ~0.5`);
			// `below: Y`: after a moment on the surface (so the body knows its way up), a sealed stone pocket at Y under the spot.
			if (Number.isFinite(entry.below) && !Array.isArray(entry.at)) {
				await s.clock.sleep(2000);
				const [px, pz] = spot, y = Math.floor(entry.below);
				await s.command(`fill ${px - 2} ${y - 1} ${pz - 2} ${px + 2} ${y + 3} ${pz + 2} minecraft:stone`);
				await s.command(`fill ${px - 1} ${y} ${pz - 1} ${px + 1} ${y + 2} ${pz + 1} minecraft:air`);
				await s.command(`tp ${name} ${px + 0.5} ${y} ${pz + 0.5}`);
			}
			for (const [itemId, count] of entry.kit ?? []) await s.command(`give ${name} ${itemId} ${count}`);
			await s.command(`effect give ${name} minecraft:instant_health 1 20 true`);
			await s.command(`effect give ${name} minecraft:saturation 2 20 true`);
			// Game time: another lane may be playing at the raised rate meanwhile (plain wall time at 20 TPS).
			await s.clock.sleep(2500);
			// Never start in water: a spot that put the body in it is replaced by the next dry one.
			for (let retry = 0; retry < 6 && !Array.isArray(entry.at) && /passed/i.test(await s.command(`execute as ${name} at @s if block ~ ~ ~ minecraft:water`).catch(() => '')); retry++) {
				spot = await landSpot(s, nextSpot);
				row.spot = spot;
				await s.command(`execute in minecraft:overworld positioned ${spot[0]} 0 ${spot[1]} positioned over motion_blocking_no_leaves run tp ${name} ~0.5 ~ ~0.5`);
				await s.clock.sleep(2500);
			}
			const kitted = (entry.kit ?? []).length;
			for (let i = 0; i < 300 && !(agent.latest()?.ready && (agent.latest()?.inventory?.items?.length ?? 0) >= kitted && (kitted > 0 || agent.latest()?.inventory?.items?.length === 0)); i++) await sleep(100);
			if (Number.isFinite(entry.time)) await s.command(`time set ${entry.time}`);
			if (Array.isArray(entry.respawnInto)) await respawnIntoPack(s, agent, entry.respawnInto, row);
			row.start = await pos();
			const damageBefore = await readDamage();
			inPlay = true;
			await s.playRate(+1);
			const healthBefore = await health(), deathsBefore = await deaths(), t0 = now(), wall0 = Date.now(), timer = await s.gameTimer();
			row.playStartedAt = wall0;
			let minHealth = healthBefore;
			let sampling = true;
			const sampler = (async () => { while (sampling) { const h = await health().catch(() => NaN); if (Number.isFinite(h)) minHealth = Math.min(minHealth, h); await s.clock.sleep(2000); } })();
			agent.resetLog();
			const call = normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: entry.item, count: entry.count ?? 1, timeoutMs: entry.budgetMs }, why: `obtain ${entry.item}` });
			const ran = await callObtain({ mode: process.env.OBTAIN_HANDBACK, budgetMs: entry.budgetMs, started: t0, now,
				execute: async (attempt, left) => {
					const again = attempt === 0 ? call : normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: entry.item, count: entry.count ?? 1, timeoutMs: Math.max(60_000, left) }, why: `obtain ${entry.item}` });
					try {
						return await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `obtain-${seedIndex}-${lane}-${index}-${attempt}`, callId: `obtain-${index}-${attempt}`, tool: again }, record);
					} catch (error) { return { state: 'ERROR', reasonCode: error?.code ?? 'ERROR', message: String(error?.message ?? error) }; }
				},
				alive: async () => await health() > 0,
				// The simplest answer a model gives: flee a creeper 12 blocks, fight any other named hostile (20 s), else
				// let the reflexes act for 3 s. Then obtain again.
				answer: async (handedBack, attempt) => {
					if (handedBack.reasonCode === 'NIGHT') {
						try {
							const rested = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `rest-${seedIndex}-${lane}-${index}-${attempt}`, callId: `rest-${index}-${attempt}`,
								tool: normalizeMinecraftToolCall('do_step', { verb: 'rest', target: { timeoutMs: Math.max(60_000, (entry.playMs ?? entry.budgetMs) - (now() - t0)) }, why: 'night: rest until dawn' }) }, record);
							return `answered rest: ${rested?.state} ${rested?.reasonCode ?? ''} ${String(rested?.message ?? '').slice(0, 160)}`;
						} catch (error) { return `rest failed: ${error?.code ?? error?.message}`; }
					}
					const named = /minecraft:([a-z_]+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(String(handedBack.message ?? ''));
					const answer = named === null ? null : named[1] === 'creeper'
						? { actionType: 'flee_from', arguments: { targetId: named[2], distance: 12, timeoutMs: 10_000 } }
						: { actionType: 'fight_target', arguments: { targetId: named[2], timeoutMs: 20_000 } };
					if (!answer) { await s.clock.sleep(3000); return null; }
					try {
						const answered = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `answer-${seedIndex}-${lane}-${index}-${attempt}`, callId: `answer-${index}-${attempt}`, tool: normalizeMinecraftToolCall('act', answer) }, record);
						return `answered ${answer.actionType} ${named[1]}: ${answered?.state} ${answered?.reasonCode ?? ''}`;
					} catch (error) { return `answer failed: ${error?.code ?? error?.message}`; }
				} });
			let result = ran.result;
			row.handBacks = ran.handBacks;
			// A night room is judged on the whole window: the body stands wherever obtain left it until playMs is up.
			if (Number.isFinite(entry.playMs)) {
				while (now() - t0 < entry.playMs && await health().catch(() => 0) > 0 && (await deaths()) === deathsBefore) await s.clock.sleep(2000);
				row.aliveAtEnd = await health().catch(() => 0) > 0 && (await deaths()) === deathsBefore;
			}
			const placedAll = ran.results.flatMap((one) => one?.stations?.placed ?? []);
			if (result && placedAll.length) result = { ...result, stations: { ...(result.stations ?? {}), placed: placedAll } };
			sampling = false; await sampler;
			row.seconds = Math.round((now() - t0) / 1000);
			row.wallSeconds = Math.round((Date.now() - wall0) / 1000);
			row.gameSeconds = Math.round((await timer.elapsed()) / 1000);
			row.rates = await timer.rates().catch(() => null);
			recordDamageEvidence(row, damageBefore, await readDamage());
			inPlay = false;
			await s.playRate(-1);
			row.result = { state: result?.state, reasonCode: result?.reasonCode, held: result?.held, message: String(result?.message ?? '').slice(0, 600), steps: result?.steps, stations: result?.stations };
			row.log = [...agent.log];
			row.actions = [...agent.actions];
			// The scoreboard misses some agent deaths; health reaching 0 is one too.
			const deathResult = deathEvidence(deathsBefore, await deaths());
			row.deaths = deathResult.valid ? Math.max(deathResult.deaths, minHealth <= 0 ? 1 : 0) : null;
			if (!deathResult.valid) (row.integrity ??= []).push({ file: 'deaths', error: 'Missing or decreasing vanilla death counter' });
			row.healthLost = Math.max(0, healthBefore - minHealth);
			row.end = await pos();
			row.stationsLeft = 0;
			for (const station of result?.stations?.placed ?? []) {
				const standing = /passed/i.test(await s.command(`execute if block ${station.x} ${station.y} ${station.z} minecraft:${station.kind}`).catch(() => ''));
				if (standing) { row.stationsLeft += 1; (row.standing ??= []).push(station); }
			}
			row.inventory = String(await s.command(`data get entity ${name} Inventory`)).slice(0, 900);
			row.pass = entry.survive === true ? row.deaths === 0 && row.aliveAtEnd === true
				: result?.state === 'SUCCEEDED' && row.seconds * 1000 <= entry.budgetMs + 15_000 && row.deaths === 0 && row.stationsLeft === 0;
			row.outcome = row.pass ? 'held' : result?.state === 'INTERRUPTED' && row.deaths === 0 ? 'handed_back' : 'failed';
			row.firstCall = row.handBacks.length === 0 ? row.result.state : 'INTERRUPTED';
			row.finishedAt = Date.now();
			row.tick = { rate: s.tickRate, held: await s.tickReport() };
			console.log(`[${seed} L${lane}] ${entry.item}: ${row.result.state} ${row.result.reasonCode} held=${row.result.held} ${row.seconds}s deaths=${row.deaths} hpLost=${row.healthLost} placed=${result?.stations?.placed?.length ?? 0} left=${row.stationsLeft} pass=${row.pass}`);
			if (!row.pass) {
				console.log(`   ${row.result.message}`);
				await writeFile(path.join(out, `fail-${seedIndex}-${lane}-${index}-${entry.item}.json`), JSON.stringify({ row, observation: agent.latest() })).catch(() => {});
			}
		} catch (error) {
			row.error = String(error?.stack ?? error).slice(0, 1200);
			console.log(`[${seed} L${lane}] ${entry.item}: ERROR ${row.error.split('\n')[0]}`);
		}
		if (inPlay) await s.playRate(-1).catch(() => {});
		await s.command(`forceload remove ${spot[0]} ${spot[1]}`).catch(() => {});
		results.push(row);
		previous = row;
		await appendFile(rowsFile, `${JSON.stringify(row)}\n`);
		// A death respawns the body at world spawn; the next run teleports it to fresh land anyway.
	}
}

// The body's spawn set where it stands, a pack summoned round it (kept from despawning, skeletons with bows), then the
// body killed and respawned into them, its goal followed as the coordinator does.
async function respawnIntoPack(s, agent, pack, row) {
	const { name, record } = agent;
	await s.command(`execute at ${name} run spawnpoint ${name} ~ ~ ~`);
	for (const [type, dx, dz] of pack) {
		// A helmet each, so the last of the dusk light does not burn the pack before night.
		const gear = `,equipment:{head:{id:"minecraft:leather_helmet",count:1}${type === 'skeleton' ? ',mainhand:{id:"minecraft:bow",count:1}' : ''}}`;
		await s.command(`execute at ${name} positioned ~${dx} ~ ~${dz} positioned over motion_blocking_no_leaves run summon minecraft:${type} ~ ~ ~ {PersistenceRequired:1b${gear}}`);
	}
	await s.command(`kill ${name}`);
	await s.clock.sleep(1500);
	const started = s.inbox.wait('goal_control', g => g.agentId === record.agentId && g.payload.operation === 'start', 60_000).catch(() => null);
	await s.command(`mineagen respawn ${name}`).catch(() => {});
	for (let i = 0; i < 60 && !(number(await s.command(`data get entity ${name} Health`)) > 0); i++) await sleep(500);
	await s.command(`mineagen start ${name} Survive for 36000 seconds.`).catch(() => {});
	const goal = await started;
	if (goal) record.goalRevision = goal.payload.goalRevision;
	await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
	await s.clock.sleep(1500);
	row.respawnedInto = pack.length;
}

async function landSpot(s, nextSpot) {
	for (let tries = 0; tries < 48; tries++) {
		const [x, z] = nextSpot();
		const surface = await surfaceAt(s, x, z).catch(() => ({ wet: true }));
		// A forced chunk stays simulated: keep only the one a run will use (its run releases it).
		if (!surface.wet) return [x, z];
		await s.command(`forceload remove ${x} ${z}`).catch(() => {});
	}
	throw new Error('no dry soil found in 48 spots round the spawn');
}
