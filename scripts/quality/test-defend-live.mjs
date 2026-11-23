#!/usr/bin/env node
// FIXTURE_TICK_RATE runs the 25 s watch faster: setup and the summons stay at 20 TPS, then the watch and every wait and
// time in it are game time on the fixture clock (s.clock). The creeper case stays at 20: its creeper is summoned when a
// harness read sees the body's first answer to the skeleton (a wall, defend or the arrow dodge), and its blast damage is read off sampled health while regeneration runs, so both
// depend on how many ticks the reads take. With regeneration on, healthLost reads later hits after more healing at a
// raised rate; rows also record damageTaken (vanilla's cumulative counter, which healing cannot hide), seconds (game),
// wallSeconds and rates.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot, fixtureTickRate } from './watch-replay.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { damageCounter, damageEvidence, deathCounter, recordDeathEvidence } from './lib/damage-counter.mjs';
import { coverReached } from './lib/cover-outcome.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = path.resolve(process.argv[2] ?? 'runtime/defend-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!template || !port || !process.env.JAVA_HOME) throw new Error('Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, MOD_JAR));
const REPEATS = Number(process.env.REPEATS ?? 2);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jar, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), repeats: REPEATS, tickRate: fixtureTickRate(), node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Guard';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const s = await boot(out, { jar, template, port, world: null, seed: '3315172112810107624', tickRate: fixtureTickRate() });
s.bridge.on('message', (event) => {
	const control = event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null;
	if (control == null || event.agentId !== s.record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= s.record.goalRevision) return;
	if (['queue', 'dequeue'].includes(control.operation)) return;
	s.record.goalRevision = control.goalRevision;
	s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
});
const health = async () => { const text = await s.command(`data get entity ${AGENT} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };
const deaths = () => deathCounter(text => s.command(text), AGENT, { objective: 'deaths', unsetIsZero: true });
/** Drains food to 6 or less (sprinting needs more than 6) with a strong Hunger effect, then clears it (as test-crowd-live). */
async function starve() {
	await s.command(`effect give ${AGENT} minecraft:hunger 60 80 true`);
	for (const until = Date.now() + 30000; Date.now() < until;) {
		if (number(await s.command(`data get entity ${AGENT} foodLevel`)) <= 6) break;
		await sleep(150);
	}
	await s.command(`effect clear ${AGENT} minecraft:hunger`);
	return number(await s.command(`data get entity ${AGENT} foodLevel`));
}
const runs = [];
try {
	await s.command('difficulty normal');
	await s.command('gamerule minecraft:spawn_mobs false');
	await s.command('gamerule minecraft:advance_time false');
	await s.command('time set midnight');
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
	await s.command('fill -320 99 -10 -280 99 30 minecraft:stone');
	await s.command('fill -320 100 -10 -280 110 30 minecraft:air');
	await s.command('scoreboard objectives add chk dummy').catch(() => {});
	// "#b has 1 [chk]": the score sits before the objective name, not at the end of the reply.
	const score = text => Number(/has (-?\d+)/.exec(String(text))?.[1]);
	const isBlock = async (x, y, z, id) => { await s.command(`execute store success score #b chk if block ${x} ${y} ${z} ${id}`); return score(await s.command('scoreboard players get #b chk')) === 1; };
	const pos = async (entity = AGENT) => (String(await s.command(`data get entity ${entity} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null);
	const walls = async () => {
		const at = await pos();
		if (!at) return null;
		const [x, z] = [Math.floor(at[0]), Math.floor(at[2])];
		let y = Math.floor(at[1] + 0.2);
		// A body bobbing in shallow water is walled from the cell on the floor.
		if (await isBlock(x, y - 1, z, 'minecraft:water')) y--;
		let count = 0;
		for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) if (await isBlock(x + dx, y + dy, z + dz, 'minecraft:cobblestone')) count++;
		if (await isBlock(x, y + 2, z, 'minecraft:cobblestone')) count++;
		return count;
	};
	// Health the gate2 bodies had when the danger arrived (no food, so no regeneration): set after the full heal.
	const START_HEALTH = { approach: 8, 'approach-hungry': 8, 'approach-fast': 8, shallow: 12, corner: 20, 'corner-bare': 20 };
	const readDamage = await damageCounter(text => s.command(text), AGENT);
	/**
	 * creeper-command (COMBAT-9): a creeper 2 blocks off fuses, default-creeper runs, and 0.3 s in a model command comes as
	 * the coordinator sends one: the reflex update asking the firing to yield, then the action (wait 4 s, which stands).
	 * Before, the run ended at once and the body stood in the blast. Pass: alive and at most 2 HP of damage. Invalid
	 * (notExercised) when the run was not firing as the command came.
	 */
	async function creeperCommand() {
		await s.command('summon minecraft:creeper -299.5 100 12.5 {PersistenceRequired:1b}');
		const tight = ms => new Promise(done => setTimeout(done, ms));
		let o = null, firingSeen = false;
		for (const until = s.clock.now() + 6000; s.clock.now() < until && !firingSeen;) {
			o = await s.observeOrNull();
			firingSeen = o?.reflexes?.firing?.id === 'default-creeper';
			if (!firingSeen) await tight(20);
		}
		if (!firingSeen) return { notExercised: 'default-creeper never fired within 6 s of the creeper' };
		await s.clock.sleep(300);
		o = await s.observeOrNull();
		const firingAtCommand = o?.reflexes?.firing?.id ?? null;
		const sent = book.payload(s.record.agentId, { yieldFiring: true });
		await s.bridge.send('reflex_update', s.record.agentId, sent);
		const commandSentAt = s.clock.now();
		let commandResult = null;
		s.act('wait', { durationMs: 4000 }, 60000).then(r => { commandResult = { state: r.state, reasonCode: r.reasonCode ?? null }; }).catch(error => { commandResult = { error: error.message }; });
		const seen = new Map();
		let lastDistance = null, distanceAtBlast = null, exploded = false, died = false;
		const position = async (entity) => (String(await s.command(`data get entity ${entity} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null);
		while (s.clock.now() - commandSentAt < 6000) {
			o = await s.observeOrNull();
			for (const event of o?.reflexes?.events ?? []) if (event.id === 'default-creeper') seen.set(event.seq, { outcome: event.outcome, detail: String(event.detail ?? '').slice(0, 160) });
			const [creeper, body] = [await position('@e[type=minecraft:creeper,limit=1]'), await position(AGENT)];
			if (creeper && body) lastDistance = +Math.hypot(creeper[0] - body[0], creeper[2] - body[2]).toFixed(1);
			if (!creeper && !exploded) { exploded = true; distanceAtBlast = lastDistance; }
			const h = await health().catch(() => null);
			if (h === 0) { died = true; break; }
			await tight(30);
		}
		// The blast is read in the window above: a creeper still about (its fuse went out) is removed before damage is read,
		// and the command is let finish, so neither reaches the next run.
		await s.command('kill @e[type=minecraft:creeper]');
		for (const until = Date.now() + 10000; commandResult === null && Date.now() < until;) await tight(100);
		const events = [...seen.values()];
		return { firingAtCommand, commandResult, exploded, distanceAtBlast, lastDistance, died, creeperEvents: events,
			yieldedToCommand: events.some(event => event.outcome === 'yielded' && /model command/.test(event.detail)),
			...(firingAtCommand !== 'default-creeper' ? { notExercised: `the run was not firing as the command came (${firingAtCommand})` } : {}) };
	}
	for (const name of (process.env.CASES ?? 'zombie,shield,water,creeper,command').split(',')) {
		for (let run = 1; run <= REPEATS; run++) {
			await s.normalRate();
			for (let attempt = 0; attempt < 10 && !((await health().catch(() => 0)) > 0); attempt++) {
				await s.bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free defend fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] }).catch(() => {});
				await s.act('respawn', {}).catch(() => null); await s.idleSleep(1500);
			}
			await s.idleSleep(3500);
			await s.command('kill @e[type=!minecraft:player]');
			// Walls and pools a previous run left: rebuild the floor so every run starts in the open.
			await s.command('fill -320 96 -10 -280 99 30 minecraft:stone');
			await s.command('fill -320 100 -10 -280 110 30 minecraft:air');
			if (name === 'water') {
				// A pool two deep, the body at its bottom (eyes under water); the skeleton on a pillar above, 6 blocks off.
				await s.command('fill -302 98 8 -298 99 12 minecraft:water');
				await s.command('fill -300 100 16 -300 102 16 minecraft:stone');
			}
			// Still water one deep round the body, held by a one-high stone rim as a lake shore holds it (unheld, it flowed
			// across the floor and its current carried the body off the cell it was walling): it stands on stone, head in air.
			if (name === 'shallow') {
				await s.command('fill -303 100 7 -297 100 13 minecraft:stone');
				await s.command('fill -302 100 8 -298 100 12 minecraft:water');
			}
			// spawner-behind: the pack's zombie comes from behind, on the straight way back. spawner-archer: a skeleton draws
			// from the side while the body backs out. cover-zombie: shieldless with cobblestone, a skeleton shooting, a zombie
			// coming from 7 blocks (too near to stand building) and a stone corner 4 blocks west.
			const spawnerCase = ['spawner', 'spawner-behind', 'spawner-archer'].includes(name);
			if (spawnerCase) {
				await s.command('setblock -301 100 16 minecraft:spawner{Delay:32767s,SpawnData:{entity:{id:"minecraft:zombie"}}}');
			}
			if (name === 'cover-zombie') await s.command('fill -304 100 9 -304 102 11 minecraft:stone');
			// corner, corner-bare: the body at the dig face of its own 1-wide stair cut into stone (solid ahead to the west,
			// the stair up behind it to the east, so a hit cannot knock it out of reach), a zombie coming along a tunnel one block lower that ends diagonal to the body, round the stone corner.
			// The corner is solid at the body's feet, open at its head, so the zombie's eye sees the body's eye (it can hit)
			// while the line to the middle of its hitbox runs into the corner (iron-kit seed 8008 lane 0, 22 Nov).
			const cornerCase = name.startsWith('corner');
			if (cornerCase) {
				await s.command('fill -306 100 4 -294 104 18 minecraft:stone');
				await s.command('fill -300 101 10 -300 103 10 minecraft:air');
				await s.command('fill -299 102 10 -299 104 10 minecraft:air');
				await s.command('fill -298 103 10 -298 104 10 minecraft:air');
				await s.command('fill -299 100 11 -299 101 16 minecraft:air');
				await s.command('setblock -299 102 11 minecraft:air');
				await s.command('setblock -300 102 11 minecraft:air');
			}
			await s.command(`execute in minecraft:overworld run tp ${AGENT} -299.5 ${name === 'water' ? 98 : cornerCase ? 101 : 100} 10.5 ${cornerCase ? 90 : 0} 0`);
			await s.command(`clear ${AGENT}`);
			await s.command(`item replace entity ${AGENT} container.0 with minecraft:${['approach', 'approach-hungry'].includes(name) || cornerCase ? 'iron_pickaxe' : 'stone_sword'}`);
			// archers-zombie (COMBAT-1's lethal room): no shield and no blocks, so neither the arrow shield nor a wall-in can answer.
			if (name !== 'open-archer' && name !== 'archers-zombie') await s.command(`item replace entity ${AGENT} container.3 with minecraft:cobblestone 16`);
			if (name === 'shield' || name === 'spawner-archer' || name === 'corner') await s.command(`item replace entity ${AGENT} weapon.offhand with minecraft:shield`);
			await s.command(`effect clear ${AGENT}`);
			await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`);
			// A hungry body gets no saturation: its food is drained below sprinting instead.
			const food = name === 'approach-hungry' ? await starve() : (await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`), null);
			if (name === 'water') await s.command(`effect give ${AGENT} minecraft:water_breathing 60 0 true`);
			await s.command(`gamerule minecraft:natural_health_regeneration ${START_HEALTH[name] === undefined}`);
			await s.idleSleep(1500);
			if (START_HEALTH[name] !== undefined) await s.command(`damage ${AGENT} ${(await health()) - START_HEALTH[name]} minecraft:generic`);
			const deathsBefore = await deaths();
			const damageBefore = await readDamage();
			const start = await health();
			if (name === 'creeper-command') {
				const row = { case: name, run, ...(await creeperCommand()) };
				const deathsEnd = await deaths().catch(() => null);
				Object.assign(row, damageEvidence(damageBefore, await readDamage(), start, await health().catch(() => null)));
				recordDeathEvidence(row, deathsBefore, deathsEnd);
				row.pass = !row.notExercised && !row.died && !(row.deaths > 0) && Number.isFinite(row.damageTaken) && row.damageTaken <= 2;
				runs.push(row);
				console.log(`[defend] ${name}#${run}: firing at command ${row.firingAtCommand}, yielded ${row.yieldedToCommand}, exploded ${row.exploded} at ${row.distanceAtBlast} blocks, damage ${row.damageTaken}, ${row.died ? 'DIED' : 'alive'}${row.notExercised ? `, NOT EXERCISED: ${row.notExercised}` : ''}`);
				await writeFile(path.join(out, 'runs.json'), JSON.stringify(runs, null, 1));
				continue;
			}
			const skeleton = `summon minecraft:skeleton %X% %Y% %Z% {PersistenceRequired:1b,equipment:{mainhand:{id:"minecraft:bow",count:1}}}`;
			if (cornerCase) await s.command(`summon minecraft:zombie -298.5 100 15.5 {PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b}`);
			if (name === 'zombie' || name === 'spawner' || name === 'spawner-archer') await s.command(`summon minecraft:zombie -299.5 100 14.5 {PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b}`);
			if (name === 'spawner-behind') {
				await s.command(`summon minecraft:zombie -299.5 100 14.5 {PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b}`);
				await s.command(`summon minecraft:zombie -299.5 100 5.5 {PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b}`);
			}
			if (name === 'spawner-archer') await s.command(skeleton.replace('%X%', '-288.5').replace('%Y%', '100').replace('%Z%', '8.5'));
			if (name === 'archers-zombie') {
				// Two skeletons 10 blocks off at right angles (north and east) and a zombie from 8 blocks south, on open stone at night.
				await s.command(skeleton.replace('%X%', '-299.5').replace('%Y%', '100').replace('%Z%', '20.5'));
				await s.command(skeleton.replace('%X%', '-289.5').replace('%Y%', '100').replace('%Z%', '10.5'));
				await s.command(`summon minecraft:zombie -299.5 100 2.5 {PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b}`);
			}
			if (name === 'cover-zombie') {
				await s.command(skeleton.replace('%X%', '-299.5').replace('%Y%', '100').replace('%Z%', '20.5'));
				await s.command(`summon minecraft:zombie -299.5 100 3.5 {PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b}`);
			}
			else if (spawnerCase || cornerCase || name === 'cover-zombie' || name === 'archers-zombie') { /* summoned above */ }
			else if (name.startsWith('approach')) await s.command(`summon minecraft:zombie -299.5 100 19.5 {PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:${name === 'approach-fast' ? 1 : 0}b}`);
			else if (name === 'water') await s.command(skeleton.replace('%X%', '-299.5').replace('%Y%', '103').replace('%Z%', '16.5'));
			else await s.command(skeleton.replace('%X%', '-299.5').replace('%Y%', '100').replace('%Z%', '20.5'));
			const steps = [];
			// Every change of firing, detail (numbers folded) or health, in order, with the game time and body position: the
			// steps list above keeps each step once, so it cannot say what took the body from its walls or when.
			const timeline = [];
			let lastMark = null;
			let maxThreatDistance = 0;
			let backOuts = 0, backingSeen = false, minHealth = start, died = false, hits = 0, shieldS = 0, fired = false, wallingSeen = false, refusal = null, stopped = null, endDetail = null;
			let blockMap = null, commandResult = null, commandSentAt = null, wallsAtCommand = null, creeperAt = null, healthAtCreeper = null, creeperExploded = false, maxWalls = 0;
			// What first answered the skeleton: a wall, or a defend or arrow-dodge firing. The creeper and the command come then.
			let reactedWith = null;
			if (name !== 'creeper') await s.fastRate();
			const now = () => s.clock.now();
			const t0 = now(), wall0 = Date.now(), timer = await s.gameTimer();
			const watchMs = name === 'archers-zombie' ? 40000 : 25000;
			while (now() - t0 < watchMs) {
				await s.clock.sleep(250);
				const o = await s.observeOrNull();
				const detail = o?.reflexes?.firing?.id === 'default-defend' ? String(o.reflexes.firing.detail ?? '') : '';
				if (spawnerCase && o?.position) {
					maxThreatDistance = Math.max(maxThreatDistance, Math.hypot(o.position.x + 300.5, o.position.z - 16.5));
				}
				if (name === 'open-archer' && o?.position) {
					const at = await pos('@e[type=minecraft:skeleton,limit=1]');
					if (at) maxThreatDistance = Math.max(maxThreatDistance, Math.hypot(o.position.x - at[0], o.position.z - at[2]));
				}
				if (o?.reflexes?.firing?.id) {
					const step = `${o.reflexes.firing.id}: ${String(o.reflexes.firing.detail ?? '').replace(/-?[\d.]+/g, '#').slice(0, 160)}`;
					if (!steps.includes(step) && steps.length < 24) steps.push(step);
				}
				if (detail) {
					fired = true;
					endDetail = detail.slice(0, 260);
					if (/walling in from|stepping to the middle/.test(detail)) wallingSeen = true;
					if (/not walling in: [^;]*/.test(detail)) refusal = /not walling in: [^;]*/.exec(detail)[0];
					if (/stopped walling in: [^;]*/.test(detail)) stopped = /stopped walling in: [^;]*/.exec(detail)[0];
					hits = Math.max(hits, Number(/(\d+) hit\(s\) back/.exec(detail)?.[1] ?? 0));
					if (/backing away|backing out/.test(detail)) backingSeen = true;
					backOuts = Math.max(backOuts, Number(/(\d+) back-out\(s\)/.exec(detail)?.[1] ?? 0));
					shieldS = Math.max(shieldS, Number(/shield up ([\d.]+) s/.exec(detail)?.[1] ?? 0));
				}
				const w = await walls();
				// When defend reports walling, record what the world holds round the body (air, cobblestone or other) once.
				if (!blockMap && /walling in|already closed|walled in/.test(detail)) {
					const at = await pos();
					if (at) {
						const [x, y, z] = [Math.floor(at[0]), Math.floor(at[1] + 0.2), Math.floor(at[2])];
						blockMap = { at: [x, y, z], cells: {} };
						for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) for (const dy of [-1, 0, 1, 2]) {
							const key = `${dx},${dy},${dz}`;
							blockMap.cells[key] = (await isBlock(x + dx, y + dy, z + dz, 'minecraft:air')) ? 'air' : (await isBlock(x + dx, y + dy, z + dz, 'minecraft:cobblestone')) ? 'cobble' : 'other';
						}
					}
				}
				if (w !== null) maxWalls = Math.max(maxWalls, w);
				// Since #186 a lone skeleton is often answered by stepping across its shot, with no wall, so the trigger is the
				// first answer of any kind, not only a wall.
				reactedWith ??= (w ?? 0) >= 1 ? 'wall' : ['default-defend', 'default-arrow-dodge'].includes(o?.reflexes?.firing?.id) ? o.reflexes.firing.id : null;
				// creeper: once the body answers the skeleton, a creeper comes from 5 blocks and the skeleton is removed, so any
				// later health lost is the creeper's.
				if (name === 'creeper' && creeperAt === null && reactedWith) {
					await s.command('kill @e[type=minecraft:skeleton]');
					await s.command(`execute at ${AGENT} positioned ~5 ~ ~ run summon minecraft:creeper ~ ~ ~ {PersistenceRequired:1b}`);
					creeperAt = now(); healthAtCreeper = await health();
				}
				if (creeperAt !== null && !creeperExploded && score(await s.command('execute store result score #c chk if entity @e[type=minecraft:creeper]').then(() => s.command('scoreboard players get #c chk'))) === 0) creeperExploded = true;
				if (name === 'command' && commandSentAt === null && reactedWith) {
					wallsAtCommand = w;
					commandSentAt = now();
					s.act('wait', { durationMs: 500 }, 60000).then(r => { commandResult = { state: r.state, reasonCode: r.reasonCode, resultAfterS: +((now() - commandSentAt) / 1000).toFixed(2) }; }).catch(error => { commandResult = { error: error.message }; });
				}
				if (name === 'command' && commandResult && now() - commandSentAt > 3000) break;
				const h = await health().catch(() => null);
				const firingNow = o?.reflexes?.firing ? `${o.reflexes.firing.id}: ${String(o.reflexes.firing.detail ?? '')}` : '-';
				const mark = `${firingNow.replace(/-?[\d.]+/g, '#').slice(0, 90)}|${h}`;
				if (mark !== lastMark && timeline.length < 120) {
					lastMark = mark;
					const at = o?.position ? [o.position.x, o.position.y, o.position.z].map(v => +Number(v).toFixed(1)) : null;
					timeline.push({ t: +((now() - t0) / 1000).toFixed(1), h, at, walls: w, firing: firingNow.slice(0, 200) });
				}
				if ((await deaths()) > deathsBefore || h === 0) { died = true; break; }
				if (h !== null) minHealth = Math.min(minHealth, h);
			}
			const seconds = Math.round((now() - t0) / 1000), wallSeconds = Math.round((Date.now() - wall0) / 1000), gameSeconds = Math.round((await timer.elapsed()) / 1000);
			const rates = await timer.rates().catch(() => null);
			// The lethal room ends its fight before deaths are read, after a settle, so a death just past the watch is still this run's.
			if (name === 'archers-zombie') { await s.command('kill @e[type=!minecraft:player]'); await s.idleSleep(2000); }
			const healthEnd = await health().catch(() => null);
			const deathsEnd = await deaths().catch(() => null);
			await s.normalRate();
			const wallsAtEnd = await walls();
			// What stands round the body's floor cell at the end: cobble, water, air or other, feet and head level.
			let endMap = null;
			const endAt = await pos();
			if (endAt) {
				const [x, z] = [Math.floor(endAt[0]), Math.floor(endAt[2])];
				let y = Math.floor(endAt[1] + 0.2);
				if (await isBlock(x, y - 1, z, 'minecraft:water')) y--;
				endMap = { at: [x, y, z], cells: {} };
				// A probe that cannot read the body's own cell (air or water) reads nothing: the map stays unknown.
				endMap.probeOk = (await isBlock(x, y, z, 'minecraft:air')) || (await isBlock(x, y, z, 'minecraft:water'));
				// The four sides at feet and head level, and the roof over the head. Only a known full block counts as closed:
				// a plant, a torch or lava reads 'other', which is not a wall.
				for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [0, 2, 0]]) {
					const kinds = [['cobble', 'minecraft:cobblestone'], ['water', 'minecraft:water'], ['air', 'minecraft:air'],
						['solid', '#minecraft:base_stone_overworld'], ['solid', '#minecraft:dirt'], ['solid', 'minecraft:cobbled_deepslate'],
						['solid', '#minecraft:planks'], ['solid', '#minecraft:logs'], ['solid', 'minecraft:gravel'], ['solid', 'minecraft:sand']];
					let kind = 'other';
					for (const [name, id] of kinds) if (await isBlock(x + dx, y + dy, z + dz, id)) { kind = name; break; }
					endMap.cells[`${dx},${dy},${dz}`] = kind;
				}
			}
			const row = { case: name, run, food, defendFired: fired, hitsBack: hits, backOuts, backingSeen, shieldSeconds: shieldS, wallingSeen, refusal, stopped, maxWalls, wallsAtEnd,
				wallsAtCommand, commandResult, creeperExploded, blastDamage: healthAtCreeper === null ? null : +(healthAtCreeper - (died ? 0 : minHealth)).toFixed(1),
				endDetail, steps, timeline, blockMap, endMap, died, healthLost: died ? start : +(start - minHealth).toFixed(1),
				seconds, wallSeconds, gameSeconds, rates, tick: { rate: s.tickRate, held: await s.tickReport() } };
			Object.assign(row, damageEvidence(damageBefore, await readDamage(), start, healthEnd));
			recordDeathEvidence(row, deathsBefore, deathsEnd);
			if (spawnerCase || name === 'open-archer') {
				row.maxThreatDistance = +maxThreatDistance.toFixed(1);
				row.pass = !died && maxThreatDistance >= (spawnerCase ? 12 : 16);
			}
			// Cover reached by any firing (defend's own step or a low-health cover rule): only a finished move says "in cover at".
			// A finished wall-in with no side left open counts too: a body closed on every side is safe from arrows and melee,
			// which is what the cover outcome stands for.
			// A body that ends the watch shut in (every side at feet and head level and the roof solid) is in cover as well,
			// also when no poll read a firing's "walled in" report: a body sheltered in its walls stops dodging, so the
			// wall-in's last report can end between two polls and nothing fires after it.
			row.closedAtEnd = !!endMap?.probeOk && Object.values(endMap.cells).every(kind => kind === 'cobble' || kind === 'solid');
			row.coverSeen = steps.some(coverReached) || coverReached(endDetail ?? '') || row.closedAtEnd;
			if (name === 'cover-zombie') row.pass = !died && row.coverSeen;
			// Without an answer to the skeleton the room measured neither the creeper nor the command.
			if (['creeper', 'command'].includes(name)) row.reactedWith = reactedWith;
			if (name === 'creeper' && creeperAt === null && !died) row.notExercised = 'the body never answered the skeleton, so the creeper never came';
			if (name === 'command' && commandSentAt === null && !died) row.notExercised = 'the body never answered the skeleton, so the command was never sent';
			if (name === 'archers-zombie') row.pass = !died && !(row.deaths > 0);
			// Corner: the body lives and kills the zombie that hits it round the corner within the watch.
			if (cornerCase) {
				row.zombieAlive = score(await s.command('execute store result score #z chk if entity @e[type=minecraft:zombie]').then(() => s.command('scoreboard players get #z chk'))) > 0;
				row.pass = !died && !row.zombieAlive;
				if (!fired) row.notExercised = 'default-defend never fired: the zombie never hit or closed on the body';
			}
			runs.push(row);
			console.log(`[defend] ${name}#${run}: fired ${fired}, hits back ${hits}, back-outs ${backOuts} (backing seen ${backingSeen})${food !== null ? `, food ${food}` : ''}, shield ${shieldS} s, walling ${wallingSeen}, walls max ${maxWalls} end ${wallsAtEnd}${refusal ? `, ${refusal}` : ''}${stopped ? `, ${stopped}` : ''}${commandResult ? `, command ${JSON.stringify(commandResult)} (walls when sent ${wallsAtCommand})` : ''}${healthAtCreeper !== null ? `, creeper exploded ${creeperExploded}, blast damage ${row.blastDamage}` : ''}, ${died ? 'DIED' : `lost ${row.healthLost}`}`);
			await writeFile(path.join(out, 'runs.json'), JSON.stringify(runs, null, 1));
		}
	}
} catch (error) {
	console.error(error);
	await writeFile(path.join(out, 'error.txt'), String(error?.stack ?? error));
} finally {
	await s.stop().catch(() => {});
}
