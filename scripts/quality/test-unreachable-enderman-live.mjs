#!/usr/bin/env node
// Provider-free live room for -Dmineagen.fight.skipUnreachable (UnreachableTargets): an angry enderman fenced in on a
// 4-high pillar the body cannot reach, and a calm one on the open floor. Each trial runs one production fight_until
// (enderman until one more ender pearl, 120 s) and counts the sword approaches that ended unreachable, the kills and the
// time to the first pearl. SKIP_UNREACHABLE=1 starts the server with the switch on; run once off and once on.
// A trial passes when the enderman was provoked, the call got its pearl, at most 3 approaches ended unreachable and the
// body lived: the switch-on bar. Run the switch-off control with --descriptive (today it is pinned and fails the bar).
// Exit (strict, the default): 0 all passed, 1 a trial failed, 2 invalid evidence (an error or missing trials).
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MOD_JAR } from './mod-jar.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';

const USAGE = 'Usage: [SKIP_UNREACHABLE=1] [TRIALS=3] test-unreachable-enderman-live.mjs OUT_DIR [--strict|--descriptive] under slot.sh live, with JAVA_HOME and ARENA_HEADLESS_SERVER_TEMPLATE';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const [outArg] = cli.filter(arg => !['--strict', '--descriptive'].includes(arg));
const root = fileURLToPath(new URL('../..', import.meta.url));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const out = path.resolve(outArg);
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, MOD_JAR));
const on = process.env.SKIP_UNREACHABLE === '1';
const TRIALS = Number(process.env.TRIALS ?? 3), CALL_MS = Number(process.env.CALL_MS ?? 120000);
if (on) process.env.REPLAY_JAVA_OPTS = `${process.env.REPLAY_JAVA_OPTS ?? ''} -Dmineagen.fight.skipUnreachable=true`.trim();
const { boot } = await import('./watch-replay.mjs');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	skipUnreachable: on, trials: TRIALS, callMs: CALL_MS, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Hunter';
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
const trials = [];
try {
	await s.command('difficulty normal');
	await s.command('gamerule minecraft:spawn_mobs false');
	await s.command('gamerule minecraft:mob_griefing false');
	await s.command('gamerule minecraft:advance_time false');
	await s.command('time set midnight');
	let e = null, reply = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 30000).catch(() => null);
		reply = await s.command(`execute positioned -299.5 100 10.5 run mineagen summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${reply}`);
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`mineagen start ${AGENT} Survive for 1200 seconds.`); s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${AGENT}`);
	await s.command('forceload add -330 -20 -270 40');
	await s.command('scoreboard objectives add chk dummy').catch(() => {});
	const score = text => Number(/has (-?\d+)/.exec(String(text))?.[1]);
	const alive = async (tag) => { await s.command(`execute store result score #e chk if entity @e[type=minecraft:enderman,tag=${tag}]`); return score(await s.command('scoreboard players get #e chk')) > 0; };
	const angry = (o) => (o?.entities ?? []).some((row) => row.type === 'minecraft:enderman' && (row.appearance?.screaming === true || row.targetingAgent === true));
	for (let trial = 1; trial <= TRIALS; trial++) {
		for (let attempt = 0; attempt < 10 && !((await health().catch(() => 0)) > 0); attempt++) { await s.act('respawn', {}).catch(() => null); await sleep(1500); }
		await s.command('kill @e[type=!minecraft:player]');
		// A stone floor in the air with open sky; the pillar 6 blocks south, its top 4 above the floor, fenced round so the
		// enderman cannot step off (an angry one inside 16 blocks of its target does not teleport, vanilla).
		await s.command('fill -320 96 -10 -280 99 30 minecraft:stone');
		await s.command('fill -320 100 -10 -280 112 30 minecraft:air');
		await s.command('fill -300 100 16 -300 103 16 minecraft:stone');
		await s.command('fill -301 104 15 -299 104 17 minecraft:oak_fence');
		await s.command('setblock -300 104 16 minecraft:air');
		await s.command(`tp ${AGENT} -299.5 100 10.5 0 0`);
		await s.command(`clear ${AGENT}`);
		await s.command(`item replace entity ${AGENT} weapon.mainhand with minecraft:iron_sword`);
		for (const [slot, item] of [['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']])
			await s.command(`item replace entity ${AGENT} ${slot} with minecraft:${item}`);
		await s.command(`effect clear ${AGENT}`);
		await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`);
		await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
		await s.command(`random reset minecraft:entities/enderman ${700 + trial}`);
		await s.command('summon minecraft:enderman -299.5 104 16.5 {PersistenceRequired:1b,Tags:["pillar"]}');
		await sleep(1500);
		// Provoke the pillar one with a stare at its eyes, as the live hunts met them: angry, in view, out of reach.
		await s.act('look_at', { x: -299.5, y: 106.55, z: 16.5 }, 20000);
		let provoked = false;
		for (const until = Date.now() + 8000; Date.now() < until && !provoked;) { provoked = angry(await s.observeOrNull()); if (!provoked) await sleep(250); }
		await s.act('look_at', { x: -299.5, y: 101.6, z: 16.5 }, 20000);
		// The reachable one, calm, on the open floor 13 blocks off.
		await s.command('summon minecraft:enderman -293.5 100 22.5 {PersistenceRequired:1b,Tags:["ground"]}');
		await sleep(1000);
		const t0 = Date.now();
		let groundKilledS = null, pillarLeft = null;
		const call = s.act('fight_until', { mob: 'minecraft:enderman', untilItem: 'minecraft:ender_pearl', untilCount: 1, fleeAtHealth: 8, timeoutMs: CALL_MS }, CALL_MS + 30000);
		let result = null;
		call.then(r => { result = r; }, error => { result = { state: 'ERROR', reasonCode: 'ERROR', message: String(error?.message ?? error) }; });
		while (!result) {
			await sleep(500);
			if (groundKilledS === null && !(await alive('ground'))) groundKilledS = +((Date.now() - t0) / 1000).toFixed(1);
		}
		pillarLeft = await alive('pillar');
		const seconds = +((Date.now() - t0) / 1000).toFixed(1);
		const message = String(result.message ?? '');
		const endings = Object.fromEntries([...(/endings: \{([^}]*)\}/.exec(message)?.[1] ?? '').matchAll(/(\w+)=(\d+)/g)].map(m => [m[1], Number(m[2])]));
		const gained = Number(/gained (\d+)/.exec(message)?.[1] ?? 0);
		const row = { trial, startedAt: t0, finishedAt: Date.now(), skipUnreachable: on, provoked, state: result.state, reasonCode: result.reasonCode, seconds,
			unreachableApproaches: (endings.NO_SEEN_ROUTE ?? 0) + (endings.TARGET_UNREACHABLE ?? 0), endings,
			kills: Number(/: (\d+) kills?,/.exec(message)?.[1] ?? 0), groundKilledS, pearlsGained: gained, firstPearlS: gained > 0 && result.reasonCode === 'UNTIL_COUNT_REACHED' ? seconds : null,
			pillarStillOnPillar: pillarLeft, keptOn: Number(/kept on (\d+) that left reach/.exec(message)?.[1] ?? 0),
			passedOver: Number(/out of reach: passed over (\d+)/.exec(message)?.[1] ?? 0), healthEnd: await health().catch(() => null), message: message.slice(0, 1600) };
		if (result.state === 'ERROR') row.error = `fight_until never returned: ${result.message}`;
		row.pass = row.provoked && row.reasonCode === 'UNTIL_COUNT_REACHED' && row.unreachableApproaches <= 3 && row.healthEnd > 0;
		trials.push(row);
		console.log(`[unreachable] ${on ? 'on' : 'off'} #${trial}: ${row.reasonCode} in ${seconds} s, unreachable approaches ${row.unreachableApproaches}, kills ${row.kills}, ground killed at ${groundKilledS} s, pearls ${gained}, first pearl ${row.firstPearlS} s`);
		await writeFile(path.join(out, 'trials.json'), JSON.stringify(trials, null, 1));
	}
} catch (error) {
	// Recorded as an invalid row: the trials it cut short are missing too.
	console.error(error);
	trials.push({ trial: 'harness', error: String(error?.stack ?? error).slice(0, 1200) });
} finally {
	try { await s.stop(); } catch (error) { trials.push({ trial: 'cleanup', error: String(error?.message ?? error) }); }
}
const report = await finishRun(trials, { file: path.join(out, 'result.json'), planned: TRIALS, strict });
console.log(JSON.stringify(report));
process.exit(report.exitCode);
