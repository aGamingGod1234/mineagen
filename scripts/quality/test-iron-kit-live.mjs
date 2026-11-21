// Provider-free route room: node scripts/quality/test-iron-kit-live.mjs SEEDS.json OUT_DIR [JAR] [--coordinator TGZ|DIR] [--descriptive]
// SEEDS.json: { seeds: [<seed>...], lanes: 2, budgetMinutes: 45 }. KIT_SEEDS=a,b plays only those seeds. One fresh
// normal-difficulty server per seed with monsters on; each lane is a body that starts with nothing at the world spawn or
// on dry soil 200+ blocks from the other lanes, and plays until it holds the full iron kit (an iron pickaxe, a shield, two
// buckets and flint and steel) or its budget runs out.
// The stand-in plays the route the model is shown: each turn it reads routeLine (the "usual next step" line) for the
// body's live sample and makes the first call that line names (obtain X count N, find an animal, equip the shield),
// through the real NativeToolRuntime and do_step exactly as a model call would. It answers a danger hand-back as the
// obtain fixture does (flee a creeper, fight another named hostile, else wait) and rests a call that failed twice for 3
// minutes. No model call is made, so it measures the route and the helpers, not whether a model follows the route.
// --coordinator names the coordinator to play (its src/ and config/ folders, or a .tgz of coordinator/src and
// coordinator/config from another commit): the route, the obtain helper and the runtime all come from it, so two arms
// on one jar compare two coordinators. Default: this checkout's coordinator.
// Per lane: minutes to the full kit, climbs back to the surface (down a mine, under y 50 with no open sky, then open sky
// within 8 blocks of the start height again without a death between), descents, deaths, blocks mined (vanilla mined
// scores for the usual blocks, and the dig results' own counts), pickaxe uses, every call and the line that named it. One row per seed in result.json; the row passes when every lane held the kit with no death.
// Exit code (strict, the default): 0 every lane held the kit with no death, 1 one did not, 2 invalid evidence.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot, newerGoalRevision } from './watch-replay.mjs';
import { callObtain } from './obtain-handbacks.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { deathCounter, deathEvidence } from './lib/damage-counter.mjs';
import { kitHeld, routeCall } from './lib/iron-kit-route.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-iron-kit-live.mjs SEEDS.json OUT_DIR [JAR] [--coordinator TGZ|DIR] [--strict|--descriptive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const coordinatorAt = cli.indexOf('--coordinator');
const coordinatorArg = coordinatorAt >= 0 ? cli[coordinatorAt + 1] : null;
const positional = cli.filter((arg, i) => !['--strict', '--descriptive', '--coordinator'].includes(arg) && !(coordinatorAt >= 0 && i === coordinatorAt + 1));
const [planFile, outArg, jarArg] = positional;
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!planFile || !outArg || !template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const plan = JSON.parse(await readFile(planFile, 'utf8'));
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }

// The coordinator this arm plays. A .tgz is unpacked inside coordinator/ so its one package import (acorn) resolves to
// this checkout's coordinator/node_modules.
async function coordinatorRoot(arg) {
	if (!arg) return path.join(root, 'coordinator');
	const full = path.resolve(arg);
	if (statSync(full).isDirectory()) return full;
	const hash = createHash('sha256').update(await readFile(full)).digest('hex').slice(0, 12);
	const into = path.join(root, 'coordinator', '.kit-arms', hash);
	if (!existsSync(path.join(into, 'coordinator', 'src'))) {
		await mkdir(into, { recursive: true });
		execFileSync('tar', ['-xzf', full, '-C', into]);
	}
	return path.join(into, 'coordinator');
}
const arm = await coordinatorRoot(coordinatorArg);
const load = (file) => import(pathToFileURL(path.join(arm, 'src', file)).href);
const [{ NativeToolRuntime }, { normalizeMinecraftToolCall }, { adaptObservation }, { InspectionClient }, { DEFAULT_REFLEXES }, { routeLine, foodStockHandback, woodStockHandback = () => false }, { emptyKnown, evaluatePlanCheck, rememberPlanFacts }, { HeadlessRconClient }, { parseSavedWorldSpawn }] = await Promise.all([
	load('native-tool-runtime.mjs'), load('native-minecraft-tools.mjs'), load('observation-adapter.mjs'), load('inspection-client.mjs'), load('reflexes.mjs'),
	load('skill-fits.mjs'), load('plan-checks.mjs'), load('headless-rcon.mjs'), load('headless-world-spawn.mjs')]);
const armId = coordinatorArg ? path.basename(coordinatorArg) : 'checkout';
console.log(`[kit] coordinator ${armId} (${arm})`);

const sleep = ms => new Promise(done => setTimeout(done, ms));
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const SPACING = 200;
const lanes = Math.min(plan.lanes ?? 2, 4);
const budgetMs = (plan.budgetMinutes ?? 45) * 60_000;
const only = new Set(String(process.env.KIT_SEEDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const seeds = plan.seeds.map(String).filter(seed => only.size === 0 || only.has(seed));
const results = [];
const rowsFile = path.join(out, 'runs.jsonl');
// Down a mine: under this height with no open sky above (the route's own test of being below ground).
const MINE_Y = 50;
// Vanilla mined scores the lanes are counted by: the blocks a mine or a staircase breaks.
const MINED = ['stone', 'deepslate', 'cobblestone', 'dirt', 'grass_block', 'gravel', 'sand', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'iron_ore', 'deepslate_iron_ore', 'coal_ore', 'deepslate_coal_ore', 'copper_ore', 'deepslate_copper_ore'];
const PICKAXES = ['wooden', 'stone', 'iron', 'diamond'];
const REST_MS = 180_000;
const MEATS = { cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken' };

process.on('unhandledRejection', (error) => console.log(`[harness] unhandled: ${String(error?.message ?? error).slice(0, 200)}`));
let current = null;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void (current?.stop() ?? Promise.resolve()).finally(() => process.exit(130)); });

for (const [seedIndex, seed] of seeds.entries()) {
	const dir = path.join(out, `seed-${seedIndex}`);
	await mkdir(dir, { recursive: true });
	const row = { seed, coordinator: armId, lanes: [], startedAt: Date.now() };
	let s;
	try {
		s = current = await boot(dir, { jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), template, port: port + (seedIndex % 20) * 4, world: null, seed, spawnMonsters: true, goalTicks: 2_000_000, extraProperties: 'max-tick-time=-1\n' });
		const secret = (await readFile(path.join(dir, 'secret.txt'), 'utf8')).trim();
		const once = s.command;
		s.command = async (text) => {
			for (let attempt = 0; ; attempt++) {
				try { return await once(text); }
				catch (error) {
					if (attempt >= 2) throw error;
					await s.rcon?.close().catch(() => {});
					s.rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + (seedIndex % 20) * 4 + 1, password: secret, connectTimeoutMs: 5000, commandTimeoutMs: 120_000 });
					await s.rcon.connect().catch(() => {});
					await sleep(1000);
				}
			}
		};
		await s.command('save-all flush');
		let sx = 0, sz = 0;
		try { ({ x: sx, z: sz } = parseSavedWorldSpawn(await readFile(path.join(dir, 'server', 'world', 'level.dat')))); }
		catch (error) { console.log(`[seed ${seed}] spawn unread (${error.message}); ringing 0,0`); }
		await s.command('difficulty normal');
		for (const [i, block] of MINED.entries()) await s.command(`scoreboard objectives add km${i} minecraft.mined:minecraft.${block}`);
		for (const tier of PICKAXES) await s.command(`scoreboard objectives add ku_${tier} minecraft.used:minecraft.${tier}_pickaxe`);
		await s.command('time set 0');
		let spotIndex = 0;
		const nextSpot = () => { const n = spotIndex++; if (n === 0) return [sx, sz]; const ring = Math.floor((n - 1) / 8) + 1, angle = ((n - 1) % 8) * Math.PI / 4 + ring * 0.4; return [Math.round(sx + Math.cos(angle) * SPACING * ring), Math.round(sz + Math.sin(angle) * SPACING * ring)]; };
		const agents = [];
		for (let lane = 0; lane < lanes; lane++) agents.push(await joinAgent(s, lane, nextSpot).catch((error) => { console.log(`[seed ${seed}] lane ${lane} could not start: ${error.message}`); return null; }));
		row.lanes = await Promise.all(agents.map((agent, lane) => agent === null ? { lane, error: 'could not start' }
			: playLane(s, agent, seed, seedIndex, dir).catch((error) => ({ lane, error: String(error?.stack ?? error).slice(0, 1200) }))));
	} catch (error) {
		row.error = String(error?.stack ?? error).slice(0, 1200);
		console.log(`[seed ${seed}] ERROR ${row.error.split('\n')[0]}`);
	} finally {
		await s?.stop().catch(() => {});
	}
	row.finishedAt = Date.now();
	const played = row.lanes.filter(lane => !lane.error);
	if (row.error || played.length < lanes) row.error ??= `${lanes - played.length} lane(s) did not play`;
	if (played.some(lane => lane.deaths === null)) (row.integrity ??= []).push({ file: 'deaths', error: 'Missing or decreasing vanilla death counter' });
	for (const lane of played) for (const flaw of lane.integrity ?? []) (row.integrity ??= []).push({ ...flaw, lane: lane.lane });
	row.pass = !row.error && played.every(lane => lane.kitMinutes !== null && lane.deaths === 0);
	results.push(row);
	await appendFile(rowsFile, `${JSON.stringify(row)}\n`);
	for (const lane of row.lanes) console.log(`[${seed} L${lane.lane}] kit ${lane.kitMinutes ?? '-'} min, climbs ${lane.climbs?.length ?? '?'}, descents ${lane.descents ?? '?'}, deaths ${lane.deaths ?? '?'}, mined ${lane.mined ?? '?'}${lane.error ? ` ERROR ${lane.error.split('\n')[0]}` : ''}`);
}
const report = await finishRun(results, { file: path.join(out, 'result.json'), planned: seeds.length, strict });
console.log(JSON.stringify(report));
process.exit(report.exitCode);

async function surfaceAt(s, x, z) {
	await s.command(`forceload add ${x} ${z}`);
	for (let wait = 0; wait < 60 && !/time is/i.test(await s.command(`execute if loaded ${x} 0 ${z} run time query gametime`)); wait++) await sleep(1000);
	const top = async (test) => /passed/i.test(await s.command(`execute positioned ${x} 0 ${z} positioned over motion_blocking if block ~ ~-1 ~ ${test}`).catch(() => ''));
	const wet = await top('minecraft:water') || await top('minecraft:lava') || await top('#minecraft:ice') || await top('minecraft:powder_snow');
	return { x, z, wet };
}

async function landSpot(s, nextSpot) {
	for (let tries = 0; tries < 48; tries++) {
		const [x, z] = nextSpot();
		const surface = await surfaceAt(s, x, z).catch(() => ({ wet: true }));
		if (!surface.wet) return [x, z];
		await s.command(`forceload remove ${x} ${z}`).catch(() => {});
	}
	throw new Error('no dry soil found in 48 spots round the spawn');
}

async function joinAgent(s, lane, nextSpot) {
	const name = `Kit${lane}`;
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
	const actions = [], log = [];
	const t0 = Date.now();
	const inspections = new InspectionClient({ send: (type, agentId, payload) => s.bridge.send(type, agentId, payload) });
	s.bridge.on('inspection_result', message => { if (message.agentId === record.agentId) inspections.accept(message); });
	const observe = async () => {
		const before = latest?.eventSequence ?? 0;
		await s.bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision });
		for (let i = 0; i < 400 && !(latest?.eventSequence > before); i++) await sleep(25);
		return { eventSequence: latest.eventSequence, observation: adaptObservation(latest) };
	};
	// The kit habit is on in production (MINEAGEN_KIT_HABIT unset): equip the shield and armour, food in reach.
	const runtime = new NativeToolRuntime({
		kitHabit: String(process.env.MINEAGEN_KIT_HABIT ?? '').trim().toLowerCase() !== 'off',
		trace: (event, fields) => { if (event === 'native_obtain_step' && fields?.agentId === record.agentId) log.push({ t: Math.round((Date.now() - t0) / 1000), text: fields.text }); },
		bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') commands.set(payload.actionId, { actionType: payload.actionType, at: Date.now() }); return s.bridge.send(type, agentId, payload); } },
		requestObservation: observe,
		inspectObservation: async (rec, query) => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await inspections.request(rec, query) }),
	});
	s.bridge.on('observation', ev => {
		if (ev.agentId !== record.agentId || !ev.payload.ready) return;
		latest = ev.payload;
		runtime.updateObservation(record, adaptObservation(ev.payload), { eventSequence: ev.payload.eventSequence });
	});
	// Every newer goal revision the server sends (a death, a respawn, a low-health hand-back), as the coordinator follows
	// it: a revision left behind made every later call fail at once with STALE_GOAL_REVISION.
	s.bridge.on('message', ev => {
		const revision = newerGoalRevision(record, ev);
		if (revision === null) return;
		record.goalRevision = revision;
		s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
	});
	s.bridge.on('action_result', ev => {
		if (ev.agentId !== record.agentId || !commands.has(ev.payload.actionId)) return;
		const sent = commands.get(ev.payload.actionId);
		if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(ev.payload.state))
			actions.push({ t: Math.round((sent.at - t0) / 1000), s: Math.round((Date.now() - sent.at) / 1000), type: sent.actionType, state: ev.payload.state, code: ev.payload.reasonCode ?? null, message: String(ev.payload.message ?? '').slice(0, 300) });
		runtime.onActionResult(record, ev.payload);
		s.bridge.send('action_result_ack', record.agentId, { goalRevision: record.goalRevision, actionId: ev.payload.actionId }).catch(() => {});
	});
	await s.bridge.send('reflex_update', record.agentId, { revision: 1, rules: DEFAULT_REFLEXES.map(rule => ({ ...structuredClone(rule), coordinatorDefault: true })), yield: false });
	return { name, lane, record, runtime, spot, observe, latest: () => latest, log, actions };
}

async function playLane(s, agent, seed, seedIndex, dir) {
	const { name, lane, record, runtime } = agent;
	const pos = async () => String(await s.command(`data get entity ${name} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const health = async () => number(await s.command(`data get entity ${name} Health`));
	const deaths = () => deathCounter(text => s.command(text), name, { objective: 'deaths', unsetIsZero: true });
	await s.command(`clear ${name}`);
	await s.command(`effect give ${name} minecraft:instant_health 1 20 true`);
	await s.command(`effect give ${name} minecraft:saturation 2 20 true`);
	for (let i = 0; i < 300 && !(agent.latest()?.ready && (agent.latest()?.inventory?.items?.length ?? 0) === 0); i++) await sleep(100);
	const start = await pos();
	const startY = start?.[1] ?? 64;
	const result = { lane, seed, spot: agent.spot, start, kitMinutes: null, climbs: [], descents: 0, deathsAt: [], calls: [] };
	const deathsBefore = await deaths();
	const t0 = Date.now();
	const minutes = () => Math.round((Date.now() - t0) / 600) / 100;
	const known = emptyKnown();
	let foodHandedBack = false, woodHandedBack = false;
	// Climb and descent tracking on the harness's own clock: a death between going under and coming up is no climb.
	let under = null, lastDeaths = 0, sampling = true, stepText = '';
	const sampler = (async () => {
		while (sampling) {
			const o = agent.latest() ? adaptObservation(agent.latest()) : null;
			const p = o?.player;
			if (p && Number.isFinite(p.y) && !(p.health <= 0)) {
				const deep = p.y < MINE_Y && p.skyOpen === false;
				const up = p.skyOpen === true && p.y >= startY - 8;
				if (deep && under === null) { under = { at: minutes(), deepest: p.y, deaths: lastDeaths }; result.descents += 1; }
				if (under !== null) under.deepest = Math.min(under.deepest, p.y);
				if (up && under !== null) {
					if (under.deaths === lastDeaths) result.climbs.push({ at: minutes(), from: Math.floor(under.deepest), food: p.foodLevel, health: p.health, why: stepText, call: result.calls.at(-1)?.call ?? null });
					under = null;
				}
			}
			await sleep(1000);
		}
	})();
	const lastObtainStep = () => agent.log.at(-1)?.text ?? '';
	const stepWatch = setInterval(() => { stepText = lastObtainStep().slice(0, 160); }, 1000);
	const resting = new Map();
	let failures = new Map();
	// A call that keeps succeeding with the inventory unchanged and the same line shown is not progress (a find that
	// sees an animal too far for the route to count it): rested like a failing one.
	let same = { key: null, inventory: null, times: 0 };
	// "look for ... animals, then obtain cooked meat": the animal a find saw is hunted next.
	let hunt = null;
	const execute = async (tool, tag) => {
		try { return await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `kit-${seedIndex}-${lane}-${tag}`, callId: `kit-${tag}`, tool }, record); }
		catch (error) { return { state: 'ERROR', reasonCode: error?.code ?? 'ERROR', message: String(error?.message ?? error) }; }
	};
	const answer = async (handedBack, tag) => {
		const named = /minecraft:([a-z_]+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(String(handedBack.message ?? ''));
		const act = named === null ? null : named[1] === 'creeper'
			? { actionType: 'flee_from', arguments: { targetId: named[2], distance: 12, timeoutMs: 10_000 } }
			: { actionType: 'fight_target', arguments: { targetId: named[2], timeoutMs: 20_000 } };
		if (!act) { await sleep(3000); return null; }
		const answered = await execute(normalizeMinecraftToolCall('act', act), `answer-${tag}`);
		return `answered ${act.actionType} ${named[1]}: ${answered?.state} ${answered?.reasonCode ?? ''}`;
	};
	let turn = 0;
	while (Date.now() - t0 < budgetMs) {
		turn += 1;
		if (!(await health() > 0)) {
			result.deathsAt.push(minutes());
			lastDeaths += 1;
			foodHandedBack = false; woodHandedBack = false;
			const started = s.inbox.wait('goal_control', g => g.agentId === record.agentId && g.payload.operation === 'start', 60_000).catch(() => null);
			await s.command(`mineagen respawn ${name}`).catch(() => {});
			for (let i = 0; i < 60 && !(await health() > 0); i++) await sleep(500);
			await s.command(`mineagen start ${name} Survive for 36000 seconds.`).catch(() => {});
			const goal = await started;
			if (goal) record.goalRevision = goal.payload.goalRevision;
			await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
			await sleep(2000);
			continue;
		}
		await agent.observe().catch(() => null);
		const o = agent.latest() ? adaptObservation(agent.latest()) : null;
		if (!o) { await sleep(1000); continue; }
		rememberPlanFacts?.(known, o);
		if (kitHeld(o)) { result.kitMinutes = minutes(); break; }
		const line = routeLine({ observation: o, known, foodHandedBack, woodHandedBack, evaluate: evaluatePlanCheck });
		let call = hunt ?? routeCall(line);
		hunt = null;
		const key = call ? JSON.stringify(call) : null;
		if (call === null || resting.get(key) > Date.now()) {
			result.calls.push({ at: minutes(), line, call: null, note: call === null ? 'no call in the line' : 'resting after two failures' });
			await sleep(5000);
			continue;
		}
		let tool, why = line;
		if (call.kind === 'obtain') {
			let item = call.item;
			// "obtain beef ... (or porkchop, mutton or chicken from the nearest animal; skip if none in view)": the animal in view.
			if (Object.values(MEATS).includes(item) || /^cooked_/.test(item)) {
				const near = (o.entities ?? []).filter(e => MEATS[String(e.type).replace(/^minecraft:/, '')] && e.alive !== false && e.baby !== true)
					.sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
				const meat = near ? MEATS[String(near.type).replace(/^minecraft:/, '')] : null;
				if (meat) item = /^cooked_/.test(item) ? `cooked_${meat}` : meat;
			}
			const held = (o.inventory?.items ?? []).filter(i => i.itemId === `minecraft:${item}`).reduce((n, i) => n + i.count, 0);
			const count = call.count ?? (call.restock ? Math.min(64, held + 4) : 1);
			// Built per attempt: a retry after a hand-back gets only the lane's remaining budget.
			tool = () => normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item, count, timeoutMs: Math.max(60_000, Math.min(1_200_000, budgetMs - (Date.now() - t0))) }, why: `route: obtain ${item}` });
			call = { ...call, item, count };
		} else if (call.kind === 'find_animal') {
			const near = (o.entities ?? []).find(e => MEATS[String(e.type).replace(/^minecraft:/, '')] && e.alive !== false);
			const mob = near ? String(near.type).replace(/^minecraft:/, '') : ['cow', 'pig', 'sheep', 'chicken'][turn % 4];
			tool = () => normalizeMinecraftToolCall('do_step', { verb: 'find', target: { mob, within: 96, timeoutMs: Math.max(60_000, Math.min(120_000, budgetMs - (Date.now() - t0))) }, why: 'route: look for an animal' });
			call = { ...call, mob };
		} else if (call.kind === 'equip_shield') {
			const shield = (o.inventory?.items ?? []).find(i => i.itemId === 'minecraft:shield' && Number.isInteger(i.slot));
			if (!shield) { await sleep(1000); continue; }
			tool = normalizeMinecraftToolCall('act', { actionType: 'equip_item', arguments: { sourceSlot: shield.slot, targetSlot: 'offhand', expectedItemId: 'minecraft:shield' } });
		}
		const begun = Date.now();
		const ran = await callObtain({ mode: 'answer', budgetMs: budgetMs - (begun - t0), started: begun, execute: async (attempt) => execute(typeof tool === 'function' ? tool() : tool, `${turn}-${attempt}`), alive: async () => await health() > 0, answer: (r, attempt) => answer(r, `${turn}-${attempt}`) });
		const done = ran.result;
		result.calls.push({ at: Math.round((begun - t0) / 600) / 100, seconds: Math.round((Date.now() - begun) / 1000), line, call, state: done?.state, code: done?.reasonCode ?? null, message: String(done?.message ?? '').slice(0, 300), handBacks: ran.handBacks });
		console.log(`[${seed} L${lane}] ${result.calls.at(-1).at} min ${call.kind}${call.item ? ` ${call.item} x${call.count}` : call.mob ? ` ${call.mob}` : ''}: ${done?.state} ${done?.reasonCode ?? ''} ${result.calls.at(-1).seconds}s, climbs ${result.climbs.length}`);
		if (call.kind === 'obtain' && foodStockHandback({ kind: 'obtain', arguments: { item: call.item } }, done)) foodHandedBack = true;
		if (call.kind === 'find_animal' && foodStockHandback({ kind: 'find', arguments: { mob: call.mob } }, done)) foodHandedBack = true;
		if (call.kind === 'obtain' && woodStockHandback({ kind: 'obtain', arguments: { item: call.item } }, done)) woodHandedBack = true;
		if (call.kind === 'find_animal' && done?.state === 'SUCCEEDED' && MEATS[call.mob]) hunt = { kind: 'obtain', item: `cooked_${MEATS[call.mob]}`, count: 8 };
		const inventory = JSON.stringify((adaptObservation(agent.latest())?.inventory?.items ?? []).map(i => [i.itemId, i.count]).sort());
		if (done?.state === 'SUCCEEDED' && key === same.key && inventory === same.inventory) same.times += 1;
		else same = { key, inventory, times: 0 };
		if (same.times >= 2) { resting.set(key, Date.now() + REST_MS); same = { key: null, inventory: null, times: 0 }; hunt = null; }
		if (done?.state === 'SUCCEEDED') failures.delete(key);
		else {
			failures.set(key, (failures.get(key) ?? 0) + 1);
			if (failures.get(key) >= 2) { resting.set(key, Date.now() + REST_MS); failures.delete(key); }
		}
		if (call.then === 'equip_shield' && done?.state === 'SUCCEEDED') {
			const after = adaptObservation(agent.latest());
			const shield = (after.inventory?.items ?? []).find(i => i.itemId === 'minecraft:shield' && Number.isInteger(i.slot));
			if (shield) await execute(normalizeMinecraftToolCall('act', { actionType: 'equip_item', arguments: { sourceSlot: shield.slot, targetSlot: 'offhand', expectedItemId: 'minecraft:shield' } }), `${turn}-equip`);
		}
	}
	if (result.kitMinutes === null && agent.latest() && kitHeld(adaptObservation(agent.latest()))) result.kitMinutes = minutes();
	sampling = false; clearInterval(stepWatch); await sampler;
	result.minutes = minutes();
	const deathResult = deathEvidence(deathsBefore, await deaths());
	result.deaths = deathResult.valid ? Math.max(deathResult.deaths, result.deathsAt.length) : null;
	result.end = await pos();
	result.inventory = String(await s.command(`data get entity ${name} Inventory`)).slice(0, 1500);
	// Blocks mined and pickaxe uses from the body's vanilla statistics (scores: a fake player's stats file is never saved).
	// A score never set is 0 blocks; an answer that cannot be read is unknown, and makes the total unknown (null), never 0.
	const score = async (objective) => {
		const text = await s.command(`scoreboard players get ${name} ${objective}`).catch(() => null);
		const n = Number(/has (-?\d+)/.exec(text ?? '')?.[1]);
		return Number.isFinite(n) ? n : /none is set|can't get value/i.test(text ?? '') ? 0 : null;
	};
	const total = async (objectives) => { let n = 0; for (const objective of objectives) { const v = await score(objective); if (v === null) return null; n += v; } return n; };
	result.mined = await total([...MINED.keys()].map(i => `km${i}`));
	result.pickaxeUses = await total(PICKAXES.map(tier => `ku_${tier}`));
	if (result.mined === null || result.pickaxeUses === null) (result.integrity ??= []).push({ file: 'scores', error: 'A mined or used score could not be read' });
	// Blocks dug as the results report them, a cross-check on the statistics.
	result.minedByResults = agent.actions.reduce((n, a) => n + Number(/(\d+) blocks? mined/.exec(a.message)?.[1] ?? 0) + (a.type === 'break_block' && a.state === 'SUCCEEDED' ? 1 : 0), 0);
	result.obtainLog = agent.log.slice(-400);
	result.actions = agent.actions.slice(-600);
	await writeFile(path.join(dir, `lane-${lane}.json`), JSON.stringify(result, null, 1)).catch(() => {});
	const { obtainLog, actions, ...summary } = result;
	return summary;
}
