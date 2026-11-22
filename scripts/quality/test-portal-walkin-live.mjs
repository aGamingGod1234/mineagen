#!/usr/bin/env node
// Provider-free check that move_to walks into a portal it targets, as a player steps onto it:
//   node scripts/quality/test-portal-walkin-live.mjs OUT_DIR [JAR]
// Fixtures (operator commands, floating stone decks at y149 in the Overworld):
//   end-lava  a 3x3 End portal in its frame ring over lava, the frame one block above the deck (a stronghold portal room)
//   end-air   the same pool over air
//   nether    a lit 2x3 Nether portal standing on the deck
//   across    move_to the deck beyond the End pool: the route must not fall into the portal
//   lava      move_to a lava cell beside the pool: still refused
//   hurt      travel_to the Nether portal; 3 damage once its feet stand in the portal: travel_to hands back
//             TRAVEL_DAMAGED while it waits for the crossing (it ran on to the crossing with no stop before)
// Each walk-in case passes when the body changes dimension through the agent's own move_to. No model call is made.
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE (or the worktree's server-template) and JAVA_HOME set.
// FIXTURE_TICK_RATE runs each case's walk faster: decks, portals and teleports are set up at 20 TPS, and each case's body
// action and the watch after it (for the crossing, for the feet in the portal) run at the raised rate on the fixture
// clock (s.clock, game time), so a raised rate plays the same game. Each case's `play` records seconds (game),
// wallSeconds, gameSeconds, rates, vanilla damageTaken and deaths.
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, fixtureTickRate } from './watch-replay.mjs';
import { damageCounter, recordDamageEvidence, deathCounter, recordDeathEvidence } from './lib/damage-counter.mjs';
import { fixtureSummary } from './lib/fixture-run.mjs';
import { MOD_JAR } from './mod-jar.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [outArg, jarArg] = process.argv.slice(2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE ?? path.join(root, 'server-template'), port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !port || !process.env.JAVA_HOME) throw new Error('Usage: OUT_DIR [JAR] under slot.sh live with JAVA_HOME');
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const AGENT = 'Portal';
const result = { cases: {} };
const s = await boot(out, { jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), template, port, world: null, seed: '20261024', tickRate: fixtureTickRate() });
await s.normalRate();
const ow = 'execute in minecraft:overworld run';
const dimension = async () => String(await s.command(`data get entity ${AGENT} Dimension`)).match(/"([^"]+)"/)?.[1] ?? null;
const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map((v) => Math.round(Number(v) * 10) / 10) ?? null;
const brief = (r) => ({ state: r.state, reasonCode: r.reasonCode ?? null, message: r.message ?? null });
const now = () => s.clock.now();
let readDamage = null;
const deaths = () => deathCounter((text) => s.command(text), AGENT, { objective: 'deaths', unsetIsZero: true });
// A case's play window: raised to the fixture rate right before the body acts; the returned function ends it (back to
// 20) and gives what it measured.
async function startPlay() {
	const damage0 = await readDamage(), deaths0 = await deaths().catch(() => null);
	await s.fastRate();
	const t0 = now(), wall0 = Date.now(), timer = await s.gameTimer();
	return async () => {
		const play = { seconds: Math.round((now() - t0) / 1000), wallSeconds: Math.round((Date.now() - wall0) / 1000), gameSeconds: Math.round((await timer.elapsed()) / 1000), rates: await timer.rates().catch(() => null) };
		await s.normalRate();
		recordDamageEvidence(play, damage0, await readDamage());
		recordDeathEvidence(play, deaths0, await deaths().catch(() => null));
		return play;
	};
}

// An End portal pool: frame ring at y150 round a 3x3 at x..x+2, z..z+2, on a deck at y149 with `under` below the pool.
async function endPool(x, z, under) {
	await s.command(`${ow} fill ${x - 8} 149 ${z - 8} ${x + 10} 149 ${z + 10} minecraft:stone`);
	await s.command(`${ow} fill ${x - 8} 150 ${z - 8} ${x + 10} 156 ${z + 10} minecraft:air`);
	await s.command(`${ow} fill ${x} 148 ${z} ${x + 2} 149 ${z + 2} ${under}`);
	for (const [fx, fz, facing] of [[0, -1, 'south'], [1, -1, 'south'], [2, -1, 'south'], [0, 3, 'north'], [1, 3, 'north'], [2, 3, 'north'], [-1, 0, 'east'], [-1, 1, 'east'], [-1, 2, 'east'], [3, 0, 'west'], [3, 1, 'west'], [3, 2, 'west']])
		await s.command(`${ow} setblock ${x + fx} 150 ${z + fz} minecraft:end_portal_frame[facing=${facing},eye=true]`);
	await s.command(`${ow} fill ${x} 150 ${z} ${x + 2} 150 ${z + 2} minecraft:end_portal`);
}
async function place(x, y, z) {
	await s.command(`${ow} tp ${AGENT} ${x + 0.5} ${y} ${z + 0.5} -90 0`);
	await s.idleSleep(1500);
	await s.observe();
}
async function walkIn(name, start, target, expect) {
	await place(...start);
	const endPlay = await startPlay();
	const r = brief(await s.act('move_to', { tolerance: 0.6, ...target, sprint: false }));
	let entered = false;
	// Up to 10 s of game time for the crossing (a Nether portal takes 4 s standing in it).
	for (let i = 0; i < 40 && !entered; i++) { entered = (await dimension()) === expect; if (!entered) await s.clock.sleep(250); }
	const play = await endPlay();
	result.cases[name] = { move: r, dimension: await dimension(), at: await pos(), ok: entered, play };
	await s.command(`${ow} tp ${AGENT} 0.5 150 0.5`); await s.idleSleep(2500);
}
try {
	// The body is summoned standing on the start deck. Summoned at y200 over nothing, it could still be falling when the
	// first case teleported it onto the deck, and died of the fall before any case (2 of 10 benchmark runs).
	await s.command(`${ow} forceload add -48 -48 48 48`);
	await s.command(`${ow} fill -2 149 -2 2 149 2 minecraft:stone`); await s.command(`${ow} fill -2 150 -2 2 152 2 minecraft:air`);
	let e = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
		await s.command(`execute positioned 0.5 150 0.5 run mineagen summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error('agent never registered');
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	// A dimension change advances the goal revision; later requests must carry the current one.
	s.bridge.on('goal_control', (g) => { if (g.agentId === s.record.agentId && Number.isSafeInteger(g.payload?.goalRevision) && g.payload.goalRevision !== s.record.goalRevision) {
		s.record.goalRevision = g.payload.goalRevision;
		s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
	} });
	const started = s.inbox.wait('goal_control', (g) => g.payload.operation === 'start');
	await s.command(`mineagen start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command('time set 1000'); await s.command('gamerule minecraft:advance_time false');
	await s.command(`gamemode survival ${AGENT}`); await s.command(`clear ${AGENT}`);
	await s.idleSleep(2000);
	readDamage = await damageCounter((text) => s.command(text), AGENT);

	// End portal over lava: frame ring at y150, the agent on the deck 5 blocks west, targets the pool centre cell.
	await endPool(20, 0, 'minecraft:lava');
	await walkIn('end-lava', [14, 150, 1], { x: 21.5, y: 150, z: 1.5 }, 'minecraft:the_end');
	await endPool(20, 0, 'minecraft:lava');
	await walkIn('end-lava-cell', [14, 150, 1], { x: 21, y: 150, z: 1 }, 'minecraft:the_end');
	await endPool(-30, 0, 'minecraft:air');
	await walkIn('end-air', [-36, 150, 1], { x: -28.5, y: 150, z: 1.5 }, 'minecraft:the_end');

	// Nether portal: obsidian frame on the deck (x 0..3, z 20), the agent 4 blocks south, targets a portal cell.
	await s.command(`${ow} fill -8 149 14 10 149 30 minecraft:stone`); await s.command(`${ow} fill -8 150 14 10 156 30 minecraft:air`);
	await s.command(`${ow} fill 0 150 20 3 154 20 minecraft:obsidian`); await s.command(`${ow} fill 1 151 20 2 153 20 minecraft:nether_portal[axis=x]`);
	await walkIn('nether', [1, 150, 25], { x: 1.5, y: 151, z: 20.5 }, 'minecraft:the_nether');

	// Hurt in the portal: travel_to the same portal; once the feet stand in it, 3 generic damage (a zombie's blow).
	await s.command(`${ow} tp ${AGENT} 0.5 150 0.5`); await s.idleSleep(2500);
	await place(1, 150, 25);
	const inPortal = async () => /passed/i.test(String(await s.command(`execute as ${AGENT} at @s if block ~ ~ ~ minecraft:nether_portal`)));
	let hurtAtMs = null;
	const endHurt = await startPlay();
	const trip = s.act('travel_to', { x: 1.5, y: 151, z: 20.5, tolerance: 2, timeoutMs: 30_000 }, 45_000).catch((error) => ({ state: 'ERROR', message: String(error?.message ?? error) }));
	const t0 = now();
	// The feet are checked every 100 ms of game time for 8 s of it; the hit lands a few ticks into the 80 the crossing takes.
	for (let i = 0; i < 80 && hurtAtMs === null; i++) {
		if (await inPortal()) { await s.command(`damage ${AGENT} 3 minecraft:generic`); hurtAtMs = now() - t0; }
		else await s.clock.sleep(100);
	}
	const hurt = brief(await trip);
	const hurtPlay = await endHurt();
	result.cases.hurt = { travel: hurt, hurtAtMs, ok: hurtAtMs !== null && hurt.reasonCode === 'TRAVEL_DAMAGED', play: hurtPlay };
	await s.idleSleep(5000);
	await s.command(`execute in minecraft:overworld run tp ${AGENT} 0.5 150 0.5`); await s.idleSleep(2500);

	// Across: from west of a fresh lava pool to the deck east of it. The route goes round, the body stays here.
	await endPool(20, 0, 'minecraft:lava');
	await place(14, 150, 1);
	const endAcross = await startPlay();
	const acrossMove = brief(await s.act('move_to', { x: 27.5, y: 150, z: 1.5, tolerance: 0.6, sprint: false }));
	const acrossPlay = await endAcross();
	result.cases.across = { move: acrossMove, dimension: await dimension(), at: await pos(), play: acrossPlay };
	result.cases.across.ok = result.cases.across.dimension === 'minecraft:overworld';
	await s.command(`${ow} setblock 16 149 6 minecraft:lava`);
	await place(14, 150, 1);
	const endLava = await startPlay();
	const lavaMove = brief(await s.act('move_to', { x: 16.5, y: 149, z: 6.5, tolerance: 0.6, sprint: false }));
	const lavaPlay = await endLava();
	result.cases.lava = { move: lavaMove, dimension: await dimension(), at: await pos(), play: lavaPlay };
	result.cases.lava.ok = result.cases.lava.move.state !== 'SUCCEEDED' && (result.cases.lava.at?.[1] ?? 0) >= 149.9;
	result.ok = Object.values(result.cases).every((c) => c.ok);
	result.tick = { rate: s.tickRate, held: await s.tickReport() };
} catch (error) {
	result.error = String(error?.stack ?? error);
} finally {
	await s.stop().catch(() => {});
}
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
const summary = fixtureSummary(Object.entries(result.cases).map(([name, row]) => ({ ...row, name, pass: row.ok })));
console.log(summary.line);
process.exit(result.error || summary.status === 'INVALID' ? 2 : summary.status === 'FAIL' ? 1 : 0);
