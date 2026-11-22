// Provider-free find check: node scripts/quality/test-find-live.mjs SPOTS.json OUT_DIR [JAR]
// SPOTS.json: [{ name, seed, inventory?, calls: [{ name, arguments }], repeat?, repeatOn?, expectCode?, budgetMs?, monsters?, time? }], one fresh
// server per spot. The body starts at the world's generated spawn (a fresh vanilla start) with the given kit and the
// twelve default reflexes (the coordinator's ReflexBook). The real NativeToolRuntime runs each call against the server: the coordinator code a model
// call reaches, fed by the wire adapter's live-shaped samples. No model call is made. repeat: while the last call ended
// without its target (budget or danger handback) and budgetMs of the spot is left, the same call runs again: a find unless
// FIND_BLOCKED, another tool only on a reason code listed in the spot's repeatOn. Before each repeat the shared stand-in
// (lib/standin-policy.mjs) answers the stop's fork as the model would (fight or flee a hostile in the way, eat, a sound
// pickaxe, out of water); a FIND_BLOCKED find is asked again after its fork was answered. row.standin lists each choice.
// Verdict per spot (lib/find-spot.mjs): expectCode on the last call, else the find's sighting, else (a room with no find
// call) no damage; every spot needs no death, from vanilla's counters. locate (e.g. "structure #minecraft:village") records vanilla's nearest one from the start as ground
// truth for the report; the search never sees it; skipBeyond skips a spot whose nearest one lies farther. Reports per spot: each result, seconds, path walked against net displacement, the farthest
// point from the start, health lost and deaths. Each spot's world is deleted when it stops (server.log stays); ARENA_FIXTURE_KEEP=1
// keeps it, saved. Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME.
// setup: operator commands that build a fixture before the calls, {x}, {y}, {z} (with +n or -n; {x+0.5} is a cell's
// centre) standing for the body's block at spawn; after: { ms, commands } runs after setup. A call argument that is
// exactly such a placeholder becomes that number. expectDamageTaken: a survival room, judged on no death and exactly that
// damage (findSpotVerdict in lib/find-spot.mjs). finish: operator commands run when the calls end, their replies kept
// (scoreboard stats, inventory); callFinish: the same after every call. A call with wait: true (a background do_step)
// holds the next call until its body actions end. Every spot reports lavaSamples: trail samples with lava at the body's
// feet or head.
// reachBiome (e.g. "minecraft:warped_forest"): the spot passes when the body itself stands in that biome (its own sampled
// biome, timed in game ticks from the start: row.reachedTicks) within reachTicks (default 12000), not on FIND_SEEN; a
// FIND_SEEN from afar is followed by travel_to the seen cell and the call again, as a model does with a far sighting.
// row.reachedDuring names the call that was running ("find" or the fallback "travel_to"); row.passFind needs "find".
// locateDimension: run the ground-truth locate in that dimension (a Nether biome is located in the Nether).
// killMob (e.g. "minecraft:enderman"): the spot passes when the body kills one (the server's entity_killed) and does
// not die; repeats stop at the kill. row.kills counts kills by type, row.pearlsHeld the ender pearls held at the end.
// Production steering lives in run-incident.mjs; this body-only fixture cannot accept steer:true.
// FIXTURE_TICK_RATE runs play faster: setup stays at 20 TPS and every deadline and wait during play is game time on the
// fixture clock (s.clock), as is the runtime it drives, so a raised rate plays the same game. row.seconds is game
// seconds, row.wallSeconds wall seconds, row.rates the rate asked for and reached.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { NativeToolRuntime } from '../../coordinator/src/native-tool-runtime.mjs';
import { kitHabitEnabled } from '../../coordinator/src/kit-habit.mjs';
import { normalizeMinecraftToolCall } from '../../coordinator/src/native-minecraft-tools.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { InspectionClient } from '../../coordinator/src/inspection-client.mjs';
import { parseSavedWorldSpawn } from '../../coordinator/src/headless-world-spawn.mjs';
import { DEFAULT_REFLEXES, ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { warmBoots } from './fixture-servers.mjs';
import { liveRecord, fixtureTickRate } from './watch-replay.mjs';
import { gameClockFromObservations } from '../../coordinator/src/game-clock.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { damageCounter, damageEvidence, deathCounter, deathEvidence } from './lib/damage-counter.mjs';
import { isFindCall, shouldRepeat, findSpotVerdict, findSpotLabel, callEntry, awaitActionReceipts } from './lib/find-spot.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { standinFork, standinEntry, playStandin, STANDIN_POLICY_ON } from './lib/standin-policy.mjs';

const atBody = (text, at) => String(text).replace(/\{([xyz])([+-][\d.]+)?\}/g, (_, axis, offset) => String(at[axis] + Number(offset ?? 0)));

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log('Usage: test-find-live.mjs SPOTS.json OUT_DIR [JAR] [--strict|--descriptive]\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const [spotsFile, outArg, jarArg] = cli.filter(arg => !['--strict', '--descriptive'].includes(arg));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!spotsFile || !outArg || !template || !port || !process.env.JAVA_HOME) { console.error('Usage: SPOTS.json OUT_DIR [JAR] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME'); process.exit(2); }
const spots = JSON.parse(await readFile(spotsFile, 'utf8'));
const only = process.env.FIND_ONLY ? new Set(process.env.FIND_ONLY.split(',')) : null;
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Probe';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const results = [];
const uuidOf = (text) => {
	const ints = /\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/.exec(String(text))?.slice(1).map(Number);
	if (!ints) return null;
	const hex = ints.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// Each spot gets its own server and world; the next one boots while this one plays, from the seed's cached world.
const cases = [...spots.entries()].filter(([, spot]) => !only || only.has(spot.name));
for await (const { item: [, spot], dir, server, error: bootError } of warmBoots(cases, ([index, spot]) => ({ dir: path.join(out, `spot-${index}`),
	options: { jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), template, port, world: null, seed: String(spot.seed), spawnMonsters: spot.monsters !== false, worldCache: true, tickRate: fixtureTickRate() } }))) {
	// A spot whose server failed to boot (ahead and again on demand) is recorded as invalid evidence below.
	const s = server;
	const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const health = async () => number(await s.command(`data get entity ${AGENT} Health`));
	// Vanilla's deathCount objective that the quality setup zeroes (qo_death); null when unreadable, never a guessed 0.
	const deaths = () => deathCounter(text => s.command(text), AGENT);
	const row = { name: spot.name, seed: spot.seed, calls: [] };
	if (spot.steer === true) { console.error('steer:true was removed; use run-incident.mjs through the production coordinator'); process.exitCode = 2; break; }
	results.push(row);
	let sampling = false, sampler = null;
	try {
		row.startedAt = Date.now();
		if (!s) throw bootError;
		await s.normalRate();
		await s.command('save-all flush');
		await s.idleSleep(1500);
		const spawn = parseSavedWorldSpawn(await readFile(path.join(dir, 'server/world/level.dat')));
		row.spawn = spawn;
		let e = null;
		for (let attempt = 0; attempt < 3 && !e; attempt++) {
			const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
			await s.command(`forceload add ${spawn.x} ${spawn.z}`);
			for (let wait = 0; wait < 60 && !/time is/i.test(await s.command(`execute if loaded ${spawn.x} 0 ${spawn.z} run time query gametime`)); wait++) await sleep(1000);
			await s.command(`execute positioned ${spawn.x} 0 ${spawn.z} positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${AGENT}`);
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
		// position: [x, y, z] starts the body there (on the surface) instead of at the world spawn: a playtest's own start.
		const setup = { dimension: 'minecraft:overworld', ...(Array.isArray(spot.position) ? { position: spot.position, surface: true } : { startAt: 'world_spawn' }),
			inventory: spot.inventory ?? [{ item: 'minecraft:bread', count: 8 }], mobs: [], commands: [], freezeUntilGoalStart: true };
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
					row.actions = [...(row.actions ?? []), { atS: Math.round((s.clock.now() - (row.t0 ?? s.clock.now())) / 1000), actionId: payload.actionId, type: payload.actionType, args }];
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
			// The kit habit as dynamic-main arms it: on unless MINEAGEN_KIT_HABIT=off.
			kitHabit: kitHabitEnabled(process.env),
		});
		const record = liveRecord(s, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' });
		s.bridge.on('observation', ev => {
			if (ev.agentId !== record.agentId || !ev.payload.ready) return;
			const observation = adaptObservation(ev.payload);
			runtime.updateObservation(record, observation, { eventSequence: ev.payload.eventSequence });
			// Standing in the biome, not passing through it: a body knocked or falling through it has not reached it.
			if (spot.reachBiome && row.t0 && row.reachedAtS === undefined && observation.world?.biome === spot.reachBiome && observation.player?.onGround !== false) {
				row.reachedAtS = Math.round((s.clock.now() - row.t0) / 1000);
				row.reachedDuring = row.currentCall ?? null;
				if (Number.isFinite(observation.world?.gameTime) && Number.isFinite(row.startTicks)) row.reachedTicks = observation.world.gameTime - row.startTicks;
				row.reachedAt = [observation.player?.x, observation.player?.y, observation.player?.z].map(n => Math.round(n));
				if (row.reachedTicks === undefined) s.command('time query gametime').then(text => { row.reachedTicks = Number(/time is (\d+)/i.exec(String(text))?.[1]) - row.startTicks; }).catch(() => {});
				console.log(`[${spot.name}] in ${spot.reachBiome} at +${row.reachedAtS}s ${row.reachedAt.join(',')}`);
			}
		});
		s.bridge.on('entity_killed', ev => {
			if (ev.agentId !== record.agentId || !row.t0) return;
			const type = ev.payload?.entityType;
			if (typeof type === 'string') row.kills = { ...(row.kills ?? {}), [type]: (row.kills?.[type] ?? 0) + 1 };
		});
		s.bridge.on('action_result', ev => {
			if (ev.agentId !== record.agentId || !commands.has(ev.payload.actionId)) return;
			runtime.onActionResult(record, ev.payload);
			if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(ev.payload.state)) {
				// The receipt goes on its own command, with the body's execution evidence (an admission rejection reports both false).
				const action = row.actions?.findLast(entry => entry.actionId === ev.payload.actionId);
				if (action) Object.assign(action, { state: ev.payload.state, reasonCode: ev.payload.reasonCode,
					...(typeof ev.payload.executionStarted === 'boolean' ? { executionStarted: ev.payload.executionStarted } : {}),
					...(typeof ev.payload.physicalAttempted === 'boolean' ? { physicalAttempted: ev.payload.physicalAttempted } : {}),
					message: String(ev.payload.message ?? '').slice(0, 2000) });
				console.log(`  [${spot.name}]   -> ${ev.payload.state} ${ev.payload.reasonCode ?? ''} ${String(ev.payload.message ?? '').slice(0, 220)}`);
				// FIND_ITEM_DIAG=1: 2 s after a vein or block break, where the dropped items really are and which the body lists.
				if (process.env.FIND_ITEM_DIAG === '1' && ['mine_vein', 'break_block'].includes(action?.type)) setTimeout(async () => {
					try {
						const truth = [];
						for (const sort of ['nearest', 'furthest']) truth.push(String(await s.command(`execute as Probe at @s run data get entity @e[type=minecraft:item,distance=..12,limit=1,sort=${sort}] Pos`)).slice(0, 160));
						const seen = adaptObservation(await s.observe());
						const listed = (seen.items ?? []).map(item => `${item.itemId}@${[item.x, item.y, item.z].map(v => Number(v).toFixed(1)).join(',')}`);
						const body = seen.player ? [seen.player.x, seen.player.y, seen.player.z, seen.player.yaw, seen.player.pitch].map(v => Number(v).toFixed(1)).join(',') : null;
						(row.itemDiag ??= []).push({ after: action.type, atS: action.atS, truth, listed, body });
						console.log(`  [${spot.name}] items after ${action.type}: truth ${truth.join(' | ')}; listed ${JSON.stringify(listed)}; body ${body}`);
					} catch (error) { console.log(`  [${spot.name}] item diag failed: ${error?.message ?? error}`); }
				}, 2_000);
			}
			s.bridge.send('action_result_ack', record.agentId, { goalRevision: record.goalRevision, actionId: ev.payload.actionId }).catch(() => {});
		});
		await s.observe();
		// The runtime resends its reflex rules when the mod reports they are missing.
		for (let wait = 0; wait < 20 && !((await s.observe()).reflexes?.rules?.length >= 12); wait++) await sleep(500);
		const reflexSample = (await s.observe()).reflexes;
		row.reflexes = reflexSample?.rules?.length ?? 0;
		console.log(`[${spot.name}] reflexes armed: ${row.reflexes} (${(reflexSample?.rules ?? []).map(rule => rule.id).join(',')}); sends ${JSON.stringify(row.reflexSends ?? [])}`);
		if (Array.isArray(spot.setup)) {
			const at = (await pos()).map(Math.floor), base = { x: at[0], y: at[1], z: at[2] };
			for (const text of spot.setup) {
				const reply = String(await s.command(atBody(text, base))).slice(0, 160);
				if (process.env.FIND_SETUP_LOG === "1" || /error|unknown|incorrect|expected|not loaded|no entity/i.test(reply)) console.log(`[${spot.name}] setup: ${atBody(text, base)} -> ${reply}`);
			}
			await s.idleSleep(spot.after?.ms ?? 1500);
			for (const text of spot.after?.commands ?? []) await s.command(atBody(text, base));
			row.fixtureAt = base;
			row.probe = [];
			for (const text of spot.probe ?? []) row.probe.push(String(await s.command(atBody(text, base))).slice(0, 200));
			if (row.probe.length) console.log(`[${spot.name}] probe ${row.probe.join(' | ')}`);
		}
		row.start = await pos();
		row.kit = (runtime.latestObservation?.(record)?.inventory?.items ?? adaptObservation(await s.observe()).inventory?.items ?? []).map(item => `${item.itemId.replace('minecraft:', '')}x${item.count}@${item.slot}`);
		console.log(`[${spot.name}] kit ${row.kit.join(' ')}`);
		// Ground truth for the report only (vanilla locate from the start; the search never sees it).
		if (spot.locate) row.located = String(await s.command(`execute ${spot.locateDimension ? `in ${spot.locateDimension} ` : ''}positioned ${row.start.map(Math.floor).join(' ')} run locate ${spot.locate}`)).slice(0, 300);
		// skipBeyond: a target vanilla puts farther than this from the start is out of the search's reach; no search runs.
		const locatedAt = Number(/\((\d+) blocks? away\)/.exec(row.located ?? '')?.[1]);
		if (spot.skipBeyond !== undefined && !(locatedAt <= spot.skipBeyond)) {
			row.skipped = `nearest is ${Number.isFinite(locatedAt) ? `${locatedAt} blocks` : 'not located'} away, beyond ${spot.skipBeyond}`;
			console.log(`[${spot.name}] SKIPPED: ${row.skipped}`);
			continue;
		}
		const readDamage = await damageCounter(text => s.command(text), AGENT);
		const damageBefore = await readDamage();
		await s.fastRate();
		// Play is timed on the fixture clock: game time, so every deadline and wait below covers the same game time at any
		// tick rate (plain wall time at 20 TPS).
		const now = () => s.clock.now();
		const healthBefore = await health(), deathsBefore = await deaths(), t0 = now(), wall0 = Date.now(), timer = await s.gameTimer();
		row.playStartedAt = wall0;
		const gameTime = async () => Number(/time is (\d+)/i.exec(String(await s.command('time query gametime')))?.[1]);
		row.startTicks = await gameTime();
		row.t0 = t0;
		const trail = [];
		sampling = true;
		row.lavaSamples = 0;
		const inLava = async () => /passed/i.test(String(await s.command(`execute at ${AGENT} if block ~ ~ ~ minecraft:lava`).catch(() => '')))
			|| /passed/i.test(String(await s.command(`execute at ${AGENT} if block ~ ~1 ~ minecraft:lava`).catch(() => '')));
		// Samples start every 500 ms of game time from t0, whatever their reads cost (as test-build-live.mjs).
		let nextSample = t0;
		sampler = (async () => { while (sampling) {
			const p = await pos().catch(() => null); if (p) trail.push([...p, now() - t0]);
			if (await inLava()) row.lavaSamples += 1;
			nextSample += 500;
			if (now() > nextSample) nextSample = now();
			await s.clock.sleep(nextSample - now());
		} })();
		const budgetMs = spot.budgetMs ?? 900_000;
		// The shared stand-in (lib/standin-policy.mjs) for a spot with repeat: before asking again it answers the stop's fork
		// (under water, a hostile in the way, hunger, a worn pickaxe, a blocked search tried once from another angle). Its
		// calls run to their receipts; every choice goes in row.standin.
		const standinRun = async (one, tag) => {
			let result;
			try {
				result = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `standin-${tag}`, callId: `standin-${tag}`,
					tool: normalizeMinecraftToolCall(one.name, one.arguments) }, record);
			} catch (error) { return { state: 'ERROR', reasonCode: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 300) }; }
			const handle = result?.actionId ?? result?.handle?.actionId;
			if (typeof handle === 'string' && ['RUNNING', 'PREPARING', 'ACCEPTED', 'STARTED'].includes(String(result?.state))) {
				// Waited to the call's own timeout and 30 s more; one still running then is cancelled, so the next call
				// never meets a busy body.
				const until = now() + (one.arguments?.arguments?.timeoutMs ?? one.arguments?.target?.timeoutMs ?? 60_000) + 30_000;
				const receipt = () => row.actions?.find(action => action.actionId === handle && action.state);
				while (!receipt() && now() < until) await s.clock.sleep(500);
				if (receipt()) return receipt();
				await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `standin-cancel-${tag}`, callId: `standin-cancel-${tag}`,
					tool: normalizeMinecraftToolCall('cancelAction', { actionId: handle, goalRevision: record.goalRevision }) }, record).catch(() => {});
				return { state: 'HARNESS_TIMEOUT', reasonCode: 'HARNESS_TIMEOUT' };
			}
			return result;
		};
		const standinAnswer = async (result, callIndex, attempt, used) => {
			if (!STANDIN_POLICY_ON) return null;
			let observation;
			try { observation = adaptObservation(await s.observe()); } catch { return null; }
			const decision = standinFork({ result, observation, used });
			const atS = Math.round((now() - t0) / 1000);
			if (!decision.fork) { (row.standin ??= []).push(standinEntry(decision, { atS, step: callIndex, code: result?.reasonCode })); return decision; }
			used[decision.fork] = (used[decision.fork] ?? 0) + 1;
			const outcomes = await playStandin(decision, { dead: async () => (await deaths()) > deathsBefore, run: (one, index) => {
				// Recovery stays inside the room budget: an obtain needs its 60 s minimum left, an act call gets at most what is left.
				const left = budgetMs - (now() - t0);
				if (left < (one.name === 'do_step' ? 60_000 : 10_000)) return { state: 'SKIPPED', reasonCode: 'ROOM_BUDGET', message: `${Math.round(left / 1000)} s of the room budget left` };
				const inner = one.arguments?.arguments;
				const args = one.name === 'do_step' ? { ...one.arguments, target: { ...one.arguments.target, timeoutMs: Math.max(60_000, Math.min(300_000, left - 30_000)) } }
					: Number.isFinite(inner?.timeoutMs) ? { ...one.arguments, arguments: { ...inner, timeoutMs: Math.min(inner.timeoutMs, Math.floor(left)) } } : one.arguments;
				return standinRun({ ...one, arguments: args }, `${callIndex}-${attempt}-${index}`);
			} });
			const entry = standinEntry(decision, { atS, step: callIndex, code: result?.reasonCode, outcomes });
			(row.standin ??= []).push(entry);
			console.log(`[${spot.name}] STANDIN ${entry.fork} ${entry.choice}: ${entry.why} -> ${entry.calls.map(one => `${one.type} ${one.state} ${one.reasonCode ?? ''}`.trim()).join('; ')}`);
			return decision;
		};
		for (const [callIndex, call] of (spot.calls ?? []).entries()) {
			const used = {};
			for (let attempt = 0; ; attempt++) {
				// A call with its own target timeoutMs (obtain) is not asked again with less than its 60 s minimum left of the
				// budget (normalizeObtain refuses shorter): the last answer stands.
				if (attempt > 0 && !isFindCall(call) && Number.isFinite(call.arguments?.target?.timeoutMs) && budgetMs - (now() - t0) < 60_000) {
					row.ended = 'under 60 s of the budget left for another ask'; break;
				}
				const callStarted = now();
				// "{item}": the UUID of the dropped item nearest the body now (pick_up_item takes a canonical UUID).
				const itemUuid = JSON.stringify(call.arguments).includes('"{item}"') ? uuidOf(await s.command(`data get entity @e[type=item,sort=nearest,limit=1] UUID`)) : null;
				let result;
				try {
					// A search never outruns the spot's budget: its timeoutMs is what is left of it (at most the 540 s default).
					const args = isFindCall(call)
						? { ...call.arguments, target: { ...call.arguments.target, timeoutMs: Math.max(10_000, Math.min(540_000, budgetMs - (now() - t0))) } }
						// A call argument that is exactly "{x+n}" (y, z) is the fixture's cell at spawn plus n, as a number.
						: row.fixtureAt ? JSON.parse(JSON.stringify(call.arguments).replace(/"(\{[xyz](?:[+-][\d.]+)?\})"/g, (_, text) => atBody(text, row.fixtureAt))
							.replace(/"\{item\}"/g, () => JSON.stringify(itemUuid))) : call.arguments;
					// Another call with its own target timeoutMs (an obtain asked again after danger) gets at most what is left of the
					// spot's budget too, so a room never passes on time an interruption added.
					const left = Math.max(60_000, budgetMs - (now() - t0));
					const bounded = !isFindCall(call) && Number.isFinite(args?.target?.timeoutMs) && args.target.timeoutMs > left
						? { ...args, target: { ...args.target, timeoutMs: left } } : args;
					row.currentCall = call.name === 'do_step' ? call.arguments.verb : call.name;
					result = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `find-live-${callIndex}-${attempt}`, callId: `find-${callIndex}-${attempt}`,
						tool: normalizeMinecraftToolCall(call.name, bounded) }, record);
				} catch (error) {
					result = { state: 'ERROR', reasonCode: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 600) };
				}
				const entry = callEntry(call, result, { attempt, atS: Math.round((callStarted - t0) / 1000), seconds: Math.round((now() - callStarted) / 1000) });
				row.calls.push(entry);
				// wait: a background step (do_step dig_to) finishes its body actions before the next call.
				if (call.wait === true && ['RUNNING', 'PREPARING'].includes(result?.state)
					&& (await awaitActionReceipts(row, { deadline: t0 + budgetMs, now, wait: ms => s.clock.sleep(ms), stopped: async () => (await deaths()) > deathsBefore })).length) {
					row.ended = 'background step unfinished at the budget'; break;
				}
				// callFinish: operator commands read after every call (a stat before the next call), replies kept on the entry.
				if (Array.isArray(spot.callFinish)) { entry.finish = []; for (const text of spot.callFinish) entry.finish.push({ command: text, reply: String(await s.command(text)).slice(0, 400) }); }
				if (spot.dump) await writeFile(path.join(dir, `call-${callIndex}-${attempt}.json`), JSON.stringify(result, null, 2));
				console.log(`[${spot.name}] +${entry.atS}s ${call.name}#${attempt} ${entry.state} ${entry.reasonCode} ${entry.seconds}s :: ${entry.message.slice(0, 300)}`);
				// A dead body, or one the server no longer samples, ends the spot.
				if ((await deaths()) > deathsBefore || /TIMEOUT observation/.test(entry.message)) { row.ended = 'death or lost observations'; break; }
				const found = result?.state === 'SUCCEEDED' && result?.reasonCode === 'FIND_SEEN';
				if (spot.reachBiome && row.reachedAtS !== undefined) break;
				if (spot.killMob && (row.kills?.[spot.killMob] ?? 0) >= 1) break;
				const seen = result?.find?.seen;
				if (spot.reachBiome && found && seen && seen.via !== 'standing in it' && now() - t0 < budgetMs - 10_000) {
					// A far sighting: the model's next call walks there (travel_to with its defaults), then finds again.
					const walkStarted = now();
					let walked;
					try {
						row.currentCall = 'travel_to';
						walked = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `find-live-go-${callIndex}-${attempt}`, callId: `go-${callIndex}-${attempt}`,
							tool: normalizeMinecraftToolCall('act', { actionType: 'travel_to', arguments: { x: seen.x + 0.5, y: seen.y + 1, z: seen.z + 0.5, tolerance: 3,
								timeoutMs: Math.max(10_000, Math.min(300_000, budgetMs - (now() - t0))) } }) }, record);
					} catch (error) { walked = { state: 'ERROR', reasonCode: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 300) }; }
					row.calls.push({ call: 'travel_to', attempt, atS: Math.round((walkStarted - t0) / 1000), seconds: Math.round((now() - walkStarted) / 1000), state: walked?.state, reasonCode: walked?.reasonCode, message: String(walked?.message ?? '').slice(0, 400) });
					if (row.reachedAtS !== undefined) break;
					continue;
				}
				// repeatBlocked: a model re-asks after FIND_BLOCKED too (seven-rods: 2-6 find calls a run); otherwise it stops there.
				const budgetLeftMs = budgetMs - (now() - t0);
				const blockedReask = spot.repeat && spot.repeatBlocked && result?.reasonCode === 'FIND_BLOCKED' && budgetLeftMs >= 10_000;
				// A blocked search is asked again only after the stand-in answered its fork (another angle, a sound pickaxe).
				const blockedFind = STANDIN_POLICY_ON && spot.repeat && isFindCall(call) && result?.reasonCode === 'FIND_BLOCKED' && budgetLeftMs >= 60_000;
				if (!blockedReask && !blockedFind && !shouldRepeat(call, result, spot, { budgetLeftMs })) break;
				// The provider-free stand-in for a model: give the reflexes a moment with danger, then ask again.
				if (['RUNNING', 'PREPARING'].includes(result?.state) && typeof result?.actionId === 'string') {
					await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `find-live-cancel-${callIndex}-${attempt}`, callId: `cancel-${callIndex}-${attempt}`,
						tool: normalizeMinecraftToolCall('cancelAction', { actionId: result.actionId, goalRevision: record.goalRevision }) }, record).catch(() => {});
				}
				const decision = await standinAnswer(result, callIndex, attempt, used);
				if ((await deaths()) > deathsBefore) { row.ended = 'death or lost observations'; break; }
				// A spot with repeatBlocked keeps re-asking after a blocked search as main does, fork or not.
				if (blockedFind && !blockedReask && !decision?.fork) break;
				// The recovery may have spent the budget: ask again only with the 10 s shouldRepeat needs.
				if (budgetMs - (now() - t0) < 10_000) break;
				// No fork answered: give the reflexes (and regeneration, when hurt) a moment, then ask again.
				if (result?.reasonCode === 'FIND_DANGER' && !decision?.fork) await s.clock.sleep((await health()) < 12 ? 15000 : 4000);
			}
			// A death, lost observations or an unfinished background step ends the spot: no later call runs.
			if (row.ended) break;
		}
		// The same classifier in both arms (STANDIN_POLICY on or off): the fork the policy sees on a repeat spot's last stop,
		// with no caps and nothing played. A failed spot whose standinEnd.fork is set ended at a fork the policy answers.
		const lastCall = row.calls.at(-1);
		if (spot.repeat && lastCall && lastCall.state !== 'SUCCEEDED') {
			const o = await s.observe().then(adaptObservation).catch(() => null);
			const end = standinFork({ result: lastCall, observation: o ?? {} });
			row.standinEnd = { code: lastCall.reasonCode, fork: end.fork, ...(end.choice ? { choice: end.choice } : {}), why: end.why, ...(row.ended ? { ended: row.ended } : {}) };
		}
		// A background step (do_step build) returned RUNNING: take the readings only once each command has its receipt.
		if (!row.ended) {
			const pending = await awaitActionReceipts(row, { deadline: t0 + budgetMs, now, wait: ms => s.clock.sleep(ms), stopped: async () => (await deaths()) > deathsBefore });
			if (pending.length) console.log(`[${spot.name}] no terminal receipt by the budget for ${pending.map(action => action.type).join(', ')}`);
		}
		sampling = false; await sampler;
		row.handBacks = row.calls.filter((entry) => entry.reasonCode === 'FIND_DANGER').length;
		row.seconds = Math.round((now() - t0) / 1000);
		row.wallSeconds = Math.round((Date.now() - wall0) / 1000);
		row.gameSeconds = Math.round((await timer.elapsed()) / 1000);
		// What the run really played at: the rate asked for and game ticks per wall second over play.
		row.rates = await timer.rates().catch(() => null);
		await s.normalRate();
		let walked = 0, farthest = 0;
		for (let i = 1; i < trail.length; i++) walked += Math.hypot(trail[i][0] - trail[i - 1][0], trail[i][2] - trail[i - 1][2]);
		for (const p of trail) farthest = Math.max(farthest, Math.hypot(p[0] - trail[0][0], p[2] - trail[0][2]));
		const end = trail.at(-1) ?? row.start;
		row.path = { walked: Math.round(walked), net: Math.round(Math.hypot(end[0] - row.start[0], end[2] - row.start[2])), farthest: Math.round(farthest),
			descended: Math.round(row.start[1] - Math.min(...trail.map(p => p[1]), row.start[1])), samples: trail.length };
		row.end = await pos();
		// finalProbe: ground-truth commands after the calls (eyes still lying in the world), {x},{y},{z} at the body's end.
		if (Array.isArray(spot.finalProbe)) {
			const at = { x: Math.floor(row.end[0]), y: Math.floor(row.end[1]), z: Math.floor(row.end[2]) };
			row.finalProbe = [];
			for (const text of spot.finalProbe) row.finalProbe.push(String(await s.command(atBody(text, at))).slice(0, 300));
		}
		if (Array.isArray(spot.finish)) { row.finish = []; for (const text of spot.finish) row.finish.push({ command: text, reply: String(await s.command(text)).slice(0, 4000) }); }
		const healthAfter = await health();
		Object.assign(row, damageEvidence(damageBefore, await readDamage(), healthBefore, healthAfter));
		row.healthLost = Number.isFinite(healthBefore) && Number.isFinite(healthAfter) ? Math.max(0, healthBefore - healthAfter) : null;
		const deathResult = deathEvidence(deathsBefore, await deaths());
		row.deaths = deathResult.deaths;
		if (!deathResult.valid) (row.integrity ??= []).push({ file: 'qo_death', error: 'Missing or decreasing vanilla death counter' });
		row.finishedAt = Date.now();
		row.tick = { rate: s.tickRate, held: await s.tickReport() };
		// found is null for a room with no find call; its verdict is then no death and no damage (lib/find-spot.mjs).
		// foundAtS comes from the same find entry that decides found.
		Object.assign(row, findSpotVerdict(spot, row));
		if (spot.killMob) {
			// A kill room is judged on the kill and no death; a pearl drop is vanilla's coin flip, reported, not judged.
			await sleep(1500);
			row.pearlsHeld = (adaptObservation(await s.observe()).inventory?.items ?? []).filter(item => item.itemId === 'minecraft:ender_pearl').reduce((n, item) => n + item.count, 0);
			const killed = (row.kills?.[spot.killMob] ?? 0) >= 1;
			row.pass = killed && row.deaths === 0;
			delete row.passReason; delete row.failReason;
			if (row.pass) { delete row.notExercised; row.passReason = `killed ${spot.killMob}, no death`; }
			else row.failReason = [killed ? null : `no ${spot.killMob} killed`, row.deaths !== 0 ? `${row.deaths} deaths` : null].filter(Boolean).join('; ');
		}
		if (spot.reachBiome) {
			// A crossing room is judged on the body standing in the biome in time, not on a sighting.
			const reachTicks = spot.reachTicks ?? 12_000;
			const reached = row.reachedTicks !== undefined && row.reachedTicks <= reachTicks;
			row.passAny = reached && row.deaths === 0;
			row.passFind = row.passAny && row.reachedDuring === 'find';
			row.travelFallbacks = row.calls.filter((entry) => entry.call === 'travel_to').length;
			row.pass = row.passAny;
			delete row.passReason; delete row.failReason;
			if (row.pass) { delete row.notExercised; row.passReason = `stood in ${spot.reachBiome} within ${reachTicks} ticks`; }
			else row.failReason = [reached ? null : `not in ${spot.reachBiome} within ${reachTicks} ticks`, row.deaths !== 0 ? `${row.deaths} deaths` : null].filter(Boolean).join('; ');
		}
		await writeFile(path.join(dir, 'trail.json'), JSON.stringify(trail));
		console.log(`[${spot.name}] ${findSpotLabel(row)} in ${row.foundAtS ?? row.seconds}s walked=${row.path.walked} net=${row.path.net} farthest=${row.path.farthest} descended=${row.path.descended} damageTaken=${row.damageTaken ?? "unknown"} deaths=${row.deaths} handBacks=${row.handBacks} lavaSamples=${row.lavaSamples}`);
	} catch (error) {
		row.error = String(error?.stack ?? error).slice(0, 1200);
		console.log(`[${spot.name}] ERROR ${row.error.split('\n')[0]}`);
	} finally {
		sampling = false; await sampler?.catch(() => {});
		let stopped = !s;
		try { if (s) await s.stop(); stopped = true; } catch (error) { (row.integrity ??= []).push({ file: 'cleanup', error: error.message }); }
		await finishRun(results, { file: path.join(out, 'result.json'), planned: spots.filter(spot => !only || only.has(spot.name)).length, strict });
	}
}
console.log(JSON.stringify(await finishRun(results, { file: path.join(out, 'result.json'), planned: spots.filter(spot => !only || only.has(spot.name)).length, strict })));
