// Provider-free judged End rooms (NE-END-2): node scripts/quality/test-dragon-fight-live.mjs OUT_DIR [JAR] [--no-bow] [--survive]
// One server on a seeded world with the vanilla End: dragon, ten crystal pillars (two caged), endermen. The body arrives on
// the obsidian arrival platform with the eyes-start End kit (iron armour, iron sword and pickaxe, food, blocks, a water
// bucket) and, unless --no-bow, a bow and 64 arrows. The real coordinator path keeps it alive: NativeToolRuntime with the
// production ReflexBook, fed live samples, so entering the End arms its defaults as in a game. No model call is made.
//   fight (default): one scripted player, the same for both kits and branching only on what is held, plays from the
//     platform: walk or bridge onto the island, shoot every crystal it has a line to (bow only), melee the dragon's head
//     when it perches, shoot it in flight (bow only), else wait on open ground near the fountain. Pass: dragon killed and
//     body alive within 20 game minutes of arrival.
//   --survive: the body stands idle on the island with the dragon circling (crystals intact) and endermen about. Pass:
//     alive after 10 game minutes, no fall into the void.
// A body that never stands on the platform (or the island, for --survive), a run whose death counter is unreadable, that
// is not a fresh fight (dragon below 200 or fewer than ten crystals), whose End reflexes never armed, or whose commands hit
// a harness error is invalid evidence, never a pass. Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME.
// Judge with REPEATS=1 (the room list does): the End is not reset between repeats, so a repeat after a kill, a lost fight
// or a death is INVALID; REPEATS=n is for bring-up only.
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeToolRuntime } from '../../coordinator/src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../../coordinator/src/native-minecraft-tools.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { ReflexBook } from '../../coordinator/src/reflexes.mjs';
import { perchedDragon } from '../../coordinator/src/dragon-fight-facts.mjs';
import { warmBoots } from './fixture-servers.mjs';
import { liveRecord, unshownTickRate } from './watch-replay.mjs';
import { gameClockFromObservations } from '../../coordinator/src/game-clock.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { damageCounter, damageEvidence, deathCounter, deathEvidence, statCounter } from './lib/damage-counter.mjs';
import { finishRun, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log('Usage: test-dragon-fight-live.mjs OUT_DIR [JAR] [--no-bow] [--survive] [--no-endermen] [--descriptive]\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const BOW = !cli.includes('--no-bow'), SURVIVE = cli.includes('--survive');
// --no-endermen (bring-up only, never judged): endermen are removed every sample, so perch and crystal work can be measured
// without enderman deaths ending the fight.
const NO_ENDERMEN = cli.includes('--no-endermen');
if (NO_ENDERMEN && strict) { console.error('--no-endermen is for bring-up: add --descriptive'); process.exit(2); }
const [outArg, jarArg] = cli.filter(arg => !arg.startsWith('--'));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !template || !port || !process.env.JAVA_HOME) { console.error('Usage: OUT_DIR [JAR] [--no-bow] [--survive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME'); process.exit(2); }
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Slayer';
const FIGHT_MS = 20 * 60_000, SURVIVE_MS = 10 * 60_000;
// The vanilla arrival platform: 5x5 obsidian at y48 centred on 100,0, feet at y49.
const PLATFORM = { x: 100.5, y: 49, z: 0.5 };
// Open ground a player waits on for the perch: 10-15 blocks from the fountain (DRAGON_FINISH_FACTS).
const WAIT_SPOT = { x: 12.5, z: 0.5 };
const SURVIVE_SPOT = { x: 20.5, z: 20.5 };
const end = (s, text) => s.command(`execute in minecraft:the_end run ${text}`);
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const results = { arm: `${SURVIVE ? 'survive' : 'fight'}-${BOW ? 'bow' : 'no-bow'}${NO_ENDERMEN ? '-no-endermen' : ''}`, noEndermen: NO_ENDERMEN, mode: SURVIVE ? 'survive' : 'fight', bow: BOW,
	bar: SURVIVE ? 'alive after 10 game min, no void fall' : 'dragon killed and body alive within 20 game min of arrival',
	jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), runs: [] };
const repeats = Math.max(1, Number(process.env.REPEATS ?? 1));

for await (const { server: s, error: bootError } of warmBoots([{ name: 'dragon-fight' }], () => ({ dir: path.join(out, 'server-0'),
	options: { jar: results.jar, template, port, world: null, seed: '20261123', spawnMonsters: true, worldCache: false, tickRate: unshownTickRate('the dragon fight and End survival have no 20 vs 60 TPS A/B yet (the smokes at 60 are bring-up only)'),
		// A flat Overworld (the body is summoned there before the End; seed 20261123 puts ocean at 0,0). The End is vanilla.
		extraProperties: 'level-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\n' } }))) {
	try {
		if (!s) throw bootError;
		await s.command('time set noon');
		await s.command('forceload add -16 -16 16 16');
		await sleep(1500);
		const registered = s.inbox.wait('agent_registered', () => true, 45000);
		console.log(`[dragon-fight] summon: ${await s.command(`execute positioned 0 0 0 positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${AGENT}`)}`);
		const e = await registered;
		s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start', 120_000);
		// A goal far past every window: a goal that completes cancels the action in flight and stales every later command.
		await s.command(`mineagen start ${AGENT} Survive for 7200 seconds.`);
		s.record.goalRevision = (await started).payload.goalRevision;
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		await s.command(`gamemode survival ${AGENT}`);
		const fast = s.clock.rate !== 20;
		const book = new ReflexBook({ ...(fast ? { now: () => s.clock.now() } : {}) });
		const commands = new Set();
		// The live record: its goal revision follows the server's, so acks, observations and commands never go stale.
		const record = liveRecord(s, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' });
		const runtime = new NativeToolRuntime({
			bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') commands.add(payload.actionId); return s.bridge.send(type, agentId, payload); } },
			requestObservation: async () => { const payload = await s.observe(); return { eventSequence: payload.eventSequence, observation: adaptObservation(payload) }; },
			inspectObservation: async () => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', survey: {} }),
			reflexBook: book,
			...(fast ? { clock: gameClockFromObservations({ tickRate: s.clock.rate }) } : {}),
		});
		let latest = null;
		// Each rule's firings: the most seen in any End sample, kept as each arrives (also during a long command the body
		// dies in; a death drops the End rules). A run subtracts what it started with.
		const firedAt = rules => Object.fromEntries((Array.isArray(rules) ? rules : []).map(rule => [rule.id, Number(rule.fired) || 0]));
		let firedMost = {};
		const noteFired = payload => { if (payload?.world?.dimension !== 'minecraft:the_end') return; for (const [id, n] of Object.entries(firedAt(payload.reflexes?.rules))) firedMost[id] = Math.max(firedMost[id] ?? 0, n); };
		s.bridge.on('observation', ev => {
			if (ev.agentId !== record.agentId || !ev.payload.ready) return;
			latest = ev.payload;
			try { noteFired(latest); } catch { /* counting never stops the feed */ }
			runtime.updateObservation(record, adaptObservation(ev.payload), { eventSequence: ev.payload.eventSequence });
		});
		s.bridge.on('action_result', ev => {
			if (ev.agentId !== record.agentId || !commands.has(ev.payload.actionId)) return;
			runtime.onActionResult(record, ev.payload);
			s.bridge.send('action_result_ack', record.agentId, { goalRevision: record.goalRevision, actionId: ev.payload.actionId }).catch(() => {});
		});
		let calls = 0, harnessErrors = 0, staleRefusals = 0, liveStale = 0, runDeathsBefore = null, lastCommand = null;
		// Every scripted command takes the path a model's command takes (runtime.execute), reflexes and vetting included.
		const act = async (actionType, args) => {
			const n = ++calls;
			lastCommand = { actionType, at: s.clock.now() };
			const r = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `fight-${n}`, callId: `fight-${n}`,
				tool: normalizeMinecraftToolCall('act', { actionType, arguments: args }) }, record).catch(error => ({ state: 'FAILED', reasonCode: 'FIXTURE_ERROR', message: String(error?.message ?? error) }));
			// A thrown command is the harness's failure, not the bot's; so is a stale-command refusal while the body lives (a
			// command sent just as it died is refused stale too, and that death is a FAIL, not invalid evidence). Whether the
			// body lived is judged when the refusal comes, so a refusal before a later death still counts against the harness.
			if (r?.reasonCode === 'FIXTURE_ERROR') harnessErrors += 1;
			else if (/^STALE_/.test(String(r?.reasonCode ?? ''))) {
				staleRefusals += 1;
				const raw = await s.observe().catch(() => null);
				const deathsNow = await readDeaths().catch(() => null);
				const died = raw === null || raw.player?.dead === true || raw.status === 'PLAYER_DEAD' || (raw.world?.dimension && raw.world.dimension !== 'minecraft:the_end')
					|| Number.isInteger(deathsNow) && Number.isInteger(runDeathsBefore) && deathsNow > runDeathsBefore;
				if (!died) liveStale += 1;
			}
			// Anything but a success is not retried in a tight loop.
			if (r?.state !== 'SUCCEEDED') await s.clock.sleep(500);
			return { state: r?.state, reasonCode: r?.reasonCode, message: String(r?.message ?? '').slice(0, 300) };
		};
		const view = async () => adaptObservation(await s.observe());
		const groundY = async (x, z) => {
			await end(s, 'kill @e[type=minecraft:marker,tag=qo_ground]');
			await end(s, `execute positioned ${x} 0 ${z} positioned over world_surface run summon minecraft:marker ~ ~ ~ {Tags:["qo_ground"]}`);
			return Math.floor(number(await end(s, 'data get entity @e[type=minecraft:marker,tag=qo_ground,limit=1] Pos[1]')));
		};
		const dragonHealth = async () => number(await end(s, 'data get entity @e[type=minecraft:ender_dragon,limit=1] Health'));
		// "Test passed, count: N" or "Test failed" from execute if entity.
		const crystalsLeft = async () => { const text = String(await end(s, 'execute if entity @e[type=minecraft:end_crystal]')); return /count:?\s*(\d+)/i.test(text) ? Number(/count:?\s*(\d+)/i.exec(text)[1]) : /failed/i.test(text) ? 0 : NaN; };
		// The End: load the island so the fight starts (the dragon spawns once a player is in the End).
		await end(s, 'forceload add -64 -64 112 64'); await sleep(2000);
		const readDamage = await damageCounter(text => s.command(text), AGENT);
		await s.command('scoreboard objectives add qo_death deathCount');
		await s.command(`scoreboard players set ${AGENT} qo_death 0`);
		const readDeaths = () => deathCounter(text => s.command(text), AGENT);
		// Damage the body dealt (tenths of HP, to anything: the dragon, endermen) is the fight's progress beside the dragon's health.
		const readDealt = await statCounter(text => s.command(text), AGENT, 'qo_dealt', 'minecraft.custom:minecraft.damage_dealt');
		for (let run = 1; run <= repeats; run++) {
			const row = { run, room: results.arm, startedAt: Date.now() };
			harnessErrors = 0; staleRefusals = 0; liveStale = 0; runDeathsBefore = null;
			results.runs.push(row);
			try {
				await s.normalRate();
				// The eyes-start End kit (build-savepoints-v2's eyes save), plus the bow for the bow arm.
				await s.command(`clear ${AGENT}`); await s.command(`effect clear ${AGENT}`);
				for (const [slot, item] of [['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots'],
					['hotbar.0', 'iron_sword'], ['hotbar.2', 'iron_pickaxe'], ['hotbar.3', 'cobblestone 64'], ['hotbar.4', 'water_bucket'], ['hotbar.5', 'cooked_beef 16']])
					await s.command(`item replace entity ${AGENT} ${slot} with minecraft:${item}`);
				await s.command(`give ${AGENT} minecraft:cobblestone 64`);
				if (BOW) { await s.command(`item replace entity ${AGENT} hotbar.1 with minecraft:bow`); await s.command(`give ${AGENT} minecraft:arrow 64`); }
				let place = PLATFORM;
				if (SURVIVE) place = { x: SURVIVE_SPOT.x, y: await groundY(SURVIVE_SPOT.x, SURVIVE_SPOT.z), z: SURVIVE_SPOT.z };
				else {
					await end(s, 'fill 98 48 -2 102 48 2 minecraft:obsidian');
					await end(s, 'fill 98 49 -2 102 51 2 minecraft:air');
				}
				let at = null;
				for (let attempt = 0; attempt < 5; attempt++) {
					await end(s, `tp ${AGENT} ${place.x} ${place.y} ${place.z} 90 0`);
					await s.command(`effect give ${AGENT} minecraft:instant_health 1 4 true`);
					await sleep(2500);
					at = await view();
					if (at.world?.dimension === 'minecraft:the_end' && Math.hypot(at.player.x - place.x, at.player.z - place.z) < 1.5 && Math.abs(at.player.y - place.y) < 1) break;
				}
				row.placed = at?.world?.dimension === 'minecraft:the_end' && Math.hypot(at.player.x - place.x, at.player.z - place.z) < 1.5;
				let dragon = NaN;
				for (let wait = 0; wait < 60 && !Number.isFinite(dragon); wait++) { await sleep(1000); dragon = await dragonHealth(); }
				row.start = { health: at?.player?.health, dragonHealth: dragon, crystals: await crystalsLeft() };
				// Entering the End arms its defaults through the runtime's ReflexBook.
				for (let wait = 0; wait < 40 && !(latest?.reflexes?.rules ?? []).some(rule => /^default-/.test(rule.id) && /breath|void|gaze|ender/.test(rule.id)); wait++) { await s.observe(); await sleep(250); }
				row.armed = (latest?.reflexes?.rules ?? []).map(rule => rule.id);
				const deathsBefore = await readDeaths(), damageBefore = await readDamage(), dealtBefore = await readDealt().catch(() => null);
				runDeathsBefore = deathsBefore;
				await s.fastRate();
				// The window is world ticks, not wall time: a server that cannot hold 20 TPS still plays the full game minutes.
				const now = () => s.clock.now(), wall0 = Date.now(), timer = await s.gameTimer({ worldTicks: true }), t0 = now();
				let played = 0, observeMisses = 0;
				// A world clock that stops while RCON still answers would hold the loop forever: three windows of wall time end it,
				// and the run is invalid ('world clock unreadable').
				const inWindow = async () => (played = Date.now() - wall0 > 3 * limit ? Infinity : await timer.elapsed().catch(() => Infinity)) < limit;
				const limit = SURVIVE ? SURVIVE_MS : FIGHT_MS;
				const log = [], tried = new Set();
				let dead = false, killed = false, minY = place.y, shots = 0, crystalBreaks = 0, meleeHits = 0, flyingShots = 0, passes = 0;
				// The dragon's lowest health and the drops between samples: crystals heal damage back, so the end health hides it.
				let lowestDragon = Number.isFinite(dragon) ? dragon : NaN, lastDragon = lowestDragon, dragonDrops = 0, meleeLanded = 0;
				// Enderman anger: each enderman that turns on the body, with the last samples before it (what the body was doing).
				const angerLog = [], recent = [];
				let angryBefore = new Set();
				const traceEndermen = o => {
					const me = o.player, t = Math.round((now() - t0) / 100) / 10;
					const rows = (o.entities ?? []).filter(e => e?.type === 'minecraft:enderman' && e.alive !== false && e.perceivedBy !== 'sound');
					const near = rows.map(e => ({ id: String(e.stableId ?? '').slice(0, 8), uuid: e.stableId, d: Math.round(e.distance ?? NaN), eye: e.appearance?.eyeContact === true || undefined,
						scream: e.appearance?.screaming === true || undefined, tgt: e.targetingAgent === true || undefined }));
					const reflex = o.reflexes && typeof o.reflexes === 'object' ? JSON.stringify(Object.fromEntries(Object.entries(o.reflexes).filter(([k]) => k !== 'rules'))).slice(0, 240) : null;
					recent.push({ t, yaw: Math.round(me.yaw), pitch: Math.round(me.pitch), hp: me.health, dealt: lastDealt, act: o.currentAction?.actionType ?? null, cmd: lastCommand?.actionType ?? null, reflex, near: near.filter(n => n.d <= 24).map(({ uuid, ...n }) => n) });
					if (recent.length > 6) recent.shift();
					// Only an enderman that targets the body counts: one screaming at the dragon is angry at it, not at you.
					const angry = new Set(near.filter(n => n.tgt).map(n => n.id));
					const fresh = [];
					for (const id of angry) if (!angryBefore.has(id) && angerLog.length < 20) { const entry = { id, t, before: recent.slice() }; angerLog.push(entry); fresh.push([entry, near.find(n => n.id === id)?.uuid]); }
					angryBefore = angry;
					return fresh;
				};
				// An enderman provoked by a stare is at full health (40); one hurt by the body (a sweep, a blast it caused) is not.
				const angerHealth = async fresh => { for (const [entry, uuid] of fresh) if (typeof uuid === 'string' && /^[0-9a-f-]{36}$/.test(uuid)) entry.health = number(await end(s, `data get entity ${uuid} Health`).catch(() => '')); };
				let lastDealt = null;
				const firedStart = firedAt(latest?.reflexes?.rules);
				firedMost = { ...firedStart };
				const note = (what, r) => { log.push([Math.round((now() - t0) / 1000), what, r?.state, r?.reasonCode, r?.message?.slice(0, 120)]); };
				while (await inWindow()) {
					// The raw sample decides death: a dead body's sample may not adapt, and it respawns in the Overworld.
					if (NO_ENDERMEN) await end(s, 'kill @e[type=minecraft:enderman]').catch(() => {});
					const raw = await s.observe().catch(() => null);
					// A lost sample feeds no reflex and shows no fall: counted, and more than two make the run invalid evidence.
					if (raw === null) observeMisses += 1;
					if (raw && (raw.player?.dead === true || raw.status === 'PLAYER_DEAD' || (raw.world?.dimension && raw.world.dimension !== 'minecraft:the_end'))) { dead = true; break; }
					const deathsNow = await readDeaths().catch(() => null);
					if (Number.isInteger(deathsNow) && Number.isInteger(deathsBefore) && deathsNow > deathsBefore) { dead = true; break; }
					let o = null;
					try { o = raw ? adaptObservation(raw) : null; } catch { o = null; }
					if (o) minY = Math.min(minY, o.player?.y ?? minY);
					lastDealt = await readDealt().catch(() => null);
					if (o?.player) try { await angerHealth(traceEndermen(o)); } catch { /* a trace never fails the run */ }
					if (!SURVIVE) {
						const health = await dragonHealth();
						if (Number.isFinite(health)) { if (health < lastDragon) dragonDrops += lastDragon - health; lastDragon = health; lowestDragon = Math.min(lowestDragon, health); }
						if (Number.isFinite(health) && health <= 0) { killed = Number.isFinite(dragon); break; }
						if (!Number.isFinite(health) && Number.isFinite(dragon)) {
							// The island stays force-loaded, so a missing dragon is a dead one only if it is still missing 2 s later.
							await s.clock.sleep(2000);
							const gone = /Test failed/i.test(String(await end(s, 'execute if entity @e[type=minecraft:ender_dragon]')));
							if (gone && !Number.isFinite(await dragonHealth())) { killed = true; break; }
						}
					}
					if (SURVIVE || !o) { await s.clock.sleep(1000); continue; }
					const me = o.player;
					const entities = o.entities ?? [];
					const arrows = (o.inventory?.items ?? []).filter(i => /^minecraft:(arrow|spectral_arrow|tipped_arrow)$/.test(i.itemId)).reduce((n, i) => n + i.count, 0);
					const ranged = (o.inventory?.items ?? []).some(i => i.itemId === 'minecraft:bow') && arrows > 0;
					const dist = row => Math.hypot(row.x - me.x, row.y - me.y, row.z - me.z);
					// 1. A crystal it has not tried yet, nearest first, within a bow's reach.
					const crystal = ranged ? entities.filter(row => row.type === 'minecraft:end_crystal' && !tried.has(row.stableId) && dist(row) <= 64)
						.sort((a, b) => dist(a) - dist(b))[0] : undefined;
					if (crystal) {
						tried.add(crystal.stableId);
						const r = await act('use_ranged', { targetId: crystal.stableId, drawDurationMs: 1100, timeoutMs: 6000 });
						shots += 1; if (r.state === 'SUCCEEDED' && /broke/.test(r.message) && !/something else/.test(r.message)) crystalBreaks += 1;
						note('shoot crystal', r); continue;
					}
					// 2. Perched: melee its head, as a player who ran in does.
					const perch = perchedDragon(o);
					if (perch?.head?.id) {
						const before = await dragonHealth();
						const r = await act('fight_target', { targetId: perch.head.id, timeoutMs: 12000 });
						const after = await dragonHealth();
						if (Number.isFinite(before) && Number.isFinite(after) && after < before) meleeLanded += 1;
						meleeHits += 1; note(`melee perched head (dragon ${before} -> ${after})`, r); continue;
					}
					// 3. In flight within a bow's reach: shoot its body.
					const part = ranged ? entities.filter(row => row.type === 'minecraft:ender_dragon' && /^(body|head)$/.test(row.partName ?? '') && dist(row) <= 48)
						.sort((a, b) => dist(a) - dist(b))[0] : undefined;
					if (part) {
						const r = await act('use_ranged', { targetId: part.stableId, drawDurationMs: 1100, timeoutMs: 6000 });
						flyingShots += 1; note('shoot flying dragon', r); continue;
					}
					// 4. Off the platform onto the island, then wait on open ground by the fountain; looking round shows new crystals.
					if (Math.hypot(me.x - WAIT_SPOT.x, me.z - WAIT_SPOT.z) > 6) {
						const y = await groundY(WAIT_SPOT.x, WAIT_SPOT.z);
						const r = await act('travel_to', { x: WAIT_SPOT.x, y: y + 1, z: WAIT_SPOT.z, tolerance: 3, build: true, timeoutMs: 60000 });
						note('to the fountain', r); continue;
					}
					// A crystal missed from one spot is tried again later (the body and its line of sight move).
					if (++passes % 20 === 0) tried.clear();
					// Looking round for crystals and the dragon, at the sky: a level gaze would meet endermen and provoke them, which
					// a player avoids (the first baseline lost both kits to endermen while the script swept the horizon).
					const turn = ((now() - t0) / 4000) % (2 * Math.PI);
					await act('look_at', { x: me.x + Math.cos(turn) * 20, y: me.y + 40, z: me.z + Math.sin(turn) * 20 });
					await s.clock.sleep(1000);
				}
				// One last sample after the window: a fall during the final wait is judged too.
				if (!dead) { const last = await s.observe().catch(() => null); if (Number.isFinite(last?.player?.y ?? last?.position?.y)) minY = Math.min(minY, last.player?.y ?? last.position.y); }
				// The last action can start inside the window and return after it (a melee runs up to 12 s): read the dragon once
				// more and keep how late its death was seen; a kill seen more than 15 s past the window does not count.
				if (!SURVIVE && !killed && !dead && Number.isFinite(dragon)) {
					const health = await dragonHealth();
					const missing = async () => /Test failed/i.test(String(await end(s, 'execute if entity @e[type=minecraft:ender_dragon]')));
					// Gone the same way the loop judges it: missing, and still missing with no health 2 s later.
					const gone = Number.isFinite(health) ? health <= 0 : await missing() && (await s.clock.sleep(2000), await missing()) && !Number.isFinite(await dragonHealth());
					// The game time now, after the final reads and the 2 s check, not the loop's last reading.
					const late = (await timer.elapsed().catch(() => Infinity)) - limit;
					if (gone) { row.killSeenLateMs = late; killed = late <= 15_000; }
				}
				Object.assign(row, damageEvidence(damageBefore, await readDamage(), row.start.health, latest?.player?.health));
				row.deathEvidence = deathEvidence(deathsBefore, await readDeaths());
				row.wallSeconds = Math.round((Date.now() - wall0) / 100) / 10;
				row.gameSeconds = Math.round((await timer.elapsed().catch(() => NaN)) / 100) / 10;
				row.rates = await timer.rates().catch(() => null);
				await s.normalRate();
				row.died = dead || row.deathEvidence.deaths > 0;
				row.voidFall = minY < 0;
				row.killed = killed;
				const dealtAfter = await readDealt().catch(() => null);
				Object.assign(row, { shots, crystalBreaks, meleeTries: meleeHits, meleeLanded, flyingShots, crystalsLeft: await crystalsLeft(), dragonHealthEnd: await dragonHealth(),
					dragonLowest: lowestDragon, dragonDrops: Math.round(dragonDrops * 10) / 10,
					damageDealt: Number.isFinite(dealtBefore) && Number.isFinite(dealtAfter) ? (dealtAfter - dealtBefore) / 10 : null, angerLog,
					reflexFired: Object.fromEntries(Object.entries(firedMost).map(([id, n]) => [id, n - (firedStart[id] ?? 0)]).filter(([, n]) => n > 0)), log: log.slice(-60) });
				row.deaths = row.deathEvidence.deaths;
				row.harnessErrors = harnessErrors + liveStale;
				row.staleRefusals = staleRefusals;
				row.observeMisses = observeMisses;
				// A fresh fight starts with a full dragon and all ten crystals; a repeat after a lost fight does not.
				const fresh = Number.isFinite(dragon) && dragon >= 200 && row.start.crystals === 10;
				const missing = [!row.deathEvidence.valid && 'death counter unreadable', !row.placed && `body not placed on the ${SURVIVE ? 'island' : 'arrival platform'}`,
					!Number.isFinite(dragon) && 'no dragon at the start', !fresh && Number.isFinite(dragon) && `not a fresh fight (dragon ${dragon}, crystals ${row.start.crystals})`,
					!row.armed.includes('default-breath') && 'the End reflexes never armed', row.harnessErrors > 0 && `${row.harnessErrors} harness error(s) sending commands`, observeMisses > 2 && `${observeMisses} live samples lost`,
					!Number.isFinite(played) && 'world clock unreadable'].filter(Boolean);
				if (missing.length) row.error = `not exercised: ${missing.join('; ')}`;
				row.pass = SURVIVE ? !row.died && !row.voidFall : row.killed && !row.died;
				row.failReason = row.pass ? null : row.died ? 'died' : row.voidFall ? 'void fall' : SURVIVE ? null : Number.isFinite(row.killSeenLateMs) ? 'dragon killed after the window' : 'dragon alive at the window end';
				row.finishedAt = Date.now();
				console.log(`[dragon-fight] ${results.arm} run ${run}: ${row.error ? 'INVALID' : row.pass ? 'PASS' : 'FAIL'} killed=${killed} died=${row.died} dragon=${row.dragonHealthEnd} crystals=${row.crystalsLeft} shots=${shots} broke=${crystalBreaks} melee=${meleeHits} landed=${meleeLanded} flying=${flyingShots} lowest=${lowestDragon} dealt=${row.damageDealt} angered=${angerLog.length} damage=${row.damageTaken} game=${row.gameSeconds}s`);
				// After a kill the End has no dragon: a further repeat on this server measures nothing.
				if (killed && run < repeats) { results.runs.push(...Array.from({ length: repeats - run }, (_, i) => ({ run: run + i + 1, room: results.arm, error: 'not exercised: the dragon was killed in an earlier repeat' }))); break; }
			} catch (error) {
				row.error = String(error?.stack ?? error).slice(0, 800);
				console.log(`[dragon-fight] run ${run}: ERROR ${row.error.split('\n')[0]}`);
			}
			await writeFile(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
		}
		const valid = results.runs.filter(row => !row.error && !row.integrity?.length);
		results.summary = { arm: results.arm, runs: results.runs.length, valid: valid.length, pass: valid.filter(row => row.pass).length,
			killed: valid.filter(row => row.killed).length, deaths: valid.filter(row => row.died).length, voidFalls: valid.filter(row => row.voidFall).length };
		console.log(JSON.stringify(results.summary));
	} catch (error) {
		results.error = String(error?.stack ?? error).slice(0, 1200);
		console.log(`[dragon-fight] ERROR ${results.error.split('\n')[0]}`);
	} finally {
		await writeFile(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
		try { if (s) await s.stop(); } catch { /* the server is gone */ }
	}
}
console.log(JSON.stringify(await finishRun(results.runs.length ? results.runs : [{ error: results.error ?? 'no runs' }], { file: path.join(out, 'runs.json'), planned: repeats, strict })));
