#!/usr/bin/env node
// Dead-end creeper: the body stands at the end of a 1-wide stone tunnel and a lit creeper is summoned 2 blocks up it, so
// the creeper reflex has no safe heading (fresh game g6 64 min: 20 to 0 in one blast). CASES=shield (offhand shield and
// stone sword) and/or sword (no shield). Rows record blast damage, death, the reflex events and vanilla damageTaken.
// MINEAGEN_CREEPER_GUARD=off on the server is the off arm. Runs at 20 TPS: blast damage is read off sampled health.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot, unshownTickRate } from './watch-replay.mjs';
const TICK_RATE = unshownTickRate('blast damage is read off sampled health; at a raised rate more healing passes between reads');
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { damageCounter, damageEvidence, deathCounter } from './lib/damage-counter.mjs';
import { finishRun, roomVerdict, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-creeper-deadend-live.mjs [OUT_DIR] [--strict|--descriptive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME (CASES, REPEATS, ARENA_JAR)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const out = path.resolve(cli.filter(arg => !['--strict', '--descriptive'].includes(arg))[0] ?? 'runtime/creeper-deadend-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, MOD_JAR));
if (!existsSync(jar)) { console.error(`no jar at ${jar}`); process.exit(2); }
const REPEATS = Number(process.env.REPEATS ?? 3);
const CASES = (process.env.CASES ?? 'shield,sword').split(',');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jar, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), repeats: REPEATS, cases: CASES, tickRate: TICK_RATE, node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Creep';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const s = await boot(out, { jar, template, port, world: null, seed: '3315172112810107624', tickRate: TICK_RATE });
s.bridge.on('message', (event) => {
	const control = event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null;
	if (control == null || event.agentId !== s.record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= s.record.goalRevision) return;
	if (['queue', 'dequeue'].includes(control.operation)) return;
	s.record.goalRevision = control.goalRevision;
	s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
});
const health = async () => { const text = await s.command(`data get entity ${AGENT} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };
const deaths = () => deathCounter(text => s.command(text), AGENT, { objective: 'deaths', unsetIsZero: true });
const alive = async id => !/No entity|not found/i.test(await s.command(`data get entity ${id} Health`));
const runs = [];
try {
	await s.command('difficulty normal');
	await s.command('gamerule minecraft:spawn_mobs false');
	await s.command('gamerule minecraft:advance_time false');
	await s.command('time set noon');
	let e = null, reply = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 30000).catch(() => null);
		reply = await s.command(`execute positioned -270.5 80 23.5 run mineagen summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${reply}`);
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`mineagen start ${AGENT} Survive for 1200 seconds.`); s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${AGENT}`);
	const book = new ReflexBook();
	if (!book.observeContext(s.record.agentId, await s.observe())) throw new Error('defaults did not arm');
	const payload = book.payload(s.record.agentId);
	await s.bridge.send('reflex_update', s.record.agentId, payload);
	for (let i = 0; i < 50 && (await s.observe()).reflexes?.revision !== payload.revision; i++) await sleep(200);
	await s.command('forceload add -330 -20 -270 40');
	const readDamage = await damageCounter(text => s.command(text), AGENT);
	let run = 0;
	for (const kit of CASES) for (let repeat = 1; repeat <= REPEATS; repeat++) {
		run++;
		await s.normalRate();
		for (let attempt = 0; attempt < 10 && !((await health().catch(() => 0)) > 0); attempt++) { await s.act('respawn', {}).catch(() => null); await s.idleSleep(1500); }
		await s.idleSleep(2000);
		await s.command('kill @e[type=!minecraft:player]');
		// A solid stone block with a 1-wide, 2-high tunnel running north from its open mouth at z=20 to a dead end at z=10.
		await s.command('fill -306 98 4 -294 104 26 minecraft:stone');
		await s.command('fill -300 100 11 -300 101 20 minecraft:air');
		await s.command('fill -300 100 21 -300 104 26 minecraft:air');
		await s.command(`execute in minecraft:the_end run tp ${AGENT} 0.5 120 0.5`); await sleep(800);
		await s.command(`execute in minecraft:overworld run tp ${AGENT} -299.5 100 11.5 0 0`);
		await s.command(`clear ${AGENT}`);
		await s.command(`item replace entity ${AGENT} container.0 with minecraft:stone_sword`);
		if (kit === 'shield') await s.command(`item replace entity ${AGENT} weapon.offhand with minecraft:shield`);
		await s.command(`effect clear ${AGENT}`);
		await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`);
		await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
		await s.idleSleep(1500);
		const id = n => `00000006-0000-0000-0000-0000${(run * 16 + n).toString(16).padStart(8, '0')}`, nbt = n => `[I;6,0,0,${run * 16 + n}]`;
		const creeper = id(2);
		const deathsBefore = await deaths();
		const damageBefore = await readDamage(), healthStart = await health();
		const before = await health();
		const t0 = s.clock.now(), wall0 = Date.now();
		await s.command(`summon minecraft:creeper -299.5 100 13.5 {UUID:${nbt(2)},PersistenceRequired:1b,ignited:1b}`);
		let minHealth = before, died = false, exploded = false;
		while (s.clock.now() - t0 < 12000) {
			await s.clock.sleep(250);
			const h = await health().catch(() => null);
			if ((await deaths()) > deathsBefore || h === 0) { died = true; break; }
			if (h !== null) minHealth = Math.min(minHealth, h);
			if (!exploded && !(await alive(creeper))) exploded = true;
			if (exploded && s.clock.now() - t0 > 3000) { await s.clock.sleep(1000); const h2 = await health().catch(() => null); if (h2 !== null) minHealth = Math.min(minHealth, h2); break; }
		}
		const row = { run, kit, repeat, seconds: Math.round((s.clock.now() - t0) / 1000), wallSeconds: Math.round((Date.now() - wall0) / 1000), creeperExploded: exploded, died,
			healthBeforeCreeper: before, blastDamage: died ? before : +(before - minHealth).toFixed(1),
			reflexEvents: ((await s.observeOrNull())?.reflexes?.events ?? []).map(event => `${event.id}:${event.outcome}:${String(event.detail ?? event.message ?? '').slice(0, 120)}`).slice(-4) };
		Object.assign(row, damageEvidence(damageBefore, await readDamage(), healthStart, await health().catch(() => null)));
		row.valid = exploded || died;
		// A run passes when the body lives through the blast; one where the creeper never went off is invalid evidence.
		if (row.valid) { row.pass = !died; if (died) row.failReason = 'died in the blast'; } else row.notExercised = 'the creeper never exploded';
		runs.push(row);
		console.log(`[deadend] ${kit} ${repeat}: ${died ? 'DIED' : `blast damage ${row.blastDamage}`}, exploded ${exploded}, reflexes ${row.reflexEvents.join(' | ')}`);
		await writeFile(path.join(out, 'runs.json'), JSON.stringify(runs, null, 1));
	}
	const by = kit => { const rows = runs.filter(r => r.kit === kit && ['PASS', 'FAIL'].includes(roomVerdict(r).verdict)); return { valid: rows.length, deaths: rows.filter(r => r.died).length,
		meanBlastDamage: rows.length ? +(rows.reduce((a, r) => a + r.blastDamage, 0) / rows.length).toFixed(1) : null }; };
	const summary = Object.fromEntries(CASES.map(kit => [kit, by(kit)]));
	await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary));
} catch (error) {
	console.error(error);
	await writeFile(path.join(out, 'error.txt'), String(error?.stack ?? error));
	runs.push({ error: String(error?.message ?? error) });
} finally {
	await s.stop().catch(() => {});
}
const report = await finishRun(runs, { file: path.join(out, 'result.json'), planned: CASES.length * REPEATS, strict });
console.log(report.line);
