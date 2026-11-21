#!/usr/bin/env node
// FIXTURE_TICK_RATE runs the watch faster: setup and the summons stay at 20 TPS, then the watch window (WATCH_S, SCORE_S)
// and every wait in it are game time on the fixture clock (s.clock). Natural regeneration is off here, so sampled health
// does not race healing. Rows record seconds (game), wallSeconds, rates and damageTaken (vanilla's cumulative counter).
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot, fixtureTickRate } from './watch-replay.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { damageCounter, damageEvidence, deathCounter } from './lib/damage-counter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = path.resolve(process.argv[2] ?? 'runtime/crowd-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!template || !port || !process.env.JAVA_HOME) throw new Error('Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, MOD_JAR));
const WATCH_S = Number(process.env.WATCH_S ?? 40), REPEATS = Number(process.env.REPEATS ?? 3), SCORE_S = Number(process.env.SCORE_S ?? 20);
const CASES = (process.env.CASES ?? 'open,bailout,cave,grass-archer').split(',');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jar, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), watchS: WATCH_S, repeats: REPEATS, cases: CASES, tickRate: fixtureTickRate(), node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Crowd';
const SEED = '3315172112810107624';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);

const s = await boot(out, { jar, template, port, world: null, seed: SEED, tickRate: fixtureTickRate() });
process.on('unhandledRejection', (error) => { if (/TIMEOUT observation/.test(String(error?.message))) return; console.error(error); process.exitCode = 1; });
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
	const revision = event?.payload?.goalRevision ?? event?.payload?.record?.goalRevision ?? event?.payload?.control?.goalRevision;
	if (!s.record || event.agentId !== s.record.agentId || !Number.isSafeInteger(revision) || revision <= s.record.goalRevision) return;
	if (event.type === 'goal_control' && ['queue', 'dequeue'].includes(event.payload?.operation)) return;
	s.record.goalRevision = revision;
	s.bridge.send('agent_ready', s.record.agentId, { goalRevision: revision, reconciled: false }).catch(() => {});
});
const health = async () => { const text = await s.command(`data get entity ${AGENT} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };
const deaths = () => deathCounter(text => s.command(text), AGENT, { objective: 'deaths', unsetIsZero: true });
// An observation that never comes back (the body between revisions) must not hang a run: wait at most 2 s for one.
const look = () => Promise.race([s.observeOrNull(), sleep(2000).then(() => null)]);
const uuid = (run, n) => [`00000005-0000-0000-0000-${String(run).padStart(4, '0')}${String(n).padStart(8, '0')}`, `[I;5,0,${run},${n}]`];

async function register() {
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

async function kit() {
	await s.command(`clear ${AGENT}`);
	for (const [slot, item] of [[0, 'stone_pickaxe'], [1, 'stone_axe'], [2, 'cobblestone 32']]) {
		await s.command(`item replace entity ${AGENT} container.${slot} with minecraft:${item}`);
	}
	await s.command(`item replace entity ${AGENT} weapon.offhand with minecraft:air`);
	await s.command(`effect clear ${AGENT}`);
	// The fall in the End before the teleport lands as damage after it, and nothing regenerates: heal until full.
	for (let attempt = 0; attempt < 8; attempt++) {
		await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`);
		await s.idleSleep(700);
		if ((await health()) >= 20) break;
	}
}

/**
 * An 81x81 stone floor round -300,99,10 (the body stands at y 100) with open air above and a 3-high stone rim, so a run
 * across it meets a wall, as on real ground, not a 35-block drop off the edge of a platform in the sky. top: the block
 * layer the floor ends with (grass for the archer case, with short grass standing in every cell above it).
 */
async function buildFloor(top = null) {
	await s.command('fill -340 96 -30 -260 99 50 minecraft:stone');
	for (const [y0, y1] of [[100, 103], [104, 107], [108, 112]]) await s.command(`fill -340 ${y0} -30 -260 ${y1} 50 minecraft:air`);
	for (const [x0, z0, x1, z1] of [[-340, -30, -260, -30], [-340, 50, -260, 50], [-340, -30, -340, 50], [-260, -30, -260, 50]]) {
		await s.command(`fill ${x0} 100 ${z0} ${x1} 102 ${z1} minecraft:stone`);
	}
	if (top) {
		await s.command('fill -339 99 -29 -261 99 49 minecraft:grass_block');
		await s.command('fill -339 100 -29 -261 100 49 minecraft:short_grass');
	}
}

/**
 * Solid stone with a 3-wide, 3-high tunnel along x from x+8 (a dead end) to x-28, where it opens into an 11x11, 4-high
 * chamber, the body's cell at x (gate A1: a dig broke into a cave of zombies, with passages to run along).
 */
async function buildTunnel(x, y, z) {
	await s.command(`fill ${x - 40} ${y - 2} ${z - 7} ${x + 12} ${y + 5} ${z + 7} minecraft:stone`);
	await s.command(`fill ${x - 28} ${y} ${z - 1} ${x + 8} ${y + 2} ${z + 1} minecraft:air`);
	await s.command(`fill ${x - 38} ${y} ${z - 5} ${x - 28} ${y + 3} ${z + 5} minecraft:air`);
}

const cases = {
	open: {
		build: () => buildFloor(), at: [-299.5, 100, 10.5, -90], forceload: [-350, -40, -250, 60],
		mobs: [['zombie', -293.5, 100, 10.5], ['zombie', -293.5, 100, 12.5], ['zombie', -293.5, 100, 8.5]],
	},
	bailout: {
		build: () => buildFloor(), at: [-299.5, 100, 10.5, -90], forceload: [-350, -40, -250, 60],
		mobs: [['zombie', -293.5, 100, 10.5], ['zombie', -293.5, 100, 12.5], ['zombie', -293.5, 100, 8.5]],
		act: ids => ['fight_target', { targetId: ids[0], fleeAtHealth: 10, timeoutMs: 30000 }],
	},
	cave: {
		build: () => buildTunnel(-240, 40, 40), at: [-239.5, 40, 40.5, -90], forceload: [-285, 30, -225, 50],
		mobs: [['zombie', -236.5, 40, 40.5], ['zombie', -235.5, 40, 41.5], ['zombie', -234.5, 40, 39.5]],
	},
	'grass-archer': {
		build: () => buildFloor('grass'), at: [-299.5, 100, 10.5, -90], forceload: [-350, -40, -250, 60],
		mobs: [['skeleton', -289.5, 100, 10.5]],
	},
	pillar: {
		build: async () => { await buildFloor(); await s.command('fill -300 100 10 -300 104 10 minecraft:cobblestone'); },
		at: [-299.5, 105, 10.5, -90], forceload: [-350, -40, -250, 60],
		mobs: [['spider', -296.5, 100, 10.5], ['spider', -296.5, 100, 12.5]],
	},
	tower: {
		build: async () => { await buildFloor(); await s.command('fill -301 100 9 -299 104 11 minecraft:cobblestone'); },
		at: [-299.5, 105, 10.5, -90], forceload: [-350, -40, -250, 60],
		mobs: [['spider', -295.5, 100, 10.5], ['spider', -295.5, 100, 12.5]],
	},
	phantoms: {
		build: () => buildFloor(), at: [-299.5, 100, 10.5, -90], forceload: [-350, -40, -250, 60],
		mobs: [['phantom', -295.5, 108, 10.5], ['phantom', -295.5, 108, 12.5]],
	},
	babies: {
		build: () => buildFloor(), at: [-299.5, 100, 10.5, -90], forceload: [-350, -40, -250, 60],
		mobs: [['zombie', -293.5, 100, 10.5, 'IsBaby:1b'], ['zombie', -293.5, 100, 12.5, 'IsBaby:1b']],
	},
	silverfish: {
		build: () => buildFloor(), at: [-299.5, 100, 10.5, -90], forceload: [-350, -40, -250, 60],
		mobs: [['silverfish', -295.5, 100, 9.5], ['silverfish', -295.5, 100, 10.5], ['silverfish', -295.5, 100, 11.5], ['silverfish', -295.5, 100, 12.5]],
	},
	hungry: {
		build: () => buildFloor(), at: [-299.5, 100, 10.5, -90], forceload: [-350, -40, -250, 60], hungry: true,
		mobs: [['zombie', -293.5, 100, 10.5], ['zombie', -293.5, 100, 12.5], ['zombie', -293.5, 100, 8.5]],
	},
	armoured: {
		build: () => buildFloor(), at: [-299.5, 100, 10.5, -90], forceload: [-350, -40, -250, 60],
		armour: [['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings']],
		mobs: [['zombie', -293.5, 100, 10.5], ['zombie', -293.5, 100, 12.5], ['zombie', -293.5, 100, 8.5]],
	},
};

/** Drains food to 6 or less (sprinting needs more than 6) with a strong Hunger effect, then clears it. */
async function starve() {
	await s.command(`effect give ${AGENT} minecraft:hunger 60 80 true`);
	for (const until = Date.now() + 30000; Date.now() < until;) {
		if (number(await s.command(`data get entity ${AGENT} foodLevel`)) <= 6) break;
		await sleep(150);
	}
	await s.command(`effect clear ${AGENT} minecraft:hunger`);
	return number(await s.command(`data get entity ${AGENT} foodLevel`));
}

/** Hits back summed over defend's firings (each counts from 0), back-outs started, and the time spent backing out. */
function defendTally(track) {
	let hits = 0, segment = 0, backOuts = 0, outs = 0, backingS = 0;
	for (const t of track) {
		const d = t.firing === 'default-defend' ? String(t.detail ?? '') : null;
		if (d === null) { hits += segment; backOuts += outs; segment = 0; outs = 0; continue; }
		const h = Number(/(\d+) hit\(s\) back/.exec(d)?.[1] ?? 0), o = Number(/(\d+) back-out\(s\)/.exec(d)?.[1] ?? 0);
		if (h < segment) { hits += segment; backOuts += outs; outs = 0; }
		segment = h; outs = Math.max(outs, o, /backing out of/.test(d) ? 1 : 0);
		if (/backing out of/.test(d)) backingS += 0.5;
	}
	return { hitsBack: hits + segment, backOuts: backOuts + outs, backingOutS: backingS };
}

const runs = [];
try {
	await s.command('difficulty normal');
	await s.command('gamerule minecraft:spawn_mobs false');
	await s.command('gamerule minecraft:advance_time false');
	await s.command('time set midnight');
	// The gate bodies fought at food 17 and saturation 0, where vanilla regenerates nothing: no regeneration here either.
	await s.command('gamerule minecraft:natural_health_regeneration false');
	await register();
	console.log(`[crowd] default reflexes armed: ${await armDefaults()}`);
	const readDamage = await damageCounter(text => s.command(text), AGENT);
	let run = 0;
	for (const name of CASES) {
		const c = cases[name];
		if (!c) throw new Error(`unknown case ${name}`);
		for (let repeat = 0; repeat < REPEATS; repeat++) {
			run++;
			await s.normalRate();
			const [x0, z0, x1, z1] = c.forceload;
			await s.command(`forceload add ${x0} ${z0} ${x1} ${z1}`);
			await s.command('kill @e[type=!minecraft:player]');
			let respawned = null;
			for (let attempt = 0; attempt < 10 && !((await health().catch(() => 0)) > 0); attempt++) {
				// The respawn action needs the model catalog, which boot sent once and which goes stale (MODEL_CATALOG_UNAVAILABLE).
				await s.bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free crowd fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] }).catch(() => {});
				respawned = await s.act('respawn', {}).catch(error => ({ error: error.message }));
				await s.idleSleep(1500);
			}
			if (!((await health().catch(() => 0)) > 0)) throw new Error(`the body did not respawn: ${JSON.stringify(respawned)?.slice(0, 300)}`);
			await s.idleSleep(3500); // vanilla spawn protection ends before the run
			// Out of the fixture before it is rebuilt, through the End, so the body arrives knowing no terrain.
			await s.command(`execute in minecraft:the_end run tp ${AGENT} 0.5 120 0.5`); await sleep(800);
			await c.build();
			const [ax, ay, az, yaw] = c.at;
			await s.command(`execute in minecraft:overworld run tp ${AGENT} ${ax} ${ay} ${az} ${yaw} 10`);
			await kit();
			for (const [slot, item] of c.armour ?? []) await s.command(`item replace entity ${AGENT} ${slot} with minecraft:${item}`);
			const food = c.hungry ? await starve() : null;
			for (const until = Date.now() + 10000; Date.now() < until;) { const o = await look(); if ((o?.reflexes?.rules ?? []).filter(r => String(r.id).startsWith('default-')).length === 12) break; await sleep(250); }
			await s.idleSleep(1500);
			// The run starts at the summon: an archer shoots at once, before the fixture has seen it in an observation.
			const deathsBefore = await deaths();
			const damageBefore = await readDamage();
			const startHealth = await health();
			// Play is timed on the fixture clock (wall time at 20 TPS). t0 is taken before the summons, as before; they run at
			// 20 so the mobs arrive the same ticks apart, and the rate goes up once the last one exists.
			const now = () => s.clock.now();
			const t0 = now();
			const ids = [];
			for (let n = 0; n < c.mobs.length; n++) {
				const [type, mx, my, mz, extra] = c.mobs[n];
				const [id, nbt] = uuid(run, n + 1);
				ids.push(id);
				// NBT skips vanilla's spawn equipment, so a skeleton's bow is given as a natural one would carry it.
				const gear = type === 'skeleton' ? ',equipment:{mainhand:{id:"minecraft:bow",count:1}}' : '';
				await s.command(`summon minecraft:${type} ${mx} ${my} ${mz} {UUID:${nbt},PersistenceRequired:1b,CanPickUpLoot:0b,${extra ?? 'IsBaby:0b'}${gear}}`);
			}
			await s.fastRate();
			const wall0 = Date.now(), timer = await s.gameTimer();
			for (const until = now() + 6000; now() < until;) { const o = await look(); if ((o?.entities ?? []).some(e => e.uuid === ids[0])) break; await s.clock.sleep(200); }
			let actResult = null, actId = null, act = null;
			if (c.act) {
				const [type, args] = c.act(ids);
				act = s.act(type, args, 90000).catch(error => ({ state: 'ERROR', message: error.message }));
				actId = s.lastActionId;
				act.then(r => { actResult = { ...r, atS: +((now() - t0) / 1000).toFixed(1) }; });
			}
			let minHealth = startHealth, last = startHealth, died = false;
			const track = [];
			const events = new Map();
			while (now() - t0 < WATCH_S * 1000) {
				await s.clock.sleep(500);
				const h = await health().catch(() => null);
				if ((await deaths()) > deathsBefore || h === 0) { died = true; break; }
				if (h !== null) { last = h; minHealth = Math.min(minHealth, h); }
				const o = await look();
				for (const e of o?.reflexes?.events ?? []) if (e && typeof e === 'object') events.set(`${e.seq}:${e.id}`, `${e.id}:${e.outcome}: ${String(e.detail ?? '').slice(0, 160)}`);
				const at = o?.position;
				track.push({ t: +((now() - t0) / 1000).toFixed(1), hp: h, firing: o?.reflexes?.firing?.id ?? null, action: o?.currentAction?.active ? o.currentAction.actionType : null,
					...(at ? { x: +at.x.toFixed(1), y: +at.y.toFixed(1), z: +at.z.toFixed(1) } : {}), detail: o?.reflexes?.firing?.detail ? String(o.reflexes.firing.detail).slice(0, 160) : null });
			}
			const seconds = Math.round((now() - t0) / 1000), wallSeconds = Math.round((Date.now() - wall0) / 1000), gameSeconds = Math.round((await timer.elapsed()) / 1000);
			const rates = await timer.rates().catch(() => null);
			await s.normalRate();
			if (act && !actResult) {
				await s.bridge.send('action_cancel', s.record.agentId, { goalRevision: s.record.goalRevision, actionId: actId }).catch(() => {});
				await Promise.race([act, sleep(3000)]);
			}
			let alive = 0;
			for (const id of ids) if (!/No entity|not found/i.test(await s.command(`data get entity ${id} Health`))) alive++;
			// The flinch covers the model's thinking gap: the gate's first hit to next command was 3-10 s, and a model round
			// takes 5-17 s, so the run is also scored at SCORE_S (20 s by default) from the same track.
			const early = track.filter(t => t.t <= SCORE_S && t.hp !== null);
			const diedBy = died && (track.at(-1)?.t ?? 0) <= SCORE_S + 0.6;
			const row = { case: name, repeat, survived: !died, startHealth, diedBy20: diedBy, minHealthBy20: diedBy ? 0 : Math.min(startHealth, ...early.map(t => t.hp)),
				diedAtS: died ? track.at(-1)?.t ?? 0 : null, minHealth: died ? 0 : minHealth, endHealth: died ? 0 : last, hostilesLeft: alive, hostiles: ids.length,
				action: actResult ? { state: actResult.state, reasonCode: actResult.reasonCode ?? null, atS: actResult.atS, message: String(actResult.message ?? '').slice(0, 400) } : (c.act ? 'still running' : null),
				food, startY: ay, minY: Math.min(...track.filter(t => t.y !== undefined).map(t => t.y)), ...defendTally(track),
				reflexEvents: [...events.values()], track, seconds, wallSeconds, gameSeconds, rates, tick: { rate: s.tickRate, held: await s.tickReport() } };
			Object.assign(row, damageEvidence(damageBefore, await readDamage(), startHealth, await health().catch(() => null)));
			runs.push(row);
			console.log(`[crowd] ${name}#${repeat}: hits back ${row.hitsBack}, back-outs ${row.backOuts} (${row.backingOutS} s), lowest feet y ${row.minY}${food !== null ? `, food ${food}` : ''}; start ${startHealth}, by ${SCORE_S} s ${row.diedBy20 ? 'DIED' : `min ${row.minHealthBy20}`}; at ${WATCH_S} s ${row.survived ? 'SURVIVED' : `DIED at ${row.diedAtS} s`} min ${row.minHealth} end ${row.endHealth}, hostiles left ${alive}/${ids.length}${row.action ? `, action ${row.action.reasonCode ?? row.action} at ${row.action.atS ?? '-'} s` : ''} | ${[...events.values()].map(e => e.split(':').slice(0, 2).join(':')).join(' ')}`);
			await writeFile(path.join(out, 'runs.json'), JSON.stringify(runs, null, 1));
		}
	}
	const summary = Object.fromEntries(CASES.map(name => {
		const rows = runs.filter(r => r.case === name);
		return [name, { runs: rows.length, diedBy20: rows.filter(r => r.diedBy20).length, meanMinHealthBy20: +(rows.reduce((a, r) => a + r.minHealthBy20, 0) / rows.length).toFixed(1),
			died: rows.filter(r => !r.survived).length, meanMinHealth: +(rows.reduce((a, r) => a + r.minHealth, 0) / rows.length).toFixed(1),
			meanEndHealth: +(rows.reduce((a, r) => a + r.endHealth, 0) / rows.length).toFixed(1),
			hitsBack: rows.map(r => r.hitsBack), backOuts: rows.map(r => r.backOuts), backingOutS: rows.map(r => r.backingOutS),
			leftStartHeight: rows.filter(r => r.minY < r.startY - 0.6).length }];
	}));
	await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary));
} catch (error) {
	console.error(error);
	await writeFile(path.join(out, 'error.txt'), String(error?.stack ?? error));
} finally {
	await s.stop().catch(() => {});
}
