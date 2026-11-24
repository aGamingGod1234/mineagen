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
import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
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
// --old-crystal-phase: the earlier crystal step (each crystal shot once from wherever the body stands, retried after 20
// idle passes), kept so a script change is judged against it on the same jar. --caged-first (bring-up): open the caged
// crystals before the open ones.
const OLD_CRYSTALS = cli.includes('--old-crystal-phase'), CAGED_FIRST = cli.includes('--caged-first');
// --old-refill: main's stand-in bucket handling, before the walk back to a remembered pour and the held bucket counted as
// in the hotbar (kept so both are judged on the same jar).
const OLD_REFILL = cli.includes('--old-refill');
// --hurt-rules (trial, off by default): no swing at a perch while a crystal stands, swings only from 16 health with no angry
// enderman near and the head within 6 blocks up, a step-out at 12 (not 8), and below 13 a walk out from the fountain to eat
// and heal to 16. Judged in one batch against main's stand-in, 20 runs a side: kills 4 and 4, deaths 9 and 9, all crystals
// down 8 against main's 12, so it stays off. --old-recover backs off only below 11.
const OLD_PERCH = !cli.includes('--hurt-rules');
// --head-aim (trial, off by default): flying shots at the dragon's head before its body. Against main's stand-in, 10 runs a side
// in one batch: about 2.6 damage an arrow against 2.2, but half as many arrows struck (head 13%, nearest part 24%), and no kills.
const OLD_AIM = !cli.includes('--head-aim');
// --old-recover: the first hurt rule, which backed off only below 11 (a step-out at 12 then walked straight back to the fountain).
const OLD_RECOVER = cli.includes('--old-recover');
// --dry-cage (trial, off by default): with no water bucket and only caged crystals left, the cage is opened anyway and the body
// comes down by breaking the column under its feet. Judged with --head-aim in the same batch: no gain shown, 1 fall in 6 uses.
const OLD_CAGE = !cli.includes('--dry-cage');
// --range-cap (trial, off by default): flying shots only within 26 blocks, not main's 48. Over 3 batches (1,306 shots with a
// distance), an arrow struck 64% of the time aimed under 20 blocks away, 37% at 20-30, 19% at 30-50 and 8% past that, and
// main's play used 62 or more of its 64 arrows in 3 of 7 runs that cleared the crystals and timed out. Against main's stand-in,
// 20 runs a side in one batch: 1 kill against 0, 36% of arrows struck against 26%, but half as many arrows landed (52 against
// 103) and the dragon ended no lower, so it stays off.
const OLD_RANGE = !cli.includes('--range-cap');
// --perch (practice room, judged with --descriptive off): the perch alone, with no crystals and no endermen. PERCHES landings
// (default 1), the body PERCH_RADIUS blocks (default 16) out from the fountain at PERCH_ANGLE degrees (default from the run's
// seed spot). Pass: every perch sat and ended, with at least PERCH_DEALT (40) damage dealt and under PERCH_LOST (4) taken.
const PERCH = cli.includes('--perch');
const PERCHES = Math.max(1, Number(process.env.PERCHES ?? 1)), PERCH_RADIUS = Number(process.env.PERCH_RADIUS ?? 16);
const PERCH_ANGLE = Number(process.env.PERCH_ANGLE ?? (Number(process.env.ROOM_INDEX ?? Math.floor(Math.random() * 1000)) * 137.5) % 360);
const PERCH_DEALT = 40, PERCH_LOST = 4;
const SKY_WAIT = cli.includes('--sky-wait');
// --crystal (practice room): the fight up to the last crystal down, endermen about. Pass: alive with a full water bucket
// when the tenth crystal breaks, within CRYSTAL_MS (wave 5: 42 of 122 runs died before then, 19 of them to endermen).
const CRYSTAL = cli.includes('--crystal');
const [outArg, jarArg] = cli.filter(arg => !arg.startsWith('--'));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !template || !port || !process.env.JAVA_HOME) { console.error('Usage: OUT_DIR [JAR] [--no-bow] [--survive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME'); process.exit(2); }
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Slayer';
const FIGHT_MS = 20 * 60_000, SURVIVE_MS = 10 * 60_000, PERCH_MS = 5 * 60_000, CRYSTAL_MS = 12 * 60_000;
// The vanilla arrival platform: 5x5 obsidian at y48 centred on 100,0, feet at y49.
const PLATFORM = { x: 100.5, y: 49, z: 0.5 };
// Open ground a player waits on for the perch: 10-15 blocks from the fountain (DRAGON_FINISH_FACTS).
const WAIT_SPOT = { x: 12.5, z: 0.5 };
const SURVIVE_SPOT = { x: 20.5, z: 20.5 };
const end = (s, text) => s.command(`execute in minecraft:the_end run ${text}`);
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const results = { arm: `${SURVIVE ? 'survive' : PERCH ? 'perch' : CRYSTAL ? 'crystal' : 'fight'}-${BOW ? 'bow' : 'no-bow'}${NO_ENDERMEN ? '-no-endermen' : ''}${OLD_CRYSTALS ? '-old-crystals' : ''}${CAGED_FIRST ? '-caged-first' : ''}`, noEndermen: NO_ENDERMEN,
	crystalPhase: OLD_CRYSTALS ? 'old' : 'positioned', mode: SURVIVE ? 'survive' : 'fight', bow: BOW,
	bar: SURVIVE ? 'alive after 10 game min, no void fall' : CRYSTAL ? 'alive with a water bucket when the last crystal breaks, within 12 game min' : 'dragon killed and body alive within 20 game min of arrival',
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
		const act = async (actionType, args, reflexes) => {
			// A long crystal sequence runs many commands between loop passes: endermen are cleared before each one too.
			if (NO_ENDERMEN) await end(s, 'kill @e[type=minecraft:enderman]').catch(() => {});
			const n = ++calls;
			lastCommand = { actionType, at: s.clock.now() };
			const r = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: `fight-${n}`, callId: `fight-${n}`,
				tool: normalizeMinecraftToolCall('act', { actionType, arguments: args, ...(reflexes ? { reflexes } : {}) }) }, record).catch(error => ({ state: 'FAILED', reasonCode: 'FIXTURE_ERROR', message: String(error?.message ?? error) }));
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
			// The whole message stays readable (a cage's advice runs past 300 characters); the log keeps a cut.
			return { state: r?.state, reasonCode: r?.reasonCode, message: String(r?.message ?? '').slice(0, 300), full: String(r?.message ?? '') };
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
		// Judging only (the body never reads it): the two caged crystals, so caged and open breaks are counted apart.
		// EndSpikeFeature: ten pillars 42 blocks out; the guarded ones are 79 and 82 high, crystals at 80 and 83.
		const cagedSpots = [];
		for (let i = 0; i < 10; i++) {
			const x = Math.floor(42 * Math.cos(2 * (-Math.PI + Math.PI / 10 * i))), z = Math.floor(42 * Math.sin(2 * (-Math.PI + Math.PI / 10 * i)));
			for (const y of [80, 83]) if (/passed/i.test(String(await end(s, `execute if block ${x + 2} ${y} ${z} minecraft:iron_bars`).catch(() => '')))) cagedSpots.push({ x: x + 0.5, y, z: z + 0.5 });
		}
		results.cagedSpots = cagedSpots;
		const cagedLeft = async () => { let n = 0; for (const c of cagedSpots) if (/passed/i.test(String(await end(s, `execute if entity @e[type=minecraft:end_crystal,x=${c.x},y=${c.y},z=${c.z},distance=..2]`)))) n += 1; return n; };
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
				const limit = SURVIVE ? SURVIVE_MS : PERCH ? PERCH_MS : CRYSTAL ? CRYSTAL_MS : FIGHT_MS;
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
				// The whole action message is kept (a bow shot's hit or miss is named late in it), up to 1500 characters.
				const note = (what, r) => { const entry = [Math.round((now() - t0) / 1000), what, r?.state, r?.reasonCode, r?.full?.slice(0, 1500)]; log.push(entry); console.log(`[dragon-fight] ${JSON.stringify(entry)}`); };
				// Judging: crystals left (all and caged) as they fall, arrows spent, and each big hit the body takes.
				const crystalTimeline = [], hurtLog = [];
				let clearedAt = null, lastLeft = null, lastCaged = null, arrowsStart = null, arrowsNow = null, lastHp = null;
				const trackCrystals = async () => {
					const left = await crystalsLeft().catch(() => NaN), caged = await cagedLeft().catch(() => NaN);
					const at = Math.round((await timer.elapsed().catch(() => NaN)) / 1000);
					if (left !== lastLeft || caged !== lastCaged) crystalTimeline.push([at, left, caged]);
					lastLeft = left; lastCaged = caged;
					if (left === 0 && clearedAt === null) clearedAt = at;
				};

				// The crystal phase, as a player who follows the facts plays it (DRAGON_FINISH_FACTS, CAGED_CRYSTAL_FACTS): every
				// crystal seen is remembered; each standing one is shot from a spot it can be hit from, and a caged one is opened
				// first (pillar beside the cage, break the lowest side bars, shaft down, shoot from the ground through the gap).
				const seenCrystals = new Map();
				// A sample whose entities are carried from memory says nothing new (rememberEndCrystals skips it too), and a
				// crystal once broken stays broken: the sample right after the shot can still list it.
				const remember = (rows, o = null) => {
					if (o?.continuity?.rememberedSections?.includes('entities')) return;
					for (const row of rows) {
						if (row?.type !== 'minecraft:end_crystal' || row.alive === false || row.perceivedBy === 'sound' || typeof row.stableId !== 'string' || ![row.x, row.y, row.z].every(Number.isFinite)) continue;
						// Updated in place: a step holding this crystal keeps seeing what a shot learnt about it.
						const known = seenCrystals.get(row.stableId) ?? { tries: 0, spot: 0, want: null, cageTries: 0, gaveUp: false, gone: false };
						Object.assign(known, { id: row.stableId, x: row.x, y: row.y, z: row.z, caged: row.appearance?.caged === true || known.caged === true });
						seenCrystals.set(row.stableId, known);
					}
				};
				const where = c => `${Math.floor(c.x)},${Math.floor(c.y + 1e-6)},${Math.floor(c.z)}`;
				const shoot = async (c, what) => {
					// A crystal remembered but out of view is looked at first (the bot shoots only what the latest sample shows),
					// and none is shot from within 9 blocks: its blast deals about 14 there before armour (CAGED_CRYSTAL_FACTS).
					let v = await view().catch(() => null);
					if (v?.player && Math.hypot(c.x - v.player.x, c.y + 1 - v.player.y, c.z - v.player.z) < 9) { note(`${what} ${where(c)}: too close to its blast`, null); return { state: 'FAILED', reasonCode: 'TOO_CLOSE', full: '' }; }
					if (!(v?.entities ?? []).some(e => e.stableId === c.id)) {
						await act('look_at', { x: c.x, y: c.y + 1, z: c.z });
						await s.clock.sleep(300);
						v = await view().catch(() => null);
						remember(v?.entities ?? [], v);
						if (!(v?.entities ?? []).some(e => e.stableId === c.id)) { note(`${what} ${where(c)}: not in view from here`, null); return { state: 'FAILED', reasonCode: 'NOT_IN_VIEW', full: '' }; }
					}
					const r = await act('use_ranged', { targetId: c.id, drawDurationMs: 1100, timeoutMs: 6000 });
					shots += 1;
					const broke = r.state === 'SUCCEEDED' && /broke/.test(r.full) && !/something else/.test(r.full);
					if (broke) crystalBreaks += 1;
					// A target the bot no longer finds is gone (a shot whose impact it lost sight of may have broken it).
					if (broke || r.reasonCode === 'TARGET_UNAVAILABLE' || /broke or died/.test(r.full)) c.gone = true;
					note(`${what} ${c.caged ? 'caged ' : ''}crystal ${where(c)}`, r);
					return r;
				};
				// Open ground at x,z (a spot on another pillar or over the void is not one).
				const goTo = async (x, z, what, tolerance = 2) => {
					const y = await groundY(Math.floor(x), Math.floor(z));
					if (!Number.isFinite(y) || y < 40 || y > 75) { note(`${what}: no open ground at ${Math.floor(x)},${Math.floor(z)} (y ${y})`, null); return { state: 'FAILED', reasonCode: 'NO_GROUND' }; }
					const r = await act('travel_to', { x, y, z, tolerance, build: true, timeoutMs: 60000 });
					note(what, r);
					return { ...r, y };
				};
				// A player climbs, works on and digs down an exposed column while the dragon is away: wait (up to 30 s) until no
				// dragon part seen is within 64 blocks (the End throw reflex arms within 48); one thrown off falls about 20 blocks.
				const dragonAway = async what => {
					for (let i = 0; i < 30; i++) {
						const v = await view().catch(() => null);
						const near = (v?.entities ?? []).filter(e => e.type === 'minecraft:ender_dragon' && e.alive !== false && Number.isFinite(e.x) && v?.player
							&& Math.hypot(e.x - v.player.x, e.y - v.player.y, e.z - v.player.z) < 64);
						if (near.length === 0) return;
						if (i === 0) note(`${what}: waiting for the dragon to fly off`, null);
						await s.clock.sleep(1000);
					}
				};
				const feetNow = async () => { const v = await view().catch(() => null); return v?.player ? { x: Math.floor(v.player.x), y: Math.floor(v.player.y + 1e-6), z: Math.floor(v.player.z), o: v } : null; };
				// An open crystal: shoot from where the body stands; a refusal that names how far out the crystal clears its
				// pillar's edge (or a miss) moves it, along the line from the pillar toward the island centre, a little further
				// round on each later spot.
				const openShot = async (c, me) => {
					const P = { x: Math.floor(c.x) + 0.5, z: Math.floor(c.z) + 0.5 };
					const flat = Math.hypot(me.x - P.x, me.z - P.z);
					if (c.tries < 2 && (c.want === null || Math.abs(flat - c.want) < 5)) {
						c.tries += 1;
						const r = await shoot(c, 'shoot');
						if (c.gone) return;
						const edge = Number((/clears that edge from about (\d+) blocks out/.exec(r.full) ?? [])[1]);
						if (Number.isFinite(edge)) { c.want = Math.min(80, Math.max(edge + 4, 12)); c.tries = 2; }
						else if (r.reasonCode === 'RANGED_TARGET_OUT_OF_REACH') { c.want = Math.max(16, flat - 24); c.tries = 2; }
						// Not in view close in is mostly the pillar's own top edge (the bot names no distance for a target it cannot
						// see): further out each time.
						else if (r.reasonCode === 'NOT_IN_VIEW') { c.want = Math.min(80, Math.max(c.want ?? 0, flat) + 10); c.tries = 2; }
						else if (r.state !== 'SUCCEEDED') c.tries = 2;
						return;
					}
					c.spot += 1; c.tries = 0;
					if (c.spot > 6) { c.gaveUp = true; note(`give up on crystal ${where(c)} for now`, null); return; }
					let d = c.want ?? 24;
					const toward = Math.atan2(-P.z, -P.x) + [0, 0.35, -0.35, 0.7, -0.7, 0][(c.spot - 1) % 6];
					// Past the island centre, the exit fountain is no spot to stand on.
					if (Math.hypot(P.x + Math.cos(toward) * d, P.z + Math.sin(toward) * d) < 7) d += 9;
					const r = await goTo(P.x + Math.cos(toward) * d, P.z + Math.sin(toward) * d, `to ${Math.round(d)} out from crystal ${where(c)}`);
					if (r.reasonCode === 'NO_GROUND' && c.want !== null) c.want = Math.max(12, c.want - 8);
				};
				// A caged crystal (CAGED_CRYSTAL_FACTS): from the ground on the side facing the island centre a shot is refused with
				// the cage's advice (the spot beside its wall); pillar up there, break the wall bars at the crystal's feet height
				// and the row above, leaving the lowest row as the wall between the column and the spike top, dig the column back
				// down (shaft, water bucket in the hotbar), and shoot from the ground through the gap.
				// The dragon flings a player, off a column or open ground; "a falling reflex" places water below in time
				// (dragonFact): armed from the first crystal step, and the bucket refilled from the water it poured.
				let clutchArmed = false;
				const CLUTCH = [{ id: 'water-clutch', kind: 'trigger', priority: 9, when: [{ type: 'falling', blocks: 4 }], do: { type: 'place', item: 'minecraft:water_bucket', where: 'below' }, ttlS: 1800 }];
				let refillMissNoted = false;
				// A cage takes minutes of back-to-back steps: none starts once the judged window is over.
				const over = async what => { if (await inWindow()) return false; note(`${what}: the window is over`, null); return true; };
				// The view lists the held stack as slot 'mainhand', and the main hand is a hotbar slot: main's stand-in (--old-refill)
				// missed it and left the cage with the bucket in hand.
				const hotbarBucket = o => (o?.inventory?.items ?? []).some(i => i.itemId === 'minecraft:water_bucket' && (Number.isInteger(i.slot) ? i.slot < 9 : (OLD_REFILL ? /hotbar|offhand/ : /hotbar|offhand|mainhand/).test(String(i.slot))));
				const refill = async () => {
					const v = await view().catch(() => null);
					const items = v?.inventory?.items ?? [];
					if (items.some(i => i.itemId === 'minecraft:water_bucket') || !items.some(i => i.itemId === 'minecraft:bucket') || !v?.player) return;
					const water = (v.blocks ?? []).filter(b => b?.blockId === 'minecraft:water' && [b.x, b.y, b.z].every(Number.isFinite))
						.sort((a, b) => Math.hypot(a.x + 0.5 - v.player.x, a.y - v.player.y, a.z + 0.5 - v.player.z) - Math.hypot(b.x + 0.5 - v.player.x, b.y - v.player.y, b.z + 0.5 - v.player.z))[0];
					if (!water || Math.hypot(water.x + 0.5 - v.player.x, water.y + 0.5 - v.player.y - 1.6, water.z + 0.5 - v.player.z) > 4.5) { if (!refillMissNoted) note('refill: no water in reach', null); refillMissNoted = true; return; }
					refillMissNoted = false;
					await act('select_item', { itemId: 'minecraft:bucket' });
					const r = await act('use_item', { expectedItemId: 'minecraft:bucket', aimX: water.x + 0.5, aimY: water.y + 0.5, aimZ: water.z + 0.5, durationMs: 100 });
					note(`refill the bucket at ${water.x},${water.y},${water.z}`, r);
				};
				// Down an access column to the ground feet y BASE: one shaft call with a hotbar water bucket (the facts' descent);
				// without one the shaft turns into two-column stairs, so the column is broken one block under the feet at a time.
				const comeDown = async base => {
					let f = await feetNow(), r;
					f = await feetNow();
					const bucket = (f?.o?.inventory?.items ?? []).some(i => i.itemId === 'minecraft:water_bucket' && (Number.isInteger(i.slot) ? i.slot < 9 : /hotbar|offhand/.test(String(i.slot))));
					note(`descend: water bucket in the hotbar ${bucket}`, null);
					// Down even past the window: the body does not stay on the column.
					await dragonAway('before the descent');
					// With the bucket, one shaft call (the facts' descent); without it the shaft turns into two-column stairs, so the
					// column is broken one block under the feet at a time, each a one-block drop.
					if (bucket) for (let i = 0; i < 2 && f && f.y > base; i++) {
						r = await act('dig_to', { pattern: 'shaft', y: base, maxShaftY: base, throughCaves: true, timeoutMs: 90000 }); note('shaft down the column', r);
						f = await feetNow();
					}
					else for (let i = 0; i < 40 && f && f.y > base; i++) {
						r = await act('break_block', { x: f.x, y: f.y - 1, z: f.z, timeoutMs: 10000 }); note(`break the column under the feet at y ${f.y - 1}`, r);
						await s.clock.sleep(600);
						const next = await feetNow();
						if (r.state !== 'SUCCEEDED' && next?.y === f.y) break;
						f = next;
					}
					return f;
				};
				// An empty bucket before a cage: back to the water the body's own reflex poured, which the End fact names
				// ("Water source you poured at X (remembered; aim the empty bucket there)"), and fill it there. --old-refill
				// skips the walk, as main's stand-in did (a cage was left whenever no water was in reach).
				const dryPours = new Set();
				const fetchWater = async () => {
					if (OLD_REFILL) return;
					const v = await view().catch(() => null);
					const items = v?.inventory?.items ?? [];
					if (!v?.player || items.some(i => i.itemId === 'minecraft:water_bucket') || !items.some(i => i.itemId === 'minecraft:bucket')) return;
					const pour = runtime.reflexPours(record, v).map(p => ({ ...p, d: Math.hypot(p.x + 0.5 - v.player.x, p.z + 0.5 - v.player.z) }))
						.filter(p => p.d <= 96 && !dryPours.has(`${p.x},${p.y},${p.z}`)).sort((a, b) => a.d - b.d)[0];
					if (!pour) { note('no water bucket and no remembered pour', null); return; }
					let reached = true;
					if (pour.d > 3) {
						const r = await act('travel_to', { x: pour.x + 0.5, y: pour.y, z: pour.z + 0.5, tolerance: 2, build: true, timeoutMs: 60000 });
						note(`to the remembered pour at ${pour.x},${pour.y},${pour.z}`, r);
						reached = r?.state === 'SUCCEEDED';
					}
					await act('select_item', { itemId: 'minecraft:bucket' });
					const r = await act('use_item', { expectedItemId: 'minecraft:bucket', aimX: pour.x + 0.5, aimY: pour.y + 0.5, aimZ: pour.z + 0.5, durationMs: 100 });
					note(`refill the bucket at the remembered pour ${pour.x},${pour.y},${pour.z}`, r);
					// The bucket met another block there: the source is gone (seen in 2 of 15 runs: the walk was made again and again), as the
					// player reads from the failed fill, so that pour is not walked to again.
					if (reached && r?.state !== 'SUCCEEDED') dryPours.add(`${pour.x},${pour.y},${pour.z}`);
				};
				const openCage = async c => {
					c.cageTries += 1;
					await refill();
					if (c.cageTries > 3) { c.gaveUp = true; note(`give up on caged crystal ${where(c)} for now`, null); return; }
					const cx = Math.floor(c.x), cy = Math.floor(c.y + 1e-6), cz = Math.floor(c.z);
					let [sx, sz] = Math.abs(cx) >= Math.abs(cz) ? [-Math.sign(cx), 0] : [0, -Math.sign(cz)];
					const groundSpot = D => ({ x: cx + 0.5 + sx * D, z: cz + 0.5 + sz * D });
					let g = groundSpot(18);
					if (await over('cage')) return;
					await goTo(g.x, g.z, `to the ground before caged crystal ${where(c)}`);
					let r = await shoot(c, 'shoot (cage check)');
					if (c.gone || r.state === 'SUCCEEDED') return;
					const named = /standing at (-?\d+),(-?\d+),(-?\d+)/.exec(r.full);
					const S = named ? { x: +named[1], y: +named[2], z: +named[3] } : { x: cx + 3 * sx, y: cy, z: cz + 3 * sz };
					// The wall cell between the stand and the crystal, on the side the advice faced.
					if (Math.abs(S.x - cx) === 3 && S.z === cz) [sx, sz] = [Math.sign(S.x - cx), 0];
					else if (Math.abs(S.z - cz) === 3 && S.x === cx) [sx, sz] = [0, Math.sign(S.z - cz)];
					const W = { x: cx + 2 * sx, z: cz + 2 * sz };
					const base = await groundY(S.x, S.z);
					if (!Number.isFinite(base) || base < 40 || base >= S.y) { note(`no ground beside caged crystal ${where(c)} (y ${base})`, null); c.cageTries = 99; return; }
					// 2. Onto the cell beside the wall, feet centred, and pillar a whole column to the crystal's feet height.
					// The facts' descent needs a water bucket in the hotbar: without one, the method is not used at all.
					if (!hotbarBucket(await view().catch(() => null))) await fetchWater();
					const gate = await view().catch(() => null);
					// No water left anywhere and only caged crystals standing: a player opens the cage anyway and comes down by
					// breaking the column under the feet a block at a time (comeDown's dry descent), since a cage left standing means no
					// kill. Round 1's fix arm: 4 of 10 runs ended alive with the two caged crystals up and the bucket empty.
					// Without --dry-cage the cage is left whenever the bucket is empty.
					const onlyCaged = !OLD_CAGE && [...seenCrystals.values()].every(k => k.gone || k.caged);
					if (!hotbarBucket(gate) && onlyCaged) note(`no water bucket: caged crystal ${where(c)} opened with the dry descent`, null);
					else if (!hotbarBucket(gate)) {
						const buckets = (gate?.inventory?.items ?? []).filter(i => /bucket/.test(i.itemId)).map(i => `${i.itemId.replace('minecraft:', '')}@${i.slot}`).join(' ') || 'none';
						note(`no water bucket in the hotbar (${buckets}): caged crystal ${where(c)} left for now`, null); c.gaveUp = true; return;
					}
					if (await over('to the cage')) return;
					r = await act('travel_to', { x: S.x + 0.5, y: base, z: S.z + 0.5, tolerance: 1, build: true, timeoutMs: 60000 }); note('to the spot beside the cage', r);
					let f = await feetNow();
					for (let i = 0; i < 3 && f && (f.x !== S.x || f.z !== S.z || f.y !== base); i++) {
						r = await act('navigate_to', { x: S.x + 0.5, y: base, z: S.z + 0.5, tolerance: 0.25, sprint: false, timeoutMs: 10000 }); note('centre on the spot', r);
						f = await feetNow();
					}
					if (!f || f.x !== S.x || f.z !== S.z || f.y !== base) { note(`not on the spot beside the cage (feet ${f ? `${f.x},${f.y},${f.z}` : '?'})`, null); return; }
					// The facts want end stone (the dragon's block clearing spares it); the kit carries cobblestone, so end stone is
					// used when the body has some.
					const column = ((await view().catch(() => null))?.inventory?.items ?? []).some(i => i.itemId === 'minecraft:end_stone' && i.count >= S.y - base) ? 'minecraft:end_stone' : 'minecraft:cobblestone';
					await act('select_item', { itemId: column });
					if (await over('the pillar')) return;
					await dragonAway('before the pillar');
					for (let i = 0; i < 4 && f && f.x === S.x && f.z === S.z && f.y < S.y; i++) {
						r = await act('build', { structure: 'pillar', size: S.y - f.y, itemId: column, timeoutMs: 60000 }); note(`pillar ${S.y - f.y} up beside the cage`, r);
						f = await feetNow();
					}
					// A build that stopped partway up leaves the body on the column: it comes down before giving up this try.
					if (!f || f.x !== S.x || f.z !== S.z || f.y < S.y) { note(`pillar short (feet ${f ? `${f.x},${f.y},${f.z}` : '?'} of ${S.y})`, null); if (f && f.y > base) await comeDown(base); return; }
					// 3. The wall bars at the crystal's feet height and above; the lowest row stays (CAGED_CRYSTAL_FACTS).
					await act('select_item', { itemId: 'minecraft:iron_pickaxe' });
					// Past the window the bars wait, but the body still comes down off the column.
					const late = await over('the bars');
					if (!late) {
						await dragonAway('before the bars');
						for (const y of [cy + 1, cy]) {
							r = await act('break_block', { x: W.x, y, z: W.z, expectedBlockId: 'minecraft:iron_bars', timeoutMs: 10000 }); note(`break bar ${W.x},${y},${W.z}`, r);
						}
					}
					// 4. Down the column to the recorded ground feet y.
					f = await comeDown(base);
					await refill();
					if (late) return;
					// 5. Only once down on the island floor: from the ground on that side, through the gap.
					if (!f || f.y > base + 1) { note(`descent short (feet ${f ? `${f.x},${f.y},${f.z}` : '?'}, ground ${base})`, null); return; }
					for (const D of [18, 24, 13]) {
						if (await over('the shot through the gap')) return;
						g = groundSpot(D);
						await goTo(g.x, g.z, `to ${D} out from the opened cage`);
						for (let k = 0; k < 2 && !c.gone; k++) {
							r = await shoot(c, 'shoot through the gap');
							if (r.state !== 'SUCCEEDED') break;
						}
						if (c.gone) return;
					}
				};
				let huntedSince = null, lastFetch = -Infinity;
				// Hurt (PERCH_FACTS: head 10 on contact, breath 6 a second through armour; an enderman hits for 7): a player backs off
				// before another hit can kill, away from the fountain (the perch and its breath) and any enderman close by, eats when
				// not full (saturation heals fast), and goes back only near full health. Round 4's fix arm: the deaths before the
				// crystals were down came at 5-8 health, 4 of 6 right after a perch swing, and the bot went straight back to work.
				let recovering = false, lastEat = -Infinity, lastHoldNote = -Infinity;
				const recover = async (o, me) => {
					if (OLD_PERCH || !Number.isFinite(me.health)) return false;
					if (me.health >= 16) { if (recovering) note(`healed to ${Math.round(me.health)}: back to work`, null); recovering = false; return false; }
					// From 13, just past the perch swing's step-out at 12, so every step-out heals first; --old-recover: from 11.
					if (!recovering && me.health >= (OLD_RECOVER ? 11 : 13)) return false;
					// Health regrows only at hunger 18 or more: with no food to get there, waiting would never end.
					if ((me.hunger ?? 20) < 18 && !(o.inventory?.items ?? []).some(i => i.itemId === 'minecraft:cooked_beef')) { recovering = false; return false; }
					if (!recovering) note(`hurt to ${Math.round(me.health)}: back off and heal`, null);
					recovering = true;
					if ((me.hunger ?? 20) < 20 && now() - lastEat > 5000 && (o.inventory?.items ?? []).some(i => i.itemId === 'minecraft:cooked_beef')) {
						lastEat = now();
						await act('select_item', { itemId: 'minecraft:cooked_beef' });
						note('eat while hurt', await act('use_item', { expectedItemId: 'minecraft:cooked_beef', durationMs: 1800 }));
						return true;
					}
					const fountain = Math.hypot(me.x - 0.5, me.z - 0.5);
					const ender = (o.entities ?? []).filter(e => e?.type === 'minecraft:enderman' && e.alive !== false && Number.isFinite(e.x) && (e.distance ?? Infinity) <= 8)
						.sort((a, b) => a.distance - b.distance)[0];
					if (fountain < 22 || ender) {
						// Out along the line from the fountain, turned away from the closest enderman.
						let a = Math.atan2(me.z - 0.5, me.x - 0.5);
						if (!Number.isFinite(a) || fountain < 1) a = 0;
						if (ender) { const away = Math.atan2(me.z - ender.z, me.x - ender.x); a = Math.atan2(Math.sin(a) + Math.sin(away), Math.cos(a) + Math.cos(away)); }
						const R = Math.max(26, fountain + (ender ? 8 : 0));
						for (const turn of [0, 0.5, -0.5, 1, -1]) {
							const x = 0.5 + Math.cos(a + turn) * R, z = 0.5 + Math.sin(a + turn) * R;
							const y = await groundY(Math.floor(x), Math.floor(z)).catch(() => NaN);
							if (!Number.isFinite(y) || y < 50 || y > 75) continue;
							note(`back off to heal (${Math.round(fountain)} from the fountain${ender ? ', an enderman close' : ''})`, await act('travel_to', { x, y, z, tolerance: 3, build: false, timeoutMs: 15000 }));
							return true;
						}
					}
					// Waiting: eyes on the sky, off the endermen.
					await act('look_at', { x: me.x, y: me.y + 40, z: me.z + 5 });
					await s.clock.sleep(1000);
					return true;
				};
				const crystalStep = async (o, me) => {
					remember(o.entities ?? [], o);
					// An enderman that has turned on the body: a player stays in the water it stands in (the End enderman default pours
					// it) instead of walking out to a shooting spot or scooping that water back up. The judged A/B lost 3 of 10 runs in
					// 82-204 s to exactly that walk. Held at most 30 s at a time: an angry enderman can keep its target while it
					// teleports about, and the crystals still have to come down.
					const hunters = (o.entities ?? []).filter(e => e?.type === 'minecraft:enderman' && e.alive !== false && e.targetingAgent === true && (e.distance ?? Infinity) <= 24);
					const hunted = hunters.length > 0;
					// Holding still is only safe in water. On dry ground a player swings at the enderman that has closed in instead
					// of standing to take its hits: round 3 lost 5 runs that stood here, out of water, while one to four endermen hit
					// it (both sides ran this hold, so the fix applies to both).
					const close = hunters.filter(e => (e.distance ?? Infinity) <= 5 && e.stableId).sort((a, b) => a.distance - b.distance)[0];
					if (hunted && me.inWater !== true) {
						huntedSince = null;
						if (close) { const r = await act('fight_target', { targetId: close.stableId, timeoutMs: 8000, fleeAtHealth: 6 }); note('an enderman is after the body out of water: fight it', r); return true; }
					} else if (!hunted) huntedSince = null;
					else if (huntedSince === null || now() - huntedSince < 30000) {
						if (huntedSince === null) { huntedSince = now(); note('an enderman is after the body: holding still in the water', null); }
						await s.clock.sleep(1000);
						return true;
					}
					// Armed with the first crystal step: a fling on open ground can kill too (dragonFact).
					if (!clutchArmed) { const armed = await act('look_at', { x: me.x + 10, y: me.y + 30, z: me.z }, CLUTCH); clutchArmed = armed.state === 'SUCCEEDED'; note('arm the water clutch', armed); }
					else if ((o.inventory?.items ?? []).some(i => i.itemId === 'minecraft:bucket')) {
						await refill();
						// Still empty and no enderman after the body: back to the water it poured (the End fact names it), as a player
						// fills the bucket again before the next enderman (main: the bucket was empty in 8 of 9 enderman deaths).
						if (now() - lastFetch > 45000) { lastFetch = now(); await fetchWater(); }
					}
					if (await recover(o, me)) return true;
					let standing = [...seenCrystals.values()].filter(c => !c.gone && !c.gaveUp);
					// Given up on every one left: try them again after a while (the body and the dragon have moved). With no swing at
					// a perch while one stands (it heals the dragon), the wait is a third as long.
					if (standing.length === 0 && passes % (OLD_PERCH ? 30 : 10) === (OLD_PERCH ? 29 : 9)) for (const c of seenCrystals.values()) if (!c.gone) Object.assign(c, { gaveUp: false, tries: 0, spot: 0, cageTries: 0 });
					standing = [...seenCrystals.values()].filter(c => !c.gone && !c.gaveUp);
					if (standing.length === 0) return false;
					const d = c => Math.hypot(c.x - me.x, c.z - me.z);
					const c = standing.sort((a, b) => (CAGED_FIRST ? b.caged - a.caged : a.caged - b.caged) || d(a) - d(b))[0];
					if (c.caged) await openCage(c); else await openShot(c, me);
					return true;
				};
				// Waiting. While crystals may still be unseen or standing, it looks round for them and the dragon, at the sky: a level
				// gaze would meet endermen and provoke them, which a player avoids (the first baseline lost both kits to endermen while
				// the script swept the horizon). With every crystal down it watches the fountain, raised over the ground (endermen),
				// as a player waiting for the landing does: a perch out of view is never seen (the --perch watch, 3 of 3 perches with
				// the eyes on the sky: no head seen, no swing). --sky-wait keeps the sky sweep throughout.
				const waitLook = async me => {
					const crystalsOpen = seenCrystals.size < 10 && !PERCH || [...seenCrystals.values()].some(c => !c.gone);
					if (SKY_WAIT || crystalsOpen) {
						const turn = ((now() - t0) / 4000) % (2 * Math.PI);
						return act('look_at', { x: me.x + Math.cos(turn) * 20, y: me.y + 40, z: me.z + Math.sin(turn) * 20 });
					}
					return act('look_at', { x: 0.5, y: Math.max(me.y + 3, 66), z: 0.5 });
				};
				// 2. Perched: melee its head, as a player who ran in does (the fight and --perch rooms share it). True when it acted.
				const perchStep = async (o, me, entities) => {
					const perch = perchedDragon(o);
					// Not below 10 health: a player heals before walking under it, and steps out at 8 (fleeAtHealth); at 3 health
					// one hit of its head (10, about 6 through iron) kills.
					// With a crystal still standing (one seen and not broken), it heals the damage back: a player keeps off the perch.
					// Not hurt either (16 or more, PERCH_FACTS: one head hit is 10 before armour and the breath 6 a second), with no
					// angry enderman near, and only once the head is down within reach height (round 4: 'perched' 7-11 blocks up).
					const crystalUp = !OLD_PERCH && [...seenCrystals.values()].some(c => !c.gone);
					const headHigh = !OLD_PERCH && perch?.head && perch.head.y - me.y > 6 && Math.hypot(perch.head.x - me.x, perch.head.z - me.z) <= 20;
					const angryNear = !OLD_PERCH && entities.some(e => e?.type === 'minecraft:enderman' && e.alive !== false && e.targetingAgent === true && (e.distance ?? Infinity) <= 16);
					const holdOff = perch?.head?.id && !OLD_PERCH && (crystalUp || me.health < 16 || angryNear || headHigh);
					if (holdOff && now() - lastHoldNote > 10000) {
						lastHoldNote = now();
						note(crystalUp ? 'perched, not swinging: a crystal still stands' : `perched, not swinging: ${me.health < 16 ? `health ${Math.round(me.health)}` : angryNear ? 'an angry enderman near' : `head ${Math.round(perch.head.y - me.y)} up`}`, null);
					}
					// Arrows bounce off a perched dragon (PERCH_FACTS): held off, the body waits with its eyes on the sky.
					if (holdOff) { await act('look_at', { x: me.x, y: me.y + 40, z: me.z + 5 }); await s.clock.sleep(1000); return true; }
					if (perch?.head?.id && (OLD_REFILL || !(me.health < 10)) && (OLD_PERCH || !(crystalUp || me.health < 16 || angryNear || headHigh))) {
						// From the far side of the island fight_target refuses (its chase reach is 32 blocks to the head) and a short
						// perch ends during the walk: a player sprints in first, to 8 blocks short of the head on their own side, as
						// the facts say (a sprint covers about 5.6 blocks a second). Main's stand-in swung from where it stood.
						const flat = Math.hypot(perch.head.x - me.x, perch.head.z - me.z);
						if (!OLD_REFILL && flat > 20 && Number.isFinite(flat)) {
							const k = (flat - 8) / flat, tx = me.x + (perch.head.x - me.x) * k, tz = me.z + (perch.head.z - me.z) * k;
							const gy = await groundY(tx, tz).catch(() => NaN);
							const r = await act('travel_to', { x: tx, y: Number.isFinite(gy) && gy > 40 ? gy + 1 : Math.floor(me.y), z: tz, tolerance: 3, build: false, timeoutMs: 10000 });
							note(`run in to the perched head (${Math.round(flat)} blocks)`, r);
						}
						const before = await dragonHealth();
						const r = await act('fight_target', { targetId: perch.head.id, timeoutMs: 12000, ...(OLD_REFILL ? {} : { fleeAtHealth: OLD_PERCH ? 8 : 12 }) });
						const after = await dragonHealth();
						if (Number.isFinite(before) && Number.isFinite(after) && after < before) meleeLanded += 1;
						meleeHits += 1; note(`melee perched head (dragon ${before} -> ${after})`, r);
						// No spot to hit from (the breath covers the ground in front of the head): a player does not wait beside a
						// perched head, which swings round to face them (the perch watch: a 10 hit on a body left standing 1.7 from it).
						if (/TARGET_UNREACHABLE|NO_SEEN_ROUTE/.test(r.reasonCode ?? "")) {
							const v = await view().catch(() => null), p2 = v && perchedDragon(v), at = v?.player;
							const near = p2?.head && at ? Math.hypot(p2.head.x - at.x, p2.head.z - at.z) : Infinity;
							if (near < 6) {
								const ux = (at.x - p2.head.x) / near, uz = (at.z - p2.head.z) / near, tx = p2.head.x + ux * 9, tz = p2.head.z + uz * 9;
								const gy = await groundY(tx, tz).catch(() => NaN);
								note('step back from the perched head', await act('travel_to', { x: tx, y: Number.isFinite(gy) && gy > 40 ? gy + 1 : Math.floor(at.y), z: tz, tolerance: 2, build: false, timeoutMs: 5000 }));
							}
						}
						return true;
					}
					return false;
				};
				// --perch: the perch alone. Crystals and endermen are removed, the body stands on open ground PERCH_RADIUS blocks out
				// from the fountain, and the dragon is sent to land (DragonPhase 3) PERCHES times; the shared perch step plays each
				// perch. Judged per perch, from the landing order to the lift-off: the dragon's health drop (it cannot heal) and the
				// body's damage taken (the vanilla counter).
				const dragonPhase = async () => number(await end(s, 'data get entity @e[type=minecraft:ender_dragon,limit=1] DragonPhase'));
				const SITTING = [5, 6, 7];
				// The fine trace (judging only): every observation while a perch is played, so a hit taken mid-command is placed.
				let tracing = null, lastFine = -Infinity;
				s.bridge.on('observation', ev => {
					if (!tracing || ev.agentId !== record.agentId || !ev.payload?.ready || tracing.fine.length >= 600) return;
					try {
						const o = adaptObservation(ev.payload), me = o.player, t = now();
						if (!me || t - lastFine < 200) return;
						lastFine = t;
						const head = perchedDragon(o)?.head;
						tracing.fine.push([Math.round((t - t0) / 100) / 10, +me.health.toFixed(1), +me.x.toFixed(2), +me.y.toFixed(2), +me.z.toFixed(2), me.onGround === false ? 0 : 1, o.currentAction?.actionType ?? null, head ? [head.x, head.y, head.z] : null]);
					} catch { /* a trace never fails the run */ }
				});
				const perchRoom = async () => {
					row.perches = [];
					await end(s, 'kill @e[type=minecraft:end_crystal]');
					seenCrystals.clear();
					const angle = PERCH_ANGLE * Math.PI / 180;
					const sx = 0.5 + Math.cos(angle) * PERCH_RADIUS, sz = 0.5 + Math.sin(angle) * PERCH_RADIUS;
					const sy = await groundY(Math.floor(sx), Math.floor(sz));
					await end(s, `tp ${AGENT} ${sx} ${sy} ${sz}`);
					await s.clock.sleep(1500);
					for (let p = 0; p < PERCHES && await inWindow(); p++) {
						await end(s, 'kill @e[type=minecraft:enderman]').catch(() => {});
						const pr = { perch: p + 1, orderedAt: Math.round((now() - t0) / 100) / 10, sat: null, ended: null, phases: [], clouds: [], track: [], melee: [], fine: [] };
						tracing = pr;
						row.perches.push(pr);
						const damage0 = await readDamage(), dragon0 = await dragonHealth(), hp0 = (await view().catch(() => null))?.player?.health ?? null;
						await end(s, 'data merge entity @e[type=minecraft:ender_dragon,limit=1] {DragonPhase:3}');
						let lastPhase = null, lastTrack = -Infinity, ordered = now();
						const cloudsSeen = new Set();
						while (await inWindow()) {
							await end(s, 'kill @e[type=minecraft:enderman]').catch(() => {});
							const raw = await s.observe().catch(() => null);
							if (raw === null) { observeMisses += 1; continue; }
							if (raw.player?.dead === true || raw.status === 'PLAYER_DEAD' || (raw.world?.dimension && raw.world.dimension !== 'minecraft:the_end')) { dead = true; break; }
							const t = Math.round((now() - t0) / 100) / 10;
							const phase = await dragonPhase();
							if (phase !== lastPhase) { pr.phases.push([t, phase]); lastPhase = phase; }
							if (pr.sat === null && SITTING.includes(phase)) pr.sat = t;
							if (pr.sat !== null && !SITTING.includes(phase)) { pr.ended = t; break; }
							// Never sat within 40 s of the order (it lands from wherever it flies): ordered again, at most twice.
							if (pr.sat === null && now() - ordered > 40000) {
								if ((pr.reorders = (pr.reorders ?? 0) + 1) > 2) break;
								await end(s, 'data merge entity @e[type=minecraft:ender_dragon,limit=1] {DragonPhase:3}'); ordered = now();
							}
							// The breath clouds (judging only): where each lands, against where the body stands.
							const cloud = String(await end(s, 'data get entity @e[type=minecraft:area_effect_cloud,limit=1] Pos').catch(() => ''));
							const c = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(cloud);
							if (c && !cloudsSeen.has(c.slice(1).join())) { cloudsSeen.add(c.slice(1).join()); pr.clouds.push({ t, x: +(+c[1]).toFixed(1), y: +(+c[2]).toFixed(1), z: +(+c[3]).toFixed(1), body: raw.player ? [raw.player.x, raw.player.y, raw.player.z].map(v => +(+v).toFixed(1)) : null }); }
							let o = null;
							try { o = adaptObservation(raw); } catch { o = null; }
							if (!o?.player) { await s.clock.sleep(500); continue; }
							const me = o.player, perch = perchedDragon(o);
							if (now() - lastTrack >= 1000 && pr.track.length < 120) {
								lastTrack = now();
								pr.track.push({ t, phase, hp: me.health, me: [me.x, me.y, me.z].map(v => +v.toFixed(1)), head: perch?.head ? [perch.head.x, perch.head.y, perch.head.z] : null });
							}
							if (await perchStep(o, me, o.entities ?? [])) continue;
							await waitLook(me);
							await s.clock.sleep(500);
						}
						tracing = null;
						const damage1 = await readDamage(), dragon1 = await dragonHealth();
						pr.dealt = Number.isFinite(dragon0) && Number.isFinite(dragon1) ? Math.round((dragon0 - dragon1) * 10) / 10 : Number.isFinite(dragon0) && !Number.isFinite(dragon1) ? dragon0 : null;
						pr.lost = damageEvidence(damage0, damage1).damageTaken;
						pr.hpStart = hp0;
						pr.pass = pr.sat !== null && pr.ended !== null && !dead && pr.dealt >= PERCH_DEALT && Number.isFinite(pr.lost) && pr.lost < PERCH_LOST;
						console.log(`[dragon-fight] perch ${p + 1}: sat=${pr.sat} ended=${pr.ended} dealt=${pr.dealt} lost=${pr.lost} clouds=${pr.clouds.length} pass=${pr.pass}`);
						if (dead || !Number.isFinite(dragon1)) break;
						// Back to its holding pattern before the next order.
						await s.clock.sleep(8000);
					}
				};
				if (PERCH) await perchRoom();
				while (!PERCH && await inWindow()) {
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
					arrowsNow = arrows; arrowsStart ??= arrows;
					if (Number.isFinite(me.health)) { if (Number.isFinite(lastHp) && lastHp - me.health >= 4 && hurtLog.length < 30) hurtLog.push({ t: Math.round((now() - t0) / 1000), from: lastHp, to: me.health, y: Math.round(me.y), cmd: lastCommand?.actionType ?? null, hunger: me.hunger ?? null, fountain: Math.round(Math.hypot(me.x - 0.5, me.z - 0.5)) }); lastHp = me.health; }
					await trackCrystals();
					if (CRYSTAL && clearedAt !== null) { row.bucketAtClear = (o.inventory?.items ?? []).some(i => i.itemId === 'minecraft:water_bucket'); row.healthAtClear = me.health; break; }
					// 1. The crystals: positioned shots and opened cages; the old step shoots each once from where the body stands.
					if (ranged && !OLD_CRYSTALS && await crystalStep(o, me)) continue;
					const crystal = ranged && OLD_CRYSTALS ? entities.filter(row => row.type === 'minecraft:end_crystal' && !tried.has(row.stableId) && dist(row) <= 64)
						.sort((a, b) => dist(a) - dist(b))[0] : undefined;
					if (crystal) {
						tried.add(crystal.stableId);
						const r = await act('use_ranged', { targetId: crystal.stableId, drawDurationMs: 1100, timeoutMs: 6000 });
						shots += 1; if (r.state === 'SUCCEEDED' && /broke/.test(r.message) && !/something else/.test(r.message)) crystalBreaks += 1;
						note('shoot crystal', r); continue;
					}
					if (await perchStep(o, me, entities)) continue;
					// 3. In flight and close: shoot the nearest of its body and head (--head-aim: the head first, which takes an arrow's
					// full damage, every other part about a quarter). Only within 48 blocks (--range-cap: 26).
					const part = ranged ? entities.filter(row => row.type === 'minecraft:ender_dragon' && /^(body|head)$/.test(row.partName ?? '') && dist(row) <= (OLD_RANGE ? 48 : 26))
						.sort((a, b) => (OLD_AIM ? 0 : (a.partName === 'head' ? 0 : 1) - (b.partName === 'head' ? 0 : 1)) || dist(a) - dist(b))[0] : undefined;
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
					await waitLook(me);
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
					reflexFired: Object.fromEntries(Object.entries(firedMost).map(([id, n]) => [id, n - (firedStart[id] ?? 0)]).filter(([, n]) => n > 0)), log: log.slice(-400) });
				// The crystal phase's judged counts: caged and open crystals broken (from the server, not the shot receipts),
				// arrows spent, game seconds to clear all ten, and how the body died (the server's death message).
				await trackCrystals();
				// Arrows spent through the last command too (a dead body has dropped its bag: its count stays the last one seen).
				if (!row.died) { const last = await view().catch(() => null); const n = (last?.inventory?.items ?? []).filter(i => /^minecraft:(arrow|spectral_arrow|tipped_arrow)$/.test(i.itemId)).reduce((sum, i) => sum + i.count, 0); if (last?.inventory && Number.isFinite(n)) arrowsNow = n; }
				const cagedEnd = await cagedLeft().catch(() => NaN);
				Object.assign(row, { cagedBroken: cagedSpots.length - cagedEnd, openBroken: Number.isFinite(row.crystalsLeft) ? 10 - cagedSpots.length - (row.crystalsLeft - cagedEnd) : null,
					crystalsClearedAt: clearedAt, clutchArmed, arrowsUsed: Number.isFinite(arrowsStart) && Number.isFinite(arrowsNow) ? arrowsStart - arrowsNow : null, crystalTimeline, hurtLog,
					deathMessages: await readFile(path.join(out, 'server-0', 'server.log'), 'utf8').then(text => text.split('\n').filter(line => new RegExp(`System chat: ${AGENT} (was|fell|hit|died|blew|burned|tried|went|walked|drowned|experienced|froze|starved|suffocated|withered|didn)`).test(line)).map(line => line.replace(/^.*System chat: /, ''))).catch(() => null) });
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
				row.pass = SURVIVE ? !row.died && !row.voidFall : CRYSTAL ? !row.died && !row.voidFall && clearedAt !== null && row.bucketAtClear === true : PERCH ? !row.died && row.perches.length === PERCHES && row.perches.every(p => p.pass) : row.killed && !row.died;
					if (PERCH && !row.error && !row.died && row.perches.some(p => p.sat === null)) row.error = 'not exercised: the dragon never perched';
				row.failReason = row.pass ? null : row.died ? 'died' : row.voidFall ? 'void fall' : SURVIVE ? null : CRYSTAL ? (clearedAt === null ? 'crystals still up at the window end' : 'no water bucket when the last crystal broke') : PERCH ? 'a perch dealt under 40 or cost 4 or more' : Number.isFinite(row.killSeenLateMs) ? 'dragon killed after the window' : 'dragon alive at the window end';
				row.finishedAt = Date.now();
				console.log(`[dragon-fight] ${results.arm} run ${run}: ${row.error ? 'INVALID' : row.pass ? 'PASS' : 'FAIL'} killed=${killed} died=${row.died} dragon=${row.dragonHealthEnd} crystals=${row.crystalsLeft} cagedBroken=${row.cagedBroken} openBroken=${row.openBroken} arrows=${row.arrowsUsed} cleared=${row.crystalsClearedAt} shots=${shots} broke=${crystalBreaks} melee=${meleeHits} landed=${meleeLanded} flying=${flyingShots} lowest=${lowestDragon} dealt=${row.damageDealt} angered=${angerLog.length} damage=${row.damageTaken} game=${row.gameSeconds}s`);
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
