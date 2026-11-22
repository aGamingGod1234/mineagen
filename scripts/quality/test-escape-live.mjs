// Provider-free "get me out safely" rooms: node scripts/quality/test-escape-live.mjs OUT_DIR JAR [runs] [room;room...] [--strict|--descriptive]
// One fresh server (seed 1) per JAR. Each trial builds a room with operator commands on a flat stone pad, arms the
// coordinator's default reflexes, and plays a stand-in for the model: one decision every THINK_MS (a model round trip),
// until the body is safe or the room's window ends.
//   deep     the body on the floor of an 11x11 pool 9 deep, about 6 s of air left at the first decision.
//   stair    the body at the bottom of an 8-step staircase cut into stone and flooded with source water (a straight
//            swim up meets the stair ceiling).
//   pit      the body on the floor of a 1x1 hole 5 deep, 16 cobblestone carried, no pickaxe.
//   pitdig   the same hole 4 deep, a stone pickaxe and no blocks.
//   shaft    afloat in a 1x1 shaft 13 deep whose bottom 4 cells are flooded, no bank anywhere, 16 cobblestone carried
//            (a find's shaft that broke into an underground lake).
//   lake     a 1x1 shaft 7 deep that broke the stone roof of a flooded cave (9x9, 6 deep, every cell a source, ceiling
//            under the shaft): afloat with the feet in the lake's top cell and the head in the shaft; 16 cobblestone and
//            an iron pickaxe. The only air is the shaft. Pass: dry footing out of the water.
//   skeleton the body on open ground with an offhand shield, a skeleton 10 blocks east, a 3x3 stone wall 3 blocks west.
//   skeleton-ledge  the skeleton room with the ground behind the wall a 5-deep drop onto lava. Pass: alive and never
//            more than 1 block below the pad (a cover walk over ground taken as level must not step off it).
//   pitskel  the playtest's cave death: a hole 2 deep and 2 wide at 7 health, cobblestone and a stone sword, a bow skeleton
//            in the hole beside the body. Pass: alive, and out of the hole or the skeleton dead, within 40 s.
//   pitcreeper the hole 4 deep with a stone pickaxe only (stairs up) and a creeper on the surface 7 blocks away: out
//            alive within 60 s; damage and deaths are read too (climbing on must not trade a stop for a blast).
//   pitcreeper-rim the same hole with a still creeper on the rim beside it, out of reach: passes when no escape call
//            runs to its deadline (a stand guarding an unreachable creeper must not hold the body there).
// Optional regressions (escape jar): archer-direction puts a nearer zombie west of the body and a skeleton east.
// archer-resume pauses the run with a reflex while the skeleton is still in range.
// The arm is read from the jar: a jar with the escape body job plays "escape" (every decision is do_step escape); any
// other jar plays "legacy", fixed in advance (a stand-in, not a model). ESCAPE_LEGACY=strong (the default) gives it the
// strongest single old call, handed the room's geometry: water rooms travel_to the bank, pit build pillar of the hole's
// depth, pitdig dig_to stairs_up to the rim, skeleton flee_from 16 blocks. ESCAPE_LEGACY=wake plays what the old wake text
// prescribed by hand: under water a raw control frame holding jump for 2 s ("hold jump to refill"), else travel_to the
// bank; pit one pillar block per decision.
// A trial passes: water rooms on dry footing out of the water, pit rooms standing at or above the rim, both alive in the
// window and still safe 2 s later; skeleton alive with at most 6 health lost over its 30 s window and behind the wall for its last 2 s. Reports per trial:
// pass, decisions, seconds to safe, health lost, death, the results. A room is INVALID (notExercised) when the live body
// did not start in danger (eyes not under water, not in the hole, no skeleton in sight) or reflexes alone made it safe
// before the first decision; with no health sample it is INVALID too. Exit code (strict, the default): 0 all passed, 1 a trial failed, 2 invalid evidence.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { boot } from './watch-replay.mjs';
import { finishRun, roomVerdict, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { DEFAULT_REFLEXES } from '../../coordinator/src/reflexes.mjs';
import { damageCounter, damageEvidence, deathCounter, recordDeathEvidence } from './lib/damage-counter.mjs';

const USAGE = 'Usage: test-escape-live.mjs OUT_DIR JAR [runs] [room;room...] [--strict|--descriptive] under slot.sh live';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const [outArg, jarArg, runsArg, roomsArg] = cli.filter(arg => !['--strict', '--descriptive'].includes(arg));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !jarArg || !template || !port) { console.error(USAGE); process.exit(2); }
const runs = Number(runsArg ?? 3);
const rooms = (roomsArg ?? 'deep;stair;pit;pitdig;shaft;lake;skeleton').split(';');
const THINK_MS = Number(process.env.ESCAPE_THINK_MS ?? 6_000);
const PAD_Y = 150;
const LEGACY = process.env.ESCAPE_LEGACY === 'wake' ? 'wake' : 'strong';
const WINDOW_MS = { deep: 60_000, stair: 60_000, pit: 60_000, pitdig: 60_000, shaft: 90_000, lake: 90_000, skeleton: 30_000, 'skeleton-ledge': 30_000, pitskel: 40_000, pitcreeper: 60_000, 'pitcreeper-rim': 40_000,
	'archer-direction': 15_000, 'archer-resume': 15_000 };
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
const jarPath = path.resolve(jarArg);
// The jar's own classes say which arm it is (a zip names its entries in plain bytes), never a refused call.
const arm = (await readFile(jarPath)).includes('ServerEscapeController') ? 'escape' : 'legacy';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdbsL]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const NAME = `Es${process.pid % 100000}`;
const rows = [];
let s;
try {
	s = await boot(path.join(out, 'server'), { jar: jarPath, template, port, world: null, seed: '1', spawnMonsters: false, goalTicks: 2_000_000 });
	await s.command('difficulty peaceful');
	await s.command('gamerule minecraft:advance_time false').catch(() => {});
	await s.command('time set 18000');
	// Deaths from the vanilla counter, made before the body exists: a death mid-call (lifecycle DEAD) can fall between two
	// health samples, so the lowest sampled health alone missed one.
	await s.command('scoreboard objectives add es_death deathCount').catch(() => {});
	const registered = s.inbox.wait('agent_registered', () => true, 60_000);
	await s.command('forceload add 0 0');
	await s.command(`execute positioned 0 0 0 positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${NAME}`);
	const e = await registered;
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start', 120_000);
	await s.command(`mineagen start ${NAME} Survive for 36000 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	// The survival reflexes a real game arms (both arms alike): swim up, shield, cover, retreat and the rest.
	const defaultRules = DEFAULT_REFLEXES.map(rule => ({ ...structuredClone(rule), coordinatorDefault: true }));
	const armDefaults = () => s.bridge.send('reflex_update', s.record.agentId, { revision: ++s.revision, rules: defaultRules, yield: false });
	await armDefaults();
	const pos = async () => String(await s.command(`data get entity ${NAME} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const health = async () => number(await s.command(`data get entity ${NAME} Health`));
	const airLeft = async () => number(await s.command(`data get entity ${NAME} Air`));
	const onGround = async () => /1b\s*$/.test(String(await s.command(`data get entity ${NAME} OnGround`)).trim());
	// The reader is made once (it creates the objective); each trial reads it before and after.
	const readDamage = await damageCounter(text => s.command(text), NAME, 'es_damage');
	const readDeaths = () => deathCounter(text => s.command(text), NAME, { objective: 'es_death', unsetIsZero: true }).catch(() => null);
	const blockAt = async (x, y, z, id) => /passed/i.test(String(await s.command(`execute if block ${x} ${y} ${z} ${id}`)));
	let n = 0;
	for (const room of rooms) for (let run = 0; run < runs; run++) {
		const startedAt = Date.now();
		const archer = room === 'archer-direction' || room === 'archer-resume';
		// skeleton-ledge: the skeleton room with the ground behind the wall a 5-deep drop onto lava (a guard for cover walks
		// planned over ground taken as level). It passes when the body stays alive and never drops off the pad.
		const skel = room === 'skeleton' || room === 'skeleton-ledge', ledge = room === 'skeleton-ledge';
		const X = 200 + 80 * n++, Z = 200;
		const west = archer ? 32 : 16;
		await s.command('difficulty peaceful');
		if (archer) await s.setReflexes(room === 'archer-resume' ? [
			{ id: 'hurt-bread', priority: 6, when: { type: 'health_below', value: 19 }, do: { type: 'select', item: 'minecraft:bread' }, maxFirings: 1 },
		] : []);
		await s.command(`forceload add ${X - west - 8} ${Z - 24} ${X + 24} ${Z + 24}`);
		for (let i = 0; i < 60 && !/time is/i.test(await s.command(`execute if loaded ${X} 0 ${Z} run time query gametime`)); i++) await sleep(1000);
		// A pad in the air, the same in every trial whatever the seed's terrain (an ocean there once flooded a dry hole),
		// ringed with barrier two high so no walk leaves it.
		const F = PAD_Y;
		await s.command(`fill ${X - 17} ${F - 14} ${Z - 17} ${X + 25} ${F + 8} ${Z + 17} minecraft:air`);
		await s.command(`fill ${X - west} ${F - 14} ${Z - 16} ${X + 24} ${F - 1} ${Z + 16} minecraft:stone`);
		await s.command(`fill ${X - west - 1} ${F} ${Z - 17} ${X + 25} ${F + 1} ${Z + 17} minecraft:barrier hollow`);
		await s.command(`fill ${X - west} ${F} ${Z - 16} ${X + 24} ${F + 8} ${Z + 16} minecraft:air`);
		await s.command(`kill @e[type=!minecraft:player,distance=..40,x=${X},y=${F},z=${Z}]`).catch(() => {});
		await s.command(`clear ${NAME}`);
		let start, drain = 0, facing = 90, bank = null, wall = null;
		if (room === 'deep') {
			await s.command(`fill ${X - 5} ${F - 9} ${Z - 5} ${X + 5} ${F - 1} ${Z + 5} minecraft:water`);
			start = [X + 0.5, F - 9, Z + 0.5]; drain = 3_000; bank = { x: X + 6.5, z: Z + 0.5 };
		} else if (room === 'stair') {
			for (let i = 0; i < 8; i++) await s.command(`fill ${X + i} ${F - 1 - i} ${Z} ${X + i} ${Math.min(F - 1, F + 1 - i)} ${Z} minecraft:water`);
			start = [X + 7.5, F - 8, Z + 0.5]; drain = 3_000; facing = 90; bank = { x: X - 1.5, z: Z + 0.5 };
		} else if (room === 'pitcreeper' || room === 'pitcreeper-rim') {
			// Climbing a stair out toward a creeper: the hole 4 deep with a stone pickaxe only (stairs up), a creeper on the
			// surface 7 blocks from the hole that hunts the body once it is out.
			await s.command(`fill ${X} ${F - 4} ${Z} ${X} ${F - 1} ${Z} minecraft:air`);
			start = [X + 0.5, F - 4, Z + 0.5];
			await s.command(`item replace entity ${NAME} hotbar.0 with minecraft:stone_pickaxe 1`);
		} else if (room === 'pit' || room === 'pitdig') {
			const depth = room === 'pit' ? 5 : 4;
			await s.command(`fill ${X} ${F - depth} ${Z} ${X} ${F - 1} ${Z} minecraft:air`);
			start = [X + 0.5, F - depth, Z + 0.5];
			await s.command(room === 'pit' ? `item replace entity ${NAME} hotbar.0 with minecraft:cobblestone 16` : `item replace entity ${NAME} hotbar.0 with minecraft:stone_pickaxe 1`);
		} else if (room === 'shaft') {
			await s.command(`fill ${X} ${F - 13} ${Z} ${X} ${F - 1} ${Z} minecraft:air`);
			await s.command(`fill ${X} ${F - 13} ${Z} ${X} ${F - 10} ${Z} minecraft:water`);
			start = [X + 0.5, F - 10, Z + 0.5];
			await s.command(`item replace entity ${NAME} hotbar.0 with minecraft:cobblestone 16`);
		} else if (room === 'lake') {
			await s.command(`fill ${X - 4} ${F - 13} ${Z - 4} ${X + 4} ${F - 8} ${Z + 4} minecraft:water`);
			await s.command(`fill ${X} ${F - 7} ${Z} ${X} ${F - 1} ${Z} minecraft:air`);
			start = [X + 0.5, F - 8.2, Z + 0.5];
			await s.command(`item replace entity ${NAME} hotbar.0 with minecraft:cobblestone 16`);
			await s.command(`item replace entity ${NAME} hotbar.1 with minecraft:iron_pickaxe 1`);
		} else if (room === 'pitskel') {
			// The playtest's cave death: a hole 2 deep at 7 health, blocks and a sword carried, a skeleton at the rim beside it.
			// Two cells wide: the skeleton stands in the hole beside the body, 1 block away, as in the playtest's cave.
			await s.command(`fill ${X} ${F - 2} ${Z} ${X + 1} ${F - 1} ${Z} minecraft:air`);
			start = [X + 0.5, F - 2, Z + 0.5];
			await s.command(`item replace entity ${NAME} hotbar.0 with minecraft:cobblestone 16`);
			await s.command(`item replace entity ${NAME} hotbar.1 with minecraft:stone_sword 1`);
		} else if (skel) {
			await s.command(`fill ${X - 3} ${F} ${Z - 1} ${X - 3} ${F + 2} ${Z + 1} minecraft:stone`);
			wall = { x0: X - 3, x1: X - 2, y0: F, y1: F + 3, z0: Z - 1, z1: Z + 2 };
			if (ledge) {
				await s.command(`fill ${X - 9} ${F - 5} ${Z - 6} ${X - 4} ${F - 1} ${Z + 6} minecraft:air`);
				await s.command(`fill ${X - 9} ${F - 5} ${Z - 6} ${X - 4} ${F - 5} ${Z + 6} minecraft:lava`);
			}
			await s.command(`item replace entity ${NAME} weapon.offhand with minecraft:shield 1`);
			start = [X + 0.5, F, Z + 0.5];
		} else if (archer) {
			start = [X + 0.5, F, Z + 0.5];
			if (room === 'archer-resume') await s.command(`item replace entity ${NAME} hotbar.4 with minecraft:bread 4`);
		} else throw new Error(`unknown room ${room}`);
		// Breath back in full first (a body moved from one underwater spot to the next keeps its spent air).
		await s.command(`tp ${NAME} ${X + 0.5} ${F} ${Z - 10.5} ${facing} 0`); await sleep(5000);
		await s.command(`tp ${NAME} ${start[0]} ${start[1]} ${start[2]} ${facing} 0`);
		await s.command(`effect give ${NAME} minecraft:instant_health 1 10 true`);
		if (archer) {
			await s.command('difficulty normal');
			await s.command(`summon minecraft:skeleton ${X + 10.5} ${F} ${Z + 0.5} {NoAI:1b,PersistenceRequired:1b,equipment:{mainhand:{id:"minecraft:bow",count:1},head:{id:"minecraft:leather_helmet",count:1}}}`);
			if (room === 'archer-direction') await s.command(`summon minecraft:zombie ${X - 3.5} ${F} ${Z + 1.5} {NoAI:1b,PersistenceRequired:1b}`);
			await sleep(500);
			const deathsBefore = await readDeaths();
			const t0 = Date.now();
			const escape = s.act('escape', { timeoutMs: WINDOW_MS[room] }).catch(error => ({ state: 'ERROR', message: error.message }));
			let firstDx = null, hit = false;
			// The cover search looks around on the spot. The first movement comes from the sprint.
			while (Date.now() - t0 < 5000 && firstDx === null) {
				const p = await pos();
				if (p && Math.abs(p[0] - start[0]) >= 1) {
					firstDx = p[0] - start[0];
					if (room === 'archer-resume' && firstDx < 0 && firstDx > -6) {
						await s.command(`damage ${NAME} 4 minecraft:generic`);
						hit = true;
					}
				}
				await sleep(50);
			}
			const result = await escape;
			const message = String(result.message ?? '');
			const paused = /paused 1 time\(s\) by reflex hurt-bread.*resumed 1 time/.test(message);
			const coverSearches = (message.match(/cover from skeleton failed/g) ?? []).length;
			const row = { room, run, firstDx, hit, paused, coverSearches, result: result.state, message, startedAt, finishedAt: Date.now() };
			row.deathEvidence = recordDeathEvidence(row, deathsBefore, await readDeaths());
			if (arm !== 'escape' || firstDx === null || !coverSearches || (room === 'archer-resume' && (!hit || !paused))) {
				row.notExercised = 'the fallback sprint or its requested reflex pause did not run';
			}
			row.pass = row.deaths === 0 && result.state === 'SUCCEEDED' && (room === 'archer-direction' ? firstDx < 0 : coverSearches === 1);
			row.failReason = room === 'archer-direction' ? 'the escape did not clear the shooter after running away from it' : 'the run did not resume directly after the reflex';
			rows.push(row);
			console.log(`[${room} ${run}] ${roomVerdict(row).verdict} ${JSON.stringify(row)}`);
			await armDefaults();
			continue;
		}
		let skeleton = null, skeletonOnServer = false, exposedAtStart = false, startSnapshot = null;
		// The room's line of sight past its one wall, as hidden() below, for the check right after the summon.
		const hiddenNow = async () => {
			const text = String(await s.command('data get entity @e[type=minecraft:skeleton,limit=1,sort=nearest] Pos').catch(() => ''));
			const e = text.match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number);
			const body = await pos();
			if (!e || !body || !wall) return false;
			const from = [e[0], e[1] + 1.74, e[2]], to = [body[0], body[1] + 1.62, body[2]];
			for (let t = 0; t <= 1; t += 0.02) {
				const [px, py, pz] = from.map((value, i) => value + (to[i] - value) * t);
				if (px >= wall.x0 && px < wall.x1 && py >= wall.y0 && py < wall.y1 && pz >= wall.z0 && pz < wall.z1) return true;
			}
			return false;
		};
		if (room === 'pitcreeper' || room === 'pitcreeper-rim') {
			await s.command('difficulty normal');
			// -rim: a creeper standing still on the rim beside the hole, where nothing in the hole can reach it.
			await s.command(room === 'pitcreeper' ? `summon minecraft:creeper ${X + 7.5} ${F} ${Z + 0.5} {PersistenceRequired:1b}`
				: `summon minecraft:creeper ${X + 1.5} ${F} ${Z + 0.5} {PersistenceRequired:1b,NoAI:1b}`);
			await sleep(500);
		}
		if (room === 'pitskel') {
			await s.command('difficulty normal');
			await s.command(`damage ${NAME} 13 minecraft:generic`);
			await s.command(`summon minecraft:skeleton ${X + 1.5} ${F - 2} ${Z + 0.5} {PersistenceRequired:1b,equipment:{mainhand:{id:"minecraft:bow",count:1},head:{id:"minecraft:leather_helmet",count:1}}}`);
			await sleep(500);
		}
		if (skel) {
			// A leather helmet keeps the skeleton from burning in daylight.
			await s.command('difficulty normal');
			await s.command(`summon minecraft:skeleton ${X + 10.5} ${F} ${Z + 0.5} {PersistenceRequired:1b,equipment:{mainhand:{id:"minecraft:bow",count:1},head:{id:"minecraft:leather_helmet",count:1}}}`);
			await sleep(1500);
			skeleton = (await s.observe()).entities?.find(entity => entity.type === 'minecraft:skeleton' && entity.alive !== false) ?? null;
			// The skeleton is behind the body (it faces the wall), so it is often not in the body's view: confirm it on the
			// server. Exposure is judged now, before the default reflexes armed above can take cover on their own during the
			// settle below (that read as "no skeleton in sight at the start": 48 of 188 trials INVALID on 22 Nov).
			skeletonOnServer = /passed/i.test(String(await s.command('execute if entity @e[type=minecraft:skeleton]').catch(() => '')));
			exposedAtStart = skeletonOnServer && !(await hiddenNow());
			// Both positions as the exposure check saw them, for the trial's record.
			startSnapshot = { body: await pos(), skeleton: String(await s.command('data get entity @e[type=minecraft:skeleton,limit=1,sort=nearest] Pos').catch(() => ''))
				.match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null, exposed: exposedAtStart };
			// The legacy arm names the skeleton in flee_from: take its UUID from the server when the body's view lacks it.
			if (!skeleton && skeletonOnServer) {
				const ints = String(await s.command('data get entity @e[type=minecraft:skeleton,limit=1] UUID').catch(() => '')).match(/\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/);
				if (ints) {
					const hex = ints.slice(1).map(v => (Number(v) >>> 0).toString(16).padStart(8, '0')).join('');
					skeleton = { uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
				}
			}
		}
		await sleep(1000 + drain);
		const before = await health(), airBefore = await airLeft();
		// The vanilla damage counter: regeneration between hits cannot hide damage the way lowest health does.
		const damageBefore = await readDamage().catch(() => null);
		const deathsBefore = await readDeaths();
		if (!Number.isFinite(before)) throw new Error(`${room} ${run}: health unreadable before the room`);
		const coverLog = [];
		let minY = Infinity, minHealth = before, minAir = airBefore, sampling = true, hiddenSamples = 0, samples = 0, healthSamples = 0;
		const skeletonEye = async () => {
			const text = String(await s.command('data get entity @e[type=minecraft:skeleton,limit=1,sort=nearest] Pos').catch(() => ''));
			const p = text.match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number);
			return p ? [p[0], p[1] + 1.74, p[2]] : null;
		};
		// Line of sight past the one wall the room built (the pad is flat): any sample point inside the wall hides the body.
		const hidden = async () => {
			const from = await skeletonEye(), body = await pos();
			if (!from || !body || !wall) return false;
			const to = [body[0], body[1] + 1.62, body[2]];
			for (let t = 0; t <= 1; t += 0.02) {
				const [px, py, pz] = from.map((value, i) => value + (to[i] - value) * t);
				if (px >= wall.x0 && px < wall.x1 && py >= wall.y0 && py < wall.y1 && pz >= wall.z0 && pz < wall.z1) return true;
			}
			return false;
		};
		const sampler = (async () => { while (sampling) {
			const h = await health().catch(() => NaN), a = await airLeft().catch(() => NaN);
			if (Number.isFinite(h)) { minHealth = Math.min(minHealth, h); healthSamples++; }
			if (Number.isFinite(a)) minAir = Math.min(minAir, a);
			if (ledge) { const here = await pos().catch(() => null); if (here) minY = Math.min(minY, here[1]); }
			if (skel) { samples++; const covered = await hidden().catch(() => false); if (covered) hiddenSamples++; coverLog.push({ at: Date.now(), covered }); }
			await sleep(250);
		} })();
		const safe = async () => {
			const p = await pos();
			if (!p) return false;
			if (room === 'deep' || room === 'stair') {
				const feet = [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])];
				return await onGround() && !(await blockAt(...feet, 'minecraft:water')) && p[1] >= F - 0.01;
			}
			if (room === 'pit' || room === 'pitdig' || room === 'shaft' || room === 'pitcreeper' || room === 'pitcreeper-rim') return p[1] >= F - 0.01 && await onGround();
			// Out of the hole, or the skeleton beside it dead.
			if (room === 'pitskel') return p[1] >= F - 0.01 && await onGround()
				|| !String(await s.command('execute if entity @e[type=minecraft:skeleton]').catch(() => 'passed')).includes('passed');
			if (room === 'lake') return await onGround() && !(await blockAt(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]), 'minecraft:water'));
			return hidden();
		};
		const live = await pos();
		const exposed = live === null ? false : room === 'deep' || room === 'stair' ? await blockAt(Math.floor(live[0]), Math.floor(live[1] + 1.62), Math.floor(live[2]), 'minecraft:water')
			: skel ? exposedAtStart
			: room === 'shaft' || room === 'lake' ? await blockAt(Math.floor(live[0]), Math.floor(live[1]), Math.floor(live[2]), 'minecraft:water')
			: room === 'pitskel' ? live[1] < F - 1 : live[1] < F - 2;
		// pitcreeper judges the climb on survival and damage too: climbing on must not trade a stop for a blast.
		const t0 = Date.now(), window = WINDOW_MS[room];
		let calls = 0, executed = 0, last = null, safeAt = null;
		const results = [];
		while (Date.now() - t0 < window) {
			if (await safe()) { safeAt ??= Date.now() - t0; if (!skel) break; await sleep(500); continue; }
			safeAt = skel ? null : safeAt;
			await sleep(THINK_MS);
			if (Date.now() - t0 >= window) break;
			if (await safe()) continue;
			const left = Math.max(5_000, window - (Date.now() - t0));
			const p = await pos();
			let call;
			if (arm === 'escape') call = ['escape', { timeoutMs: Math.min(60_000, left) }];
			else if (room === 'deep' || room === 'stair') {
				const under = await blockAt(Math.floor(p[0]), Math.floor(p[1] + 1.62), Math.floor(p[2]), 'minecraft:water');
				call = under && LEGACY === 'wake' ? ['control', { forward: 0, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false, yaw: facing, pitch: -45, selectedSlot: 0, hand: 'main', ticks: 40 }]
					: ['travel_to', { x: bank.x, z: bank.z, tolerance: 1, timeoutMs: Math.min(30_000, left) }];
			} else if (room === 'pit') call = ['build', { structure: 'pillar', size: LEGACY === 'wake' ? 1 : Math.max(1, F - Math.floor(p[1])), timeoutMs: Math.min(30_000, left) }];
			else if (room === 'lake' && LEGACY === 'wake') call = ['control', { forward: 0, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false, yaw: facing, pitch: -45, selectedSlot: 0, hand: 'main', ticks: 40 }];
			else if (room === 'lake') call = ['dig_to', { pattern: 'stairs_up', y: F, heading: 'east', timeoutMs: Math.min(60_000, left) }];
			else if (room === 'shaft') call = LEGACY === 'wake' ? ['control', { forward: 0, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false, yaw: facing, pitch: -45, selectedSlot: 0, hand: 'main', ticks: 40 }]
				: ['build', { structure: 'pillar', size: Math.max(1, F - Math.floor(p[1])), timeoutMs: Math.min(30_000, left) }];
			else if (room === 'pitdig' || room === 'pitcreeper' || room === 'pitcreeper-rim') call = ['dig_to', { pattern: 'stairs_up', y: F, heading: 'east', timeoutMs: Math.min(60_000, left) }];
			else if (room === 'pitskel') call = ['build', { structure: 'pillar', size: Math.max(1, F - Math.floor(p[1])), timeoutMs: Math.min(30_000, left) }];
			else if (skeleton?.uuid) call = ['flee_from', { targetId: skeleton.uuid, distance: 16, timeoutMs: Math.min(10_000, left) }];
			else { results.push('legacy:no skeleton to name'); break; }
			calls++;
			last = await s.act(call[0], call[1], left + 10_000).catch(error => ({ state: 'ERROR', reasonCode: error.message }));
			results.push(`${call[0]}:${last.state}:${last.reasonCode}`);
			// A call the body ran (not refused at the gate): only these can be credited with a save.
			if (last.state !== 'ERROR' && last.executionStarted !== false && !/^INVALID|^UNKNOWN_ACTION/.test(String(last.reasonCode ?? ''))) executed++;
			if (last.state === 'ERROR') break;
			if ((await health().catch(() => NaN)) <= 0) break;
		}
		if (skel) await sleep(Math.max(0, window - (Date.now() - t0)));
		// Safe has to hold: two seconds on, the body is still out (not slid back into the water or the hole).
		let endSafe = null;
		if (!skel && safeAt !== null) { endSafe = true; for (let i = 0; i < 4 && endSafe; i++) { await sleep(500); endSafe = await safe(); } }
		// The skeleton room ends in cover: behind the wall for every sample of the window's last 2 s, not only blocking in
		// the open behind a shield.
		if (skel) {
			const tail = coverLog.filter(row => row.at >= t0 + window - 2000 && row.at <= t0 + window);
			endSafe = tail.length >= 4 && tail.every(row => row.covered);
		}
		sampling = false; await sampler;
		const end = await pos();
		const damage = damageEvidence(damageBefore, await readDamage().catch(() => null), before, await health().catch(() => NaN));
		const row = { room, arm: arm === 'legacy' ? `legacy-${LEGACY}` : arm, run, calls, executed, endSafe, safeSeconds: safeAt === null ? null : Math.round(safeAt / 100) / 10, seconds: Math.round((Date.now() - t0) / 100) / 10,
			healthLost: Math.round(Math.max(0, before - minHealth) * 10) / 10, damageTaken: damage.damageTaken,
			...(damage.integrity ? { integrity: damage.integrity } : {}), airBefore, minAir,
			hiddenShare: skel && samples > 0 ? Math.round(hiddenSamples / samples * 100) / 100 : undefined,
			endDy: end ? Math.round((end[1] - F) * 10) / 10 : null, results, state: last?.state ?? null, reasonCode: last?.reasonCode ?? null,
			message: String(last?.message ?? '').slice(0, 300), startedAt, finishedAt: Date.now() };
		row.deathEvidence = recordDeathEvidence(row, deathsBefore, await readDeaths());
		const sawDeath = minHealth <= 0 || row.deaths > 0 || /Lifecycle changed to DEAD/.test(String(last?.message ?? ''));
		const died = row.died = sawDeath ? true : row.deathEvidence.valid ? false : null;
		if (skel) row.start = { ...(startSnapshot ?? {}), skeletonSeen: skeleton !== null, wall };
		if (!exposed) row.notExercised = skel ? 'no skeleton in sight at the start' : 'the live body did not start in danger';
		// The skeleton room's verdict is cover at the end, however the body got there: reflexes taking cover before the
		// first decision is the bot doing right, not missing evidence.
		else if (executed === 0 && safeAt !== null && !skel) row.notExercised = calls === 0 ? 'safe before the first decision (reflexes alone)' : 'safe with no call the body ran';
		if (healthSamples === 0) row.error = 'no health sample in the window';
		if (last?.state === 'ERROR') row.error = `call never returned: ${last.reasonCode}`;
		// pitcreeper-rim: no escape call may sit out its whole timeout guarding a creeper it cannot reach.
		if (room === 'pitcreeper-rim') {
			row.pass = died === false && !results.some(r => r.startsWith('escape:TIMED_OUT'));
			if (!row.pass) row.failReason = died ? 'died' : 'an escape call ran to its deadline';
			// No escape call the body ran: the room tested nothing (a long ESCAPE_THINK_MS can eat the window).
			if (!results.some(r => r.startsWith('escape:')) || executed === 0) row.notExercised = 'no escape call ran in the window';
		}
		else row.pass = died === false && (skel ? (row.damageTaken ?? Infinity) <= 6 && endSafe === true : safeAt !== null && endSafe === true);
		if (ledge && exposed) {
			row.minDy = Number.isFinite(minY) ? Math.round((minY - F) * 10) / 10 : null;
			row.pass = died === false && row.minDy !== null && row.minDy >= -1;
			row.failReason = row.pass ? undefined : died ? 'died' : row.minDy === null ? 'no position sample' : 'dropped off the pad behind the wall';
		}
		if (!row.pass && room !== 'pitcreeper-rim' && !ledge) row.failReason = died ? 'died' : skel ? (endSafe !== true ? 'not in cover at the end' : `took ${row.damageTaken} damage`) : safeAt === null ? 'not safe within the window' : 'safe, then back in danger';
		rows.push(row);
		console.log(`[${room} ${row.arm} ${run}] ${roomVerdict(row).verdict} calls=${calls} safe=${row.safeSeconds}s hpLost=${row.healthLost}${died ? ' DIED' : ''} air ${airBefore}->${minAir}${row.hiddenShare !== undefined ? ` hidden=${row.hiddenShare}` : ''} | ${results.join(' ')} | ${row.message.slice(0, 160)}`);
		await s.command(`kill @e[type=minecraft:skeleton]`).catch(() => {});
		await s.command(`kill @e[type=minecraft:creeper]`).catch(() => {});
		if (died) {
			// Back on its feet before the next room: the next room's first read failed when it came too soon after a respawn.
			await s.command(`mineagen respawn ${NAME}`).catch(() => {});
			for (let i = 0; i < 30; i++) { await sleep(1000); const o = await s.observe().catch(() => null); if (o && o.player?.dead !== true && Number.isFinite(await health().catch(() => NaN))) break; }
		}
	}
} catch (error) {
	rows.push({ room: 'harness', error: String(error?.stack ?? error).slice(0, 1200) });
	console.log(`[escape] ERROR ${String(error?.message ?? error).split('\n')[0]}`);
} finally {
	try { await s?.stop(); } catch (error) { rows.push({ room: 'cleanup', error: String(error?.message ?? error) }); }
}
const report = await finishRun(rows, { file: path.join(out, 'result.json'), planned: rooms.length * runs, strict });
console.log(JSON.stringify(report));
process.exit(report.exitCode);
