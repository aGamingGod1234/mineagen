#!/usr/bin/env node
// Provider-free check of the rest verb: node scripts/quality/test-rest-live.mjs OUT_DIR
// This script stands in for the coordinator (no model call): it sends the production rest action and nothing else.
// Per seed (SEEDS, default 3), on the surface where /spreadplayers puts the body, no armour, monsters spawning:
//   wool:   3 white wool and 7 oak planks at nightfall (time 13000): rest should craft a table and a bed, sleep, and
//           set the spawn at the bed; reports health lost, the respawn point before and after, the time after.
//   nowool: 16 cobblestone at nightfall with 2 zombies and a skeleton summoned 12-14 blocks off: rest should wall in,
//           wait out the night, open the wall at morning; reports health lost and whether the body is out.
// Then, on the first seed: day (REST_NOT_NIGHT), a sealed room underground (UNDERGROUND), the Nether (REST_NOT_HERE).
// CASES also takes thin1/thin2 (3 cobblestone on a 1- or 2-thick stone roof over a cavern: the hole must not open into it)
// and empty/sand/snow (nothing held at dusk, 12500, on the natural ground of a dry spot or a 9x9 pad of sand or snow
// blocks): rest's dug hole, the only shelter an empty-handed body has.
// TICK_RATE (default 60) speeds the server while a walled-in night runs. The fixture otherwise runs at 20 TPS and ignores
// FIXTURE_TICK_RATE: at 80, 2 of 6 walled-in nights took 3-4 damage and 1 of 6 bed nights could not place its bed, which no
// run at 20 did; the cause is not known. A night's damage is sampled health (minHealth) while the saturated body heals
// about 1 health per half second, so it depends on how much game time passes between reads; rows also record damageTaken,
// vanilla's cumulative counter, which healing cannot hide. ARENA_JAR picks the jar. Launch under slot.sh live with
// ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set; operator commands only set the fixture up.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot } from './watch-replay.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { damageCounter, damageEvidence, deathCounter } from './lib/damage-counter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = path.resolve(process.argv[2] ?? 'runtime/rest-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, basePort = Number(process.env.SLOT_PORT_BASE);
if (!template || !basePort || !process.env.JAVA_HOME) throw new Error('Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, MOD_JAR));
const SEEDS = (process.env.SEEDS ?? '3315172112810107624,20261107,424242').split(',');
const CASES = (process.env.CASES ?? 'wool,nowool').split(',');
const EXTRAS = process.env.EXTRAS !== '0';
const TICK_RATE = Number(process.env.TICK_RATE ?? 60);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jar, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), seeds: SEEDS, cases: CASES, tickRate: TICK_RATE, fixtureTickRate: 20, node: process.version }, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Rest';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdbL]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const rows = [];

async function session(seed, index) {
	const dir = path.join(out, `seed-${index}`);
	await mkdir(dir, { recursive: true });
	// boot() follows any server message carrying a newer goal revision (one dawn run's rest was refused STALE_REVISION
	// when only goal_control was followed).
	const s = await boot(dir, { jar, template, port: basePort + (index % 2) * 50, world: null, seed, spawnMonsters: true });
	const health = async () => { const text = await s.command(`data get entity ${AGENT} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };
	const pos = async () => (String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null);
	// Command feedback is off on this server, so the clock is read from the body's own observation.
	const time = async () => { const o = await s.observeOrNull(); return Number.isFinite(o?.world?.dayTime) ? o.world.dayTime % 24000 : null; };
	// SleepingX/Y/Z exist only while the body lies in a bed.
	const asleep = async () => {
		for (const field of ['sleeping_pos', 'SleepingX']) {
			const text = String(await s.command(`data get entity ${AGENT} ${field}`));
			if (!/Found no elements|No entity|not found|Unknown/i.test(text) && /\d/.test(text)) return true;
		}
		return false;
	};
	// Vanilla's deathCount objective boot() adds ("has 1 [deaths]" once read as NaN and then 0).
	const deaths = () => deathCounter(text => s.command(text), AGENT, { objective: 'deaths', unsetIsZero: true });
	try {
		await s.command('difficulty normal');
		await s.command('gamerule minecraft:advance_time true');
		await s.command('gamerule minecraft:spawn_mobs true');
		let e = null, reply = null;
		for (let attempt = 0; attempt < 3 && !e; attempt++) {
			const registered = s.inbox.wait('agent_registered', () => true, 30000).catch(() => null);
			reply = await s.command(`execute positioned 0.5 200 0.5 run mineagen summon gpt-6.1-sol low ${AGENT}`);
			e = await registered;
		}
		if (!e) throw new Error(`agent never registered: ${reply}`);
		s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
		await s.command(`mineagen start ${AGENT} Survive for 1200 seconds.`); s.record.goalRevision = (await started).payload.goalRevision;
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		await s.command(`gamemode survival ${AGENT}`);
		const readDamage = await damageCounter(text => s.command(text), AGENT);

		// A fresh dry spot each night, away from the last shelter: spreadplayers loads the chunks and avoids water, then the
		// body drops under any canopy. Seed 1 centres on its world spawn (-272, 32): its 0,0 is ocean. REST_SPOT=x,z names
		// the centre instead (one seed per room).
		const drySpot = async () => {
			const spot = String(process.env.REST_SPOT ?? '').split(',').map(Number);
			const [cx, cz] = spot.length === 2 && spot.every(Number.isFinite) ? [spot[0] + rows.length * 48, spot[1]]
				: index === 0 ? [-272 + rows.length * 48, 32] : [index * 400 + rows.length * 48, 0];
			await s.command(`spreadplayers ${cx} ${cz} 0 24 false ${AGENT}`);
			await s.gameSleep(1500);
			await s.command(`execute at ${AGENT} positioned over motion_blocking_no_leaves run tp ${AGENT} ~ ~ ~`);
		};
		const prepare = async (kit, at) => {
			await s.normalRate();
			await s.command('kill @e[type=!minecraft:player]');
			await s.command('time set 1000');
			if (typeof at === 'function') await at();
			else if (at) await s.command(at);
			else await drySpot();
			await s.command(`clear ${AGENT}`);
			for (const [slot, item] of kit) await s.command(`item replace entity ${AGENT} container.${slot} with minecraft:${item}`);
			await s.command(`effect clear ${AGENT}`);
			await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`);
			await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
			await s.gameSleep(2500);
		};
		const run = async (name, { kit, at, setTime = 13000, mobs = [], fast = false, timeoutMs = 600000, cancelAsleepMs = null, healthTarget = 20, lateMobs = [], lateAfterMs = 0 }) => {
			await prepare(kit, at);
			// A body short of health (vanilla spawn protection has passed by now): damage it down and check it took.
			for (let attempt = 0; healthTarget < 20 && attempt < 6 && (await health()) > healthTarget + 0.5; attempt++) {
				await s.command(`damage ${AGENT} ${(await health()) - healthTarget} minecraft:generic`); await s.gameSleep(1000);
			}
			// No natural regeneration for a low-health case, so the body does not heal back over the night (hunger starved
			// it to the 1-health floor instead, which hid what the mobs did).
			await s.command(`gamerule minecraft:natural_health_regeneration ${healthTarget < 20 ? 'false' : 'true'}`);
			const startHealth = await health();
			const deathsBefore = await deaths();
			const damageBefore = await readDamage();
			const spawnBefore = await s.command(`data get entity ${AGENT} respawn`);
			const start = await pos();
			if (setTime !== null) await s.command(`time set ${setTime}`);
			for (const [type, dx, dz] of mobs) {
				const gear = type === 'skeleton' ? '{equipment:{mainhand:{id:"minecraft:bow",count:1}}}' : '';
				await s.command(`execute at ${AGENT} positioned ~${dx} ~ ~${dz} positioned over motion_blocking_no_leaves run summon minecraft:${type} ~ ~ ~ ${gear}`);
			}
			// Windows below are game time (wall time at 20 TPS, as before); the 660 s cap stays wall time. Only the action
			// runs at the raised rate.
			await s.fastRate();
			const t0 = Date.now(), timer = await s.gameTimer();
			let result = null;
			// A command sent just as the goal revision moves on is refused STALE_REVISION; the revision listener has caught
			// up a moment later, so it is sent once more.
			const act = s.act('rest', { timeoutMs }, 700000).then(async r => {
				// Game time: the body stands idle in the night meanwhile, so a raised rate must not make the pause longer.
				if (r?.reasonCode === 'STALE_REVISION') { await s.gameSleep(2000); r = await s.act('rest', { timeoutMs }, 700000); }
				result = r;
			}).catch(error => { result = { state: 'ERROR', message: error.message }; });
			const restId = s.lastActionId;
			let minHealth = await health(), died = false, sped = false, minY = start?.[1] ?? null, asleepAt = null, cancelled = false;
			let lateDone = lateMobs.length === 0;
			while (!result && Date.now() - t0 < 660000) {
				await s.gameSleep(1000);
				// Mobs that wait outside the walls once they are up (a spider, a zombie in a helmet so dawn does not burn it).
				if (!lateDone && (await timer.elapsed()) >= lateAfterMs) {
					lateDone = true;
					for (const [type, dx, dz, nbt] of lateMobs) await s.command(`execute at ${AGENT} positioned ~${dx} ~ ~${dz} positioned over motion_blocking_no_leaves run summon minecraft:${type} ~ ~ ~ ${nbt ?? '{PersistenceRequired:1b}'}`);
				}
				const h = await health().catch(() => null);
				if ((await deaths()) > deathsBefore || h === 0) { died = true; break; }
				if (h !== null) minHealth = Math.min(minHealth, h);
				const p = await pos().catch(() => null);
				if (p && minY !== null) minY = Math.min(minY, p[1]);
				if (cancelAsleepMs !== null && !cancelled) {
					if (asleepAt === null && await asleep()) asleepAt = await timer.elapsed();
					if (asleepAt !== null && (await timer.elapsed()) - asleepAt >= cancelAsleepMs) {
						await s.bridge.send('action_cancel', s.record.agentId, { goalRevision: s.record.goalRevision, actionId: restId }).catch(() => {});
						cancelled = true;
					}
				}
				// Once walled in the body only waits: run the clock faster so a night takes minutes, not ten.
				if (fast && !sped && (await timer.elapsed()) > 20000) {
					if (TICK_RATE > s.tickRate) await s.setRate(TICK_RATE);
					sped = true;
				}
			}
			await Promise.race([act, s.gameSleep(5000)]);
			// The dawn case watches 10 s more after rest hands back, with no command (the model thinking): what an opened
			// wall lets in shows up here.
			if (name === 'dawn' && !died) {
				const after = await s.gameTimer();
				while ((await after.elapsed()) < 10000) {
					await s.gameSleep(500);
					const h = await health().catch(() => null);
					if ((await deaths()) > deathsBefore || h === 0) { died = true; break; }
					if (h !== null) minHealth = Math.min(minHealth, h);
				}
			}
			const gameSeconds = Math.round((await timer.elapsed()) / 1000);
			await s.normalRate();
			await s.gameSleep(1500);
			const end = await pos();
			const stillAsleep = await asleep();
			const row = { stillAsleep, fell: minY !== null && start ? +(start[1] - minY).toFixed(1) : null, cancelled, seed, case: name, state: result?.state ?? 'none', reasonCode: result?.reasonCode ?? null, seconds: Math.round((Date.now() - t0) / 1000), gameSeconds,
				died, startHealth, minHealth: died ? 0 : minHealth, damage: died ? startHealth : +(startHealth - minHealth).toFixed(1), timeAfter: await time(),
				spawnBefore: String(spawnBefore).replace(/^.*?: /, '').slice(0, 200), spawnAfter: String(await s.command(`data get entity ${AGENT} respawn`)).replace(/^.*?: /, '').slice(0, 200),
				start, end, moved: start && end ? +Math.hypot(end[0] - start[0], end[2] - start[2]).toFixed(1) : null,
				message: String(result?.message ?? '').slice(0, 900) };
			Object.assign(row, damageEvidence(damageBefore, await readDamage(), startHealth, await health().catch(() => null)));
			rows.push(row);
			console.log(`[rest] seed ${seed} ${name}: ${row.reasonCode ?? row.state} ${died ? 'DIED' : `damage ${row.damage}`} in ${row.seconds} s, time after ${row.timeAfter}, spawn ${/pos/.test(row.spawnAfter) && row.spawnAfter !== row.spawnBefore ? 'SET' : 'unchanged'} | ${row.message.slice(0, 260)}`);
			await writeFile(path.join(out, 'rows.json'), JSON.stringify(rows, null, 1));
			if (died) { await s.gameSleep(1500); await s.act('respawn', {}).catch(() => null); await s.gameSleep(3500); }
		};
		const dawnPad = async () => {
			await s.command('forceload add -215 785 -185 815'); await sleep(1500);
			await s.command('fill -212 99 788 -188 99 812 minecraft:stone');
			await s.command('fill -212 100 788 -188 112 812 minecraft:air');
			await s.command(`tp ${AGENT} -199.5 100 800.5`);
		};
		for (let repeat = 0; CASES.includes('dawn') && repeat < Number(process.env.DAWN_REPEATS ?? 3); repeat++) {
			await run('dawn', { kit: [[0, 'cobblestone 16']], at: dawnPad, setTime: 22700, healthTarget: 5, lateAfterMs: 30000,
				// Two zombies in helmets (dawn does not burn them) outside the east side, where rest opens its wall; a spider
				// turns calm in daylight and stood off in earlier runs.
				lateMobs: [['zombie', 3, 0, '{PersistenceRequired:1b,equipment:{head:{id:"minecraft:iron_helmet",count:1}}}'], ['zombie', 3, 2, '{PersistenceRequired:1b,equipment:{head:{id:"minecraft:iron_helmet",count:1}}}']] });
		}
		if (CASES.includes('wool')) await run('wool', { kit: [[0, 'white_wool 3'], [1, 'oak_planks 7']] });
		if (CASES.includes('nowool')) await run('nowool', { kit: [[0, 'cobblestone 16']], mobs: [['zombie', 12, 0], ['zombie', -12, 3], ['skeleton', 3, 14]], fast: true });
		const thin = thick => async () => {
			const [x, z] = [-200, 600];
			await s.command(`forceload add ${x - 10} ${z - 10} ${x + 10} ${z + 10}`); await sleep(1500);
			await s.command(`fill ${x - 8} 40 ${z - 8} ${x + 8} ${68 + thick} ${z + 8} minecraft:stone`);
			await s.command(`fill ${x - 7} 41 ${z - 7} ${x + 7} 68 ${z + 7} minecraft:air`);
			await s.command(`fill ${x - 8} ${69 + thick} ${z - 8} ${x + 8} 100 ${z + 8} minecraft:air`);
			await s.command(`tp ${AGENT} ${x + 0.5} ${69 + thick} ${z + 0.5}`);
		};
		if (CASES.includes('thin1')) await run('thin1', { kit: [[0, 'cobblestone 3']], at: thin(1), fast: true });
		if (CASES.includes('thin2')) await run('thin2', { kit: [[0, 'cobblestone 3']], at: thin(2), fast: true });
		// Empty-handed at dusk on open ground, as a fresh or respawned body is: rest's only way is the dug hole. empty is
		// the natural ground at a dry spot; sand and snow put a 9x9 pad of that ground under the body there, 4 deep.
		const pad9 = block => async () => {
			await drySpot();
			const p = await pos();
			if (!p || block === null) return;
			const [x, y, z] = p.map(Math.floor);
			await s.command(`fill ${x - 4} ${y - 4} ${z - 4} ${x + 4} ${y - 1} ${z + 4} minecraft:${block}`);
			await s.command(`fill ${x - 4} ${y} ${z - 4} ${x + 4} ${y + 3} ${z + 4} minecraft:air`);
			await s.command(`tp ${AGENT} ${x + 0.5} ${y} ${z + 0.5}`);
		};
		for (const [name, block] of [['empty', null], ['sand', 'sand'], ['snow', 'snow_block']]) {
			if (CASES.includes(name)) await run(name, { kit: [], at: pad9(block), setTime: 12500, fast: true });
		}
		// A flat stone pad of its own for the bed cases (spreadplayers can leave the body where the last case stood).
		const pad = async () => {
			await s.command('forceload add -210 690 -190 710'); await sleep(1500);
			await s.command('fill -206 99 694 -194 99 706 minecraft:stone');
			await s.command('fill -206 100 694 -194 110 706 minecraft:air');
			await s.command(`tp ${AGENT} -199.5 100 700.5`);
		};
		if (CASES.includes('cancel') || CASES.includes('timeout')) await s.command('gamerule minecraft:players_sleeping_percentage 101');
		if (CASES.includes('cancel')) await run('cancel', { kit: [[0, 'white_wool 3'], [1, 'oak_planks 7']], at: pad, cancelAsleepMs: 2000 });
		if (CASES.includes('timeout')) await run('timeout', { kit: [[0, 'white_wool 3'], [1, 'oak_planks 7']], at: pad, timeoutMs: 20000 });
		if (CASES.includes('cancel') || CASES.includes('timeout')) await s.command('gamerule minecraft:players_sleeping_percentage 100');
		if (EXTRAS && index === 0) {
			await run('day', { kit: [[0, 'cobblestone 16']], setTime: null });
			await s.command('fill 40 20 40 44 24 44 minecraft:stone'); await s.command('fill 41 21 41 43 22 43 minecraft:air');
			await run('underground', { kit: [[0, 'cobblestone 16']], at: `tp ${AGENT} 42.5 21 42.5` });
			await s.command('execute in minecraft:the_nether run forceload add 0 0'); await sleep(1500);
			await s.command('execute in minecraft:the_nether run fill -3 99 -3 3 104 3 minecraft:glass hollow');
			await run('nether', { kit: [[0, 'cobblestone 16']], at: `execute in minecraft:the_nether run tp ${AGENT} 0.5 100 0.5` });
		}
	} finally {
		await writeFile(path.join(dir, 'tick.json'), JSON.stringify({ tickRate: s.tickRate, held: await s.tickReport() }, null, 2)).catch(() => {});
		await s.stop().catch(() => {});
	}
}

try {
	for (let index = 0; index < SEEDS.length; index++) await session(SEEDS[index], index);
} catch (error) {
	console.error(error);
	await writeFile(path.join(out, 'error.txt'), String(error?.stack ?? error));
}
const nights = rows.filter(row => ['wool', 'nowool'].includes(row.case));
const summary = { nights: nights.length, survived: nights.filter(row => !row.died).length, noDamage: nights.filter(row => !row.died && row.damage === 0).length,
	rested: nights.filter(row => row.reasonCode === 'RESTED').length, bedSpawnSet: rows.filter(row => row.case === 'wool' && /pos/.test(row.spawnAfter) && row.spawnAfter !== row.spawnBefore).length,
	extras: rows.filter(row => !['wool', 'nowool'].includes(row.case)).map(row => `${row.case}:${row.reasonCode}`) };
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
