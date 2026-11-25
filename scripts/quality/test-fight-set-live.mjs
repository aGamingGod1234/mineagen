#!/usr/bin/env node
// Provider-free mixed fight set: node scripts/quality/test-fight-set-live.mjs OUT_DIR [--descriptive]
// One fight per (mob, place, kit, stand-in): does the body come out of a fight with each mob that killed real games alive,
// and how much does it lose? Real fortress and overworld games on 25 Nov lost 32 of 42 deaths to fights: skeleton,
// zombie, drowned, blaze, creeper, spider, piglin, zombified piglin, wither skeleton, magma cube. The score is the sum
// over the set of deaths and damage taken (vanilla counters), so one fix is judged on every mob at once.
// Places (PLACES, comma list), each built fresh around the body before its fight:
//   open    a flat stone field 100 by 80 blocks with no drop in reach; the mob DIST blocks ahead.
//   tight   a corridor 2 wide and 3 high, roofed; the mob DIST blocks down it.
//   ledge   a 3-wide nether-brick bridge 6 above a lava sea; the mob DIST blocks along it.
// Kits (KITS): iron  iron sword, shield in the off hand, full iron armour, cobblestone 64, cooked beef 8.
//              none  the same without armour.
//              stone  what real games met their deaths with: a stone sword, a shield, 16 cobblestone, no armour, no food.
// Stand-ins (STANDINS): fight  the model's call: fight_target on the mob (pursue, shield, flee at 6, 15 s) until it dies,
//                              the body dies or the window ends; nothing else.
//                       idle   no model call at all: the default reflexes alone, as between turns or while it thinks.
//                       walk   the model busy elsewhere: navigate_to the far end of the place and back, again and again,
//                              as most real fight deaths came under a travel or a walk.
//                       flee   the model's other answer: flee_from the nearest of the mobs (14 blocks, 8 s), again and again.
// Every fight arms the default reflexes as the coordinator arms them (ReflexBook), with night set so drowned and the rest
// hunt the body, natural spawning off, the mob persistent and, for the neutral ones (piglin, zombified piglin), angered
// at the body by a 0.5 hit from it. A fight ends when the mob is dead, the body is dead, or WINDOW_S game seconds pass.
// Per fight: died, damage taken, mob killed, mob health lost, seconds, fell (feet more than 2 below the start), lowest
// feet y. A fight passes when the body survives it. result.json holds every fight; fight-set.json adds totals per mob,
// place, kit and stand-in.
// Each fight also keeps the reflex events seen while it ran and the body's lowest health (from observations once a second).
// Env: ARENA_JAR, MOBS (default all ten), PLACES (open,tight,ledge), KITS (iron,none,stone), STANDINS (fight,idle,walk,flee),
// REPEATS (default 1), DIST (default 8), WINDOW_S (default 40), GROUP, START_HEALTH (default 20). Launch under slot.sh live with
// ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set.
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { boot, unshownTickRate } from './watch-replay.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { damageCounter, recordDamageEvidence, deathCounter, recordDeathEvidence } from './lib/damage-counter.mjs';
import { MOD_JAR } from './mod-jar.mjs';

const root = resolve(import.meta.dirname, '../..');
const USAGE = 'usage: node scripts/quality/test-fight-set-live.mjs OUT_DIR [--descriptive] (under slot.sh live, ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set; MOBS, PLACES, KITS, STANDINS, REPEATS, DIST, WINDOW_S)';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const outArg = cli.find(arg => !arg.startsWith('--'));
if (!outArg || !process.env.ARENA_HEADLESS_SERVER_TEMPLATE || !process.env.SLOT_PORT_BASE || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const out = resolve(outArg), jar = resolve(process.env.ARENA_JAR ?? join(root, MOD_JAR));
const TICK_RATE = unshownTickRate('a new fixture, not yet in a 20 vs 60 TPS A/B');

// The mob as summoned: its NBT, how many come at once (as the real fights met them: a lone creeper, a pack of zombified
// piglins), and whether a hit from the body is what turns them on the body. GROUP=1 summons one of each.
const MOBS = {
	skeleton: { nbt: ',equipment:{mainhand:{id:"minecraft:bow",count:1}}', count: 2 },
	zombie: { nbt: ',IsBaby:0b', count: 3 },
	drowned: { nbt: ',IsBaby:0b', count: 2 },
	blaze: { nbt: '', hover: 1, count: 2 },
	creeper: { nbt: '', count: 1 },
	spider: { nbt: '', count: 2 },
	piglin: { nbt: ',IsImmuneToZombification:1b,IsBaby:0b,equipment:{mainhand:{id:"minecraft:golden_sword",count:1}}', count: 2 },
	zombified_piglin: { nbt: ',IsBaby:0b,equipment:{mainhand:{id:"minecraft:golden_sword",count:1}}', provoke: true, count: 3 },
	wither_skeleton: { nbt: ',equipment:{mainhand:{id:"minecraft:stone_sword",count:1}}', count: 2 },
	magma_cube: { nbt: ',Size:1', count: 2 },
};
const GROUP = process.env.GROUP === undefined ? null : Number(process.env.GROUP);
// START_HEALTH: the body's health when the fight starts (real fights mostly began part-hurt); the setup's own damage is
// read before the fight's counter starts, so it is not counted.
const START_HEALTH = Number(process.env.START_HEALTH ?? 20);
const list = (name, fallback) => (process.env[name] ?? fallback).split(',').map(x => x.trim()).filter(Boolean);
const MOB_LIST = list('MOBS', Object.keys(MOBS)), PLACES = list('PLACES', 'open,tight,ledge'), KITS = list('KITS', 'iron,none');
const STANDINS = list('STANDINS', 'fight,idle');
const REPEATS = Number(process.env.REPEATS ?? 1), DIST = Number(process.env.DIST ?? 8), WINDOW_S = Number(process.env.WINDOW_S ?? 40);
for (const m of MOB_LIST) if (!MOBS[m]) { console.error(`unknown mob ${m}`); process.exit(2); }
for (const p of PLACES) if (!['open', 'tight', 'ledge'].includes(p)) { console.error(`unknown place ${p}`); process.exit(2); }
for (const k of KITS) if (!['iron', 'none', 'stone'].includes(k)) { console.error(`unknown kit ${k}`); process.exit(2); }
for (const t of STANDINS) if (!['fight', 'idle', 'walk', 'flee'].includes(t)) { console.error(`unknown stand-in ${t}`); process.exit(2); }
const planned = MOB_LIST.length * PLACES.length * KITS.length * STANDINS.length * REPEATS;

const hash = createHash('sha256'); for await (const chunk of createReadStream(jar)) hash.update(chunk);
await mkdir(out, { recursive: true });
const results = { kind: 'provider-free mixed fight set', jar, jarSha256: hash.digest('hex'), mobs: MOB_LIST, places: PLACES, kits: KITS, standIns: STANDINS, repeats: REPEATS, dist: DIST, windowS: WINDOW_S, tickRate: TICK_RATE, fights: [] };
const save = () => writeFile(join(out, 'fight-set.json'), JSON.stringify(results, null, 1));
const number = text => { const m = /(-?[\d.]+)[fd]?\s*$/.exec(String(text ?? '').trim()); return m ? Number(m[1]) : null; };
// Floor (walking surface) at feet y 101 everywhere; the ledge's lava sea lies 6 below it.
const FEET = 101, X0 = 0, Z0 = 0;
let s;
// Mobs of the fight still alive, counted into command storage and read back (null when the read fails).
const alive = async () => {
	await s.command('execute store result storage mineagen:fightset alive int 1 if entity @e[tag=fightset]');
	return number(await s.command('data get storage mineagen:fightset alive'));
};
const feetY = async () => number(await s.command('data get entity Probe Pos[1]'));

// The open field is wide enough that a back-out or a shove never reaches its rim: a narrow one was a plateau whose edge
// (natural terrain far below) killed bodies that backed away. Every build clears the whole field's space first.
const FIELD = { x0: X0 - 40, x1: X0 + 60, z0: Z0 - 40, z1: Z0 + 40 };

async function build(place) {
	for (let x = FIELD.x0; x <= FIELD.x1; x += 16) await s.command(`fill ${x} 92 ${FIELD.z0} ${Math.min(FIELD.x1, x + 15)} 110 ${FIELD.z1} minecraft:air`);
	await s.command(`fill ${X0 - 6} 92 ${Z0 - 8} ${X0 + 26} 99 ${Z0 + 8} minecraft:stone`);
	if (place === 'open') await s.command(`fill ${FIELD.x0} 100 ${FIELD.z0} ${FIELD.x1} 100 ${FIELD.z1} minecraft:stone`);
	else if (place === 'tight') {
		// Solid rock with a corridor 2 wide (z 0 and 1) and 3 high cut through it.
		await s.command(`fill ${X0 - 6} 100 ${Z0 - 3} ${X0 + 26} 105 ${Z0 + 4} minecraft:stone`);
		await s.command(`fill ${X0 - 3} 101 ${Z0} ${X0 + 22} 103 ${Z0 + 1} minecraft:air`);
	} else {
		await s.command(`fill ${X0 - 6} 94 ${Z0 - 8} ${X0 + 26} 94 ${Z0 + 8} minecraft:lava`);
		await s.command(`fill ${X0 - 6} 95 ${Z0 - 8} ${X0 + 26} 99 ${Z0 + 8} minecraft:air`);
		await s.command(`fill ${X0 - 4} 100 ${Z0 - 1} ${X0 + 22} 100 ${Z0 + 1} minecraft:nether_bricks`);
	}
}

const weapon = name => name === 'stone' ? 'stone_sword' : 'iron_sword';
// The far end of each place a walk heads for, and its start: the walk stand-in goes there and back past the mobs.
const WALK_END = { open: X0 + 20, tight: X0 + 20, ledge: X0 + 20 };

async function kit(name) {
	await s.command('clear Probe'); await s.command('effect clear Probe');
	await s.command('effect give Probe minecraft:instant_health 1 4 true'); await s.command('effect give Probe minecraft:saturation 1 20 true');
	await s.command(`item replace entity Probe hotbar.0 with minecraft:${weapon(name)}`);
	await s.command(`item replace entity Probe hotbar.1 with minecraft:cobblestone ${name === 'stone' ? 16 : 64}`);
	if (name !== 'stone') await s.command('item replace entity Probe hotbar.2 with minecraft:cooked_beef 8');
	await s.command('item replace entity Probe weapon.offhand with minecraft:shield');
	if (name === 'iron') for (const [slot, item] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]) {
		await s.command(`item replace entity Probe armor.${slot} with minecraft:iron_${item}`);
	}
}

const rows = [];
try {
	s = await boot(out, { jar, template: process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port: Number(process.env.SLOT_PORT_BASE), seed: 20261125, tickRate: TICK_RATE });
	await s.command('gamerule minecraft:spawn_mobs false'); await s.command('difficulty hard');
	await s.command('time set midnight'); await s.command('gamerule minecraft:advance_time false');
	await s.command('gamerule minecraft:advance_weather false'); await s.command('weather clear');
	await s.command(`forceload add ${FIELD.x0 - 8} ${FIELD.z0 - 8} ${FIELD.x1 + 8} ${FIELD.z1 + 8}`);
	const registered = s.inbox.wait('agent_registered'); await s.command('mineagen summon gpt-6.1-sol low Probe');
	const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start'); await s.command('mineagen start Probe Survive for 3600 seconds.');
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command('gamemode survival Probe');
	const readDamage = await damageCounter(text => s.command(text), 'Probe');
	const deaths = () => deathCounter(text => s.command(text), 'Probe', { objective: 'deaths', unsetIsZero: true });
	// The default rules as the coordinator arms them on a body's first live sample (as test-lone-blaze-live.mjs).
	const book = new ReflexBook();
	// A death moves the goal revision, so a respawn sent before the new revision arrives is refused: ask again until the
	// body observes, up to a minute.
	const respawned = async () => {
		for (let i = 0; i < 12; i++) {
			await s.act('respawn', {}, 10000).catch(() => {});
			if (await s.observeOrNull()) return;
			await s.clock.sleep(1000);
		}
		throw new Error('the body did not respawn after its death');
	};
	const arm = async () => {
		book.observeContext(s.record.agentId, await s.observe());
		const payload = book.payload(s.record.agentId);
		s.revision = Math.max((s.revision ?? 0) + 1, payload.revision);
		await s.bridge.send('reflex_update', s.record.agentId, { ...payload, revision: s.revision });
		for (let i = 0; i < 50; i++) {
			const o = await s.observe();
			if (o.reflexes?.revision === s.revision && (o.reflexes.rules ?? []).some(rule => rule.id === 'default-defend')) return;
			await s.clock.sleep(200);
		}
		throw new Error(`default reflexes (revision ${s.revision}) never echoed with default-defend`);
	};
	for (const standIn of STANDINS) for (const kitName of KITS) for (const place of PLACES) for (const mob of MOB_LIST) for (let repeat = 1; repeat <= REPEATS; repeat++) {
		const name = `${mob}-${place}-${kitName}-${standIn}${REPEATS > 1 ? `-${repeat}` : ''}`;
		const row = { name, mob, place, kit: kitName, standIn, repeat, startedAt: Date.now(), calls: [] };
		try {
			await s.normalRate();
			// A body left dead by an earlier fight (its respawn refused) is brought back before this one.
			if (!(await s.observeOrNull())) await respawned();
			await s.setReflexes([]);
			await s.command('kill @e[type=!minecraft:player]');
			await build(place);
			if (await s.command('execute if entity Probe[gamemode=spectator]').then(t => /passed/.test(t)).catch(() => false)) await s.command('gamemode survival Probe');
			await s.command(`tp Probe ${X0 + 0.5} ${FEET} ${Z0 + 0.5} -90 0`);
			await kit(kitName);
			await s.observe();
			const spec = MOBS[mob];
			const count = GROUP ?? spec.count;
			// A group stands across the place's width (the corridor's two lanes), a block apart along it.
			for (let i = 0; i < count; i++) {
				await s.command(`summon minecraft:${mob} ${X0 + DIST + 0.5 + i} ${FEET + (spec.hover ?? 0)} ${Z0 + 0.5 + (i % 2)} {Tags:["fightset"],PersistenceRequired:1b${spec.nbt}}`);
			}
			// Summoned by command a mob carries nothing: the weapon it spawns with in a real world is given above.
			// A neutral mob is angered at the body as a hit from it would: its anger target and time set on it (both the
			// older and the newer save names), then read back.
			if (spec.provoke) {
				const uuid = /\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/.exec(String(await s.command('data get entity Probe UUID') ?? ''));
				if (!uuid) throw new Error('could not read the body\'s UUID to anger the mob');
				const ints = `[I;${uuid.slice(1).join(',')}]`;
				const gameTime = number(await s.command('time query gametime')) ?? 0;
				await s.command(`execute as @e[tag=fightset] run data merge entity @s {AngerTime:2400,AngryAt:${ints},anger_end_time:${gameTime + 2400}L,angry_at:${ints}}`);
				row.provoked = String(await s.command('data get entity @e[tag=fightset,limit=1]') ?? '').match(/(AngerTime|anger_end_time|AngryAt|angry_at)[^,]*/g)?.join(' ') ?? 'no anger field';
			}
			if (START_HEALTH < 20) await s.command(`damage Probe ${20 - START_HEALTH} minecraft:generic`);
			await arm();
			const damageBefore = await readDamage(), deathsBefore = await deaths().catch(() => null);
			row.count = count;
			if ((await alive()) !== count) throw new Error(`summoned ${count} ${mob}, ${await alive()} alive at the start`);
			let lowest = await feetY();
			await s.fastRate();
			const t0 = s.clock.now();
			const sampler = setInterval(() => { feetY().then(y => { if (y !== null && (lowest === null || y < lowest)) lowest = y; }).catch(() => {}); }, 250);
			// Once a second: ask for an observation (not awaited: a dead body sends none) and keep the reflex events and
			// health the last one carried.
			const seenEvents = new Set();
			// The observation keeps the last events of earlier fights too: only those after this fight's start count.
			const seq0 = Math.max(0, ...(s.observation?.reflexes?.events ?? []).map(ev => Number(ev.seq) || 0));
			row.reflex = []; row.minHealth = null;
			const watch = () => {
				const o = s.observation;
				if (o) {
					const health = o.player?.health;
					if (Number.isFinite(health) && (row.minHealth === null || health < row.minHealth)) row.minHealth = health;
					for (const ev of o.reflexes?.events ?? []) {
						const key = `${ev.seq}:${ev.id}:${ev.outcome}`;
						if (seenEvents.has(key) || (Number(ev.seq) || 0) <= seq0) continue;
						seenEvents.add(key);
						if (row.reflex.length < 60) row.reflex.push({ t: Math.round((s.clock.now() - t0) / 100) / 10, seq: ev.seq, id: ev.id, outcome: ev.outcome, ms: ev.ms, detail: String(ev.detail ?? '').slice(0, 240) });
					}
				}
				s.bridge.send('request_observation', s.record.agentId, { goalRevision: s.record.goalRevision }).catch(() => {});
			};
			const watcher = setInterval(watch, 1000);
			const over = async () => {
				const living = await alive();
				if (living === null) throw new Error('could not count the fight\'s mobs');
				if (living === 0) return 'all dead';
				// A dead body sends no observation: the vanilla death counter says it died.
				const nowDeaths = await deaths().catch(() => null);
				if (nowDeaths !== null && deathsBefore !== null && nowDeaths > deathsBefore) return 'body died';
				return (s.clock.now() - t0) / 1000 >= WINDOW_S ? 'window' : null;
			};
			try {
				let ended = null;
				while (!(ended = await over())) {
					if (standIn === 'fight') {
						const o = await s.observe().catch(() => null);
						if (!o) continue;
						// The nearest of the fight's mobs, as a model names the one closing in.
						const target = (o.entities ?? []).filter(x => x.type === `minecraft:${mob}`).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
						if (!target) { await s.clock.sleep(500); continue; }
						await s.act('select_item', { itemId: `minecraft:${weapon(kitName)}` }).catch(() => {});
						const left = Math.max(2000, Math.min(15000, WINDOW_S * 1000 - (s.clock.now() - t0)));
						const r = await s.act('fight_target', { targetId: target.uuid, pursue: true, shield: true, fleeAtHealth: 6, collect: false, timeoutMs: left }, left + 15000).catch(error => ({ state: 'ERROR', message: String(error?.message ?? error) }));
						row.calls.push({ state: r.state, reasonCode: r.reasonCode, message: String(r.message ?? '').slice(0, 300) });
					} else if (standIn === 'walk') {
						// There and back along the place, past the mobs, as a travel that does not stop for them.
						const o = await s.observe().catch(() => null);
						if (!o) { await s.clock.sleep(500); continue; }
						const x = (o.player?.x ?? X0) < (X0 + WALK_END[place]) / 2 ? WALK_END[place] : X0;
						const left = Math.max(2000, Math.min(12000, WINDOW_S * 1000 - (s.clock.now() - t0)));
						const r = await s.act('navigate_to', { x: x + 0.5, y: FEET, z: Z0 + 0.5, tolerance: 1, sprint: false, timeoutMs: left }, left + 15000).catch(error => ({ state: 'ERROR', message: String(error?.message ?? error) }));
						row.calls.push({ state: r.state, reasonCode: r.reasonCode, message: String(r.message ?? '').slice(0, 300) });
					} else if (standIn === 'flee') {
						const o = await s.observe().catch(() => null);
						if (!o) { await s.clock.sleep(500); continue; }
						const target = (o.entities ?? []).filter(x => x.type === `minecraft:${mob}`).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
						if (!target) { await s.clock.sleep(500); continue; }
						const r = await s.act('flee_from', { targetId: target.uuid, distance: 14, timeoutMs: 8000 }, 23000).catch(error => ({ state: 'ERROR', message: String(error?.message ?? error) }));
						row.calls.push({ state: r.state, reasonCode: r.reasonCode, message: String(r.message ?? '').slice(0, 300) });
					} else await s.clock.sleep(1000);
				}
				row.ended = ended;
			} finally { clearInterval(sampler); clearInterval(watcher); watch(); }
			row.seconds = Math.round((s.clock.now() - t0) / 1000);
			await s.normalRate();
			const left = await alive();
			if (left === null) throw new Error('could not count the fight\'s mobs');
			row.killed = left === 0; row.mobsKilled = count - left;
			row.lowestFeetY = lowest;
			row.fell = lowest !== null && lowest < FEET - 2;
			recordDamageEvidence(row, damageBefore, await readDamage());
			recordDeathEvidence(row, deathsBefore, await deaths().catch(() => null));
			if (lowest === null) (row.integrity ??= []).push({ file: 'feet', error: 'no feet position read during the fight' });
			row.died = row.deaths === null ? null : row.deaths > 0;
			row.pass = row.died === false;
			if (row.died) row.failReason = `died to ${mob} (${place}, ${kitName}, ${standIn})${row.fell ? ' after a fall' : ''}`;
			if (row.deaths) await respawned();
		} catch (error) {
			row.error = String(error?.stack ?? error).slice(0, 1500);
		}
		row.finishedAt = Date.now();
		rows.push(row); results.fights.push(row); await save();
		console.log(`[fight-set] ${name}: ${row.error ? `ERROR ${row.error.slice(0, 160)}` : `${row.died ? 'DIED' : 'lived'}${row.fell ? ' (fell)' : ''}, damage ${row.damageTaken}, killed ${row.mobsKilled}/${row.count}, ${row.seconds}s, ${row.ended}`}`);
	}
} catch (error) {
	console.error(error);
	results.error = String(error?.stack ?? error).slice(0, 1500);
} finally { await s?.stop().catch(() => {}); await save(); }
// Totals: deaths and damage per mob, place, kit and stand-in; an unread counter makes its total unknown (null).
const total = group => {
	const known = (k) => group.some(r => r[k] === null || r[k] === undefined) ? null : group.reduce((n, r) => n + r[k], 0);
	return { fights: group.length, deaths: known('deaths'), damageTaken: known('damageTaken') === null ? null : Math.round(known('damageTaken') * 10) / 10, cleared: group.filter(r => r.killed).length, mobsKilled: group.reduce((n, r) => n + (r.mobsKilled ?? 0), 0), falls: group.filter(r => r.fell).length };
};
const valid = results.fights.filter(r => !r.error);
results.summary = { all: total(valid) };
for (const key of ['mob', 'place', 'kit', 'standIn']) {
	results.summary[key] = {};
	for (const value of [...new Set(valid.map(r => r[key]))]) results.summary[key][value] = total(valid.filter(r => r[key] === value));
}
await save();
console.log(`[fight-set] totals ${JSON.stringify(results.summary.all)}`);
console.log(`[fight-set] per mob ${JSON.stringify(Object.fromEntries(Object.entries(results.summary.mob ?? {}).map(([k, v]) => [k, `${v.deaths} deaths, ${v.damageTaken} dmg`])))}`);
const report = await finishRun(rows.length || !results.error ? rows : [{ name: 'boot', error: results.error, startedAt: Date.now(), finishedAt: Date.now() }], { file: join(out, 'result.json'), planned, strict });
console.log(`[fight-set] ${report.line}`);
process.exit(report.exitCode);
