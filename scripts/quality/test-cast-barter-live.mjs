#!/usr/bin/env node
// Provider-free check of the model-chosen goal skills cast_obsidian and barter_until through the production action path.
//   node scripts/quality/test-cast-barter-live.mjs cast-count CHECKPOINT.json OUT_DIR [JAR]   (lava-pool: >= 4 new obsidian)
//   node scripts/quality/test-cast-barter-live.mjs cast-frame CHECKPOINT.json OUT_DIR [JAR]   (lava-half-frame: complete 4x5 frame)
//   node scripts/quality/test-cast-barter-live.mjs barter FIXTURE.json OUT_DIR [JAR]          (piglin room: items gained, count matches inventory)
//   node scripts/quality/test-cast-barter-live.mjs portal CHECKPOINT.json OUT_DIR [JAR]       (frame, light, step in: Nether within 6 min)
//     portal mode: PORTAL_SITE=x,y,z,axis is the site a model sent (default: the half-frame origin). It plays the sequence
//     the model played in the live runs that entered: cast_obsidian frame:true (once more with the same site if it fails
//     and time is left), select flint_and_steel, interact_block on a bottom cell's up face, move_to into the opening, wait.
// Boots the save point's seed, applies its setup with the production applyQualitySetup, looks at the pool (as the model
// would before naming it), sends one action and checks the world with operator reads. No model call is made; operator
// commands build the fixture and read the outcome only. Launch under fix-slot.sh (SLOT_PORT_BASE) with
// ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME. RANDOM_SALT=N reseeds loot rolls for barter trials.
// FIXTURE_TICK_RATE runs the action faster: setup, the look at the pool and the operator reads before and after (obsidian
// counts, block maps) stay at 20 TPS; the action and, in portal mode, its 360 s window, the model's answer waits and the
// last wait for the portal are game time on the fixture clock (s.clock). result.seconds is game seconds; result.tick
// records wallSeconds and the rates.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { boot, unshownTickRate } from './watch-replay.mjs';
import { MOD_JAR } from './mod-jar.mjs';
import { damageCounter, damageEvidence, deathCounter, deathEvidence } from './lib/damage-counter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [mode, fixtureFile, outArg, jarArg] = process.argv.slice(2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!['cast-count', 'cast-frame', 'barter', 'portal'].includes(mode) || !fixtureFile || !outArg || !template || !port || !process.env.JAVA_HOME)
	throw new Error('Usage: cast-count|cast-frame|barter FIXTURE.json OUT_DIR [JAR] under fix-slot.sh with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
// A partial-frame save point names its starting obsidian; the frame origin is their lowest corner, the axis the one they span.
if ((mode === 'cast-frame' || mode === 'portal') && !fixture.frame && fixture.initialObsidian?.length) {
	const cells = fixture.initialObsidian, sameZ = cells.every(c => c[2] === cells[0][2]);
	fixture.frame = { axis: sameZ ? 'x' : 'z', origin: [Math.min(...cells.map(c => c[0])), Math.min(...cells.map(c => c[1])), Math.min(...cells.map(c => c[2]))] };
}
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Probe';
const result = { mode, fixture: path.basename(fixtureFile), salt: process.env.RANDOM_SALT ?? null, tickRate: unshownTickRate('it already fails at 20 TPS, so an A/B cannot show the same game at 60') };
const s = await boot(out, { jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), template, port, world: null, seed: fixture.seed, readyTimeoutMs: 90000, tickRate: unshownTickRate('it already fails at 20 TPS, so an A/B cannot show the same game at 60') });
const count = text => Number(/count: (\d+)/i.exec(String(text))?.[1] ?? 0);
const held = async item => count(await s.command(`execute if items entity ${AGENT} container.* ${item}`));
const isBlock = async (dim, [x, y, z], block) => /passed/i.test(String(await s.command(`execute in ${dim} if block ${x} ${y} ${z} ${block}`)));
async function act(type, args, ms) {
	const id = `skill-${++s.ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: s.record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: s.record.provider, model: s.record.model, reasoningEffort: s.record.reasoningEffort, serviceTier: s.record.serviceTier, traceId: id, programId: 'skill-test', programVersion: 1, sourceStepId: id, eventSequence: s.observation?.eventSequence ?? 0 } };
	const next = s.inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), ms);
	await s.bridge.send('action_command', s.record.agentId, payload);
	const r = (await next).payload;
	await s.bridge.send('action_result_ack', s.record.agentId, { actionId: id, goalRevision: s.record.goalRevision });
	return { state: r.state, reasonCode: r.reasonCode, message: r.message };
}
// Play: the rate goes up and the clock starts; endPlay records the rates and brings the server back to 20.
const now = () => s.clock.now();
let wall0 = null, timer = null, readDamage = null, damageBefore = null, deathsBefore = null;
const deaths = () => deathCounter(text => s.command(text), AGENT, { objective: 'deaths', unsetIsZero: true });
async function startPlay() {
	// Harm evidence (vanilla's cumulative damage and death counters), read at 20 before the rate goes up.
	readDamage ??= await damageCounter(text => s.command(text), AGENT);
	damageBefore = await readDamage(); deathsBefore = await deaths();
	await s.fastRate(); wall0 = Date.now(); timer = await s.gameTimer(); return now();
}
async function endPlay() {
	if (!timer) return;
	result.tick = { rate: s.tickRate, wallSeconds: Math.round((Date.now() - wall0) / 1000), gameSeconds: Math.round((await timer.elapsed()) / 1000), rates: await timer.rates().catch(() => null) };
	timer = null;
	await s.normalRate();
	result.tick.held = await s.tickReport();
	const { damageTaken, integrity } = damageEvidence(damageBefore, await readDamage(), null, null);
	result.harm = { damageTaken, ...(integrity ? { integrity } : {}), deaths: deathEvidence(deathsBefore, await deaths()).deaths };
}
async function obsidianIn(dim, [x0, y0, z0], [x1, y1, z1]) {
	const cells = [];
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++)
		if (await isBlock(dim, [x, y, z], 'minecraft:obsidian')) cells.push([x, y, z]);
	return cells;
}
try {
	let e = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
		result.summon = await s.command(`execute positioned 0.5 200 0.5 run mineagen summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${result.summon}`);
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`mineagen start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const command = async text => ({ text: await s.command(text) });
	let setup = { ...fixture.setup, ...(process.env.RANDOM_SALT ? { randomSalt: Number(process.env.RANDOM_SALT) } : {}) };
	let room = null;
	if (mode === 'barter') {
		// Nether wastes found from the seed; a sealed netherrack room keeps lava and wandering mobs out.
		const located = await s.command(`execute in minecraft:the_nether positioned 0 70 0 run locate biome ${fixture.room.biome}`);
		const m = /\[(-?\d+),\s*(~|-?\d+),\s*(-?\d+)\]/.exec(located);
		if (!m) throw new Error(`locate failed: ${located}`);
		const [x, y, z] = [Number(m[1]), fixture.room.y, Number(m[3])];
		const r = fixture.room.half;
		room = { at: [x, y, z], located };
		setup = { ...setup, position: [x + 0.5, y, z + 0.5], commands: [
			`execute in minecraft:the_nether run forceload add ${x - 16} ${z - 16} ${x + 16} ${z + 16}`,
			`execute in minecraft:the_nether run fill ${x - r - 1} ${y - 1} ${z - r - 1} ${x + r + 1} ${y + 4} ${z + r + 1} minecraft:netherrack`,
			`execute in minecraft:the_nether run fill ${x - r} ${y} ${z - r} ${x + r} ${y + 3} ${z + r} minecraft:air`,
			`execute in minecraft:the_nether run setblock ${x} ${y + 3} ${z} minecraft:glowstone`,
		] };
	}
	const receipt = await applyQualitySetup(setup, command, AGENT);
	await activateQualitySetup(receipt, command, { stage: 'goal-start' });
	await activateQualitySetup(receipt, command, { stage: 'first-decision' });
	await s.command('tick unfreeze').catch(() => {});
	await s.command('difficulty normal');
	const dim = setup.dimension;
	result.start = String(await s.command(`data get entity ${AGENT} Pos`));
	await s.observe();
	if (mode === 'barter') {
		const [x, y, z] = room.at;
		for (const [i, [dx, dz]] of fixture.room.piglins.entries())
			await s.command(`execute in minecraft:the_nether run summon minecraft:piglin ${x + dx + 0.5} ${y} ${z + dz + 0.5} {PersistenceRequired:1b,IsImmuneToZombification:1b,UUID:[I;0,0,7,${i + 1}]}`);
		await s.idleSleep(2000);
		const o = await s.observe();
		result.piglinsSeen = (o.entities ?? []).filter(row => row.type === 'minecraft:piglin').length;
		result.before = { wanted: await held(fixture.item), gold: await held('minecraft:gold_ingot') };
		const t0 = await startPlay();
		result.action = await act('barter_until', { itemId: fixture.item, count: fixture.count, timeoutMs: fixture.timeoutMs }, fixture.timeoutMs + 30000);
		result.seconds = Math.round((now() - t0) / 1000);
		// Inventory first, as before: the verdict compares it with the reported count, and items keep arriving.
		result.after = { wanted: await held(fixture.item), gold: await held('minecraft:gold_ingot') };
		await endPlay();
		const reported = Number(new RegExp(`${fixture.item} gained: (\\d+)`).exec(result.action.message ?? '')?.[1] ?? NaN);
		const thrown = Number(/gold ingots thrown (\d+)/.exec(result.action.message ?? '')?.[1] ?? NaN);
		const gainedAll = /all items gained: (.*)$/.exec(result.action.message ?? '')?.[1] ?? '';
		result.check = { reported, actual: result.after.wanted - result.before.wanted, thrown, goldSpent: result.before.gold - result.after.gold, gainedAll };
		result.ok = result.check.reported === result.check.actual && gainedAll !== 'none' && gainedAll !== ''
			&& ['BARTER_COUNT_REACHED', 'OUT_OF_GOLD', 'BARTER_TIMED_OUT'].includes(result.action.reasonCode);
	} else if (mode === 'portal') {
		const edge = fixture.lavaPool.edge;
		const named = process.env.PORTAL_SITE?.split(',');
		const site = named ? { origin: named.slice(0, 3).map(Number), axis: named[3] ?? 'x' } : fixture.frame;
		if (!site) throw new Error('portal mode needs PORTAL_SITE or a half-frame save point');
		await s.command('scoreboard objectives add probeDeaths deathCount');
		await act('look_at', { x: edge[0] + 0.5, y: edge[1] + 0.5, z: edge[2] + 0.5 }, 10000);
		await s.observe(); await sleep(500); await s.observe();
		// PORTAL_DUMP=x0,y0,z0,x1,y1,z1: a block map (operator reads) before the cast and at the end, for diagnosis only.
		const dumpBox = process.env.PORTAL_DUMP?.split(',').map(Number);
		const KINDS = [['.', 'minecraft:air'], ['L', 'minecraft:lava'], ['S', 'minecraft:water[level=0]'], ['W', 'minecraft:water'], ['O', 'minecraft:obsidian'], ['c', 'minecraft:cobblestone'], ['d', 'minecraft:deepslate'], ['s', 'minecraft:stone']];
		async function dump() {
			if (!dumpBox) return null;
			const [x0, y0, z0, x1, y1, z1] = dumpBox, layers = {};
			for (let y = y1; y >= y0; y--) {
				const rows = [];
				for (let z = z0; z <= z1; z++) {
					let row = '';
					for (let x = x0; x <= x1; x++) {
						let ch = '#';
						for (const [k, id] of KINDS) if (await isBlock(dim, [x, y, z], id)) { ch = k; break; }
						row += ch;
					}
					rows.push(`z${z} ${row}`);
				}
				layers[`y${y} x${x0}..${x1}`] = rows;
			}
			return layers;
		}
		result.mapBefore = await dump();
		const t0 = await startPlay(), WINDOW = 360000, left = () => WINDOW - (now() - t0);
		const args = { x: site.origin[0], y: site.origin[1], z: site.origin[2], axis: site.axis, frame: true, timeoutMs: 240000 };
		result.args = args;
		result.calls = [];
		for (let call = 0; call < 2 && left() > 60000; call++) {
			if (call) await s.clock.sleep(5000);   // the model's answer time before it calls again
			const r = await act('cast_obsidian', { ...args, timeoutMs: Math.min(240000, left() - 30000) }, left() + 30000);
			result.calls.push({ reasonCode: r.reasonCode, seconds: Math.round((now() - t0) / 1000), message: r.message?.slice(0, 4000) });
			if (r.reasonCode === 'FRAME_COMPLETE' || /DAMAGE|LAVA|FIRE|HEALTH/.test(r.reasonCode ?? '')) break;
		}
		const last = result.calls.at(-1) ?? {};
		result.frameComplete = last.reasonCode === 'FRAME_COMPLETE';
		result.frameSeconds = result.frameComplete ? last.seconds : null;
		if (result.frameComplete && left() > 0) {
			const msg = last.message ?? '';
			const num = t => t.split(',').map(Number);
			// PORTAL_LIGHT=asked: a model that ignores the result text and lights origin+1 of the site it sent.
			const readText = process.env.PORTAL_LIGHT !== 'asked';
			const named = readText ? /flint_and_steel on the (\w+) face of (-?\d+,-?\d+,-?\d+)/.exec(msg) : null;
			const lightAt = named?.[2], face = named?.[1] ?? 'up';
			const openAt = readText ? /opening at (-?\d+,-?\d+,-?\d+)/.exec(msg)?.[1] : undefined;
			const [ox, oy, oz] = site.origin, alongX = site.axis !== 'z';
			const bottom = lightAt ? num(lightAt) : alongX ? [ox + 1, oy, oz] : [ox, oy, oz + 1];
			const inside = openAt ? num(openAt) : [bottom[0], bottom[1] + 1, bottom[2]];
			result.light = { bottom, inside, face };
			result.steps = [];
			result.completePos = String(await s.command(`data get entity ${AGENT} Pos`)).replace(/.*data: /, '');
			result.steps.push(await act('select_item', { itemId: 'minecraft:flint_and_steel' }, 10000));
			result.steps.push(await act('interact_block', { x: bottom[0], y: bottom[1], z: bottom[2], face, hand: 'main', expectedItemId: 'minecraft:flint_and_steel' }, 15000));
			result.lit = await isBlock(dim, inside, 'minecraft:nether_portal');
			result.litSeconds = Math.round((now() - t0) / 1000);
			if (result.lit) {
				const walkIn = () => act('move_to', { x: inside[0] + 0.5, y: inside[1], z: inside[2] + 0.5, tolerance: 0.3, sprint: true }, 30000);
				// PORTAL_PREWALK=x,y,z (diagnosis only): a first move_to there before the walk in.
				if (process.env.PORTAL_PREWALK) { const [px, py, pz] = process.env.PORTAL_PREWALK.split(',').map(Number); result.steps.push(await act('move_to', { x: px, y: py, z: pz, tolerance: 0.3 }, 30000)); }
				result.steps.push(await walkIn());
				// A failed walk gets the model's answer time and one more call, as a model retries it.
				if (result.steps.at(-1).state === 'FAILED') { await s.clock.sleep(5000); result.steps.push(await walkIn()); result.walkRetried = true; }
				result.steps.push(await act('wait', { durationMs: 4500 }, 15000).catch(error => ({ error: String(error) })));
			}
			result.steps = result.steps.map(r => ({ state: r.state, reasonCode: r.reasonCode, message: r.message?.slice(0, 200) }));
		}
		await s.clock.sleep(1500);
		// The block map is diagnosis only: it reads at 20, as before (and still counts towards seconds, as it did).
		await endPlay();
		if (!result.nether) result.mapAfter = await dump();
		result.dimension = String(await s.command(`data get entity ${AGENT} Dimension`));
		result.nether = /the_nether/.test(result.dimension);
		result.seconds = Math.round((now() - t0) / 1000);
		result.inWindow = result.nether && result.seconds <= WINDOW / 1000 + 30;
		result.deaths = count(await s.command(`scoreboard players get ${AGENT} probeDeaths`)) || Number(/has (\d+)/.exec(String(await s.command(`scoreboard players get ${AGENT} probeDeaths`)))?.[1] ?? 0);
		result.ok = result.nether && result.inWindow;
	} else {
		// The model names a pool it has seen: turn toward it first, as a player would before choosing the spot.
		const edge = fixture.lavaPool.edge;
		await act('look_at', { x: edge[0] + 0.5, y: edge[1] + 0.5, z: edge[2] + 0.5 }, 10000);
		await s.observe(); await sleep(500); await s.observe();
		const box = [[edge[0] - 8, edge[1] - 2, edge[2] - 8], [edge[0] + 6, edge[1] + 6, edge[2] + 8]];
		const before = await obsidianIn(dim, ...box);
		const t0 = await startPlay();
		const args = mode === 'cast-frame'
			? { x: fixture.frame.origin[0], y: fixture.frame.origin[1], z: fixture.frame.origin[2], axis: fixture.frame.axis, frame: true, timeoutMs: 240000 }
			: { x: edge[0], y: edge[1], z: edge[2], count: 4, timeoutMs: 240000 };
		result.args = args;
		result.action = await act('cast_obsidian', args, 270000);
		result.seconds = Math.round((now() - t0) / 1000);
		await endPlay();
		const after = await obsidianIn(dim, ...box);
		const key = c => c.join(',');
		const old = new Set(before.map(key));
		result.newObsidian = after.filter(c => !old.has(key(c))).length;
		result.health = String(await s.command(`data get entity ${AGENT} Health`));
		if (mode === 'cast-frame') {
			const [ox, oy, oz] = fixture.frame.origin;
			const along = (i, y) => fixture.frame.axis === 'z' ? [ox, oy + y, oz + i] : [ox + i, oy + y, oz];
			const cells = [along(1, 0), along(2, 0), along(0, 1), along(3, 1), along(0, 2), along(3, 2), along(0, 3), along(3, 3), along(1, 4), along(2, 4)];
			const missing = [];
			for (const c of cells) if (!(await isBlock(dim, c, 'minecraft:obsidian'))) missing.push(c);
			const blockedInterior = [];
			for (const i of [1, 2]) for (const y of [1, 2, 3]) if (!(await isBlock(dim, along(i, y), 'minecraft:air')) && !(await isBlock(dim, along(i, y), 'minecraft:water'))) blockedInterior.push(along(i, y));
			result.frame = { missing, blockedInterior };
			result.ok = missing.length === 0;
		} else {
			result.ok = result.newObsidian >= 4;
		}
		result.alive = !/No entity/i.test(result.health);
	}
} catch (error) {
	result.error = String(error?.stack ?? error);
} finally {
	await s.stop().catch(() => {});
}
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
if (mode === 'portal') console.log(JSON.stringify({ ok: result.ok, site: result.args, calls: result.calls?.map(c => `${c.reasonCode}@${c.seconds}s`),
	frameComplete: result.frameComplete, lit: result.lit, nether: result.nether, seconds: result.seconds, deaths: result.deaths,
	last: result.calls?.at(-1)?.message?.slice(0, 500), error: result.error?.slice(0, 400) }));
else console.log(JSON.stringify({ ok: result.ok, action: result.action, newObsidian: result.newObsidian, frame: result.frame, check: result.check, seconds: result.seconds, error: result.error?.slice(0, 400) }));
process.exit(result.ok ? 0 : 1);
