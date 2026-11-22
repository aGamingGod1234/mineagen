#!/usr/bin/env node
// FIXTURE_TICK_RATE runs the 7 s watch faster: the room, the summon of the body and its walk in stay at 20 TPS, and from
// the zombie's summon the watch and its samples are game time on the fixture clock (rate.clock). The spot records
// seconds (game), wallSeconds and rates.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { spotPassed } from './lib/reflex-failspot-pass.mjs';
import { reflexHold } from './lib/room-evidence.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { installTickRate, fixtureTickRate } from './watch-replay.mjs';
import { deathCounter } from './lib/damage-counter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, MOD_JAR));
const USAGE = 'Usage: test-reflex-failspots-live.mjs [OUT_DIR] [--strict|--descriptive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE (SPOTS=a,b, ARENA_JAR)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const out = resolve(cli.filter(arg => !['--strict', '--descriptive'].includes(arg))[0] ?? 'runtime/reflex-failspots-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) { console.error(USAGE); process.exit(2); }
const port = Number(process.env.SLOT_PORT_BASE);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const END = 'minecraft:the_end', OVERWORLD = 'minecraft:overworld';

const SPOTS = [
	// d19: a tunnel that bends behind the body. Every straight heading away from the zombie is a wall one or two cells
	// out; the way the body walked in (west one cell, then north) is the escape a player takes.
	// Built in the air at y150, so it needs no recorded terrain.
	{ name: 'tunnelBend', kind: 'tunnel', dim: OVERWORLD,
		recorded: 'd18 live runs: sprint_away "no safe heading away: wall NE, N, E, NW..." in tunnels; built here as a bent glass tunnel in the air',
		pos: [1.5, 150, 0.5], view: [-90, 10], health: 20, origin: [17, 150, 81], kit: {},
		rules: [{ id: 'escape', kind: 'trigger', priority: 8, when: { type: 'hostile_near', within: 8 }, do: { type: 'sprint_away', blocks: 8 }, maxS: 5 }] },
];
const only = (process.env.SPOTS ?? '').split(',').filter(Boolean);
const results = { jar: jarPath, spots: {} };
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jarSha256: createHash('sha256').update(await readFile(jarPath).catch(error => { console.error(`no jar: ${error.message}`); process.exit(2); })).digest('hex'), tickRate: fixtureTickRate(), node: process.version }, null, 2));

// A stopped run must not leave its server holding the slot's ports.
let liveServer = null;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (liveServer?.exitCode === null) liveServer.kill('SIGKILL'); process.exit(1); });

class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', e => this.accept(e)); bridge.on('ready', e => this.accept({ type: 'ready', ...e })); }
	accept(e) { const i = this.waiters.findIndex(w => w.type === e.type && w.match(e)); if (i >= 0) this.waiters.splice(i, 1)[0].done(e); else { this.events.push(e); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) { const i = this.events.findIndex(e => e.type === type && match(e)); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, match, done: e => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(w); }); }
}

async function boot(dir) {
	const server = join(dir, 'server');
	await cp(template, server, { recursive: true });
	for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('mineagen-')) await unlink(join(server, 'mods', name));
	await cp(jarPath, join(server, 'mods/mineagen-0.2.0.jar'));
	const secret = randomBytes(32).toString('hex');
	await writeFile(join(dir, 'secret.txt'), secret, { mode: 0o600 });
	await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261029\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=false\ndifficulty=normal\n`);
	const log = await open(join(dir, 'server.log'), 'a');
	const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Dmineagen.bridgePort=${port}`, '-Dmineagen.coordinatorAutoStart=false', `-Dmineagen.bridgeSecretFile=${join(dir, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
	const s = { child, log, secret, record: null, observation: null, ordinal: 0, revision: 0 };
	liveServer = child;
	for (let i = 0; i < 150; i++) { try { s.rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 30000 }); await s.rcon.connect(); break; } catch (e) { await s.rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	s.command = async (text) => { if (s.rcon.state === 'closed') { s.rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 30000 }); await s.rcon.connect(); } return (await s.rcon.command(text)).text; };
	// The fixture tick rate helpers (s.normalRate, s.fastRate, s.clock, s.gameTimer) over the reconnecting command above.
	installTickRate(s, fixtureTickRate());
	s.bridge = new MultiplexedServerBridge({ port, secret }, {}); s.inbox = new Inbox(s.bridge);
	s.bridge.on('observation', e => { s.clock.observe(e.payload?.world?.gameTime); if (e.agentId === s.record?.agentId && e.payload.ready) s.observation = e.payload; });
	s.bridge.on('goal_spec_request', e => { s.bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = s.inbox.wait('ready'); s.bridge.start(); await ready;
	await s.bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free failspot fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await s.command('gamerule minecraft:send_command_feedback false');
	await s.command('scoreboard objectives add deaths deathCount');
	s.observeOrNull = async () => { try { return await s.observe(); } catch { return null; } };
	s.observe = async () => { const seq = s.observation?.eventSequence ?? 0; const next = s.inbox.wait('observation', e => e.agentId === s.record.agentId && e.payload.ready && e.payload.eventSequence > seq); await s.bridge.send('request_observation', s.record.agentId, { goalRevision: s.record.goalRevision }); return (await next).payload; };
	s.act = async (type, args) => {
		const id = `spot-${++s.ordinal}`;
		const payload = { actionId: id, traceId: id, goalRevision: s.record.goalRevision, actionType: type, arguments: args,
			provenance: { provider: s.record.provider, model: s.record.model, reasoningEffort: s.record.reasoningEffort, serviceTier: s.record.serviceTier, traceId: id, programId: 'failspot-fixture', programVersion: 1, sourceStepId: id, eventSequence: s.observation?.eventSequence ?? 0 } };
		const next = s.inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000);
		await s.bridge.send('action_command', s.record.agentId, payload);
		const r = (await next).payload;
		await s.bridge.send('action_result_ack', s.record.agentId, { actionId: id, goalRevision: s.record.goalRevision });
		return r;
	};
	s.setReflexes = async (rules) => {
		s.revision += 1;
		await s.bridge.send('reflex_update', s.record.agentId, { revision: s.revision, rules: normalizeReflexEntries(rules), yield: false });
		for (let i = 0; i < 40; i++) { const o = await s.observe(); if (o.reflexes?.revision === s.revision) return o; await sleep(100); }
		throw new Error(`reflex revision ${s.revision} never echoed`);
	};
	s.stop = async () => {
		await s.command('stop').catch(() => {});
		s.bridge?.stop(); await s.rcon?.close();
		await Promise.race([new Promise(r => child.once('exit', r)), sleep(15000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
	};
	return s;
}

const agent = 'Probe';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const round = v => Math.round(v * 100) / 100;

/** Summons the agent at the spot (a new body knows no terrain yet), in the spot's dimension, with the recorded view. */
async function place(s, spot, kit) {
	const at = `execute in ${spot.dim} run`;
	await s.command(`execute in ${spot.dim} run forceload add ${Math.floor(spot.pos[0]) - 24} ${Math.floor(spot.pos[2]) - 24} ${Math.floor(spot.pos[0]) + 24} ${Math.floor(spot.pos[2]) + 24}`);
	if (!s.record) {
		const registered = s.inbox.wait('agent_registered');
		console.log(await s.command(`execute positioned 0.5 200 0.5 run mineagen summon gpt-6.1-sol low ${agent}`));
		const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		const started = s.inbox.wait('goal_control', e => e.payload.operation === 'start'); await s.command(`mineagen start ${agent} Survive for 1200 seconds.`); s.record.goalRevision = (await started).payload.goalRevision;
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		await s.command(`gamemode survival ${agent}`);
	}
	await s.setReflexes([]);
	// Through another dimension, so the body arrives with no terrain memory: what it knows is what the recorded view shows.
	await s.command(`execute in ${spot.dim === END ? OVERWORLD : END} run tp ${agent} 0.5 200 0.5`); await sleep(500);
	await s.command(`clear ${agent}`);
	for (const [slot, item] of Object.entries(kit ?? {})) await s.command(`item replace entity ${agent} ${slot} with ${item}`);
	await s.command(`effect clear ${agent}`);
	await s.command(`effect give ${agent} minecraft:saturation 2 10 true`);
	await s.command(`${at} tp ${agent} ${spot.pos.join(' ')} ${spot.view.join(' ')}`);
	await s.command(`${at} kill @e[type=minecraft:ender_dragon]`); await s.command(`${at} kill @e[type=minecraft:enderman]`);
	await s.command(`${at} kill @e[type=minecraft:area_effect_cloud]`); await s.command(`${at} kill @e[type=minecraft:skeleton]`); await s.command(`${at} kill @e[type=minecraft:zombie]`);
	// A dimension change leaves the body invulnerable for 60 ticks (vanilla): wait it out before damage counts.
	await s.idleSleep(3500);
	await s.command(`effect give ${agent} minecraft:instant_health 1 5 true`); await s.idleSleep(700);
	if (spot.health < 20) await s.command(`damage ${agent} ${round(20 - spot.health)} minecraft:generic`);
	await s.idleSleep(1000);
}

const eventsOf = (o, ids, since) => (o.reflexes?.events ?? []).filter(e => ids.includes(e.id) && (e.seq ?? 0) > since).map(e => ({ outcome: e.outcome, detail: e.detail, ms: e.ms }));
// The deathCount objective boot adds: "has 1 [deaths]" once read as NaN, and `|| 0` hid the death.
const deaths = (s) => deathCounter(text => s.command(text), agent, { objective: 'deaths', unsetIsZero: true });
const health = async (s) => { const text = await s.command(`data get entity ${agent} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };

async function tunnelSpot(s, spot) {
	await s.normalRate();
	const [ox, oy, oz] = spot.origin;
	const at = (dx, dy, dz) => `${ox + dx} ${oy + dy} ${oz + dz}`;
	await s.command(`execute in ${spot.dim} run forceload add ${ox - 24} ${oz - 24} ${ox + 24} ${oz + 24}`); await sleep(1500);
	await s.command('time set 6000');
	// Glass shell, then the two legs: east (x 0..8, z 0) and north (x 0, z -8..0), two blocks high.
	await s.command(`execute in ${spot.dim} run fill ${at(-2, -1, -10)} ${at(10, 2, 2)} minecraft:glass`);
	await s.command(`execute in ${spot.dim} run fill ${at(0, 0, 0)} ${at(8, 1, 0)} minecraft:air`);
	await s.command(`execute in ${spot.dim} run fill ${at(0, 0, -8)} ${at(0, 1, 0)} minecraft:air`);
	const world = (dx, dz) => [ox + dx + 0.5, oy, oz + dz + 0.5];
	await place(s, { ...spot, pos: world(0, -7), view: [0, 10] }, spot.kit);
	// Walk in along the tunnel, so its cells are ground the body has walked (as the way it came is in a cave).
	const walked = [];
	for (const [dx, dz] of [[0, -4], [0, 0], [1, 0]]) {
		const [x, y, z] = world(dx, dz);
		walked.push((await s.act('move_to', { x, y, z, tolerance: 0.4 })).state);
	}
	await s.act('control', { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw: -90, pitch: 10, selectedSlot: 0, hand: 'main', ticks: 10 });
	const ids = spot.rules.map(r => r.id);
	let o = await s.setReflexes(spot.rules);
	const since = Math.max(0, ...(o.reflexes?.events ?? []).map(e => e.seq ?? 0));
	const start0 = [o.position.x, o.position.z];
	const deathsBefore = await deaths(s);
	// The summon starts the watch: the rate goes up just before it.
	await s.fastRate();
	const now = () => s.clock.now();
	const wall0 = Date.now(), timer = await s.gameTimer();
	await s.command(`execute in ${spot.dim} run summon minecraft:zombie ${world(6, 0).join(' ')} {NoAI:1b,PersistenceRequired:1b}`);
	const track = [];
	const start = now();
	while (now() - start < 7000) {
		o = (await s.observeOrNull()) ?? o;
		track.push({ t: now() - start, x: round(o.position?.x ?? 0), z: round(o.position?.z ?? 0), firing: o.reflexes?.firing?.detail ?? null });
		await s.clock.sleep(250);
	}
	const tick = { seconds: Math.round((now() - start) / 1000), wallSeconds: Math.round((Date.now() - wall0) / 1000), gameSeconds: Math.round((await timer.elapsed()) / 1000),
		rates: await timer.rates().catch(() => null) };
	await s.normalRate();
	tick.held = await s.tickReport();
	const events = eventsOf(o, ids, since);
	const final = track.at(-1);
	const died = (await deaths(s)) > deathsBefore || (await health(s)) <= 0;
	await s.command(`execute in ${spot.dim} run kill @e[type=minecraft:zombie]`);
	// The rule under test must fire: a body that walked out on its own measured nothing (finishRun reports it invalid).
	return { recorded: spot.recorded, tick: { rate: s.tickRate, ...tick }, walkedIn: walked, events, died, hold: reflexHold(o.reflexes, { id: 'escape', sinceSeq: since, holdMs: 0 }), startedAt: start0.map(round), final: [final.x, final.z],
		fromZombie: round(Math.hypot(final.x - world(6, 0)[0], final.z - world(6, 0)[2])), escaped: !events.some(e => e.outcome === 'failed') && final.z < oz - 1, track: track.filter((_, i) => i % 2 === 0) };
}

const selected = SPOTS.filter(spot => !only.length || only.includes(spot.name));
const rows = [];
for (const spot of selected) {
	const dir = join(out, spot.name);
	await mkdir(dir, { recursive: true });
	let s;
	const row = { name: spot.name, kind: spot.kind, startedAt: Date.now() };
	rows.push(row);
	try {
		s = await boot(dir);
		results.spots[spot.name] = await tunnelSpot(s, spot);
		const r = results.spots[spot.name];
		Object.assign(row, { died: r.died ?? null, lost: r.lost ?? null, events: r.events?.map(e => e.outcome) ?? null, reflexHold: r.hold, finishedAt: Date.now() });
		row.pass = spotPassed(spot, r);
	} catch (error) {
		results.spots[spot.name] = { ...(results.spots[spot.name] ?? {}), error: String(error?.stack ?? error).slice(0, 600) };
		row.error = results.spots[spot.name].error;
	} finally {
		await s?.stop().catch(() => {});
		// A boot that threw (bridge never ready) leaves no s to stop: its server would hold the slot's ports.
		if (liveServer?.exitCode === null) liveServer.kill('SIGKILL');
		await rm(join(dir, 'server'), { recursive: true, force: true }).catch(() => {});
		await writeFile(join(out, 'failspots.json'), JSON.stringify(results, null, 2));
		await finishRun(rows, { file: join(out, 'result.json'), planned: selected.length, strict });
	}
	console.log(`[spot] ${spot.name}: ${JSON.stringify(Object.fromEntries(Object.entries(results.spots).filter(([k]) => k.startsWith(spot.name.replace(/[A-Z].*$/, ''))).map(([k, v]) => [k, { events: v.events, lost: v.lost, died: v.died, error: v.error }])))}`);
}
await writeFile(join(out, 'failspots.json'), JSON.stringify(results, null, 2));
const report = await finishRun(rows, { file: join(out, 'result.json'), planned: selected.length, strict });
console.log(JSON.stringify(report));
process.exit(report.exitCode);
