// Provider-free End breath room (late-game wall, order 12): node scripts/quality/test-end-breath-live.mjs OUT_DIR [JAR] [--old]
// One server. The body stands on a 25x25 end-stone island in the End's void, far from the main island (no dragon). The
// real coordinator path arms the reflexes: NativeToolRuntime with the production ReflexBook, fed the wire adapter's live
// samples, so entering the End arms its defaults as in a game. Each run tops health up, places the body, and drops a
// real dragon fireball (vanilla's cloud: Instant Damage II, radius 3 growing to 7) on or beside it; some runs then send a
// model command (travel_to into the cloud) through runtime.execute, the path a model's command takes. Pass per run:
// alive after 12 s, no fall into the void. No model call is made.
// --old: the base arm, no End defaults (the coordinator before this change had none); run it with that commit's jar.
// --old-rule: the base arm plus the same breath rule installed as a model rule (what a model could install itself).
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME. REPEATS=n plays every room n times.
// FIXTURE_TICK_RATE runs each room's window faster: placement stays at 20 TPS, and from the fireball's summon the cloud
// wait, the 12 s window, the command's 400 ms delay and the trail are game time (s.clock), as is the reflex book. Rows
// record row.rates, row.gameSeconds and row.wallSeconds.
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeToolRuntime } from '../../coordinator/src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../../coordinator/src/native-minecraft-tools.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { ReflexBook, normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';
import { warmBoots } from './fixture-servers.mjs';
import { fixtureTickRate } from './watch-replay.mjs';
import { gameClockFromObservations } from '../../coordinator/src/game-clock.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { damageCounter, damageEvidence, deathCounter, deathEvidence } from './lib/damage-counter.mjs';
import { finishRun, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log('Usage: test-end-breath-live.mjs OUT_DIR [JAR] [--old|--old-rule] [--descriptive]\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const OLD = cli.includes('--old') || cli.includes('--old-rule'), OLD_RULE = cli.includes('--old-rule');
const [outArg, jarArg] = cli.filter(arg => !arg.startsWith('--'));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !template || !port || !process.env.JAVA_HOME) { console.error('Usage: OUT_DIR [JAR] [--old|--old-rule] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME'); process.exit(2); }
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Breath';
// The island: x -12..12, z 288..312, top at y 59 (feet at 60). The void lies past every rim. A breath cloud grows to
// radius 7 in 30 s, so a 13x13 island is all cloud by then; 25 wide leaves the way out a player would have.
const CX = 0, CZ = 300, TOP = 59, HALF = 12;
const end = (s, text) => s.command(`execute in minecraft:the_end run ${text}`);
// Rooms: the body's cell and where the fireball lands, relative to the island centre. command: a model command sent
// 0.4 s after the cloud forms, walking into the cloud's centre (the 02c13 shape).
const ROOMS = [
	{ name: 'centre-on-body', body: [0, 0], ball: [0, 0] },
	{ name: 'centre-beside', body: [0, 0], ball: [-2, 0] },
	{ name: 'east-rim-on-body', body: [11, 0], ball: [11, 0] },
	{ name: 'corner-on-body', body: [11, 11], ball: [11, 11] },
	{ name: 'rim-cloud-inland', body: [11, 0], ball: [8, 0] },
	{ name: 'command-into-cloud', body: [0, 0], ball: [0, 0], command: true },
	{ name: 'rim-command-into-cloud', body: [11, -3], ball: [10, -3], command: true },
];
const repeats = Math.max(1, Number(process.env.REPEATS ?? 1));
// A vanilla breath cloud starts at radius 3; default-breath fires within 2 of it.
const CLOUD_REACH = 5;
const runs = Array.from({ length: repeats }, () => ROOMS).flat();
const results = { arm: OLD_RULE ? 'old+model-rule' : OLD ? 'old' : 'new', jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), runs: [] };

for await (const { server: s, error: bootError } of warmBoots([{ name: 'breath' }], () => ({ dir: path.join(out, 'server-0'),
	options: { jar: results.jar, template, port, world: null, seed: '20261017', spawnMonsters: false, worldCache: true, tickRate: fixtureTickRate() } }))) {
	try {
		if (!s) throw bootError;
		await s.command('time set noon');
		await s.command('forceload add -16 -16 16 16');
		await sleep(1500);
		const registered = s.inbox.wait('agent_registered', () => true, 45000);
		await s.command(`execute positioned 0 0 0 positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${AGENT}`);
		const e = await registered;
		s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start', 120_000);
		await s.command(`mineagen start ${AGENT} Survive for 1200 seconds.`);
		s.record.goalRevision = (await started).payload.goalRevision;
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		await s.command(`gamemode survival ${AGENT}`);
		await s.command(`effect give ${AGENT} minecraft:saturation 1200 4 true`);
		const fast = s.clock.rate !== 20;
		const book = new ReflexBook({ ...(OLD ? { dimensionDefaults: {} } : {}), ...(fast ? { now: () => s.clock.now() } : {}) });
		const commands = new Set();
		const record = { ...s.record, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
		const runtime = new NativeToolRuntime({
			bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') commands.add(payload.actionId); return s.bridge.send(type, agentId, payload); } },
			requestObservation: async () => { const payload = await s.observe(); return { eventSequence: payload.eventSequence, observation: adaptObservation(payload) }; },
			inspectObservation: async () => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', survey: {} }),
			reflexBook: book,
			...(fast ? { clock: gameClockFromObservations({ tickRate: s.clock.rate }) } : {}),
		});
		let latest = null;
		s.bridge.on('observation', ev => {
			if (ev.agentId !== record.agentId || !ev.payload.ready) return;
			latest = ev.payload;
			runtime.updateObservation(record, adaptObservation(ev.payload), { eventSequence: ev.payload.eventSequence });
		});
		s.bridge.on('action_result', ev => {
			if (ev.agentId !== record.agentId || !commands.has(ev.payload.actionId)) return;
			runtime.onActionResult(record, ev.payload);
			s.bridge.send('action_result_ack', record.agentId, { goalRevision: record.goalRevision, actionId: ev.payload.actionId }).catch(() => {});
		});
		await s.observe();
		// The End island, far south of the main island.
		await end(s, `forceload add ${CX - 32} ${CZ - 32} ${CX + 32} ${CZ + 32}`); await sleep(1500);
		await end(s, 'kill @e[type=minecraft:ender_dragon]');
		const build = async () => {
			await end(s, `fill ${CX - 20} ${TOP - 4} ${CZ - 20} ${CX + 20} ${TOP + 8} ${CZ + 20} minecraft:air`);
			await end(s, `fill ${CX - HALF} ${TOP} ${CZ - HALF} ${CX + HALF} ${TOP} ${CZ + HALF} minecraft:end_stone`);
		};
		await build();
		await end(s, `tp ${AGENT} ${CX + 0.5} ${TOP + 1} ${CZ + 0.5}`);
		// Entering the End arms its defaults through the runtime's ReflexBook (observeContext on the live sample).
		const armedWanted = OLD ? 15 : 17;
		for (let wait = 0; wait < 60; wait++) { await s.observe(); if ((latest?.reflexes?.rules ?? []).length >= armedWanted && latest?.world?.dimension === 'minecraft:the_end') break; await sleep(250); }
		if (OLD_RULE) {
			book.apply(record.agentId, normalizeReflexEntries([{ id: 'end-breath', priority: 9, when: { type: 'cloud_near', within: 2 }, do: { type: 'sprint_away', blocks: 10 }, maxS: 6, ttlS: 3600 }]));
			for (let wait = 0; wait < 20 && !(latest?.reflexes?.rules ?? []).some(rule => rule.id === 'end-breath'); wait++) { await s.observe(); await sleep(250); }
		}
		results.armed = (latest?.reflexes?.rules ?? []).map(rule => rule.id);
		console.log(`[breath] ${results.arm}: armed ${results.armed.join(',')}`);
		const readDamage = await damageCounter(text => s.command(text), AGENT);
		// Deaths come from a deathCount objective this fixture owns; an unreadable count is invalid evidence.
		await s.command('scoreboard objectives add qo_death deathCount');
		await s.command(`scoreboard players set ${AGENT} qo_death 0`);
		const readDeaths = () => deathCounter(text => s.command(text), AGENT);
		// The breath rule's own fired count (the mod's status row): a room counts only if it rose there.
		const breathId = OLD_RULE ? 'end-breath' : 'default-breath';
		const firedCount = async () => ((await s.observe()).reflexes?.rules ?? []).find(rule => rule.id === breathId)?.fired ?? null;
		const pos = async () => { const o = await s.observe(); return { x: o.position?.x, y: o.position?.y, z: o.position?.z, dead: o.player?.dead === true || o.status === 'PLAYER_DEAD', health: o.player?.health }; };
		const armedBreath = !OLD || OLD_RULE;
		for (const [index, room] of runs.entries()) {
			const row = { run: index + 1, room: room.name, startedAt: Date.now() };
			results.runs.push(row);
			try {
				await s.normalRate();
				await end(s, 'kill @e[type=minecraft:area_effect_cloud]'); await end(s, 'kill @e[type=minecraft:dragon_fireball]'); await end(s, 'kill @e[type=minecraft:item]');
				await build();
				// The last run's firing (a run is bounded at 6 s) ends before the body is placed, or it would carry the body off.
				for (let wait = 0; wait < 60 && (await s.observe()).reflexes?.firing; wait++) await sleep(250);
				// Respawned (old arm deaths): back to the End island. Placed until it stands on the room's cell.
				const cell = [CX + room.body[0] + 0.5, TOP + 1, CZ + room.body[1] + 0.5];
				let before = null;
				for (let attempt = 0; attempt < 5; attempt++) {
					await end(s, `tp ${AGENT} ${cell.join(' ')} 0 20`);
					await s.command(`effect clear ${AGENT}`);
					await s.command(`effect give ${AGENT} minecraft:instant_health 1 4 true`);
					await s.command(`effect give ${AGENT} minecraft:saturation 1200 4 true`);
					await sleep(2500);
					before = await pos();
					if (Math.hypot(before.x - cell[0], before.z - cell[2]) < 0.8 && Math.abs(before.y - cell[1]) < 0.5) break;
				}
				row.placed = Math.hypot(before.x - cell[0], before.z - cell[2]) < 0.8;
				row.start = before;
				// Baselines read right before the summon, after placement (placing can itself end a firing).
				const deathsBefore = await readDeaths();
				const firedBefore = armedBreath ? await firedCount() : null;
				const damageBefore = await readDamage();
				const [bx, bz] = room.ball;
				// Play from the summon: game time on the fixture clock (wall time at 20 TPS).
				await s.fastRate();
				const now = () => s.clock.now(), wall0 = Date.now(), timer = await s.gameTimer();
				// A dragon fireball dropped onto the cell: vanilla makes the breath cloud where it hits.
				// Summoned just above the ground so it lands at once, before the fireball reflex could turn it aside.
				await end(s, `summon minecraft:dragon_fireball ${CX + bx + 0.5} ${TOP + 1.3} ${CZ + bz + 0.5} {Motion:[0.0d,-1.0d,0.0d],acceleration_power:0.1d}`);
				let cloudAt = null, t0 = now(), commandResult = null, minY = before.y, dead = false;
				for (let i = 0; i < 60 && !cloudAt; i++) {
					const reply = String(await end(s, `execute as @e[type=minecraft:area_effect_cloud,limit=1] run data get entity @s Pos`));
					const m = reply.match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
					if (m) cloudAt = m.slice(1).map(Number);
					else await s.clock.sleep(100);
				}
				row.cloudAt = cloudAt;
				row.cloud = cloudAt ? String(await end(s, 'execute as @e[type=minecraft:area_effect_cloud,limit=1] run data get entity @s')).slice(0, 600) : null;
				t0 = now();
				let pending = null;
				const trail = [];
				while (now() - t0 < 12_000) {
					if (room.command && !pending && now() - t0 >= 400 && cloudAt) {
						pending = runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `breath-${index}`, callId: `breath-${index}`,
							tool: normalizeMinecraftToolCall('act', { actionType: 'travel_to', arguments: { x: Math.floor(cloudAt[0]) + 0.5, y: TOP + 1, z: Math.floor(cloudAt[2]) + 0.5, tolerance: 1 } }) }, record)
							.then(r => { commandResult = { state: r?.state, reasonCode: r?.reasonCode, message: String(r?.message ?? '').slice(0, 300) }; })
							.catch(error => { commandResult = { error: String(error?.message ?? error).slice(0, 300) }; });
					}
					const p = await pos().catch(() => null);
					if (p) {
						trail.push([Math.round((now() - t0) / 100) / 10, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10, p.health]);
						minY = Math.min(minY, p.y);
						if (p.dead) { dead = true; break; }
					}
					await s.clock.sleep(200);
				}
				// One cutoff for every piece of evidence: the window's end. Damage, deaths, the breath rule's fired count and the
				// final position are all read here, before the wait for the command's receipt, so a firing (or a hit) during that
				// wait cannot qualify or fail the room.
				Object.assign(row, damageEvidence(damageBefore, await readDamage(), before.health, trail.at(-1)?.[4]));
				row.deathEvidence = deathEvidence(deathsBefore, await readDeaths());
				const firedAfter = armedBreath ? await firedCount().catch(() => null) : null;
				const after = await pos().catch(() => null);
				row.end = after;
				// The window is over once its evidence is read: what it ran at, then back to 20 for the next room's setup.
				row.wallSeconds = Math.round((Date.now() - wall0) / 100) / 10;
				row.gameSeconds = Math.round((await timer.elapsed()) / 100) / 10;
				row.rates = await timer.rates().catch(() => null);
				await s.normalRate();
				row.trail = trail;
				row.died = dead || row.deathEvidence.deaths > 0 || after?.dead === true;
				// The receipt wait is diagnostic only (did the held command return?).
				if (pending) await Promise.race([pending, sleep(3000)]);
				row.command = commandResult;
				row.breathFirings = armedBreath && Number.isInteger(firedBefore) && Number.isInteger(firedAfter) ? firedAfter - firedBefore : null;
				// Missing evidence is invalid, never a pass: death count, trail, final observation, the breath rule's count.
				// A count that went down (the rule replaced or reset mid-room) is not evidence of anything.
				const missing = [!row.deathEvidence.valid && 'death counter unreadable', !trail.length && 'no trail', !after && 'no final observation',
					armedBreath && row.breathFirings === null && 'breath fired count unreadable',
					armedBreath && row.breathFirings < 0 && `breath fired count went down (${row.breathFirings})`].filter(Boolean);
				if (missing.length) row.integrity = [...(row.integrity ?? []), ...missing.map(error => ({ file: 'room', error }))];
				row.voidFall = minY < TOP - 1;
				const events = latest?.reflexes?.events ?? [];
				row.reflexEvents = events.filter(event => /breath|end-/.test(event.id)).slice(-6);
				// Exposure: the cloud landed within reach of the body (its 3-block radius plus the rule's 2) and, in an arm with a
				// breath rule, that rule fired in this room. A room without it measured nothing (council R1: a fireball 4.8 blocks
				// off, no firing, no move, counted as a pass).
				row.cloudDistance = cloudAt && before ? Math.round(Math.hypot(before.x - cloudAt[0], before.z - cloudAt[2]) * 10) / 10 : null;
				const notExercised = !cloudAt ? 'no breath cloud formed' : !row.placed ? 'body not placed on the room cell'
					: !(row.cloudDistance <= CLOUD_REACH) ? `cloud ${row.cloudDistance} blocks from the body`
					: armedBreath && !(row.breathFirings > 0) ? 'the breath rule did not fire in this room' : null;
				row.exercised = notExercised === null;
				row.pass = !row.died && !row.voidFall;
				// A room that measured nothing is invalid evidence, not a pass.
				if (notExercised) row.error = `not exercised: ${notExercised}`;
				row.finishedAt = Date.now();
				console.log(`[breath] run ${row.run} ${row.room}: ${row.error ? "NOT EXERCISED" : row.pass ? "PASS" : "FAIL"} died=${row.died} voidFall=${row.voidFall} damageHp=${row.damageTaken} cloudDist=${row.cloudDistance} breathFirings=${row.breathFirings} cloud=${cloudAt ? cloudAt.map(n => Math.round(n * 10) / 10).join(',') : 'none'} end=${after ? [after.x, after.y, after.z].map(n => Math.round(n * 10) / 10).join(',') : '?'} command=${JSON.stringify(commandResult)}`);
				if (row.died) await sleep(3000);
			} catch (error) {
				row.error = String(error?.stack ?? error).slice(0, 800);
				console.log(`[breath] run ${row.run} ${row.room}: ERROR ${row.error.split('\n')[0]}`);
			}
			await writeFile(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
		}
		const valid = results.runs.filter(row => !row.error && !row.integrity?.length && row.exercised);
		results.summary = { arm: results.arm, runs: results.runs.length, valid: valid.length, notExercised: results.runs.filter(row => /^not exercised/.test(row.error ?? '')).length, survived: valid.filter(row => !row.died).length, voidFalls: valid.filter(row => row.voidFall).length,
			deaths: valid.filter(row => row.died).length, pass: valid.filter(row => row.pass).length, damage: valid.map(row => row.damageTaken) };
		console.log(JSON.stringify(results.summary));
	} catch (error) {
		results.error = String(error?.stack ?? error).slice(0, 1200);
		console.log(`[breath] ERROR ${results.error.split('\n')[0]}`);
	} finally {
		await writeFile(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
		try { if (s) await s.stop(); } catch { /* the server is gone */ }
	}
}
console.log(JSON.stringify(await finishRun(results.runs.length ? results.runs : [{ error: results.error ?? 'no runs' }], { file: path.join(out, 'runs.json'), planned: runs.length, strict })));
