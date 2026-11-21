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
// The arm is read from the jar: a jar with the escape body job plays "escape" (every decision is do_step escape); any
// other jar plays "legacy", fixed in advance (a stand-in, not a model). ESCAPE_LEGACY=strong (the default) gives it the
// strongest single old call, handed the room's geometry: water rooms travel_to the bank, pit build pillar of the hole's
// depth, pitdig dig_to stairs_up to the rim, skeleton flee_from 16 blocks. ESCAPE_LEGACY=wake plays what the old wake text
// prescribed by hand: under water a raw control frame holding jump for 2 s ("hold jump to refill"), else travel_to the
// bank; pit one pillar block per decision.
// A trial passes: water rooms on dry footing out of the water, pit rooms standing at or above the rim, both alive in the
// window and still safe 2 s later; skeleton alive with at most 6 health lost over its 30 s window. Reports per trial:
// pass, decisions, seconds to safe, health lost, death, the results. A room is INVALID (notExercised) when the live body
// did not start in danger (eyes not under water, not in the hole, no skeleton in sight) or reflexes alone made it safe
// before the first decision; with no health sample it is INVALID too. Exit code (strict, the default): 0 all passed, 1 a trial failed, 2 invalid evidence.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { boot } from './watch-replay.mjs';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { DEFAULT_REFLEXES } from '../../coordinator/src/reflexes.mjs';

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
const WINDOW_MS = { deep: 60_000, stair: 60_000, pit: 60_000, pitdig: 60_000, shaft: 90_000, lake: 90_000, skeleton: 30_000 };
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
	await s.bridge.send('reflex_update', s.record.agentId, { revision: 1, rules: DEFAULT_REFLEXES.map(rule => ({ ...structuredClone(rule), coordinatorDefault: true })), yield: false });
	const pos = async () => String(await s.command(`data get entity ${NAME} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const health = async () => number(await s.command(`data get entity ${NAME} Health`));
	const airLeft = async () => number(await s.command(`data get entity ${NAME} Air`));
	const onGround = async () => /1b\s*$/.test(String(await s.command(`data get entity ${NAME} OnGround`)).trim());
	const blockAt = async (x, y, z, id) => /passed/i.test(String(await s.command(`execute if block ${x} ${y} ${z} ${id}`)));
	let n = 0;
	for (const room of rooms) for (let run = 0; run < runs; run++) {
		const startedAt = Date.now();
		const X = 200 + 80 * n++, Z = 200;
		await s.command('difficulty peaceful');
		await s.command(`forceload add ${X - 24} ${Z - 24} ${X + 24} ${Z + 24}`);
		for (let i = 0; i < 60 && !/time is/i.test(await s.command(`execute if loaded ${X} 0 ${Z} run time query gametime`)); i++) await sleep(1000);
		// A pad in the air, the same in every trial whatever the seed's terrain (an ocean there once flooded a dry hole),
		// ringed with barrier two high so no walk leaves it.
		const F = PAD_Y;
		await s.command(`fill ${X - 17} ${F - 14} ${Z - 17} ${X + 25} ${F + 8} ${Z + 17} minecraft:air`);
		await s.command(`fill ${X - 16} ${F - 14} ${Z - 16} ${X + 24} ${F - 1} ${Z + 16} minecraft:stone`);
		await s.command(`fill ${X - 17} ${F} ${Z - 17} ${X + 25} ${F + 1} ${Z + 17} minecraft:barrier hollow`);
		await s.command(`fill ${X - 16} ${F} ${Z - 16} ${X + 24} ${F + 8} ${Z + 16} minecraft:air`);
		await s.command(`kill @e[type=!minecraft:player,distance=..40,x=${X},y=${F},z=${Z}]`).catch(() => {});
		await s.command(`clear ${NAME}`);
		let start, drain = 0, facing = 90, bank = null, wall = null;
		if (room === 'deep') {
			await s.command(`fill ${X - 5} ${F - 9} ${Z - 5} ${X + 5} ${F - 1} ${Z + 5} minecraft:water`);
			start = [X + 0.5, F - 9, Z + 0.5]; drain = 3_000; bank = { x: X + 6.5, z: Z + 0.5 };
		} else if (room === 'stair') {
			for (let i = 0; i < 8; i++) await s.command(`fill ${X + i} ${F - 1 - i} ${Z} ${X + i} ${Math.min(F - 1, F + 1 - i)} ${Z} minecraft:water`);
			start = [X + 7.5, F - 8, Z + 0.5]; drain = 3_000; facing = 90; bank = { x: X - 1.5, z: Z + 0.5 };
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
		} else if (room === 'skeleton') {
			await s.command(`fill ${X - 3} ${F} ${Z - 1} ${X - 3} ${F + 2} ${Z + 1} minecraft:stone`);
			wall = { x0: X - 3, x1: X - 2, y0: F, y1: F + 3, z0: Z - 1, z1: Z + 2 };
			await s.command(`item replace entity ${NAME} weapon.offhand with minecraft:shield 1`);
			start = [X + 0.5, F, Z + 0.5];
		} else throw new Error(`unknown room ${room}`);
		// Breath back in full first (a body moved from one underwater spot to the next keeps its spent air).
		await s.command(`tp ${NAME} ${X + 0.5} ${F} ${Z - 10.5} ${facing} 0`); await sleep(5000);
		await s.command(`tp ${NAME} ${start[0]} ${start[1]} ${start[2]} ${facing} 0`);
		await s.command(`effect give ${NAME} minecraft:instant_health 1 10 true`);
		let skeleton = null;
		if (room === 'skeleton') {
			await s.command('difficulty normal');
			await s.command(`summon minecraft:skeleton ${X + 10.5} ${F} ${Z + 0.5} {PersistenceRequired:1b,equipment:{mainhand:{id:"minecraft:bow",count:1}}}`);
			await sleep(1500);
			skeleton = (await s.observe()).entities?.find(entity => entity.type === 'minecraft:skeleton' && entity.alive !== false) ?? null;
		}
		await sleep(1000 + drain);
		const before = await health(), airBefore = await airLeft();
		if (!Number.isFinite(before)) throw new Error(`${room} ${run}: health unreadable before the room`);
		let minHealth = before, minAir = airBefore, sampling = true, hiddenSamples = 0, samples = 0, healthSamples = 0;
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
			if (room === 'skeleton') { samples++; if (await hidden().catch(() => false)) hiddenSamples++; }
			await sleep(250);
		} })();
		const safe = async () => {
			const p = await pos();
			if (!p) return false;
			if (room === 'deep' || room === 'stair') {
				const feet = [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])];
				return await onGround() && !(await blockAt(...feet, 'minecraft:water')) && p[1] >= F - 0.01;
			}
			if (room === 'pit' || room === 'pitdig' || room === 'shaft') return p[1] >= F - 0.01 && await onGround();
			if (room === 'lake') return await onGround() && !(await blockAt(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]), 'minecraft:water'));
			return hidden();
		};
		const live = await pos();
		const exposed = live === null ? false : room === 'deep' || room === 'stair' ? await blockAt(Math.floor(live[0]), Math.floor(live[1] + 1.62), Math.floor(live[2]), 'minecraft:water')
			: room === 'skeleton' ? skeleton !== null && !(await hidden())
			: room === 'shaft' || room === 'lake' ? await blockAt(Math.floor(live[0]), Math.floor(live[1]), Math.floor(live[2]), 'minecraft:water') : live[1] < F - 2;
		const t0 = Date.now(), window = WINDOW_MS[room];
		let calls = 0, last = null, safeAt = null;
		const results = [];
		while (Date.now() - t0 < window) {
			if (await safe()) { safeAt ??= Date.now() - t0; if (room !== 'skeleton' || calls === 0) break; await sleep(500); continue; }
			safeAt = room === 'skeleton' ? null : safeAt;
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
			else if (room === 'lake') call = ['dig_to', { pattern: 'stairs_up', y: F, heading: 'east', timeoutMs: Math.min(60_000, left) }];
			else if (room === 'shaft') call = LEGACY === 'wake' ? ['control', { forward: 0, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false, yaw: facing, pitch: -45, selectedSlot: 0, hand: 'main', ticks: 40 }]
				: ['build', { structure: 'pillar', size: Math.max(1, F - Math.floor(p[1])), timeoutMs: Math.min(30_000, left) }];
			else if (room === 'pitdig') call = ['dig_to', { pattern: 'stairs_up', y: F, heading: 'east', timeoutMs: Math.min(60_000, left) }];
			else call = ['flee_from', { targetId: skeleton.uuid, distance: 16, timeoutMs: Math.min(10_000, left) }];
			calls++;
			last = await s.act(call[0], call[1], left + 10_000).catch(error => ({ state: 'ERROR', reasonCode: error.message }));
			results.push(`${call[0]}:${last.state}:${last.reasonCode}`);
			if (last.state === 'ERROR') break;
			if ((await health().catch(() => NaN)) <= 0) break;
		}
		if (room === 'skeleton' && calls > 0) await sleep(Math.max(0, window - (Date.now() - t0)));
		// Safe has to hold: two seconds on, the body is still out (not slid back into the water or the hole).
		let endSafe = null;
		if (room !== 'skeleton' && safeAt !== null) { await sleep(2000); endSafe = await safe(); }
		sampling = false; await sampler;
		const end = await pos();
		const died = minHealth <= 0;
		const row = { room, arm: arm === 'legacy' ? `legacy-${LEGACY}` : arm, run, calls, endSafe, safeSeconds: safeAt === null ? null : Math.round(safeAt / 100) / 10, seconds: Math.round((Date.now() - t0) / 100) / 10,
			healthLost: Math.round(Math.max(0, before - minHealth) * 10) / 10, died, airBefore, minAir,
			hiddenShare: room === 'skeleton' && samples > 0 ? Math.round(hiddenSamples / samples * 100) / 100 : undefined,
			endDy: end ? Math.round((end[1] - F) * 10) / 10 : null, results, state: last?.state ?? null, reasonCode: last?.reasonCode ?? null,
			message: String(last?.message ?? '').slice(0, 300), startedAt, finishedAt: Date.now() };
		if (!exposed) row.notExercised = room === 'skeleton' ? 'no skeleton in sight at the start' : 'the live body did not start in danger';
		else if (calls === 0 && safeAt !== null) row.notExercised = 'safe before the first decision (reflexes alone)';
		if (healthSamples === 0) row.error = 'no health sample in the window';
		if (last?.state === 'ERROR') row.error = `call never returned: ${last.reasonCode}`;
		row.pass = !died && (room === 'skeleton' ? row.healthLost <= 6 : safeAt !== null && endSafe === true);
		if (!row.pass) row.failReason = died ? 'died' : room === 'skeleton' ? `lost ${row.healthLost} health` : safeAt === null ? 'not safe within the window' : 'safe, then back in danger';
		rows.push(row);
		console.log(`[${room} ${row.arm} ${run}] ${row.pass ? 'PASS' : 'FAIL'} calls=${calls} safe=${row.safeSeconds}s hpLost=${row.healthLost}${died ? ' DIED' : ''} air ${airBefore}->${minAir}${row.hiddenShare !== undefined ? ` hidden=${row.hiddenShare}` : ''} | ${results.join(' ')} | ${row.message.slice(0, 160)}`);
		if (died) { await s.command(`mineagen respawn ${NAME}`).catch(() => {}); await sleep(3000); }
		await s.command(`kill @e[type=minecraft:skeleton]`).catch(() => {});
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
