// Body-only sweep of how high a swimmer climbs out of water: node scripts/quality/test-water-exit-live.mjs OUT_DIR JAR [runs] [states]
// No model call and no escape or travel job: the fixture holds forward and jump against a ledge, as a player climbs out,
// and records whether the body ends on top. It settles the one number escape, travel and the pathfinder must agree on
// (how high a ledge a swimmer gets onto), measured from vanilla movement instead of guessed.
// States (semicolon list, default afloat;standing;wading):
//   afloat    4-deep water; the body treads water at the surface (jump held, 2 s) and then pushes east onto the ledge.
//   standing  2-deep water; the body stands on the bed with its eyes under water and pushes from there.
//   wading    1-deep water; the body stands on the bed with its eyes in air.
// Each state sweeps ledge tops over a grid of heights built from full blocks and partial blocks of known collision height
// (snow layers, daylight detector, slab, stonecutter, enchanting table, mud, dirt path), `runs` repeats each (default 5).
// Per run: the ledge top, the feet Y when the push starts (dy = ledge top - feet), the ledge top above the water's top
// block (overWater), whether the body ended standing on the ledge (climbed) and how many ticks it took. Rows are
// measurements, not verdicts: the run is descriptive and every valid row passes. Launch under slot.sh live with
// ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME. Reflexes are cleared so nothing but the push moves the body.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { boot } from './watch-replay.mjs';
import { finishRun } from './lib/fixture-run.mjs';

const USAGE = 'Usage: test-water-exit-live.mjs OUT_DIR JAR [runs] [afloat;standing;wading] under slot.sh live';
const cli = process.argv.slice(2);
if (cli.includes('--help')) { console.log(USAGE); process.exit(0); }
const [outArg, jarArg, runsArg, statesArg] = cli;
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !jarArg || !template || !port) { console.error(USAGE); process.exit(2); }
const runs = Number(runsArg ?? 5);
const states = (statesArg ?? 'afloat;standing;wading').split(';');
const DEPTH = { afloat: 4, standing: 2, wading: 1 };
// Partial blocks by collision height. Snow's collision is one layer lower than its look (layers - 1 eighths); water would
// wash it away, so snow is only used above the water's top block.
const PARTIAL = [
	{ h: 0.125, block: 'minecraft:snow[layers=2]', dryOnly: true }, { h: 0.25, block: 'minecraft:snow[layers=3]', dryOnly: true },
	{ h: 0.375, block: 'minecraft:daylight_detector' }, { h: 0.5, block: 'minecraft:smooth_stone_slab[type=bottom]' },
	{ h: 0.5625, block: 'minecraft:stonecutter[facing=north]' }, { h: 0.625, block: 'minecraft:snow[layers=6]', dryOnly: true },
	{ h: 0.75, block: 'minecraft:enchanting_table' }, { h: 0.875, block: 'minecraft:mud' }, { h: 0.9375, block: 'minecraft:dirt_path' },
];
// Ledge tops above the pool bed for each state: from just above the bed to well past any climb.
const ledges = (depth) => {
	const tops = [];
	for (let k = 0; k <= depth + 1; k++) {
		if (k > 0) tops.push({ above: k, solid: k, partial: null });
		for (const p of PARTIAL) if (!p.dryOnly || k >= depth) tops.push({ above: k + p.h, solid: k, partial: p });
	}
	// afloat: the water's top block is the bed + depth; climbs near it are what matters. Others: the first 2 blocks.
	const lo = depth >= 3 ? depth - 0.75 : 0.3, hi = depth >= 3 ? depth + 1.75 : 2.0;
	return tops.filter(t => t.above >= lo && t.above <= hi).sort((a, b) => a.above - b.above);
};
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
const sleep = ms => new Promise(done => setTimeout(done, ms));
const NAME = `Wx${process.pid % 100000}`;
const rows = [];
let planned = 0;
for (const state of states) planned += ledges(DEPTH[state]).length * runs;
let s;
try {
	s = await boot(path.join(out, 'server'), { jar: path.resolve(jarArg), template, port, world: null, seed: '1', spawnMonsters: false, goalTicks: 2_000_000 });
	await s.command('difficulty peaceful');
	await s.command('gamerule minecraft:advance_time false').catch(() => {});
	await s.command('time set 1000');
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
	await s.setReflexes([]);
	const pos = async () => String(await s.command(`data get entity ${NAME} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
	const onGround = async () => /1b\s*$/.test(String(await s.command(`data get entity ${NAME} OnGround`)).trim());
	const control = (forward, ticks) => s.act('control', { forward, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false,
		yaw: -90, pitch: 0, selectedSlot: 0, hand: 'main', ticks }, 30_000).catch(error => ({ state: 'ERROR', reasonCode: error.message }));
	// One pad, rebuilt each run. The pool is x X-2..X, the ledge x X+1..X+3, both z Z-1..Z+1, walled 4 above the ledge's
	// highest top so the only way out is the ledge. Bed at B = F - depth; the water's top block is F - 1.
	const X = 200, Z = 200, F = 120;
	await s.command(`forceload add ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
	for (let i = 0; i < 60 && !/time is/i.test(await s.command(`execute if loaded ${X} 0 ${Z} run time query gametime`)); i++) await sleep(1000);
	for (const state of states) {
		const depth = DEPTH[state];
		if (!depth) throw new Error(`unknown state ${state}`);
		const B = F - depth;
		for (const ledge of ledges(depth)) for (let run = 0; run < runs; run++) {
			const startedAt = Date.now();
			await s.command(`fill ${X - 4} ${B - 2} ${Z - 3} ${X + 5} ${F + 4} ${Z + 3} minecraft:stone`);
			await s.command(`fill ${X - 2} ${B} ${Z - 1} ${X + 3} ${F + 4} ${Z + 1} minecraft:air`);
			if (ledge.solid > 0) await s.command(`fill ${X + 1} ${B} ${Z - 1} ${X + 3} ${B + ledge.solid - 1} ${Z + 1} minecraft:stone`);
			if (ledge.partial) await s.command(`fill ${X + 1} ${B + ledge.solid} ${Z - 1} ${X + 3} ${B + ledge.solid} ${Z + 1} ${ledge.partial.block}`);
			await s.command(`fill ${X - 2} ${B} ${Z - 1} ${X} ${F - 1} ${Z + 1} minecraft:water`);
			const top = B + ledge.above;
			// Breath and footing back first, on the stone beside the pool, then into the water facing the ledge.
			await s.command(`tp ${NAME} ${X - 3.5} ${F + 5} ${Z + 0.5} -90 0`); await sleep(1500);
			// In the pool cell beside the ledge (centre 0.5 from its face), as a swimmer that reached the bank.
			await s.command(`tp ${NAME} ${X + 0.5} ${state === 'afloat' ? F - 1 : B} ${Z + 0.5} -90 0`);
			let settle = null;
			if (state === 'afloat') {
				// Tread water at the surface (jump held, no forward), the way a swimmer waits before a push.
				settle = await control(0, 40);
			} else await sleep(1500);
			const p0 = await pos();
			if (!p0) throw new Error(`${state} ${ledge.above}: body position unreadable`);
			const t0 = await s.gameTicks();
			const push = await control(1, 60);
			const end = await pos(), ground = await onGround();
			const ticks = (await s.gameTicks()) - t0;
			const climbed = end !== null && ground && end[0] >= X + 1.3 && end[1] >= top - 0.05;
			const row = { state, depth, run, ledgeTop: Math.round(ledge.above * 10000) / 10000, partial: ledge.partial?.block ?? null,
				overWater: Math.round((top - F) * 10000) / 10000, feet0: Math.round((p0[1] - B) * 1000) / 1000, dy: Math.round((top - p0[1]) * 1000) / 1000,
				climbed, endFeet: end ? Math.round((end[1] - B) * 1000) / 1000 : null, endDx: end ? Math.round((end[0] - X) * 100) / 100 : null, onGround: ground,
				pushTicks: ticks, push: `${push.state}:${push.reasonCode ?? ''}`, settle: settle ? `${settle.state}:${settle.reasonCode ?? ''}` : null, startedAt, finishedAt: Date.now() };
			if (push.state === 'ERROR' || settle?.state === 'ERROR') row.error = `control never returned: ${push.reasonCode ?? settle?.reasonCode}`;
			row.pass = !row.error;
			rows.push(row);
			console.log(`[${state} top=${row.ledgeTop} run ${run}] dy=${row.dy} overWater=${row.overWater} ${climbed ? 'CLIMBED' : 'stayed'} end feet ${row.endFeet} dx ${row.endDx}`);
		}
	}
} catch (error) {
	rows.push({ state: 'harness', error: String(error?.stack ?? error).slice(0, 1200) });
	console.log(`[water-exit] ERROR ${String(error?.message ?? error).split('\n')[0]}`);
} finally {
	try { await s?.stop(); } catch (error) { rows.push({ state: 'cleanup', error: String(error?.message ?? error) }); }
}
// Per state: the highest ledge climbed in every run, the lowest never climbed, and the dy range on each side.
const summary = {};
for (const row of rows.filter(r => r.ledgeTop !== undefined && !r.error)) {
	const st = summary[row.state] ??= { byTop: {}, maxDyClimbed: null, minDyRefused: null };
	const t = st.byTop[row.ledgeTop] ??= { climbed: 0, runs: 0 };
	t.runs++;
	if (row.climbed) { t.climbed++; st.maxDyClimbed = Math.max(st.maxDyClimbed ?? -Infinity, row.dy); }
	else st.minDyRefused = Math.min(st.minDyRefused ?? Infinity, row.dy);
}
for (const st of Object.values(summary)) {
	const tops = Object.entries(st.byTop).map(([top, t]) => ({ top: Number(top), ...t })).sort((a, b) => a.top - b.top);
	st.highestAlways = tops.filter(t => t.climbed === t.runs).at(-1)?.top ?? null;
	st.lowestNever = tops.find(t => t.climbed === 0)?.top ?? null;
}
console.log(JSON.stringify(summary));
const report = await finishRun(rows, { file: path.join(out, 'result.json'), planned, strict: false, hits: false });
console.log(JSON.stringify(report));
process.exit(report.exitCode);
