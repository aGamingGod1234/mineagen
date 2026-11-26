#!/usr/bin/env node
// Private freeze smoke, part B: node scripts/quality/freeze-dims-live.mjs OUT_DIR [JAR] under slot.sh live.
// One fresh normal-difficulty world (random seed, monsters on). One body with the production reflex book (all
// defaults, dimension defaults, instincts, switches read from this process's env as the coordinator would), fed by
// the real NativeToolRuntime from live samples. No model call. Phases: Nether (real Nether kit, NETHER_S seconds),
// then End (End kit, END_S seconds). Records: rules armed vs echoed per phase, reflex events by id, deaths, damage,
// health floor, tick ms, mod errors in server.log. Exit 0 ran clean, 1 a check failed, 2 harness/invalid.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeToolRuntime } from '../../coordinator/src/native-tool-runtime.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { InspectionClient } from '../../coordinator/src/inspection-client.mjs';
import { ReflexBook, DEFAULT_REFLEXES, DIMENSION_REFLEXES } from '../../coordinator/src/reflexes.mjs';
import { resolveSwitches } from '../../coordinator/src/switches.mjs';
import { boot, unshownTickRate } from './watch-replay.mjs';
import { followGoalRevision, inspectionObserve, respawnBody } from './room-body-link.mjs';
import { MOD_JAR } from './mod-jar.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [outArg, jarArg] = process.argv.slice(2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !template || !port || !process.env.JAVA_HOME) { console.error('usage: freeze-dims-live.mjs OUT [JAR] under slot.sh live'); process.exit(2); }
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) { console.error('Use a fresh output directory'); process.exit(2); }
const NETHER_S = Number(process.env.NETHER_S ?? 180), END_S = Number(process.env.END_S ?? 120);
const seed = String(process.env.SMOKE_SEED ?? Math.floor(Math.random() * 2 ** 31));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const score = t => /has no score|none is set|no score/i.test(t) ? 0 : Number((/has (-?\d+)/.exec(t) ?? [])[1]);
const report = { seed, jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), switches: Object.fromEntries([...resolveSwitches(process.env)].map(([k, v]) => [k, v.value])), phases: [], trace: [], errors: [] };
const save = () => writeFile(path.join(out, 'smoke.json'), JSON.stringify(report, null, 2));
process.on('unhandledRejection', e => report.errors.push(`unhandled: ${String(e?.message ?? e).slice(0, 300)}`));
let s;
const name = 'Smoke';
try {
	s = await boot(out, { jar: report.jar, template, port, world: null, seed, spawnMonsters: true, goalTicks: 2_000_000, extraProperties: 'max-tick-time=-1\n', tickRate: unshownTickRate('freeze smoke plays at 20') });
	await s.normalRate?.();
	await s.command('forceload add -8 -8 8 8');
	const registered = s.inbox.wait('agent_registered', () => true, 60_000);
	await s.command(`execute positioned 0 0 0 positioned over motion_blocking_no_leaves run mineagen summon gpt-6.1-sol low ${name}`);
	const e = await registered;
	const record = { ...(e.payload.record ?? e.payload), agentId: e.agentId, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
	s.record = record;
	await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.agentId === record.agentId && g.payload.operation === 'start', 120_000);
	await s.command(`mineagen start ${name} Survive for 36000 seconds.`);
	record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${name}`);
	await s.command('scoreboard objectives add fx_taken minecraft.custom:minecraft.damage_taken');
	let latest = null;
	const inspections = new InspectionClient({ send: (type, agentId, payload) => s.bridge.send(type, agentId, payload) });
	s.bridge.on('inspection_result', m => { if (m.agentId === record.agentId) inspections.accept(m); });
	// As dynamic-main.mjs builds it with the defaults on.
	const reflexBook = new ReflexBook({ defaults: DEFAULT_REFLEXES, dimensionDefaults: DIMENSION_REFLEXES });
	const sent = [];
	const runtime = new NativeToolRuntime({
		reflexBook,
		trace: (event, fields) => { if (/^reflex/.test(event) && fields?.agentId === record.agentId) report.trace.push({ at: Date.now(), event, ...(fields.events ? { events: fields.events } : {}), ...(fields.rules ? { rules: fields.rules.length } : {}), ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}) }); },
		bridge: { send: async (type, agentId, payload) => { if (type === 'reflex_update') sent.push({ at: Date.now(), revision: payload.revision, rules: payload.rules.map(r => r.id) }); return s.bridge.send(type, agentId, payload); } },
		requestObservation: inspectionObserve(inspections, record),
		inspectObservation: async (rec, query) => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await inspections.request(rec, query) }),
	});
	s.bridge.on('observation', ev => {
		if (ev.agentId !== record.agentId || !ev.payload.ready) return;
		latest = ev.payload;
		try { runtime.updateObservation(record, adaptObservation(ev.payload), { eventSequence: ev.payload.eventSequence }); } catch (err) { report.errors.push(`updateObservation: ${String(err?.message ?? err).slice(0, 300)}`); }
	});
	s.bridge.on('action_result', ev => { if (ev.agentId === record.agentId) { runtime.onActionResult(record, ev.payload); s.bridge.send('action_result_ack', record.agentId, { goalRevision: record.goalRevision, actionId: ev.payload.actionId }).catch(() => {}); } });
	followGoalRevision(s.bridge, record);
	const pump = setInterval(() => s.bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }).catch(() => {}), 1000);
	const health = async () => number(await s.command(`data get entity ${name} Health`));
	const kit = async items => { await s.command(`clear ${name}`); for (const [slot, item] of items) await s.command(`item replace entity ${name} ${slot} with ${item}`); };
	const NETHER_KIT = [['armor.head', 'minecraft:golden_helmet'], ['armor.chest', 'minecraft:iron_chestplate'], ['armor.legs', 'minecraft:iron_leggings'], ['armor.feet', 'minecraft:iron_boots'],
		['weapon.mainhand', 'minecraft:iron_sword'], ['weapon.offhand', 'minecraft:shield'], ['hotbar.1', 'minecraft:iron_pickaxe'], ['hotbar.2', 'minecraft:bow'], ['hotbar.3', 'minecraft:cooked_beef 16'],
		['hotbar.4', 'minecraft:cobblestone 64'], ['hotbar.5', 'minecraft:flint_and_steel'], ['hotbar.6', 'minecraft:bucket'], ['inventory.0', 'minecraft:arrow 64'], ['inventory.1', 'minecraft:oak_planks 32']];
	const END_KIT = [['armor.head', 'minecraft:iron_helmet'], ['armor.chest', 'minecraft:iron_chestplate'], ['armor.legs', 'minecraft:iron_leggings'], ['armor.feet', 'minecraft:iron_boots'],
		['weapon.mainhand', 'minecraft:iron_sword'], ['weapon.offhand', 'minecraft:shield'], ['hotbar.1', 'minecraft:iron_pickaxe'], ['hotbar.2', 'minecraft:bow'], ['hotbar.3', 'minecraft:cooked_beef 16'],
		['hotbar.4', 'minecraft:cobblestone 64'], ['hotbar.5', 'minecraft:water_bucket'], ['inventory.0', 'minecraft:arrow 64'], ['inventory.1', 'minecraft:oak_planks 32']];
	const phases = [
		{ dim: 'minecraft:the_nether', seconds: NETHER_S, kit: NETHER_KIT, place: async () => { await s.command('execute in minecraft:the_nether run forceload add -64 -64 64 64'); await sleep(3000); return s.command(`execute in minecraft:the_nether run spreadplayers 0 0 0 48 under 100 false ${name}`); } },
		{ dim: 'minecraft:the_end', seconds: END_S, kit: END_KIT, place: async () => { await s.command('execute in minecraft:the_end run forceload add -48 -48 48 48'); await sleep(3000); return s.command(`execute in minecraft:the_end positioned 28 0 4 positioned over motion_blocking_no_leaves run tp ${name} ~0.5 ~ ~0.5`); } },
	];
	for (const ph of phases) {
		const row = { dim: ph.dim, seconds: ph.seconds, deaths: 0, respawns: 0, events: {}, tickMs: [], healthMin: 20 };
		report.phases.push(row);
		await kit(ph.kit);
		await s.command(`effect give ${name} minecraft:instant_health 1 20 true`);
		row.place = String(await ph.place()).slice(0, 200);
		const sentBefore = sent.length, taken0 = score(await s.command(`scoreboard players get ${name} fx_taken`)), deaths0 = score(await s.command(`scoreboard players get ${name} deaths`));
		for (let i = 0; i < 30 && latest?.world?.dimension !== ph.dim; i++) await sleep(500);
		row.arrivedIn = latest?.world?.dimension ?? null;
		const t0 = Date.now();
		let checkedEcho = false;
		while (Date.now() - t0 < ph.seconds * 1000) {
			await sleep(5000);
			const h = await health().catch(() => NaN);
			if (Number.isFinite(h)) row.healthMin = Math.min(row.healthMin, h);
			if (!(h > 0)) {
				row.deaths++;
				const back = await respawnBody({ command: s.command, health, sleep, send: (...a) => s.bridge.send(...a) }, record, name);
				if (back) { row.respawns++; await kit(ph.kit); await ph.place(); }
			}
			if (!checkedEcho && latest?.world?.dimension === ph.dim && Date.now() - t0 > 10_000) {
				checkedEcho = true;
				const want = sent.at(-1);
				row.armedRules = want?.rules ?? [];
				row.echoedRules = (latest?.reflexes?.rules ?? []).map(r => r.id);
				row.echoRevision = { sent: want?.revision ?? null, mod: latest?.reflexes?.revision ?? null };
				row.dimensionDefaultsArmed = (DIMENSION_REFLEXES[ph.dim] ?? []).map(r => r.id).filter(id => row.armedRules.includes(id));
				row.dimensionDefaultsMissing = (DIMENSION_REFLEXES[ph.dim] ?? []).map(r => r.id).filter(id => !row.echoedRules.includes(id));
			}
			if (Math.round((Date.now() - t0) / 1000) % 30 < 5) row.tickMs.push(String(await s.command('tick query').catch(() => '')).match(/([\d.]+)\s*ms/)?.[1] ?? null);
		}
		for (const t of report.trace.filter(t => t.at >= t0 && t.events)) for (const ev of t.events) row.events[ev] = (row.events[ev] ?? 0) + 1;
		row.updatesSent = sent.length - sentBefore;
		row.damageTaken = score(await s.command(`scoreboard players get ${name} fx_taken`)) - taken0;
		row.deathsScore = score(await s.command(`scoreboard players get ${name} deaths`)) - deaths0;
		await save();
	}
	clearInterval(pump);
	const log = await readFile(path.join(out, 'server.log'), 'utf8').catch(() => '');
	const lines = log.split('\n');
	report.serverLog = { errors: lines.filter(l => /\b(ERROR|Exception)\b/.test(l) && !/Can't keep up/.test(l)).slice(0, 40), mineagenErrors: lines.filter(l => /\bERROR\b/.test(l) && /mineagen/i.test(l)).length, cantKeepUp: lines.filter(l => /Can't keep up/.test(l)).length };
	const failed = [];
	for (const ph of report.phases) {
		if (ph.arrivedIn !== ph.dim) failed.push(`${ph.dim}: body never arrived (${ph.arrivedIn})`);
		if (!ph.echoedRules?.length) failed.push(`${ph.dim}: mod echoed no rules`);
		if (ph.dimensionDefaultsMissing?.length) failed.push(`${ph.dim}: defaults missing in the mod: ${ph.dimensionDefaultsMissing.join(',')}`);
		if (ph.echoRevision && ph.echoRevision.sent !== ph.echoRevision.mod) failed.push(`${ph.dim}: revision sent ${ph.echoRevision.sent} vs mod ${ph.echoRevision.mod}`);
	}
	if (report.errors.length) failed.push(`harness/runtime errors: ${report.errors.length}`);
	if (report.serverLog.mineagenErrors) failed.push(`mod ERROR lines: ${report.serverLog.mineagenErrors}`);
	report.failed = failed;
	report.verdict = failed.length ? 'FAIL' : 'RAN CLEAN';
	await save();
	console.log(JSON.stringify({ verdict: report.verdict, failed, phases: report.phases.map(p => ({ dim: p.dim, deaths: p.deaths, damage: p.damageTaken, healthMin: p.healthMin, rules: p.echoedRules?.length, events: p.events, tickMs: p.tickMs })) }, null, 2));
	process.exitCode = failed.length ? 1 : 0;
} catch (err) {
	report.errors.push(`fatal: ${String(err?.stack ?? err).slice(0, 800)}`);
	report.verdict = 'INVALID';
	await save().catch(() => {});
	console.error(err);
	process.exitCode = 2;
} finally {
	await s?.stop?.().catch(() => {});
	setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
}
