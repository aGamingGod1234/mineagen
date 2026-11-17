#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot } from './watch-replay.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = path.resolve(process.argv[2] ?? 'runtime/cornered-creeper-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!template || !port || !process.env.JAVA_HOME) throw new Error('Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, 'build/libs/mineagen-0.2.0.jar'));
const REPEATS = Number(process.env.REPEATS ?? 3);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jar, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), repeats: REPEATS, node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Creep';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const s = await boot(out, { jar, template, port, world: null, seed: '3315172112810107624' });
s.bridge.on('message', (event) => {
	const control = event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null;
	if (control == null || event.agentId !== s.record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= s.record.goalRevision) return;
	if (['queue', 'dequeue'].includes(control.operation)) return;
	s.record.goalRevision = control.goalRevision;
	s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
});
const health = async () => { const text = await s.command(`data get entity ${AGENT} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };
const deaths = async () => number(await s.command(`scoreboard players get ${AGENT} deaths`)) || 0;
const alive = async id => !/No entity|not found/i.test(await s.command(`data get entity ${id} Health`));
const runs = [];
try {
	await s.command('difficulty normal');
	await s.command('gamerule minecraft:spawn_mobs false');
	await s.command('gamerule minecraft:advance_time false');
	await s.command('time set midnight');
	let e = null, reply = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 30000).catch(() => null);
		reply = await s.command(`execute positioned -270.5 80 23.5 run codex summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${reply}`);
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`codex start ${AGENT} Survive for 1200 seconds.`); s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${AGENT}`);
	const book = new ReflexBook();
	if (!book.observeContext(s.record.agentId, await s.observe())) throw new Error('defaults did not arm');
	const payload = book.payload(s.record.agentId);
	await s.bridge.send('reflex_update', s.record.agentId, payload);
	for (let i = 0; i < 50 && (await s.observe()).reflexes?.revision !== payload.revision; i++) await sleep(200);
	await s.command('forceload add -330 -20 -270 40');
	await s.command('fill -320 99 -10 -280 99 30 minecraft:stone');
	await s.command('fill -320 100 -10 -280 110 30 minecraft:air');
	for (let run = 1; run <= REPEATS; run++) {
		for (let attempt = 0; attempt < 10 && !((await health().catch(() => 0)) > 0); attempt++) { await s.act('respawn', {}).catch(() => null); await sleep(1500); }
		await sleep(3500);
		await s.command('kill @e[type=!minecraft:player]');
		await s.command(`execute in minecraft:the_end run tp ${AGENT} 0.5 120 0.5`); await sleep(800);
		await s.command(`execute in minecraft:overworld run tp ${AGENT} -300.5 100 10.5 0 10`);
		await s.command(`clear ${AGENT}`);
		await s.command(`item replace entity ${AGENT} container.0 with minecraft:stone_sword`);
		await s.command(`effect clear ${AGENT}`);
		await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`);
		await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
		await s.command(`effect give ${AGENT} minecraft:slowness 60 6 true`);
		await sleep(1500);
		const id = n => `00000005-0000-0000-0000-0000${(run * 16 + n).toString(16).padStart(8, '0')}`, nbt = n => `[I;5,0,0,${run * 16 + n}]`;
		const zombie = id(1), creeper = id(2);
		await s.command(`summon minecraft:zombie -300.5 100 12.5 {UUID:${nbt(1)},PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b,Health:200f,attributes:[{id:"minecraft:max_health",base:200}]}`);
		for (let wait = 0; wait < 30 && !((await s.observe()).entities ?? []).some(row => row.uuid === zombie || row.stableId === zombie); wait++) await sleep(200);
		const deathsBefore = await deaths();
		const t0 = Date.now();
		let flee = null;
		const fleeing = s.act('flee_from', { targetId: zombie, distance: 14, timeoutMs: 60000 }, 90000).then(r => { flee = { ...r, atS: (Date.now() - t0) / 1000 }; }).catch(error => { flee = { state: 'ERROR', message: error.message }; });
		const fleeId = s.lastActionId;
		// The stand begins once the pinned flee gives up running (slowed, the zombie keeps up and hits).
		for (let i = 0; i < 12 && !flee; i++) await sleep(500);
		const standing = !flee;
		await s.command(`effect clear ${AGENT} minecraft:slowness`);
		await s.command(`attribute ${zombie} minecraft:attack_damage base set 0`);
		await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`);
		await sleep(700);
		const before = await health();
		await s.command(`execute at ${AGENT} positioned ~10 ~ ~ run summon minecraft:creeper ~ ~ ~ {UUID:${nbt(2)},PersistenceRequired:1b}`);
		let minHealth = before, died = false, exploded = false;
		const t1 = Date.now();
		while (Date.now() - t1 < 20000) {
			await sleep(250);
			const h = await health().catch(() => null);
			if ((await deaths()) > deathsBefore || h === 0) { died = true; break; }
			if (h !== null) minHealth = Math.min(minHealth, h);
			if (!exploded && !(await alive(creeper))) exploded = true;
			if (exploded && Date.now() - t1 > 3000) { await sleep(1000); const h2 = await health().catch(() => null); if (h2 !== null) minHealth = Math.min(minHealth, h2); break; }
		}
		if (!flee) {
			await s.bridge.send('action_cancel', s.record.agentId, { goalRevision: s.record.goalRevision, actionId: fleeId }).catch(() => {});
			await Promise.race([fleeing, sleep(3000)]);
		}
		const row = { run, fleeStillRunningWhenCreeperCame: standing, creeperExploded: exploded, died, healthBeforeCreeper: before,
			blastDamage: died ? before : +(before - minHealth).toFixed(1), flee: flee ? { state: flee.state, reasonCode: flee.reasonCode ?? null, message: String(flee.message ?? '').slice(0, 400) } : null,
			reflexEvents: ((await s.observeOrNull())?.reflexes?.events ?? []).map(event => `${event.id}:${event.outcome}`).slice(-6) };
		runs.push(row);
		console.log(`[creeper] run ${run}: ${died ? 'DIED' : `blast damage ${row.blastDamage}`}, exploded ${exploded}, flee running ${row.fleeStillRunningWhenCreeperCame}, reflexes ${row.reflexEvents.join(' ')} | flee ${row.flee?.reasonCode ?? 'running'}`);
		await writeFile(path.join(out, 'runs.json'), JSON.stringify(runs, null, 1));
	}
	const summary = { runs: runs.length, deaths: runs.filter(r => r.died).length, meanBlastDamage: +(runs.reduce((a, r) => a + r.blastDamage, 0) / runs.length).toFixed(1),
		creeperFlinches: runs.filter(r => r.reflexEvents.some(e => e.startsWith('default-creeper'))).length };
	await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary));
} catch (error) {
	console.error(error);
	await writeFile(path.join(out, 'error.txt'), String(error?.stack ?? error));
} finally {
	await s.stop().catch(() => {});
}
