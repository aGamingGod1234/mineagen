#!/usr/bin/env node
// Provider-free check of a body that cannot flee: node scripts/quality/test-cornered-live.mjs OUT_DIR
// This script stands in for the coordinator (no model call). It arms the coordinator's default reflexes, sends the
// production flee_from from a dead end and then sends nothing more for WATCH_S seconds, as the model thinking. Cases:
//   seed4-cave: the granite dead end where seed 4 of the Nov 7 architecture check died (terrain regenerated from the
//     run's seed 3315172112810107624), as it stood 12 s after the run's FLEE_BLOCKED: the granite at -293,24,48 the
//     model broke is gone and the zombie and skeleton stand in the pit 3 blocks below where the run's observations put
//     them; stone sword, pickaxe, cobblestone, no shield, no armour; flee_from the zombie, distance 14, timeoutMs 15000,
//     as the model sent.
//   corridor: a 1-wide, 2-high dead-end tunnel cut in stone with three zombies coming down it single file.
//   corridor-archer: a one-cell nook off a 3-wide cave, a zombie 4 blocks away on one side and a skeleton 9 blocks off
//     on the other: seed 4's pair (a zombie close, a skeleton shooting from beyond reach) with the line of fire the run had.
//   crowd-low: the corridor at 8 health with the body carrying cobblestone: outnumbered and low, it should wall in.
// Per run: the flee result, alive at the end, lowest and final health, hostiles left alive.
// ARENA_JAR picks the jar; CASES and REPEATS narrow the runs; FIXTURE_TICK_RATE runs the server faster (WATCH_S stays game seconds). Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE
// and JAVA_HOME set; operator commands only build the fixture and set the body up.
// A run passes when the body is alive at the end. Exit code (strict, the default): 0 every run passed, 1 a body died,
// 2 invalid evidence (the server or a run errored, or runs are missing). --descriptive reports without one.
import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot, fixtureTickRate, frozenFixtureSetup } from './watch-replay.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { damageCounter, damageEvidence } from './lib/damage-counter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-cornered-live.mjs [OUT_DIR] [--strict|--descriptive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME (CASES, REPEATS, WATCH_S, ARENA_JAR)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const out = path.resolve(cli.filter(arg => !['--strict', '--descriptive'].includes(arg))[0] ?? 'runtime/cornered-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, 'build/libs/mineagen-0.2.0.jar'));
if (!existsSync(jar)) { console.error(`no jar at ${jar}`); process.exit(2); }
const WATCH_S = Number(process.env.WATCH_S ?? 45), REPEATS = Number(process.env.REPEATS ?? 3);
const CASES = (process.env.CASES ?? 'seed4-cave,corridor,corridor-archer,crowd-low').split(',');
const diagnostics = process.env.CORNERED_DIAGNOSTICS === '1';
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jar, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), watchS: WATCH_S, repeats: REPEATS, cases: CASES, tickRate: fixtureTickRate(), diagnostics,
	diagnosticTiming: diagnostics ? 'Additional RCON reads advance the running world; snapshots are bracketed, not atomic.' : null, node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Cornered';
const SEED = '3315172112810107624';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);

const runs = [];
const planned = CASES.length * REPEATS;
const finish = async () => {
	const report = await finishRun(runs, { file: path.join(out, 'result.json'), planned, strict });
	console.log(JSON.stringify(report));
	process.exit(report.exitCode);
};
const s = await boot(out, { jar, template, port, world: null, seed: SEED, tickRate: fixtureTickRate(), worldCache: true }).catch(async (error) => {
	runs.push({ case: 'boot', error: String(error?.stack ?? error).slice(0, 1200) });
	return finish();
});
// A refused observation names the server's current revision: adopt it and ask again (a revision moved on by a message
// this fixture does not track ended two matrices early with "TIMEOUT observation").
// Any server message carrying a newer goal revision moves the fixture on with it (a death, a respawn or a lifecycle
// message it does not otherwise track left later commands STALE_REVISION).
s.bridge.on('message', (event) => {
	const revision = event?.payload?.goalRevision ?? event?.payload?.record?.goalRevision ?? event?.payload?.control?.goalRevision;
	if (!s.record || event.agentId !== s.record.agentId || !Number.isSafeInteger(revision) || revision <= s.record.goalRevision) return;
	s.record.goalRevision = revision;
	s.bridge.send('agent_ready', s.record.agentId, { goalRevision: revision, reconciled: false }).catch(() => {});
});
// watch-replay's observe leaves its reply wait pending when the send is refused; that orphan later rejects unhandled.
process.on('unhandledRejection', (error) => { if (/TIMEOUT observation/.test(String(error?.message))) return; console.error(error); runs.push({ case: 'harness', error: String(error?.stack ?? error).slice(0, 1200) }); });
const rawObserve = s.observe;
s.observe = async () => {
	for (let attempt = 0; ; attempt++) {
		try { return await rawObserve(); } catch (error) {
			const current = /current revision (\d+)/.exec(String(error?.message))?.[1];
			if (current && attempt < 3) {
				s.record.goalRevision = Number(current);
				await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
				continue;
			}
			if (/TIMEOUT observation/.test(String(error?.message)) && attempt < 2) continue;
			throw error;
		}
	}
};
// A death or respawn moves the goal revision on; follow it as the coordinator does, or every later message is refused.
s.bridge.on('message', (event) => {
	const registered = ['agent_registered', 'registry_entry'].includes(event.type) ? { goalRevision: event.payload.goalRevision ?? event.payload.record?.goalRevision, operation: 'registered' } : null;
	const control = registered ?? (event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null);
	if (control == null || event.agentId !== s.record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= s.record.goalRevision) return;
	if (['queue', 'dequeue'].includes(control.operation)) return;
	s.record.goalRevision = control.goalRevision;
	s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
});
const health = async () => { const text = await s.command(`data get entity ${AGENT} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };
const deaths = async () => number(await s.command(`scoreboard players get ${AGENT} deaths`)) || 0;
const uuid = (run, n) => [`00000004-0000-0000-0000-${String(run).padStart(4, '0')}${String(n).padStart(8, '0')}`, `[I;4,0,${run},${n}]`];

// Keep diagnosis opt-in: RCON reads themselves take wall time while entities continue ticking.
async function snapshot(label, ids = [], timing = {}) {
	if (!diagnostics) return;
	const fromTick = await s.gameTicks(), wallAt = Date.now();
	const entities = [];
	for (const id of [AGENT, ...ids]) {
		entities.push({ id, nbt: await s.command(`data get entity ${id}`), throughTick: await s.gameTicks() });
	}
	await appendFile(path.join(out, 'initial-state.jsonl'), JSON.stringify({ label, wallAt, fromTick, throughTick: await s.gameTicks(), ...timing, entities,
		observation: s.observation }) + '\n');
}

async function register() {
	let e = null, reply = null;
	// A summon right after boot can go unanswered while the server settles; a player would just try again.
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 30000).catch(() => null);
		const summon = () => s.command(`execute positioned -270.5 80 23.5 run mineagen summon gpt-6.1-sol low ${AGENT}`);
		reply = await summon();
		// The mod applies boot's model catalog at the start of a later tick, so the first summon is often refused at once
		// (MODEL_CATALOG_UNAVAILABLE) and no registration follows: ask again shortly instead of waiting out the 30 s.
		for (let n = 0; /MODEL_CATALOG_UNAVAILABLE/.test(reply) && n < 40; n++) { await sleep(250); reply = await summon(); }
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${reply}`);
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`mineagen start ${AGENT} Survive for 1200 seconds.`); s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${AGENT}`);
}

async function armDefaults() {
	const book = new ReflexBook();
	const sample = await s.observe();
	if (!book.observeContext(s.record.agentId, sample)) throw new Error('defaults did not arm on a live sample');
	const payload = book.payload(s.record.agentId);
	await s.bridge.send('reflex_update', s.record.agentId, payload);
	for (let i = 0; i < 50; i++) { const o = await s.observe(); if (o.reflexes?.revision === payload.revision && o.reflexes.rules.length === payload.rules.length) return o.reflexes.rules.length; await sleep(200); }
	throw new Error('the mod did not echo the default rules');
}

async function kit(healthTarget) {
	await s.command(`clear ${AGENT}`);
	for (const [slot, item] of [[0, 'stone_sword'], [1, 'apple 3'], [2, 'dirt 12'], [3, 'cobblestone 24'], [6, 'stone_pickaxe'], [7, 'oak_planks 4']]) {
		await s.command(`item replace entity ${AGENT} container.${slot} with minecraft:${item}`);
	}
	await s.command(`effect clear ${AGENT}`);
	await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`);
	await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
	await s.idleSleep(600);
	// A body respawned moments ago ignores damage for 3 s (vanilla), so the low-health setup is checked and repeated.
	for (let attempt = 0; healthTarget < 20 && attempt < 6; attempt++) {
		const now = await health();
		if (now <= healthTarget + 0.5) break;
		await s.command(`damage ${AGENT} ${now - healthTarget} minecraft:generic`);
		await s.idleSleep(1000);
	}
}

/** A 1-cell nook (the body's cell at x,z) opening onto a 3-wide, 3-high cave running +z for 12 blocks, in solid stone. */
async function buildNook(x, y, z) {
	await s.command(`fill ${x - 4} ${y - 2} ${z - 3} ${x + 4} ${y + 4} ${z + 14} minecraft:stone`);
	await s.command(`fill ${x} ${y} ${z} ${x} ${y + 1} ${z} minecraft:air`);
	await s.command(`fill ${x - 1} ${y} ${z + 1} ${x + 1} ${y + 2} ${z + 12} minecraft:air`);
}

/** A stone cube with a 1-wide, 2-high tunnel running +z from a dead end at z0 (the body's cell), open 8 blocks on. */
async function buildCorridor(x, y, z) {
	await s.command(`fill ${x - 4} ${y - 2} ${z - 3} ${x + 4} ${y + 4} ${z + 14} minecraft:stone`);
	await s.command(`fill ${x} ${y} ${z} ${x} ${y + 1} ${z + 13} minecraft:air`);
	await s.command(`fill ${x - 2} ${y} ${z + 10} ${x + 2} ${y + 2} ${z + 13} minecraft:air`);
}

const cases = {
	'seed4-cave': {
		at: [-292.3, 24, 47.5, 57], forceload: [-310, 30, -270, 70],
		build: () => s.command('setblock -293 24 48 minecraft:air'),
		mobs: [['zombie', -291.9, 21, 46.4], ['skeleton', -289.9, 21, 45.3]], flee: { distance: 14, timeoutMs: 15000 }, health: 20,
	},
	corridor: {
		build: () => buildCorridor(-240, 40, 40), at: [-239.5, 40, 40.5, 0], forceload: [-250, 30, -230, 60],
		mobs: [['zombie', -239.5, 40, 47.5], ['zombie', -239.5, 40, 49.5], ['zombie', -239.5, 40, 51.5]], flee: { distance: 14, timeoutMs: 15000 }, health: 20,
	},
	'corridor-archer': {
		build: () => buildNook(-240, 40, 40), at: [-239.5, 40, 40.5, 0], forceload: [-250, 30, -230, 60],
		mobs: [['zombie', -240.5, 40, 44.5], ['skeleton', -238.5, 40, 49.5]], flee: { distance: 14, timeoutMs: 15000 }, health: 20,
	},
	'crowd-low': {
		build: () => buildCorridor(-240, 40, 40), at: [-239.5, 40, 40.5, 0], forceload: [-250, 30, -230, 60],
		mobs: [['zombie', -239.5, 40, 44.5], ['zombie', -239.5, 40, 46.5], ['zombie', -239.5, 40, 48.5]], flee: { distance: 14, timeoutMs: 15000 }, health: 8,
	},
};

try {
	await s.command('difficulty normal');
	await s.command('gamerule minecraft:spawn_mobs false');
	await s.command('gamerule minecraft:advance_time false');
	await s.command('time set midnight');
	await register();
	const readDamage = await damageCounter(text => s.command(text), AGENT);
	let run = 0;
	for (const name of CASES) {
		const c = cases[name];
		if (!c) throw new Error(`unknown case ${name}`);
		for (let repeat = 0; repeat < REPEATS; repeat++) {
			run++;
			const startedAt = Date.now();
			const [x0, z0, x1, z1] = c.forceload;
			await s.normalRate();
			await s.command(`forceload add ${x0} ${z0} ${x1} ${z1}`);
			await s.command('kill @e[type=!minecraft:player]');
			// A body killed by the last run respawns first (vanilla's respawn screen), and the run starts only once it lives.
			let respawned = null;
			for (let attempt = 0; attempt < 10 && !((await health().catch(() => 0)) > 0); attempt++) {
				// The respawn action needs the model catalog, which boot sent once and which goes stale (MODEL_CATALOG_UNAVAILABLE).
				await s.bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free cornered fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] }).catch(() => {});
				respawned = await s.act('respawn', {}).catch(error => ({ error: error.message }));
				await s.gameSleep(1500);
			}
			if (!((await health().catch(() => 0)) > 0)) throw new Error(`the body did not respawn: ${JSON.stringify(respawned)?.slice(0, 300)}`);
			await s.idleSleep(3500); // vanilla spawn protection ends before the setup damages the body
			// Out of the fixture before it is rebuilt: rebuilding filled the tunnel with stone around a body still standing in
			// it from the last run, a suffocation tick and a dig-out reflex the next run inherited.
			// Through the End, so the body arrives knowing no terrain, as after the run's own descent into an unseen cave.
			// It lands on a barrier: a drop from y 120 onto the island killed bodies whose return was a few ticks late (at a
			// raised tick rate, more ticks pass while the fixture's commands run).
			await s.command('execute in minecraft:the_end run forceload add 0 0');
			// The seeded End can contain bedrock here; clear both body blocks before entering the staging cell.
			await s.command('execute in minecraft:the_end run fill 0 120 0 0 121 0 minecraft:air');
			await s.command('execute in minecraft:the_end run setblock 0 119 0 minecraft:barrier');
			await s.command(`execute in minecraft:the_end run tp ${AGENT} 0.5 120 0.5`); await s.idleSleep(800);
			if (c.build) await c.build();
			const [ax, ay, az, yaw] = c.at;
			await s.command(`execute in minecraft:overworld run tp ${AGENT} ${ax} ${ay} ${az} ${yaw} 10`);
			await kit(c.health);
			// The damage steps can overshoot when a hit lands after the health read (one crowd run began at 2.5): set up again.
			for (let retry = 0; retry < 3 && Math.abs((await health()) - c.health) > 1.5; retry++) await kit(c.health);
			await s.command(`item replace entity ${AGENT} weapon.offhand with minecraft:air`);
			if (repeat === 0 && run === 1) console.log(`[cornered] default reflexes armed: ${await armDefaults()}`);
			await s.idleSleep(1500);
			const damageBefore = await readDamage(), healthBefore = await health();
			const ids = [];
			// Summon-to-action tick spans differed (2 vs 10) in a paired diagnostic.
			// Hold the world until every mob exists; release it before waiting on the bridge below.
			await frozenFixtureSetup(s, async () => {
				await snapshot(`${name}#${repeat}:before-summons`);
				for (let n = 0; n < c.mobs.length; n++) {
					const [type, mx, my, mz] = c.mobs[n];
					const [id, nbt] = uuid(run, n + 1);
					ids.push(id);
					// NBT skips vanilla's spawn equipment, so a skeleton's bow is given as a natural one would carry it.
					const gear = type === 'skeleton' ? ',equipment:{mainhand:{id:"minecraft:bow",count:1}}' : '';
					const summonFromTick = diagnostics ? await s.gameTicks() : null;
					const made = await s.command(`summon minecraft:${type} ${mx} ${my} ${mz} {UUID:${nbt},PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b${gear}}`);
					await snapshot(`${name}#${repeat}:summoned-${n}`, ids, { summonFromTick });
					if (run === 1 && n === c.mobs.length - 1) console.log(`[cornered] summon: ${made}`);
				}
			});
			let o = null;
			for (let wait = 0; wait < 30; wait++) { o = await s.observe(); if ((o.entities ?? []).some(e => e.uuid === ids[0] || e.stableId === ids[0])) break; await sleep(200); }
			const deathsBefore = await deaths();
			await snapshot(`${name}#${repeat}:before-rate-change`, ids);
			// Both variants measure the watch window from world ticks, including a lagging 20 TPS baseline.
			await s.fastRate();
			const timer = await s.gameTimer({ worldTicks: true });
			const actionSentAt = Date.now();
			const flee = s.act('flee_from', { targetId: ids[0], ...c.flee }, 90000).catch(error => ({ state: 'ERROR', message: error.message }));
			const fleeId = s.lastActionId;
			if (diagnostics) await appendFile(path.join(out, 'initial-state.jsonl'), JSON.stringify({ label: `${name}#${repeat}:action-sent`, actionId: fleeId,
				wallAt: actionSentAt, throughTick: await s.gameTicks() }) + '\n');
			let fleeResult = null; flee.then(async r => { const ms = await timer.elapsed(); fleeResult = { ...r, atS: ms / 1000 }; });
			let minHealth = 20, last = 20, died = false;
			const track = [];
			while ((await timer.elapsed()) < WATCH_S * 1000) {
				await s.gameSleep(500);
				const h = await health().catch(() => null);
				if ((await deaths()) > deathsBefore || h === 0) { died = true; break; }
				if (h !== null) { last = h; minHealth = Math.min(minHealth, h); }
				const at = s.observation?.position;
				track.push({ t: +((await timer.elapsed()) / 1000).toFixed(1), hp: h, firing: s.observation?.reflexes?.firing?.id ?? null, action: s.observation?.currentAction?.actionType ?? null,
					...(at ? { x: +at.x.toFixed(2), y: +at.y.toFixed(2), z: +at.z.toFixed(2) } : {}), detail: s.observation?.reflexes?.firing?.detail ?? null });
			}
			const wallS = +(timer.wallMs() / 1000).toFixed(1);
			const tick = await timer.rates();
			await s.normalRate();
			if (!fleeResult) {
				await s.bridge.send('action_cancel', s.record.agentId, { goalRevision: s.record.goalRevision, actionId: fleeId }).catch(() => {});
				await Promise.race([flee, sleep(3000)]);
			}
			let alive = 0;
			for (const id of ids) if (!/No entity|not found/i.test(await s.command(`data get entity ${id} Health`))) alive++;
			const row = { case: name, repeat, wallS, tick, survived: !died, minHealth: died ? 0 : minHealth, endHealth: died ? 0 : last, hostilesLeft: alive, hostiles: ids.length,
				flee: fleeResult ? { state: fleeResult.state, reasonCode: fleeResult.reasonCode ?? null, atS: fleeResult.atS, message: String(fleeResult.message ?? '').slice(0, 600) } : 'still running',
				reflexEvents: (s.observation?.reflexes?.events ?? []).map(e => `${e.id}:${e.outcome}`).slice(-8),
				reflexDetails: (s.observation?.reflexes?.events ?? []).map(e => `${e.id}:${e.outcome}: ${e.detail ?? ''}`).slice(-8), track,
				startedAt, finishedAt: Date.now(), pass: !died };
			Object.assign(row, damageEvidence(damageBefore, await readDamage(), healthBefore, await health()));
			row.deaths = (await deaths()) - deathsBefore;
			runs.push(row);
			console.log(`[cornered] ${name}#${repeat}: ${row.survived ? 'SURVIVED' : 'DIED'} min ${row.minHealth} end ${row.endHealth}, hostiles left ${alive}/${ids.length}, flee ${row.flee.reasonCode ?? row.flee} at ${row.flee.atS ?? '-'} s, tps asked ${tick.askedTps} reached ${tick.reachedTps} | ${String(row.flee.message ?? '').slice(0, 200)}`);
			await writeFile(path.join(out, 'runs.json'), JSON.stringify(runs, null, 1));

		}
	}
	const summary = Object.fromEntries(CASES.map(name => {
		const rows = runs.filter(r => r.case === name);
		return [name, { runs: rows.length, survived: rows.filter(r => r.survived).length, meanMinHealth: +(rows.reduce((a, r) => a + r.minHealth, 0) / rows.length).toFixed(1),
			meanEndHealth: +(rows.reduce((a, r) => a + r.endHealth, 0) / rows.length).toFixed(1), outcomes: rows.map(r => r.flee.reasonCode ?? r.flee) }];
	}));
	await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary));
	await writeFile(path.join(out, 'tick.json'), JSON.stringify({ tickRate: s.tickRate, held: await s.tickReport() }, null, 2));
} catch (error) {
	console.error(error);
	await writeFile(path.join(out, 'error.txt'), String(error?.stack ?? error));
	runs.push({ case: 'harness', error: String(error?.stack ?? error).slice(0, 1200) });
} finally {
	await s.stop().catch(() => {});
}
await finish();
