#!/usr/bin/env node
// End knock-off room: the body stands on a 1x1 column 22 blocks above an end-stone island (the height of the column it
// builds to open a caged crystal) with the End reflex set the coordinator arms there, and is put off the column's
// edge by a wind charge burst, as the dragon's charge throws it. Three plain knock-offs, then three with a breath cloud on the column top, so
// the breath run is holding when the fall starts. Each fall is judged on health lost (a 22-block drop costs 19 of 20).
// KNOCKOFF_RULES=main leaves out default-end-fall (main's End set before it was a default).
// Usage: slot.sh live node scripts/quality/test-end-knockoff-live.mjs OUT (ARENA_JAR names the jar).
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
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { damageCounter, recordDamageEvidence, deathCounter, recordDeathEvidence } from './lib/damage-counter.mjs';

const USAGE = 'Usage: slot.sh live node scripts/quality/test-end-knockoff-live.mjs OUT (ARENA_JAR names the jar; KNOCKOFF_RULES=main leaves out default-end-fall)';
if (process.argv.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, MOD_JAR));
const out = resolve(process.argv[2] ?? 'runtime/end-knockoff-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true, jarSha256: createHash('sha256').update(await readFile(jarPath)).digest('hex'), node: process.version }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('mineagen-')) await unlink(join(server, 'mods', name));
await cp(jarPath, join(server, 'mods/mineagen-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261017\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\ndifficulty=normal\n`);
const log = await open(join(out, 'server.log'), 'a');
const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Dmineagen.bridgePort=${port}`, '-Dmineagen.coordinatorAutoStart=false', `-Dmineagen.bridgeSecretFile=${join(out, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
await writeFile(join(out, 'server.pid'), String(child.pid));
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', e => this.accept(e)); bridge.on('ready', e => this.accept({ type: 'ready', ...e })); }
	accept(e) { const i = this.waiters.findIndex(w => w.type === e.type && w.match(e)); if (i >= 0) this.waiters.splice(i, 1)[0].done(e); else { this.events.push(e); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) { const i = this.events.findIndex(e => e.type === type && match(e)); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, match, done: e => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(w); }); }
}
let rcon, bridge, record, observation, inbox, revision = 0, rate;
const agent = 'Climber';
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
const end = s => command(`execute in minecraft:the_end run ${s}`);
async function observe() { const seq = observation?.eventSequence ?? 0; const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq); await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }); return (await next).payload; }
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(text.trim()) ?? [])[1]);
const health = async () => number(await command(`data get entity ${agent} Health`));
const results = { rules: null, falls: [], startedAt: Date.now() };
// The island is far south of the main island (no dragon there); the column stands at its centre.
// KNOCKOFF_TOP raises the column (default 78, cage height; the bot climbs to about y105-110 to shoot over the last crystals).
const GROUND = 56, TOP = Number(process.env.KNOCKOFF_TOP ?? 78), CX = 0, CZ = 300;
const arm = process.env.KNOCKOFF_RULES === 'main' ? 'main' : 'branch';
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	rate = installTickRate({ command: text => command(text) }, unshownTickRate('not played in the 20 v 60 TPS A/B'));
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { rate.clock.observe(e.payload?.world?.gameTime); if (e.agentId === record?.agentId && e.payload.ready) observation = e.payload; });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free End knock-off fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('forceload add -16 -16 16 16'); await sleep(2000);
	await command('fill -4 80 -4 4 80 4 minecraft:stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 81 0.5 run mineagen summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); await command(`mineagen start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	await command(`effect give ${agent} minecraft:saturation 1200 4 true`);
	// The kit goes back on before every fall: a death drops it.
	const kit = async () => { for (const [slot, item] of [['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots'], ['hotbar.0', 'iron_sword'], ['hotbar.1', 'bow'], ['hotbar.2', 'end_stone 32'], ['hotbar.3', 'water_bucket']]) await command(`item replace entity ${agent} ${slot} with minecraft:${item}`); };
	await end(`forceload add ${CX - 16} ${CZ - 16} ${CX + 16} ${CZ + 16}`); await sleep(2000);
	await end(`fill ${CX - 10} ${GROUND} ${CZ - 10} ${CX + 10} ${GROUND} ${CZ + 10} minecraft:end_stone`);
	const clearIsland = async () => {
		await end('kill @e[type=minecraft:area_effect_cloud]'); await end('kill @e[type=minecraft:dragon_fireball]'); await end('kill @e[type=minecraft:enderman]'); await end('kill @e[type=minecraft:item]');
		await end(`fill ${CX - 10} ${GROUND + 1} ${CZ - 10} ${CX + 10} ${TOP + 4} ${CZ + 10} minecraft:air`);
		await end(`fill ${CX} ${GROUND + 1} ${CZ} ${CX} ${TOP} ${CZ} minecraft:end_stone`);
	};
	await command('scoreboard objectives add fixture_deaths deathCount');
	const deaths = () => deathCounter(command, agent, { objective: 'fixture_deaths', unsetIsZero: true });
	await clearIsland();
	// The rules the coordinator arms on entering the End: the survival defaults plus the End's own.
	const book = new ReflexBook();
	book.observeContext(record.agentId, { world: { dimension: 'minecraft:the_end' }, player: { health: 20 } });
	const rules = book.payload(record.agentId).rules.filter(rule => arm !== 'main' || rule.id !== 'default-end-fall');
	results.rules = { arm, count: rules.length, endFall: rules.some(rule => rule.id === 'default-end-fall') };
	let lastPlace = null;
	const toTop = async () => {
		for (let attempt = 0; attempt < 5; attempt++) {
			// Onto the ground beside the column first: straight from a landing, the body went back to its landing cell
			// within 2 s of a teleport up and fell again.
			await end(`tp ${agent} ${CX + 0.5} ${GROUND + 1} ${CZ + 6.5} 90 20`); await sleep(1000);
			await end(`tp ${agent} ${CX + 0.5} ${TOP + 1} ${CZ + 0.5} 90 20`);
			await command(`effect give ${agent} minecraft:instant_health 1 5 true`);
			await sleep(2500);
			const o = await observe().catch(() => null);
			lastPlace = o ? { dimension: o.world?.dimension ?? null, y: o.position?.y ?? null, onGround: o.player?.onGround ?? null } : null;
			if (o?.world?.dimension === 'minecraft:the_end' && Math.abs(o.position.y - (TOP + 1)) < 0.3 && o.player?.onGround) return o;
		}
		return null;
	};
	await toTop();
	revision += 1;
	await bridge.send('reflex_update', record.agentId, { revision, rules, yield: false });
	for (let i = 0; i < 40 && (await observe()).reflexes?.revision !== revision; i++) await sleep(100);
	const lastSeq = o => Math.max(0, ...(o.reflexes?.events ?? []).map(event => event.seq ?? 0));
	const reflexEvents = (o, since) => (o.reflexes?.events ?? []).filter(event => (event.seq ?? 0) > since).map(event => `${event.id} ${event.outcome}${event.detail ? `: ${event.detail}` : ''}`);
	const fall = async (breath) => {
		await kit();
		const top = await toTop();
		const row = { breath, placed: Boolean(top) };
		if (!top) { row.notExercised = 'the body never stood on the column top'; row.lastPlace = lastPlace; return row; }
		const tick0 = lastSeq(top);
		if (breath) {
			// A dragon fireball dropped on the column top: vanilla makes the breath cloud where it hits.
			await end(`summon minecraft:dragon_fireball ${CX + 0.5} ${TOP + 1.3} ${CZ + 0.5} {Motion:[0.0d,-1.0d,0.0d],acceleration_power:0.1d}`);
			let o;
			for (let i = 0; i < 20; i++) { await sleep(150); o = await observe(); if (o.reflexes?.firing?.id === 'default-breath') break; }
			row.breathFiring = o.reflexes?.firing?.id === 'default-breath';
		}
		const before = await health();
		const o = await observe();
		row.before = before;
		row.startY = Math.round(o.position.y * 10) / 10;
		if (o.position.y < TOP + 0.5) { row.offEarly = true; }
		// The throw: a wind charge bursts against the body from the west and blows it east off the top, as the dragon's
		// charge does, with no command (a waiting command never ran under the breath hold; a teleport into the air left
		// later teleports reverted to the landing).
		else await end(`summon minecraft:wind_charge ${CX - 1.5} ${o.position.y + 0.6} ${CZ + 0.5} {Motion:[0.8d,0.0d,0.0d],acceleration_power:0.0d}`);
		const deaths0 = await deaths();
		// A dead body sends no ready observation: the landing is read from the server (position, health, death count).
		const at = async () => number((await command(`data get entity ${agent} Pos[1]`)) ?? '');
		for (let i = 0; i < 60; i++) { await sleep(150); if (await deaths() > deaths0) break; const y = await at(); if (Number.isFinite(y) && y < GROUND + 3) break; }
		await sleep(3000);
		row.dead = (await deaths()) > deaths0;
		const after = row.dead ? null : await observe().catch(() => null);
		row.after = row.dead ? 0 : await health();
		row.lost = row.dead ? before : Math.round((before - row.after) * 10) / 10;
		row.endY = row.dead ? null : Math.round((after?.position?.y ?? await at()) * 10) / 10;
		row.fell = row.dead || row.endY < GROUND + 3 && row.startY - row.endY >= 15;
		if (!row.fell && !row.dead) row.notExercised = `the body did not fall off the column (ended at y ${row.endY})`;
		row.caught = row.fell && !row.dead && row.lost < 2;
		row.bucketBack = (await command(`data get entity ${agent} Inventory[{Slot:3b}].id`)).includes('water_bucket');
		row.reflex = after ? reflexEvents(after, tick0) : null;
		row.firingAtThrow = o.reflexes?.firing?.id ?? null;
		if (row.dead) { await command(`mineagen respawn ${agent}`).catch(() => {}); await sleep(3000); await command(`effect give ${agent} minecraft:saturation 1200 4 true`); }
		return row;
	};
	for (let i = 0; i < 3; i++) { results.falls.push(await fall(false)); await clearIsland(); }
	for (let i = 0; i < 3; i++) { results.falls.push(await fall(true)); await clearIsland(); }
	const valid = results.falls.filter(row => !row.notExercised);
	results.deaths = valid.filter(row => row.dead).length;
	results.damageTaken = Math.round(valid.reduce((sum, row) => sum + (row.lost ?? 0), 0) * 10) / 10;
	results.summary = { arm, falls: valid.length, caught: valid.filter(row => row.caught).length, breathCaught: valid.filter(row => row.breath && row.caught).length,
		bucketBack: valid.filter(row => row.bucketBack).length, deaths: results.deaths, jar: jarPath };
	if (valid.length < results.falls.length) results.notExercised = results.falls.find(row => row.notExercised).notExercised;
	results.bar = 'every knock-off lands with under 2 health lost';
	results.pass = valid.length === results.falls.length && valid.every(row => row.caught);
	await writeFile(join(out, 'end-knockoff.json'), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(results.summary, null, 2));
} catch (error) {
	results.error = String(error?.stack ?? error);
	console.error(results.error);
} finally {
	results.finishedAt = Date.now();
	await writeFile(join(out, 'end-knockoff.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
// One row for the room: an error or an unexercised throw is invalid evidence (exit 2), a missed catch a fail (exit 1).
const { falls, rules, ...room } = results;
const report = await finishRun([{ name: 'end-knockoff', ...room }], { file: join(out, 'acceptance.json'), planned: 1 });
process.exit(report.exitCode);
