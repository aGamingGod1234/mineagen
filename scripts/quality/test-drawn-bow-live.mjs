#!/usr/bin/env node
// Provider-free A/B check of the arrow shield in a real server: this script stands in for the coordinator and installs
// one shield rule, the arrow-only one (incoming_projectile withinS 0.6, the old default-arrow) or the shipped default-arrow
// (drawn:true, which also reads a bow drawn at the body; RULE_ARMS=drawn plays only this one). A live skeleton at 4, 7 and 10 blocks
// shoots at an idle body with a shield in the off hand. Vanilla's damage_blocked_by_shield and damage_taken counters
// (tenths of HP) give the share of arrow damage the shield stopped in each arm. Pass: the drawn arm blocks at least
// DRAWN_MIN_SHARE of the damage and more than the arrow-only arm. CP2r baseline with a shield in hand: 41 of 77 hits blocked.
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build the fixture and spawn mobs only.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries, DEFAULT_REFLEXES } from '../../coordinator/src/reflexes.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { statCounter, shieldShareVerdict } from './lib/damage-counter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-drawn-bow-live.mjs [OUT_DIR] [--strict|--descriptive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME (DISTANCES, REPEATS, CASE_SECONDS, DRAWN_MIN_SHARE, RULE_ARMS, ARENA_JAR)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const out = resolve(cli.filter((arg) => !['--strict', '--descriptive'].includes(arg))[0] ?? 'runtime/drawn-bow-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const jar = resolve(process.env.ARENA_JAR ?? join(root, MOD_JAR));
if (!existsSync(jar)) { console.error(`no jar at ${jar}`); process.exit(2); }
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), node: process.version }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('mineagen-')) await unlink(join(server, 'mods', name));
await cp(jar, join(server, 'mods/mineagen-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261018\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=5\nsimulation-distance=5\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=false\n`);
const log = await open(join(out, 'server.log'), 'a');
const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Dmineagen.bridgePort=${port}`, '-Dmineagen.coordinatorAutoStart=false', `-Dmineagen.bridgeSecretFile=${join(out, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
await writeFile(join(out, 'server.pid'), String(child.pid));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', (event) => this.accept(event)); bridge.on('ready', (event) => this.accept({ type: 'ready', ...event })); }
	accept(event) { const index = this.waiters.findIndex((waiter) => waiter.type === event.type && waiter.match(event)); if (index >= 0) this.waiters.splice(index, 1)[0].done(event); else { this.events.push(event); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) {
		const index = this.events.findIndex((event) => event.type === type && match(event));
		if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
		return new Promise((resolveWait, reject) => { const waiter = { type, match, done: (event) => { clearTimeout(timer); resolveWait(event); } }; const timer = setTimeout(() => { this.waiters = this.waiters.filter((entry) => entry !== waiter); reject(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(waiter); });
	}
}

let rcon, bridge, record, observation, inbox, revision = 0, ordinal = 0;
const agent = 'Reflex';
const timeline = [];
const command = async (text) => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(text)).text;
};
async function observe() {
	const sequence = observation?.eventSequence ?? 0;
	const next = inbox.wait('observation', (event) => event.agentId === record.agentId && event.payload.ready && event.payload.eventSequence > sequence);
	await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision });
	return (await next).payload;
}
/** As the coordinator sends rules: the complete set in wire form (model rules through normalizeReflexEntries), a new revision. */
async function setReflexes(rules) {
	revision += 1;
	await bridge.send('reflex_update', record.agentId, { revision, rules, yield: false });
	for (let index = 0; index < 40; index += 1) { const o = await observe(); if (o.reflexes?.revision === revision) return o; await sleep(100); }
	throw new Error(`reflex revision ${revision} never echoed`);
}
function startAction(type, args) {
	const id = `reflex-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'reflex-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const result = inbox.wait('action_result', (event) => event.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(event.payload.state), 90000)
		.then(async (event) => { await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }); return event.payload; });
	return bridge.send('action_command', record.agentId, payload).then(() => ({ id, result }));
}
const events = (o, id) => (o.reflexes?.events ?? []).filter((event) => event.id === id);
const health = (o) => o.player?.health;

const results = {};
// One acceptance row: the drawn arm's blocked share against the floor and the arrow-only arm. A crash is invalid evidence.
const acceptance = { startedAt: Date.now() };
const only = (process.env.REFLEX_ONLY ?? '').split(',').filter(Boolean);
let o;
try {
	for (let attempt = 0; attempt < 150; attempt += 1) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (error) { await rcon?.close(); if (attempt === 149) throw error; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', (event) => {
		if (event.agentId !== record?.agentId || !event.payload.ready) return;
		observation = event.payload;
		const firing = event.payload.reflexes?.firing;
		timeline.push({ at: Date.now(), firing: firing?.id ?? null, action: event.payload.currentAction?.active ? event.payload.currentAction.actionId ?? true : false, health: event.payload.player?.health, incoming: (event.payload.incomingProjectiles ?? []).map((row) => `${row.type}@${row.etaSeconds}`), yaw: event.payload.view?.yaw, air: event.payload.player?.air, y: event.payload.position?.y });
	});
	// Follow goal revisions (the accepted goal spec bumps it); reflex rules are not tied to a revision.
	bridge.on('message', (event) => {
		if (!['observation', 'action_progress', 'heartbeat'].includes(event.type)) console.log(`[in] ${event.type} ${JSON.stringify(event.payload).slice(0, 160)}`);
		const registered = ['agent_registered', 'registry_entry'].includes(event.type) ? { goalRevision: event.payload.goalRevision ?? event.payload.record?.goalRevision, operation: 'registered' } : null;
		const control = registered ?? (event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null);
		if (control == null || event.agentId !== record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= record.goalRevision) return;
		if (['queue', 'dequeue'].includes(control.operation)) return;
		record.goalRevision = control.goalRevision;
		bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
	});
	bridge.on('goal_spec_request', (event) => { bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Controlled live reflex fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free reflex fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] });
	await command('difficulty normal'); await command('gamerule minecraft:send_command_feedback false'); await command('gamerule minecraft:spawn_mobs false');
	await command('time set noon'); await command('forceload add -32 -32 48 48'); await sleep(2000);
	await command('fill -24 75 -24 40 95 40 minecraft:air'); await command('fill -24 79 -24 40 79 40 minecraft:stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 80 0.5 run mineagen summon gpt-6.1-sol low ${agent}`));
	const summoned = await registered; record = { ...(summoned.payload.record ?? summoned.payload), agentId: summoned.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', (event) => event.payload.operation === 'start'); await command(`mineagen start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await sleep(2000); await observe();
	await command(`gamemode survival ${agent}`); await command(`clear ${agent}`);
	await command(`effect give ${agent} minecraft:saturation 5 10 true`);

	await command('time set midnight');
	// Unreadable counter reads stay null and make the run invalid evidence; only "none is set" is a real zero.
	const score = { blk: await statCounter(command, agent, 'blk', 'minecraft.custom:minecraft.damage_blocked_by_shield'), dmg: await statCounter(command, agent, 'dmg', 'minecraft.custom:minecraft.damage_taken') };
	// The drawn arm plays the shipped default-arrow rule as the coordinator sends it (its 10 s maxMs too), renamed for the events.
	const arrowOnly = normalizeReflexEntries([{ id: 'arrow-test', priority: 7, when: [{ type: 'incoming_projectile', withinS: 0.6 }], do: { type: 'shield' } }])[0];
	const drawn = { ...structuredClone(DEFAULT_REFLEXES.find((rule) => rule.id === 'default-arrow')), id: 'arrow-test' };
	// RULE_ARMS=drawn skips the arrow-only arm: half the room time when jars, not rules, are the A/B arms.
	const ruleArms = (process.env.RULE_ARMS ?? 'arrowOnly,drawn').split(',').filter(Boolean);
	if (!ruleArms.includes('drawn') || ruleArms.some((arm) => !['arrowOnly', 'drawn'].includes(arm))) throw new Error(`RULE_ARMS wants arrowOnly,drawn or drawn, got ${ruleArms}`);
	const distances = (process.env.DISTANCES ?? '4,7,10').split(',').map(Number);
	const repeats = Number(process.env.REPEATS ?? 2), seconds = Number(process.env.CASE_SECONDS ?? 30);
	const cases = [];
	for (let repeat = 0; repeat < repeats; repeat += 1) {
		for (const distance of distances) {
			for (const [arm, rule] of [['arrowOnly', arrowOnly], ['drawn', drawn]].filter(([arm]) => ruleArms.includes(arm))) {
				await command('kill @e[type=minecraft:skeleton]'); await command('kill @e[type=minecraft:arrow]');
				await command(`tp ${agent} 0.5 80 0.5 0 0`); await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
				await command(`effect give ${agent} minecraft:instant_health 1 3 true`);
				await setReflexes([rule]); await sleep(1000);
				const blocked0 = await score.blk(), taken0 = await score.dmg();
				// /summon gives a skeleton no bow (it then walks up and punches): hand it one, as a natural spawn has.
				await command(`summon minecraft:skeleton 0.5 80 ${0.5 + distance} {PersistenceRequired:1b,equipment:{mainhand:{id:"minecraft:bow",count:1}}}`);
				const seenEvents = new Map();
				for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(1000)) {
					// Observations come on request: read a fresh one, and top health up so no case ends in a death
					// (damage_taken still counts every hit).
					o = await observe();
					for (const row of events(o, 'arrow-test')) seenEvents.set(row.seq, row);
					if (process.env.DRAWN_DEBUG) console.log(`[tick] health ${health(o)} firing ${o.reflexes?.firing?.id ?? '-'} incoming ${JSON.stringify(o.incomingProjectiles ?? null)?.slice(0, 120)} mode ${o.player?.gameMode ?? o.gameMode ?? '?'}`);
					if ((health(o) ?? 20) < 12) await command(`effect give ${agent} minecraft:instant_health 1 3 true`);
				}
				const blocked1 = await score.blk(), taken1 = await score.dmg();
				o = await observe();
				cases.push({ arm, repeat, distance, blocked0, blocked1, taken0, taken1, events: [...seenEvents.values()] });
				const counter = (before, after) => before === null || after === null ? 'unreadable' : `${(after - before) / 10} HP`;
				console.log(`[case] ${arm} ${distance} blocks: blocked ${counter(blocked0, blocked1)}, taken ${counter(taken0, taken1)}; firings ${seenEvents.size}: ${[...seenEvents.values()].slice(0, 4).map(row => `${row.outcome} ${row.detail}`).join(' | ')}`);
				await setReflexes([]);
			}
		}
	}
	results.drawnBow = shieldShareVerdict(cases, Number(process.env.DRAWN_MIN_SHARE ?? 0.8), ruleArms);
	await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
	await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
	console.log(`blocked share: arrow-only ${results.drawnBow.shareArrowOnly}, drawn ${results.drawnBow.shareDrawn}`);
	acceptance.pass = results.drawnBow.pass;
	acceptance.shareArrowOnly = results.drawnBow.shareArrowOnly; acceptance.shareDrawn = results.drawnBow.shareDrawn;
	if (results.drawnBow.integrity) acceptance.integrity = results.drawnBow.integrity;
	if (acceptance.pass && !acceptance.integrity) console.log('Drawn bow shield verified');
} catch (error) {
	acceptance.error = String(error?.stack ?? error);
	console.error(error);
} finally {
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
acceptance.finishedAt = Date.now();
const report = await finishRun([acceptance], { file: join(out, 'acceptance.json'), planned: 1, strict });
console.log(JSON.stringify(report));
process.exit(report.exitCode);
