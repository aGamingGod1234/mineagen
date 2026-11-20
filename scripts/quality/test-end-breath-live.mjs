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
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeToolRuntime } from '../../coordinator/src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../../coordinator/src/native-minecraft-tools.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { ReflexBook, normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';
import { warmBoots } from './fixture-servers.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { damageCounter, replyNumber } from './lib/damage-counter.mjs';
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
const runs = Array.from({ length: repeats }, () => ROOMS).flat();
const results = { arm: OLD_RULE ? 'old+model-rule' : OLD ? 'old' : 'new', jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), runs: [] };

for await (const { server: s, error: bootError } of warmBoots([{ name: 'breath' }], () => ({ dir: path.join(out, 'server-0'),
	options: { jar: results.jar, template, port, world: null, seed: '20261017', spawnMonsters: false, worldCache: true } }))) {
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
		const book = new ReflexBook(OLD ? { dimensionDefaults: {} } : {});
		const commands = new Set();
		const record = { ...s.record, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
		const runtime = new NativeToolRuntime({
			bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') commands.add(payload.actionId); return s.bridge.send(type, agentId, payload); } },
			requestObservation: async () => { const payload = await s.observe(); return { eventSequence: payload.eventSequence, observation: adaptObservation(payload) }; },
			inspectObservation: async () => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', survey: {} }),
			reflexBook: book,
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
		const pos = async () => { const o = await s.observe(); return { x: o.position?.x, y: o.position?.y, z: o.position?.z, dead: o.player?.dead === true || o.status === 'PLAYER_DEAD', health: o.player?.health }; };
		for (const [index, room] of runs.entries()) {
			const row = { run: index + 1, room: room.name, startedAt: Date.now() };
			results.runs.push(row);
			try {
				await end(s, 'kill @e[type=minecraft:area_effect_cloud]'); await end(s, 'kill @e[type=minecraft:dragon_fireball]'); await end(s, 'kill @e[type=minecraft:item]');
				await build();
				const deathsBefore = replyNumber(await s.command(`scoreboard players get ${AGENT} deaths`)) || 0;
				if (deathsBefore > (results.deaths ?? 0)) { results.deaths = deathsBefore; }
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
				const damageBefore = await readDamage();
				const [bx, bz] = room.ball;
				// A dragon fireball dropped onto the cell: vanilla makes the breath cloud where it hits.
				// Summoned just above the ground so it lands at once, before the fireball reflex could turn it aside.
				await end(s, `summon minecraft:dragon_fireball ${CX + bx + 0.5} ${TOP + 1.3} ${CZ + bz + 0.5} {Motion:[0.0d,-1.0d,0.0d],acceleration_power:0.1d}`);
				let cloudAt = null, t0 = Date.now(), commandResult = null, minY = before.y, dead = false;
				for (let i = 0; i < 60 && !cloudAt; i++) {
					const reply = String(await end(s, `execute as @e[type=minecraft:area_effect_cloud,limit=1] run data get entity @s Pos`));
					const m = reply.match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
					if (m) cloudAt = m.slice(1).map(Number);
					else await sleep(100);
				}
				row.cloudAt = cloudAt;
				row.cloud = cloudAt ? String(await end(s, 'execute as @e[type=minecraft:area_effect_cloud,limit=1] run data get entity @s')).slice(0, 600) : null;
				t0 = Date.now();
				let pending = null;
				const trail = [];
				while (Date.now() - t0 < 12_000) {
					if (room.command && !pending && Date.now() - t0 >= 400 && cloudAt) {
						pending = runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `breath-${index}`, callId: `breath-${index}`,
							tool: normalizeMinecraftToolCall('act', { actionType: 'travel_to', arguments: { x: Math.floor(cloudAt[0]) + 0.5, y: TOP + 1, z: Math.floor(cloudAt[2]) + 0.5, tolerance: 1 } }) }, record)
							.then(r => { commandResult = { state: r?.state, reasonCode: r?.reasonCode, message: String(r?.message ?? '').slice(0, 300) }; })
							.catch(error => { commandResult = { error: String(error?.message ?? error).slice(0, 300) }; });
					}
					const p = await pos().catch(() => null);
					if (p) {
						trail.push([Math.round((Date.now() - t0) / 100) / 10, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10, p.health]);
						minY = Math.min(minY, p.y);
						if (p.dead) { dead = true; break; }
					}
					await sleep(200);
				}
				// Damage within the window, before the wait for the command's result.
				row.damageTaken = (await readDamage()) - damageBefore;
				if (pending) await Promise.race([pending, sleep(3000)]);
				const after = await pos().catch(() => null);
				const deathsAfter = replyNumber(await s.command(`scoreboard players get ${AGENT} deaths`)) || 0;
				row.end = after;
				row.trail = trail;
				row.command = commandResult;
				row.died = dead || deathsAfter > deathsBefore || after?.dead === true;
				row.voidFall = minY < TOP - 1;
				row.reflexEvents = (latest?.reflexes?.events ?? []).filter(event => /breath|end-/.test(event.id)).slice(-6);
				row.pass = !row.died && !row.voidFall;
				// No cloud, or a body not on its cell, measures nothing: invalid evidence, not a pass.
				if (!cloudAt) row.error = 'no breath cloud formed';
				else if (!row.placed) row.error = 'body not placed on the room cell';
				row.finishedAt = Date.now();
				console.log(`[breath] run ${row.run} ${row.room}: ${row.pass ? 'PASS' : 'FAIL'} died=${row.died} voidFall=${row.voidFall} damage=${row.damageTaken} cloud=${cloudAt ? cloudAt.map(n => Math.round(n * 10) / 10).join(',') : 'none'} end=${after ? [after.x, after.y, after.z].map(n => Math.round(n * 10) / 10).join(',') : '?'} command=${JSON.stringify(commandResult)}`);
				if (row.died) await sleep(3000);
			} catch (error) {
				row.error = String(error?.stack ?? error).slice(0, 800);
				console.log(`[breath] run ${row.run} ${row.room}: ERROR ${row.error.split('\n')[0]}`);
			}
			await writeFile(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
		}
		const valid = results.runs.filter(row => !row.error && row.cloudAt && row.placed);
		results.summary = { arm: results.arm, runs: results.runs.length, valid: valid.length, survived: valid.filter(row => !row.died).length, voidFalls: valid.filter(row => row.voidFall).length,
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
