#!/usr/bin/env node
// Provider-free: how fast can this machine run a fixture server? node scripts/quality/measure-tick-rate.mjs OUT_DIR
// One server at night with monsters spawning. Bodies join one at a time (BODIES, default 1,2,3,4), each kept busy with
// the production travel_to (long walks that load new chunks, fighting through the night's monsters instead of stopping
// for each) or dig_to (tunnels), resistance keeping them alive. For each body count the server steps through RATES
// (/tick rate N, default 20,40,60,80,100,120) and measures the world clock over SAMPLE_S wall seconds: achieved ticks per
// second, tick query's mean and p95 ms per tick, and busy (the share of body time spent in actions that ran at least 2 s,
// not refused on the spot). A rate is held when the server reaches 95% of it; highestHeld per body count is the highest
// rate held with every lower rate held too (notHeld lists the misses). No model call. ARENA_JAR picks the jar. Launch under slot.sh live with
// ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set; operator commands only set the world up.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boot } from './watch-replay.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = path.resolve(process.argv[2] ?? 'runtime/tick-rate');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!template || !port || !process.env.JAVA_HOME) throw new Error('Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
const jar = path.resolve(process.env.ARENA_JAR ?? path.join(root, 'build/libs/arena-agents-0.2.0.jar'));
const BODIES = (process.env.BODIES ?? '1,2,3,4').split(',').map(Number);
const RATES = (process.env.RATES ?? '20,40,60,80,100,120').split(',').map(Number);
const SAMPLE_S = Number(process.env.SAMPLE_S ?? 20);
// The default seed's world spawn (-272, 32) is dry land; START overrides where the bodies start.
const SEED = process.env.SEED ?? '3315172112810107624';
const [START_X, START_Z] = (process.env.START ?? '-272,32').split(',').map(Number);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const sleep = ms => new Promise(done => setTimeout(done, ms));
/**
 * One body count's rows: the highest rate held with every lower rate held too (a rate held after a lower one was missed
 * does not count), the rates missed, what was achieved, and the least busy sample.
 */
function capacity(rows) {
	const sorted = [...rows].sort((a, b) => a.rate - b.rate);
	let highestHeld = null;
	for (const row of sorted) { if (!row.held) break; highestHeld = row.rate; }
	const busy = sorted.map(row => row.busy).filter(Number.isFinite);
	return { highestHeld, notHeld: sorted.filter(row => !row.held).map(row => row.rate), achieved: Object.fromEntries(sorted.map(row => [row.rate, row.achieved])), leastBusy: busy.length ? Math.min(...busy) : null };
}
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free tick rate capacity', jar, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'),
	bodies: BODIES, rates: RATES, sampleS: SAMPLE_S, seed: SEED, start: [START_X, START_Z], host: os.hostname(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model, loadAverage: os.loadavg(), node: process.version }, null, 2));

const s = await boot(out, { jar, template, port, world: null, seed: SEED, spawnMonsters: true, tickRate: 20 });
const records = new Map();
// Any message with a newer goal revision moves that body on with it (as the coordinator does).
s.bridge.on('message', (event) => {
	const record = records.get(event.agentId);
	const revision = event?.payload?.goalRevision ?? event?.payload?.record?.goalRevision ?? event?.payload?.control?.goalRevision;
	if (!record || !Number.isSafeInteger(revision) || revision <= record.goalRevision) return;
	if (event.type === 'goal_control' && ['queue', 'dequeue'].includes(event.payload?.operation)) return;
	record.goalRevision = revision;
	s.bridge.send('agent_ready', record.agentId, { goalRevision: revision, reconciled: false }).catch(() => {});
});
let ordinal = 0, running = true;
// Per body: wall intervals of actions that ran at least 2 s, and the action in flight.
const work = new Map();
const busyShare = (from, to) => {
	if (work.size === 0) return null;
	let total = 0;
	for (const { done, current } of work.values()) {
		const spans = current === null ? done : [...done, [current, to, true]];
		for (const [a, b, open] of spans) if (open ? to - a >= 2000 : true) total += Math.max(0, Math.min(b, to) - Math.max(a, from));
	}
	return +(total / (work.size * (to - from))).toFixed(2);
};
async function act(record, type, args, waitMs) {
	const id = `rate-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'tick-rate', programVersion: 1, sourceStepId: id, eventSequence: 0 } };
	const next = s.inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), waitMs);
	try { await s.bridge.send('action_command', record.agentId, payload); } catch (error) { next.catch(() => {}); throw error; }
	const r = (await next).payload;
	await s.bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }).catch(() => {});
	return r;
}
const actions = [];
async function keepBusy(record, index) {
	const headings = ['east', 'south', 'west', 'north'];
	const mine = { done: [], current: null };
	let refusedInRow = 0;
	work.set(record.name, mine);
	for (let step = 0; running; step++) {
		const at = String(await s.command(`data get entity ${record.name} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number);
		const [type, args] = index % 2 === 0
			// Walkers go 120 blocks out each leg, so they keep loading new chunks.
			// fightThrough: a monster coming for the walker is fought, not a reason to stop (283 HOSTILE_NEAR refusals left
			// walkers idle in an earlier run).
			? ['travel_to', { x: (at?.[0] ?? 0) + [120, 0, -120, 0][step % 4], z: (at?.[2] ?? 0) + [0, 120, 0, -120][step % 4], tolerance: 4, fightThrough: true, timeoutMs: 90_000 }]
			// Diggers go 20 blocks down a staircase, then 20 back up (a new heading each leg), so a leg always has blocks to
			// dig (a fixed y -40 target returned at once once reached).
			: ['dig_to', step % 2 === 0
				? { pattern: 'stairs_down', y: Math.max(-50, Math.floor(at?.[1] ?? 64) - 20), heading: headings[step % 4], maxBlocks: 40, timeoutMs: 90_000 }
				: { pattern: 'stairs_up', y: Math.min(110, Math.floor(at?.[1] ?? 64) + 20), heading: headings[step % 4], maxBlocks: 40, timeoutMs: 90_000 }];
		const begun = Date.now();
		mine.current = begun;
		const r = await act(record, type, args, 200_000).catch(error => ({ state: 'ERROR', reasonCode: error.message }));
		const ended = Date.now();
		mine.current = null;
		if (ended - begun >= 2000) mine.done.push([begun, ended]);
		actions.push({ body: record.name, type, state: r.state, reasonCode: r.reasonCode, wallMs: ended - begun });
		// A refusal comes back at once: wait as a model would before the next step, so the bridge is not flooded. Two in a
		// row (a digger by an aquifer refused WATER_AHEAD 56 times in an earlier run) move the body to a fresh dry spot.
		if (ended - begun < 2000) {
			refusedInRow += 1;
			if (refusedInRow >= 2) { await s.command(`spreadplayers ${START_X} ${START_Z} 0 48 false ${record.name}`).catch(() => {}); refusedInRow = 0; }
			await sleep(2000);
		} else refusedInRow = 0;
	}
}
async function addBody(index) {
	const name = `Rate${index + 1}`;
	const [x, z] = [START_X + index * 6, START_Z];
	let e = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45_000).catch(() => null);
		await s.command(`forceload add ${x} ${z}`);
		for (let wait = 0; wait < 60 && !/time is/i.test(await s.command(`execute if loaded ${x} 0 ${z} run time query gametime`)); wait++) await sleep(1000);
		await s.command(`execute positioned ${x} 0 ${z} positioned over motion_blocking_no_leaves run codex summon gpt-6.1-sol low ${name}`);
		e = await registered;
	}
	if (!e) throw new Error(`${name} never registered`);
	const record = { ...(e.payload.record ?? e.payload), agentId: e.agentId, name };
	records.set(e.agentId, record);
	await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.agentId === record.agentId && g.payload.operation === 'start', 120_000);
	await s.command(`codex start ${name} Survive for 1200 seconds.`);
	record.goalRevision = Math.max(record.goalRevision, (await started).payload.goalRevision);
	await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${name}`);
	await s.command(`item replace entity ${name} container.0 with minecraft:diamond_pickaxe`);
	await s.command(`item replace entity ${name} container.1 with minecraft:cobblestone 64`);
	await s.command(`effect give ${name} minecraft:resistance infinite 4 true`);
	await s.command(`effect give ${name} minecraft:saturation infinite 1 true`);
	await s.command(`effect give ${name} minecraft:fire_resistance infinite 0 true`);
	await s.command(`effect give ${name} minecraft:water_breathing infinite 0 true`);
	keepBusy(record, index).catch(error => console.error(`${name}: ${error.message}`));
}
const number = (pattern, text) => { const m = pattern.exec(text); return m ? Number(m[1]) : null; };
const rows = [];
try {
	await s.command('difficulty normal');
	await s.command('gamerule minecraft:advance_time false');
	await s.command('time set 14000');
	for (let index = 0, count = 0; count < Math.max(...BODIES); count++, index++) {
		await addBody(index);
		if (!BODIES.includes(count + 1)) continue;
		await sleep(5000);
		for (const rate of RATES) {
			await s.setRate(rate);
			await sleep(3000);
			const g0 = await s.gameTicks(), w0 = Date.now();
			await sleep(SAMPLE_S * 1000);
			const g1 = await s.gameTicks(), w1 = Date.now();
			const query = await s.tickReport();
			const achieved = g0 === null || g1 === null ? null : +((g1 - g0) / ((w1 - w0) / 1000)).toFixed(1);
			const row = { bodies: count + 1, rate, achieved, held: achieved !== null && achieved >= rate * 0.95, busy: busyShare(w0, w1),
				meanMspt: number(/Average time per tick: ([\d.]+)/i, query), p95Mspt: number(/P95: ([\d.]+)/i, query), entities: null, query: query.slice(0, 400) };
			row.entities = number(/(\d+)/, String(await s.command('execute if entity @e').catch(() => '')));
			rows.push(row);
			console.log(`[tick-rate] ${row.bodies} bodies, rate ${rate}: ${achieved} t/s (${row.held ? 'held' : 'NOT held'}), busy ${row.busy}, mean ${row.meanMspt} ms, p95 ${row.p95Mspt} ms, ${row.entities} entities`);
			await writeFile(path.join(out, 'rows.json'), JSON.stringify(rows, null, 1));
		}
		await s.normalRate();
	}
} catch (error) {
	console.error(error);
	await writeFile(path.join(out, 'error.txt'), String(error?.stack ?? error));
} finally {
	running = false;
	await s.normalRate().catch(() => {});
	await writeFile(path.join(out, 'actions.json'), JSON.stringify(actions, null, 1));
	await s.stop().catch(() => {});
	await rm(path.join(out, 'server'), { recursive: true, force: true });
}
const summary = Object.fromEntries(BODIES.map(bodies => [bodies, capacity(rows.filter(row => row.bodies === bodies))]));
summary.actions = actions.reduce((counts, row) => ({ ...counts, [`${row.type}:${row.reasonCode}`]: (counts[`${row.type}:${row.reasonCode}`] ?? 0) + 1 }), {});
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
process.exit(0);
