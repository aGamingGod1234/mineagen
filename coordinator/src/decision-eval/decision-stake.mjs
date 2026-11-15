import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDynamicCoordinator } from '../dynamic-main.mjs';
import { formatStake } from './stake-summary.mjs';
import { searchDanger } from '../search-danger.mjs';
import { FactLedger } from '../fact-ledger.mjs';
import { AgentRegistry } from '../agent-registry.mjs';
import { PlanningScheduler } from '../planning-scheduler.mjs';
import { goalSpecFingerprint } from '../goal-spec.mjs';
import { normalizeMinecraftToolCall } from '../native-minecraft-tools.mjs';
import { replayAgentRecord, REPLAY_AGENT_ID } from './render.mjs';
import { HarnessBridge, ReplayPlanner, TraceLog, withVirtualClock, idleProvider, settle } from './replay-harness.mjs';

export const STAKE_ROOT = fileURLToPath(new URL('../../test/fixtures/stake/', import.meta.url));
// Bridge commands keep only what a decision is: which command, for which goal revision, of which action type.
// Raw control floats (yaw to many decimals, pitch, ticks) and provenance change with harmless refactors and
// would turn every such change into an expectation diff.
const COMMAND_FIELDS = ['goalRevision', 'actionType'];
const TRACE_FIELDS = ['trigger', 'verdict', 'reason', 'reasonCode', 'actionType', 'toolKind', 'state'];
const isDecision = event => /native_.*(wake_filtered|steer|interrupt|hand_back|tool_rejected)/.test(event);

/** Replay admission and steering on supported recorded facts, without simulating physical results. */
export async function replayEpisode(episode, { createCoordinator = createDynamicCoordinator, judgeDanger = searchDanger, Ledger = FactLedger } = {}) {
	if (!['threat', 'hit-then-lava', 'late-result'].includes(episode.kind)) throw new Error('UNSUPPORTED: episode kind');
	const wallStart = performance.now();
	return withVirtualClock(episode.initial.observedAtEpochMs, async clock => {
		let latest = structuredClone(episode.initial), sequence = 0;
		const bridge = new HarnessBridge({ inspection: query => query.section === 'observation'
			? { result: { observation: { ...structuredClone(latest), eventSequence: ++sequence, observedAtEpochMs: clock.now }, eventSequence: sequence } } : null });
		const registry = new AgentRegistry(), planner = new ReplayPlanner(registry), traces = new TraceLog();
		const steers = [], returned = [], inputs = [], ledgerReceipts = [];
		let currentRevision = 1;
		// The runner already owns the process clock exclusively. Observe this private boundary
		// without adding a production testing API, and restore it with the clock on every exit.
		const ingest = Ledger.prototype.ingest;
		Ledger.prototype.ingest = function(source, payload) {
			if (source === 'action_result' && currentRevision === 2) ledgerReceipts.push(structuredClone(payload));
			return ingest.call(this, source, payload);
		};
		planner.interrupt = async () => { for (const turn of planner.turns) turn.finish({ status: 'interrupted', toolCalls: 0 }); };
		const requestTurn = planner.requestNativeTurn.bind(planner);
		planner.requestNativeTurn = request => { inputs.push({ revision: request.goalRevision, input: request.input }); return requestTurn(request); };
		let interruptionRequests = 0;
		planner.steerNativeTurn = async request => {
			if (request.onInterrupt) { interruptionRequests++; request.onInterrupt(); }
			const input = typeof request.input === 'function' ? await request.input() : request.input;
			inputs.push({ revision: request.goalRevision, input });
			steers.push(request.goalRevision);
		};
		const coordinator = createCoordinator({ bridge: { port: 25570, secret: 's'.repeat(32) },
			codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' } } }, {
			bridge, registry, planner, scheduler: new PlanningScheduler(), codexService: idleProvider, memoryDirectory: null, traceWriter: traces,
			controlNow: () => clock.now, epochNow: () => clock.now, goalSchedule: clock.schedule, cancelGoalSchedule: clock.cancel,
			goalStuckSchedule: clock.schedule, cancelGoalStuckSchedule: clock.cancel, setSteerTimeout: clock.schedule, clearSteerTimeout: clock.cancel,
			setWakeHoldTimeout: clock.schedule, clearWakeHoldTimeout: clock.cancel, setGoalSpecTimeout: clock.schedule, clearGoalSpecTimeout: clock.cancel,
			setStatusInterval: () => ({}), clearStatusInterval: () => {}, reflexDefaults: [],
		});
		const deliver = async (type, message) => {
			const pending = [];
			bridge.emit(type, { connectionEpoch: 1, ...message, waitUntil: promise => pending.push(promise) });
			await Promise.all(pending); await settle();
		};
		const goal = async revision => {
			currentRevision = revision;
			const fields = { originalRequest: 'Find lava.', predicate: { type: 'operator_confirmed' }, createdAtTick: 1 };
			await deliver('goal_control', { agentId: REPLAY_AGENT_ID, payload: { operation: revision === 1 ? 'start' : 'steer', goalRevision: revision,
				updatedAtEpochMs: clock.now, goal: fields.originalRequest, goalSpec: { ...fields, fingerprint: goalSpecFingerprint(fields) } } });
		};
		const observe = async (payload, trigger) => {
			latest = { ...structuredClone(payload), goalRevision: currentRevision, observedAtEpochMs: clock.now, eventSequence: ++sequence,
				...(trigger ? { attention: true, priority: 'urgent', trigger } : {}) };
			await deliver('observation', { agentId: REPLAY_AGENT_ID, payload: latest });
		};
		try {
			await coordinator.start();
			await deliver('ready', { serverInstanceId: 'decision-stake', registry: [replayAgentRecord({ state: { agent: {} } }, { provider: 'codex', model: 'gpt-6.1-sol' })] });
			await goal(1); await observe(episode.initial);
			await traces.until(() => planner.turns.length > 0, 500);
			if (!planner.turns.length) throw new Error('UNSUPPORTED: no planner admission');
			void planner.turns[0].request.executeTool({ agentId: REPLAY_AGENT_ID, goalRevision: 1, turnId: 'stake', callId: episode.id,
				tool: normalizeMinecraftToolCall(episode.call.name, episode.call.arguments) }).then(result => {
				returned.push({ event: 'tool_hand_back', state: result.state, reasonCode: result.reasonCode });
			}, error => returned.push({ event: 'tool_hand_back', reasonCode: error.code ?? 'ERROR' }));
			await traces.until(() => bridge.count('action_command') > 0 || traces.count('native_tool_rejected') > 0, 500);
			const action = bridge.sent.find(message => message.type === 'action_command');
			if (!action) throw new Error('UNSUPPORTED: find could not enter an action');
			let invariant = false, diagnostics = {};
			await clock.advanceTo(clock.now + 100);
			if (episode.kind === 'late-result') {
				await goal(2); await observe(episode.initial); await settle(60);
				if (!planner.turns.some(turn => turn.request.goalRevision === 2)) throw new Error('UNSUPPORTED: revision 2 has no planner turn');
				const commandsBefore = bridge.count('action_command'), inputsBefore = inputs.length;
				const traceBefore = traces.events.length, marker = 'STAKE_STALE_REVISION_ONE_DO_NOT_DELIVER';
				await deliver('action_result', { agentId: REPLAY_AGENT_ID, payload: { actionId: action.payload.actionId, goalRevision: 1,
					actionType: action.payload.actionType, state: 'SUCCEEDED', reasonCode: 'CONTROL_SEGMENT_COMPLETED', message: marker, observedAtEpochMs: clock.now } });
				await settle(60);
				const receiptWakes = traces.events.slice(traceBefore).filter(row => /native_turn_(requested|steered)|native_wake/.test(row.event));
				const receiptInputs = inputs.length - inputsBefore;
				// A fresh revision-2 input also exercises the ledger's later rendering path.
				await observe(episode.initial, 'threat'); await settle(60);
				const contaminatedInputs = inputs.filter(row => row.revision === 2 && JSON.stringify(row.input).includes(marker)).length;
				diagnostics = { revisionTwoTurns: planner.turns.filter(turn => turn.request.goalRevision === 2).length,
					staleLedgerReceipts: ledgerReceipts.filter(row => row.goalRevision === 1).length, receiptInputs, receiptWakes: receiptWakes.length, contaminatedInputs };
				invariant = registry.get(REPLAY_AGENT_ID).goalRevision === 2 && bridge.count('action_command') === commandsBefore
					&& diagnostics.staleLedgerReceipts === 0 && receiptInputs === 0 && receiptWakes.length === 0 && contaminatedInputs === 0;
			} else if (episode.kind === 'hit-then-lava') {
				const zombie = episode.observation.threats.entries.find(row => row.type === 'minecraft:zombie');
				const hit = structuredClone(episode.observation);
				hit.player = { ...hit.player, health: 17, hurtBy: 'mob_attack by minecraft:zombie', lastAttacker: { uuid: zombie.uuid, type: zombie.type, distance: zombie.distance } };
				await observe(hit, 'damage'); await settle(60);
				const before = steers.length;
				await clock.advanceTo(clock.now + 100);
				const lava = { ...hit, player: { ...hit.player, health: 17, inLava: true, hurtBy: 'lava' } };
				const traceBefore = traces.events.length;
				await observe(lava, 'damage'); await settle(60);
				diagnostics = { lavaHealth: lava.player.health, fightJudgement: judgeDanger(lava)?.handle,
					lavaHolds: traces.events.slice(traceBefore).filter(row => row.event === 'native_wake_filtered' && row.fields.verdict === 'hold').length };
				invariant = steers.length > before && diagnostics.fightJudgement === 'fight' && diagnostics.lavaHolds === 0;
			} else {
				await observe(episode.observation, 'threat'); await settle(60);
				invariant = episode.invariant === 'creeper-steers' ? steers.length > 0
					: true; // Routine policy is rebaselineable; only critical danger/stale-result assertions are hard.
			}
			const decisions = traces.events.filter(row => isDecision(row.event)).map(row => ({ event: row.event,
				...Object.fromEntries(TRACE_FIELDS.filter(key => row.fields[key] !== undefined).map(key => [key, row.fields[key]])) }));
			const commands = bridge.sent.filter(row => ['action_command', 'action_cancel'].includes(row.type)).map(row => ({ event: row.type,
				...Object.fromEntries(COMMAND_FIELDS.filter(key => row.payload?.[key] !== undefined).map(key => [key, row.payload[key]])) }));
			return { id: episode.id, mode: episode.mode, invariant, diagnostics, decisions, commands, returned: structuredClone(returned),
				metrics: { holds: decisions.filter(row => row.verdict === 'hold').length, wakes: decisions.filter(row => row.verdict === 'wake').length,
					notifies: decisions.filter(row => row.verdict === 'notify').length, interruptions: interruptionRequests, steers: steers.length, handBacks: returned.length,
					dangerCalls: decisions.filter(row => ['damage', 'threat', 'lava'].includes(row.trigger)).length }, wallMs: performance.now() - wallStart };
		} finally {
			try {
				for (const turn of planner.turns) turn.finish({ status: 'completed', toolCalls: 0 });
				await coordinator.stop();
			} finally { Ledger.prototype.ingest = ingest; }
		}
	});
}

export const expectedDecisions = result => ({ decisions: result.decisions, commands: result.commands, returned: result.returned });

export async function runStake({ root = STAKE_ROOT, incident = null, replayOptions = {} } = {}) {
	const start = performance.now(), manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
	const expected = JSON.parse(await readFile(path.join(root, 'expected.json'), 'utf8'));
	const results = [];
	for (const entry of manifest.episodes.filter(entry => incident === null || entry.id === incident)) {
		try {
			const raw = await readFile(path.join(root, entry.file));
			if (raw.length > 200_000 || createHash('sha256').update(raw).digest('hex') !== entry.sha256) throw new Error('INCOMPLETE: episode size/hash mismatch');
			const episode = JSON.parse(raw), result = await replayEpisode(episode, replayOptions);
			results.push({ ...result, matches: JSON.stringify(expectedDecisions(result)) === JSON.stringify(expected[entry.id]), expected: expected[entry.id] });
		} catch (error) { results.push({ id: entry.id, error: error.message, invariant: false, matches: false }); }
	}
	if (results.length === 0) results.push({ id: incident ?? 'corpus', error: 'UNSUPPORTED: no matching episode', invariant: false, matches: false });
	return { results, totalEpisodes: manifest.episodes.length, coverageGaps: manifest.unreplayable, wallMs: performance.now() - start,
		pass: results.length > 0 && results.every(result => result.invariant && result.matches && !result.error) };
}

export async function printStake(report, { summaryFile = process.env.GITHUB_STEP_SUMMARY } = {}) {
	const text = formatStake(report);
	console.log(text);
	if (summaryFile) await appendFile(summaryFile, text);
	return text;
}
