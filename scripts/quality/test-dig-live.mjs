#!/usr/bin/env node
// Provider-free dig_to check: node scripts/quality/test-dig-live.mjs SPOTS.json OUT_DIR [JAR]
// SPOTS.json: [{ name, seed, checkpoint?, x?, z?, y?, targetY?, heading?, pattern?, legs?, inventory?, extraItems?, digArgs?,
// fixture?, after?, travelTo? }], one fresh server per spot; travelTo {dx,dy,dz} calls travel_to that far from the start instead; a given y starts underground in a carved two-block pocket instead of on the
// surface; fixture commands place hazards; `inventory` replaces the kit (default iron pickaxe, spare stone pickaxe).
// Each spot puts the body on the surface at x/z (or the checkpoint position), with the checkpoint inventory (an
// iron pickaxe first) and full food, then calls dig_to directly over the bridge, leg after leg: a leg that stops for a
// reason a player would turn around for (lava, water, cave, loose blocks, no floor, stuck) is followed by another leg
// turned 90 degrees; a HOSTILE_NEAR leg is followed by a stand-in for the model's fight (the sensed monsters are
// removed by command and counted) and the same heading; TOOL_WORN by a stand-in for crafting a stone pickaxe (given by
// command, counted); DAMAGE_TAKEN and a timed-out call go on the same way. Up to `legs`. Reports per
// leg: wall time, blocks mined, blocks per minute, stop reason, health lost and deaths. No model call is made; operator commands build the fixture only. Launch under slot.sh live
// (SLOT_PORT_BASE) with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME. FIXTURE_TICK_RATE runs the server faster: each leg then
// reports gameSeconds (the action's own elapsed game time) beside wall seconds, and blocksPerGameMinute.
// `variant` compares ways down to the lava floors, each standing in for one model choice after every stop:
// - "shaft": dig_to shaft (steep_down below maxShaftY, default -20) to targetY; after a cave stop that dropped the body it
//   digs the shaft on from there; a stop with no progress (a deep drop or fluid seen below, loose blocks) gets one short
//   steep_down leg on a turned heading, then the shaft again.
// - "cave": the same shaft with throughCaves:false, so every cave met is handed back with the look-round facts; lava
//   seen there is walked to with travel_to, else the lowest seen floor below (stopWhenSeen minecraft:lava), else it digs on.
//   The spot ends once lava is perceivable within 16 blocks.
// - "steep": steep_down to targetY with the same stand-ins as "shaft" (the comparison's control).
// - none: `pattern` leg after leg as before.
// Each row adds lavaWithin16 (first lava within 16 blocks: minute into the spot's action time, where, how far), fallsIntoLava.
// A spot passes with no death or lava fall and exactly expectDamageTaken HP (default 0), when it reached targetY or, for a spot built to
// stop (`expectCode`: one code or a list, e.g. LAVA_AHEAD beside covered lava), its last leg stopped for that reason.
// Every spot recorded to stop on purpose carries its expectCode; without one, reaching targetY is the rule. Exit code
// (strict, the default): 0 all passed, 1 a spot failed, 2 invalid evidence (a spot errored, never ran or its health
// could not be read). --descriptive reports only.
// Climb-out rooms (climb-out-spots.json): `expectEndDy: [min, max]` replaces the goal rule with where the feet ended,
// relative to the start feet y, and `maxPlaced` caps the cobblestone the body placed (vanilla's used-item statistic,
// reported as row.placed). DIG_ONLY=a,b runs only those spots.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { finishRun, EDIT_LOOP_HELP, FIXTURE_OUTCOME_HELP } from './lib/fixture-run.mjs';
import { damageCounter, damageEvidence, matchesDamageExpectation, deathCounter, deathEvidence, scoreboardCounter } from './lib/damage-counter.mjs';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { fixtureTickRate } from './watch-replay.mjs';
import { warmBoots } from './fixture-servers.mjs';
import { MOD_JAR } from './mod-jar.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: test-dig-live.mjs SPOTS.json OUT_DIR [JAR] [--strict|--descriptive] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE + '\n' + EDIT_LOOP_HELP + '\n' + FIXTURE_OUTCOME_HELP); process.exit(0); }
const strict = !cli.includes('--descriptive');
const [spotsFile, outArg, jarArg] = cli.filter(arg => !['--strict', '--descriptive'].includes(arg));
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!spotsFile || !outArg || !template || !port || !process.env.JAVA_HOME) { console.error(USAGE); process.exit(2); }
const only = process.env.DIG_ONLY ? new Set(process.env.DIG_ONLY.split(',')) : null;
const spots = JSON.parse(await readFile(spotsFile, 'utf8')).filter(spot => !only || only.has(spot.name));
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Probe';
const TURN = { east: 'south', south: 'west', west: 'north', north: 'east' };
// Stops after which a player digging down turns and digs on; the rest end the spot.
const TURN_STOPS = new Set(['LAVA_AHEAD', 'WATER_AHEAD', 'CAVE_OPENING', 'FALLING_BLOCKS', 'NO_FLOOR', 'DIG_STUCK', 'UNBREAKABLE']);
const SAME_STOPS = new Set(['HOSTILE_NEAR', 'DAMAGE_TAKEN', 'ACTION_TIMED_OUT', 'TOOL_WORN']);
const MONSTERS = ['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
	'witch', 'enderman', 'slime', 'silverfish', 'phantom', 'pillager', 'vindicator', 'breeze'];
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const results = [];

// One fresh server per spot: the fixture goal is a 20-minute survival that cannot be restarted on the same body.
// The next spot's server boots while this one plays, from the seed's cached world.
const cases = [];
for (const [index, raw] of spots.entries()) cases.push([index, raw, raw.checkpoint ? JSON.parse(await readFile(raw.checkpoint, 'utf8')) : null]);
for await (const { item: [, raw, checkpoint], server: s, error: bootError } of warmBoots(cases, ([index, raw, checkpoint]) => ({ dir: path.join(out, `spot-${index}`),
	options: { jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), template, port, world: null, seed: String(raw.seed ?? checkpoint?.seed), tickRate: fixtureTickRate(), worldCache: true } }))) {
	const seed = String(raw.seed ?? checkpoint?.seed);
	const seedSpots = [{ ...raw, checkpointData: checkpoint }];
	const startedAt = Date.now();
	if (!s) { results.push({ name: raw.name, seed, startedAt, error: String(bootError?.stack ?? bootError).slice(0, 1200) }); continue; }
	const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const health = async () => number(await s.command(`data get entity ${AGENT} Health`));
	const deaths = () => deathCounter(text => s.command(text), AGENT, { objective: 'deaths', unsetIsZero: true });
	// dig_to legs run for minutes: the bridge act helper waits 65 s, so this one waits for the action's own timeout.
	const dig = async (args, actionType = 'dig_to') => {
		const id = `dig-${++s.ordinal}`;
		const payload = { actionId: id, traceId: id, goalRevision: s.record.goalRevision, actionType, arguments: args,
			provenance: { provider: s.record.provider, model: s.record.model, reasoningEffort: s.record.reasoningEffort, serviceTier: s.record.serviceTier, traceId: id, programId: 'dig-live', programVersion: 1, sourceStepId: id, eventSequence: s.observation?.eventSequence ?? 0 } };
		const next = s.inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), args.timeoutMs * Math.max(1, 20 / s.tickRate) + 30_000);
		await s.bridge.send('action_command', s.record.agentId, payload);
		const r = (await next).payload;
		await s.bridge.send('action_result_ack', s.record.agentId, { actionId: id, goalRevision: s.record.goalRevision });
		return r;
	};
	try {
		await s.normalRate();
		let e = null;
		for (let attempt = 0; attempt < 3 && !e; attempt++) {
			const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
			// On the ground at the first spot: a body summoned in the air over an ocean drowned before its goal started.
			const first = seedSpots[0], fx = first.x ?? first.checkpointData?.setup.position[0] ?? 0, fz = first.z ?? first.checkpointData?.setup.position[2] ?? 0;
			await s.command(`forceload add ${Math.floor(fx)} ${Math.floor(fz)}`);
			for (let wait = 0; wait < 600 && !/time is/i.test(await s.command(`execute if loaded ${Math.floor(fx)} 0 ${Math.floor(fz)} run time query gametime`)); wait++) await sleep(100);
			console.log(`summon: ${await s.command(`execute positioned ${fx} 0 ${fz} positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${AGENT}`)}`);
			e = await registered;
		}
		if (!e) throw new Error('agent never registered');
		s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		const command = async text => ({ text: await s.command(text) });
		for (const spot of seedSpots) {
			const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start', 120_000);
			await s.command(`mineagen start ${AGENT} Survive for 1200 seconds.`);
			s.record.goalRevision = (await started).payload.goalRevision;
			await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
			const base = spot.checkpointData?.setup ?? { dimension: 'minecraft:overworld', inventory: [{ item: 'minecraft:iron_pickaxe', count: 1 }], generality: true, groundBelowCanopy: true };
			const inventory = spot.inventory ?? [{ item: 'minecraft:iron_pickaxe', count: 1 }, { item: 'minecraft:stone_pickaxe', count: 1 },
				...(base.inventory ?? []).filter(item => !/_pickaxe$/.test(item.item)), ...(spot.extraItems ?? [])];
			const setup = { ...base, inventory, mobs: [], commands: [], freezeUntilGoalStart: true, generality: true,
				position: [spot.x ?? base.position[0], spot.y ?? 100, spot.z ?? base.position[2]], surface: spot.y === undefined };
			const row = { name: spot.name, seed, legs: [], startedAt };
			results.push(row);
			try {
				if (spot.y !== undefined) {
					const [cx, cz] = [Math.floor(setup.position[0]), Math.floor(setup.position[2])];
					await s.command(`forceload add ${cx} ${cz}`);
					for (let wait = 0; wait < 600 && !/time is/i.test(await s.command(`execute if loaded ${cx} 0 ${cz} run time query gametime`)); wait++) await sleep(100);
					await s.command(`fill ${cx} ${spot.y} ${cz} ${cx} ${spot.y + 1} ${cz} minecraft:air`);
					await s.command(`setblock ${cx} ${spot.y - 1} ${cz} minecraft:deepslate`);
					setup.position = [cx + 0.5, spot.y, cz + 0.5];
					setup.groundBelowCanopy = false;
				}
				const receipt = await applyQualitySetup(setup, command, AGENT);
				await activateQualitySetup(receipt, command, { stage: 'goal-start' });
				await activateQualitySetup(receipt, command, { stage: 'first-decision' });
				await s.command('tick unfreeze').catch(() => {});
				await s.command('difficulty normal');
				await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
				// Hazard fixture: commands with {x}/{y}/{z} (optionally {x+2}) at the start feet cell, e.g. hidden lava on the path.
				const [fx0, fy0, fz0] = (await pos()).map(Math.floor);
				for (const text of spot.fixture ?? []) {
					const at = { x: fx0, y: fy0, z: fz0 };
					row.fixture = [...(row.fixture ?? []), await s.command(text.replace(/\{([xyz])([+-]\d+)?\}/g, (_, axis, offset) => String(at[axis] + Number(offset ?? 0))))];
				}
				await s.idleSleep(2000);
				row.start = await pos();
				const deathsBefore = await deaths();
				const readDamage = await damageCounter(text => s.command(text), AGENT);
				const damageBefore = await readDamage(), healthBefore = await health();
				if (spot.maxPlaced !== undefined) await s.command('scoreboard objectives add placed minecraft.used:minecraft.cobblestone');
				const placedBefore = spot.maxPlaced === undefined ? null : await scoreboardCounter(text => s.command(text), AGENT, 'placed', { unsetIsZero: true });
				let heading = spot.heading ?? 'east';
				row.standIns = 0;
				await s.fastRate();
				const spotStart = Date.now(), timer = await s.gameTimer();
				const targetY = spot.targetY ?? -55;
				const variant = spot.variant ?? null;
				let actionSeconds = 0, detour = false, walkTo = null, away = false, stuck = 0;
				row.variant = variant;
				row.fallsIntoLava = 0;
				for (let leg = 0; leg < (spot.legs ?? 4); leg++) {
					const before = { at: await pos(), health: await health(), t: Date.now() };
					let args, actionType = 'dig_to';
					if (spot.travelTo) {
						// A travel_to whose way on is a staircase (the trip-to-dig handoff), aimed relative to the start feet cell.
						const [sx, sy, sz] = row.start.map(Math.floor);
						actionType = 'travel_to';
						args = { x: sx + spot.travelTo.dx + 0.5, y: sy + spot.travelTo.dy, z: sz + spot.travelTo.dz + 0.5, tolerance: 1, timeoutMs: 180_000, ...(spot.digArgs ?? {}) };
					} else if (walkTo) {
						actionType = 'travel_to';
						args = { x: walkTo.x, y: walkTo.y, z: walkTo.z, tolerance: walkTo.tolerance, stopWhenSeen: 'minecraft:lava', timeoutMs: 180_000 };
					} else if (variant && away) {
						args = { pattern: 'tunnel', heading, maxBlocks: 16, timeoutMs: 600_000 };
					} else if (variant && detour) {
						args = { pattern: 'steep_down', y: Math.max(targetY, Math.floor(before.at?.[1] ?? 0) - 8), heading, timeoutMs: 600_000 };
					} else if (variant === 'steep') {
						args = { pattern: 'steep_down', y: targetY, heading, timeoutMs: 600_000 };
					} else if (variant) {
						args = { pattern: 'shaft', y: targetY, heading, maxShaftY: spot.maxShaftY ?? -20, timeoutMs: 600_000, ...(variant === 'cave' ? { throughCaves: false } : {}) };
					} else {
						args = { pattern: spot.pattern ?? 'stairs_down', y: targetY, heading, timeoutMs: 600_000, ...(spot.digArgs ?? {}) };
					}
					if (args.y === null) delete args.y;
					const wasWalk = Boolean(walkTo), wasDetour = detour, wasAway = away;
					walkTo = null;
					detour = false;
					away = false;
					const r = await dig(args, actionType);
					const after = { at: await pos(), health: await health(), deaths: await deaths() };
					const seconds = (Date.now() - before.t) / 1000, gameSeconds = Number.isFinite(r.elapsedMs) ? r.elapsedMs / 1000 : null;
					const blocks = Number(/; (\d+) blocks mined/.exec(r.message ?? '')?.[1] ?? NaN);
					// Lava within 16 blocks: the dig's own first sighting, travel_to's stopWhenSeen, or a walk that ended near seen lava.
					const firstDig = /lava first seen at (-?\d+),(-?\d+),(-?\d+), ([\d.]+) blocks away, (\d+) s into the dig/.exec(r.message ?? '');
					const seenTravel = r.reasonCode === 'TARGET_SEEN' ? /minecraft:lava seen at (-?\d+),(-?\d+),(-?\d+), ([\d.]+) blocks away/.exec(r.message ?? '') : null;
					const lookLava = /lava seen at (-?\d+),(-?\d+),(-?\d+), ([\d.]+) blocks away/.exec(r.message ?? '');
					if (!row.lavaWithin16) {
						if (firstDig) row.lavaWithin16 = { minute: +((actionSeconds + Number(firstDig[5])) / 60).toFixed(2), at: firstDig.slice(1, 4).map(Number), distance: Number(firstDig[4]), how: actionType };
						else if (seenTravel && Number(seenTravel[4]) <= 16) row.lavaWithin16 = { minute: +((actionSeconds + seconds) / 60).toFixed(2), at: seenTravel.slice(1, 4).map(Number), distance: Number(seenTravel[4]), how: 'travel_to' };
						else if (wasWalk && row.lavaTarget && after.at && Math.hypot(...row.lavaTarget.map((v, i) => v + 0.5 - after.at[i])) <= 16)
							row.lavaWithin16 = { minute: +((actionSeconds + seconds) / 60).toFixed(2), at: row.lavaTarget, distance: +Math.hypot(...row.lavaTarget.map((v, i) => v + 0.5 - after.at[i])).toFixed(1), how: 'travel_to' };
					}
					actionSeconds += seconds;
					if (r.reasonCode === 'IN_LAVA' || /\(lava\)|\(inFire\)|\(onFire\)|IN_LAVA/.test(r.message ?? '')) row.fallsIntoLava++;
					row.legs.push({ actionType, pattern: args.pattern, heading, state: r.state, reasonCode: r.reasonCode, seconds: Math.round(seconds), blocks,
						blocksPerMinute: Number.isFinite(blocks) ? Math.round(blocks / seconds * 60) : null,
						gameSeconds: gameSeconds === null ? null : Math.round(gameSeconds), blocksPerGameMinute: Number.isFinite(blocks) && gameSeconds ? Math.round(blocks / gameSeconds * 60) : null,
						fromY: Math.floor(before.at?.[1]), toY: Math.floor(after.at?.[1]), healthLost: Math.max(0, before.health - after.health),
						deaths: after.deaths - deathsBefore, message: r.message });
					console.log(`[${spot.name}] leg ${leg} ${actionType} ${args.pattern ?? ''} ${heading}: ${r.state} ${r.reasonCode} ${Math.round(seconds)} s y${Math.floor(before.at?.[1])}->${Math.floor(after.at?.[1])} ${blocks} blocks`);
					if (after.deaths > deathsBefore || r.reasonCode === 'IN_LAVA') break;
					if (variant === 'cave' && row.lavaWithin16) break;
					if (variant) {
						const progressed = Math.floor(after.at?.[1] ?? 0) < Math.floor(before.at?.[1] ?? 0);
						stuck = progressed || wasWalk || wasAway ? 0 : stuck + 1;
						const reachedY = Math.floor(after.at?.[1] ?? 999) <= targetY;
						if (variant === 'cave' && r.reasonCode === 'CAVE_OPENING' && !wasWalk) {
							const floor = /lowest floor seen (-?\d+),(-?\d+),(-?\d+)/.exec(r.message ?? '');
							if (lookLava) {
								row.lavaTarget = lookLava.slice(1, 4).map(Number);
								walkTo = { x: row.lavaTarget[0], y: row.lavaTarget[1], z: row.lavaTarget[2], tolerance: 8 };
								continue;
							}
							if (floor) { walkTo = { x: Number(floor[1]), y: Number(floor[2]), z: Number(floor[3]), tolerance: 2 }; continue; }
						}
						if (variant === 'cave' && seenTravel) {
							row.lavaTarget = seenTravel.slice(1, 4).map(Number);
							walkTo = { x: row.lavaTarget[0], y: row.lavaTarget[1], z: row.lavaTarget[2], tolerance: 8 };
							continue;
						}
						if (reachedY) break;
						if (r.reasonCode === 'HOSTILE_NEAR') {
							for (const type of MONSTERS) await s.command(`execute at ${AGENT} run kill @e[type=minecraft:${type},distance=..24]`);
							row.standIns++;
							continue;
						}
						if (r.reasonCode === 'TOOL_WORN' && /tool for minecraft:\w+_ore has/.test(r.message ?? '')) {
							heading = TURN[heading];
							detour = true;
							continue;
						}
						if (r.reasonCode === 'TOOL_WORN') {
							await s.command(`item replace entity ${AGENT} hotbar.8 with minecraft:stone_pickaxe`);
							row.standIns++;
							continue;
						}
						if (r.reasonCode === 'NO_WATER_BUCKET') {
							// Stand-in for refilling the bucket at the nearest water.
							await s.command(`item replace entity ${AGENT} hotbar.2 with minecraft:water_bucket`);
							row.standIns++;
							continue;
						}
						if (/under water|\(drown\)/.test(r.message ?? '')) { row.decision = r.reasonCode; break; }
						if (/body of water/.test(r.message ?? '') && !wasAway) { heading = TURN[heading]; away = true; stuck = 0; continue; }
						if (wasWalk || wasAway || ['DAMAGE_TAKEN', 'ACTION_TIMED_OUT', 'DIG_LIMIT_REACHED'].includes(r.reasonCode)) continue;
						if (stuck >= 2) { heading = TURN[heading]; away = true; stuck = 0; continue; }
						if (wasDetour && r.reasonCode === 'DIG_GOAL_REACHED' || r.reasonCode === 'CAVE_OPENING' && progressed && !wasDetour) continue;
						// A stop with no way on down here: one short steep_down leg on a turned heading, then the shaft again.
						heading = TURN[heading];
						detour = true;
						continue;
					}
					if (r.state === 'SUCCEEDED' || !(TURN_STOPS.has(r.reasonCode) || SAME_STOPS.has(r.reasonCode)) || after.deaths > deathsBefore) break;
					// A body of water or a body under water is the model's call (leave, swim up): the spot ends there.
					if (/body of water|under water|\(drown\)/.test(r.message ?? '')) { row.decision = r.reasonCode; break; }
					if (r.reasonCode === 'HOSTILE_NEAR') {
						// Stand-in for the model's fight: remove the monsters near the body, then dig on the same way.
						for (const type of MONSTERS) await s.command(`execute at ${AGENT} run kill @e[type=minecraft:${type},distance=..24]`);
						row.standIns++;
					} else if (r.reasonCode === 'TOOL_WORN' && /tool for minecraft:\w+_ore has/.test(r.message ?? '')) {
						// An ore only the worn pickaxe could harvest: as a player keeping it for later, dig on around it.
						heading = TURN[heading];
					} else if (r.reasonCode === 'TOOL_WORN') {
						// Stand-in for the model crafting a stone pickaxe from the cobblestone it dug (a table and sticks away).
						await s.command(`item replace entity ${AGENT} hotbar.8 with minecraft:stone_pickaxe`);
						row.standIns++;
					} else if (TURN_STOPS.has(r.reasonCode)) heading = TURN[heading];
				}
				row.end = await pos();
				row.seconds = Math.round((Date.now() - spotStart) / 1000);
				row.gameSeconds = Math.round(row.legs.reduce((sum, leg) => sum + (leg.gameSeconds ?? 0), 0));
				const rates = await timer.rates();
				await s.normalRate();
				row.tick = { ...rates, held: await s.tickReport() };
				row.actionSeconds = Math.round(actionSeconds);
				row.blocks = row.legs.reduce((sum, leg) => sum + (Number.isFinite(leg.blocks) ? leg.blocks : 0), 0);
				row.blocksPerMinute = actionSeconds ? Math.round(row.blocks / actionSeconds * 60) : null;
				const deathResult = deathEvidence(deathsBefore, await deaths());
				row.deaths = deathResult.deaths;
				if (!deathResult.valid) (row.integrity ??= []).push({ file: 'deaths', error: 'Missing or decreasing vanilla death counter' });
				row.reached = (spot.pattern ?? 'stairs_down') === 'stairs_up' ? Math.floor(row.end?.[1] ?? -999) >= targetY
					: row.legs.some(leg => leg.reasonCode === 'DIG_GOAL_REACHED') || Math.floor(row.end?.[1] ?? 999) <= targetY;
				row.legsToReach = row.reached ? row.legs.length : null;
				row.healthLost = row.legs.reduce((sum, leg) => sum + leg.healthLost, 0);
				Object.assign(row, damageEvidence(damageBefore, await readDamage(), healthBefore, await health()));
				for (const text of spot.after ?? []) row.after = [...(row.after ?? []), await s.command(text.replace(/\{AGENT\}/g, AGENT))];
				row.finishedAt = Date.now();
				if (!Number.isFinite(row.healthLost) || !Number.isFinite(row.deaths)) throw new Error('health or deaths unreadable over RCON');
				const expected = [spot.expectCode].flat().filter(Boolean);
				if (spot.maxPlaced !== undefined) {
					const placedAfter = await scoreboardCounter(text => s.command(text), AGENT, 'placed', { unsetIsZero: true });
					if (!Number.isSafeInteger(placedBefore) || !Number.isSafeInteger(placedAfter)) throw new Error('placed counter unreadable over RCON');
					row.placed = placedAfter - placedBefore;
				}
				row.endDy = Math.floor(row.end?.[1] ?? NaN) - Math.floor(row.start?.[1] ?? NaN);
				const ended = spot.expectEndDy ? row.endDy >= spot.expectEndDy[0] && row.endDy <= spot.expectEndDy[1] : true;
				const met = (expected.length ? expected.includes(row.legs.at(-1)?.reasonCode) : spot.expectEndDy ? true : row.reached)
					&& ended && (spot.maxPlaced === undefined || row.placed <= spot.maxPlaced);
				row.expectedDamageTaken = spot.expectDamageTaken === undefined ? 0 : spot.expectDamageTaken;
				row.pass = Boolean(matchesDamageExpectation(row, row.expectedDamageTaken) && met && row.deaths === 0 && row.fallsIntoLava === 0);
			} catch (error) {
				row.error = String(error?.stack ?? error);
				console.log(`[${spot.name}] error ${row.error}`);
			}
			await writeFile(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
		}
	} catch (error) {
		// Registration or goal start failed before the spot's row existed: an invalid row, not a silent gap.
		if (!results.some(row => row.name === raw.name)) results.push({ name: raw.name, seed, startedAt, error: String(error?.stack ?? error).slice(0, 1200) });
		console.log(`[${raw.name}] error ${String(error?.message ?? error)}`);
	} finally {
		// Stopping deletes the world (ARENA_FIXTURE_KEEP=1 keeps it); the result rows and server.log are what the report needs.
		await s.stop();
	}
}
console.log(JSON.stringify(results.map(({ name, reached, deaths, seconds, legs, error, standIns, pass, tick, endDy, placed }) => ({ name, pass, reached, endDy, placed, deaths, seconds, standIns, tick, error: error?.slice(0, 200),
	legs: legs?.map(({ message, ...leg }) => leg) })), null, 2));
const report = await finishRun(results, { file: path.join(out, 'result.json'), planned: spots.length, strict });
console.log(JSON.stringify(report));
process.exit(report.exitCode);
