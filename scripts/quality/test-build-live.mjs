// Provider-free build check: node scripts/quality/test-build-live.mjs SPOTS.json OUT_DIR [JAR]
// SPOTS.json: [{ name, seed, inventory?, commands?, calls: [{ name, arguments }], expect?, time?, monsters? }], one fresh
// server per spot. The body starts at the world's generated spawn with the given kit and the twelve default reflexes (the
// coordinator's ReflexBook), exactly as test-find-live.mjs. commands run as the operator before the first call, from the
// body's start (execute at the body: ~ is its feet), to cut a gap for a bridge. A call's target.at may hold "~dx" strings,
// resolved against the start cell. The real NativeToolRuntime runs each call; a background step (do_step build) is waited
// on until its action ends. No model call is made. Ground truth from operator reads, never shown to the body: expect
// "portal" checks a nether_portal block in the opening the result names; "pillar"/"bridge" check the feet against the
// start; expectCode names the result code a refusal or hand-back must end with. Every spot also needs no death, no damage,
// no fire or lava contact and no fall of 3+ blocks (row.pass). Every 0.5 s the sampler reads the body's position, Fire ticks and whether its feet or head are in lava or fire.
// startAt {x, z} moves the body to the surface there (startAt {x, y, z}: to that cell) before the calls (a cast spot starts within 64 blocks of a surveyed
// lava pool, survey-spawn-lava.mjs). barSeconds adds row.bar: a lit portal within that many seconds, no death, no burning.
// A chain from fresh spawn (portal-chain-spots.json): inventory [] starts with nothing; totalMs bounds the whole chain
// (each obtain, find or build gets what is left); a call's target may be "$opening", the cell a lit build named, or "$lava", the
// lava cell the last find named (travel_to its level, within 2 blocks, at most 60 s); a call's
// recover {code: [calls]} runs those calls when it ends with that code, then the call again (as the model's next turns
// would: BUILD_SHORT of blocks, obtain cobblestone; a key "CODE:phrase" applies only when the message holds the phrase); retry.answer flees a named creeper or fights another named hostile
// before the retry; expect "nether" passes when the body stands in the Nether at the end.
// A call { command } is an operator command run at the body (execute as it at it), not a body step: a setup between steps,
// such as fresh pickaxes after a dig down that placed the body. A call with setup: true is not timed against the bar.
// expect "water" (water-underground-spots.json): the body holds a water bucket within waterSeconds (default 180) of the
// first obtain water_bucket call, the model's retries included, with no death and no drowning (the sampler's Air never
// reaches 0, and at least one Air sample was read; row.waterHurt is the health lost from the first water call on, any cause).
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME. BUILD_ONLY=a,b runs only those spots.
// CHAIN_TOTAL_MS=5400000 gives each chain 90 minutes instead of its totalMs. CHAIN_STEP_MS (default 25 minutes for a
// chain) ends a run whose one step, its retries and recovery calls included, runs longer: row.ended 'stuck at <step>'.
// FIXTURE_TICK_RATE runs play faster: setup stays at 20 TPS (its idle waits pass at the fixture rate) and every deadline and
// wait during play is game time on the fixture clock (s.clock), so a raised rate plays the same game. row.seconds is game
// seconds, row.wallSeconds wall seconds, row.rates the rate asked for and reached.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { NativeToolRuntime } from '../../coordinator/src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../../coordinator/src/native-minecraft-tools.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { heldCounts } from '../../coordinator/src/obtain-plan.mjs';
import { HAND_SPEED_STONE } from '../../coordinator/src/obtain-runner.mjs';
import { InspectionClient } from '../../coordinator/src/inspection-client.mjs';
import { parseSavedWorldSpawn } from '../../coordinator/src/headless-world-spawn.mjs';
import { DEFAULT_REFLEXES, ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { fixtureTickRate } from './watch-replay.mjs';
import { gameClockFromObservations } from '../../coordinator/src/game-clock.mjs';
import { warmBoots } from './fixture-servers.mjs';
import { liveRecord } from './watch-replay.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { damageCounter, damageEvidence, replyNumber, deathCounter, deathEvidence } from './lib/damage-counter.mjs';
import { MOD_JAR } from './mod-jar.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log('Usage: test-build-live.mjs SPOTS.json OUT_DIR [JAR] [--strict|--descriptive]\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const [spotsFile, outArg, jarArg] = cli.filter(arg => !['--strict', '--descriptive'].includes(arg));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!spotsFile || !outArg || !template || !port || !process.env.JAVA_HOME) { console.error('Usage: SPOTS.json OUT_DIR [JAR] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME'); process.exit(2); }
const spots = JSON.parse(await readFile(spotsFile, 'utf8'));
const only = process.env.BUILD_ONLY ? new Set(process.env.BUILD_ONLY.split(',')) : null;
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Probe';
const number = replyNumber;
const results = [];

// Each spot gets its own server and world; the next one boots while this one plays, from the seed's cached world.
// The goal outlasts the spot: a 30-minute chain under a 1200 s goal lost its goal revision at 20 minutes.
// CHAIN_TOTAL_MS replaces a chain's totalMs (expect "nether") to see steps past its usual cap.
const totalMsOf = spot => spot.expect === 'nether' && Number(process.env.CHAIN_TOTAL_MS) > 0 ? Number(process.env.CHAIN_TOTAL_MS) : spot.totalMs;
const stepMsOf = spot => spot.expect === 'nether' ? Number(process.env.CHAIN_STEP_MS) > 0 ? Number(process.env.CHAIN_STEP_MS) : 1_500_000 : Infinity;
const goalSecondsOf = spot => Math.max(1200, Math.ceil((totalMsOf(spot) ?? 0) / 1000) + 600);
const cases = [...spots.entries()].filter(([, spot]) => !only || only.has(spot.name));
for await (const { item: [, spot], dir, server, error: bootError } of warmBoots(cases, ([index, spot]) => ({ dir: path.join(out, `spot-${index}`),
	options: { jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), template, port, world: null, seed: String(spot.seed), spawnMonsters: spot.monsters !== false, goalTicks: goalSecondsOf(spot) * 20, worldCache: true, tickRate: fixtureTickRate() } }),
	// BUILD_KEEP keeps each world, saved at stop, to inspect what was built; otherwise stopping deletes the ~150 MB world.
	{ keepWorld: process.env.BUILD_KEEP ? true : undefined })) {
	const goalSeconds = goalSecondsOf(spot);
	// A spot whose server failed to boot (ahead and again on demand) is recorded as invalid evidence below.
	const s = server;
	const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const health = async () => number(await s.command(`data get entity ${AGENT} Health`));
	// quality setup initializes qo_death; never infer historical deaths from current health.
	const deaths = () => deathCounter(text => s.command(text), AGENT);
	const row = { name: spot.name, seed: spot.seed, calls: [] };
	results.push(row);
	let sampling = false, sampler = null;
	try {
		row.startedAt = Date.now();
		if (!s) throw bootError;
		await s.normalRate();
		// level.dat holds the spawn: a cached world (hit or just saved) already has it on disk; only a server without the
		// cache must save first. The wait lets the world run as before, in less wall time at a raised fixture rate.
		if (s.worldCache === 'off') await s.command('save-all flush');
		await s.idleSleep(1500);
		const spawn = parseSavedWorldSpawn(await readFile(path.join(dir, 'server/world/level.dat')));
		row.spawn = spawn;
		let e = null;
		for (let attempt = 0; attempt < 3 && !e; attempt++) {
			const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
			await s.command(`forceload add ${spawn.x} ${spawn.z}`);
			for (let wait = 0; wait < 600 && !/time is/i.test(await s.command(`execute if loaded ${spawn.x} 0 ${spawn.z} run time query gametime`)); wait++) await sleep(100);
			await s.command(`execute positioned ${spawn.x} 0 ${spawn.z} positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${AGENT}`);
			e = await registered;
		}
		if (!e) throw new Error('agent never registered');
		s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start', 120_000);
		await s.command(`mineagen start ${AGENT} Survive for ${goalSeconds} seconds.`);
		s.record.goalRevision = (await started).payload.goalRevision;
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		const command = async text => ({ text: await s.command(text) });
		const setup = { dimension: 'minecraft:overworld', startAt: 'world_spawn', inventory: spot.inventory ?? [{ item: 'minecraft:bread', count: 8 }], mobs: [], commands: [], freezeUntilGoalStart: true };
		const receipt = await applyQualitySetup(setup, command, AGENT);
		await activateQualitySetup(receipt, command, { stage: 'goal-start' });
		await activateQualitySetup(receipt, command, { stage: 'first-decision' });
		await s.command('tick unfreeze').catch(() => {});
		await s.command(`difficulty ${spot.difficulty ?? 'normal'}`);
		if (spot.time !== undefined) await s.command(`time set ${spot.time}`);
		await s.idleSleep(1500);
		const commands = new Set();
		const inspections = new InspectionClient({ send: (type, agentId, payload) => s.bridge.send(type, agentId, payload) });
		s.bridge.on('inspection_result', message => { inspections.accept(message); });
		const runtime = new NativeToolRuntime({
			bridge: { send: async (type, agentId, payload) => {
				if (type === 'reflex_update') row.reflexSends = [...(row.reflexSends ?? []), { revision: payload.revision, rules: payload.rules?.length ?? 0 }];
				if (type === 'action_command') {
					commands.add(payload.actionId);
					const { timeoutMs: _t, discard: _d, ...args } = payload.arguments ?? {};
					row.actions = [...(row.actions ?? []), { atS: Math.round((s.clock.now() - (row.t0 ?? s.clock.now())) / 1000), type: payload.actionType, args }];
					console.log(`  [${spot.name}] +${row.actions.at(-1).atS}s ${payload.actionType} ${JSON.stringify(args)}`);
				}
				return s.bridge.send(type, agentId, payload);
			} },
			requestObservation: async () => { const payload = await s.observe(); return { eventSequence: payload.eventSequence, observation: adaptObservation(payload) }; },
			inspectObservation: async (rec, query) => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await inspections.request(rec, query) }),
			// The twelve default reflexes, armed at the first live sample as the coordinator arms them (dynamic-main).
			reflexBook: new ReflexBook({ defaults: DEFAULT_REFLEXES, ...(s.clock.rate === 20 ? {} : { now: () => s.clock.now() }) }),
			// At a raised rate the runtime times find, gather, obtain and wait in game time too (it feeds the clock its samples).
			...(s.clock.rate === 20 ? {} : { clock: gameClockFromObservations({ tickRate: s.clock.rate }) }),
		});
		const record = liveRecord(s, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' });
		s.bridge.on('observation', ev => { if (ev.agentId === record.agentId && ev.payload.ready) runtime.updateObservation(record, adaptObservation(ev.payload), { eventSequence: ev.payload.eventSequence }); });
		// A message the wire schema refused is dropped, connection kept (schema drift): count it, or the body loses
		// observations with no trace in the run (batch 1: far-sight rows marked flowing/small, fixed in #209).
		s.bridge.on('messageRejected', ev => {
			const key = String(ev?.error?.cause?.message ?? ev?.error?.message ?? 'unknown').slice(0, 160);
			row.rejected = { ...(row.rejected ?? {}), [key]: Math.max(row.rejected?.[key] ?? 0, ev?.count ?? 1) };
			console.log(`[${spot.name}] REJECTED ${ev?.type} x${ev?.count}: ${key}`);
		});
		s.bridge.on('action_result', ev => {
			if (ev.agentId !== record.agentId || !commands.has(ev.payload.actionId)) return;
			runtime.onActionResult(record, ev.payload);
			if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(ev.payload.state)) {
				const last = row.actions?.at(-1);
				if (last) Object.assign(last, { state: ev.payload.state, reasonCode: ev.payload.reasonCode, message: String(ev.payload.message ?? '').slice(0, 400) });
				console.log(`  [${spot.name}]   -> ${ev.payload.state} ${ev.payload.reasonCode ?? ''} ${String(ev.payload.message ?? '').slice(0, 220)}`);
			}
			s.bridge.send('action_result_ack', record.agentId, { goalRevision: record.goalRevision, actionId: ev.payload.actionId }).catch(() => {});
		});
		await s.observe();
		// The runtime resends its reflex rules when the mod reports they are missing.
		for (let wait = 0; wait < 100 && !((await s.observe()).reflexes?.rules?.length >= 12); wait++) await sleep(100);
		const reflexSample = (await s.observe()).reflexes;
		row.reflexes = reflexSample?.rules?.length ?? 0;
		if (spot.startAt?.y !== undefined) {
			const { x, y, z } = spot.startAt;
			await s.command(`forceload add ${x} ${z}`);
			for (let wait = 0; wait < 600 && !/time is/i.test(await s.command(`execute if loaded ${x} 0 ${z} run time query gametime`)); wait++) await sleep(100);
			row.teleport = String(await s.command(`tp ${AGENT} ${x + 0.5} ${y} ${z + 0.5}`)).slice(0, 160);
			await s.idleSleep(3000);
		} else if (spot.startAt) {
			// The first dry surface cell from startAt, then round the pool at the same distance in 45 degree steps.
			const r = spot.pool ? Math.hypot(spot.startAt.x - spot.pool.x, spot.startAt.z - spot.pool.z) : 0;
			const a0 = spot.pool ? Math.atan2(spot.startAt.z - spot.pool.z, spot.startAt.x - spot.pool.x) : 0;
			for (let k = 0; k < 8; k++) {
				const x = k === 0 || !spot.pool ? spot.startAt.x : Math.round(spot.pool.x + r * Math.cos(a0 + k * Math.PI / 4));
				const z = k === 0 || !spot.pool ? spot.startAt.z : Math.round(spot.pool.z + r * Math.sin(a0 + k * Math.PI / 4));
				await s.command(`forceload add ${x} ${z}`);
				for (let wait = 0; wait < 600 && !/time is/i.test(await s.command(`execute if loaded ${x} 0 ${z} run time query gametime`)); wait++) await sleep(100);
				row.teleport = String(await s.command(`execute as ${AGENT} positioned ${x} 0 ${z} positioned over motion_blocking_no_leaves run tp @s ~ ~ ~`)).slice(0, 160);
				await s.idleSleep(1500);
				const wet = !/passed/i.test(String(await s.command(`execute as ${AGENT} at @s unless block ~ ~ ~ water unless block ~ ~-1 ~ water unless block ~ ~-1 ~ lava unless block ~ ~-1 ~ ice`)));
				row.startTried = [...(row.startTried ?? []), { x, z, wet }];
				if (!wet || !spot.pool) break;
			}
			await s.idleSleep(1500);
		}
		console.log(`[${spot.name}] reflexes armed: ${row.reflexes} (${(reflexSample?.rules ?? []).map(rule => rule.id).join(',')}); sends ${JSON.stringify(row.reflexSends ?? [])}`);
		row.start = await pos();
		row.kit = (runtime.latestObservation?.(record)?.inventory?.items ?? adaptObservation(await s.observe()).inventory?.items ?? []).map(item => `${item.itemId.replace('minecraft:', '')}x${item.count}@${item.slot}`);
		console.log(`[${spot.name}] kit ${row.kit.join(' ')}`);
		if (spot.locate) row.located = String(await s.command(`execute positioned ${row.start.map(Math.floor).join(' ')} run locate ${spot.locate}`)).slice(0, 300);
		// skipBeyond: a target vanilla puts farther than this from the start is out of the search's reach; no search runs.
		const locatedAt = Number(/\((\d+) blocks? away\)/.exec(row.located ?? '')?.[1]);
		if (spot.skipBeyond !== undefined && !(locatedAt <= spot.skipBeyond)) {
			row.skipped = `nearest is ${Number.isFinite(locatedAt) ? `${locatedAt} blocks` : 'not located'} away, beyond ${spot.skipBeyond}`;
			console.log(`[${spot.name}] SKIPPED: ${row.skipped}`);
			continue;
		}
		for (const text of spot.commands ?? []) row.setup = [...(row.setup ?? []), String(await s.command(`execute as ${AGENT} at @s run ${text}`)).slice(0, 120)];
		if (spot.commands?.length) await s.idleSleep(1500);
		const startCell = row.start.map(Math.floor);
		const resolveAt = at => at === undefined ? undefined : Object.fromEntries(['x', 'y', 'z'].map((k, i) => [k, typeof at[k] === 'string' && at[k].startsWith('~') ? startCell[i] + Number(at[k].slice(1) || 0) : at[k]]));
		const readDamage = await damageCounter(text => s.command(text), AGENT);
		const damageBefore = await readDamage();
		await s.fastRate();
		// Play is timed on the fixture clock: game time, so every deadline and wait below covers the same game time at any
		// tick rate (plain wall time at 20 TPS).
		const now = () => s.clock.now();
		const healthBefore = await health(), deathsBefore = await deaths(), t0 = now(), wall0 = Date.now(), timer = await s.gameTimer();
		row.playStartedAt = wall0;
		row.t0 = t0;
		const trail = [];
		sampling = true;
		row.fireTicks = 0; row.lavaContact = 0; row.fireContact = 0; row.minAir = 300; row.airSamples = 0;
		// Samples start every 500 ms of game time from t0, whatever their reads cost: a raised rate packs more ticks into
		// the reads, and sleeping 500 ms after them spaced samples 11-12 ticks apart at 60 TPS, so the same drop read as a
		// bigger fall (cast-obi-2's worst fall: 2.8-2.9 blocks at 20 TPS, up to 3.0 at 60).
		let nextSample = t0;
		sampler = (async () => { while (sampling) {
			const p = await pos().catch(() => null); if (p) trail.push([...p, now() - t0]);
			const air = number(await s.command(`data get entity ${AGENT} Air`).catch(() => ''));
			if (Number.isFinite(air) && row.waterFrom !== undefined) { row.minAir = Math.min(row.minAir, air); row.airSamples++; }
			const fire = number(await s.command(`data get entity ${AGENT} Fire`).catch(() => '')); if (fire > 0) row.fireTicks++;
			for (const dy of ['~', '~1']) {
				if (/passed/i.test(String(await s.command(`execute as ${AGENT} at @s if block ~ ${dy} ~ minecraft:lava`).catch(() => '')))) row.lavaContact++;
				if (/passed/i.test(String(await s.command(`execute as ${AGENT} at @s if block ~ ${dy} ~ #minecraft:fire`).catch(() => '')))) row.fireContact++;
			}
			nextSample += 500;
			if (now() > nextSample) nextSample = now();
			await s.clock.sleep(nextSample - now());
		} })();
		row.totalMs = totalMsOf(spot);
		const totalEnd = row.totalMs === undefined ? Infinity : t0 + row.totalMs;
		// The step limit: one route step (its retries and recovery calls too) that has run this long is stuck.
		const stepMs = stepMsOf(spot), stepStarted = new Map();
		const stepOf = callIndex => String(callIndex).replace(/r$/, '');
		let stepEnd = Infinity, step = null;
		const stuck = () => {
			const main = spot.calls[Number(step)]?.arguments;
			const what = String(main?.target?.item ?? main?.target?.block ?? main?.target?.structure ?? main?.verb ?? step).replace('minecraft:', '');
			row.stuck = { step: Number(step), what, minutes: Math.round((now() - stepStarted.get(step)) / 6000) / 10 };
			row.ended = `stuck at ${what}`;
		};
		const left = () => Math.min(totalEnd, stepEnd) - now();
		const dimension = async () => String(await s.command(`data get entity ${AGENT} Dimension`).catch(() => '')).match(/"([^"]+)"/)?.[1] ?? null;
		let opening = null;
		// The lava cell the last find named ("lava seen at x,y,z"): a call's target "$lava" walks there (within 4 blocks).
		let lavaAt = null;
		// The model's next turn after a hand-back: flee a named creeper or archer, or any named hostile at 12 health or
		// less; fight another named hostile; with none named, the nearest hostile in sight is answered the same way (fled
		// when there are two or more); health 8 or less with no hostile within 16 blocks: heal (below); the same stop again
		// with no mob in sight (heard lava, a flooded tunnel): tunnel 8 blocks another way first; else let the reflexes act.
		// Then the step again.
		let lastStop = null;
		// One body step from an answer, waited to its end like a route step (a background step returns a handle).
		const run = async (name, args, tag) => {
			try {
				let done = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `answer-${tag}`, callId: `answer-${tag}`, tool: normalizeMinecraftToolCall(name, args) }, record);
				const handle = done?.actionId ?? done?.handle?.actionId;
				if (typeof handle === 'string' && ['RUNNING', 'PREPARING', 'ACCEPTED', 'STARTED'].includes(String(done?.state))) {
					const until = Math.min(now() + 420_000, totalEnd, stepEnd);
					while (!terminal.has(handle) && now() < until) await s.clock.sleep(500);
					done = terminal.get(handle) ?? { state: 'HARNESS_TIMEOUT' };
				}
				return done;
			} catch (error) { return { state: 'ERROR', reasonCode: error?.code ?? error?.message }; }
		};
		// Low health with no hostile near: heal as a player does. rest does not do it (by day it refuses REST_NOT_NIGHT,
		// underground it hands back UNDERGROUND at once, and it never eats), so: obtain beef when no food is carried, wall
		// in with carried stone, then eat whenever food is under 18 (vanilla heals only at 18+) and wait for health 14
		// (up to 90 s). Each heal goes in row.heals.
		const FOOD = /^minecraft:(cooked_[a-z]+|beef|porkchop|mutton|chicken|rabbit|bread|apple|baked_potato|carrot|sweet_berries)$/;
		const WALL = /^minecraft:(cobblestone|cobbled_deepslate|stone|deepslate|andesite|diorite|granite|tuff|netherrack|dirt|[a-z_]+_planks|[a-z_]+_log)$/;
		const wallRank = (id) => /_(planks|log)$/.test(id) ? 2 : id === 'minecraft:dirt' ? 1 : 0;
		const foodToHotbar = async (tag) => {
			const inv = adaptObservation(await s.observe()).inventory ?? {}, items = inv.items ?? [];
			const held = (slot) => slot === 'mainhand' || slot === 'offhand' || slot === 40 || Number.isInteger(slot) && slot <= 8;
			if (items.some((item) => FOOD.test(item.itemId) && held(item.slot))) return null;
			const one = items.filter((item) => FOOD.test(item.itemId) && Number.isInteger(item.slot) && item.slot > 8 && item.slot <= 35)
				.sort((a, b) => /cooked/.test(b.itemId) - /cooked/.test(a.itemId) || b.count - a.count)[0];
			if (!one) return null;
			const used = new Set(items.map((item) => item.slot === 'mainhand' ? inv.selectedSlot : item.slot).filter((slot) => Number.isInteger(slot) && slot <= 8));
			const free = [8, 7, 6, 5, 4, 3, 2, 1, 0].find((slot) => !used.has(slot)) ?? 8;
			const moved = await run('act', { actionType: 'select_tool', arguments: { sourceSlot: one.slot, hotbarSlot: free, expectedItemId: one.itemId, minRemainingDurability: 0 } }, `${tag}-hotbar`);
			return `${one.itemId.slice(10)} to hotbar ${free}: ${moved?.state} ${moved?.reasonCode ?? ''}`;
		};
		const heal = async (tag, cover = false) => {
			// A dead body sends no ready observation (s.observe throws TIMEOUT): read it as no sample.
			const started = now(), body = async () => { try { return adaptObservation(await s.observe()); } catch { return {}; } };
			let o = await body(), sill = null, walledIn = false, windowShut = null;
			const entry = { ...(cover ? { cover: true } : {}), before: o.player?.health, foodBefore: o.player?.foodLevel, steps: [] };
			let food = () => (o.inventory?.items ?? []).filter(item => FOOD.test(item.itemId)).sort((a, b) => /cooked/.test(b.itemId) - /cooked/.test(a.itemId));
			if (!cover && !food().length) {
				const got = await run('do_step', { verb: 'obtain', target: { item: 'minecraft:beef', count: 5, timeoutMs: Math.floor(Math.max(60_000, Math.min(300_000, left() - 60_000))) }, why: 'food to heal' }, `${tag}-food`);
				entry.steps.push(`obtain beef: ${got?.state} ${got?.reasonCode ?? ''}`);
				o = await body();
				// Still running past the harness wait: no second body action beside it.
				if (got?.state === 'HARNESS_TIMEOUT') food = () => [];
			}
			// Any full block a player would wall in with, 8 or more of one kind: stone kinds first (the body's own shelter list,
			// find-search.mjs SHELTER_BLOCKS), then dirt, then planks or logs (batches 1-6: 32 of 98 covers found no
			// cobblestone or dirt while the runs had mined andesite, diorite and granite).
			const stone = (o.inventory?.items ?? []).filter((item) => WALL.test(item.itemId) && item.count >= 8)
				.sort((a, b) => wallRank(a.itemId) - wallRank(b.itemId) || b.count - a.count)[0];
			if ((cover || food().length) && stone && o.player) {
				let [x, y, z] = [o.player.x, o.player.y, o.player.z].map(Math.floor);
				// The doorway faces away from the mob, read from the sample the walls go up in (after any creeper flee).
				const away = () => {
					const mob = cover && (o.entities ?? []).find((one) => one?.stableId === cover && Number.isFinite(one.x) && Number.isFinite(one.z));
					const [dx, dz] = mob ? [mob.x - o.player.x, mob.z - o.player.z] : [0, 1];
					return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'west' : 'east') : (dz > 0 ? 'north' : 'south');
				};
				let opening = away();
				const creeper = (o.entities ?? []).find((one) => one?.type === 'minecraft:creeper' && one.alive !== false && typeof one.stableId === 'string' && Math.hypot(one.x - o.player.x, one.y - o.player.y, one.z - o.player.z) <= 10);
				if (creeper) {
					const fled = await run('act', { actionType: 'flee_from', arguments: { targetId: creeper.stableId, distance: 16, timeoutMs: 12_000 } }, `${tag}-creeper`);
					entry.steps.push(`flee creeper first: ${fled?.state} ${fled?.reasonCode ?? ''}`);
					o = await body();
					const still = o.player && (o.entities ?? []).find((one) => one?.stableId === creeper.stableId && one.alive !== false && Math.hypot(one.x - o.player.x, one.y - o.player.y, one.z - o.player.z) <= 7);
					walledIn = fled?.reasonCode === 'WALLED_IN' && Boolean(o.player);
					if (!walledIn && (!o.player || still)) {
						Object.assign(entry, { after: o.player?.health, healed: o.player?.health > 8, seconds: Math.round((now() - started) / 1000) });
						entry.steps.push(o.player ? 'creeper still within 7 blocks: no walls' : 'no player sample');
						(row.heals ??= []).push(entry);
						console.log(`[${spot.name}] HEAL ${JSON.stringify(entry)}`);
						return `cover: ${entry.steps.join('; ')}`;
					}
					[x, y, z] = [o.player.x, o.player.y, o.player.z].map(Math.floor);
					opening = away();
				}
				let walled = walledIn ? { state: 'SUCCEEDED', reasonCode: 'WALLED_IN' } : await run('act', { actionType: 'build_shelter', arguments: { x, y, z, opening, itemId: stone.itemId, timeoutMs: 30_000 } }, `${tag}-wall`);
				entry.steps.push(`build_shelter ${opening}: ${walled?.state} ${walled?.reasonCode ?? ''}`);
				if (walled?.reasonCode === 'NO_STANDABLE_PATH') {
					await s.clock.sleep(1_000);
					o = await body();
					if (o.player) {
						[x, y, z] = [o.player.x, o.player.y, o.player.z].map(Math.floor);
						opening = away();
						walled = await run('act', { actionType: 'build_shelter', arguments: { x, y, z, opening, itemId: stone.itemId, timeoutMs: 30_000 } }, `${tag}-wall2`);
						entry.steps.push(`build_shelter again ${opening}: ${walled?.state} ${walled?.reasonCode ?? ''}`);
					}
				}
				// Walled in, the step's walks go nowhere: open the sill of the doorway again once healed (never natural stone).
				if (walled?.state === 'SUCCEEDED' && !walledIn) sill = { x: x + ({ east: 1, west: -1 }[opening] ?? 0), y, z: z + ({ south: 1, north: -1 }[opening] ?? 0), expectedBlockId: stone.itemId };
				if (sill) {
					const shut = await run('act', { actionType: 'place_block', arguments: { x: sill.x, y: sill.y + 1, z: sill.z, face: 'up', itemId: stone.itemId } }, `${tag}-shut`);
					entry.steps.push(`close window: ${shut?.state} ${shut?.reasonCode ?? ''}`);
					if (shut?.state === 'SUCCEEDED') windowShut = { x: sill.x, y: sill.y + 1, z: sill.z, expectedBlockId: stone.itemId };
				}
			} else if (cover) entry.steps.push(`no wall: ${(o.inventory?.items ?? []).filter((item) => WALL.test(item.itemId)).map((item) => `${item.itemId.slice(10)}x${item.count}`).join(' ') || 'no blocks to wall in with'}${o.player ? '' : ', no player sample'}`);
			let ate = 0, best = entry.before;
			const waitFrom = now();
			// Cover with no walls up waits for nothing: the step again (the mob is answered there).
			while ((!cover || sill || walledIn) && now() - waitFrom < (cover ? 60_000 : 90_000) && left() > 60_000) {
				o = await body();
				// Healed, or hurt while waiting (a mob found the body): hand back to the next answer.
				// Hurt is measured from the best health reached while eating, not the health the heal started at.
				best = Math.max(best, o.player?.health ?? best);
				if (!(o.player?.health < 14) || o.player.health < best - 1) break;
				if (o.player.foodLevel < 18 && (food().length || !cover)) {
					if (!food().length) break;
					const moved = await foodToHotbar(`${tag}-f${ate}`);
					if (moved) entry.steps.push(moved);
					await run('act', { actionType: 'select_item', arguments: { itemId: food()[0].itemId } }, `${tag}-sel${ate}`);
					await run('act', { actionType: 'use_item', arguments: { mode: 'hold', durationMs: 2_000 } }, `${tag}-eat${ate++}`);
				} else await s.clock.sleep(3_000);
			}
			if (windowShut) {
				const reopened = await run('act', { actionType: 'break_block', arguments: { ...windowShut, timeoutMs: 15_000 } }, `${tag}-window`);
				entry.steps.push(`open window: ${reopened?.state} ${reopened?.reasonCode ?? ''}`);
			}
			if (sill) {
				const opened = await run('act', { actionType: 'break_block', arguments: { ...sill, timeoutMs: 15_000 } }, `${tag}-open`);
				entry.steps.push(`open sill: ${opened?.state} ${opened?.reasonCode ?? ''}`);
			}
			o = await body();
			Object.assign(entry, { after: o.player?.health, foodAfter: o.player?.foodLevel, ate, seconds: Math.round((now() - started) / 1000), healed: o.player?.health > 8 });
			(row.heals ??= []).push(entry);
			console.log(`[${spot.name}] HEAL ${JSON.stringify(entry)}`);
			return `${cover ? 'cover' : 'heal'} ${entry.before} -> ${entry.after} health, food ${entry.foodBefore} -> ${entry.foodAfter}, ate ${ate} in ${entry.seconds}s${entry.steps.length ? ` (${entry.steps.join('; ')})` : ''}`;
		};
		// Round 5 shield: after an archer stop, carry a shield in the off hand (the body raises it: default-arrow at a shot,
		// fight_target's shot guard). obtain plans it from scratch (1 iron ingot, 6 planks); once per run unless it is lost.
		const ARCHER = /^(skeleton|stray|bogged|parched|pillager)$/;
		let archerSeen = false, shieldTried = false, shieldHeld = false;
		const shield = async (tag) => {
			const items = async () => adaptObservation(await s.observe()).inventory;
			let inv = await items();
			if ((inv?.items ?? []).some((item) => (item.slot === 40 || item.slot === 'offhand') && item.itemId === 'minecraft:shield')) { shieldHeld = true; return null; }
			if (shieldHeld) shieldHeld = shieldTried = false;
			const said = [];
			const carried = () => (inv?.items ?? []).find((item) => item.itemId === 'minecraft:shield');
			if (!carried() && !shieldTried) {
				shieldTried = true;
				const got = await run('do_step', { verb: 'obtain', target: { item: 'minecraft:shield', timeoutMs: Math.floor(Math.max(60_000, Math.min(300_000, left() - 60_000))) }, why: 'a shield against arrows' }, `${tag}-shield`);
				said.push(`obtain shield: ${got?.state} ${got?.reasonCode ?? ''}`);
				inv = await items();
			}
			const one = carried();
			// The held hotbar slot shows as 'mainhand' in observations: its number is the inventory's selectedSlot.
			const slot = one?.slot === 'mainhand' ? inv?.selectedSlot : one?.slot;
			if (Number.isInteger(slot) && slot >= 0 && slot <= 35) {
				const put = await run('act', { actionType: 'equip_item', arguments: { sourceSlot: slot, targetSlot: 'offhand', expectedItemId: 'minecraft:shield' } }, `${tag}-offhand`);
				said.push(`equip offhand: ${put?.state} ${put?.reasonCode ?? ''}`);
				shieldHeld = put?.state === 'SUCCEEDED';
			}
			return said.length ? said.join('; ') : null;
		};
		const answer = async (message, tag) => {
			const named = /minecraft:([a-z_]+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(String(message ?? ''));
			const stop = String(message ?? '').replace(/-?\d+/g, '#').slice(0, 90);
			const again = stop === lastStop;
			lastStop = stop;
			let act;
			// No mob named ("2 hostiles after it"): the nearest hostile in the latest sample, as the model sees it in its
			// facts; fled when there are two or more, else answered as a named one.
			let near = null;
			const o = runtime.latestObservation?.(record)?.observation ?? adaptObservation(await s.observe());
			const at = o?.player ?? o?.position;
			const away = (id) => { const one = (o?.entities ?? []).find((row) => row?.stableId === id && [row.x, row.y, row.z].every(Number.isFinite)); return one && at ? Math.hypot(one.x - at.x, one.y - at.y, one.z - at.z) : null; };
			if (/\b(skeleton|stray|bogged|parched|pillager)\b/.test(String(message ?? ''))) archerSeen = true;
			if (!named) {
				const hostiles = (o?.entities ?? []).filter((row) => row?.hostile === true && row.alive !== false && typeof row.stableId === 'string' && [row.x, row.y, row.z].every(Number.isFinite)
					&& at && Math.hypot(row.x - at.x, row.y - at.y, row.z - at.z) <= 16).sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z));
				if (hostiles.length > 0) near = { type: String(hostiles[0].type).replace('minecraft:', ''), id: hostiles[0].stableId, many: hostiles.length > 1 };
				if (hostiles.some((row) => ARCHER.test(String(row.type).replace('minecraft:', '')))) archerSeen = true;
			}
			// Round 4: a lone ranged mob (an archer) is fought while health is above 8 (fleeing an archer got away 5 times
			// in 16); a creeper, witch, drowned or blaze, or two or more hostiles, are fled; another hostile is fought above
			// 12 health. Health 8 or less with a mob near, or a flee that did not get away: wall in and wait (cover).
			const mob = near ?? (named && { type: named[1], id: named[2], many: false });
			if (mob) {
				const hp = await health(), archer = !mob.many && ARCHER.test(mob.type);
				if (!(hp > 8)) return `${mob.type} near at health ${hp}: ${await heal(tag, mob.id)}`;
				const unarmed = /nothing to fight/i.test(String(message ?? '')) || !(o?.inventory?.items ?? []).some((item) => /_(sword|axe|pickaxe|shovel)$/.test(item.itemId));
				// An archer named but not in the sample is out of sight: not chased either.
				const far = archer && !(away(mob.id) <= 8);
				// A shield in the off hand goes up between swings (fight_target shield:true), as a player closes on an archer.
				const shielded = (o?.inventory?.items ?? []).some((item) => (item.slot === 40 || item.slot === 'offhand') && item.itemId === 'minecraft:shield');
				const flee = unarmed || far || mob.many || /^(creeper|witch|drowned|blaze)$/.test(mob.type) || (!archer && !(hp > 12));
				act = flee ? { actionType: 'flee_from', arguments: { targetId: mob.id, distance: 16, timeoutMs: 12_000 } }
					: { actionType: 'fight_target', arguments: { targetId: mob.id, ...(archer ? { fleeAtHealth: 8, ...(shielded ? { shield: true } : {}) } : {}), timeoutMs: 20_000 } };
			} else if (!(await health() > 8)) {
				return heal(tag);
			} else if (again) {
				act = { actionType: 'dig_to', arguments: { pattern: 'tunnel', heading: spot.retry?.heading ?? 'east', maxBlocks: 8, timeoutMs: 30_000 } };
			} else return null;
			// Waited to its end like run(): no second body action beside it.
			const done = await run('act', act, tag);
			const said = `${act.actionType} ${mob?.type ?? act.arguments.heading}: ${done?.state} ${done?.reasonCode ?? ''}`;
			if (!mob) return said;
			const escaped = act.actionType !== 'flee_from' || ['ESCAPED', 'TARGET_LOST', 'TARGET_GONE'].includes(done?.reasonCode) && !/no safe direction/i.test(String(done?.message ?? ''));
			if (!escaped || !(await health() > 8)) return `${said}; ${await heal(`${tag}-c`, mob.id)}`;
			return said;
		};
		const terminal = new Map();
		s.bridge.on('action_result', ev => { if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(ev.payload.state)) terminal.set(ev.payload.actionId, ev.payload); });
		const queue = [...(spot.calls ?? [])].map((call, index) => ({ call, index }));
		const recovered = new Map();
		calls: for (let next = 0; next < queue.length; next++) for (let attempt = 0; ; attempt++) {
			const { call, index: callIndex } = queue[next];
			step = stepOf(callIndex);
			if (!stepStarted.has(step)) stepStarted.set(step, now());
			stepEnd = stepStarted.get(step) + stepMs;
			if (now() >= stepEnd - 5_000 && stepEnd < totalEnd) { stuck(); break calls; }
			if (left() <= 5_000) { row.ended = 'out of time'; break calls; }
			// A setup step with untilY is skipped once the body stands at or below that y (an earlier dig got there).
			if (call.setup && call.untilY !== undefined && (await pos())?.[1] < call.untilY + 1) break;
			if (call.command !== undefined) {
				row.setup = [...(row.setup ?? []), String(await s.command(`execute as ${AGENT} at @s run ${call.command}`)).slice(0, 120)];
				break;
			}
			// A call { equip, to } puts a carried item in an equipment slot, as the model does with act equip_item from the
			// slot it sees (the route's shield goes in the off hand, slot 40 in observations). Already there: nothing to do.
			if (call.equip !== undefined) {
				const started = now(), obsInv = adaptObservation(await s.observe()).inventory ?? {}, inv = obsInv.items ?? [];
				const there = inv.some((item) => ((call.to === 'offhand' && item.slot === 40) || item.slot === call.to) && item.itemId === call.equip);
				// The held hotbar slot shows as 'mainhand' in observations: its number is the inventory's selectedSlot.
				const slotOf = (item) => item.slot === 'mainhand' ? obsInv.selectedSlot : item.slot;
				const one = inv.find((item) => item.itemId === call.equip && Number.isInteger(slotOf(item)) && slotOf(item) <= 35);
				const done = there ? { state: 'SUCCEEDED', reasonCode: 'ALREADY_EQUIPPED' } : one
					? await run('act', { actionType: 'equip_item', arguments: { sourceSlot: slotOf(one), targetSlot: call.to, expectedItemId: call.equip } }, `equip-${callIndex}`)
					: { state: 'FAILED', reasonCode: 'NOT_CARRIED' };
				row.calls.push({ call: 'equip', verb: 'equip', what: call.equip, atS: Math.round((started - t0) / 1000), seconds: Math.round((now() - started) / 1000), state: done?.state, reasonCode: done?.reasonCode });
				console.log(`[${spot.name}] +${row.calls.at(-1).atS}s equip ${call.equip} to ${call.to}: ${done?.state} ${done?.reasonCode ?? ''}`);
				break;
			}
			const callStarted = now();
			// The water window belongs to the water spots (expect "water"); a chain's water step has the step limit instead.
			const water = spot.expect === 'water' && call.arguments?.verb === 'obtain' && call.arguments?.target?.item === 'minecraft:water_bucket';
			const windowMs = (spot.waterSeconds ?? 180) * 1000;
			if (water && row.waterFrom !== undefined && now() - row.waterFrom >= windowMs) { row.ended = 'water window over'; break calls; }
			if (water && row.waterFrom === undefined) { row.waterFrom = callStarted; row.waterStart = await pos(); row.waterHealth = await health(); }
			let result;
			try {
				let args = typeof call.arguments?.target === 'object' && call.arguments.target.at ? { ...call.arguments, target: { ...call.arguments.target, at: resolveAt(call.arguments.target.at) } } : call.arguments;
				if (args?.target === '$lava') {
					if (!lavaAt) { row.ended = 'no lava named'; break calls; }
					// At the lava's own level, 2 across: travel's height band (3) then ends with the feet at most 3 above the surface,
					// a bucket's reach (bench b4-boat seed 5: one above with tolerance 4 'arrived' 3 above the pool, out of reach).
					args = { ...args, target: { x: lavaAt[0] + 0.5, y: lavaAt[1], z: lavaAt[2] + 0.5, tolerance: 2, timeoutMs: 60_000 } };
				}
				if (args?.target === '$opening') {
					if (!opening) { row.ended = 'no opening named'; break calls; }
					args = { ...args, target: { x: opening[0] + 0.5, y: opening[1], z: opening[2] + 0.5 } };
				}
				// "$meat": the raw meat of the nearest animal in the latest sample, as a player picks the cows or pigs in view;
				// beef when none is seen (obtain searches for it). Chicken last: raw chicken can poison.
				if (args?.target?.item === '$meat') {
					const o = adaptObservation(await s.observe()), at = o.player ?? {};
					const MEAT = { 'minecraft:cow': 'beef', 'minecraft:mooshroom': 'beef', 'minecraft:pig': 'porkchop', 'minecraft:sheep': 'mutton', 'minecraft:chicken': 'chicken' };
					const animal = (o.entities ?? []).filter((row) => MEAT[row?.type] && row.alive !== false && [row.x, row.z].every(Number.isFinite))
						.sort((a, b) => (a.type === 'minecraft:chicken') - (b.type === 'minecraft:chicken') || Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z))[0];
					// Only an animal in view is worth the detour, as a player takes the cow beside the spawn and goes on: none in
					// view, the step is skipped (batches 5-6: no animal in view, 2 of 17 found meat, 1.5-3 min each, and the
					// iron pickaxe came later, 6.8 -> 9-10 min median). In view: at most 75 s.
					if (!animal) {
						row.meat = { item: null, from: null, skipped: 'no animal in view' };
						row.calls.push({ call: call.name, verb: 'obtain', what: '$meat', atS: Math.round((callStarted - t0) / 1000), seconds: 0, state: 'SKIPPED', reasonCode: 'NO_ANIMAL_IN_VIEW', message: 'no cow, pig, sheep or chicken in view' });
						console.log(`[${spot.name}] food step skipped: no animal in view`);
						break;
					}
					args = { ...args, target: { ...args.target, item: `minecraft:${MEAT[animal.type]}`, timeoutMs: Math.min(args.target.timeoutMs ?? 75_000, 75_000) } };
					row.meat = { item: args.target.item, from: animal.type, distance: Math.round(Math.hypot(animal.x - at.x, animal.z - at.z)) };
				}
				if (Number.isFinite(totalEnd) && args?.target && typeof args.target === 'object' && ['obtain', 'find', 'build'].includes(args.verb)) {
					const cap = { obtain: [60_000, 1_800_000], find: [5_000, 570_000], build: [30_000, 600_000] }[args.verb];
					const want = Math.min(args.target.timeoutMs ?? cap[1], cap[1], left());
					if (want < cap[0]) { if (stepEnd < totalEnd) stuck(); else row.ended = 'out of time'; break calls; }
					args = { ...args, target: { ...args.target, timeoutMs: Math.floor(want) } };
				}
				// A retry gets what is left of the water window (obtain takes at least 60 s).
				if (water && row.waterFrom !== undefined && spot.expect === 'water') args = { ...args, target: { ...args.target, timeoutMs: Math.max(60_000, Math.floor(windowMs - (now() - row.waterFrom))) } };
				row.sent = [...(row.sent ?? []), args];
				result = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `build-live-${callIndex}-${attempt}`, callId: `build-${callIndex}-${attempt}`,
					tool: normalizeMinecraftToolCall(call.name, args) }, record);
				const handle = result?.actionId ?? result?.handle?.actionId;
				if (typeof handle === 'string' && ['RUNNING', 'PREPARING', 'ACCEPTED', 'STARTED'].includes(String(result?.state))) {
					const until = Math.min(now() + (spot.budgetMs ?? 420_000), totalEnd, stepEnd);
					while (!terminal.has(handle) && now() < until) await s.clock.sleep(500);
					result = terminal.get(handle) ?? { state: 'HARNESS_TIMEOUT', reasonCode: 'HARNESS_TIMEOUT', message: 'no terminal result' };
				}
			} catch (error) {
				result = { state: 'ERROR', reasonCode: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 600) };
			}
			if (water && result?.state === 'SUCCEEDED' && row.waterSeconds === undefined) row.waterSeconds = Math.round((now() - row.waterFrom) / 1000);
			const entry = { call: call.name, verb: call.arguments?.verb, what: call.arguments?.target?.item ?? call.arguments?.target?.block ?? call.arguments?.target?.structure ?? call.arguments?.actionType,
				atS: Math.round((callStarted - t0) / 1000), seconds: Math.round((now() - callStarted) / 1000), state: result?.state, reasonCode: result?.reasonCode,
				message: String(result?.message ?? '').slice(0, 1500), ...(result?.steps ? { steps: result.steps } : {}) };
			row.calls.push(entry);
			const lavaNamed = /lava seen at (-?\d+),(-?\d+),(-?\d+)/.exec(entry.message);
			if (lavaNamed && entry.state === 'SUCCEEDED' && entry.verb === 'find') lavaAt = lavaNamed.slice(1).map(Number);
			const named = /opening at (-?\d+),(-?\d+),(-?\d+)/.exec(entry.message);
			if (named && entry.state === 'SUCCEEDED') opening = named.slice(1).map(Number);
			if (spot.dump) await writeFile(path.join(dir, `call-${callIndex}.json`), JSON.stringify(result, null, 2));
			console.log(`[${spot.name}] +${entry.atS}s ${call.name} ${entry.state} ${entry.reasonCode} ${entry.seconds}s :: ${entry.message.slice(0, 600)}`);
			if ((await deaths()) > deathsBefore) { row.ended = 'death'; break calls; }
			// The meat the food step got, all or some, goes on the hotbar so the eat reflex and the heal can eat it.
			if (call.arguments?.target?.item === '$meat' && row.meat) row.meat.hotbar = await foodToHotbar(`meat-${callIndex}`).catch((error) => `failed: ${error.message}`);
			if (entry.state === 'SUCCEEDED') {
				// Front-half runs (CHAIN_STOP_AFTER=<item id>): the run ends once that item is obtained (ExamplePlayer, 12 Nov: kit first).
				if (process.env.CHAIN_STOP_AFTER && entry.verb === 'obtain' && entry.what === process.env.CHAIN_STOP_AFTER) { row.ended = 'kit done'; break calls; }
				break;
			}
			// Round 4: a worn or missing pickaxe, at any step and every time: make a stone pickaxe, then the step again
			// (not counted as a retry). A failed make falls through to the step's other answers. At most 6 per step: a make
			// that succeeds while the stop stays (a spare pickaxe off the hotbar) would otherwise loop to the step limit.
			// The step's own stop may not name the tool (find hands back 'digs went nowhere'), but the last answer's dig said
			// it: no pickaxe. Batches r0-b6: 124 answers in 29 runs failed NO_TOOL/TOOL_WORN before any pickaxe was made.
			const answerSaidTool = row.retries?.at(-1)?.call === callIndex && /FAILED (NO_TOOL|TOOL_WORN)\b/.test(String(row.retries.at(-1).answered ?? ''));
			if ((answerSaidTool || ['NO_TOOL', 'TOOL_WORN'].includes(entry.reasonCode) || /\b(TOOL_WORN|NO_TOOL)\b|\bpickaxe (is |was )?(worn|missing)|\b(worn[- ]out|missing|no usable) ([a-z_:]+ )?pickaxe/i.test(entry.message) || HAND_SPEED_STONE.test(entry.message))
				&& (row.toolFixes ?? []).filter((fix) => stepOf(fix.call) === step).length < 6) {
				const sound = heldCounts(adaptObservation(await s.observe())).get('stone_pickaxe') ?? 0;
				const make = (count, tag) => run('do_step', { verb: 'obtain', target: { item: 'minecraft:stone_pickaxe', count, timeoutMs: Math.floor(Math.max(60_000, Math.min(300_000, left() - 60_000))) }, why: count > sound + 1 ? 'two pickaxes to dig on with' : 'a pickaxe to dig on with' }, tag);
				let made = await make(sound + 2, `${callIndex}-${attempt}-tool`);
				// Cobblestone for one but not two (6 needed, and no sound pickaxe to mine more): one is still worth having.
				if (made?.state !== 'SUCCEEDED' && made?.state !== 'HARNESS_TIMEOUT' && !['DANGER', 'LOW_HEALTH', 'INTERRUPTED'].includes(made?.reasonCode) && made?.state !== 'INTERRUPTED' && (await deaths()) <= deathsBefore && left() > 90_000) made = await make(sound + 1, `${callIndex}-${attempt}-tool1`);
				row.toolFixes = [...(row.toolFixes ?? []), { call: callIndex, code: entry.reasonCode, state: made?.state, reasonCode: made?.reasonCode }];
				console.log(`[${spot.name}] TOOL ${entry.reasonCode} -> obtain stone_pickaxe: ${made?.state} ${made?.reasonCode ?? ''} ${String(made?.message ?? '').slice(0, 300)}`);
				if ((await deaths()) > deathsBefore) { row.ended = 'death'; break calls; }
				// Still running past the harness wait (the step's time is up): no second body action beside it.
				if (made?.state === 'HARNESS_TIMEOUT') { row.ended = 'tool timeout'; break calls; }
				if (made?.state === 'SUCCEEDED') { attempt--; continue; }
			}
			// retry {codes, times, waitMs}: a danger hand-back is answered as the model's next turn would, by calling the
			// same step again after a pause (the reflexes act meanwhile). Each retry is counted in row.retries.
			// LOW_HEALTH too when the script answers: the heal is the answer to it.
			// once: a step tried one time (the walk to the lava before a rebuild): no retries; with optional the chain goes on.
			if (!call.once && (spot.retry?.codes?.includes(entry.reasonCode) || spot.retry?.answer && entry.reasonCode === 'LOW_HEALTH') && attempt < (spot.retry.times ?? 2)) {
				const heals = row.heals?.length ?? 0;
				// A death during the answer (a dead body sends no observation) is a death, not a harness error.
				const answered = spot.retry.answer ? await answer(entry.message, `${callIndex}-${attempt}`).catch(async (error) => { if ((await deaths()) > deathsBefore) return `died during the answer (${error.message})`; throw error; }) : null;
				row.retries = [...(row.retries ?? []), { call: callIndex, code: entry.reasonCode, ...(answered ? { answered } : {}) }];
				if ((await deaths()) > deathsBefore) { row.ended = 'death'; break calls; }
				let healFailed = row.heals?.length > heals && !row.heals.at(-1).healed;
				// A cover that stalled only for want of food (none carried, food under 18: vanilla heals only at 18+) with no
				// hostile within 16 blocks: go and get some once per step, as row 12's heal does (batch 3: 3 of 3 'could not
				// heal' ends were safe covers that gained about 1 health while food fell 20 -> 17). Then the usual check.
				const stalled = healFailed && row.heals.at(-1).cover && !(row.heals.at(-1).foodAfter >= 18) && !(row.foodRuns ?? []).includes(step);
				if (stalled) {
					const o = await s.observe().then(adaptObservation).catch(() => ({}));
					const at = o.player;
					const carried = (o.inventory?.items ?? []).some((item) => FOOD.test(item.itemId));
					const near = at && (o.entities ?? []).some((one) => one?.hostile === true && one.alive !== false && [one.x, one.y, one.z].every(Number.isFinite) && Math.hypot(one.x - at.x, one.y - at.y, one.z - at.z) <= 16);
					if (at && !carried && !near && at.health > 0) {
						row.foodRuns = [...(row.foodRuns ?? []), step];
						const fed = await heal(`${callIndex}-${attempt}-food`).catch(async (error) => { if ((await deaths()) > deathsBefore) return `died during the food run (${error.message})`; throw error; });
						row.retries.at(-1).answered = `${row.retries.at(-1).answered ?? ''}; food run: ${fed}`;
						if ((await deaths()) > deathsBefore) { row.ended = 'death'; break calls; }
						healFailed = !row.heals.at(-1).healed;
					}
				}
				if (healFailed) { row.ended = 'could not heal'; break calls; }
				if (spot.retry.answer && archerSeen) {
					const shielded = await shield(`${callIndex}-${attempt}`).catch(async (error) => { if ((await deaths()) > deathsBefore) return null; throw error; });
					if (shielded) { row.shields = [...(row.shields ?? []), { call: callIndex, steps: shielded }]; console.log(`[${spot.name}] SHIELD ${shielded}`); }
					if ((await deaths()) > deathsBefore) { row.ended = 'death'; break calls; }
				}
				await s.clock.sleep(spot.retry.waitMs ?? 5000);
				continue;
			}
			// A refusal the model answers with other steps first (blocks short for the mould: obtain them), then this one again.
			// A recover key "CODE:phrase" answers that code only when the message holds the phrase, before the plain "CODE".
			const recoverKey = Object.keys(call.recover ?? {}).find((key) => key.startsWith(`${entry.reasonCode}:`) && entry.message.includes(key.slice(entry.reasonCode.length + 1))) ?? entry.reasonCode;
			const fix = call.recover?.[recoverKey];
			if (fix && !recovered.has(`${callIndex}:${recoverKey}`)) {
				recovered.set(`${callIndex}:${recoverKey}`, true);
				queue.splice(next, 0, ...fix.map((one) => ({ call: one, index: `${callIndex}r` })));
				next -= 1;
				break;
			}
			// A setup step that stopped short (a dig down that met water or a cave) leaves the body where it is: the next step
			// starts from there.
			if (call.setup) break;
			// An optional route step (the shield) that could not be done: the chain goes on without it, as a player would.
			if (call.optional) { (row.skipped ??= []).push({ call: callIndex, code: entry.reasonCode }); break; }
			break calls;
		}
		const last = row.calls.at(-1);
		// A step that failed at its step limit (its own timeout was cut to it) is stuck too.
		if (!row.ended && last && last.state !== 'SUCCEEDED' && step !== null && stepEnd < totalEnd && now() >= stepEnd - 15_000) stuck();
		row.built = last?.state === 'SUCCEEDED';
		if (spot.expect === 'portal') {
			const opening = /opening at (-?\d+),(-?\d+),(-?\d+)/.exec(last?.message ?? '');
			row.portalBlock = opening ? /passed/i.test(String(await s.command(`execute if block ${opening[1]} ${opening[2]} ${opening[3]} minecraft:nether_portal`))) : false;
			row.lit = row.built && last.reasonCode === 'PORTAL_LIT' && row.portalBlock;
		}
		if (spot.expect === 'nether') { await s.clock.sleep(3000); row.dimension = await dimension(); row.inNether = row.dimension === 'minecraft:the_nether'; }
		const endCell = (await pos())?.map(Math.floor);
		row.endCell = endCell;
		row.rose = endCell ? endCell[1] - startCell[1] : null;
		const goalAt = spot.calls.at(-1)?.arguments?.target?.at;
		if (spot.expect === 'bridge' && goalAt) { const goal = resolveAt(goalAt); row.leftToGoal = endCell ? Math.abs(goal.x - endCell[0]) + Math.abs(goal.z - endCell[2]) : null; }
		row.code = last?.reasonCode;
		sampling = false; await sampler;
		row.seconds = Math.round((now() - t0) / 1000);
		row.wallSeconds = Math.round((Date.now() - wall0) / 1000);
		row.gameSeconds = Math.round((await timer.elapsed()) / 1000);
		// What the run really played at: the rate asked for and game ticks per wall second over play.
		row.rates = await timer.rates().catch(() => null);
		let walked = 0, farthest = 0;
		for (let i = 1; i < trail.length; i++) walked += Math.hypot(trail[i][0] - trail[i - 1][0], trail[i][2] - trail[i - 1][2]);
		for (const p of trail) farthest = Math.max(farthest, Math.hypot(p[0] - trail[0][0], p[2] - trail[0][2]));
		const end = trail.at(-1) ?? row.start;
		row.path = { walked: Math.round(walked), net: Math.round(Math.hypot(end[0] - row.start[0], end[2] - row.start[2])), farthest: Math.round(farthest),
			descended: Math.round(row.start[1] - Math.min(...trail.map(p => p[1]), row.start[1])), samples: trail.length };
		row.end = await pos();
		const healthAfter = await health();
		Object.assign(row, damageEvidence(damageBefore, await readDamage(), healthBefore, healthAfter));
		const deathResult = deathEvidence(deathsBefore, await deaths());
		row.deaths = deathResult.deaths;
		row.deathEvidence = deathResult;
		if (!deathResult.valid) (row.integrity ??= []).push({ file: 'qo_death', error: 'Missing or decreasing death counter' });
		row.finishedAt = Date.now();
		// A fall: 3+ blocks down between two 0.5 s samples (vanilla fall damage starts above 3; walking down steps drops 1-2).
		row.fell = 0;
		for (let i = 1; i < trail.length; i++) row.fell = Math.max(row.fell, Math.round((trail[i - 1][1] - trail[i][1]) * 10) / 10);
		// pass: the spot's expectation held and the body came to no harm (no death, damage, fire or lava, no fall of 2+).
		const safe = row.deaths === 0 && row.damageTaken === 0 && row.lavaContact === 0 && row.fireContact === 0 && row.fell < 3;
		const met = spot.expectCode ? row.code === spot.expectCode
			: spot.expect === 'portal' ? row.lit === true
			: spot.expect === 'nether' ? row.inNether === true
			: spot.expect === 'pillar' ? row.built && row.rose === (spot.calls.at(-1).arguments.target.size ?? 4)
			: spot.expect === 'bridge' ? row.built && row.leftToGoal <= 1
			: spot.expect === 'noharm' ? true
			: spot.expect === 'water' ? row.waterSeconds !== undefined && row.waterSeconds <= (spot.waterSeconds ?? 180)
			: row.built;
		// A chain from fresh spawn meets mobs on the way: its bar is the Nether with no death.
		if (spot.expect === 'water') row.waterHurt = Number.isFinite(row.waterHealth) && Number.isFinite(healthAfter) ? Math.max(0, row.waterHealth - healthAfter) : null;
		row.pass = Boolean(met && (spot.expect === 'nether' ? row.deaths === 0
			: spot.expect === 'water' ? row.deaths === 0 && row.airSamples > 0 && row.minAir > 0 : safe));
		if (spot.barSeconds !== undefined) row.bar = Boolean(row.lit && row.deaths === 0 && row.fireTicks === 0 && row.lavaContact === 0 && row.fireContact === 0 && row.seconds <= spot.barSeconds);
		await writeFile(path.join(dir, 'trail.json'), JSON.stringify(trail));
		if (spot.expect === 'water') console.log(`[${spot.name}] WATER filled=${row.waterSeconds ?? 'no'}s from y${row.waterStart?.[1]?.toFixed(1)} minAir=${row.minAir} (${row.airSamples} samples) waterHurt=${row.waterHurt}`);
		console.log(`[${spot.name}] ${row.built ? 'BUILT' : 'NOT BUILT'}${spot.expect === 'portal' ? ` lit=${row.lit}` : ''}${row.rose !== undefined ? ` rose=${row.rose}` : ''}${row.leftToGoal !== undefined ? ` leftToGoal=${row.leftToGoal}` : ''} code=${row.code} fell=${row.fell} PASS=${row.pass}${row.bar === undefined ? '' : ` BAR=${row.bar}`} in ${row.seconds}s walked=${row.path.walked} damageTaken=${row.damageTaken ?? "unknown"} deaths=${row.deaths} fireTicks=${row.fireTicks} lavaContact=${row.lavaContact} fireContact=${row.fireContact}`);
	} catch (error) {
		row.error = String(error?.stack ?? error).slice(0, 1200);
		console.log(`[${spot.name}] ERROR ${row.error.split('\n')[0]}`);
	} finally {
		sampling = false; await sampler?.catch(() => {});
		if (s) row.tick = { rate: s.tickRate, held: await s.tickReport() };
		try { if (s) await s.stop(); } catch (error) { (row.integrity ??= []).push({ file: 'cleanup', error: error.message }); }
		await finishRun(results, { file: path.join(out, 'result.json'), planned: spots.filter(spot => !only || only.has(spot.name)).length, strict });
	}
}
console.log(JSON.stringify(await finishRun(results, { file: path.join(out, 'result.json'), planned: spots.filter(spot => !only || only.has(spot.name)).length, strict })));
