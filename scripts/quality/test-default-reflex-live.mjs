#!/usr/bin/env node
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { installTickRate, unshownTickRate } from './watch-replay.mjs';
import { damageCounter, recordDamageEvidence } from './lib/damage-counter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, MOD_JAR));
const out = resolve(process.argv[2] ?? 'runtime/default-reflex-live');
const repeats = Number(process.env.REPEATS ?? 2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true, jarSha256: createHash('sha256').update(await readFile(jarPath)).digest('hex'), node: process.version }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('mineagen-')) await unlink(join(server, 'mods', name));
await cp(jarPath, join(server, 'mods/mineagen-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261028\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=5\nsimulation-distance=5\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=false\n`);
const log = await open(join(out, 'server.log'), 'a');
const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Dmineagen.bridgePort=${port}`, '-Dmineagen.coordinatorAutoStart=false', `-Dmineagen.bridgeSecretFile=${join(out, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
await writeFile(join(out, 'server.pid'), String(child.pid));
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', e => this.accept(e)); bridge.on('ready', e => this.accept({ type: 'ready', ...e })); }
	accept(e) { const i = this.waiters.findIndex(w => w.type === e.type && w.match(e)); if (i >= 0) this.waiters.splice(i, 1)[0].done(e); else { this.events.push(e); if (this.events.length > 2048) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) { const i = this.events.findIndex(e => e.type === type && match(e)); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, match, done: e => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(w); }); }
}
let rcon, bridge, inbox, ordinal = 0, rate;
const latest = new Map();
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
const numbers = text => (/\[([^\]]*)\]/.exec(text)?.[1] ?? '').split(',').map(v => Number(v.trim().replace(/[a-z]$/i, '')));
const round = v => Math.round(v * 100) / 100;
const pos = async name => { const [x, y, z] = numbers(await command(`data get entity ${name} Pos`)); return { x, y, z }; };
const health = async name => { const text = await command(`data get entity ${name} Health`); const value = Number(/(-?[0-9.]+)f?\s*$/.exec(text.trim())?.[1]); return Number.isFinite(value) ? value : null; };

const agents = [
	{ name: 'Ember', mode: 'defaults', ox: 0 },
	{ name: 'Ash', mode: 'none', ox: 40 },
];

async function register(agent) {
	const registered = inbox.wait('agent_registered');
	await command(`execute positioned ${agent.ox + 0.5} 81 -1.5 run mineagen summon gpt-6.1-sol low ${agent.name}`);
	const e = await registered; agent.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', agent.record.agentId, { goalRevision: agent.record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.agentId === agent.record.agentId && e.payload.operation === 'start');
	await command(`mineagen start ${agent.name} Survive for 1200 seconds.`); agent.record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', agent.record.agentId, { goalRevision: agent.record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent.name}`);
	await command(`effect give ${agent.name} minecraft:saturation 1200 4 true`);
	agent.damage = await damageCounter(command, agent.name);
}

/**
 * FIXTURE_TICK_RATE: each case is built at 20 and the server runs at the fixture rate only from its trigger (the
 * fireball, the drop over lava, the fire) to the end of its watch, which polls on the fixture clock. The watch is 50
 * polls of three RCON reads each, not a fixed window: at a raised rate those reads take more game time, so it covers
 * somewhat more game time than at 20 (never less).
 */
async function playStart(agent) {
	const damage0 = await agent.damage().catch(() => null);
	await rate.fastRate();
	return { agent, damage0, t0: rate.clock.now(), wall0: Date.now(), timer: await rate.gameTimer() };
}
async function playEnd(p) {
	// elapsed() reads the world tick first, so the clock is anchored on it when seconds is read.
	const gameMs = await p.timer.elapsed();
	const tick = { tickRate: rate.tickRate, seconds: Math.round((rate.clock.now() - p.t0) / 1000), wallSeconds: Math.round((Date.now() - p.wall0) / 1000),
		gameSeconds: Math.round(gameMs / 1000), rates: await p.timer.rates().catch(() => null) };
	await rate.normalRate();
	tick.held = await rate.tickReport();
	recordDamageEvidence(tick, p.damage0, await p.agent.damage().catch(() => null));
	return tick;
}

async function armDefaults(agent) {
	const book = new ReflexBook(rate.clock.rate === 20 ? {} : { now: () => rate.clock.now() });
	const sample = latest.get(agent.record.agentId);
	if (!book.observeContext(agent.record.agentId, sample)) throw new Error('defaults did not arm on a live sample');
	const payload = book.payload(agent.record.agentId);
	await bridge.send('reflex_update', agent.record.agentId, payload);
	for (let i = 0; i < 50; i++) {
		const reflexes = latest.get(agent.record.agentId)?.reflexes;
		if (reflexes?.revision === payload.revision && reflexes.rules.length === payload.rules.length) return reflexes.rules.map(r => `${r.id}:${r.state}`);
		await bridge.send('request_observation', agent.record.agentId, { goalRevision: agent.record.goalRevision });
		await sleep(200);
	}
	throw new Error('the mod did not echo the default rules');
}

function control(agent, args) {
	const id = `dr-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: agent.record.goalRevision, actionType: 'control', arguments: args,
		provenance: { provider: agent.record.provider, model: agent.record.model, reasoningEffort: agent.record.reasoningEffort, serviceTier: agent.record.serviceTier, traceId: id, programId: 'dr-fixture', programVersion: 1, sourceStepId: id, eventSequence: latest.get(agent.record.agentId)?.eventSequence ?? 0 } };
	const done = inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000)
		.then(async e => { await bridge.send('action_result_ack', agent.record.agentId, { actionId: id, goalRevision: agent.record.goalRevision }); return e.payload; });
	return { sent: bridge.send('action_command', agent.record.agentId, payload), done };
}

/** Lava pool (y80, z 1..3) beside a stone pad (y80, z -3..0), floor y79; the body's pad is x ox-3..ox+3. */
async function buildLava(ox) {
	await command(`fill ${ox - 4} 79 -4 ${ox + 4} 79 4 minecraft:stone`);
	await command(`fill ${ox - 4} 80 -4 ${ox + 4} 84 4 minecraft:air`);
	await command(`fill ${ox - 4} 80 -4 ${ox + 4} 80 0 minecraft:stone`);
	await command(`fill ${ox - 4} 80 1 ${ox + 4} 80 3 minecraft:lava`);
	await command(`fill ${ox - 4} 80 4 ${ox + 4} 81 4 minecraft:stone`);
}
async function buildBridge(ox) {
	// Floor 30 blocks under the walking surface: a lethal fall at full health (the brink guard walks back only those).
	await command(`fill ${ox - 8} 50 12 ${ox + 8} 50 24 minecraft:stone`);
	await command(`fill ${ox - 8} 51 12 ${ox + 8} 84 24 minecraft:air`);
	await command(`fill ${ox - 6} 80 18 ${ox + 6} 80 18 minecraft:stone`);
}
async function revive(agent) {
	// Every case is set up at 20, also after one that failed mid-watch.
	await rate.normalRate();
	await command(`effect clear ${agent.name}`);
	await command(`extinguish ${agent.name}`).catch(() => {});
	await command(`effect give ${agent.name} minecraft:instant_health 1 5 true`);
	await command(`effect give ${agent.name} minecraft:saturation 1200 4 true`);
}

async function watch(agent, start) {
	let minY = start.y, entered = false, last = start, alive = true;
	for (let i = 0; i < 50; i++) {
		await rate.clock.sleep(200);
		const h = await health(agent.name).catch(() => null);
		if (h === null || h <= 0) { alive = false; break; }
		last = await pos(agent.name);
		minY = Math.min(minY, last.y);
		const sample = latest.get(agent.record.agentId);
		if (sample?.player?.inLava === true || /passed/i.test(await command(`execute as ${agent.name} at @s if block ~ ~ ~ minecraft:lava`).catch(() => ''))) entered = true;
	}
	const finalHealth = alive ? await health(agent.name) : 0;
	return { alive, entered, health: finalHealth, end: { x: round(last.x), y: round(last.y), z: round(last.z) }, fell: round(start.y - minY) };
}

async function lavaKnock(agent) {
	await buildLava(agent.ox); await revive(agent);
	await command(`tp ${agent.name} ${agent.ox + 0.5} 81 0.75 0 10`); await rate.idleSleep(1500);
	const start = await pos(agent.name);
	const play = await playStart(agent);
	await command(`summon minecraft:small_fireball ${agent.ox + 0.5} 81.9 -2.5 {Motion:[0.0,0.0,0.6],acceleration_power:0.0}`);
	const row = { case: 'lava-knock', agent: agent.name, mode: agent.mode, ...(await watch(agent, start)) };
	return { ...row, tick: await playEnd(play) };
}
async function lavaDrop(agent) {
	await buildLava(agent.ox); await revive(agent);
	const play = await playStart(agent);
	await command(`tp ${agent.name} ${agent.ox + 0.5} 81.6 2.5 0 10`);
	const start = await pos(agent.name);
	const row = { case: 'lava-drop', agent: agent.name, mode: agent.mode, ...(await watch(agent, start)) };
	return { ...row, tick: await playEnd(play) };
}
// edge-control-shield: the same shot with a shield in the offhand, which blocks the hit and its knockback.
async function edgeControl(agent, shield = false) {
	await buildBridge(agent.ox); await revive(agent);
	if (shield) await command(`item replace entity ${agent.name} weapon.offhand with minecraft:shield`);
	await command(`effect give ${agent.name} minecraft:resistance 60 255 true`);
	// A player on a bridge has seen the drop on both sides: look down each side, then along the bridge.
	await command(`tp ${agent.name} ${agent.ox + 0.5} 81 18.5 0 70`); await rate.idleSleep(1000);
	await command(`tp ${agent.name} ${agent.ox + 0.5} 81 18.5 180 70`); await rate.idleSleep(1000);
	await command(`tp ${agent.name} ${agent.ox + 0.5} 81 18.5 -90 10`); await rate.idleSleep(1000);
	const play = await playStart(agent);
	const keys = control(agent, { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw: -90, pitch: 10, selectedSlot: 0, hand: 'main', ticks: 70 });
	await keys.sent; await rate.clock.sleep(400);
	const start = await pos(agent.name);
	await command(`summon minecraft:small_fireball ${agent.ox + 0.5} 81.9 15.5 {Motion:[0.0,0.0,0.6],acceleration_power:0.0}`);
	const row = { case: shield ? 'edge-control-shield' : 'edge-control', agent: agent.name, mode: agent.mode, ...(await watch(agent, start)) };
	row.tick = await playEnd(play);
	await keys.done.catch(() => null);
	await command(`effect clear ${agent.name} minecraft:resistance`);
	if (shield) await command(`item replace entity ${agent.name} weapon.offhand with minecraft:air`);
	// Empty-handed, a fireball's knockback lifts the body off a one-wide bridge before any reflex can act (the rule-less
	// body falls the same): that shot is recorded, not judged. The shield shot is the bar: blocked, the hit pushes nothing.
	return shield ? { ...row, offBridge: row.fell > 3 } : { ...row, knockedOff: row.fell > 3 };
}

/** A one-cell stone shelter on a pad at z 30 (walls two high, roof, a window at eye height east), fire at the feet. */
async function shelterFire(agent) {
	await command(`fill ${agent.ox - 3} 79 27 ${agent.ox + 3} 79 33 minecraft:stone`);
	await command(`fill ${agent.ox - 3} 80 27 ${agent.ox + 3} 84 33 minecraft:air`);
	await command(`fill ${agent.ox - 3} 80 27 ${agent.ox + 3} 80 33 minecraft:stone`);
	// Netherrack under the cell: fire on it never burns out by itself (vanilla), so only a punch puts it out.
	await command(`setblock ${agent.ox} 80 30 minecraft:netherrack`);
	await revive(agent);
	await command(`tp ${agent.name} ${agent.ox + 0.5} 81 30.5 -90 30`); await rate.idleSleep(1000);
	await command(`fill ${agent.ox - 1} 81 29 ${agent.ox + 1} 82 31 minecraft:cobblestone hollow`);
	await command(`fill ${agent.ox - 1} 83 29 ${agent.ox + 1} 83 31 minecraft:cobblestone`);
	await command(`setblock ${agent.ox + 1} 82 30 minecraft:air`);
	// Look round the cell so its walls and floor are seen terrain, as a body that built it has seen them.
	for (const yaw of [-90, 0, 90, 180]) { await command(`tp ${agent.name} ${agent.ox + 0.5} 81 30.5 ${yaw} 60`); await rate.idleSleep(400); }
	// No saturation effect here: its regeneration would hide the burn.
	await command(`effect clear ${agent.name}`);
	const start = await pos(agent.name);
	const play = await playStart(agent);
	await command(`setblock ${agent.ox} 81 30 minecraft:fire`);
	let fireOutS = null;
	const t0 = rate.clock.now();
	const poll = (async () => { for (let i = 0; i < 50 && fireOutS === null; i++) { await rate.clock.sleep(200); if (!/passed/i.test(await command(`execute if block ${agent.ox} 81 30 minecraft:fire`).catch(() => 'passed'))) fireOutS = Math.round((rate.clock.now() - t0) / 100) / 10; } })();
	const row = { case: 'shelter-fire', agent: agent.name, mode: agent.mode, ...(await watch(agent, start)) };
	await poll;
	row.tick = await playEnd(play);
	row.fireLeft = /passed/i.test(await command(`execute if block ${agent.ox} 81 30 minecraft:fire`).catch(() => ''));
	row.fireOutS = fireOutS;
	row.reflexes = (latest.get(agent.record.agentId)?.reflexes?.rules ?? []).map(r => `${r.id}:${r.state}:${r.fired}`).join(' ');
	row.events = JSON.stringify(latest.get(agent.record.agentId)?.reflexes?.events ?? []).slice(0, 600);
	return row;
}

const results = { rules: {}, cases: [] };
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	// 21 Nov A/B, 10 runs a side: in 4 of 8 shelter-fire and edge-control cases the body lived at 20 and died at 60 (its
	// watch is a count of polls, so it covers more game time at 60). It stays at 20 until the watch counts game time.
	rate = installTickRate({ command: text => command(text) }, unshownTickRate('the body without rules died at 60 TPS in cases it survived at 20'));
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { rate.clock.observe(e.payload?.world?.gameTime); if (e.payload.ready) latest.set(e.agentId, e.payload); });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free default reflex fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('forceload add -32 -32 80 32'); await sleep(2000);
	for (const agent of agents) { await buildLava(agent.ox); await register(agent); }
	for (const agent of agents) {
		await bridge.send('request_observation', agent.record.agentId, { goalRevision: agent.record.goalRevision });
		for (let i = 0; i < 50 && !latest.has(agent.record.agentId); i++) await sleep(200);
	}
	results.rules.Ember = await armDefaults(agents[0]);
	console.log(JSON.stringify(results.rules));
	// The edge case first (resistance keeps both alive), then lava; the rule-less body dies in lava last.
	const only = process.env.CASES ? new Set(process.env.CASES.split(',')) : null;
	if (!only || only.has('shelter-fire')) for (let r = 0; r < repeats; r++) for (const agent of agents) { const row = await shelterFire(agent); console.log(JSON.stringify(row)); results.cases.push(row); await revive(agent); await command(`extinguish ${agent.name}`).catch(() => {}); }
	if (!only || only.has('edge-control')) for (let r = 0; r < repeats; r++) for (const agent of agents) { const row = await edgeControl(agent); console.log(JSON.stringify(row)); results.cases.push(row); }
	if (only?.has('edge-control-shield')) for (let r = 0; r < repeats; r++) for (const agent of agents) { const row = await edgeControl(agent, true); console.log(JSON.stringify(row)); results.cases.push(row); }
	if (!only || only.has('lava')) for (const agent of agents) {
		for (const run of [lavaKnock, lavaDrop]) for (let r = 0; r < repeats; r++) {
			const h = await health(agent.name).catch(() => null);
			if (h === null || h <= 0) { results.cases.push({ case: run.name, agent: agent.name, mode: agent.mode, skipped: 'body dead from an earlier case' }); continue; }
			const row = await run(agent); console.log(JSON.stringify(row)); results.cases.push(row);
		}
	}
	const tally = (mode, name) => { const rows = results.cases.filter(c => c.mode === mode && c.case === name && !c.skipped); return `${rows.filter(c => name.startsWith('edge-control') ? !(c.offBridge ?? c.knockedOff) : c.alive).length}/${rows.length}${name.startsWith('edge-control') ? ' stayed on' : ' alive'}${name.startsWith('lava') ? `, entered lava ${rows.filter(c => c.entered).length}/${rows.length}` : ''}`; };
	results.summary = Object.fromEntries(['defaults', 'none'].map(mode => [mode, Object.fromEntries(['edge-control', 'edge-control-shield', 'lava-knock', 'lava-drop'].map(name => [name, tally(mode, name)]))]));
	results.summary.jar = jarPath;
	results.tickRate = rate.tickRate;
	console.log(JSON.stringify(results.summary, null, 2));
} finally {
	await writeFile(join(out, 'default-reflex.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
