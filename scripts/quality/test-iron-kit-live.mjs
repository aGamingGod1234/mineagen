// Provider-free route room: node scripts/quality/test-iron-kit-live.mjs SEEDS.json OUT_DIR [JAR] [--coordinator TGZ|DIR] [--descriptive]
// SEEDS.json: { seeds: [<seed>...], lanes: 2, budgetMinutes: 45, start?: 'kit', until?: 'kit'|'portal' }. KIT_SEEDS=a,b plays only those seeds. One fresh
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
// start: 'kit' gives each lane, before its clock starts, what lanes held when they made the kit from nothing (the kit with
// the shield worn, two spare stone pickaxes, a stack of cobblestone, some wood, a table, a furnace, food and 1 raw iron).
// until: 'portal' plays on past the kit until the route's line reaches the portal (whatever the route puts between the
// kit and the portal, such as armour, is done); a lane then passes on reaching it with no death.
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
import { kitHeld, kitMinutes, kitStatTotal, portalReady, routeCall, routeToolTimeout } from './lib/iron-kit-route.mjs';

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
// Mob night as the coordinator's danger contexts read it: dusk (12000) until sunrise burns them (23500).
const isNightTime = dayTime => Number.isFinite(dayTime) ? ((dayTime % 24_000) + 24_000) % 24_000 >= 12_000 && ((dayTime % 24_000) + 24_000) % 24_000 < 23_500 : null;
const lanes = Math.min(plan.lanes ?? 2, 4);
const budgetMs = (plan.budgetMinutes ?? 45) * 60_000;
const until = plan.until ?? 'kit';
if (!['kit', 'portal'].includes(until) || ![undefined, 'kit'].includes(plan.start)) { console.error("until is 'kit' or 'portal'; start is 'kit' or absent"); process.exit(2); }
// Leftovers from the lanes that made the kit from nothing in the iron-kit room (median-ish of 20 such lanes).
const START_KIT = [['iron_pickaxe', 1], ['stone_pickaxe', 2], ['bucket', 2], ['flint_and_steel', 1], ['cobblestone', 64], ['oak_planks', 8], ['oak_log', 4],
	['crafting_table', 1], ['furnace', 1], ['cooked_beef', 6], ['raw_iron', 1]];
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
		// Why a lane stalls: the coordinator side of the bridge dropping or rejecting a message is otherwise silent (the
		// server only says "Connection lost"); lanes copy these into their result.
		s.bridgeEvents = [];
		for (const kind of ['disconnected', 'recovered', 'protocolError', 'transportError', 'heartbeatLate', 'messageRejected', 'listenerError']) {
			s.bridge.on(kind, (event) => { if (s.bridgeEvents.length < 200) s.bridgeEvents.push({ at: Date.now(), kind, detail: String(event?.error?.message ?? event?.message ?? event?.type ?? '').slice(0, 200) }); });
		}
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
	row.pass = !row.error && played.every(lane => (until === 'portal' ? lane.portalMinutes !== null : lane.kitMinutes !== null) && lane.deaths === 0);
	results.push(row);
	await appendFile(rowsFile, `${JSON.stringify(row)}\n`);
	for (const lane of row.lanes) console.log(`[${seed} L${lane.lane}] kit ${lane.kitMinutes ?? '-'} min, portal-ready ${lane.portalMinutes ?? '-'} min, armour worn ${lane.firsts?.armorWorn ?? '-'} min, climbs ${lane.climbs?.length ?? '?'}, descents ${lane.descents ?? '?'}, deaths ${lane.deaths ?? '?'}, mined ${lane.mined ?? '?'}${lane.error ? ` ERROR ${lane.error.split('\n')[0]}` : ''}`);
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
	// As the production coordinator asks (dynamic-main requestObservation): an observation inspection the server answers.
	// The old stand-in polled 10 s for a newer published sample and handed back the stale one, which the runtime refuses
	// (FRESH_OBSERVATION_REQUIRED, in 4 old and 7 new lanes of the shield-first round).
	const observe = async () => {
		const result = await inspections.request(record, { section: 'observation' });
		return { ...result, observation: adaptObservation(result.observation) };
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
	if (plan.start === 'kit') {
		for (const [item, count] of START_KIT) await s.command(`give ${name} minecraft:${item} ${count}`);
		await s.command(`item replace entity ${name} weapon.offhand with minecraft:shield`);
		for (let i = 0; i < 100 && !kitHeld(agent.latest() ? adaptObservation(agent.latest()) : null); i++) { await agent.observe().catch(() => null); await sleep(200); }
	}
	const start = await pos();
	const startY = start?.[1] ?? 64;
	const result = { lane, seed, spot: agent.spot, start, kitMinutes: null, portalMinutes: null, climbs: [], descents: 0, deathsAt: [], calls: [], firsts: {} };
	const deathsBefore = await deaths();
	const t0 = Date.now();
	const minutes = () => Math.round((Date.now() - t0) / 600) / 100;
	const remaining = () => budgetMs - (Date.now() - t0);
	const known = emptyKnown();
	let foodHandedBack = false, woodHandedBack = false;
	// Climb and descent tracking on the harness's own clock: a death between going under and coming up is no climb.
	let under = null, lastDeaths = 0, sampling = true, stepText = '';
	const sampler = (async () => {
		while (sampling) {
			const o = agent.latest() ? adaptObservation(agent.latest()) : null;
			const p = o?.player;
			// Minutes to the first time each kit item is held, the shield and any armour worn, and the whole kit held.
			for (const item of o?.inventory?.items ?? []) {
				const id = String(item?.itemId ?? '').replace(/^minecraft:/, '');
				if (['iron_ingot', 'iron_pickaxe', 'shield', 'bucket', 'flint_and_steel', 'iron_chestplate', 'iron_boots'].includes(id) && item.count > 0) result.firsts[id] ??= minutes();
				if (id === 'shield' && item.slot === 'offhand') result.firsts.shieldWorn ??= minutes();
				if (['head', 'chest', 'legs', 'feet'].includes(item.slot) && item.count > 0) { result.firsts.armorWorn ??= minutes(); result.firsts[`${item.slot}Worn`] ??= minutes(); }
			}
			if (o && kitHeld(o)) result.firsts.kit ??= minutes();
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
		const left = remaining();
		if (left <= 0) return null;
		if (!act) { await sleep(Math.min(3000, left)); return null; }
		act.arguments.timeoutMs = Math.min(act.arguments.timeoutMs, left);
		const answered = await execute(normalizeMinecraftToolCall('act', act), `answer-${tag}`);
		return `answered ${act.actionType} ${named[1]}: ${answered?.state} ${answered?.reasonCode ?? ''}`;
	};
	let turn = 0, aliveSinceDeath = true;
	while (remaining() > 0) {
		turn += 1;
		const hp = await health();
		// Unreadable health (the body gone from the server, or RCON failing) is not a death; a body that stays dead because
		// its respawn did not take (the bridge down) is one death, not one per pass of this loop (two lanes logged 36 each).
		if (!Number.isFinite(hp)) { result.unreadableHealth = (result.unreadableHealth ?? 0) + 1; await sleep(Math.min(3000, Math.max(0, remaining()))); continue; }
		if (hp > 0) aliveSinceDeath = true;
		if (!(hp > 0)) {
			if (aliveSinceDeath) {
				result.deathsAt.push(minutes()); lastDeaths += 1;
				// Where and when, from the last sample alive: a surface death at night is the night-cover question.
				const last = agent.latest() ? adaptObservation(agent.latest()) : null;
				const worn = (last?.inventory?.items ?? []).filter(i => ['head', 'chest', 'legs', 'feet'].includes(i?.slot) && i.count > 0).map(i => String(i.itemId).replace(/^minecraft:/, ''));
				(result.deathContext ??= []).push({ at: minutes(), dayTime: Number.isFinite(last?.world?.dayTime) ? last.world.dayTime : null, night: isNightTime(last?.world?.dayTime), skyOpen: last?.player?.skyOpen ?? null, y: last?.player?.y ?? null, worn });
			} else result.stuckDead = (result.stuckDead ?? 0) + 1;
			aliveSinceDeath = false;
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
		result.kitMinutes ??= kitMinutes(o, Date.now() - t0, budgetMs);
		if ((until === 'kit' && result.kitMinutes !== null) || remaining() <= 0) break;
		const line = routeLine({ observation: o, known, foodHandedBack, woodHandedBack, evaluate: evaluatePlanCheck });
		if (until === 'portal' && portalReady(o, line)) { result.portalMinutes = minutes(); result.portalLine = line; break; }
		let call = hunt ?? routeCall(line);
		hunt = null;
		const key = call ? JSON.stringify(call) : null;
		if (call === null || resting.get(key) > Date.now()) {
			result.calls.push({ at: minutes(), line, call: null, note: call === null ? 'no call in the line' : 'resting after two failures' });
			await sleep(5000);
			continue;
		}
		let tool;
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
			tool = (timeoutMs) => normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item, count, timeoutMs }, why: `route: obtain ${item}` });
			call = { ...call, item, count };
		} else if (call.kind === 'find_animal') {
			const near = (o.entities ?? []).find(e => MEATS[String(e.type).replace(/^minecraft:/, '')] && e.alive !== false);
			const mob = near ? String(near.type).replace(/^minecraft:/, '') : ['cow', 'pig', 'sheep', 'chicken'][turn % 4];
			tool = (timeoutMs) => normalizeMinecraftToolCall('do_step', { verb: 'find', target: { mob, within: 96, timeoutMs }, why: 'route: look for an animal' });
			call = { ...call, mob };
		} else if (call.kind === 'equip') {
			const piece = (o.inventory?.items ?? []).find(i => i.itemId === `minecraft:${call.item}` && Number.isInteger(i.slot));
			if (!piece || !call.slot) { await sleep(1000); continue; }
			tool = () => normalizeMinecraftToolCall('act', { actionType: 'equip_item', arguments: { sourceSlot: piece.slot, targetSlot: call.slot, expectedItemId: piece.itemId } });
		}
		const begun = Date.now();
		const ran = await callObtain({
			mode: 'answer', budgetMs: budgetMs - (begun - t0), started: begun,
			execute: async (attempt, left) => {
				const timeoutMs = routeToolTimeout(call.kind, left);
				if (timeoutMs === null) return { state: 'TIMED_OUT', reasonCode: 'LANE_BUDGET' };
				return execute(tool(timeoutMs), `${turn}-${attempt}`);
			},
			alive: async () => remaining() > 0 && await health() > 0,
			answer: (r, attempt) => answer(r, `${turn}-${attempt}`),
		});
		const done = ran.result;
		result.calls.push({ at: Math.round((begun - t0) / 600) / 100, seconds: Math.round((Date.now() - begun) / 1000), line, call, state: done?.state, code: done?.reasonCode ?? null, message: String(done?.message ?? '').slice(0, 300), handBacks: ran.handBacks });
		console.log(`[${seed} L${lane}] ${result.calls.at(-1).at} min ${call.kind}${call.item ? ` ${call.item} x${call.count}` : call.mob ? ` ${call.mob}` : ''}: ${done?.state} ${done?.reasonCode ?? ''} ${result.calls.at(-1).seconds}s, climbs ${result.climbs.length}`);
		result.kitMinutes ??= kitMinutes(adaptObservation(agent.latest()), Date.now() - t0, budgetMs);
		if ((until === 'kit' && result.kitMinutes !== null) || remaining() <= 0 || done?.reasonCode === 'LANE_BUDGET') break;
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
		if (call.then?.equip && done?.state === 'SUCCEEDED') {
			const after = adaptObservation(agent.latest());
			const piece = (after.inventory?.items ?? []).find(i => i.itemId === `minecraft:${call.item}` && Number.isInteger(i.slot));
			if (piece) await execute(normalizeMinecraftToolCall('act', { actionType: 'equip_item', arguments: { sourceSlot: piece.slot, targetSlot: call.then.equip, expectedItemId: piece.itemId } }), `${turn}-equip`);
		}
	}
	sampling = false; clearInterval(stepWatch); await sampler;
	result.minutes = minutes();
	const deathResult = deathEvidence(deathsBefore, await deaths());
	// The server's own death counter is the count. When it cannot be read the count is unknown (null fails the seed's
	// integrity check): the loop skips unreadable health, so its sightings are kept only as a diagnostic, never as zero.
	result.deaths = deathResult.valid ? deathResult.deaths : null;
	result.deathsSeen = result.deathsAt.length;
	result.bridgeEvents = (s.bridgeEvents ?? []).map((event) => ({ ...event, at: Math.round((event.at - t0) / 600) / 100 }));
	result.end = await pos();
	result.inventory = String(await s.command(`data get entity ${name} Inventory`)).slice(0, 1500);
	// Blocks mined and pickaxe uses from the body's vanilla statistics (scores: a fake player's stats file is never saved).
	result.mined = await kitStatTotal(s.command, name, [...MINED.keys()].map(i => `km${i}`));
	result.pickaxeUses = await kitStatTotal(s.command, name, PICKAXES.map(tier => `ku_${tier}`));
	if (result.mined === null || result.pickaxeUses === null) (result.integrity ??= []).push({ file: 'scores', error: 'A mined or used score could not be read' });
	// Blocks dug as the results report them, a cross-check on the statistics.
	result.minedByResults = agent.actions.reduce((n, a) => n + Number(/(\d+) blocks? mined/.exec(a.message)?.[1] ?? 0) + (a.type === 'break_block' && a.state === 'SUCCEEDED' ? 1 : 0), 0);
	result.obtainLog = agent.log.slice(-400);
	result.actions = agent.actions.slice(-600);
	await writeFile(path.join(dir, `lane-${lane}.json`), JSON.stringify(result, null, 1)).catch(() => {});
	const { obtainLog, actions, ...summary } = result;
	return summary;
}
