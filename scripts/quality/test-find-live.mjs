// Provider-free find check: node scripts/quality/test-find-live.mjs SPOTS.json OUT_DIR [JAR]
// SPOTS.json: [{ name, seed, inventory?, calls: [{ name, arguments }], repeat?, budgetMs?, monsters?, time? }], one fresh
// server per spot. The body starts at the world's generated spawn (a fresh vanilla start) with the given kit and the
// twelve default reflexes (the coordinator's ReflexBook). The real NativeToolRuntime runs each call against the server: the coordinator code a model
// call reaches, fed by the wire adapter's live-shaped samples. No model call is made. repeat: while the last call ended
// without its target (budget or danger handback) and budgetMs of the spot is left, the same call runs again, as a model
// that only re-asks would. locate (e.g. "structure #minecraft:village") records vanilla's nearest one from the start as ground
// truth for the report; the search never sees it; skipBeyond skips a spot whose nearest one lies farther. Reports per spot: each result, seconds, path walked against net displacement, the farthest
// point from the start, health lost and deaths. Each spot's world is deleted when it stops (server.log stays); ARENA_FIXTURE_KEEP=1
// keeps it, saved. Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME.
// setup: operator commands that build a fixture before the calls, {x}, {y}, {z} (with +n or -n; {x+0.5} is a cell's
// centre) standing for the body's block at spawn; after: { ms, commands } runs after setup.
// reachBiome (e.g. "minecraft:warped_forest"): the spot passes when the body itself stands in that biome (its own sampled
// biome, timed in game ticks from the start: row.reachedTicks) within reachTicks (default 12000), not on FIND_SEEN; a
// FIND_SEEN from afar is followed by travel_to the seen cell and the call again, as a model does with a far sighting.
// row.reachedDuring names the call that was running ("find" or the fallback "travel_to"); row.passFind needs "find".
// Production steering lives in run-incident.mjs; this body-only fixture cannot accept steer:true.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { NativeToolRuntime } from '../../coordinator/src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../../coordinator/src/native-minecraft-tools.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { InspectionClient } from '../../coordinator/src/inspection-client.mjs';
import { parseSavedWorldSpawn } from '../../coordinator/src/headless-world-spawn.mjs';
import { DEFAULT_REFLEXES, ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { warmBoots } from './fixture-servers.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { damageCounter, damageEvidence } from './lib/damage-counter.mjs';

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

// Each spot gets its own server and world; the next one boots while this one plays, from the seed's cached world.
const cases = [...spots.entries()].filter(([, spot]) => !only || only.has(spot.name));
for await (const { item: [, spot], dir, server, error: bootError } of warmBoots(cases, ([index, spot]) => ({ dir: path.join(out, `spot-${index}`),
	options: { jar: path.resolve(jarArg ?? path.join(root, 'build/libs/mineagen-0.2.0.jar')), template, port, world: null, seed: String(spot.seed), spawnMonsters: spot.monsters !== false, worldCache: true } }))) {
	// A spot whose server failed to boot (ahead and again on demand) is recorded as invalid evidence below.
	const s = server;
	const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const health = async () => number(await s.command(`data get entity ${AGENT} Health`));
	// The scoreboard can miss a death; a dead (or respawning) player shows as no entity or zero health too.
	let diedSeen = 0;
	const deaths = async () => {
		const counted = number(await s.command(`scoreboard players get ${AGENT} deaths`)) || 0;
		const hp = number(await s.command(`data get entity ${AGENT} Health`));
		if (!(hp > 0)) diedSeen = Math.max(diedSeen, 1);
		return Math.max(counted, diedSeen);
	};
	const row = { name: spot.name, seed: spot.seed, calls: [] };
	if (spot.steer === true) { console.error('steer:true was removed; use run-incident.mjs through the production coordinator'); process.exitCode = 2; break; }
	results.push(row);
	let sampling = false, sampler = null;
	try {
		row.startedAt = Date.now();
		if (!s) throw bootError;
		await s.command('save-all flush');
		await sleep(1500);
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
		const setup = { dimension: 'minecraft:overworld', startAt: 'world_spawn', inventory: spot.inventory ?? [{ item: 'minecraft:bread', count: 8 }], mobs: [], commands: [], freezeUntilGoalStart: true };
		const receipt = await applyQualitySetup(setup, command, AGENT);
		await activateQualitySetup(receipt, command, { stage: 'goal-start' });
		await activateQualitySetup(receipt, command, { stage: 'first-decision' });
		await s.command('tick unfreeze').catch(() => {});
		await s.command(`difficulty ${spot.difficulty ?? 'normal'}`);
		if (spot.time !== undefined) await s.command(`time set ${spot.time}`);
		await sleep(1500);
		const commands = new Set();
		const inspections = new InspectionClient({ send: (type, agentId, payload) => s.bridge.send(type, agentId, payload) });
		s.bridge.on('inspection_result', message => { inspections.accept(message); });
		const runtime = new NativeToolRuntime({
			bridge: { send: async (type, agentId, payload) => {
				if (type === 'reflex_update') row.reflexSends = [...(row.reflexSends ?? []), { revision: payload.revision, rules: payload.rules?.length ?? 0 }];
				if (type === 'action_command') {
					commands.add(payload.actionId);
					const { timeoutMs: _t, discard: _d, ...args } = payload.arguments ?? {};
					row.actions = [...(row.actions ?? []), { atS: Math.round((Date.now() - (row.t0 ?? Date.now())) / 1000), type: payload.actionType, args }];
					console.log(`  [${spot.name}] +${row.actions.at(-1).atS}s ${payload.actionType} ${JSON.stringify(args)}`);
				}
				return s.bridge.send(type, agentId, payload);
			} },
			requestObservation: async () => { const payload = await s.observe(); return { eventSequence: payload.eventSequence, observation: adaptObservation(payload) }; },
			inspectObservation: async (rec, query) => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await inspections.request(rec, query) }),
			// The twelve default reflexes, armed at the first live sample as the coordinator arms them (dynamic-main).
			reflexBook: new ReflexBook({ defaults: DEFAULT_REFLEXES }),
		});
		const record = { ...s.record, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
		s.bridge.on('observation', ev => {
			if (ev.agentId !== record.agentId || !ev.payload.ready) return;
			const observation = adaptObservation(ev.payload);
			runtime.updateObservation(record, observation, { eventSequence: ev.payload.eventSequence });
			if (spot.reachBiome && row.t0 && row.reachedAtS === undefined && observation.world?.biome === spot.reachBiome) {
				row.reachedAtS = Math.round((Date.now() - row.t0) / 1000);
				row.reachedDuring = row.currentCall ?? null;
				if (Number.isFinite(observation.world?.gameTime) && Number.isFinite(row.startTicks)) row.reachedTicks = observation.world.gameTime - row.startTicks;
				row.reachedAt = [observation.player?.x, observation.player?.y, observation.player?.z].map(n => Math.round(n));
				if (row.reachedTicks === undefined) s.command('time query gametime').then(text => { row.reachedTicks = number(text) - row.startTicks; }).catch(() => {});
				console.log(`[${spot.name}] in ${spot.reachBiome} at +${row.reachedAtS}s ${row.reachedAt.join(',')}`);
			}
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
			await sleep(spot.after?.ms ?? 1500);
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
		if (spot.locate) row.located = String(await s.command(`execute positioned ${row.start.map(Math.floor).join(' ')} run locate ${spot.locate}`)).slice(0, 300);
		// skipBeyond: a target vanilla puts farther than this from the start is out of the search's reach; no search runs.
		const locatedAt = Number(/\((\d+) blocks? away\)/.exec(row.located ?? '')?.[1]);
		if (spot.skipBeyond !== undefined && !(locatedAt <= spot.skipBeyond)) {
			row.skipped = `nearest is ${Number.isFinite(locatedAt) ? `${locatedAt} blocks` : 'not located'} away, beyond ${spot.skipBeyond}`;
			console.log(`[${spot.name}] SKIPPED: ${row.skipped}`);
			continue;
		}
		const readDamage = await damageCounter(text => s.command(text), AGENT);
		const damageBefore = await readDamage();
		const healthBefore = await health(), deathsBefore = await deaths(), t0 = Date.now();
		row.playStartedAt = t0;
		row.startTicks = number(await s.command('time query gametime'));
		row.t0 = t0;
		const trail = [];
		sampling = true;
		sampler = (async () => { while (sampling) { const p = await pos().catch(() => null); if (p) trail.push([...p, Date.now() - t0]); await sleep(500); } })();
		const budgetMs = spot.budgetMs ?? 900_000;
		for (const [callIndex, call] of (spot.calls ?? []).entries()) {
			for (let attempt = 0; ; attempt++) {
				const callStarted = Date.now();
				let result;
				try {
					// A search never outruns the spot's budget: its timeoutMs is what is left of it (at most the 540 s default).
					const args = call.name === 'do_step' && call.arguments.verb === 'find'
						? { ...call.arguments, target: { ...call.arguments.target, timeoutMs: Math.max(10_000, Math.min(540_000, budgetMs - (Date.now() - t0))) } } : call.arguments;
					row.currentCall = call.name === 'do_step' ? call.arguments.verb : call.name;
					result = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `find-live-${callIndex}-${attempt}`, callId: `find-${callIndex}-${attempt}`,
						tool: normalizeMinecraftToolCall(call.name, args) }, record);
				} catch (error) {
					result = { state: 'ERROR', reasonCode: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 600) };
				}
				const entry = { call: call.name, attempt, atS: Math.round((callStarted - t0) / 1000), seconds: Math.round((Date.now() - callStarted) / 1000), state: result?.state, reasonCode: result?.reasonCode,
					message: String(result?.message ?? '').slice(0, 900), find: result?.find };
				row.calls.push(entry);
				if (spot.dump) await writeFile(path.join(dir, `call-${callIndex}-${attempt}.json`), JSON.stringify(result, null, 2));
				console.log(`[${spot.name}] +${entry.atS}s ${call.name}#${attempt} ${entry.state} ${entry.reasonCode} ${entry.seconds}s :: ${entry.message.slice(0, 300)}`);
				// A dead body, or one the server no longer samples, ends the spot.
				if ((await deaths()) > deathsBefore || /TIMEOUT observation/.test(entry.message)) { row.ended = 'death or lost observations'; break; }
				const found = result?.state === 'SUCCEEDED' && result?.reasonCode === 'FIND_SEEN';
				if (spot.reachBiome && row.reachedAtS !== undefined) break;
				const seen = result?.find?.seen;
				if (spot.reachBiome && found && seen && seen.via !== 'standing in it' && Date.now() - t0 < budgetMs - 10_000) {
					// A far sighting: the model's next call walks there (travel_to with its defaults), then finds again.
					const walkStarted = Date.now();
					let walked;
					try {
						row.currentCall = 'travel_to';
						walked = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `find-live-go-${callIndex}-${attempt}`, callId: `go-${callIndex}-${attempt}`,
							tool: normalizeMinecraftToolCall('act', { actionType: 'travel_to', arguments: { x: seen.x + 0.5, y: seen.y + 1, z: seen.z + 0.5, tolerance: 3,
								timeoutMs: Math.max(10_000, Math.min(300_000, budgetMs - (Date.now() - t0))) } }) }, record);
					} catch (error) { walked = { state: 'ERROR', reasonCode: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 300) }; }
					row.calls.push({ call: 'travel_to', attempt, atS: Math.round((walkStarted - t0) / 1000), seconds: Math.round((Date.now() - walkStarted) / 1000), state: walked?.state, reasonCode: walked?.reasonCode, message: String(walked?.message ?? '').slice(0, 400) });
					if (row.reachedAtS !== undefined) break;
					continue;
				}
				if (found || !spot.repeat || result?.reasonCode === 'FIND_BLOCKED' || Date.now() - t0 >= budgetMs - 10_000) break;
				// The provider-free stand-in for a model: give the reflexes a moment with danger, then ask again.
				if (['RUNNING', 'PREPARING'].includes(result?.state) && typeof result?.actionId === 'string') {
					await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `find-live-cancel-${callIndex}-${attempt}`, callId: `cancel-${callIndex}-${attempt}`,
						tool: normalizeMinecraftToolCall('cancelAction', { actionId: result.actionId, goalRevision: record.goalRevision }) }, record).catch(() => {});
				}
				// The stand-in for a model after danger: give the reflexes (and regeneration, when hurt) a moment, then ask again.
				if (result?.reasonCode === 'FIND_DANGER') await sleep((await health()) < 12 ? 15000 : 4000);
			}
		}
		sampling = false; await sampler;
		row.handBacks = row.calls.filter((entry) => entry.reasonCode === 'FIND_DANGER').length;
		const last = row.calls.at(-1);
		row.found = last?.state === 'SUCCEEDED' && last?.reasonCode === 'FIND_SEEN';
		row.seconds = Math.round((Date.now() - t0) / 1000);
		row.foundAtS = row.found ? last.atS + last.seconds : null;
		let walked = 0, farthest = 0;
		for (let i = 1; i < trail.length; i++) walked += Math.hypot(trail[i][0] - trail[i - 1][0], trail[i][2] - trail[i - 1][2]);
		for (const p of trail) farthest = Math.max(farthest, Math.hypot(p[0] - trail[0][0], p[2] - trail[0][2]));
		const end = trail.at(-1) ?? row.start;
		row.path = { walked: Math.round(walked), net: Math.round(Math.hypot(end[0] - row.start[0], end[2] - row.start[2])), farthest: Math.round(farthest),
			descended: Math.round(row.start[1] - Math.min(...trail.map(p => p[1]), row.start[1])), samples: trail.length };
		row.end = await pos();
		const healthAfter = await health();
		Object.assign(row, damageEvidence(damageBefore, await readDamage(), healthBefore, healthAfter));
		row.deaths = (await deaths()) - deathsBefore;
		row.finishedAt = Date.now();
		const reachTicks = spot.reachTicks ?? 12_000;
		row.passAny = spot.reachBiome ? row.reachedTicks !== undefined && row.reachedTicks <= reachTicks && row.deaths === 0 : undefined;
		row.passFind = spot.reachBiome ? row.passAny && row.reachedDuring === 'find' : undefined;
		row.travelFallbacks = row.calls.filter((entry) => entry.call === 'travel_to').length;
		row.pass = (spot.reachBiome ? row.reachedTicks !== undefined && row.reachedTicks <= reachTicks
			: spot.expectCode ? last?.reasonCode === spot.expectCode : row.found) && row.deaths === 0;
		await writeFile(path.join(dir, 'trail.json'), JSON.stringify(trail));
		console.log(`[${spot.name}] ${row.found ? 'FOUND' : 'NOT FOUND'} in ${row.foundAtS ?? row.seconds}s walked=${row.path.walked} net=${row.path.net} farthest=${row.path.farthest} descended=${row.path.descended} damageTaken=${row.damageTaken ?? "unknown"} deaths=${row.deaths} handBacks=${row.handBacks}`);
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
