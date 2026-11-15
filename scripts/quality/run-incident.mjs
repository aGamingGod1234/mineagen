#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDynamicCoordinator } from '../../coordinator/src/dynamic-main.mjs';
import { AgentRegistry } from '../../coordinator/src/agent-registry.mjs';
import { PlanningScheduler } from '../../coordinator/src/planning-scheduler.mjs';
import { idleProvider } from '../../coordinator/src/decision-eval/replay-harness.mjs';
import { parseSavedWorldSpawn } from '../../coordinator/src/headless-world-spawn.mjs';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { ScriptedPlanner } from './lib/scripted-planner.mjs';
import { finishRun, terminalCounter, EDIT_LOOP_HELP } from './lib/fixture-run.mjs';
import { damageCounter, damageEvidence } from './lib/damage-counter.mjs';
import { boot } from './watch-replay.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const number = text => Number(/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim())?.[1]);
const AGENT = 'Probe';
async function main() {
	const { values } = parseArgs({ options: { incident: { type: 'string', default: 'lava-gate-seed-2' }, out: { type: 'string' }, jar: { type: 'string' }, 'keep-world': { type: 'boolean' }, help: { type: 'boolean' } } });
	if (values.help) {
		console.log(`Usage: run-incident.mjs --incident lava-gate-seed-2 --out FRESH_DIR --jar MAIN_JAR [--keep-world]
	Runs one production coordinator with its real bridge and a fixed scripted planner. No model calls.
	Requires JAVA_HOME, ARENA_HEADLESS_SERVER_TEMPLATE and a slot.sh live reservation.
	Reports exit 0 for the product bar, 1 for unmet acceptance, 2 for invalid evidence.
	${EDIT_LOOP_HELP}`);
	} else {
		if (!values.out || !values.jar || !process.env.JAVA_HOME || !process.env.ARENA_HEADLESS_SERVER_TEMPLATE || !process.env.SLOT_PORT_BASE) throw new Error('Use --help; output, jar, Java, template and live slot are required');
		if (!/^[a-z0-9-]+$/.test(values.incident)) throw new Error('Invalid incident ID');
		const incident = JSON.parse(await readFile(path.join(root, 'scripts/quality/incidents', values.incident + '.json')));
		const out = path.resolve(values.out), jar = path.resolve(values.jar);
		await mkdir(out, { recursive: true }); if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
		const trace = path.join(out, 'decisions.jsonl');
		const decisions = [], receipts = terminalCounter();
		const log = (actor, event, fields) => { const row = { actor, event, at: Date.now(), ...fields }; decisions.push(row); appendFileSync(trace, JSON.stringify(row) + '\n'); };
		const row = { name: incident.id, seed: incident.spot.seed, startedAt: Date.now(), calls: [], phasesMs: {}, mode: incident.mode, modelCalls: 0 };
		await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ incident: incident.id, source: incident.source, baseline: '0c689437', jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), mode: incident.mode }, null, 2));
		let s, coordinator, planner, deadline;
		try {
			const bootAt = Date.now(), registry = new AgentRegistry();
			planner = new ScriptedPlanner(registry, { ...incident.script, budgetMs: incident.spot.totalMs, log });
			s = await boot(out, { jar, template: process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port: Number(process.env.SLOT_PORT_BASE), seed: String(incident.spot.seed), spawnMonsters: true, handleGoalSpec: false,
				onBridge: async (session, connection) => {
					const bridge = session.bridge, send = bridge.send.bind(bridge);
					bridge.send = async (type, agentId, payload, options) => {
						if (['action_command', 'action_cancel'].includes(type)) log('coordinator-bridge', type, { agentId, ...payload });
						return send(type, agentId, payload, options);
					};
					bridge.on('observation', ({ payload }) => {
						if (!row.playStartedAt || row.finishedAt) return;
						row.samples = (row.samples ?? 0) + 1;
						if (payload.player?.onFire) row.burningSamples = (row.burningSamples ?? 0) + 1;
						if (payload.player?.inLava) row.lavaContactSamples = (row.lavaContactSamples ?? 0) + 1;
					});
					bridge.on('action_result', event => { receipts.accept(event); log('minecraft', 'action_result', { agentId: event.agentId, ...event.payload }); });
					coordinator = createDynamicCoordinator({ bridge: connection,
						codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' } } }, {
						bridge, registry, planner, scheduler: new PlanningScheduler(), codexService: idleProvider, memoryDirectory: null,
						traceWriter: { write: (event, fields) => log('coordinator', event, fields) },
					});
					await coordinator.start();
				} });
			row.phasesMs.boot = Date.now() - bootAt;
			const setupAt = Date.now();
			await s.command('save-all flush');
			const spawn = parseSavedWorldSpawn(await readFile(path.join(out, 'server/world/level.dat')));
			await s.command(`forceload add ${spawn.x} ${spawn.z}`);
			for (let i = 0; i < 60 && !/time is/i.test(await s.command(`execute if loaded ${spawn.x} 0 ${spawn.z} run time query gametime`)); i++) await sleep(500);
			const registered = s.inbox.wait('agent_registered', () => true, 45000);
			await s.command(`execute positioned ${spawn.x} 0 ${spawn.z} positioned over motion_blocking_no_leaves run codex summon gpt-6.1-sol low ${AGENT}`);
			const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
			const command = async text => ({ text: await s.command(text) });
			const setup = await applyQualitySetup({ dimension: 'minecraft:overworld', startAt: 'world_spawn', inventory: incident.spot.inventory, mobs: [], commands: [], freezeUntilGoalStart: true }, command, AGENT);
			await activateQualitySetup(setup, command, { stage: 'goal-start' });
			await activateQualitySetup(setup, command, { stage: 'first-decision' });
			await s.command('tick unfreeze');
			if (incident.spot.time !== undefined) await s.command(`time set ${incident.spot.time}`);
			await sleep(1500);
			const readDamage = await damageCounter(text => s.command(text), AGENT);
			const beforeDamage = await readDamage(), beforeHealth = number(await s.command(`data get entity ${AGENT} Health`));
			const before = await s.observe();
			const missingItems = incident.spot.inventory.filter(item => (before.inventory?.items ?? []).filter(row => row.itemId === item.item).reduce((n, row) => n + row.count, 0) < item.count);
			row.startState = { position: before.position, dimension: before.world?.dimension, health: before.player?.health, onFire: before.player?.onFire, dayTime: before.world?.dayTime, inventory: before.inventory?.items };
			if (missingItems.length || before.player?.health !== incident.assertStart.health || before.player?.onFire !== incident.assertStart.onFire || before.world?.dimension !== incident.assertStart.dimension || beforeDamage === null) throw new Error('Start-state assertion failed; incident clock did not start');
			row.phasesMs.setup = Date.now() - setupAt;
			row.playStartedAt = Date.now();
			const started = s.inbox.wait('goal_control', event => event.payload.operation === 'start', 60000);
			await s.command(`codex start ${AGENT} Find lava.`); s.record.goalRevision = (await started).payload.goalRevision;
			await Promise.race([planner.finished.promise, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Incident did not finish within its scripted budget')), incident.spot.totalMs + 30000); })]);
			clearTimeout(deadline);
			row.phasesMs.run = Date.now() - row.playStartedAt; row.calls = planner.results;
			const after = await s.observe(), afterHealth = number(await s.command(`data get entity ${AGENT} Health`));
			Object.assign(row, damageEvidence(beforeDamage, await readDamage(), beforeHealth, afterHealth));
			row.deaths = number(await s.command(`scoreboard players get ${AGENT} deaths`)) || 0;
			row.actionCounts = receipts.snapshot();
			row.decisions = { holds: decisions.filter(event => event.event === 'native_wake_filtered' && event.verdict === 'hold').length,
				steers: decisions.filter(event => event.event === 'native_turn_steered').length, handBacks: row.calls.filter(result => result.reasonCode === 'FIND_DANGER').length };
			row.found = row.calls.some(result => result.state === 'SUCCEEDED' && result.reasonCode === 'FIND_SEEN');
			// Validate the structured sighting independently; a survey/flowing-lava success is not source-lava evidence.
			const seen = row.calls.find(result => result.state === 'SUCCEEDED' && result.reasonCode === 'FIND_SEEN')?.find?.seen;
			row.verifiedSource = Boolean(seen?.id === 'minecraft:lava' && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(seen[axis]))
				&& /passed/i.test(await s.command(`execute if block ${seen.x} ${seen.y} ${seen.z} minecraft:lava[level=0]`)));
			if (!row.samples || !Number.isFinite(afterHealth)) (row.integrity ??= []).push({ file: 'observations', error: 'No valid live samples or final health' });
			row.pass = row.verifiedSource && row.damageTaken === 0 && row.deaths === 0 && !row.burningSamples && !row.lavaContactSamples;
			row.finishedAt = Date.now();
		} catch (error) { row.error = error.message; row.pass = false; }
		finally {
			clearTimeout(deadline); planner?.finishAll();
			await coordinator?.stop().catch(error => (row.integrity ??= []).push({ file: 'coordinator-stop', error: error.message }));
			const stopAt = Date.now();
			try {
				if (s) { await s.stop(); row.confirmedExit = { exitCode: s.child.exitCode, signalCode: s.child.signalCode }; if (!values['keep-world']) await rm(path.join(out, 'server'), { recursive: true, force: true }); }
			} catch (error) { (row.integrity ??= []).push({ file: 'server-stop', error: error.message }); }
			row.phasesMs.stop = Date.now() - stopAt;
			row.elapsedMs = Date.now() - row.startedAt;
			console.log(JSON.stringify(row, null, 2));
			await finishRun([row], { file: path.join(out, 'result.json') });
		}
	}
}
main().catch(error => { console.error(error.message); process.exitCode = 2; });
