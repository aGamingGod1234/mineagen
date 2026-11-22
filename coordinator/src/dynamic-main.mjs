import { watchCaptureShutdown } from './capture-shutdown.mjs';
import { strictSpendRuntime } from './strict-spend-runtime.mjs';
import { NEW_CONTEXT_EVENT_INSTRUCTION, isNewContextEventInput } from './native-event-instructions.mjs';
export { NEW_CONTEXT_EVENT_INSTRUCTION } from './native-event-instructions.mjs';
export { carriedFoodToEat, naturalRegeneration } from './fork-rule.mjs';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentPlanner } from './agent-planner.mjs';
import { AgentRegistry, AgentRegistryError, DynamicAgentState } from './agent-registry.mjs';
import { ActiveGoalSupervisor } from './active-goal-supervisor.mjs';
import { MAX_LEASE_TIMEOUT_MS, actionLeaseTimeoutMs, requestedActionTimeoutMs } from './work-lease-supervisor.mjs';
import { AgentWorkspaceManager } from './agent-workspace.mjs';
import { MinecraftAgentWorkspace } from './minecraft-agent-workspace.mjs';
import { ClaudeProviderService } from './claude-service.mjs';
import { CodexService } from './codex-service.mjs';
import { createHealthSampler } from './coordinator-health.mjs';
import { ControlLatencyRegistry } from './control-latency-registry.mjs';
import { buildCoordinatorStatus, providerRecoveryComponents } from './coordinator-status.mjs';
import { ConversationMemory, conversationWakes } from './conversation-memory.mjs';
import { PendingConversationInbox } from './pending-conversation-inbox.mjs';
import { FactLedger } from './fact-ledger.mjs';
import { InspectionClient } from './inspection-client.mjs';
import { ModelNotebook } from './model-notebook.mjs';
import { RuntimeMemoryContext } from './runtime-memory-context.mjs';
import { TaskMemoryStore } from './task-memory-store.mjs';
import { experienceSettings } from './experience-store.mjs';
import { createExperience } from './experience-runtime.mjs';
import { LiveTaskViews, updateUsage } from './live-task-view.mjs';
import { ObservedMemoryStore } from './observed-memory-store.mjs';
import { ExplorationOccupancy } from './explore-frontier.mjs';
import { ProviderService } from './provider-service.mjs';
import { ProviderTurnRecorder } from './provider-turn-recorder.mjs';
import { DangerSteerCoalescer } from './danger-steer-coalescer.mjs';
import { owedWakeEvents, protectedNativeWake } from './native-wake-events.mjs';
import { defaultServiceTier } from './constants.mjs';
import { PlanningScheduler } from './planning-scheduler.mjs';
import { MAX_VERBOSE_MESSAGE_LENGTH, MultiplexedServerBridge, ProtocolV2Error, VERBOSE_STAGES } from './protocol-v2.mjs';
import { adaptObservation } from './observation-adapter.mjs';
import { advanceContextCursor, buildPlannerInput, buildPlannerRequest, contextCursorMatches, createContextCursor } from './prompts.mjs';
import { profileFingerprint } from './provider-session.mjs';
import { ProviderHealthRegistry } from './provider-health-registry.mjs';
import { classifyRecoveryFailure } from './recovery-policy.mjs';
import { ReportingTransitionDeduper } from './reporting-transition-deduper.mjs';
import { NativeToolRuntime } from './native-tool-runtime.mjs';
import { classifyNativeGoalError } from './native-goal-error-policy.mjs';
import { MAX_GOAL_SPEC_CORRECTION_ATTEMPTS, fallbackCompiledDragonGoal, localGoalSpecFeedback } from './goal-spec-translator.mjs';
import { ProgramRuntimeManager } from './program-runtime-manager.mjs';
import { createProviderChildEnvironment } from './provider-environment.mjs';
import { PROVIDER_CLI, ProviderCliHealthMonitor, createDisabledProviderCliHealthMonitor } from './provider-cli-health.mjs';
import { NATIVE_TOOL_PROVIDERS, PROVIDER_IDS, TOOL_BOUNDARY_STEER_PROVIDERS } from './provider-identity.mjs';
import { ProviderDiscovery, createAccountReaders } from './provider-discovery.mjs';
import { registerDiscoveredPrice } from './call-cost.mjs';
import { TASK_VIEW_MAX_BYTES } from './protocol-v2.mjs';
import { UsageLedger } from './usage-ledger.mjs';
import { TraceWriter } from './trace-writer.mjs';
import { DecisionLog } from './decision-log.mjs';
import { rememberCredential } from './provider-key-redaction.mjs';
import { wireRuntimeDiagnostics } from './runtime-diagnostics.mjs';
import { RuntimeErrorReporter } from './runtime-error-reporter.mjs';
import { BestEffortDiagnosticQueue } from './best-effort-diagnostic-queue.mjs';
import { RotatingJsonlSink } from './rotating-jsonl-sink.mjs';
import { sanitizeDiagnosticCode, sanitizeDiagnosticErrorCode, sanitizeDiagnosticErrorMessage, sanitizeDiagnosticText, sanitizeDiagnosticValue } from './diagnostic-sanitizer.mjs';
import { dragonPerchEdge, noteCombatDispatch, rememberEndCrystals, settleCombatResult } from './dragon-fight-facts.mjs';
import { heldToolBreak } from './held-tool-break.mjs';
import { SituationChangeTracker } from './situation-changes.mjs';
import { ContextEntryTracker, uncoveredDangers } from './danger-contexts.mjs';
import { WakeFilter, countSkillKinds, stepFolds } from './wake-filter.mjs';
import { searchHoldsSteer } from './search-danger.mjs';
import { carriedFoodToEat, naturalRegeneration } from './fork-rule.mjs';
// Danger triggers a running count skill handles itself when they come from its own mob (see countSkillKinds).
const COUNT_SKILL_HELD = new Set(['damage', 'threat', 'projectile', 'fire']);
import { DEFAULT_REFLEXES, DIMENSION_REFLEXES, ReflexBook, instinctsEnabled } from './reflexes.mjs';
import { kitHabitEnabled } from './kit-habit.mjs';
// Namespace import: situationStrategyTopic is optional, so the changed line works with or without it.
import * as strategyReference from './minecraft-strategy-reference.mjs';
import { BodyPace } from './body-pace.mjs';
import { killTraceFields } from './kill-trace.mjs';
import { DeathRecorder } from './death-record.mjs';
import { codedRuntimeError, loadDynamicConfig, normalizeDynamicConfig, parseDynamicCliArguments, positiveInteger, resolveDynamicCliRuntime } from './dynamic-config.mjs';
import { createVoiceSupervisor } from './voice-worker.mjs';
import { blockPosition, classifyObservationTrigger, dangerWakeRank, dangerWakeTrigger, DIMENSION_CHANGED_TRIGGER, factualProgressDetails, factualProgressSignature, finiteOrNull, imminentLavaFlow, inHazardContact, isHazardContactRequest, isSelfPreservationTool, isSurvivalReissueTool, KNOCKBACK_LEAD_MS, KNOCKBACK_SETTLE_MS, knockbackHurt, lavaFlowWakeDue, mergeAttentionTrigger, mergePlannerRequest, movementEvidence, nativeBlockPositionKey, nativeObservationSignature, NO_TASK_WAKE_TRIGGERS, rememberResources, routinePerceptionChange, sampleMovement, settleOwnBreak, startOwnBreak, SURVIVAL_EPISODE_QUIET_MS, SURVIVAL_RESTART_MIN_CALL_AGE_MS, survivalDangerShown, survivalFactKeys, withdrawShovedSteps, withoutOwnSightings } from './observation-facts.mjs';
import { burnFacts, DANGER_DECISION_TRIGGERS, fightSteerDecision, HEALING_EVENT_TRIGGERS, healingFacts, healNudgeVerdict, healWakeVerdict, isConfirmationContextTool, LOW_HEALTH_RECOVERY_TRIGGERS, rejectionTraceFields } from './danger-lines.mjs';
import { buildNativeEventInput, CONTEXT_ENTRY_TRIGGER, DEFAULT_TASK_REQUEST_TIMEOUT_MS, NEW_CONTEXT_TRIGGERS, UUID_TEXT } from './wake-input.mjs';
export { loadDynamicConfig, normalizeDynamicConfig, parseDynamicCliArguments, resolveDynamicCliRuntime } from './dynamic-config.mjs';
export { createVoiceSupervisor, startVoiceWorker } from './voice-worker.mjs';
export { classifyObservationTrigger, detectMovementLoop, FOOD_PLANT_BLOCKS, heardLavaNear, hudFacts, imminentLavaFlow, inHazardContact, isHazardContactRequest, isSelfPreservationTool, LAVA_FLOW_TRIGGER, LAVA_HEARD_TRIGGER, lavaFlowLine, lavaFlowWakeDue, mergePlannerRequest, nativeObservationSignature, rememberResources, routinePerceptionChange, settleOwnBreak, startOwnBreak, survivalFactKeys, withoutOwnSightings } from './observation-facts.mjs';
export { AWAITING_CONFIRMATION_EVENT_INSTRUCTION, burnFacts, BURNING_INSTRUCTION, carriedCombatOptions, dangerFactLine, edgeNote, fightSteerDecision, FIRE_CONTACT_INSTRUCTION, FOOD_BERRY_BLOCKS, foodSourceKeys, HAZARD_CONTACT_INSTRUCTION, healingFacts, healingOptions, healNudgeVerdict, healWakeVerdict, lowHealthWake, nativeSteerInterruption, NO_TASK_DANGER_INSTRUCTION, NO_TASK_HEAL_INSTRUCTION, standNote, TASK_HEAL_INSTRUCTION, threatOutlook } from './danger-lines.mjs';
export { buildNativeEventInput, compactEventInstruction, EVENT_BLOCK_DEFAULTS, EVENT_ITEM_DEFAULTS, GENERIC_FACTS_INSTRUCTION, GENERIC_UPDATE_INSTRUCTION, isLeanDangerWake, LEAN_DANGER_NOTE } from './wake-input.mjs';

const EMPTY_TURN_RETRY_DELAY_MS = 1_000;
const GOAL_SPEC_RETRY_BASE_MS = 1_000;
const GOAL_SPEC_RETRY_MAX_MS = 30_000;
const GOAL_SPEC_PROPOSAL_RETRY_MS = 5_000;
const TERMINAL_GOAL_SPEC_REJECTIONS = new Set(['UNKNOWN_GOAL_DRAFT', 'GOAL_DRAFT_AGENT_MISMATCH', 'STALE_GOAL_DRAFT']);
const QUIET_LIFECYCLE_ERRORS = new Set(['PLAN_CANCELLED', 'STALE_PLAN', 'STALE_GOAL_REVISION', 'GOAL_REVISION_COLLISION']);
const MAX_CONVERSATION_WAKE_TRANSACTIONS = 4_096;
const PARKED_NATIVE_STATES = [DynamicAgentState.IDLE, DynamicAgentState.COMPLETED, DynamicAgentState.PAUSED, DynamicAgentState.ERROR];
const GENERIC_WAKE_TRIGGERS = new Set(['attention', 'observation']);
// Folded by a running step yet still named on the wake its end brings: what was seen, not how the body moved.
// A running step's until "seen:<block>" came into view (a verb whose body does not stop itself on it).
const STEP_UNTIL_TRIGGER = 'step_until_seen';
const STEP_NAMED_TRIGGERS = new Set(['resource_discovery', 'structure_sighted', 'lava_heard', 'furnace_ready', 'heal_opportunity']);
// Ordinary perception a running program already receives and answers through its own decisions (onObservation).
const PROGRAM_OWNED_PERCEPTION_TRIGGERS = new Set(['attention', 'observation', 'resource_discovery', 'structure_sighted', 'lava_heard', 'heal_opportunity', 'projectile']);
// Longest an ordinary wake is held for the model's own running action. Long walks (navigate_to ran up to 37 s) must
// still let the model change course, and the model's own decision p95 is about 8 s.
const ORDINARY_WAKE_HOLD_MS = 15_000;
const DEFAULT_CONNECTION_OPERATION_CAP = 256;
const DEFAULT_AGENT_OPERATION_CAP = 32;
const MAX_PUBLIC_NARRATIVE_RAW_CHARS = 1_024;
const DEFAULT_MAX_PENDING_AGENT_OPERATIONS = 64;
const DEFAULT_MAX_PENDING_AGENT_TRANSACTIONS = 16;

export class DynamicCoordinator extends EventEmitter {
	#registry;
	#taskViews;
	#decisionLog;
	#observedMemory;
	#scheduler;
	#codexService;
	#planner;
	#bridge;
	#listeners = [];
	#providerListeners = [];
	#agentOperations = new Map();
	#agentOperationCounts = new Map();
	#totalAgentOperations = 0;
	#connectionOperationCap;
	#agentOperationCap;
	#providerWork = new Map();
	#pendingAttention = new Map();
	// Ordinary wakes held while the model's own action runs: the freshest held request, the first named reason, and the
	// deadline timer that releases them if the action outlasts the hold.
	#actionDeferredWakes = new Map();
	// While the model's own action runs: which wakes are absorbed into the next one, and what they carried.
	#wakeFilter = new WakeFilter();
	#deathRecorder = new DeathRecorder();
	#attentionFlushes = new Map();
	#lifecycleGenerations = new Map();
	#providerRetryAfter = new Map();
	#providerProbeDeadlines = new Map();
	#deferredProviderRecovery = new Map();
	#programRuntimeEpochs = new Map();
	#nativeRuntimeEpochs = new Map();
	#nativeProgramLeases = new Map();
	#traceUsageSamples = new Map();
	#factLedgers = new Map();
	#conversationMemories = new Map();
	#contextCursors = new Map();
	#pendingConversationInboxes = new Map();
	#memoryDirectory;
	#nativeConversationRecoveries = new Map();
	#nativeObservationSignatures = new Map();
	// Per agent and goal revision: a pending situation assessment (goal start, death or respawn, another dimension). It is
	// cleared only once an event carrying the assessment instruction and the situation line is delivered.
	#eventContexts = new Map();
	// Per agent: what materially changed since the last delivered wake (dimension, death, time, biome, gear, ...).
	#situationChanges = new Map();
	#contextEntries = new Map();
	// Per agent: the running action as first observed (handle, health), so a wake can say what changed while it ran.
	#runningActions = new Map();
	// Per agent: the body's current lava or fire-block contact (a sequence number, when it began) and whether a mid-call
	// turn was already reissued for it.
	#hazardContacts = new Map();
	#survivalRestartAt = new Map();
	// Per agent: since when no observation has shown survival danger (see #trackSurvivalQuiet).
	#survivalQuietSince = new Map();
	#hazardContactSequence = 0;
	#perceptionSequences = new Map();
	#nativeWorldSignals = new Map();
	// Low-health wakes of agents with no task, one per health level (see lowHealthWake).
	#healWakes = new Map();
	// Low-health-with-food nudges of agents with a task (see healNudgeVerdict).
	#healNudges = new Map();
	#nativeConfirmationWaits = new Map();
	// Agents that started body work while their finished goal awaits confirmation: their follow-up wakes pass.
	#confirmationActivity = new Set();
	#confirmationWorkAuthority = new Map();
	// takeTask round trips awaiting Minecraft's task_request_result, keyed by requestId.
	#taskRequests = new Map();
	#taskRequestTimeoutMs;
	#supervisedObservationRequests = new Map();
	#conversationWakeTransactions = new Map();
	#goalSpecRequests = new Map();
	#goalSpecRequestCap;
	#setGoalSpecTimeout;
	#clearGoalSpecTimeout;
	#programRuntime;
	#nativeRuntime;
	#inspections;
	#playerMemory;
	#memorySummaries = new Map();
	#receiptReconciliations = new Map();
	#latestActionDispatches = new Map();
	#goalSupervisor;
	#codexControlProtocol;
	#reconciliation = Promise.resolve();
	#started = false;
	#stopping = false;
	#closed = false;
	#stopPromise = null;
	#healthRegistry;
	#latencyRegistry;
	#controlNow;
	#epochNow;
	#setSteerTimeout;
	#setWakeHoldTimeout;
	#clearWakeHoldTimeout;
	#clearSteerTimeout;
	#disconnectedAt = null;
	#supportedAgentIds = new Set();
	#reconciledStatus = false;
	#setStatusInterval;
	#clearStatusInterval;
	#statusHandle = null;
	#healthSamplerFactory;
	#health = null;
	#serverInstanceId = null;
	#connectionEpoch = 0;
	#connected = false;
	#providerRecoveryPending = false;
	#traceWriter;
	#bodyPace;
	#providerTurnRecorder;
	#runtimeGeneration;
	#verboseTransitions = new ReportingTransitionDeduper();
	#maxPendingAgentOperations;
	#maxPendingAgentTransactions;
	#runtimeHooks;
	#providerCliHealth;
	#providerCliNotices = { connectionEpoch: null, agents: new Set() };
	#providerCliStartupLogged = false;
	#providerDiscovery;
	#usageLedger;
	#lastCatalog = null;
	#lastRosterTraceAt = 0;

	constructor({ registry, scheduler, codexService, planner, bridge, healthRegistry, latencyRegistry, goalSupervisor, codexControlProtocol = 'native_tools', memoryDirectory = null, experience = null, runtimeSessionId, traceWriter = null, providerTurnRecorder = null, decisionLog = null, bodyPace = null, runtimeGeneration = null, runtimeHooks = {}, benchmarkRecorder = null, providerCliHealth = null, providerDiscovery = null, controlNow = () => performance.now(), epochNow = Date.now, setStatusInterval = defaultStatusInterval, clearStatusInterval = clearInterval, healthSampler = undefined, setGoalSpecTimeout = defaultGoalSpecTimeout, clearGoalSpecTimeout = clearTimeout, setSteerTimeout = setTimeout, clearSteerTimeout = clearTimeout, setWakeHoldTimeout = defaultGoalSpecTimeout, clearWakeHoldTimeout = clearTimeout, reflexDefaults = DEFAULT_REFLEXES, reflexInstincts = false, kitHabit = false, taskRequestTimeoutMs = DEFAULT_TASK_REQUEST_TIMEOUT_MS, connectionOperationCap = DEFAULT_CONNECTION_OPERATION_CAP, agentOperationCap = DEFAULT_AGENT_OPERATION_CAP, goalSpecRequestCap = connectionOperationCap, maxPendingAgentOperations = DEFAULT_MAX_PENDING_AGENT_OPERATIONS, maxPendingAgentTransactions = DEFAULT_MAX_PENDING_AGENT_TRANSACTIONS, nativeClock = undefined }) {
		super();
		this.#memoryDirectory = memoryDirectory;
		this.#decisionLog = decisionLog;
		if (providerCliHealth !== null && typeof providerCliHealth.check !== 'function') throw new TypeError('providerCliHealth.check must be a function');
		this.#providerCliHealth = providerCliHealth;
		this.#providerDiscovery = providerDiscovery ?? new ProviderDiscovery({ cliHealth: null });
		this.#usageLedger = new UsageLedger({ now: epochNow, onWarning: (warning) => this.#publishUsageWarning(warning) });
		this.#providerDiscovery.onChange((state) => this.#acceptDiscovery(state));
		this.#registry = requireDependency(registry, 'registry');
		this.#scheduler = requireDependency(scheduler, 'scheduler');
		this.#codexService = requireDependency(codexService, 'codexService');
		this.#planner = requireDependency(planner, 'planner');
		this.#bridge = requireDependency(bridge, 'bridge');
		this.#inspections = new InspectionClient({ send: (type, agentId, payload, options) => this.#sendForEpoch(options.connectionEpoch, type, agentId, payload) });
		this.#playerMemory = new RuntimeMemoryContext({ notebook: new ModelNotebook({ directory: memoryDirectory }), taskMemory: new TaskMemoryStore({ directory: memoryDirectory }), sessionId: runtimeSessionId,
			// MINEAGEN_EXPERIENCE (default off): lessons from this profile's earlier games and this game's own death review.
			experience: createExperience(experience, { trace: (event, fields) => this.#writeTrace(event, fields) }),
			onReceipt: async (identity, receipt) => {
				const record = this.#registry.get(identity.agentId);
				if (record?.goalRevision === identity.goalRevision) {
					try { await this.#taskViews.actionReceipt(record, receipt); }
					catch (error) { this.#writeTrace('task_view_receipt_error', { code: error?.code ?? 'PLAN_VIEW_ERROR' }); }
				}
			} });
		// One observed memory serves the native tools and the plan's need options (remembered sightings and blocks).
		const occupancy = new ExplorationOccupancy({ memoryStore: new ObservedMemoryStore({ directory: memoryDirectory }) });
		this.#observedMemory = occupancy;
		this.#taskViews = new LiveTaskViews({ directory: memoryDirectory ? path.join(memoryDirectory, 'plans') : null,
			sources: (record, observation, blockPattern) => occupancy.knownSources(record.agentId, observation, blockPattern), instincts: reflexInstincts });
		this.#healthRegistry = requireDependency(healthRegistry, 'healthRegistry');
		this.#latencyRegistry = requireDependency(latencyRegistry, 'latencyRegistry');
		this.#goalSupervisor = requireDependency(goalSupervisor, 'goalSupervisor');
		if (traceWriter !== null && typeof traceWriter.write !== 'function') throw new TypeError('traceWriter.write must be a function');
		this.#traceWriter = traceWriter;
		this.#bodyPace = bodyPace ?? new BodyPace({ now: epochNow });
		if (providerTurnRecorder !== null && typeof providerTurnRecorder.close !== 'function') throw new TypeError('providerTurnRecorder.close must be a function');
		this.#providerTurnRecorder = providerTurnRecorder;
		this.#runtimeGeneration = runtimeGeneration;
		if (runtimeHooks === null || typeof runtimeHooks !== 'object' || Array.isArray(runtimeHooks)) throw new TypeError('runtimeHooks must be an object');
		if (runtimeHooks.onRemoved !== undefined && typeof runtimeHooks.onRemoved !== 'function') throw new TypeError('runtimeHooks.onRemoved must be a function');
		this.#runtimeHooks = runtimeHooks;
		this.#connectionOperationCap = positiveInteger(connectionOperationCap, 'connectionOperationCap');
		this.#agentOperationCap = positiveInteger(agentOperationCap, 'agentOperationCap');
		this.#goalSpecRequestCap = positiveInteger(goalSpecRequestCap, 'goalSpecRequestCap');
		if (!['arena_script', 'native_tools'].includes(codexControlProtocol)) throw new TypeError('codexControlProtocol must be arena_script or native_tools');
		this.#codexControlProtocol = codexControlProtocol;
		if (typeof controlNow !== 'function') throw new TypeError('controlNow must be a function');
		if (typeof epochNow !== 'function') throw new TypeError('epochNow must be a function');
		if (!Number.isSafeInteger(maxPendingAgentOperations) || maxPendingAgentOperations < 1) throw new TypeError('maxPendingAgentOperations must be a positive safe integer');
		if (!Number.isSafeInteger(maxPendingAgentTransactions) || maxPendingAgentTransactions < 1) throw new TypeError('maxPendingAgentTransactions must be a positive safe integer');
		this.#controlNow = controlNow;
		this.#epochNow = epochNow;
		if (typeof setSteerTimeout !== 'function' || typeof clearSteerTimeout !== 'function') throw new TypeError('steer timer callbacks must be functions');
		this.#setSteerTimeout = setSteerTimeout;
		if (typeof setWakeHoldTimeout !== 'function' || typeof clearWakeHoldTimeout !== 'function') throw new TypeError('wake hold timer callbacks must be functions');
		this.#setWakeHoldTimeout = setWakeHoldTimeout;
		this.#clearWakeHoldTimeout = clearWakeHoldTimeout;
		this.#clearSteerTimeout = clearSteerTimeout;
		this.#maxPendingAgentOperations = maxPendingAgentOperations;
		this.#maxPendingAgentTransactions = maxPendingAgentTransactions;
		const programBridge = {
			send: (type, agentId, payload) => this.#sendRuntimeMessage('program', type, agentId, payload),
		};
		const nativeBridge = {
			send: (type, agentId, payload) => this.#sendRuntimeMessage('native', type, agentId, payload),
		};
		this.#programRuntime = new ProgramRuntimeManager({
			sessionId: runtimeSessionId,
			memoryOperation: (record, operation) => this.#playerMemory.execute(record, operation),
			inspectObservation: async (record, query, authority = {}) => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await this.#inspections.request(record, query, { ...authority, connectionEpoch: this.#connectionEpoch }) }),
			registry: this.#registry,
			bridge: programBridge,
			planner: this.#planner,
			reportError: (agentId, error) => this.#reportAgentError(agentId, error, this.#programRuntimeEpochs.get(agentId)),
			requestRecovery: ({ record, reason, errorCode, recoveryKind, nextProbeAtEpochMs }) => {
				const connectionEpoch = this.#programRuntimeEpochs.get(record.agentId);
				if (!this.#isConnectionEpochCurrent(connectionEpoch)) return false;
				const current = this.#registry.get(record.agentId);
				if (current === null || current.goalRevision !== record.goalRevision) return false;
				const key = this.#supervisionKey(current);
				this.#goalSupervisor.activate(key);
				const details = this.#recoveryDetails(record.agentId, { errorCode, recoveryKind, nextProbeAtEpochMs });
				return this.#goalSupervisor.recover(key, { reason, ...details });
			},
			onCompletionRequested: (request) => this.#publishGoalCompleted(request, this.#programRuntimeEpochs.get(request.record.agentId)),
			latencyRegistry: this.#latencyRegistry,
			trace: (event, fields) => this.#writeTrace(event, fields),
			plannerContext: (agentId) => this.#plannerContext(agentId),
			onContextAccepted: (record, receipt) => this.#rememberAcceptedContextCursor(record, receipt),
			clock: () => this.#controlNow(),
			benchmarkRecorder,
		});
		this.#nativeRuntime = new NativeToolRuntime({
			// A test's virtual clock (game-clock.mjs shape) for program deadlines and step budgets; production keeps wall time.
			...(nativeClock === undefined ? {} : { clock: nativeClock }),
			// The game's rule book arms the default survival rules (ruling 16); a bare runtime has the model's rules only.
			// The End's own defaults arm whenever the coordinator arms defaults at all (late-game wall, order 12).
			reflexBook: new ReflexBook({ defaults: reflexDefaults, dimensionDefaults: reflexDefaults.length > 0 ? DIMENSION_REFLEXES : {}, instincts: reflexInstincts }),
			kitHabit,
			taskPlan: (record, tool) => this.#taskViews.operate(record, tool),
			knownStations: (record) => this.#taskViews.placedStations(record),
			planNeeds: (record) => this.#taskViews.openNeeds(record),
			planVocabulary: (record, worldId) => this.#taskViews.activeResourceVocabulary(record, worldId),
			sessionId: runtimeSessionId,
			requestObservation: async (record) => {
				const result = await this.#inspections.request(record, { section: 'observation' }, { connectionEpoch: this.#connectionEpoch });
				const observation = adaptObservation(result.observation);
				await this.#taskViews.observe(record, observation, result.observation);
				return { ...result, observation };
			},
			inspectObservation: async (record, query, authority = {}) => {
				const result = await this.#inspections.request(record, query, { ...authority, connectionEpoch: this.#connectionEpoch });
				if (query.section === 'survey') {
					const latest = this.#nativeRuntime.latestObservation(record)?.observation;
					if (latest && result.worldId === latest.world?.worldId && result.dimension === latest.world?.dimension) await this.#taskViews.observe(record, { ...latest, survey: result.survey, continuity: { rememberedSections: ['blocks', 'landmarks', 'nearbyContainers', 'interaction', 'inventory'] } });
				}
				return result;
			},
			// Coordinator ingress owns authoritative terminal persistence/retries.
			// Avoid the runtime's best-effort duplicate write ahead of live delivery;
			// dispatch and unknown-receipt durability still use the real notebook.
			notebook: {
				...Object.fromEntries(['writeNote', 'query', 'listUnresolved', 'recordDispatch', 'recordUnknown', 'findReceipt'].map((method) => [method, this.#playerMemory.notebook[method].bind(this.#playerMemory.notebook)])),
				...(typeof this.#playerMemory.notebook.recordNotSent === 'function' ? { recordNotSent: this.#playerMemory.notebook.recordNotSent.bind(this.#playerMemory.notebook) } : {}),
				recordReceipt: async () => {},
			},
			memoryOperation: (record, operation) => this.#playerMemory.execute(record, operation),
			taskContext: (record) => this.#playerMemory.taskContext(record),
			memoryObservation: (record, observation, options) => {
				// This callback sees only accepted snapshots, including quiet heartbeats and requested samples.
				this.#trackRunningAction(record.agentId, observation);
				return this.#playerMemory.observe(record, observation, options);
			},
			executionSettings: (record) => this.#planner.getExecutionSettings?.(record.agentId) ?? null,
			// Preparation needs the whole response-to-request path (adapter delivery included), as one sample series.
			planningLeadTime: (record) => {
				const timing = this.#planner.getNativeDecisionTiming?.(record.agentId);
				return timing?.responseGapP95Ms ?? timing?.p95Ms ?? null;
			},
			onModelActionCancelled: (record) => this.#releaseHeldWakeForCancelledAction(record),
			occupancy,
			bridge: nativeBridge,
			registry: this.#registry,
			trace: (event, fields) => this.#writeTrace(event, fields),
			onFinish: async ({ record, result, lifecycleGeneration }) => {
				const connectionEpoch = this.#nativeRuntimeEpochs.get(record.agentId);
				if (this.#stopping || this.#closed || !this.#isConnectionEpochCurrent(connectionEpoch)) return;
				const current = this.#registry.get(record.agentId);
				if (current === null || current.goalRevision !== record.goalRevision
					|| !this.#isLifecycleGenerationCurrent(record.agentId, lifecycleGeneration)) return;
				if (result.state === 'COMPLETED') {
					this.#goalSupervisor.terminate(this.#supervisionKey(current, lifecycleGeneration));
					this.#registry.setState(record.agentId, DynamicAgentState.COMPLETED, { goalRevision: record.goalRevision });
				}
			},
			onWorkStarted: (record, kind, options) => {
				const key = this.#supervisionKey(record);
				this.#goalSupervisor.activate(key);
				const token = this.#goalSupervisor.begin(key, kind, options);
				const programLease = kind === 'program' ? { token, programId: options.programId } : null;
				if (programLease !== null) this.#nativeProgramLeases.set(record.agentId, programLease);
				let released = false;
				const release = () => {
					if (released) return;
					released = true;
					if (this.#nativeProgramLeases.get(record.agentId) === programLease) this.#nativeProgramLeases.delete(record.agentId);
					this.#goalSupervisor.end(token);
				};
				// Time a reflex held the body moves the lease out with the program's own deadline.
				release.extend = (ms) => !released && this.#goalSupervisor.extend?.(token, ms);
				return release;
			},
			onProgramEvent: (record, event) => {
				// Already-authorized successor work owns the body; no planner wake is needed.
				if (event.event === 'program_handoff_started') {
					this.#writeTrace('native_program_handoff_started', { agentId: record.agentId, goalRevision: record.goalRevision,
						programId: event.programId, predecessorProgramId: event.predecessorProgramId, queueId: event.queueId,
						...(event.predecessorActionsFailed > 0 ? { predecessorActionsFailed: event.predecessorActionsFailed } : {}) });
					return;
				}
				const connectionEpoch = this.#nativeRuntimeEpochs.get(record.agentId);
				const lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
				const current = this.#registry.get(record.agentId);
				if (this.#stopping || this.#closed || !this.#isConnectionEpochCurrent(connectionEpoch)
					|| current?.goalRevision !== record.goalRevision || ![DynamicAgentState.PLANNING, DynamicAgentState.ACTING].includes(current.state)) return;
				this.#scheduleNativeTurn(current, { agentId: current.agentId, goalRevision: current.goalRevision,
					observation: event.observation, eventSequence: event.eventSequence, preserveState: true,
					priority: event.priority ?? event.status?.decision?.priority ?? 'ordinary', trigger: event.status?.decision?.trigger ?? event.event,
					connectionEpoch, lifecycleGeneration, nativeEvent: event });
			},
		});
		this.#setStatusInterval = requireDependency(setStatusInterval, 'setStatusInterval');
		this.#healthSamplerFactory = healthSampler === undefined ? () => createHealthSampler() : () => healthSampler;
		this.#clearStatusInterval = requireDependency(clearStatusInterval, 'clearStatusInterval');
		this.#setGoalSpecTimeout = requireDependency(setGoalSpecTimeout, 'setGoalSpecTimeout');
		this.#clearGoalSpecTimeout = requireDependency(clearGoalSpecTimeout, 'clearGoalSpecTimeout');
		this.#taskRequestTimeoutMs = taskRequestTimeoutMs;
	}

	get registry() { return this.#registry; }
	get bridge() { return this.#bridge; }

	/**
	 * With the compact heard section present, a perception change made only of new raw sound packets is
	 * already summarised there (and heard lava raises its own "heard" fact), so it is not attention by itself.
	 */
	#withoutSoundOnlyAttention(agentId, payload, wireObservation) {
		const perception = wireObservation?.perception;
		const latest = Number.isSafeInteger(perception?.latestSequence) ? perception.latestSequence : null;
		const previous = this.#perceptionSequences.get(agentId);
		if (latest !== null) this.#perceptionSequences.set(agentId, latest);
		const agentNames = this.#registry.list().map((record) => record.name);
		return routinePerceptionChange(payload, wireObservation, previous, this.#registry.get(agentId)?.name, agentNames) ? { ...payload, attention: false, changedFacts: [] } : payload;
	}

	/**
	 * A sighting wake whose new rows show only what the agent placed itself (its crafting table, furnace and cobblestone
	 * read as a built cluster) is no news: the fact is dropped, and the attention with it when nothing else changed.
	 */
	#withoutOwnSightings(agentId, payload, wireObservation) {
		if (!Array.isArray(payload?.changedFacts) || !payload.changedFacts.includes('sighted')) return payload;
		let placed;
		try { placed = this.#observedMemory.ownPlacements(agentId, wireObservation); } catch { return payload; }
		return withoutOwnSightings(payload, wireObservation, placed);
	}

	requestSupervisedObservation(key) {
		if (this.#stopping || this.#closed || key === null || typeof key !== 'object') return false;
		const record = this.#registry.get(key.agentId);
		if (record === null || record.goalRevision !== key.goalRevision
			|| !this.#isConnectionEpochCurrent(key.sessionEpoch)
			|| !this.#isLifecycleGenerationCurrent(key.agentId, key.lifecycleGeneration)
			|| key.profileFingerprint !== profileFingerprint(record)) return false;
		// DEAD snapshots are not admitted by the ordinary observation handler.
		// Rebuild the death request from current facts instead of requesting a sample
		// that cannot consume recovery. The lease supplies the retry backoff.
		if (this.#usesNativeTools(record) && record.state === DynamicAgentState.DEAD) {
			return this.#installDeadStatePlan(record, record.death, key.sessionEpoch);
		}
		const conversationRecovery = this.#nativeConversationRecoveries.get(key.agentId);
		if (conversationRecovery !== undefined && sameSupervisionKey(conversationRecovery.supervisionKey, key)) {
			this.#nativeConversationRecoveries.delete(key.agentId);
			this.#scheduleNativeTurn(record, conversationRecovery.request);
			return true;
		}
		if (this.#usesNativeTools(record)) {
			this.#supervisedObservationRequests.set(key.agentId, {
				goalRevision: key.goalRevision,
				lifecycleGeneration: key.lifecycleGeneration,
				connectionEpoch: key.sessionEpoch,
			});
		}
		return this.#bridge.send('request_observation', key.agentId, { goalRevision: key.goalRevision });
	}

	handleLeaseExpired({ key, lease }) {
		if (this.#stopping || this.#closed || !this.#isLifecycleGenerationCurrent(key.agentId, key.lifecycleGeneration)) return;
		const connectionEpoch = this.#connectionEpoch;
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
		const record = this.#registry.get(key.agentId);
		if (record === null || record.goalRevision !== key.goalRevision) return;
		if (key.sessionEpoch !== connectionEpoch || key.profileFingerprint !== profileFingerprint(record)) return;
		this.#writeTrace('work_lease_expired', { ...key, kind: lease.kind, operationId: lease.operationId });
		this.#publishVerbose(key.agentId, key.goalRevision, 'retry', `${lease.kind} work timed out; recovering automatically.`);
		if (lease.kind === 'program') {
			const owned = this.#nativeProgramLeases.get(key.agentId);
			if (owned?.token.operationId === lease.operationId) {
				// The executor deadline and outer lease can fire in either order.
				// Settle only this program, retaining its physical cancellation fence.
				void this.#nativeRuntime.expireProgram(record, owned.programId)
					.catch((error) => this.#reportAgentError(key.agentId, error, connectionEpoch));
			}
			return;
		}
		let preserveProgram = false;
		if (lease.kind === 'provider') {
			const work = this.#providerWork.get(key.agentId);
			if (work?.kind === 'native' && work.goalRevision === key.goalRevision
				&& work.lifecycleGeneration === key.lifecycleGeneration
				&& work.supervisionToken?.operationId === lease.operationId) {
				preserveProgram = this.#preparationHasRunningProgram(work, record);
				work.expired = true;
				this.#restoreNativeConversation(work.steerRequest);
				this.#restoreNativeConversation(work.request);
				if (work.request.conversationOnly === true) {
					this.#nativeConversationRecoveries.set(work.agentId, {
						supervisionKey: work.supervisionKey,
						request: work.request,
					});
				}
				this.#providerWork.delete(key.agentId);
			}
			try {
				void Promise.resolve(this.#planner.interrupt(key.agentId, 'Provider work lease expired'))
					.catch((error) => this.#reportAgentError(key.agentId, error, connectionEpoch));
			} catch (error) {
				void this.#reportAgentError(key.agentId, error, connectionEpoch);
			}
		}
		if (['provider', 'action', 'completion'].includes(lease.kind) && !preserveProgram) {
			this.#nativeObservationSignatures.delete(key.agentId);
			void this.#nativeRuntime.dispose(key.agentId, `${lease.kind}_lease_expired`)
				.catch((error) => this.#reportAgentError(key.agentId, error, connectionEpoch));
		}
	}

	handleGoalStuck({ key, inactiveMs, history }) {
		if (this.#stopping || this.#closed || !this.#isLifecycleGenerationCurrent(key.agentId, key.lifecycleGeneration)) return;
		const record = this.#registry.get(key.agentId);
		if (record === null || record.goalRevision !== key.goalRevision) return;
		if (key.sessionEpoch !== this.#connectionEpoch || key.profileFingerprint !== profileFingerprint(record)) return;
		this.#rememberPendingAttention(key.agentId, key.goalRevision, { priority: 'urgent', trigger: 'stuck' });
		this.#writeTrace('goal_factual_progress_stuck', { ...key, inactiveMs, positionSamples: history.length });
		this.#publishVerbose(key.agentId, key.goalRevision, 'retry', 'No factual world progress for 30 seconds; reassessing without pausing the goal.');
	}

	async start() {
		if (this.#started) return;
		if (this.#closed) throw new Error('Dynamic coordinator cannot restart after it has been stopped');
		this.#stopping = false;
		try {
			this.#bindBridge();
			this.#bridge.start();
			this.#health = this.#healthSamplerFactory();
			this.#statusHandle = this.#setStatusInterval(() => {
				try {
					const health = this.#health?.sample({ inboundQueued: this.#bridge.inboundQueued ?? null, agentOperations: this.#totalAgentOperations });
					if (health) this.#writeTrace('coordinator_health', health);
				} catch { /* health rows are observational; status and recovery still run */ }
				const connectionEpoch = this.#connectionEpoch;
				this.#requestProviderRecovery(connectionEpoch);
				this.#run(() => this.#publishStatus(connectionEpoch), connectionEpoch);
			}, 1_000);
			this.#started = true;
		} catch (error) {
			if (this.#statusHandle !== null) this.#clearStatusInterval(this.#statusHandle);
			this.#statusHandle = null;
			this.#health?.close();
			this.#health = null;
			this.#bridge.stop();
			this.#unbindBridge();
			await this.#codexService.stop();
			throw error;
		}
	}

	stop() {
		if (this.#stopPromise !== null) return this.#stopPromise;
		this.#stopPromise = this.#stopOnce();
		return this.#stopPromise;
	}

	async #stopOnce() {
		if (this.#closed) return;
		this.#stopping = true;
		const receipts = [...this.#receiptReconciliations.values()];
		for (const receipt of receipts) { clearTimeout(receipt.retry); receipt.resolve(); }
		this.#inspections.cancel();
		this.#connected = false;
		this.#verboseTransitions.clearAll();
		if (this.#statusHandle !== null) this.#clearStatusInterval(this.#statusHandle);
		this.#statusHandle = null;
		this.#health?.close();
		this.#health = null;
		this.#bridge.stop();
		this.#unbindBridge();
		this.#scheduler.close('Dynamic coordinator stopped');
		this.#goalSupervisor.close();
		await Promise.allSettled([this.#reconciliation, ...[...this.#agentOperations.values()].map((queue) => queue.drainPromise)]);
		await Promise.all([...this.#pendingConversationInboxes.values()].map((inbox) => inbox.close().catch((error) => this.#emitRuntimeError(error))));
		this.#pendingConversationInboxes.clear();
		this.#agentOperations.clear();
		this.#agentOperationCounts.clear();
		this.#totalAgentOperations = 0;
		this.#providerWork.clear();
		this.#pendingAttention.clear();
		this.#dropAllDeferredWakes();
		this.#attentionFlushes.clear();
		this.#lifecycleGenerations.clear();
		this.#programRuntime.disposeAll();
		// Release native waiters immediately, independently of stalled terminal I/O.
		const nativeDisposal = this.#nativeRuntime.disposeAll();
		const closeMemory = async () => {
			await Promise.all([Promise.allSettled(receipts.map((receipt) => receipt.pending)), nativeDisposal]);
			await this.#playerMemory.markUnknown(undefined, 'COORDINATOR_STOPPED');
			await this.#playerMemory.flush();
		};
		// A stuck receipt write cannot hold shutdown forever. Unacknowledged
		// terminals remain in the server journal for replay on the next session.
		let receiptShutdownTimer;
		await Promise.race([
			closeMemory().catch((error) => this.#emitRuntimeError(error)),
			...(receipts.length === 0 ? [] : [new Promise((resolve) => {
				receiptShutdownTimer = setTimeout(() => {
					this.#emitRuntimeError(codedRuntimeError('RECEIPT_SHUTDOWN_PENDING', 'Receipt storage has not settled; server results remain unacknowledged for replay'));
					resolve();
				}, 1_000);
			})]),
		]);
		clearTimeout(receiptShutdownTimer);
		this.#receiptReconciliations.clear();
		this.#latestActionDispatches.clear();
		for (const receipt of receipts) receipt.resolve();
		await this.#taskViews.flush().catch((error) => this.#emitRuntimeError(error));
		this.#traceUsageSamples.clear();
		this.#providerDiscovery.stop();
		this.#memorySummaries.clear();
		this.#providerRetryAfter.clear();
		this.#providerProbeDeadlines.clear();
		this.#deferredProviderRecovery.clear();
		this.#programRuntimeEpochs.clear();
		this.#nativeRuntimeEpochs.clear();
		this.#factLedgers.clear();
		this.#conversationMemories.clear();
		this.#contextCursors.clear();
		this.#nativeConversationRecoveries.clear();
		this.#nativeObservationSignatures.clear();
		this.#hazardContacts.clear();
		this.#survivalRestartAt.clear();
		this.#survivalQuietSince.clear();
		this.#nativeWorldSignals.clear();
		this.#nativeConfirmationWaits.clear();
		this.#supervisedObservationRequests.clear();
		this.#conversationWakeTransactions.clear();
		this.#settleTaskRequests(undefined, 'COORDINATOR_STOPPING', 'The coordinator is stopping.');
		this.#cancelGoalSpecRequests();
		// Provider stop settles final turn capture before either diagnostic sink closes.
		await this.#codexService.stop();
		if (this.#providerTurnRecorder !== null) {
			await this.#scheduler.drain?.();
			await this.#providerTurnRecorder.close();
		}
		if (this.#traceWriter !== null && typeof this.#traceWriter.close === 'function') await this.#traceWriter.close();
		this.#started = false;
		this.#stopping = false;
		this.#closed = true;
	}

	#bindBridge() {
		this.#listen('inspection_result', (message) => { this.#inspections.accept(message); });
		this.#bindProviderRecovery();
		this.#listen('ready', (connection) => {
			const connectionEpoch = this.#acceptReadyEpoch(connection);
			if (connectionEpoch === null) return;
			const { serverInstanceId, registry } = connection;
			this.#verboseTransitions.clearAll();
			if (this.#serverInstanceId !== null && serverInstanceId !== this.#serverInstanceId) {
				this.#invalidateServerInstance(connectionEpoch);
			}
			this.#serverInstanceId = serverInstanceId;
			this.#logProviderCliHealthAtStartup();
			this.#reconciledStatus = false;
			this.#supportedAgentIds.clear();
			this.#beginReconciliation(registry, connectionEpoch);
		}, { lifecycle: true });
		this.#listen('catalog_request', (_message, connectionEpoch) => this.#run(async () => {
			await this.#reconciliation;
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			// A player's Rescan: re-run discovery (CLIs, accounts) and every provider's model list.
			await this.#providerDiscovery.refresh({ force: true }).catch(() => {});
			const catalog = await this.#codexService.catalog.refresh({ force: true });
			await this.#publishCatalog(catalog, connectionEpoch);
		}, connectionEpoch));
		this.#listen('agent_registered', (message, connectionEpoch) => this.#enqueueAgent(message.agentId, async () => {
			const previous = this.#registry.get(message.agentId);
			const record = this.#registry.register(message.payload.record === undefined
				? { ...message.payload, agentId: message.agentId }
				: { ...message.payload.record, agentId: message.agentId });
			this.#codexService.catalog.assertSupported(record.provider, record.model, record.reasoningEffort, record.serviceTier ?? defaultServiceTier(record.provider));
			const replacesDeath = previous?.state === DynamicAgentState.DEAD && record.state === DynamicAgentState.DEAD
				&& record.goalRevision > previous.goalRevision;
			let lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
			const isCurrent = () => this.#isConnectionEpochCurrent(connectionEpoch)
				&& this.#isLifecycleGenerationCurrent(record.agentId, lifecycleGeneration)
				&& this.#registry.get(record.agentId)?.goalRevision === record.goalRevision;
			if (replacesDeath) {
				this.#cancelGoalSpecRequests(record.agentId);
				this.#retireGoalSupervision(previous, 'replace');
				this.#invalidateAcceptedLifecycle(record.agentId);
				lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
				this.#beginGoalControlInterruption({ agentId: record.agentId, payload: { operation: 'steer' } }, connectionEpoch);
				this.#programRuntime.onGoalControl(previous, 'steer');
				await this.#nativeRuntime.dispose(record.agentId, 'dead_registration_replaced');
				if (!isCurrent()) return;
			}
			await this.#sendForEpoch(connectionEpoch, 'agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
			if (!isCurrent()) return;
			this.#supportedAgentIds.add(record.agentId);
			this.#usageLedger.registerAgent(record);
			this.#publishVerbose(record.agentId, record.goalRevision, 'lifecycle', 'Agent registered and ready.', connectionEpoch);
			this.#prewarmNativeAgent(record);
			this.#checkProviderCli(record, connectionEpoch);
			if (replacesDeath) {
				const recovery = this.#installDeadStatePlan(record, record.death, connectionEpoch);
				if (this.#usesNativeTools(record)) void recovery.catch((error) => this.#reportAgentError(record.agentId, error, connectionEpoch));
				else await recovery;
			}
			await this.#publishStatus(connectionEpoch);
		}, { connectionEpoch, transactional: true }));
		this.#listen('agent_removed', (message, connectionEpoch) => this.#run(async () => {
			await this.#reconciliation;
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			this.#publishVerbose(message.agentId, message.payload.goalRevision, 'lifecycle', 'Agent removed from the coordinator roster.', connectionEpoch);
			// Removal also owns persisted mailboxes not yet opened after restart.
			const inbox = this.#pendingConversationInbox(message.agentId);
			inbox.fence();
			const current = this.#registry.get(message.agentId);
			if (current !== null) this.#goalSupervisor.terminate(this.#supervisionKey(current));
			this.#programRuntime.dispose(message.agentId);
			await this.#nativeRuntime.dispose(message.agentId, 'agent_removed');
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			this.#traceUsageSamples.delete(message.agentId);
			this.#usageLedger.removeAgent(message.agentId);
			this.#providerWork.delete(message.agentId);
			this.#verboseTransitions.clear(message.agentId);
			this.#programRuntimeEpochs.delete(message.agentId);
			this.#nativeRuntimeEpochs.delete(message.agentId);
			this.#pendingAttention.delete(message.agentId);
			this.#dropDeferredWake(message.agentId);
			this.#attentionFlushes.delete(message.agentId);
			await this.#planner.remove(message.agentId);
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			this.#lifecycleGenerations.delete(message.agentId);
			this.#providerRetryAfter.delete(message.agentId);
			this.#providerProbeDeadlines.delete(message.agentId);
			this.#deferredProviderRecovery.delete(message.agentId);
			this.#factLedgers.delete(message.agentId);
			this.#memorySummaries.delete(message.agentId);
			this.#playerMemory.forget(message.agentId);
			this.#conversationMemories.delete(message.agentId);
			this.#contextCursors.delete(message.agentId);
			await inbox.remove(() => this.#isConnectionEpochCurrent(connectionEpoch));
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			this.#nativeConversationRecoveries.delete(message.agentId);
			this.#nativeObservationSignatures.delete(message.agentId);
			this.#hazardContacts.delete(message.agentId);
			this.#survivalQuietSince.delete(message.agentId);
			this.#nativeWorldSignals.delete(message.agentId);
			this.#eventContexts.delete(message.agentId);
			this.#situationChanges.delete(message.agentId);
			this.#contextEntries.delete(message.agentId);
			this.#runningActions.delete(message.agentId);
			this.#healNudges.delete(message.agentId);
			this.#nativeConfirmationWaits.delete(message.agentId);
			this.#confirmationActivity.delete(message.agentId);
			this.#supervisedObservationRequests.delete(message.agentId);
			this.#settleTaskRequests(message.agentId, 'AGENT_REMOVED', 'This agent was removed.');
			this.#forgetConversationWakes(message.agentId);
			this.#cancelGoalSpecRequests(message.agentId);
			this.#supportedAgentIds.delete(message.agentId);
			try {
				void Promise.resolve(this.#runtimeHooks.onRemoved?.(message.agentId)).catch((error) => this.#emitRuntimeError(error));
			} catch (error) { this.#emitRuntimeError(error); }
			await this.#publishStatus(connectionEpoch);
		}, connectionEpoch));

		this.#listen('goal_spec_request', (message, connectionEpoch) => {
			const key = this.#goalSpecRequestKey(message.agentId, message.payload.requestId);
			const { playerState, ...intent } = message.payload;
			const fingerprint = JSON.stringify(intent);
			const existing = this.#goalSpecRequests.get(key);
			if (existing !== undefined) {
				if (existing.fingerprint !== fingerprint) {
					this.#emitRuntimeError(new ProtocolV2Error('TRANSACTION_COLLISION', `Goal translation request '${message.payload.requestId}' changed during replay`));
					return;
				}
				if (existing.proposal !== null) {
					void this.#sendForEpoch(connectionEpoch, 'goal_spec_proposal', message.agentId, existing.proposal).catch((error) => this.#emitRuntimeError(error));
				}
				return existing.completion;
			}
			if (this.#goalSpecRequests.size >= this.#goalSpecRequestCap) {
				throw new ProtocolV2Error('GOAL_SPEC_REQUEST_BACKPRESSURE', 'Coordinator goal translation request capacity is full');
			}
			const releaseCapacity = this.#reserveAgentOperation(message.agentId);
			let resolveCompletion;
			const completion = new Promise((resolve) => { resolveCompletion = resolve; });
			const entry = {
				agentId: message.agentId, requestId: message.payload.requestId, request: message.payload,
				fingerprint, proposal: null, attempts: 0, rejectionAttempts: 0, correctiveFeedback: null, serverRejected: false,
				translating: false, retryHandle: null, connectionEpoch, completion, resolveCompletion, releaseCapacity,
			};
			this.#goalSpecRequests.set(key, entry);
			const initialProcessing = this.#run(() => this.#processGoalSpecRequest(key, entry), connectionEpoch);
			return Promise.all([initialProcessing, completion]);
		});
		this.#listen('goal_spec_result', (message, connectionEpoch) => {
			const key = this.#goalSpecRequestKey(message.agentId, message.payload.requestId);
			const existing = this.#goalSpecRequests.get(key);
			if (existing === undefined || existing.proposal === null) return;
			if (message.payload.status === 'accepted' || TERMINAL_GOAL_SPEC_REJECTIONS.has(message.payload.reasonCode)) {
				this.#forgetGoalSpecRequest(key, existing);
				return;
			}
			if (existing.retryHandle !== null) {
				this.#clearGoalSpecTimeout(existing.retryHandle);
				existing.retryHandle = null;
			}
			existing.rejectionAttempts += 1;
			existing.serverRejected = true;
			existing.correctiveFeedback = {
				attempt: existing.rejectionAttempts,
				reasonCode: message.payload.reasonCode,
				rejectedProposal: existing.proposal,
			};
			existing.proposal = null;
			try { this.#planner.cancelGoalSpec?.(message.agentId, message.payload.requestId); } catch { /* completed translation cleanup is best effort */ }
			if (existing.rejectionAttempts <= MAX_GOAL_SPEC_CORRECTION_ATTEMPTS) {
				const delay = Math.min(GOAL_SPEC_RETRY_MAX_MS, GOAL_SPEC_RETRY_BASE_MS * (2 ** (existing.rejectionAttempts - 1)));
				this.#scheduleGoalSpecRequest(key, existing, delay);
				return;
			}
			this.#forgetGoalSpecRequest(key, existing);
			void this.#reportAgentError(message.agentId, codedRuntimeError(
				'GOAL_SPEC_TRANSLATION_REJECTED',
				`Minecraft rejected ${MAX_GOAL_SPEC_CORRECTION_ATTEMPTS + 1} goal translation proposals; the pending draft requires operator correction or cancellation`,
			), connectionEpoch);
		});
		this.#listen('task_view_request', (message, connectionEpoch) => {
			const record = this.#registry.get(message.agentId);
			if (record === null || record.goalRevision !== message.payload.goalRevision) return;
			return this.#sendForEpoch(connectionEpoch, 'task_view', record.agentId, this.#taskViewWithRoster(record));
		});
		this.#listen('goal_control', (message, connectionEpoch) => {
			let record;
			let nativeDisposal = Promise.resolve();
			let lifecycleGeneration;
			return this.#enqueueAgent(message.agentId, async () => {
				await nativeDisposal;
				const acceptedStillCurrent = () => {
					const current = this.#registry.get(message.agentId);
					return this.#isConnectionEpochCurrent(connectionEpoch)
						&& current !== null && current.goalRevision === record.goalRevision
						&& this.#isLifecycleGenerationCurrent(message.agentId, lifecycleGeneration);
				};
				if (!acceptedStillCurrent()) return;
				this.#publishVerbose(record.agentId, record.goalRevision, 'lifecycle', `Goal lifecycle operation '${message.payload.operation}' accepted.`, connectionEpoch);
				if (!['queue', 'dequeue'].includes(message.payload.operation)) {
					this.#providerRetryAfter.delete(message.agentId);
				}
				if (message.payload.operation === 'dead') {
					void this.#installDeadStatePlan(record, message.payload.death, connectionEpoch).catch((error) => this.#reportAgentError(record.agentId, error, connectionEpoch));
				}
				const resumesGoal = ['start', 'replace', 'resume', 'steer'].includes(message.payload.operation)
					|| message.payload.operation === 'respawn' && record.state === DynamicAgentState.STARTING;
				const activatesQueuedGoal = message.payload.operation === 'complete' && record.state === DynamicAgentState.STARTING;
				if (resumesGoal || activatesQueuedGoal) {
					this.#goalSupervisor.activate(this.#supervisionKey(record));
				}
				if (resumesGoal) {
					this.#rememberPendingAttention(record.agentId, record.goalRevision, {
						priority: message.payload.operation === 'steer' ? 'urgent' : 'ordinary',
						trigger: message.payload.operation,
					});
				}
				if (resumesGoal) {
					await this.#sendForEpoch(connectionEpoch, 'agent_ready', record.agentId, { goalRevision: record.goalRevision });
				}
				if (!acceptedStillCurrent()) return;
				if (message.payload.operation === 'complete' && record.state === DynamicAgentState.COMPLETED) {
					await this.#resumeUnreadNativeConversation(record, connectionEpoch, lifecycleGeneration);
					if (!acceptedStillCurrent()) return;
				}
				this.emit('goalControl', record);
			}, {
				connectionEpoch,
				transactional: true,
				onAdmitted: () => {
					const previous = this.#registry.get(message.agentId);
					record = this.#registry.applyGoalControl(message.agentId, message.payload);
					if (['start','replace','steer'].includes(message.payload.operation)) this.#taskViews.begin(record, { fresh: ['start','replace'].includes(message.payload.operation) });
					if (message.payload.operation === 'dead') this.#traceDeath(record, message.payload.death);
					// The death screen's respawn target is where the next body appears: the plan's spawn:bed fact.
					if (message.payload.operation === 'dead') void this.#taskViews.observe(record, { ready: false, player: { dead: true }, ...(message.payload.death ? { death: message.payload.death } : {}) }).catch(() => {});
					const lifecycleChanged = previous !== null && !['queue', 'dequeue'].includes(message.payload.operation)
						&& (record.goalRevision > previous.goalRevision
							|| (record.goalRevision === previous.goalRevision && ['dead', 'respawn'].includes(message.payload.operation)));
					if (lifecycleChanged) {
						this.#cancelGoalSpecRequests(message.agentId);
						this.#retireGoalSupervision(previous, message.payload.operation);
						this.#invalidateAcceptedLifecycle(message.agentId);
						if (['dead', 'respawn'].includes(message.payload.operation)) {
							// Admission must retain this need even if task-memory loading or a later control cancels the input.
							const context = this.#assessmentContext(record);
							context.pending = ++context.generation;
						}
						this.#beginGoalControlInterruption(message, connectionEpoch);
						this.#programRuntime.onGoalControl(previous, message.payload.operation);
						nativeDisposal = Promise.resolve(this.#nativeRuntime.dispose(previous.agentId, `goal_${message.payload.operation}`));
					}
					lifecycleGeneration = this.#lifecycleGeneration(message.agentId);
				},
			});
		});
		this.#listen('conversation_event', (message, connectionEpoch) => {
			return this.#enqueueAgent(message.agentId, async () => {
				this.#publishVerbose(message.agentId, message.payload.goalRevision, 'conversation', `Conversation event '${message.payload.kind}' received from '${message.payload.sourceId}'.`, connectionEpoch);
				const ingested = await this.#admitConversation(message.agentId, message.payload, connectionEpoch);
				const record = this.#registry.get(message.agentId);
				// Recipient-side evidence for harnesses: this runtime accepted the message (and whether it wakes the agent).
				if (ingested && record !== null) {
					this.emit('conversationAdmitted', { agentId: record.agentId, goalRevision: record.goalRevision, sequence: message.payload.sequence,
						sourceId: message.payload.sourceId, wakes: conversationWakes(message.payload) });
				}
				// Context-only chat stays unread in the inbox and rides the next wake.
				if (ingested && record !== null && conversationWakes(message.payload)) {
					this.#rememberPendingAttention(record.agentId, record.goalRevision, { priority: 'urgent', trigger: 'conversation' });
					if (this.#usesNativeTools(record)) this.#scheduleNativeConversation(record, message.payload, 'conversation');
					else {
						if ([DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING, DynamicAgentState.DEAD].includes(record.state)) {
							this.#goalSupervisor.activate(this.#supervisionKey(record));
						}
						this.#schedulePendingAttentionFlush(record);
					}
				}
				this.emit('conversationEvent', message);
			}, { waitForReconciliation: false, connectionEpoch, transactional: true });
		});
		this.#listen('conversation_wake', (message, connectionEpoch) => {
			return this.#enqueueAgent(message.agentId, async () => {
				this.#publishVerbose(message.agentId, message.payload.event.goalRevision, 'conversation', `Conversation wake '${message.payload.event.kind}' received.`, connectionEpoch);
				const fingerprint = JSON.stringify({ agentId: message.agentId, event: message.payload.event, control: message.payload.control });
				const existing = this.#conversationWakeTransactions.get(message.payload.transactionId);
				if (existing !== undefined) {
					if (existing.fingerprint !== fingerprint) {
						throw new ProtocolV2Error('TRANSACTION_COLLISION', `Conversation wake '${message.payload.transactionId}' changed during replay`);
					}
					const record = this.#registry.applyConversationWake(message.agentId, message.payload.control);
					this.#goalSupervisor.activate(this.#supervisionKey(record));
					this.#providerRetryAfter.delete(message.agentId);
					await this.#sendForEpoch(connectionEpoch, 'conversation_wake_ack', message.agentId, {
						transactionId: message.payload.transactionId,
						goalRevision: record.goalRevision,
					});
					await this.#sendForEpoch(connectionEpoch, 'agent_ready', record.agentId, { goalRevision: record.goalRevision });
					return;
				}
				const previous = this.#registry.get(message.agentId);
				if (this.#usesNativeTools(previous)) {
					await this.#pendingConversationInbox(message.agentId).checkWake(this.#serverInstanceId, message.payload.event,
						{ transactionId: message.payload.transactionId, fingerprint });
					if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
				}
				let record;
				try {
					record = this.#registry.applyConversationWake(message.agentId, message.payload.control);
				} catch (error) {
					if (error instanceof AgentRegistryError && ['STALE_GOAL_REVISION', 'GOAL_REVISION_COLLISION', 'INVALID_AGENT_STATE'].includes(error.code)) return;
					throw error;
				}
				if (previous !== null && record.goalRevision > previous.goalRevision) {
					this.#retireGoalSupervision(previous, message.payload.control.operation);
					this.#invalidateAcceptedLifecycle(message.agentId);
					this.#programRuntime.onGoalControl(previous, message.payload.control.operation);
					await this.#nativeRuntime.dispose(previous.agentId, 'conversation_wake');
					if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
				}
				await this.#admitConversation(message.agentId, message.payload.event, connectionEpoch,
					{ transactionId: message.payload.transactionId, fingerprint });
				this.#goalSupervisor.activate(this.#supervisionKey(record));
				this.#providerRetryAfter.delete(message.agentId);
				this.#rememberPendingAttention(record.agentId, record.goalRevision, { priority: 'urgent', trigger: 'conversation_wake' });
				if (this.#usesNativeTools(record)) this.#scheduleNativeConversation(record, message.payload.event, 'conversation_wake');
				else this.#schedulePendingAttentionFlush(record);
				this.#rememberConversationWake(message.payload.transactionId, message.agentId, fingerprint);
				await this.#sendForEpoch(connectionEpoch, 'conversation_wake_ack', record.agentId, {
					transactionId: message.payload.transactionId,
					goalRevision: record.goalRevision,
				});
				await this.#sendForEpoch(connectionEpoch, 'agent_ready', record.agentId, { goalRevision: record.goalRevision });
				this.emit('conversationEvent', { ...message, payload: message.payload.event });
				this.emit('goalControl', record);
			}, { waitForReconciliation: false, connectionEpoch, transactional: true });
		});
		for (const type of ['plan_facts', 'advancement_granted', 'entity_killed']) this.#listen(type, (message, connectionEpoch) => this.#enqueueAgent(message.agentId, async () => {
			const record = this.#registry.assertCurrentRevision(message.agentId, message.payload.goalRevision);
			await this.#taskViews.receipt(record, message.payload);
			// 1b: every kill is traced; position (not at, which the trace keeps as its timestamp) only for a kill the body saw.
			if (type === 'entity_killed') this.#writeTrace('entity_killed', killTraceFields(record, message.payload));
		}, { connectionEpoch }));
		this.#listen('observation', (message, connectionEpoch) => {
			// On arrival, before the agent's queue: a death's trace row carries the last 10 s of live samples, whatever the goal state.
			this.#deathRecorder.observe(message.agentId, message.payload?.observation ?? message.payload);
			const receiptMonotonicMs = safeClockRead(this.#controlNow);
			const receiptEpochMs = safeClockRead(this.#epochNow);
			const lifecycleGeneration = this.#lifecycleGeneration(message.agentId);
			return this.#enqueueAgent(message.agentId, async () => {
				if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
				if (!this.#isLifecycleGenerationCurrent(message.agentId, lifecycleGeneration)) return;
				const record = this.#registry.assertCurrentRevision(message.agentId, message.payload.goalRevision);
				// Parked native agents still own their body: danger must reach the model without resuming their goal.
				const noTask = this.#usesNativeTools(record) && PARKED_NATIVE_STATES.includes(record.state);
				if (!noTask && ![DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING].includes(record.state)) return;
				const wireObservation = message.payload.observation ?? message.payload;
				const supervisionKey = this.#supervisionKey(record, lifecycleGeneration);
				this.#goalSupervisor.factualProgress(supervisionKey, factualProgressSignature(wireObservation), factualProgressDetails(wireObservation));
				if (this.#usesNativeTools(record)) this.#nativeRuntimeEpochs.set(record.agentId, connectionEpoch);
				let observation;
				try { observation = adaptObservation(wireObservation); }
				catch (error) {
					// The sample is still dropped and reported as agent_error; the trace names the field that failed.
					this.#writeTrace('observation_rejected', { agentId: record.agentId, goalRevision: record.goalRevision,
						eventSequence: Number.isSafeInteger(wireObservation?.eventSequence) ? wireObservation.eventSequence : null, ...rejectionTraceFields(error, 'INVALID_OBSERVATION') });
					throw error;
				}
				const refreshMemorySummary = () => {
					const memoryKey = `${record.goalRevision}:${this.#playerMemory.worldId(record)}`;
					if (this.#memorySummaries.get(record.agentId)?.key !== memoryKey) {
						return this.#playerMemory.unresolved(record, { limit: 8 }).then((unresolved) => {
							if (!this.#isConnectionEpochCurrent(connectionEpoch) || !this.#isLifecycleGenerationCurrent(record.agentId, lifecycleGeneration)) return false;
							this.#memorySummaries.set(record.agentId, { key: memoryKey, unresolved });
							return true;
						});
					}
				};
				const worldSignals = this.#usesNativeTools(record)
					? this.#rememberNativeWorldSignals(record, lifecycleGeneration, connectionEpoch, observation)
					: null;
				// Stored and shown with this sample only, like the result it came with.
				if (worldSignals?.toolBreak != null) observation.toolBroke = worldSignals.toolBreak;
				if (worldSignals?.dragonPerch != null) observation.dragonPerch = worldSignals.dragonPerch;
				if (worldSignals?.endCrystals != null) observation.endCrystals = worldSignals.endCrystals;
				// After the world signals, so the plan's stage checks read the same End crystal tally the wake shows.
				await this.#taskViews.observe(record, observation, wireObservation).catch((error) => this.#writeTrace('task_view_observation_error', { code: error?.code ?? 'PLAN_VIEW_ERROR' }));
				const classified = classifyObservationTrigger(this.#withoutOwnSightings(record.agentId, this.#withoutSoundOnlyAttention(record.agentId, message.payload, wireObservation), wireObservation), wireObservation, worldSignals);
				let pendingAttention = this.#pendingAttention.get(record.agentId);
				if (pendingAttention?.goalRevision === record.goalRevision && pendingAttention.trigger === 'movement_loop') {
					pendingAttention = this.#settleProvisionalLoopAttention(record, pendingAttention, worldSignals, classified);
				}
				const merged = pendingAttention?.goalRevision === record.goalRevision
					? mergeAttentionTrigger(classified, pendingAttention)
					: classified;
				let attention = noTask ? merged : this.#withHealNudge(record, observation, merged);
				// The plan not moving for minutes, or one result repeating, is said once; a routine wake takes its name.
				const progressWake = noTask ? null : this.#taskViews.progressWake(record);
				if (progressWake !== null && (attention.attention !== true || attention.priority !== 'urgent' && ['attention', 'observation'].includes(attention.trigger))) attention = { attention: true, priority: 'ordinary', trigger: progressWake };
				// Entering a dangerous context (dusk on the surface, lava near, a fortress, low health with hostiles) owes the
				// model one wake listing its dangers and their armed rules. A respawn or arrival already wakes it.
				const entered = noTask || !this.#usesNativeTools(record) ? [] : this.#contextTracker(record.agentId).observe(observation, Date.now());
				if (entered.length > 0) {
					this.#writeTrace('context_entered', { agentId: record.agentId, goalRevision: record.goalRevision, contexts: entered });
					if (attention.attention !== true && entered.some((context) => context !== 'respawn')) attention = { attention: true, priority: 'ordinary', trigger: CONTEXT_ENTRY_TRIGGER };
				}
				if (pendingAttention?.goalRevision === record.goalRevision) this.#pendingAttention.delete(record.agentId);
				this.#trackHazardContact(record.agentId, observation);
				this.#trackSurvivalQuiet(record, observation);
				if (noTask) {
					this.#observeWithoutTask(record, observation, message.payload, attention, lifecycleGeneration, connectionEpoch);
					return;
				}
				const ledger = this.#ledger(record.agentId);
				ledger.ingest('observation', wireObservation);
				if (this.#usesNativeTools(record)) {
					const observationSignature = nativeObservationSignature(observation);
					const previousSignature = this.#nativeObservationSignatures.get(record.agentId);
					const supervisedRequest = this.#supervisedObservationRequests.get(record.agentId);
					const forcedContinuation = supervisedRequest?.goalRevision === record.goalRevision
						&& supervisedRequest.lifecycleGeneration === lifecycleGeneration
						&& supervisedRequest.connectionEpoch === connectionEpoch;
					if (forcedContinuation) this.#supervisedObservationRequests.delete(record.agentId);
					const unchangedHeartbeat = attention.attention === false && !forcedContinuation
						&& previousSignature?.goalRevision === record.goalRevision
						&& previousSignature.lifecycleGeneration === lifecycleGeneration
						&& previousSignature.connectionEpoch === connectionEpoch
						&& previousSignature.signature === observationSignature;
					this.#nativeObservationSignatures.set(record.agentId, {
						goalRevision: record.goalRevision,
						lifecycleGeneration,
						connectionEpoch,
						signature: observationSignature,
					});
					const memory = this.#conversationMemory(record.agentId);
					const conversation = memory.history();
					// An unchanged heartbeat may still owe the model a failure whose steer was rejected; it must try again,
					// within the attempt bound that also applies to changed snapshots.
					const failureSteerOwed = this.#nativeRuntime.failureSteerOwed(record, observation.lastResult);
					if (unchangedHeartbeat && !failureSteerOwed) {
						if (this.#nativeRuntime.refreshObservation(record, observation, { eventSequence: message.payload.eventSequence, conversation })) return;
					}
					const accepted = this.#nativeRuntime.updateObservation(record, observation, { eventSequence: message.payload.eventSequence, conversation, attention: attention.attention, priority: attention.priority, trigger: attention.trigger, resourceSightings: worldSignals?.resourceSightings, changedFacts: message.payload.changedFacts });
					// Accepted native snapshots are ingested by the runtime callback, which
					// also preserves requested samples and enriched sparse death facts.
					if (!accepted) this.#playerMemory.observe(record, observation);
					const pendingSummary = refreshMemorySummary();
					if (pendingSummary !== undefined && !await pendingSummary) return;
					this.#goalSupervisor.observed(supervisionKey);
					// Stored above for standing orders and watchers; a sample published only for the drop ahead is no turn. A
					// finished action's held wake still resumes here (its completion owns the next observation).
					if (attention.sampleOnly === true && attention.attention === false && !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision
						&& this.#actionDeferredWakes.get(record.agentId)?.actionEnded !== true) return;
					// The program owns ordinary progress. It explicitly notifies the model
					// when reconsideration or a new intention is needed.
					if (this.#nativeRuntime.hasProgram(record) && !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision) return;
					// The model can only wait for its own running action, and the action's result is followed by an
					// attention observation that wakes it with fresher facts. Danger, conversation and forced
					// continuations (a pending attention) still wake it now.
					const wakeRequest = {
						agentId: record.agentId,
						goalRevision: record.goalRevision,
						observation,
						memory: this.#memorySummaries.get(record.agentId)?.unresolved,
						executionSettings: this.#planner.getExecutionSettings?.(record.agentId) ?? null,
						eventSequence: message.payload.eventSequence,
						priority: attention.priority,
						trigger: attention.trigger,
						lifecycleGeneration,
						connectionEpoch,
						nativeEvent: { event: 'observation', trigger: forcedContinuation ? 'continuation' : attention.trigger, observation },
						// The failure protects this wake only while a steer about it is still owed and within its attempts.
						failureSteered: !failureSteerOwed,
					};
					// A step owns ordinary progress (wake-filter.mjs stepFolds): sightings, routine updates and the coordinator's
					// loop and stall notes are folded into the wake its end brings, with no deadline. A major discovery and a failure
					// still owed to the model wake as before.
					const step = forcedContinuation ? null : this.#nativeRuntime.runningStep(record);
					// The step's own until "seen:<block>" sighting is the step's news, not ordinary: it wakes the model at once.
					const untilSeen = step === null ? null : this.#nativeRuntime.stepSighting(record, observation);
					if (untilSeen !== null) {
						this.#writeTrace('native_wake_filtered', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: attention.trigger, verdict: 'wake', reason: `step ${step} until seen:${untilSeen}` });
						this.#resumeDeferredWake(record, attention);
						this.#scheduleNativeTurn(record, { ...wakeRequest, priority: 'urgent', trigger: STEP_UNTIL_TRIGGER, nativeEvent: { ...wakeRequest.nativeEvent, trigger: STEP_UNTIL_TRIGGER } });
						return;
					}
					if (stepFolds(step, attention, observation) && !failureSteerOwed && this.#wakeFilter.discovery(record.agentId, { attention, observation, goalText: record.currentGoal }) === null) {
						this.#wakeFilter.fold(record.agentId, attention.trigger, observation, this.#nativeRuntime.reflexEvents(record));
						this.#writeTrace('native_wake_filtered', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: attention.trigger, verdict: 'fold', reason: `step ${step} running` });
						this.#holdWakeForModelAction(record, wakeRequest, { step: true });
						return;
					}
					// obtain recovers at low health itself (fork-rule.mjs: eat carried food, or wait for regeneration): a low-health
					// wake is folded while it recovers. Only then: an obtain that is merely running may end or search on without
					// recovering, and the heal nudge's latch would keep that wake from coming back. A fork, a mob, lava or any other
					// trigger still wakes, and a recovery that forks ends obtain LOW_HEALTH, which brings the one wake.
					const recovery = !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision && LOW_HEALTH_RECOVERY_TRIGGERS.has(attention.trigger)
						? this.#nativeRuntime.recovering?.(record) ?? null : null;
					if (recovery === 'active') {
						this.#wakeFilter.fold(record.agentId, attention.trigger, observation, this.#nativeRuntime.reflexEvents(record));
						this.#writeTrace('native_wake_filtered', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: attention.trigger, verdict: 'hold', reason: `obtain recovers (${recovery})`, steer: true });
						return;
					}
					// A search (find, or obtain's search for a source) answers a hit or threat edge it can handle as a player keeps
					// searching: one mob it can beat is fought, one behind rock or not after the body is passed by (search-danger.mjs).
					// A steer for it would cut the search short for a model round trip (gate run 3: 8 of 24 mob hand-backs during find
					// and obtain). Its facts reach the next input as now.whileActing; a fork still steers and interrupts as before.
					const searchHeld = !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision && attention.priority === 'urgent'
						&& this.#nativeRuntime.searching?.(record) === true ? searchHoldsSteer(attention, observation) : null;
					if (searchHeld !== null) {
						this.#wakeFilter.fold(record.agentId, 'search_danger', observation, this.#nativeRuntime.reflexEvents(record));
						this.#writeTrace('native_wake_filtered', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: attention.trigger, verdict: 'hold', reason: `search handles: ${searchHeld}`, steer: true });
						return;
					}
					// A count skill (fight_until; fight_target or use_ranged with untilItem) handles its own mob's shots, hits and
					// fire itself, so a model mid-turn waiting on it is not steered for them either (d41-big rods: 114 of 124 count
					// fights were cancelled by the model after such steers, 13-20 s in; none reached its count). Another kind, low
					// health, lava or a discovery still steers; the held facts reach the next input as now.whileActing.
					const skillKinds = !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision && attention.attention === true
						&& this.#providerWork.has(record.agentId) && this.#nativeRuntime.hasModelAction(record)
						? countSkillKinds(this.#nativeRuntime.runningAction(record), observation) : null;
					if (skillKinds !== null) {
						const skillAttention = COUNT_SKILL_HELD.has(attention.trigger) ? { ...attention, priority: 'urgent' } : attention;
						const held = this.#wakeFilter.decide(record.agentId, { attention: skillAttention, observation, changedFacts: message.payload.changedFacts,
							reflexRules: this.#nativeRuntime.reflexRules(record), reflexEvents: this.#nativeRuntime.reflexEvents(record), goalText: record.currentGoal, ownKinds: skillKinds });
						if (held.verdict !== 'default') this.#writeTrace('native_wake_filtered', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: attention.trigger, verdict: held.verdict, reason: held.reason, steer: true });
						if (held.verdict === 'hold') return;
					}
					// System 1 runs, System 2 sleeps: while the model's own action runs, a hit absorbed at safe health by a known
					// kind, a known threat's next signal or a burn a fire rule handles is summed into the next wake; a new
					// kind of danger, low health or a discovery wakes at once (wake-filter.mjs).
					// A model mid-turn is awake already: its danger steers are folded by the DangerSteerCoalescer instead.
					const filtered = !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision && attention.attention === true
						&& this.#nativeRuntime.hasModelAction(record) && !this.#providerWork.has(record.agentId)
						? this.#wakeFilter.decide(record.agentId, { attention, observation, changedFacts: message.payload.changedFacts, reflexRules: this.#nativeRuntime.reflexRules(record),
							reflexEvents: this.#nativeRuntime.reflexEvents(record), goalText: record.currentGoal })
						: null;
					if (filtered !== null && filtered.verdict !== 'default') this.#writeTrace('native_wake_filtered', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: attention.trigger, verdict: filtered.verdict, reason: filtered.reason });
					if (filtered?.verdict === 'hold' && this.#holdWakeForModelAction(record, wakeRequest, { absorbed: true })) return;
					if (filtered?.verdict !== 'wake' && !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision && attention.priority !== 'urgent'
						&& attention.trigger !== DIMENSION_CHANGED_TRIGGER && attention.trigger !== CONTEXT_ENTRY_TRIGGER && this.#nativeRuntime.hasModelAction(record) && this.#holdWakeForModelAction(record, wakeRequest)) return;
					const resumedTrigger = this.#resumeDeferredWake(record, attention);
					if (!forcedContinuation) { wakeRequest.trigger = resumedTrigger; wakeRequest.nativeEvent.trigger = resumedTrigger; }
					if (failureSteerOwed) this.#nativeRuntime.noteFailureSteerAttempt(record, observation.lastResult);
					this.#scheduleNativeTurn(record, wakeRequest);
					return;
				}
				this.#playerMemory.observe(record, observation);
				const pendingSummary = refreshMemorySummary();
				if (pendingSummary !== undefined && !await pendingSummary) return;
				this.#goalSupervisor.observed(supervisionKey);
				const installed = await this.#programRuntime.onObservation(record, {
					observation,
					eventSequence: message.payload.eventSequence,
					attention: attention.attention,
					priority: attention.priority,
					trigger: attention.trigger,
					receiptMonotonicMs,
					receiptEpochMs,
					observedAtEpochMs: message.payload.observedAtEpochMs,
				});
				if (installed !== null) return;
				this.#scheduleInitialPlan(record, {
					agentId: record.agentId,
					goalRevision: record.goalRevision,
					observation,
					wireObservation,
					eventSequence: message.payload.eventSequence,
					receiptMonotonicMs,
					attention: attention.attention,
					priority: attention.priority,
					trigger: attention.trigger,
					preserveState: false,
					kind: 'initial',
					lifecycleGeneration,
					connectionEpoch,
					...buildPlannerRequest({
						agent: { agentId: record.agentId, provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort },
						goal: record.currentGoal,
						goalRevision: record.goalRevision,
						attentionPriority: attention.priority,
						attentionTrigger: attention.trigger,
						observation,
						memory: this.#memorySummaries.get(record.agentId)?.unresolved,
						executionSettings: this.#planner.getExecutionSettings?.(record.agentId) ?? null,
					}, this.#plannerContext(record.agentId)),
				});
			}, {
				connectionEpoch,
				coalesceKey: message.payload.attention === false
					&& message.payload.trigger === undefined
					&& !this.#pendingAttention.has(message.agentId)
					&& !this.#supervisedObservationRequests.has(message.agentId)
					? `quiet-observation:${connectionEpoch}:${lifecycleGeneration}:${message.payload.goalRevision}`
					: null,
			});
		});
		this.#listen('action_progress', (message, connectionEpoch) => {
			const lifecycleGeneration = this.#lifecycleGeneration(message.agentId);
			// Progress for the live dispatch is the experience review's evidence that the body started it.
			const admitted = this.#latestActionDispatches.get(message.agentId);
			if (admitted?.connectionEpoch === connectionEpoch && admitted.actionId === message.payload?.actionId && admitted.goalRevision === message.payload?.goalRevision) {
				this.#playerMemory.noteProgress(message.agentId, { actionId: admitted.actionId });
			}
			return this.#enqueueAgent(message.agentId, async () => {
				const record = this.#registry.assertCurrentRevision(message.agentId, message.payload.goalRevision);
				if (this.#usesNativeTools(record) && message.payload.actionObservation?.position !== undefined
					&& this.#isLifecycleGenerationCurrent(message.agentId, lifecycleGeneration)) {
					this.#sampleProgressMovement(record, lifecycleGeneration, connectionEpoch, message.payload.actionObservation);
				}
				const nativeWork = this.#providerWork.get(message.agentId);
				if (this.#usesNativeTools(record) && nativeWork?.goalRevision === record.goalRevision) {
					this.#goalSupervisor.progress(nativeWork.supervisionToken);
					for (const call of nativeWork.toolSupervision.values()) {
						if (call.token !== null) this.#goalSupervisor.progress(call.token);
					}
				}
				if (this.#usesNativeTools(record) && this.#nativeRuntime.onActionProgress(record, message.payload)) {
					this.emit('actionProgress', message);
					return;
				}
				if (this.#usesNativeTools(record) && this.#nativeRuntime.isActionResultStale(record, message.payload)) return;
				if (!this.#programRuntime.onActionProgress(record, message.payload)) throw new ProtocolV2Error('UNEXPECTED_ACTION_RESULT', `Agent '${message.agentId}' has no outstanding program action`);
				this.emit('actionProgress', message);
			}, { connectionEpoch });
		});
		this.#listen('action_result', (message, connectionEpoch) => {
			const lifecycleGeneration = this.#lifecycleGeneration(message.agentId);
			// The experience review hears a result that matches the live dispatch when it is admitted, before the queue and
			// its persistence, so a death admitted right after it (which clears the live dispatch) still sees it.
			// Anything unmatched waits for durable reconciliation.
			const admitted = this.#latestActionDispatches.get(message.agentId);
			if (admitted?.connectionEpoch === connectionEpoch && admitted.actionId === message.payload?.actionId && admitted.goalRevision === message.payload?.goalRevision
				&& (message.payload.actionType === undefined || message.payload.actionType === admitted.actionType)) {
				this.#playerMemory.noteLiveResult(message.agentId, { ...message.payload, actionType: admitted.actionType });
			}
			let receipt, admittedRespawn = false;
			return this.#enqueueAgent(message.agentId, async () => {
				const dispatch = this.#latestActionDispatches.get(message.agentId);
				if (dispatch?.connectionEpoch === connectionEpoch && dispatch.actionId === message.payload.actionId
					&& dispatch.goalRevision === message.payload.goalRevision && message.payload.actionType !== undefined
					&& dispatch.actionType !== message.payload.actionType) {
					// Invalid receipt evidence must neither enter live facts nor fail valid
					// gameplay through the agent-error/cancellation path. No disk read here.
					this.#emitRuntimeError(codedRuntimeError('UNCORRELATED_ACTION_RECEIPT', 'Terminal action type does not match its live dispatch; withholding ACK'));
					return;
				}
				// Live correlation must not wait for disk. The retained server result is
				// acknowledged separately, only after authoritative storage succeeds.
				receipt = this.#queueReceiptReconciliation(message, connectionEpoch);
				this.#decisionLog?.actionResult(message.agentId, message.payload);
				try {
					if (admittedRespawn) { this.emit('actionResult', message); return; }
					const current = this.#registry.get(message.agentId);
					if (current === null || message.payload.goalRevision !== current.goalRevision
						|| !this.#isLifecycleGenerationCurrent(message.agentId, lifecycleGeneration)) {
						return;
					}
					const record = this.#registry.assertCurrentRevision(message.agentId, message.payload.goalRevision);
					this.#ledger(record.agentId).ingest('action_result', message.payload);
					if (this.#usesNativeTools(record)) {
						this.#trackOwnBreak(record, lifecycleGeneration, connectionEpoch, (state) => {
							settleOwnBreak(state, message.payload.actionId, message.payload.state === 'SUCCEEDED', message.payload.observedAtEpochMs, message.payload.actionObservation);
							settleCombatResult(state, message.payload);
						});
					}
					if (this.#usesNativeTools(record) && this.#nativeRuntime.onActionResult(record, message.payload)) {
						this.#endHeldWakeForFinishedAction(record);
						this.emit('actionResult', message);
						return;
					}
					if (this.#usesNativeTools(record) && this.#nativeRuntime.isActionResultStale(record, message.payload)) {
						return;
					}
					if (!await this.#programRuntime.onActionResult(record, message.payload)) {
						if (this.#programRuntime.isActionResultStale(record, message.payload)) {
							return;
						}
						throw new ProtocolV2Error('UNEXPECTED_ACTION_RESULT', `Agent '${message.agentId}' has no outstanding program action`);
					}
					this.emit('actionResult', message);
				} finally {
					this.#reconcileReceipt(receipt);
				}
			}, { connectionEpoch, terminal: true, onAdmitted: () => {
				// The next wire event can be respawn lifecycle control, whose admission fences
				// this body immediately. Consume its exact successful receipt before that fence.
				const current = this.#registry.get(message.agentId);
				const active = current && this.#nativeRuntime.runningAction(current);
				if (current?.state === DynamicAgentState.DEAD && current.goalRevision === message.payload.goalRevision
					&& this.#usesNativeTools(current) && active?.actionType === 'respawn'
					&& active.actionId === message.payload.actionId && message.payload.actionType === 'respawn'
					&& message.payload.state === 'SUCCEEDED' && message.payload.reasonCode === 'VANILLA_RESPAWNED') {
					admittedRespawn = this.#nativeRuntime.onActionResult(current, message.payload);
				}
			} });
		});
		this.#listen('task_request_result', (message) => {
			// Settled directly: the agent queue may be busy applying the goal_control this result follows.
			const pending = this.#taskRequests.get(message.payload.requestId);
			if (pending === undefined || pending.agentId !== message.agentId) return;
			this.#taskRequests.delete(message.payload.requestId);
			clearTimeout(pending.timer);
			pending.resolve(message.payload);
		});
		this.#listen('goal_completion_result', (message, connectionEpoch) => {
			return this.#enqueueAgent(message.agentId, async () => {
				const current = this.#registry.get(message.agentId);
				if (current === null || current.goalRevision !== message.payload.goalRevision) return;
				if (this.#usesNativeTools(current) && this.#nativeRuntime.onCompletionResult(current, message.payload)) { if (message.payload.verified) this.#taskViews.verified(current); return; }
				const accepted = this.#programRuntime.onCompletionResult(current, message.payload);
				if (!accepted) throw new ProtocolV2Error('UNEXPECTED_COMPLETION_RESULT', `Agent '${message.agentId}' has no matching completion request`);
				if (message.payload.verified) this.#taskViews.verified(current);
			}, { connectionEpoch, transactional: true });
		});
		this.#listen('disconnected', (event) => {
			const connectionEpoch = this.#eventConnectionEpoch(event);
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			this.#inspections.cancel(undefined, 'BRIDGE_DISCONNECTED');
			void this.#playerMemory.markUnknown(undefined, 'BRIDGE_DISCONNECTED').catch((error) => this.#emitRuntimeError(error));
			this.#connected = false;
			this.#retireReceiptReconciliations();
			this.#verboseTransitions.clearAll();
			this.#cancelGoalSpecRequests();
			this.#settleTaskRequests(undefined, 'BRIDGE_DISCONNECTED', 'Lost the connection to Minecraft before it answered.');
			for (const record of this.#registry.list()) {
				const work = this.#providerWork.get(record.agentId);
				if (work?.kind === 'native') {
					this.#restoreNativeConversation(work.steerRequest);
					this.#restoreNativeConversation(work.request);
				}
				this.#nativeConversationRecoveries.delete(record.agentId);
				this.#dropDeferredWake(record.agentId);
				this.#goalSupervisor.suspend(this.#supervisionKey(record));
				this.#advanceLifecycleGeneration(record.agentId);
			}
			this.#run(async () => {
			if (this.#connectionEpoch !== connectionEpoch) return;
			this.#disconnectedAt ??= safeClockRead(this.#controlNow);
			this.#reconciledStatus = false;
			this.#supportedAgentIds.clear();
			this.#programRuntimeEpochs.clear();
			this.#nativeRuntimeEpochs.clear();
			this.#programRuntime.disposeAll();
			void this.#nativeRuntime.disposeAll('bridge_disconnected');
			this.#pendingAttention.clear();
			this.#dropAllDeferredWakes();
			this.#attentionFlushes.clear();
			this.#providerRetryAfter.clear();
			this.#providerProbeDeadlines.clear();
			this.#deferredProviderRecovery.clear();
			this.#providerWork.clear();
			await Promise.allSettled(this.#registry.list().map(async (record) => {
				if ([DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING].includes(record.state)) {
					this.#registry.setState(record.agentId, DynamicAgentState.DISCONNECTED, { goalRevision: record.goalRevision });
				}
				await this.#planner.interrupt(record.agentId, 'Minecraft bridge disconnected');
			}));
			}, connectionEpoch, { requireConnected: false });
		}, { lifecycle: true });
		this.#listen('shutdown', () => {
			this.#run(async () => {
				try { this.emit('shutdown'); }
				finally { await this.stop(); }
			});
		});
		// Both drop inbound input: protocolError also resets the connection, messageRejected keeps it.
		this.#listen('protocolError', (error) => {
			this.#writeTrace('bridge_protocol_error', rejectionTraceFields(error, 'PROTOCOL_ERROR'));
			this.emit('runtimeError', error);
		}, { lifecycle: true });
		this.#listen('messageRejected', (rejection) => {
			this.#writeTrace('bridge_message_rejected', { type: typeof rejection?.type === 'string' ? rejection.type.slice(0, 64) : null,
				agentId: typeof rejection?.agentId === 'string' ? rejection.agentId.slice(0, 128) : null,
				count: Number.isSafeInteger(rejection?.count) ? rejection.count : null, ...rejectionTraceFields(rejection?.error, 'INBOUND_MESSAGE_REJECTED') });
			this.emit('runtimeError', rejection.error);
		}, { lifecycle: true });
		this.#listen('transportError', (error) => this.emit('runtimeError', error), { lifecycle: true });
		this.#listen('heartbeatLate', (event) => this.#writeTrace('bridge_heartbeat_late', { lateMs: event?.lateMs ?? null }), { lifecycle: true });
		// A single-player pause stops the game, not the bot's work: its deadlines wait and the running step resumes after.
		this.#listen('serverPause', (event) => this.#serverPaused(event?.paused === true, event?.tickAgeMs ?? null), { lifecycle: true });
	}

	/**
	 * A single-player pause stops the game, not the bot's work. Every wall-clock timer that can end a live step holds
	 * here, in one place, and resumes with the time it had left:
	 * - work leases (provider 45 s, action 125 s+, program, completion) and the 30 s no-progress check (goal supervisor);
	 * - the planner's per-phase lease (a foreground tool's 130 s) and its overall turn budget (planning scheduler);
	 * - each running program's deadline, its world sampling and its server-lag clock (native runtime, program executor);
	 * - the time budgets of obtain, gather and find steps (native runtime's step clock);
	 * - the 10 s timeout of a fresh-sample request already sent (inspection client).
	 * The body's own limits run on game time in the mod, which stands still while paused.
	 */
	#serverPaused(paused, tickAgeMs) {
		this.#goalSupervisor.serverPaused?.(paused);
		this.#scheduler.serverPaused?.(paused);
		this.#nativeRuntime?.serverPaused?.(paused);
		this.#inspections.serverPaused(paused);
		this.#writeTrace(paused ? 'bridge_server_paused' : 'bridge_server_resumed', { tickAgeMs });
	}

	#beginReconciliation(registry, connectionEpoch, { providerOnly = false } = {}) {
		let startedReconciliation;
		try {
			startedReconciliation = this.#planner.beginReconcile(registry, providerOnly ? { recovery: true, providerOnly: true } : { recovery: true });
		} catch (error) {
			startedReconciliation = { complete: Promise.reject(error) };
		}
		const reconciliation = Promise.resolve().then(async () => {
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
			if (typeof this.#codexService.bootstrapCatalog === 'function') {
				const catalog = await this.#codexService.bootstrapCatalog(registry);
				if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
				await this.#publishCatalog(catalog, connectionEpoch);
			}
			const result = await startedReconciliation.complete;
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
			const providers = result.providers ?? result.codex;
			await this.#publishCatalog(providers.catalog, connectionEpoch);
			const deadStatePlans = [];
			for (const profile of providers.valid) {
				if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
				const record = this.#registry.get(profile.agentId);
				if (record === null) throw new ProtocolV2Error('UNKNOWN_AGENT', `Reconciled provider profile references unknown agent '${profile.agentId}'`);
				const lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
				if (this.#supportedAgentIds.has(profile.agentId)) continue;
				if (record.state === DynamicAgentState.STARTING && record.currentGoal !== null) {
					this.#goalSupervisor.activate(this.#supervisionKey(record));
				}
				await this.#sendForEpoch(connectionEpoch, 'agent_ready', profile.agentId, { goalRevision: record.goalRevision, reconciled: true });
				this.#supportedAgentIds.add(profile.agentId);
				this.#usageLedger.registerAgent(record);
				this.#publishVerbose(record.agentId, record.goalRevision, 'lifecycle', 'Agent reconciled and ready.', connectionEpoch);
				this.#prewarmNativeAgent(record);
				this.#checkProviderCli(record, connectionEpoch);
				if (this.#usesNativeTools(record) && [DynamicAgentState.IDLE, DynamicAgentState.PAUSED, DynamicAgentState.COMPLETED].includes(record.state)) {
					await this.#resumeUnreadNativeConversation(record, connectionEpoch, lifecycleGeneration);
				}
				if (record.state === DynamicAgentState.DEAD) {
					const recovery = this.#installDeadStatePlan(record, record.death, connectionEpoch);
					// Native recovery is already supervised. Its body may need receipts
					// admitted only after reconciliation, so readiness cannot join the turn.
					if (this.#usesNativeTools(record)) void recovery.catch((error) => this.#reportAgentError(record.agentId, error, connectionEpoch));
					else deadStatePlans.push(recovery);
				}
			}
			for (const invalid of providers.invalid) {
				if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
				const agentId = invalid.agentId ?? invalid.profile?.agentId;
				await this.#sendForEpoch(connectionEpoch, 'agent_error', agentId, {
					goalRevision: this.#registry.get(agentId)?.goalRevision ?? 0,
					code: sanitizeDiagnosticCode(invalid.code, { fallback: 'INVALID_PROFILE' }),
					message: sanitizeDiagnosticText(invalid.message ?? 'Provider profile is unavailable.', { maxBytes: 2_048 }),
				});
			}
			await Promise.all(deadStatePlans);
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
			this.#reconciledStatus = !this.#hasUnsupportedAgents();
			if (this.#disconnectedAt !== null) this.#disconnectedAt = null;
			await this.#publishStatus(connectionEpoch);
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
			// The catalogs above only cover providers with saved agents. The bridge treats any
			// non-empty snapshot as loaded, so publish every provider or the summon menu stays
			// limited to those providers. Off the readiness path so slow CLIs cannot delay agents.
			void this.#publishFullCatalog(connectionEpoch);
			this.emit('reconciled', result);
			return result;
		});
		this.#reconciliation = reconciliation.catch((error) => {
			if (this.#isConnectionEpochCurrent(connectionEpoch)) this.#emitRuntimeError(error);
			return null;
		});
	}

	#bindProviderRecovery() {
		if (typeof this.#codexService.on !== 'function' || typeof this.#codexService.off !== 'function') return;
		const listener = () => this.#requestProviderRecovery(this.#connectionEpoch, { force: true });
		this.#codexService.on('providerRestored', listener);
		this.#providerListeners.push(['providerRestored', listener]);
	}

	#requestProviderRecovery(connectionEpoch, { force = false } = {}) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch) || this.#providerRecoveryPending) return;
		if (!this.#hasUnsupportedAgents()) return;
		if (!force && !this.#providerProbeDue()) return;
		this.#providerRecoveryPending = true;
		void Promise.resolve(this.#reconciliation).finally(() => {
			this.#providerRecoveryPending = false;
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			if (!this.#hasUnsupportedAgents()) return;
			this.#beginReconciliation(this.#registry.list(), connectionEpoch, { providerOnly: true });
		});
	}

	#hasUnsupportedAgents() {
		return this.#registry.list().some(({ agentId }) => !this.#supportedAgentIds.has(agentId));
	}

	#providerProbeDue() {
		if (typeof this.#codexService.recoverySnapshot !== 'function') return true;
		let recovery;
		try { recovery = this.#codexService.recoverySnapshot(); }
		catch { return true; }
		if (!Array.isArray(recovery)) return true;
		const missingProviders = new Set(this.#registry.list()
			.filter(({ agentId }) => !this.#supportedAgentIds.has(agentId))
			.map(({ provider }) => provider ?? 'codex'));
		const now = safeClockRead(this.#epochNow);
		for (const provider of missingProviders) {
			const record = recovery.find((entry) => entry?.provider === provider);
			if (record?.state !== 'degraded' || record.nextProbeAtEpochMs === null || now === null || now >= record.nextProbeAtEpochMs) return true;
		}
		return false;
	}

	#listen(event, listener, { lifecycle = false } = {}) {
		const registered = lifecycle ? listener : (message) => {
			const connectionEpoch = this.#eventConnectionEpoch(message);
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			const result = listener(message, connectionEpoch);
			if (typeof message?.waitUntil === 'function' && result !== undefined) message.waitUntil(result);
			return result;
		};
		this.#bridge.on(event, registered);
		this.#listeners.push([event, registered]);
	}

	#acceptReadyEpoch(connection) {
		const supplied = connection?.connectionEpoch;
		let connectionEpoch;
		if (supplied === undefined) {
			connectionEpoch = this.#connected && connection?.serverInstanceId === this.#serverInstanceId
				? this.#connectionEpoch
				: this.#connectionEpoch + 1;
		} else if (!Number.isSafeInteger(supplied) || supplied < 1) {
			this.#emitRuntimeError(new ProtocolV2Error('INVALID_CONNECTION_EPOCH', 'Bridge ready event requires a positive connection epoch'));
			return null;
		} else {
			connectionEpoch = supplied;
		}
		if (connectionEpoch <= this.#connectionEpoch) return null;
		this.#retireReceiptReconciliations();
		this.#inspections.cancel(undefined, 'STALE_CONNECTION_EPOCH');
		this.#memorySummaries.clear();
		if (this.#connectionEpoch > 0) {
			for (const record of this.#registry.list()) {
				void this.#nativeRuntime.dispose(record.agentId, 'connection_replaced').catch((error) => this.#emitRuntimeError(error));
			}
		}
		this.#connectionEpoch = connectionEpoch;
		this.#connected = true;
		return connectionEpoch;
	}

	#eventConnectionEpoch(event) {
		const supplied = event?.connectionEpoch;
		return Number.isSafeInteger(supplied) && supplied >= 1 ? supplied : this.#connectionEpoch;
	}

	#isConnectionEpochCurrent(connectionEpoch) {
		return this.#connected && Number.isSafeInteger(connectionEpoch) && connectionEpoch === this.#connectionEpoch;
	}

	async #installDeadStatePlan(record, death, connectionEpoch = this.#connectionEpoch) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
		if (death === null || death === undefined) throw new ProtocolV2Error('MISSING_FIELD', `DEAD agent '${record.agentId}' requires death facts`);
		if (record.currentGoal === null) return;
		if (this.#programRuntime.hasCurrent(record)) return;
		this.#playerMemory.observe(record, { death: structuredClone(death) });
		const lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
		if (this.#usesNativeTools(record)) {
			this.#dropDeferredWake(record.agentId);
			this.#nativeRuntimeEpochs.set(record.agentId, connectionEpoch);
			const observation = { death: structuredClone(death) };
			const live = this.#nativeRuntime.snapshotLive(record.agentId);
			const eventSequence = Number.isSafeInteger(live?.eventSequence) ? live.eventSequence : 0;
			this.#nativeRuntime.updateObservation(record, observation, {
				eventSequence,
				conversation: this.#conversationMemory(record.agentId).history(),
				force: true,
			});
			return this.#scheduleNativeTurn(record, {
				agentId: record.agentId,
				goalRevision: record.goalRevision,
				observation,
				eventSequence,
				priority: 'urgent',
				trigger: 'player_death',
				preserveState: true,
				lifecycleGeneration,
				connectionEpoch,
				nativeEvent: { event: 'player_death', trigger: 'player_death', observation },
			});
		}
		return this.#scheduleProviderPlan(record, {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			observation: { death },
			eventSequence: 0,
			attention: true,
			priority: 'urgent',
			trigger: 'player_death',
			preserveState: true,
			kind: 'death',
			lifecycleGeneration,
			connectionEpoch,
			input: buildPlannerInput({
				agent: { agentId: record.agentId, provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort },
				goal: record.currentGoal,
				goalRevision: record.goalRevision,
				decisionContext: 'player_death',
				attentionPriority: 'urgent',
				attentionTrigger: 'player_death',
				death,
			}),
		}, { preserveState: true, kind: 'death' });
	}

	#rememberNativeWorldSignals(record, lifecycleGeneration, connectionEpoch, observation) {
		const state = this.#nativeWorldState(record, lifecycleGeneration, connectionEpoch);
		const sampledAt = finiteOrNull(observation?.observedAtEpochMs);
		const evidence = movementEvidence(observation?.velocity, observation?.player?.onGround);
		// Ground motion at walking speed on the hurt sample is evidence of a walk. A known impulse's later ground drift is not.
		if (knockbackHurt(observation?.player, state.player) && evidence !== 'walking') {
			// The hit landed after the previous observation; progress positions since then may already show the shove.
			withdrawShovedSteps(state.positions, state.observedAt, sampledAt);
			state.knockbackFrom = sampledAt === null ? null : sampledAt - KNOCKBACK_LEAD_MS;
			state.knockbackUntil = sampledAt === null ? null : sampledAt + KNOCKBACK_SETTLE_MS;
			state.knockbackLanding = true;
			state.knockbackNow = true;
		}
		sampleMovement(state, nativeBlockPositionKey(observation?.player), sampledAt, evidence);
		// Only an observation at or after the closing step can validate progress-derived history.
		if (state.movementLoopDue === true && (sampledAt === null || state.positions.at(-1)?.at == null || sampledAt >= state.positions.at(-1).at)) {
			state.movementLoopValidatedVersion = state.movementLoopVersion;
		}
		state.knockbackNow = false;
		// Due until delivered: danger in the same sample carries the loop fact in its own wake.
		const movementLoop = state.movementLoopDue === true && state.movementLoopValidatedVersion === state.movementLoopVersion
			&& state.movementLoopDelivery?.version !== state.movementLoopVersion;
		if (sampledAt !== null) state.observedAt = sampledAt;
		const lavaFlowDue = lavaFlowWakeDue(state, observation?.player, sampledAt ?? Date.now());
		// Stacks the agent's own dig or trip Q-drops (its discard list) are not new resources: the recorded Oct 29 game woke Sol
		// 13 times in a minute for its own cobblestone. Held for 30 s after the action, for drops still settling.
		const running = this.#nativeRuntime.runningAction?.(record);
		const discard = Array.isArray(running?.arguments?.discard) ? running.arguments.discard : [];
		if (discard.length > 0) state.ownDiscard = { ids: new Set(discard.map((id) => String(id).includes(':') ? String(id) : `minecraft:${id}`)), until: (sampledAt ?? Date.now()) + 30_000 };
		const ownDiscard = state.ownDiscard !== undefined && (sampledAt ?? Date.now()) <= state.ownDiscard.until ? state.ownDiscard.ids : null;
		const resourceDiscovery = rememberResources(state, observation, record, ownDiscard);
		const previousPlayer = state.player;
		state.player = observation.player;
		// Only a live body's inventory is compared: a death empties it, and a stack moved into an open container leaves the hand.
		const liveInventory = observation?.ready !== false && observation?.death == null && observation?.player?.dead !== true && Array.isArray(observation?.inventory?.items);
		const toolBreak = liveInventory && observation.interaction?.menu == null ? heldToolBreak(state.inventory, observation.inventory) : null;
		state.inventory = liveInventory ? observation.inventory : null;
		const dimension = observation?.world?.dimension ?? null;
		const dimensionChanged = dimension !== null && state.dimension != null && dimension !== state.dimension;
		if (dimension !== null) state.dimension = dimension;
		const dragonPerch = dragonPerchEdge(state, observation, sampledAt);
		const endCrystals = rememberEndCrystals(state, observation);
		this.#nativeWorldSignals.set(record.agentId, state);
		return {
			previousPlayer,
			lavaFlowDue,
			dragonPerch,
			endCrystals,
			movementLoop,
			resourceDiscovery,
			resourceSightings: state.resourceSightings,
			dimensionChanged,
			toolBreak,
		};
	}

	#nativeWorldState(record, lifecycleGeneration, connectionEpoch) {
		const previous = this.#nativeWorldSignals.get(record.agentId);
		const sameLifecycle = previous?.goalRevision === record.goalRevision
			&& previous.lifecycleGeneration === lifecycleGeneration
			&& previous.connectionEpoch === connectionEpoch;
		return sameLifecycle
			? previous
			: { goalRevision: record.goalRevision, lifecycleGeneration, connectionEpoch, positions: [], resources: new Set(), brokenBlocks: [] };
	}

	/** Tracks the dispatch and confirmed visible faces of this agent's own successful break. */
	#trackOwnBreak(record, lifecycleGeneration, connectionEpoch, update) {
		const state = this.#nativeWorldState(record, lifecycleGeneration, connectionEpoch);
		update(state);
		this.#nativeWorldSignals.set(record.agentId, state);
	}

	/**
	 * Full observations now arrive only when a fact changed, so a walk back and forth is also sampled from the position
	 * every action progress message carries. A loop seen there asks the server for an observation, which merges the
	 * pending attention, so the model hears of it as fast as when every position change produced an observation.
	 */
	#sampleProgressMovement(record, lifecycleGeneration, connectionEpoch, actionObservation) {
		const state = this.#nativeWorldState(record, lifecycleGeneration, connectionEpoch);
		const movementLoop = sampleMovement(state, nativeBlockPositionKey(actionObservation.position), finiteOrNull(actionObservation.observedAtEpochMs),
			movementEvidence(actionObservation.velocity, actionObservation.onGround));
		this.#nativeWorldSignals.set(record.agentId, state);
		if (!movementLoop) return;
		// Provisional: the observation it asks for may explain the closing steps as a shove and withdraw them.
		const superseded = this.#pendingAttention.get(record.agentId);
		this.#rememberPendingAttention(record.agentId, record.goalRevision, { priority: 'urgent', trigger: 'movement_loop' });
		if (superseded?.goalRevision === record.goalRevision && superseded.trigger !== 'movement_loop') this.#pendingAttention.get(record.agentId).superseded = superseded;
		void Promise.resolve(this.#bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision })).catch(() => {});
	}

	/**
	 * A loop queued from action progress is settled by the observation it asked for: withdrawn when the corrected
	 * movement history no longer loops, kept queued (not merged) when danger in this observation outranks it, and
	 * otherwise merged as before. Returns the attention to merge, if any.
	 */
	#settleProvisionalLoopAttention(record, pending, signals, classified) {
		if (signals?.movementLoop !== true) {
			if (pending.superseded === undefined) this.#pendingAttention.delete(record.agentId);
			else this.#pendingAttention.set(record.agentId, pending.superseded);
			this.#writeTrace('native_movement_loop_withdrawn', { agentId: record.agentId, goalRevision: record.goalRevision });
			return this.#pendingAttention.get(record.agentId);
		}
		if (classified.priority === 'urgent' && classified.trigger !== 'movement_loop') return undefined;
		return pending;
	}

	#usesNativeTools(record) {
		// Claude agents always use the native tool loop; Codex follows its configured control protocol.
		if (record?.provider === 'codex') return this.#codexControlProtocol === 'native_tools';
		return NATIVE_TOOL_PROVIDERS.includes(record?.provider);
	}

	#prewarmNativeAgent(record) {
		if (!this.#usesNativeTools(record) || record.state !== DynamicAgentState.IDLE || typeof this.#codexService.prewarmAgent !== 'function') return;
		void Promise.resolve(this.#codexService.prewarmAgent(record, { goalRevision: record.goalRevision })).catch((error) => {
			this.#writeTrace('native_prewarm_failed', {
				agentId: record.agentId,
				goalRevision: record.goalRevision,
				errorCode: String(error?.code ?? 'PREWARM_FAILED').slice(0, 128),
			});
		});
	}

	/**
	 * Tells players at launch time when the provider CLI is missing, broken or signed out.
	 * The probe never blocks registration; agent_notice is used because agent_error is
	 * dropped by the server for agents without an active goal.
	 */
	#checkProviderCli(record, connectionEpoch) {
		if (this.#providerCliHealth === null) return;
		// CLI health depends on neither the goal revision nor the lifecycle generation (goal_control
		// bumps both): a goal started while a broken CLI is probed (tens of seconds) must not
		// silence the notice. Only a new connection or agent removal makes it stale.
		const current = () => this.#isConnectionEpochCurrent(connectionEpoch) && this.#registry.get(record.agentId) !== null;
		const spec = PROVIDER_CLI[record.provider];
		void Promise.resolve().then(() => this.#providerCliHealth.check(record.provider)).then((health) => {
			if (!current()) return;
			const goalRevision = this.#registry.get(record.agentId)?.goalRevision ?? record.goalRevision;
			if (health.status === 'ok') {
				this.#publishVerbose(record.agentId, goalRevision, 'provider', `${spec?.display ?? record.provider}${health.version ? ` ${health.version}` : ''} ready.`, connectionEpoch);
				return;
			}
			if (health.code === null || typeof health.message !== 'string' || health.message.length === 0) return;
			if (!this.#acceptProviderCliNotice(connectionEpoch, record.agentId)) return;
			this.#writeTrace('provider_cli_unhealthy', {
				agentId: record.agentId,
				goalRevision,
				provider: record.provider,
				status: health.status,
				code: health.code,
				version: health.version,
				details: sanitizeDiagnosticText(health.details ?? '', { maxBytes: 512 }),
			});
			this.#publishVerbose(record.agentId, goalRevision, 'provider', `${spec?.display ?? record.provider} check failed (${health.code}).`, connectionEpoch);
			void this.#sendForEpoch(connectionEpoch, 'agent_notice', record.agentId, { severity: 'error', code: health.code, message: health.message })
				.catch((error) => {
					// A failed send must not consume the one notice this agent gets per connection.
					this.#forgetProviderCliNotice(connectionEpoch, record.agentId);
					this.#writeTrace('provider_cli_notice_failed', { agentId: record.agentId, code: sanitizeDiagnosticErrorCode(error, { fallback: 'NOTICE_FAILED' }) });
				});
		}).catch((error) => {
			this.#writeTrace('provider_cli_probe_failed', { agentId: record.agentId, provider: record.provider, code: sanitizeDiagnosticErrorCode(error, { fallback: 'PROBE_FAILED' }) });
		});
	}

	/** One notice per agent per connection epoch, so reconnects and re-registrations do not repeat it. */
	#acceptProviderCliNotice(connectionEpoch, agentId) {
		if (this.#providerCliNotices.connectionEpoch !== connectionEpoch) {
			this.#providerCliNotices = { connectionEpoch, agents: new Set() };
		}
		if (this.#providerCliNotices.agents.has(agentId)) return false;
		this.#providerCliNotices.agents.add(agentId);
		return true;
	}

	#forgetProviderCliNotice(connectionEpoch, agentId) {
		if (this.#providerCliNotices.connectionEpoch === connectionEpoch) this.#providerCliNotices.agents.delete(agentId);
	}

	/**
	 * One console line per provider, once per coordinator process. Runs after the first bridge
	 * handshake rather than in start(): a first-time Codex desktop-CLI cache copy is synchronous
	 * and must not eat into the server's 5 s handshake window.
	 */
	#logProviderCliHealthAtStartup() {
		if (this.#providerCliStartupLogged || this.#providerCliHealth === null || this.#providerCliHealth.enabled !== true) return;
		this.#providerCliStartupLogged = true;
		this.#providerDiscovery.start();
		for (const provider of PROVIDER_IDS) {
			void Promise.resolve().then(() => this.#providerCliHealth.check(provider)).then((health) => {
				const display = PROVIDER_CLI[provider]?.display ?? provider;
				const line = health.status === 'ok'
					? `${display}${health.version ? ` ${health.version}` : ''} ready${health.executable ? ` (${health.executable})` : ''}`
					: `${health.status}: ${health.message ?? health.details ?? 'no details'}`;
				try { console.error(`[provider-cli] ${provider}: ${line}`); } catch { /* console output is best effort */ }
			}).catch(() => {});
		}
	}

	/**
	 * A parked agent (idle, finished, paused or in error) still has a body. Its facts stay current for observe/inspect, and urgent
	 * danger (damage, a threat, fire, lava, drowning, a fall) wakes the model at once in a no-task turn with every body
	 * tool. Ordinary sightings never wake it, so a finished task is not restarted or redone.
	 */
	#observeWithoutTask(record, observation, payload, attention, lifecycleGeneration, connectionEpoch) {
		const conversation = this.#conversationMemory(record.agentId).history();
		const accepted = this.#nativeRuntime.updateObservation(record, observation, { eventSequence: payload.eventSequence, conversation,
			attention: attention.attention, priority: attention.priority, trigger: attention.trigger, changedFacts: payload.changedFacts });
		if (!accepted) this.#playerMemory.observe(record, observation);
		// An operator's /mineagen takeover owns the body: Minecraft reports it, and the model is not woken to act on it.
		if (observation?.player?.operatorControlled === true) return;
		if (attention.priority !== 'urgent' || !NO_TASK_WAKE_TRIGGERS.has(attention.trigger)) {
			this.#considerHealWake(record, observation, lifecycleGeneration, connectionEpoch);
			return;
		}
		this.#nativeRuntimeEpochs.set(record.agentId, connectionEpoch);
		this.#scheduleNativeTurn(record, {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			observation,
			eventSequence: payload.eventSequence,
			priority: 'urgent',
			trigger: attention.trigger,
			lifecycleGeneration,
			connectionEpoch,
			preserveState: true,
			conversationOnly: true,
			dangerWake: true,
			nativeEvent: { event: 'observation', trigger: attention.trigger, observation, conversationOnly: true, dangerWake: true },
		});
	}

	/**
	 * Low health with no task: once per health level, give the model a no-task turn to recover (eat, or get food:
	 * hunt passive animals, pick up drops, harvest ripe crops or berries). Danger turns come first; this runs when the
	 * observation was not danger, or after a no-task turn ends. The model decides; it may simply wait.
	 */
	#considerHealWake(record, observation, lifecycleGeneration, connectionEpoch) {
		if (!this.#usesNativeTools(record) || ![DynamicAgentState.IDLE, DynamicAgentState.COMPLETED].includes(record.state)) return false;
		if (observation === null || observation === undefined || this.#providerWork.has(record.agentId)) return false;
		const latch = this.#healWakes.get(record.agentId);
		const verdict = healWakeVerdict(observation, latch?.goalRevision === record.goalRevision ? latch : null);
		if (verdict.latch === null) this.#healWakes.delete(record.agentId);
		else this.#healWakes.set(record.agentId, { goalRevision: record.goalRevision, ...verdict.latch });
		if (!verdict.wake) return false;
		this.#nativeRuntimeEpochs.set(record.agentId, connectionEpoch);
		this.#writeTrace('native_heal_wake', { agentId: record.agentId, goalRevision: record.goalRevision, health: observation.player.health, foodLevel: observation.player.foodLevel ?? null });
		this.#scheduleNativeTurn(record, {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			observation,
			priority: 'ordinary',
			trigger: 'low_health_idle',
			lifecycleGeneration,
			connectionEpoch,
			preserveState: true,
			conversationOnly: true,
			selfCareWake: true,
			nativeEvent: { event: 'observation', trigger: 'low_health_idle', observation, conversationOnly: true, selfCareWake: true, healing: healingFacts(observation) },
		});
		return true;
	}

	/**
	 * An agent with a task at low health with food in reach: one urgent attention edge (debounced, see healNudgeVerdict)
	 * so the model hears it at once instead of in the 30 s ordinary window. It carries healing facts and options; the
	 * routine keeps running unless the model chooses otherwise. Danger observations pass through untouched.
	 */
	#withHealNudge(record, observation, attention) {
		if (!this.#usesNativeTools(record) || attention.priority === 'urgent') return attention;
		// Another named trigger (a structure, a resource, a program edge) keeps its own wake; the nudge waits for the next sample.
		if (attention.attention === true && !['observation', 'attention'].includes(attention.trigger)) return attention;
		const latch = this.#healNudges.get(record.agentId);
		const verdict = healNudgeVerdict(observation, latch?.goalRevision === record.goalRevision ? latch : null, safeClockRead(this.#epochNow));
		if (verdict.latch === null) this.#healNudges.delete(record.agentId);
		else this.#healNudges.set(record.agentId, { goalRevision: record.goalRevision, ...verdict.latch });
		if (!verdict.nudge) return attention;
		this.#writeTrace('native_heal_nudge', { agentId: record.agentId, goalRevision: record.goalRevision, health: observation.player.health,
			foodLevel: observation.player.foodLevel ?? null, options: verdict.options });
		return { attention: true, priority: 'urgent', trigger: 'low_health_food' };
	}

	#scheduleNativeConversation(record, event, trigger) {
		const conversationOnly = [DynamicAgentState.IDLE, DynamicAgentState.COMPLETED, DynamicAgentState.PAUSED].includes(record.state);
		if (!conversationOnly && ![DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING].includes(record.state)) return;
		const lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
		const connectionEpoch = this.#connectionEpoch;
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
		this.#nativeRuntimeEpochs.set(record.agentId, connectionEpoch);
		this.#scheduleNativeTurn(record, {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			priority: 'urgent',
			trigger,
			lifecycleGeneration,
			connectionEpoch,
			preserveState: conversationOnly,
			conversationOnly,
			nativeEvent: {
				event: event?.kind ?? 'conversation',
				trigger,
				observation: {},
				conversationOnly,
			},
		});
	}

	async #resumeUnreadNativeConversation(record, connectionEpoch, lifecycleGeneration) {
		if (!this.#usesNativeTools(record)) return;
		const isCurrent = () => this.#isConnectionEpochCurrent(connectionEpoch)
			&& this.#isLifecycleGenerationCurrent(record.agentId, lifecycleGeneration)
			&& this.#registry.get(record.agentId)?.goalRevision === record.goalRevision;
		const hasCurrentWork = () => {
			const work = this.#providerWork.get(record.agentId);
			return work?.kind === 'native' && work.goalRevision === record.goalRevision
				&& work.connectionEpoch === connectionEpoch && work.lifecycleGeneration === lifecycleGeneration;
		};
		if (!isCurrent() || hasCurrentWork()) return;
		const inbox = this.#pendingConversationInbox(record.agentId);
		await inbox.open(this.#serverInstanceId);
		if (!isCurrent() || hasCurrentWork()) return;
		if (!await inbox.hasUnreadWake()) return;
		if (!isCurrent() || hasCurrentWork()) return;
		// Derive authority from the new lifecycle, never replay the old goal request.
		this.#scheduleNativeConversation(record, null, 'conversation');
	}

	#awaitingNativeConfirmation(record, lifecycleGeneration = this.#lifecycleGeneration(record.agentId)) {
		return sameSupervisionKey(this.#nativeConfirmationWaits.get(record.agentId), this.#supervisionKey(record, lifecycleGeneration));
	}

	#confirmationBlocksRequest(record, request) {
		// A supervision continuation can share a wake with real danger; waiting must not swallow that danger.
		if (request.priority === 'urgent' && NO_TASK_WAKE_TRIGGERS.has(request.trigger)) return false;
		return this.#awaitingNativeConfirmation(record, request.lifecycleGeneration)
			&& !this.#confirmationActivity.has(record.agentId)
			&& (request.priority !== 'urgent' || request.trigger === 'stuck' || request.nativeEvent?.trigger === 'continuation');
	}

	#scheduleNativeTurn(record, request) {
		if (!this.#isConnectionEpochCurrent(request.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(record.agentId, request.lifecycleGeneration)) return;
		if (!this.#nativePreparationIsCurrent(record, request) || this.#confirmationBlocksRequest(record, request)) return;
		if (this.#awaitingNativeConfirmation(record, request.lifecycleGeneration)) request = { ...request, preserveState: true };
		request = this.#afterProviderProbeDeadline(record, request);
		if (request === null) return;
		const existing = this.#providerWork.get(record.agentId);
		if (existing !== undefined) {
			if (
				existing.kind === 'native'
				&& existing.goalRevision === request.goalRevision
				&& existing.lifecycleGeneration === request.lifecycleGeneration
				&& existing.connectionEpoch === request.connectionEpoch
				&& (request.priority === 'urgent' || request.nativeEvent?.event === 'program_planning_due'
						|| protectedNativeWake(request))
			) {
				this.#traceEventReady(record, request, existing.traceId, 'steer');
				if (request.nativeEvent?.event === 'program_planning_due') this.#queueNativePreparation(existing, request);
				else this.#queueNativeSteer(existing, request);
				return existing.promise;
			}
			this.#traceEventReady(record, request, existing.traceId, 'pending');
			existing.pending = mergePlannerRequest(existing.pending, request);
			// How long a queued wake waits for the running turn (and its closing call) to end is reported when it does.
			if (existing.kind === 'native') existing.pendingSince ??= safeClockRead(this.#controlNow);
			return existing.promise;
		}
		const supervisionKey = this.#supervisionKey(record, request.lifecycleGeneration);
		this.#forgetNativeConversationRecovery(supervisionKey);
		this.#goalSupervisor.activate(supervisionKey);
		const work = {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			lifecycleGeneration: request.lifecycleGeneration,
			connectionEpoch: request.connectionEpoch,
			kind: 'native',
			request,
			pending: null,
			pendingSince: null,
			steerQueued: null,
			steerRequest: null,
			steerPromise: null,
			// Repeated damage/threat steers into this turn fold into one summary (see danger-steer-coalescer.mjs).
			dangerSteer: new DangerSteerCoalescer(),
			dangerSteerTimer: null,
			preparationPromise: null,
			traceId: planningTraceId(record.agentId, record.goalRevision, request.lifecycleGeneration, 'native'),
			promise: null,
			supervisionKey,
			supervisionToken: this.#goalSupervisor.begin(supervisionKey, 'provider', { timeoutMs: Math.min(MAX_LEASE_TIMEOUT_MS, this.#planner.getExecutionSettings?.(record.agentId)?.limits?.nativeTurnBudgetMs ?? MAX_LEASE_TIMEOUT_MS) }),
			toolSupervision: new Map(),
			// When the model's current call began (the turn start, then each moment no tool is left running), and the newest
			// hazard contact whose facts reached the provider in this turn's input, a steer or a tool result.
			modelCallStartedAt: safeClockRead(this.#controlNow),
			// The current call has begun streaming a tool call (Claude), so it is about to reach a tool boundary.
			callStreamingTool: false,
			hazardContactDelivered: 0,
			survivalAware: false,
			// When this turn was last told of survival danger; awareness ends with the episode (see #trackSurvivalQuiet).
			survivalAwareAt: null,
			seenSurvivalFacts: new Set(),
			survivalReissued: false,
			survivalRecheckTimer: null,
			// An IN_LAVA/ON_FIRE tool result reached the provider in this turn.
			hazardResultDelivered: false,
			// Danger's tool-boundary flush carried a contact steer, so the call is not planning blind.
			hazardSteerAtToolBoundary: false,
			successfulChat: false,
			expired: false,
		};
		this.#providerWork.set(record.agentId, work);
		this.#traceEventReady(record, request, work.traceId, 'turn');
		work.dangerSteer.noteDelivered(request, safeClockRead(this.#controlNow));
		try {
			if (request.preserveState !== true) {
				if (record.state === DynamicAgentState.STARTING) this.#registry.setState(record.agentId, DynamicAgentState.PLANNING, { goalRevision: record.goalRevision });
				void this.#sendForEpoch(request.connectionEpoch, 'planning_state', record.agentId, { goalRevision: record.goalRevision, state: DynamicAgentState.PLANNING })
					.catch((error) => this.#reportAgentError(record.agentId, error, request.connectionEpoch));
			}
		} catch (error) {
			this.#providerWork.delete(record.agentId);
			this.#goalSupervisor.end(work.supervisionToken);
			throw error;
		}
		const verboseReporter = this.#verboseReporter(record.agentId, record.goalRevision, { allowPublicAgentMessage: true, publicActivity: request.conversationOnly !== true, connectionEpoch: request.connectionEpoch });
		const eventReadyAt = performance.now();
		work.promise = Promise.resolve()
			.then(async () => this.#planner.requestNativeTurn({
				agentId: record.agentId,
				goalRevision: record.goalRevision,
				input: await this.#nativeTurnInput(record, request).then((input) => {
					this.#noteHazardDelivered(work);
					this.#playerMemory.confirmShown(record.agentId, input);
					this.#noteSurvivalDelivered(work, request, request.survivalFacts);
					work.modelCallStartedAt = safeClockRead(this.#controlNow);
					work.callStreamingTool = false;
					if (typeof input === 'string') {
						work.inputBytes = Buffer.byteLength(input, 'utf8');
						this.#writeTrace('native_input_built', { agentId: record.agentId, goalRevision: record.goalRevision, traceId: work.traceId, inputBytes: work.inputBytes, buildMs: Math.round((performance.now() - eventReadyAt) * 10) / 10 });
					}
					return input;
				}),
				recoverySummary: record.lastSummary,
				priority: request.priority,
				preserveState: request.preserveState === true,
				traceId: work.traceId,
				onVerbose: verboseReporter,
				onProgress: (metadata) => {
					if (metadata?.phase === 'tool_streaming') work.callStreamingTool = true;
					if (metadata?.phase === 'tool_queued' && work.dangerSteer?.hasFolded()) {
						this.#cancelDangerSteerTimer(work);
						const folded = work.dangerSteer.flush(safeClockRead(this.#controlNow));
						if (folded !== null) this.#deliverNativeSteer(work, folded, { toolBoundary: true });
					}
					if (this.#providerWork.get(record.agentId) === work && this.#isConnectionEpochCurrent(request.connectionEpoch)) this.#goalSupervisor.progress(work.supervisionToken);
				},
				executeTool: (toolRequest) => this.#executeNativeTool(work, toolRequest),
				normalizeTool: (tool) => this.#nativeRuntime?.effectiveTool?.(tool, record) ?? tool,
			}))
			.then(async (result) => {
				try { return await this.#completeNativeTurn(work, result); }
				catch (error) { return this.#failNativeTurn(work, error); }
			}, (error) => this.#failNativeTurn(work, error));
		return work.promise;
	}

	/** Marks the moment an observation or attention event reaches the coordinator's turn scheduling; the first stage of a latency chain. */
	#traceEventReady(record, request, traceId, mode) {
		this.#writeTrace('native_event_ready', { agentId: record.agentId, goalRevision: record.goalRevision, traceId, mode,
			trigger: request.trigger ?? null, eventName: request.nativeEvent?.event ?? null, priority: request.priority ?? null,
			...(Number.isFinite(request.receiptMonotonicMs) ? { receiptMonotonicMs: request.receiptMonotonicMs } : {}) });
	}

	/**
	 * True when this ordinary wake is held back for the running action. The first held wake arms a deadline, so a
	 * one-time sighting is released with the freshest held facts even if no other observation ever arrives.
	 */
	#holdWakeForModelAction(record, request, { absorbed = false, step = false } = {}) {
		// An absorbed wake (wake-filter.mjs) was protected danger the body is coping with: it is held as a routine one.
		if (!absorbed && !step && protectedNativeWake(request)) return false;
		// A step folds its loop and stall notes as routine updates; a sighting keeps its name for the wake the step's end brings.
		const routine = absorbed || step && !STEP_NAMED_TRIGGERS.has(request.trigger);
		const held = routine ? { ...request, priority: 'ordinary', trigger: 'attention', nativeEvent: { ...request.nativeEvent, trigger: 'attention' } } : request;
		const previous = this.#actionDeferredWakes.get(record.agentId);
		const continuing = previous?.goalRevision === record.goalRevision && !previous.actionEnded;
		const entry = continuing ? previous : { goalRevision: record.goalRevision, trigger: null, count: 0, request: null, timer: null, actionEnded: false };
		entry.count += 1;
		entry.request = held;
		// A sighting or discovery is signalled once, so the first named reason survives the plain heartbeats after it.
		if (entry.trigger === null && !GENERIC_WAKE_TRIGGERS.has(held.trigger)) entry.trigger = held.trigger;
		this.#actionDeferredWakes.set(record.agentId, entry);
		if (entry.count === 1) this.#writeTrace('native_wake_deferred_for_action', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: request.trigger, ...(absorbed ? { absorbed: true } : {}) });
		// Only a named reason (a sighting, a discovery) is released by the deadline; routine updates and absorbed hits wait
		// for the action's end, a real wake or the model's next turn, and are summed into it. A step's folds have no deadline.
		if (step) entry.step = true;
		if (entry.timer === null && entry.trigger !== null && entry.step !== true) {
			entry.timer = this.#setWakeHoldTimeout(() => { if (entry.timer !== null) { entry.timer = null; this.#releaseHeldWake(record.agentId, entry, 'hold_limit'); } }, ORDINARY_WAKE_HOLD_MS);
		}
		return true;
	}

	/** The trigger to wake with: a generic wake adopts the named reason it replaced. */
	#namedWakeTrigger(entry, trigger, priority) {
		return priority !== 'urgent' && entry.trigger !== null && GENERIC_WAKE_TRIGGERS.has(trigger) ? entry.trigger : trigger;
	}

	/** The trigger to wake with now that the model is being woken. */
	#resumeDeferredWake(record, attention) {
		const entry = this.#actionDeferredWakes.get(record.agentId);
		if (entry === undefined) return attention.trigger;
		this.#dropDeferredWake(record.agentId);
		if (entry.goalRevision !== record.goalRevision) return attention.trigger;
		this.#writeTrace('native_wake_resumed_after_action', { agentId: record.agentId, goalRevision: record.goalRevision, skippedWakes: entry.count, deferredTrigger: entry.trigger, reason: 'wake' });
		return this.#namedWakeTrigger(entry, attention.trigger, attention.priority);
	}

	/** Wakes the model with the freshest held request: the hold limit passed, or the held action was cancelled or replaced. */
	#releaseHeldWake(agentId, entry, reason) {
		if (this.#actionDeferredWakes.get(agentId) !== entry) return false;
		this.#dropDeferredWake(agentId);
		const request = entry.request;
		this.#writeTrace('native_wake_resumed_after_action', { agentId, goalRevision: entry.goalRevision, skippedWakes: entry.count, deferredTrigger: entry.trigger, reason });
		if (request === null || this.#stopping || this.#closed) return false;
		const trigger = this.#namedWakeTrigger(entry, request.trigger, request.priority);
		return this.#reschedulePendingNativeTurn({ ...request, trigger, nativeEvent: { ...request.nativeEvent, trigger } }, { released: true });
	}

	/** The model cancelled or replaced the action that held these wakes; the facts they carried still reach the model. */
	#releaseHeldWakeForCancelledAction(record) {
		const entry = this.#actionDeferredWakes.get(record.agentId);
		if (entry !== undefined && !entry.actionEnded) this.#releaseHeldWake(record.agentId, entry, 'action_cancelled');
	}

	/** The action ended: no deadline is needed, and the completion observation that follows names what was held. */
	#endHeldWakeForFinishedAction(record) {
		const entry = this.#actionDeferredWakes.get(record.agentId);
		if (entry === undefined || entry.actionEnded || this.#nativeRuntime.hasModelAction(record)) return;
		this.#clearHeldWakeTimer(entry);
		entry.actionEnded = true;
	}

	#clearHeldWakeTimer(entry) {
		if (entry.timer === null) return;
		this.#clearWakeHoldTimeout(entry.timer);
		entry.timer = null;
	}

	#dropDeferredWake(agentId) {
		const entry = this.#actionDeferredWakes.get(agentId);
		if (entry === undefined) return;
		this.#clearHeldWakeTimer(entry);
		this.#actionDeferredWakes.delete(agentId);
	}

	#dropAllDeferredWakes() {
		for (const agentId of [...this.#actionDeferredWakes.keys()]) this.#dropDeferredWake(agentId);
	}

	#nativePreparationIsCurrent(record, request) {
		const event = request?.nativeEvent;
		return event?.event !== 'program_planning_due'
			|| this.#nativeRuntime.canPrepareProgram(record, event.programId, event.status?.programVersion);
	}

	#preparationHasRunningProgram(work, record) {
		return (work.request?.nativeEvent?.event === 'program_planning_due' || work.preparingProgram != null)
			&& this.#nativeRuntime.hasProgram(record);
	}

	#queueNativeSteer(work, request) {
		// Danger reaching a no-task conversation turn lets it defend the body (self-preservation tools only).
		if (request.dangerWake === true) work.dangerWoken = true;
		// A lava contact often arrives as a repeat damage hit; folding it would hold the reissue for up to the fold interval.
		if (this.#reissueMidCallTurnForHazard(work, request, false) || this.#reissueUnawareSurvivalTurn(work, request, false)) return;
		const decision = work.dangerSteer.offer(request, safeClockRead(this.#controlNow));
		if (decision.action === 'fold') {
			this.#writeTrace('native_turn_steer_coalesced', { agentId: work.agentId, goalRevision: work.goalRevision,
				traceId: work.traceId, trigger: request.trigger, foldedEvents: decision.folded });
			if (work.dangerSteerTimer === null) {
				work.dangerSteerTimer = this.#setSteerTimeout(() => {
					work.dangerSteerTimer = null;
					if (this.#providerWork.get(work.agentId) !== work || work.expired === true) return;
					const folded = work.dangerSteer.flush(safeClockRead(this.#controlNow));
					if (folded !== null) this.#deliverNativeSteer(work, folded);
				}, decision.dueInMs);
				work.dangerSteerTimer?.unref?.();
			}
			return;
		}
		this.#cancelDangerSteerTimer(work);
		this.#deliverNativeSteer(work, decision.request);
	}

	#cancelDangerSteerTimer(work) {
		if (work.dangerSteerTimer === null || work.dangerSteerTimer === undefined) return;
		this.#clearSteerTimeout(work.dangerSteerTimer);
		work.dangerSteerTimer = null;
	}

	/** Pending work plus any danger summary still folded when the turn ends, so no hit is lost. */
	#pendingWithFoldedSteer(work) {
		this.#cancelDangerSteerTimer(work);
		const folded = work.dangerSteer?.flush(safeClockRead(this.#controlNow)) ?? null;
		if (folded === null) return work.pending;
		return work.pending?.eventSequence > folded.eventSequence
			? mergePlannerRequest(folded, work.pending) : mergePlannerRequest(work.pending, folded);
	}

	#trackHazardContact(agentId, observation) {
		const touching = inHazardContact(observation?.player);
		if (!touching && imminentLavaFlow(observation?.player) === null) this.#hazardContacts.delete(agentId);
		// A seen flow due soon opens an episode before contact; the contact itself is a new one, so a turn that only
		// knew the flow is reissued again once the lava is on the body.
		else if (!this.#hazardContacts.has(agentId) || touching && this.#hazardContacts.get(agentId).touching === false) {
			this.#hazardContacts.set(agentId, { sequence: ++this.#hazardContactSequence, startedAt: safeClockRead(this.#controlNow), reissued: false, touching });
		}
	}

	/**
	 * A Claude turn can run for minutes, so knowing about one drowning or lava episode must not make it count as aware
	 * of the next. Once no observation has shown danger for SURVIVAL_EPISODE_QUIET_MS after everything the turn was
	 * told, the next danger wake is new to it and may reissue its call again. Short gaps (stepping in and out of a pool,
	 * a breath at the surface while escaping) stay one episode. Threat entities the model has seen stay known.
	 */
	#trackSurvivalQuiet(record, observation) {
		const player = observation?.player;
		if (player == null) return;
		const now = safeClockRead(this.#controlNow);
		if (!Number.isFinite(now)) return;
		if (survivalDangerShown(player)) { this.#survivalQuietSince.delete(record.agentId); return; }
		if (!this.#survivalQuietSince.has(record.agentId)) this.#survivalQuietSince.set(record.agentId, now);
		const quietSince = this.#survivalQuietSince.get(record.agentId);
		const work = this.#providerWork.get(record.agentId);
		if (!TOOL_BOUNDARY_STEER_PROVIDERS.includes(record.provider) || work === undefined || work.survivalReissued || !Number.isFinite(work.survivalAwareAt)
				|| work.survivalAwareAt > quietSince || now - quietSince < SURVIVAL_EPISODE_QUIET_MS) return;
		work.survivalAware = false;
		work.survivalAwareAt = null;
		work.hazardResultDelivered = false;
		work.hazardSteerAtToolBoundary = false;
		work.hazardContactDelivered = 0;
		work.seenSurvivalFacts.delete('air');
		work.seenSurvivalFacts.delete('fall');
		this.#writeTrace('native_turn_survival_episode_closed', { agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId,
			quietMs: Math.round(now - quietSince) });
	}

	#noteSurvivalAware(work) {
		work.survivalAwareAt = safeClockRead(this.#controlNow);
	}

	#noteHazardDelivered(work) {
		const contact = this.#hazardContacts.get(work.agentId);
		// A flow warning delivered before contact leaves the contact itself to reissue a call that is still planning.
		if (contact !== undefined && contact.touching !== false) {
			work.hazardContactDelivered = Math.max(work.hazardContactDelivered ?? 0, contact.sequence);
			this.#noteSurvivalAware(work);
		}
	}

	#noteSurvivalDelivered(work, request, facts) {
		if (dangerWakeRank(request) === 2 || dangerWakeRank(facts) === 2) { work.survivalAware = true; this.#noteSurvivalAware(work); }
		const keys = survivalFactKeys(facts);
		for (const key of keys) work.seenSurvivalFacts.add(key);
		if (keys.has('air') || keys.has('fall')) this.#noteSurvivalAware(work);
	}

	/**
	 * Lava or fire-block contact while the model is mid-call: a steer would wait for that call's next tool boundary
	 * (3-7 s at low effort), or for a whole new turn if the call ends text-only. When nothing in this turn has carried
	 * any contact to the provider yet (its input, a steer or an IN_LAVA/ON_FIRE result), the call is planning without
	 * knowing: cancel it and reissue the turn with this event. A turn that already knows (the reissued one, or one
	 * stepping in and out of a pool while it escapes) gets the event as a steer. Never while a tool runs (the tool's
	 * result carries the steer, and danger already cuts blocking tools short).
	 */
	#reissueMidCallTurnForHazard(work, request, toolBoundary) {
		const contact = this.#hazardContacts.get(work.agentId);
		if (contact === undefined || contact.reissued || !isHazardContactRequest(request)) return false;
		// The model just asked for a tool, so this steer rides on that tool's result; it also counts as the turn's contact
		// (a flow warning there only closes its own episode).
		if (toolBoundary && contact.touching === false) contact.reissued = true;
		else if (toolBoundary) { work.hazardSteerAtToolBoundary = true; this.#noteSurvivalAware(work); }
		if (work.toolSupervision.size > 0 || work.callStreamingTool || work.hazardSteerAtToolBoundary === true || work.hazardResultDelivered === true || (work.hazardContactDelivered ?? 0) > 0) return false;
		contact.reissued = true;
		this.#cancelDangerSteerTimer(work);
		const folded = work.dangerSteer?.flush(safeClockRead(this.#controlNow)) ?? null;
		if (folded !== null) work.pending = mergePlannerRequest(work.pending, folded);
		work.pending = mergePlannerRequest(work.pending, request);
		const now = safeClockRead(this.#controlNow);
		this.#writeTrace('native_turn_hazard_reissue', { agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId,
			trigger: request.trigger ?? null, contact: contact.sequence, deliveredContact: work.hazardContactDelivered ?? 0,
			...(Number.isFinite(now) && Number.isFinite(work.modelCallStartedAt) ? { callAgeMs: Math.max(0, Math.round(now - work.modelCallStartedAt)) } : {}),
			...(Number.isFinite(now) && Number.isFinite(contact.startedAt) ? { contactAgeMs: Math.max(0, Math.round(now - contact.startedAt)) } : {}) });
		void Promise.resolve(this.#planner.interrupt(work.agentId, 'Hazard contact during a model call')).catch(() => {});
		return true;
	}

	/** Claude queues steers until a tool result. Replace an unaware reasoning call with the first survival edge. */
	#reissueUnawareSurvivalTurn(work, request, toolBoundary) {
		if (!TOOL_BOUNDARY_STEER_PROVIDERS.includes(this.#registry.get(work.agentId)?.provider) || request.priority !== 'urgent' || dangerWakeRank(request) !== 2) return false;
		// Newer facts arriving while interruption drains belong to the replacement, never the obsolete turn.
		if (work.survivalReissued) {
			work.pending = mergePlannerRequest(work.pending, request);
			return true;
		}
		if (toolBoundary) { work.survivalAware = true; this.#noteSurvivalAware(work); }
		if (work.survivalAware || work.hazardResultDelivered || work.hazardContactDelivered > 0 || work.toolSupervision.size > 0 || work.callStreamingTool) return false;
		const observation = request.nativeEvent?.observation ?? request.observation;
		const player = observation?.player;
		const trigger = dangerWakeTrigger(request);
		// Match the warning itself, rather than unrelated known entities or air facts in the same snapshot.
		const warning = ['suffocation', 'drowning'].includes(trigger) ? { air: player?.air }
			: trigger === 'fall' ? { fallDistance: player?.fallDistance }
				: trigger === 'damage' ? { lastAttacker: player?.lastAttacker, incomingProjectiles: player?.incomingProjectiles }
					: { threats: player?.threats, incomingProjectiles: player?.incomingProjectiles };
		let facts = survivalFactKeys(warning);
		// Damage with no attacker or projectile comes from the body's surroundings (drowning, a fall): judge it by those.
		if (trigger === 'damage' && facts.size === 0) facts = survivalFactKeys({ air: player?.air, fallDistance: player?.fallDistance });
		if ([...facts].some(key => work.seenSurvivalFacts.has(key))) return false;
		const now = safeClockRead(this.#controlNow);
		const previousRestart = this.#survivalRestartAt.get(work.agentId);
		if (!Number.isFinite(now) || !Number.isFinite(work.modelCallStartedAt)
			|| previousRestart !== undefined && now - previousRestart < 20_000) return false;
		if (now - work.modelCallStartedAt < SURVIVAL_RESTART_MIN_CALL_AGE_MS) {
			this.#recheckYoungSurvivalCall(work, request, SURVIVAL_RESTART_MIN_CALL_AGE_MS - (now - work.modelCallStartedAt));
			return false;
		}
		this.#survivalRestartAt.set(work.agentId, now);
		work.survivalReissued = true;
		this.#cancelDangerSteerTimer(work);
		const folded = work.dangerSteer?.flush(safeClockRead(this.#controlNow)) ?? null;
		for (const pending of [work.steerRequest, work.steerQueued, folded, request]) {
			if (pending != null) work.pending = mergePlannerRequest(work.pending, pending);
		}
		work.steerQueued = null;
		this.#writeTrace('native_turn_survival_reissue', { agentId: work.agentId, goalRevision: work.goalRevision,
			traceId: work.traceId, trigger: request.trigger, eventSequence: request.eventSequence, phase: 'requested', callAgeMs: now - work.modelCallStartedAt });
		void Promise.resolve().then(() => this.#planner.interrupt(work.agentId, 'First survival warning during an unaware model call'))
			.then((metrics) => this.#writeTrace('native_turn_survival_reissue', {
				agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId, phase: 'interrupted',
				...metrics,
			})).catch((error) => {
				work.survivalReissued = false;
				this.#writeTrace('native_turn_survival_reissue', { agentId: work.agentId, goalRevision: work.goalRevision,
					traceId: work.traceId, phase: 'interrupt_failed', errorCode: error?.code ?? 'INTERRUPT_FAILED' });
				if (this.#providerWork.get(work.agentId) === work && !work.expired) this.#deliverNativeSteer(work, request);
			});
		return true;
	}

	/**
	 * A call too young to restart still plans blind and its steer waits for its tool boundary (6 s in W-FLOOD). Look
	 * again once it reaches the minimum age: if that same call is still generating without the danger, reissue it then.
	 */
	#recheckYoungSurvivalCall(work, request, delayMs) {
		if (work.survivalRecheckTimer != null) return;
		const callStartedAt = work.modelCallStartedAt;
		work.survivalRecheckTimer = this.#setSteerTimeout(() => {
			work.survivalRecheckTimer = null;
			if (this.#providerWork.get(work.agentId) !== work || work.expired === true || work.modelCallStartedAt !== callStartedAt) return;
			this.#reissueUnawareSurvivalTurn(work, request, false);
		}, Math.max(0, Math.ceil(delayMs)));
		work.survivalRecheckTimer?.unref?.();
	}

	#deliverNativeSteer(work, request, { toolBoundary = false } = {}) {
		if (this.#reissueMidCallTurnForHazard(work, request, toolBoundary) || this.#reissueUnawareSurvivalTurn(work, request, toolBoundary)) return;
		work.steerQueued = mergePlannerRequest(work.steerQueued, request);
		const interruption = this.#steerInterruptionFor(work, request);
		if (work.steerPromise !== null) {
			if (interruption) this.#interruptForSteer(work);
			return;
		}
		const steering = this.#drainNativeSteering(work);
		const tracked = steering.finally(() => {
			if (work.steerPromise === tracked) work.steerPromise = null;
			// A drain that ended with its turn gone may leave an arm no steer will clear; a newer turn's arm is its own.
			const owner = this.#providerWork.get(work.agentId);
			if (owner === undefined || owner === work && work.expired === true) this.#nativeRuntime.disarmBlockingInterrupt?.(work.agentId);
		});
		work.steerPromise = tracked;
	}

	#queueNativePreparation(work, request) {
		// Planning is a one-shot advisory. It must never delay or replace an
		// urgent steering request, and its eventual failure must not become a
		// replayable pending turn.
		if (work.preparationPromise !== null
				|| work.request?.priority === 'urgent'
				|| work.steerQueued?.priority === 'urgent'
				|| work.pending?.priority === 'urgent'
				|| work.steerPromise !== null) return;
		const preparation = this.#deliverNativePreparation(work, request);
		const tracked = preparation.finally(() => {
			if (work.preparationPromise === tracked) work.preparationPromise = null;
		});
		work.preparationPromise = tracked;
	}

	async #deliverNativePreparation(work, request) {
		try {
			const record = this.#registry.get(work.agentId);
			if (record === null || record.goalRevision !== work.goalRevision
					|| work.expired === true
					|| this.#providerWork.get(work.agentId) !== work
					|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
					|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)
					|| !this.#nativePreparationIsCurrent(record, request)
					|| work.steerQueued?.priority === 'urgent'
					|| work.pending?.priority === 'urgent'
					|| work.steerPromise !== null) return;
			work.preparingProgram = { programId: request.nativeEvent.programId, programVersion: request.nativeEvent.status?.programVersion };
			const preparedInput = await this.#nativeTurnInput(record, request, { deliverConversation: false });
			await this.#planner.steerNativeTurn({
				agentId: work.agentId,
				goalRevision: work.goalRevision,
				input: preparedInput,
			});
			this.#noteSurvivalDelivered(work, request, request.survivalFacts);
			this.#playerMemory.confirmShown(record.agentId, preparedInput);
			this.#writeTrace('native_turn_prepared', {
				agentId: work.agentId,
				goalRevision: work.goalRevision,
				traceId: work.traceId,
				trigger: request.trigger,
			});
		} catch (error) {
			// Advisory delivery has no turn ownership. Do not restore conversation
			// state or queue a stale reminder after the body turn has moved on.
			this.#writeTrace('native_turn_preparation_skipped', {
				agentId: work.agentId,
				goalRevision: work.goalRevision,
				traceId: work.traceId,
				errorCode: String(error?.code ?? 'PREPARATION_FAILED').slice(0, 128),
			});
		}
	}

	async #drainNativeSteering(work) {
		const isCurrent = () => work.expired !== true
			&& this.#providerWork.get(work.agentId) === work
			&& this.#registry.get(work.agentId)?.goalRevision === work.goalRevision
			&& this.#isConnectionEpochCurrent(work.connectionEpoch)
			&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration);
		while (work.steerQueued !== null) {
			// Death and reconnect can replace a lifecycle without changing the goal
			// revision. Never deliver its queued events into the replacement turn.
			if (!isCurrent()) { work.steerQueued = null; return; }
			const request = work.steerQueued;
			work.steerQueued = null;
			work.steerRequest = request;
			const steerStartedAt = performance.now();
			const interruption = this.#steerInterruptionFor(work, request);
			let deliveryRequest = request;
			try {
				const record = this.#registry.get(work.agentId);
				if (record === null || record.goalRevision !== work.goalRevision) throw Object.assign(new Error('Native steering belongs to an obsolete goal'), { code: 'STALE_PLAN' });
				if (!this.#nativePreparationIsCurrent(record, request)) continue;
				const buildInput = async () => {
					while (true) {
						if (work.steerQueued !== null) {
							deliveryRequest = mergePlannerRequest(deliveryRequest, work.steerQueued);
							work.steerQueued = null;
							work.steerRequest = deliveryRequest;
						}
						if (buildInput.discarded) throw Object.assign(new Error('Native steer input was superseded before delivery'), { code: 'STEER_SUPERSEDED' });
						const input = await this.#nativeTurnInput(record, deliveryRequest, { freshObservation: true });
						this.#noteHazardDelivered(work);
						if (buildInput.discarded) {
							this.#restoreNativeConversation(deliveryRequest);
							throw Object.assign(new Error('Native steer input was superseded before delivery'), { code: 'STEER_SUPERSEDED' });
						}
						if (work.steerQueued === null) {
							this.#noteSurvivalDelivered(work, deliveryRequest, deliveryRequest.survivalFacts);
							this.#playerMemory.confirmShown(record.agentId, input);
							return input;
						}
						this.#restoreNativeConversation(deliveryRequest);
					}
				};
				buildInput.discarded = false;
				await this.#planner.steerNativeTurn({
					agentId: work.agentId,
					goalRevision: work.goalRevision,
					input: buildInput,
					onInterrupt: interruption ? () => this.#interruptForSteer(work) : null,
					onDiscard: () => {
						buildInput.discarded = true;
						this.#restoreNativeConversation(deliveryRequest);
					},
				});
				this.#nativeRuntime.disarmBlockingInterrupt?.(work.agentId);
				if (!isCurrent()) { this.#restoreNativeConversation(deliveryRequest); work.steerQueued = null; return; }
				await this.#commitNativeConversation(deliveryRequest);
				work.steeredPlayerRequests = [...(work.steeredPlayerRequests ?? []), ...(deliveryRequest.deliveredPlayerRequests ?? [])];
				if (!isCurrent()) { work.steerQueued = null; return; }
				// Continue only to reach unread waking messages. A public-only suffix
				// stays pending for the next legitimate wake, even during steering.
				if (deliveryRequest.nativeConversationDelivery?.omittedEntries > 0 && work.steerQueued === null
					&& await deliveryRequest.nativeConversationDelivery.inbox.hasUnreadWake() && isCurrent()) {
					work.steerQueued = { ...deliveryRequest };
				}
				this.#writeTrace('native_turn_steered', {
					agentId: work.agentId,
					goalRevision: work.goalRevision,
					traceId: work.traceId,
					trigger: deliveryRequest.trigger,
					steerMs: Math.round((performance.now() - steerStartedAt) * 10) / 10,
				});
			} catch (error) {
				this.#nativeRuntime.disarmBlockingInterrupt?.(work.agentId);
				// A late rejection has no authority to rewind current conversation
				// delivery or add recovery work after its lifecycle has ended.
				if (!isCurrent()) { work.steerQueued = null; return; }
				this.#restoreNativeConversation(deliveryRequest);
				if (error?.code === 'CONVERSATION_STORAGE_FAILED') await this.#reportAgentError(work.agentId, error, work.connectionEpoch);
				if (!isCurrent()) { work.steerQueued = null; return; }
				work.pending = mergePlannerRequest(work.pending, deliveryRequest);
				if (work.steerQueued !== null) work.pending = mergePlannerRequest(work.pending, work.steerQueued);
				work.steerQueued = null;
				this.#writeTrace('native_turn_steer_deferred', {
					agentId: work.agentId,
					goalRevision: work.goalRevision,
					traceId: work.traceId,
					errorCode: String(error?.code ?? 'TURN_STEER_FAILED').slice(0, 128),
				});
				return;
			} finally {
				work.steerRequest = null;
			}
		}
	}

	/**
	 * Danger steer: cut a running blocking body tool short so its result carries the steer. Claude sees a steer only at
	 * a tool boundary, so while its call is still generating, the blocking tool it issues next was chosen without the
	 * danger: that tool starts already interrupted (its action keeps running, the model decides what follows).
	 */
	/** nativeSteerInterruption, except that hits from the mob a running fight is fighting do not cut that fight short. */
	#steerInterruptionFor(work, request) {
		const record = this.#registry.get(work.agentId);
		const authored = record === null ? null : this.#nativeRuntime.runningAction?.(record) ?? null;
		const running = authored === null ? null : { ...authored, startHealth: this.#runningActions.get(work.agentId)?.health ?? null };
		const decision = fightSteerDecision(request, running, work.fightSteerState ?? null);
		work.fightSteerCut = decision.cut;
		if (decision.absorbed) this.#writeTrace('native_steer_absorbed_by_fight', { agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId, actionType: running.actionType });
		return decision.interruption;
	}

	#interruptForSteer(work) {
		// The band reference moves only when a fight is really cut short.
		if (work.fightSteerCut != null) work.fightSteerState = work.fightSteerCut;
		const armNext = TOOL_BOUNDARY_STEER_PROVIDERS.includes(this.#registry.get(work.agentId)?.provider);
		return this.#nativeRuntime.interruptBlockingTool(work.agentId, armNext ? { armNext } : undefined);
	}

	async #settleNativeSteering(work) {
		while (work.steerPromise !== null) await work.steerPromise;
	}

	/**
	 * Every model tool call. A call that ends without reaching Minecraft (refused, stale, gated) is traced as
	 * native_tool_rejected with its kind and reason code only, so an idle body is explainable from the trace.
	 */
	async #executeNativeTool(work, toolRequest) {
		const traceRejection = (reasonCode) => this.#writeTrace('native_tool_rejected', {
			agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId,
			callId: typeof toolRequest?.callId === 'string' ? toolRequest.callId.slice(0, 128) : null,
			toolKind: toolRequest?.tool?.kind ?? 'unknown',
			...(typeof toolRequest?.tool?.actionType === 'string' ? { actionType: toolRequest.tool.actionType } : {}),
			reasonCode: String(reasonCode ?? 'UNKNOWN').slice(0, 128),
		});
		let result;
		try {
			result = await this.#executeNativeToolCall(work, toolRequest);
		} catch (error) {
			traceRejection(error?.code ?? 'TOOL_EXECUTION_FAILED');
			throw error;
		}
		if (result?.executed === false) traceRejection(result.reasonCode);
		return result;
	}

	async #executeNativeToolCall(work, toolRequest) {
		const record = this.#registry.get(work.agentId);
		if (work.expired === true || (work.survivalReissued === true && !isSurvivalReissueTool(toolRequest.tool)) || record === null || record.goalRevision !== work.goalRevision
				|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
			const finished = record !== null && [DynamicAgentState.COMPLETED, DynamicAgentState.IDLE].includes(record.state)
				&& record.goalRevision > work.goalRevision;
			return { state: 'CANCELLED', reasonCode: 'STALE_PLAN', executed: false,
				goalRevision: work.goalRevision, currentGoalRevision: record?.goalRevision ?? null,
				message: work.taskAdopted !== undefined
					? 'Your task was accepted. Nothing was dispatched from this turn: end it now and the task turn starts with every tool.'
					: finished
						? 'Your task is complete, so this turn has ended and nothing was dispatched. End it now: damage and threats wake you again at once; then you may fight, flee, eat, equip or move away.'
						: 'This goal turn has ended or been superseded. No action was dispatched. End this turn and await the next goal event.' };
		}
		// A model tool invocation proves this turn input was consumed, even if the provider fails later.
		this.#settleFailureDelivery(work.request, true);
		if (toolRequest.tool.kind === 'take_task') return this.#takeTask(work, toolRequest.tool);
		let deliveredConfirmationAuthority = false;
		if (sameSupervisionKey(this.#nativeConfirmationWaits.get(work.agentId), work.supervisionKey)) {
			const messages = [...(work.request.deliveredPlayerRequests ?? []), ...(work.steeredPlayerRequests ?? [])];
			deliveredConfirmationAuthority = messages.slice(work.confirmationMessageBoundary ?? 0).some(entry => entry.operator === true);
			if (!deliveredConfirmationAuthority && !sameSupervisionKey(this.#confirmationWorkAuthority.get(work.agentId), work.supervisionKey)
					&& !isConfirmationContextTool(toolRequest.tool)) {
				return { state: 'REJECTED', reasonCode: 'OPERATOR_REQUEST_REQUIRED', executed: false,
					message: 'Finished work awaits the operator. Other messages allow facts and replies, not new work, plans, intent, programs or memory directives.' };
			}
		}

		if (work.request.conversationOnly === true
				&& toolRequest.tool.kind !== 'observe'
				&& !(toolRequest.tool.kind === 'action' && toolRequest.tool.actionType === 'chat')) {
			if (work.taskAdopted !== undefined) return { ...work.taskAdopted, executed: false };
			// Player requests go through takeTask, which binds the requester and Minecraft's permission checks. Only a
			// turn woken by danger may defend the body without a task, and only with self-preservation tools.
			const dangerWoken = work.request.dangerWake === true || work.dangerWoken === true || work.request.selfCareWake === true;
			if (!dangerWoken || !isSelfPreservationTool(toolRequest.tool)) {
				throw Object.assign(new Error(dangerWoken
					? 'With no task you may only look after yourself: fight_target, flee_from, attack, use_ranged, block_with_shield, use_item (eat, drink, totem), select/equip items, pick up food, mine grown crops or melons, interact with ripe berries, navigate or move away, look, control without attack/use, wait. Anything else is a player request: call takeTask.'
					: 'You have no active task yet. If the operator asked you to do something, call takeTask first and end this turn; otherwise reply with say.'), { code: 'CONVERSATION_ONLY' });
			}
		}
		const executesBody = toolRequest.tool.kind === 'action'
			|| toolRequest.tool.kind === 'sequence'
			|| toolRequest.tool.kind === 'lookAround'
			|| toolRequest.tool.kind === 'gather'
			|| toolRequest.tool.kind === 'find'
			|| toolRequest.tool.kind === 'obtain'
			|| toolRequest.tool.kind === 'run_program'
			|| toolRequest.tool.kind === 'respond_program'
			|| toolRequest.tool.kind === 'start_action'
			|| toolRequest.tool.kind === 'replace_action';
		const supervisionKind = executesBody ? 'action' : toolRequest.tool.kind === 'finish' ? 'completion' : null;
		if (work.toolSupervision.has(toolRequest.callId)) throw codedRuntimeError('DUPLICATE_TOOL_CALL', 'A tool call with this callId is already running');
		const call = { token: null, executesBody, done: null, resolve: null };
		call.done = new Promise((resolve) => { call.resolve = resolve; });
		const finishPredecessors = toolRequest.tool.kind === 'finish' ? [...work.toolSupervision.values()].map((pending) => pending.done) : [];
		work.toolSupervision.set(toolRequest.callId, call);
		let supervisionToken = null;
		let result;
		try {
			if (finishPredecessors.length > 0) {
				await Promise.all(finishPredecessors);
				if (work.expired || !this.#isConnectionEpochCurrent(work.connectionEpoch)
					|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) return { state: 'CANCELLED', reasonCode: 'STALE_PLAN', executed: false };
			}
			if (executesBody && record.state === DynamicAgentState.PLANNING) {
				this.#registry.setState(record.agentId, DynamicAgentState.ACTING, { goalRevision: record.goalRevision });
			}
			// After finish awaits operator confirmation the goal's work leases are terminated;
			// the body must still act at once, so it runs unsupervised instead of failing to acquire a lease.
			const awaitingConfirmation = sameSupervisionKey(this.#nativeConfirmationWaits.get(work.agentId), work.supervisionKey);
			const supervised = supervisionKind !== null && !awaitingConfirmation;
			const leaseOptions = supervisionKind === 'action' ? { timeoutMs: actionLeaseTimeoutMs(requestedActionTimeoutMs(toolRequest.tool)) } : undefined;
			supervisionToken = supervised ? this.#goalSupervisor.begin(work.supervisionKey, supervisionKind, leaseOptions) : null;
			if (awaitingConfirmation && executesBody && !['chat', 'wait'].includes(toolRequest.tool.actionType)) {
				// Work begun while waiting (defending, a player's extra request) may need follow-up wakes, such as its
				// own action result; let those through until a turn ends without new body work (see completion).
				this.#confirmationActivity.add(work.agentId);
				work.actedWhileAwaiting = true;
			}
			call.token = supervisionToken;
			this.#goalSupervisor.progress(work.supervisionToken);
			// A step says why in game chat as it starts (it also stays in the decision log as the call's own argument): a step
			// that runs to its result as it begins, a background step once its action is admitted (a rejected one says nothing).
			const announceStep = () => this.#publishVerbose(record.agentId, record.goalRevision, 'decision', sanitizePublicNarrative(`${toolRequest.tool.step.verb.replace(/_/g, ' ')}: ${toolRequest.tool.step.why}`), work.connectionEpoch);
			if (toolRequest.tool.step !== undefined && toolRequest.tool.kind !== 'start_action') announceStep();
			result = await this.#nativeRuntime.execute(toolRequest, record, { lifecycleGeneration: work.lifecycleGeneration });
			if (toolRequest.tool.step !== undefined && toolRequest.tool.kind === 'start_action' && result?.step?.started === true) announceStep();
			// A greeting/read/reply does not grant later messages authority over finished work.
			if (deliveredConfirmationAuthority && !isConfirmationContextTool(toolRequest.tool)
					&& result?.executed !== false && ['SUCCEEDED', 'RUNNING'].includes(result?.state)) {
				this.#confirmationWorkAuthority.set(work.agentId, work.supervisionKey);
			}
			if (toolRequest.tool.kind === 'action' && toolRequest.tool.actionType === 'chat' && result?.state === 'SUCCEEDED') work.successfulChat = true;
			if (result?.advisory === 'program_planning_due') work.preparingProgram = { programId: result.programId, programVersion: result.programVersion };
			const current = this.#registry.get(work.agentId);
			if (current?.goalRevision === work.goalRevision
				&& this.#isConnectionEpochCurrent(work.connectionEpoch)
				&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
				this.#taskViews.noteFoodHandback(current, toolRequest.tool, result);
				if (toolRequest.tool.kind === 'task_plan' && toolRequest.tool.operation === 'intent' && result?.state === 'SUCCEEDED') {
					const intent = toolRequest.tool.intent;
					const label = this.#taskViews.snapshot(current).plan?.steps.find(step => step.id === intent.step)?.label ?? intent.step;
					this.#publishVerbose(current.agentId, current.goalRevision, 'decision', sanitizePublicNarrative(`${label}: ${intent.why}`), work.connectionEpoch);
				}
				if (result?.state === 'AWAITING_OPERATOR_CONFIRMATION') {
					// Waiting belongs to this goal lifecycle, not just the provider turn that
					// requested verification. Ordinary queued sightings cannot resume it.
					this.#nativeConfirmationWaits.set(record.agentId, { ...work.supervisionKey, facts: structuredClone(result.facts) });
					this.#confirmationWorkAuthority.delete(record.agentId);
					work.confirmationMessageBoundary = (work.request.deliveredPlayerRequests?.length ?? 0) + (work.steeredPlayerRequests?.length ?? 0);
					this.#confirmationActivity.delete(record.agentId);
					this.#goalSupervisor.terminate(work.supervisionKey);
				} else if (toolRequest.tool.kind === 'finish') {
					// Body actions while waiting (defending, eating, a player's extra request) leave the finished goal
					// awaiting confirmation; only a new finish result changes it. Clearing it restarted goal supervision,
					// which woke the model to redo the finished work.
					this.#nativeConfirmationWaits.delete(record.agentId);
					this.#confirmationWorkAuthority.delete(record.agentId);
					this.#confirmationActivity.delete(record.agentId);
				}
			}
			return result;
		} finally {
			if (supervisionToken !== null) {
				this.#goalSupervisor.end(supervisionToken, { progress: ['SUCCEEDED', 'COMPLETED'].includes(result?.state) });
			}
			if (work.toolSupervision.get(toolRequest.callId) === call) work.toolSupervision.delete(toolRequest.callId);
			if (work.toolSupervision.size === 0) { work.modelCallStartedAt = safeClockRead(this.#controlNow); work.callStreamingTool = false; }
			if (result !== undefined) this.#noteSurvivalDelivered(work, null, result);
			// An action stopped by the contact names it, with the exits, in its result. That alone makes the turn aware, even
			// when no observation has reported the contact yet or the body has already left it.
			if (['IN_LAVA', 'ON_FIRE'].includes(result?.reasonCode)) {
				work.hazardResultDelivered = true;
				this.#noteSurvivalAware(work);
				this.#noteHazardDelivered(work);
			}
			call.resolve();
			this.#goalSupervisor.progress(work.supervisionToken);
			const latest = this.#registry.get(work.agentId);
			if (!this.#stopping && !this.#closed && executesBody && latest?.goalRevision === work.goalRevision && latest.state === DynamicAgentState.ACTING
				&& ![...work.toolSupervision.values()].some((pending) => pending.executesBody)
				&& this.#isConnectionEpochCurrent(work.connectionEpoch)
				&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
				this.#registry.setState(latest.agentId, DynamicAgentState.PLANNING, { goalRevision: latest.goalRevision });
			}
		}
	}

	/**
	 * The model chose to adopt a player's request. Only a conversation-only turn (no active task)
	 * may do so, and only for a player message delivered in this turn, so neither the model nor a
	 * player talking to it can credit someone else. Minecraft owns the decision: it starts or
	 * resumes the goal through its normal lifecycle (goal_control follows), stages a translation
	 * draft, or refuses with a reason the model can relay. Nothing here starts work on its own.
	 */
	async #takeTask(work, tool) {
		if (work.request.conversationOnly !== true) {
			return { state: 'REJECTED', reasonCode: 'TASK_ALREADY_ACTIVE', executed: false,
				message: 'You already have a task. takeTask only adopts an operator request when you have none; treat an operator message as input to your current task and act on it now (awaiting operator confirmation never blocks this).' };
		}
		if (work.taskAdopted !== undefined) return { ...work.taskAdopted, executed: false };
		const received = [...(work.request.deliveredPlayerRequests ?? []), ...(work.steeredPlayerRequests ?? [])];
		// Only the operator gives tasks; Minecraft enforces this too.
		const delivered = received.filter((entry) => entry.operator === true);
		const senders = [...new Set(delivered.map((entry) => entry.sourceId))];
		if (tool.requesterId !== undefined && !senders.includes(tool.requesterId)) {
			const notOperator = received.some((entry) => entry.sourceId === tool.requesterId);
			return { state: 'REJECTED', reasonCode: notOperator ? 'NOT_OPERATOR' : 'UNKNOWN_REQUESTER', executed: false,
				message: notOperator ? 'That player is not the operator; only the operator gives you tasks.'
					: 'That player did not ask you anything in this conversation. Use the sourceId of a message you received.' };
		}
		if (tool.requesterId === undefined && senders.length !== 1) {
			return { state: 'REJECTED', reasonCode: senders.length === 0 ? (received.length > 0 ? 'NOT_OPERATOR' : 'NO_PLAYER_REQUEST') : 'REQUESTER_REQUIRED', executed: false,
				message: senders.length === 0
					? (received.length > 0 ? 'Only the operator gives you tasks; no operator message is in this conversation.' : 'No player asked you anything in this conversation. Only adopt a task the operator requested.')
					: `Several operators messaged you; pass requesterId (one of ${senders.join(', ')}) for the request you adopt.` };
		}
		const requesterId = tool.requesterId ?? senders[0];
		// A model paraphrase could launder another sender's directive through an operator greeting.
		const asked = delivered.filter((entry) => entry.sourceId === requesterId
			&& (tool.request === undefined || entry.text === tool.request)).at(-1);
		if (asked === undefined) return { state: 'REJECTED', reasonCode: 'REQUEST_MISMATCH', executed: false,
			message: 'request must exactly match delivered operator words; omit it for their latest message. Never credit another sender to the operator.' };
		const requestId = randomUUID();
		const outcome = new Promise((resolve) => {
			const timer = setTimeout(() => this.#settleTaskRequest(requestId, 'TASK_REQUEST_TIMEOUT', 'Minecraft did not answer in time; nothing started. Try again.'), this.#taskRequestTimeoutMs);
			timer.unref?.();
			this.#taskRequests.set(requestId, { agentId: work.agentId, resolve, timer });
		});
		try {
			await this.#sendForEpoch(work.connectionEpoch, 'task_request', work.agentId, {
				requestId, goalRevision: work.goalRevision, requesterId, conversationSequence: asked.sequence,
				request: asked.text, resume: tool.resume === true,
			});
		} catch (error) {
			this.#settleTaskRequest(requestId, 'TASK_REQUEST_UNSENT', 'The request could not be sent to Minecraft.');
			throw error;
		}
		const result = await outcome;
		this.#writeTrace('native_task_request', { agentId: work.agentId, goalRevision: work.goalRevision, status: result.status, reasonCode: result.reasonCode });
		if (result.status === 'rejected') {
			return { state: 'REJECTED', reasonCode: result.reasonCode, executed: false,
				message: `${result.message} Tell the player with say.` };
		}
		work.taskAdopted = result.status === 'pending'
			? { state: 'PENDING', reasonCode: result.reasonCode, goalRevision: result.goalRevision, requesterId,
				message: `${result.message} You may tell the player briefly with say, then end this turn; your task turn starts when the goal does.` }
			: { state: 'SUCCEEDED', reasonCode: result.reasonCode, goalRevision: result.goalRevision, requesterId,
				message: 'Minecraft accepted this as your task. End this turn now: your task turn starts immediately with every tool.' };
		return work.taskAdopted;
	}

	#settleTaskRequest(requestId, reasonCode, message) {
		const pending = this.#taskRequests.get(requestId);
		if (pending === undefined) return;
		this.#taskRequests.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve({ requestId, status: 'rejected', reasonCode, message, goalRevision: 0 });
	}

	#settleTaskRequests(agentId, reasonCode, message) {
		for (const [requestId, pending] of this.#taskRequests) {
			if (agentId === undefined || pending.agentId === agentId) this.#settleTaskRequest(requestId, reasonCode, message);
		}
	}

	async #completeNativeTurn(work, result) {
		await Promise.all([...work.toolSupervision.values()].map((call) => call.done));
		await this.#settleNativeSteering(work);
		if (this.#providerWork.get(work.agentId) !== work) {
			this.#goalSupervisor.end(work.supervisionToken, { scheduleRecovery: false });
			return null;
		}
		if (this.#isConnectionEpochCurrent(work.connectionEpoch)
			&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) await this.#commitNativeConversation(work.request);
		else this.#restoreNativeConversation(work.request);
		// Persistence is part of delivery. A failed commit still owns the exact
		// supervision entry, so failNativeTurn can arrange autonomous recovery.
		this.#goalSupervisor.end(work.supervisionToken, { progress: (result?.toolCalls ?? 0) > 0 });
		if (work.request.conversationOnly === true && this.#providerWork.get(work.agentId) === work) this.#goalSupervisor.terminate(work.supervisionKey);
		// Disk completion can race replacement work just like provider completion.
		if (this.#providerWork.get(work.agentId) !== work) return null;
		this.#providerWork.delete(work.agentId);
		this.#providerRetryAfter.delete(work.agentId);
		const pending = this.#pendingWithFoldedSteer(work);
		const completedAt = safeClockRead(this.#controlNow);
		const pendingWaitMs = work.pendingSince == null || completedAt === null || pending === null ? null : Math.max(0, Math.round(completedAt - work.pendingSince));
		const record = this.#registry.get(work.agentId);
		if (record !== null && record.goalRevision === work.goalRevision
				&& this.#isConnectionEpochCurrent(work.connectionEpoch)
				&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
			this.#writeTrace('native_turn_completed', { agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId, toolCalls: result?.toolCalls ?? 0,
				trigger: work.request.nativeEvent?.trigger ?? work.request.trigger ?? null, wakeEvent: work.request.nativeEvent?.event ?? null,
				...(work.inputBytes === undefined ? {} : { inputBytes: work.inputBytes }), ...turnUsageTraceFields(result?.usage),
				...(pendingWaitMs === null ? {} : { pendingWaitMs, pendingTrigger: pending?.trigger ?? null }) });
		}
		if (this.#reschedulePendingNativeTurn(pending)) return result;
		if (this.#isActiveNativeGoal(work) && this.#nativeRuntime.remindProgramDecision(record)) {
			this.#writeTrace('native_program_decision_followup', { agentId: work.agentId, goalRevision: work.goalRevision });
			return result;
		}
		if (work.request.nativeConversationDelivery?.omittedEntries > 0
			&& await work.request.nativeConversationDelivery.inbox.hasUnreadWake()
			&& this.#reschedulePendingNativeTurn({ ...work.request, conversationRetry: false })) return result;
		if (work.request.conversationOnly === true && work.request.dangerWake !== true && work.request.selfCareWake !== true && !work.successfulChat
				&& work.request.conversationRetry !== true && record !== null) {
			this.#scheduleNativeTurn(record, {
				...work.request,
				connectionEpoch: work.connectionEpoch,
				conversationRetry: true,
				retryInstruction: 'Your previous turn made no visible reply. Call say exactly once now.',
			});
			return result;
		}
		// A no-task turn (often a danger turn) ended: if the body is still low, the model may now recover.
		if (work.request.conversationOnly === true && record !== null && record.goalRevision === work.goalRevision
				&& this.#isConnectionEpochCurrent(work.connectionEpoch)
				&& this.#considerHealWake(record, this.#nativeRuntime.snapshotLive(work.agentId)?.observation ?? null, work.lifecycleGeneration, work.connectionEpoch)) return result;
		const awaitingConfirmation = record !== null && this.#awaitingNativeConfirmation(record, work.lifecycleGeneration);
		if (awaitingConfirmation) this.#goalSupervisor.terminate(work.supervisionKey);
		// A turn that started no body work while waiting returns the goal to plain waiting (no redo wakes).
		if (awaitingConfirmation && work.actedWhileAwaiting !== true) this.#confirmationActivity.delete(work.agentId);
		if (!awaitingConfirmation && this.#isActiveNativeGoal(work)) {
			this.#goalSupervisor.ensure(work.supervisionKey, (result?.toolCalls ?? 0) === 0 ? 'zero_tool_turn' : 'turn_completed');
		}
		return result;
	}

	async #failNativeTurn(work, error) {
		let recovery = classifyRecoveryFailure(error);
		let classification = recovery.retryable ? 'recoverable' : classifyNativeGoalError(error);
		this.#writeTrace('native_turn_failed', { agentId: work.agentId, goalRevision: work.goalRevision,
			errorCode: sanitizeDiagnosticErrorCode(error, { fallback: 'NATIVE_TURN_FAILED' }), classification });
		try {
			await this.#settleNativeSteering(work);
		} catch (steeringError) {
			error = steeringError;
			recovery = classifyRecoveryFailure(error);
			classification = recovery.retryable ? 'recoverable' : classifyNativeGoalError(error);
		} finally {
			this.#goalSupervisor.end(work.supervisionToken, { scheduleRecovery: classification !== 'stale' });
		}
		if (this.#providerWork.get(work.agentId) !== work) return null;
		this.#providerWork.delete(work.agentId);
		const pending = this.#pendingWithFoldedSteer(work);
		const record = this.#registry.get(work.agentId);
		const staleLifecycle = record?.goalRevision !== work.goalRevision
			|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
			|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration);
		if (staleLifecycle || this.#stopping || this.#closed) {
			if (work.request.conversationOnly === true) this.#goalSupervisor.terminate(work.supervisionKey);
			this.#reschedulePendingNativeTurn(pending);
			return null;
		}
		this.#restoreNativeConversation(work.request);
		if (classification === 'stale') {
			if (work.request.conversationOnly === true) this.#goalSupervisor.terminate(work.supervisionKey);
			this.#reschedulePendingNativeTurn(pending);
			return null;
		}
		if (this.#preparationHasRunningProgram(work, record)) {
			this.#writeTrace('native_preparation_failed_current_program_preserved', { agentId: work.agentId, goalRevision: work.goalRevision,
				errorCode: sanitizeDiagnosticErrorCode(error, { fallback: 'NATIVE_TURN_FAILED' }) });
			this.#goalSupervisor.ensure(work.supervisionKey, 'program_preparation_failed');
			// The mod fails the goal on agent_error, cancelling the program kept here; only a terminal error may end it.
			if (classification === 'terminal') await this.#reportAgentError(work.agentId, error, work.connectionEpoch);
			else this.#publishVerbose(work.agentId, work.goalRevision, 'retry', 'The model turn ended early; the running program continues and its next event wakes the model.', work.connectionEpoch, {
				component: 'provider', boundary: 'planning', code: sanitizeDiagnosticErrorCode(error, { fallback: 'NATIVE_TURN_FAILED' }), state: 'retrying',
			});
			this.#reschedulePendingNativeTurn(pending);
			return null;
		}
		await this.#nativeRuntime.dispose(work.agentId, 'native_turn_failed');
		this.#nativeObservationSignatures.delete(work.agentId);
		if (classification === 'terminal') {
			this.#goalSupervisor.terminate(work.supervisionKey);
			if ([DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING].includes(record.state)) {
				this.#registry.setState(work.agentId, DynamicAgentState.ERROR, {
					goalRevision: work.goalRevision,
					error: { code: sanitizeDiagnosticErrorCode(error, { fallback: 'NATIVE_TURN_FAILED' }), message: sanitizeDiagnosticErrorMessage(error, { maxBytes: 2_048 }) },
				});
			}
			await this.#reportAgentError(work.agentId, error, work.connectionEpoch);
		} else {
			if (work.request.conversationOnly === true) {
				this.#nativeConversationRecoveries.set(work.agentId, {
					supervisionKey: work.supervisionKey,
					request: work.request,
				});
			}
			this.#goalSupervisor.recover(work.supervisionKey, this.#recoveryDetails(work.agentId, {
				errorCode: recovery.code,
				recoveryKind: recovery.kind,
				nextProbeAtEpochMs: recovery.nextProbeAtEpochMs,
			}));
			this.#reschedulePendingNativeTurn(pending);
		}
		return null;
	}

	#reschedulePendingNativeTurn(request, { released = false } = {}) {
		if (request === null || request === undefined || this.#stopping || this.#closed) return false;
		const record = this.#registry.get(request.agentId);
		if (record === null || record.goalRevision !== request.goalRevision
				|| !this.#isConnectionEpochCurrent(request.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(record.agentId, request.lifecycleGeneration)) return false;
		const eligible = request.conversationOnly === true
			? PARKED_NATIVE_STATES
			: [DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING, DynamicAgentState.DEAD];
		if (!this.#usesNativeTools(record) || !eligible.includes(record.state)) return false;
		if (!this.#nativePreparationIsCurrent(record, request) || this.#confirmationBlocksRequest(record, request)) return false;
		// An ordinary observation queued behind a turn that then started its own action is stale for the same reason.
		if (!protectedNativeWake(request) && request.conversationOnly !== true && request.nativeEvent?.event === 'observation'
				&& request.nativeEvent.trigger !== 'continuation' && request.nativeEvent.trigger !== DIMENSION_CHANGED_TRIGGER
				&& !(request.nativeConversationDelivery?.omittedEntries > 0) && this.#nativeRuntime.hasModelAction(record)
				&& !released && this.#holdWakeForModelAction(record, request)) return false;
		// Routine perception queued behind a turn that left a program running belongs to that program, exactly as a live
		// observation does: the program decides whether it needs the model (its decisions, end and danger still wake).
		if (!protectedNativeWake(request) && request.conversationOnly !== true && request.nativeEvent?.event === 'observation'
				&& PROGRAM_OWNED_PERCEPTION_TRIGGERS.has(request.nativeEvent.trigger ?? request.trigger)
				&& !(request.nativeConversationDelivery?.omittedEntries > 0) && !released && this.#nativeRuntime.hasProgram(record)) {
			this.#writeTrace('native_wake_left_to_program', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: request.trigger ?? null });
			return false;
		}
		// Waking the model for any reason ends the hold; its named reason rides this wake only if the wake is generic.
		const resumed = this.#resumeDeferredWake(record, request);
		if (resumed !== request.trigger && request.nativeEvent?.event === 'observation' && request.nativeEvent.trigger !== 'continuation') {
			request = { ...request, trigger: resumed, nativeEvent: { ...request.nativeEvent, trigger: resumed } };
		}
		this.#scheduleNativeTurn(record, request);
		return true;
	}

	#isActiveNativeGoal(work) {
		if (this.#stopping || this.#closed) return false;
		const record = this.#registry.get(work.agentId);
		return record !== null
			&& !this.#awaitingNativeConfirmation(record, work.lifecycleGeneration)
			&& record.goalRevision === work.goalRevision
			&& this.#isConnectionEpochCurrent(work.connectionEpoch)
			&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)
			&& this.#usesNativeTools(record)
			&& [DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING, DynamicAgentState.DEAD].includes(record.state);
	}

	#scheduleInitialPlan(record, request) {
		if (!this.#isConnectionEpochCurrent(request.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(record.agentId, request.lifecycleGeneration)) return;
		request = this.#afterProviderProbeDeadline(record, request);
		if (request === null) return;
		const existing = this.#providerWork.get(record.agentId);
		if (existing !== undefined) {
			if (existing.goalRevision !== record.goalRevision || existing.lifecycleGeneration !== request.lifecycleGeneration) {
				existing.pending = mergePlannerRequest(existing.pending, request);
				return;
			}
			if (request.priority === 'urgent' && existing.request.priority !== 'urgent') {
				// Retain the urgent payload before cancellation settles. The scheduler
				// may reject the queued turn immediately, so interruption alone cannot
				// be the handoff mechanism for the replacement request.
				existing.pending = mergePlannerRequest(existing.pending, request);
				void Promise.resolve(this.#planner.interrupt(record.agentId, 'Urgent planning trigger')).catch(() => {});
				return;
			}
			existing.pending = mergePlannerRequest(existing.pending, request);
			return;
		}
		if (this.#scheduler.hasScheduled(record.agentId)) return;
		if (request.priority !== 'urgent' && request.receiptMonotonicMs !== null && (this.#providerRetryAfter.get(record.agentId) ?? 0) > request.receiptMonotonicMs) return;
		void this.#sendForEpoch(request.connectionEpoch, 'planning_state', record.agentId, { goalRevision: record.goalRevision, state: DynamicAgentState.PLANNING })
			.catch((error) => this.#reportAgentError(record.agentId, error, request.connectionEpoch));
		void this.#scheduleProviderPlan(record, request, { preserveState: false, kind: 'initial' });
	}

	#afterProviderProbeDeadline(record, request) {
		const probeDeadline = this.#providerProbeDeadlines.get(record.agentId);
		const now = safeClockRead(this.#epochNow);
		if (probeDeadline !== undefined && now !== null && now < probeDeadline) {
			const deferred = this.#deferredProviderRecovery.get(record.agentId);
			this.#deferredProviderRecovery.set(record.agentId, mergePlannerRequest(deferred, request));
			return null;
		}
		if (probeDeadline !== undefined) {
			this.#providerProbeDeadlines.delete(record.agentId);
			const deferred = this.#deferredProviderRecovery.get(record.agentId);
			this.#deferredProviderRecovery.delete(record.agentId);
			request = mergePlannerRequest(deferred, request);
		}
		return request;
	}

	#scheduleProviderPlan(record, request, { preserveState = false, kind = 'initial' } = {}) {
		const lifecycleGeneration = request.lifecycleGeneration ?? this.#lifecycleGeneration(record.agentId);
		const connectionEpoch = request.connectionEpoch ?? this.#connectionEpoch;
		if (!this.#isConnectionEpochCurrent(connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(record.agentId, lifecycleGeneration)) return Promise.resolve(null);
		const existing = this.#providerWork.get(record.agentId);
		if (existing !== undefined) {
			if (existing.goalRevision !== record.goalRevision || existing.lifecycleGeneration !== lifecycleGeneration
					|| existing.connectionEpoch !== connectionEpoch) {
				existing.pending = mergePlannerRequest(existing.pending, request);
				return existing.promise;
			}
			existing.pending = mergePlannerRequest(existing.pending, request);
			return existing.promise;
		}
		const work = {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			lifecycleGeneration,
			connectionEpoch,
			kind,
			preserveState,
			request,
			contextSnapshot: this.#contextSnapshot(record),
			pending: null,
			traceId: request.traceId ?? planningTraceId(record.agentId, record.goalRevision, lifecycleGeneration, kind),
			promise: null,
		};
		this.#providerWork.set(record.agentId, work);
		const verboseReporter = this.#verboseReporter(record.agentId, record.goalRevision, { connectionEpoch });
		const providerRequest = {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			preserveState,
			recoverySummary: record.lastSummary,
			input: request.input,
			prepareInput: request.prepareInput ?? null,
			traceId: work.traceId,
			planningPriority: request.priority,
			priority: request.priority,
			onVerbose: verboseReporter,
		};
		work.promise = Promise.resolve()
			.then(() => this.#planner.requestPlan(providerRequest))
			.then((decision) => this.#completeProviderPlan(work, decision), (error) => this.#failProviderPlan(work, record, error));
		return work.promise;
	}

	async #completeProviderPlan(work, decision) {
		if (this.#providerWork.get(work.agentId) !== work) return null;
		const record = this.#registry.get(work.agentId);
		if (record === null || record.goalRevision !== work.goalRevision
				|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
			const pending = work.pending;
			this.#providerWork.delete(work.agentId);
			this.#reschedulePendingProviderPlan(pending);
			return null;
		}
		let runtime = null;
		try {
			this.#programRuntimeEpochs.set(record.agentId, work.connectionEpoch);
			runtime = await this.#programRuntime.installDecision(record, decision, {
				observation: work.request.observation,
				eventSequence: work.request.eventSequence,
				traceId: work.traceId,
			});
		} catch (error) {
			if (this.#providerWork.get(work.agentId) !== work) return null;
			this.#providerWork.delete(work.agentId);
			const current = this.#registry.get(work.agentId);
			const stale = current?.goalRevision !== work.goalRevision
				|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration);
			if (this.#programRuntimeEpochs.get(work.agentId) === work.connectionEpoch) this.#programRuntimeEpochs.delete(work.agentId);
			if (!stale) await this.#reportAgentError(work.agentId, error, work.connectionEpoch);
			if (stale || work.pending?.priority === 'urgent') this.#reschedulePendingProviderPlan(work.pending);
			return null;
		}
		if (this.#providerWork.get(work.agentId) !== work) return null;
		const current = this.#registry.get(work.agentId);
		if (current?.goalRevision !== work.goalRevision
				|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
			const pending = work.pending;
			this.#providerWork.delete(work.agentId);
			if (this.#programRuntimeEpochs.get(work.agentId) === work.connectionEpoch) {
				this.#programRuntime.dispose(work.agentId);
				this.#programRuntimeEpochs.delete(work.agentId);
			}
			this.#reschedulePendingProviderPlan(pending);
			return null;
		}
		const pending = work.pending;
		this.#providerWork.delete(work.agentId);
		this.#providerRetryAfter.delete(work.agentId);
		this.#publishVerbose(record.agentId, record.goalRevision, 'decision', verboseDecisionSummary(decision), work.connectionEpoch);
		if (runtime === null) return runtime;
		const latest = this.#registry.get(work.agentId);
		if (latest === null || latest.goalRevision !== work.goalRevision
				|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) return runtime;
		if (decision.contextReceipt != null) this.#rememberAcceptedContextCursor(latest, decision.contextReceipt);
		this.#flushPendingAttention(latest, work.connectionEpoch);
		if (pending === null) return runtime;
		try {
			if (pending.observation !== undefined) {
				await this.#programRuntime.onObservation(latest, {
					observation: pending.observation,
					eventSequence: pending.eventSequence,
					attention: pending.attention,
					priority: pending.priority,
					trigger: pending.trigger,
				});
			} else if (pending.attention) {
				this.#programRuntime.notifyAttention(latest, { priority: pending.priority, trigger: pending.trigger });
			}
		} catch (error) {
			await this.#reportAgentError(work.agentId, error, work.connectionEpoch);
		}
		return runtime;
	}

	async #failProviderPlan(work, record, error) {
		if (this.#providerWork.get(work.agentId) !== work) return null;
		const current = this.#registry.get(work.agentId);
		const stale = current?.goalRevision !== work.goalRevision
			|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
			|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration);
		this.#promotePendingAttention(work, current);
		const pending = work.pending;
		this.#providerWork.delete(work.agentId);
		const urgentRecovery = pending?.priority === 'urgent';
		const recovery = classifyRecoveryFailure(error);
		const quietRetry = recovery.quiet;
		if (!stale && recovery.retryable) {
			if (quietRetry) {
				const retryAt = safeClockRead(this.#controlNow);
				if (retryAt !== null) this.#providerRetryAfter.set(record.agentId, retryAt + EMPTY_TURN_RETRY_DELAY_MS);
			}
			this.#publishVerbose(record.agentId, record.goalRevision, 'retry', verboseRecoveryMessage(recovery), work.connectionEpoch, {
				component: 'provider', boundary: recovery.kind ?? 'planning', code: recovery.code ?? 'PROVIDER_RETRY', state: 'retrying',
			});
			try {
				const latest = this.#registry.get(record.agentId);
				if (latest?.state === DynamicAgentState.ERROR) this.#registry.setState(record.agentId, DynamicAgentState.STARTING, { goalRevision: record.goalRevision });
				if (this.#registry.get(record.agentId)?.state === DynamicAgentState.STARTING) this.#registry.setState(record.agentId, DynamicAgentState.PLANNING, { goalRevision: record.goalRevision });
			} catch (stateError) {
				void this.#reportAgentError(record.agentId, stateError, work.connectionEpoch);
			}
			const session = typeof this.#codexService.getAgent === 'function' ? this.#codexService.getAgent(record.agentId) : null;
			if (session !== null && typeof this.#codexService.replaceAgent === 'function') {
				try {
					await this.#codexService.replaceAgent(record, {
						recoverySummary: 'provider_plan_recovery',
						controlProtocol: 'arena_script',
						...(Number.isSafeInteger(session.sessionGeneration) ? { expectedSessionGeneration: session.sessionGeneration } : {}),
					});
				} catch (replacementError) {
					this.#writeTrace('provider_session_replacement_failed', {
						agentId: record.agentId,
						goalRevision: record.goalRevision,
						errorCode: replacementError?.code ?? 'SESSION_REPLACEMENT_FAILED',
					});
				}
			}
			const recoveryDetails = this.#recoveryDetails(record.agentId, {
				errorCode: recovery.code,
				recoveryKind: recovery.kind,
				nextProbeAtEpochMs: recovery.nextProbeAtEpochMs,
			});
			const supervisionKey = this.#supervisionKey(record, work.lifecycleGeneration);
			this.#goalSupervisor.activate(supervisionKey);
			this.#goalSupervisor.recover(supervisionKey, recoveryDetails);
			this.#reschedulePendingProviderPlan(pending);
			return null;
		}
		if (!stale && !urgentRecovery) await this.#reportAgentError(record.agentId, error, work.connectionEpoch);
		if (!stale && quietRetry && current?.state === DynamicAgentState.ERROR) {
			try {
				this.#registry.setState(record.agentId, DynamicAgentState.STARTING, { goalRevision: record.goalRevision });
			} catch (stateError) {
				void this.#reportAgentError(record.agentId, stateError, work.connectionEpoch);
				return null;
			}
		}
		if (urgentRecovery || stale) this.#reschedulePendingProviderPlan(pending);
		return null;
	}

	#promotePendingAttention(work, record) {
		const attention = this.#pendingAttention.get(work.agentId);
		if (record === null || attention?.goalRevision !== work.goalRevision) return;
		const request = work.request;
		const prepared = buildPlannerRequest({
			agent: { agentId: record.agentId, provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort },
			goal: record.currentGoal,
			goalRevision: record.goalRevision,
			attentionPriority: 'urgent',
			attentionTrigger: attention.trigger,
			observation: request.observation,
		}, this.#plannerContext(record.agentId));
		work.pending = mergePlannerRequest(work.pending, {
			...request,
			attention: true,
			priority: 'urgent',
			trigger: attention.trigger,
			preserveState: false,
			...prepared,
		});
		this.#pendingAttention.delete(work.agentId);
	}

	#reschedulePendingProviderPlan(request) {
		if (request === null || request === undefined) return;
		const record = this.#registry.get(request.agentId);
		if (record === null || record.goalRevision !== request.goalRevision
				|| !this.#isConnectionEpochCurrent(request.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(record.agentId, request.lifecycleGeneration)) return;
		if (record.state === DynamicAgentState.ERROR && request.preserveState !== true) {
			try {
				this.#registry.setState(record.agentId, DynamicAgentState.STARTING, { goalRevision: record.goalRevision });
			} catch (error) {
				void this.#reportAgentError(record.agentId, error, request.connectionEpoch);
				return;
			}
		}
		request = this.#afterProviderProbeDeadline(record, request);
		if (request === null) return;
		void this.#scheduleProviderPlan(record, request, { preserveState: request.preserveState === true, kind: request.kind ?? 'initial' });
	}

	#unbindBridge() {
		for (const [event, listener] of this.#listeners) this.#bridge.off(event, listener);
		this.#listeners = [];
		if (typeof this.#codexService.off === 'function') {
			for (const [event, listener] of this.#providerListeners) this.#codexService.off(event, listener);
		}
		this.#providerListeners = [];
	}

	#beginGoalControlInterruption(message, connectionEpoch) {
		let reason = null;
		if (['stop', 'disconnect', 'dead'].includes(message.payload.operation)) reason = `Goal ${message.payload.operation}`;
		// A turn woken by danger before the goal arrived can no longer act: every body call it makes is STALE_PLAN. Live
		// rooms spawn mobs while the goal is translated (5-9 s), and the goal turn waited 3-20 s for that turn to wind down.
		const olderTurn = this.#providerWork.get(message.agentId);
		if (message.payload.operation === 'start' && olderTurn !== undefined && olderTurn.goalRevision < (this.#registry.get(message.agentId)?.goalRevision ?? -1)) reason = 'Goal started';
		if (message.payload.operation === 'steer') reason = 'Goal steered';
		if (message.payload.operation === 'replace') reason = 'Goal replaced';
		if (message.payload.operation === 'complete') reason = 'Goal completed';
		if (reason === null) return;
		try {
			Promise.resolve(this.#planner.interrupt(message.agentId, reason)).catch((error) => this.#reportAgentError(message.agentId, error, connectionEpoch));
		} catch (error) {
			void this.#reportAgentError(message.agentId, error, connectionEpoch);
		}
	}

	#lifecycleGeneration(agentId) {
		return this.#lifecycleGenerations.get(agentId) ?? 0;
	}

	#supervisionKey(record, lifecycleGeneration = this.#lifecycleGeneration(record.agentId)) {
		return {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			lifecycleGeneration,
			sessionEpoch: this.#connectionEpoch,
			profileFingerprint: profileFingerprint(record),
		};
	}

	#recoveryDetails(agentId, { errorCode, recoveryKind, nextProbeAtEpochMs }) {
		const deadline = Number.isFinite(nextProbeAtEpochMs) && nextProbeAtEpochMs >= 0 ? nextProbeAtEpochMs : null;
		if (deadline === null) this.#providerProbeDeadlines.delete(agentId);
		else this.#providerProbeDeadlines.set(agentId, deadline);
		const now = safeClockRead(this.#epochNow);
		return {
			errorCode,
			...(recoveryKind === undefined ? {} : { recoveryKind }),
			...(deadline === null ? {} : {
				nextProbeAtEpochMs: deadline,
				retryDelayMs: now === null ? 0 : Math.max(0, deadline - now),
			}),
		};
	}

	#retireGoalSupervision(record, operation) {
		const key = this.#supervisionKey(record);
		if (['disconnect', 'dead'].includes(operation)) this.#goalSupervisor.suspend(key);
		else this.#goalSupervisor.terminate(key);
	}

	#advanceLifecycleGeneration(agentId) {
		this.#latestActionDispatches.delete(agentId);
		// Release unacknowledged reservations before a replacement consumes them.
		// Late callbacks have no reservation identity left to commit or rewind.
		const work = this.#providerWork.get(agentId);
		if (work?.kind === 'native') {
			this.#restoreNativeConversation(work.steerRequest);
			this.#restoreNativeConversation(work.request);
		}
		this.#pendingConversationInboxes.get(agentId)?.fence();
		this.#inspections.cancel(agentId);
		this.#memorySummaries.delete(agentId);
		const next = this.#lifecycleGeneration(agentId) + 1;
		this.#lifecycleGenerations.set(agentId, next);
		return next;
	}

	#invalidateLifecycleWork(message) {
		if (['queue', 'dequeue'].includes(message.payload.operation)) return;
		const current = this.#registry.get(message.agentId);
		if (current !== null && message.payload.goalRevision <= current.goalRevision) return;
		this.#invalidateAcceptedLifecycle(message.agentId);
	}

	#invalidateAcceptedLifecycle(agentId) {
		this.#pendingAttention.delete(agentId);
		this.#dropDeferredWake(agentId);
		this.#wakeFilter.drop(agentId);
		this.#attentionFlushes.delete(agentId);
		this.#contextCursors.delete(agentId);
		this.#nativeObservationSignatures.delete(agentId);
		this.#hazardContacts.delete(agentId);
		this.#survivalQuietSince.delete(agentId);
		this.#supervisedObservationRequests.delete(agentId);
		this.#nativeConversationRecoveries.delete(agentId);
		this.#providerProbeDeadlines.delete(agentId);
		this.#deferredProviderRecovery.delete(agentId);
		this.#nativeWorldSignals.delete(agentId);
		// A death's unread assessment outlives the revision changes a respawn brings (see #pendingAssessment); only the
		// delivery that was in flight is void now.
		const eventContext = this.#eventContexts.get(agentId);
		if (eventContext?.pending > 0) eventContext.inFlight = null;
		else this.#eventContexts.delete(agentId);
		this.#nativeConfirmationWaits.delete(agentId);
		this.#confirmationActivity.delete(agentId);
		this.#confirmationWorkAuthority.delete(agentId);
		this.#advanceLifecycleGeneration(agentId);
	}

	#rememberPendingAttention(agentId, goalRevision, attention) {
		const previous = this.#pendingAttention.get(agentId);
		if (previous === undefined || previous.goalRevision !== goalRevision) {
			this.#pendingAttention.set(agentId, { goalRevision, ...attention });
			return;
		}
		const merged = mergeAttentionTrigger(previous, attention);
		this.#pendingAttention.set(agentId, { goalRevision, ...merged });
	}

	#schedulePendingAttentionFlush(record) {
		if (!this.#programRuntime.hasCurrent(record)) return;
		const existing = this.#attentionFlushes.get(record.agentId);
		if (existing?.goalRevision === record.goalRevision) return;
		const token = { goalRevision: record.goalRevision, connectionEpoch: this.#connectionEpoch };
		this.#attentionFlushes.set(record.agentId, token);
		setImmediate(() => {
			if (this.#attentionFlushes.get(record.agentId) !== token) return;
			this.#attentionFlushes.delete(record.agentId);
			if (this.#stopping || this.#closed || !this.#isConnectionEpochCurrent(token.connectionEpoch)) return;
			const current = this.#registry.get(record.agentId);
			const pending = this.#pendingAttention.get(record.agentId);
			if (current === null || pending?.goalRevision !== token.goalRevision || current.goalRevision !== token.goalRevision) return;
			this.#flushPendingAttention(current, token.connectionEpoch);
		});
	}

	#flushPendingAttention(record, connectionEpoch = this.#connectionEpoch) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
		const pending = this.#pendingAttention.get(record.agentId);
		if (pending?.goalRevision !== record.goalRevision || !this.#programRuntime.hasCurrent(record)) return;
		try {
			const notified = this.#programRuntime.notifyAttention(record, { priority: pending.priority, trigger: pending.trigger });
			if (notified !== null) this.#pendingAttention.delete(record.agentId);
		} catch (error) {
			void this.#reportAgentError(record.agentId, error, connectionEpoch);
		}
	}

	#isLifecycleGenerationCurrent(agentId, generation) {
		return this.#lifecycleGeneration(agentId) === generation;
	}

	#enqueueAgent(agentId, operation, { waitForReconciliation = true, connectionEpoch = this.#connectionEpoch, coalesceKey = null, terminal = false, terminalKey = null, transactional = false, onAdmitted = null } = {}) {
		const releaseCapacity = this.#reserveAgentOperation(agentId);
		let resolve;
		let reject;
		const promise = new Promise((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
		const waiter = {
			resolve: (value) => { releaseCapacity(); resolve(value); },
			reject: (error) => { releaseCapacity(); reject(error); },
		};
		let queue = this.#agentOperations.get(agentId);
		if (queue === undefined) {
			queue = { items: [], drainPromise: null };
			this.#agentOperations.set(agentId, queue);
		}
		const tail = queue.items.at(-1);
		if (coalesceKey !== null && tail?.coalesceKey === coalesceKey) {
			for (const superseded of tail.waiters) superseded.resolve(undefined);
			tail.operation = operation;
			tail.waitForReconciliation = waitForReconciliation;
			tail.connectionEpoch = connectionEpoch;
			tail.transactional = transactional;
			tail.waiters = [waiter];
		} else {
			const pendingTerminal = terminalKey === null ? undefined : queue.items.find((item) => item.terminal === true
				&& item.terminalKey === terminalKey && item.connectionEpoch === connectionEpoch);
			if (terminal && pendingTerminal !== undefined) {
				// An exact replay shares reconciliation and its durable-before-ACK outcome.
				// Distinct receipts remain queued, bounded by the admission reservations.
				pendingTerminal.waiters.push(waiter);
				promise.catch((error) => this.#reportAgentError(agentId, error, connectionEpoch));
				return promise;
			}
			const ordinaryPending = queue.items.filter((item) => item.terminal !== true && item.transactional !== true).length;
			const transactionalPending = queue.items.filter((item) => item.transactional === true).length;
			const capacity = transactional ? this.#maxPendingAgentTransactions : this.#maxPendingAgentOperations;
			const pending = transactional ? transactionalPending : ordinaryPending;
			if (!terminal && pending >= capacity) {
				const lane = transactional ? 'transactional' : 'ordinary';
				const error = codedRuntimeError('AGENT_EVENT_BACKPRESSURE', `Agent '${agentId}' has ${capacity} pending ${lane} coordinator events`);
				waiter.reject(error);
				promise.catch((caught) => this.#reportAgentError(agentId, caught, connectionEpoch));
				return promise;
			}
			try {
				if (onAdmitted !== null) onAdmitted();
			} catch (error) {
				waiter.reject(error);
				promise.catch((caught) => this.#reportAgentError(agentId, caught, connectionEpoch));
				if (queue.items.length === 0 && this.#agentOperations.get(agentId) === queue) this.#agentOperations.delete(agentId);
				return promise;
			}
			queue.items.push({ operation, waitForReconciliation, connectionEpoch, coalesceKey, terminal, terminalKey, transactional, waiters: [waiter] });
		}
		promise.catch((error) => this.#reportAgentError(agentId, error, connectionEpoch));
		if (queue.drainPromise === null) queue.drainPromise = Promise.resolve().then(() => this.#drainAgentOperations(agentId, queue));
		return promise;
	}

	async #drainAgentOperations(agentId, queue) {
		while (queue.items.length > 0) {
			const item = queue.items.shift();
			try {
				if (this.#isConnectionEpochCurrent(item.connectionEpoch) && item.waitForReconciliation) await this.#reconciliation;
				const value = this.#isConnectionEpochCurrent(item.connectionEpoch) ? await item.operation() : undefined;
				for (const waiter of item.waiters) waiter.resolve(value);
			} catch (error) {
				for (const waiter of item.waiters) waiter.reject(error);
			}
		}
		if (this.#agentOperations.get(agentId) === queue) this.#agentOperations.delete(agentId);
	}

	#reserveAgentOperation(agentId) {
		const agentCount = this.#agentOperationCounts.get(agentId) ?? 0;
		if (this.#totalAgentOperations >= this.#connectionOperationCap) {
			throw new ProtocolV2Error('CONNECTION_INBOUND_BACKPRESSURE', 'Coordinator inbound operation queue is full');
		}
		if (agentCount >= this.#agentOperationCap) {
			throw new ProtocolV2Error('AGENT_INBOUND_BACKPRESSURE', `Coordinator inbound operation queue for agent '${agentId}' is full`);
		}
		this.#totalAgentOperations++;
		this.#agentOperationCounts.set(agentId, agentCount + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#totalAgentOperations = Math.max(0, this.#totalAgentOperations - 1);
			const pending = this.#agentOperationCounts.get(agentId) ?? 0;
			if (pending <= 1) this.#agentOperationCounts.delete(agentId);
			else this.#agentOperationCounts.set(agentId, pending - 1);
		};
	}

	#run(operation, connectionEpoch = this.#connectionEpoch, { requireConnected = true } = {}) {
		return Promise.resolve().then(() => {
			const current = requireConnected
				? this.#isConnectionEpochCurrent(connectionEpoch)
				: connectionEpoch === this.#connectionEpoch;
			return current ? operation() : undefined;
		}).catch((error) => this.emit('runtimeError', error));
	}

	async #sendForEpoch(connectionEpoch, type, agentId, payload) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) {
			throw codedRuntimeError('STALE_CONNECTION_EPOCH', `Bridge connection epoch ${connectionEpoch ?? 'unknown'} is no longer active`);
		}
		return this.#bridge.send(type, agentId, payload, { connectionEpoch });
	}

	async #acknowledgeActionResult(message, connectionEpoch) {
		if (typeof this.#bridge.acknowledgeActionResult === 'function') {
			await this.#bridge.acknowledgeActionResult(message.agentId, message.payload, { connectionEpoch });
		}
	}

	#queueReceiptReconciliation(message, connectionEpoch) {
		const key = JSON.stringify([connectionEpoch, message.agentId, message.payload]);
		const existing = this.#receiptReconciliations.get(key);
		if (existing !== undefined) return existing;
		// Separate capacity from gameplay ingress: a stalled disk must not consume
		// every observation/control slot. Overflow remains unacknowledged upstream.
		const agentPending = [...this.#receiptReconciliations.values()].filter((entry) => entry.message.agentId === message.agentId).length;
		if (this.#receiptReconciliations.size >= this.#connectionOperationCap || agentPending >= this.#agentOperationCap) {
			this.#emitRuntimeError(codedRuntimeError('RECEIPT_BACKPRESSURE', 'Receipt reconciliation is full; server must retain this unacknowledged result'));
			return null;
		}
		const predecessor = [...this.#receiptReconciliations.values()].findLast((entry) => entry.message.agentId === message.agentId && entry.connectionEpoch === connectionEpoch);
		const receipt = { key, message: { agentId: message.agentId, payload: structuredClone(message.payload) }, connectionEpoch, pending: null, retry: null, failures: 0, durable: false, done: null, resolve: null, predecessor: predecessor?.done };
		receipt.done = new Promise((resolve) => { receipt.resolve = resolve; });
		this.#receiptReconciliations.set(key, receipt);
		return receipt;
	}

	#retireReceiptReconciliations() {
		for (const receipt of this.#receiptReconciliations.values()) {
			clearTimeout(receipt.retry);
			receipt.resolve();
			// In-flight I/O remains tracked for bounded shutdown until it settles.
			if (receipt.pending === null) this.#receiptReconciliations.delete(receipt.key);
		}
	}

	#reconcileReceipt(receipt) {
		if (receipt === null || receipt.pending !== null || receipt.retry !== null || this.#stopping || this.#closed) return;
		const { message, connectionEpoch } = receipt;
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) {
			this.#receiptReconciliations.delete(receipt.key);
			receipt.resolve();
			return;
		}
		receipt.pending = Promise.resolve().then(async () => {
			await receipt.predecessor;
			if (this.#stopping || this.#closed || !this.#isConnectionEpochCurrent(connectionEpoch)) {
				this.#receiptReconciliations.delete(receipt.key);
				receipt.resolve();
				return;
			}
			if (!receipt.durable) {
				if (message.payload.actionType !== undefined) {
					const dispatch = await this.#playerMemory.notebook.findReceipt(message.agentId, { actionId: message.payload.actionId });
					if (dispatch?.actionType !== message.payload.actionType) throw codedRuntimeError('UNCORRELATED_ACTION_RECEIPT', 'Terminal action type does not match its durable dispatch; withholding ACK');
				}
				const stored = await this.#playerMemory.recordResult({ agentId: message.agentId, goalRevision: message.payload.goalRevision }, message.payload);
				if (stored !== true) throw codedRuntimeError('UNCORRELATED_ACTION_RECEIPT', 'No authoritative dispatch matches the terminal receipt; withholding ACK');
				receipt.durable = true;
				if (this.#isConnectionEpochCurrent(connectionEpoch)) this.#memorySummaries.delete(message.agentId);
			}
			if (!this.#stopping && !this.#closed && this.#isConnectionEpochCurrent(connectionEpoch)) await this.#acknowledgeActionResult(message, connectionEpoch);
			this.#receiptReconciliations.delete(receipt.key);
			receipt.resolve();
		}).catch((error) => {
			if (error?.code === 'UNCORRELATED_ACTION_RECEIPT' || ['RECEIPT_CONFLICT', 'RECEIPT_WORLD_REQUIRED'].includes(error?.message)) {
				// Missing or conflicting durable authority cannot be repaired by retrying
				// this payload. Leave it unacknowledged on the server, but release the
				// local queue so later, correctly correlated receipts can be persisted.
				this.#emitRuntimeError(error);
				this.#receiptReconciliations.delete(receipt.key);
				receipt.resolve();
				return;
			}
			// Storage errors are operational evidence, not failed gameplay. Keep the
			// exact receipt and retry without cancelling already-authorized work.
			receipt.failures++;
			this.#emitRuntimeError(error);
			if (!this.#stopping && !this.#closed && this.#isConnectionEpochCurrent(connectionEpoch)) {
				receipt.retry = setTimeout(() => { receipt.retry = null; this.#reconcileReceipt(receipt); }, Math.min(5_000, 100 * 2 ** Math.min(receipt.failures - 1, 6)));
				receipt.retry.unref?.();
			} else { this.#receiptReconciliations.delete(receipt.key); receipt.resolve(); }
		}).finally(() => { receipt.pending = null; });
	}

	async #sendRuntimeMessage(kind, type, agentId, payload) {
		const epochs = kind === 'native' ? this.#nativeRuntimeEpochs : this.#programRuntimeEpochs;
		const connectionEpoch = epochs.get(agentId);
		if (type === 'action_cancel' && !this.#isConnectionEpochCurrent(connectionEpoch)) return null;
		if (type === 'action_command' && this.#isConnectionEpochCurrent(connectionEpoch)) {
			// Both execution modes pass here. One latest dispatch per agent is enough
			// for active correlation; historical receipts still use durable authority.
			this.#latestActionDispatches.set(agentId, { actionId: payload.actionId, goalRevision: payload.goalRevision, actionType: payload.actionType, connectionEpoch });
		}
		if (kind === 'program' && type === 'action_command') {
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) throw Object.assign(new Error('Action belongs to an obsolete connection'), { code: 'STALE_SESSION' });
			await this.#playerMemory.recordDispatch(this.#registry.assertCurrentRevision(agentId, payload.goalRevision), payload);
		}
		if (kind === 'native' && type === 'action_command') {
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) throw codedRuntimeError('STALE_SESSION', 'Action belongs to an obsolete connection');
			const record = this.#registry.assertCurrentRevision(agentId, payload.goalRevision);
			if (!this.#nativeRuntime.hasCurrent(record)) {
				const lifecycleGeneration = this.#lifecycleGeneration(agentId);
				// Conversation replies can precede the first world observation. Retain
				// their exact dispatch in a durable transport-session scope. The
				// ephemeral "session:" notebook namespace intentionally never reaches
				// disk; this separate scope is not an observed world or model memory.
				await this.#playerMemory.notebook.recordDispatch(agentId, {
					worldId: `dispatch-session:${this.#playerMemory.sessionId}`,
					actionId: payload.actionId, goalRevision: payload.goalRevision,
					actionType: payload.actionType, arguments: payload.arguments,
				});
				if (!this.#isLifecycleGenerationCurrent(agentId, lifecycleGeneration)
					|| this.#nativeRuntime.isActionResultStale(record, payload)) throw codedRuntimeError('STALE_PLAN', 'Native action lifecycle ended before bridge send');
				this.#registry.assertCurrentRevision(agentId, payload.goalRevision);
			}
			if (this.#usesNativeTools(record) && typeof payload.arguments?.targetId === 'string') {
				this.#trackOwnBreak(record, this.#lifecycleGeneration(agentId), connectionEpoch, (state) => noteCombatDispatch(state, payload.actionId, payload.actionType, payload.arguments));
			}
			const target = payload.actionType === 'break_block' ? blockPosition(payload.arguments) : null;
			if (target !== null && this.#usesNativeTools(record)) {
				this.#trackOwnBreak(record, this.#lifecycleGeneration(agentId), connectionEpoch, (state) => startOwnBreak(state, payload.actionId, target));
			}
			// Native actions journal straight to the notebook; the experience review sees each one as it is sent.
			this.#playerMemory.noteDispatch(agentId, payload);
		}
		return this.#sendForEpoch(connectionEpoch, type, agentId, payload);
	}

	async #reportAgentError(agentId, error, connectionEpoch = this.#connectionEpoch) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
		try {
			const verboseRecord = this.#registry.get(agentId);
			if (QUIET_LIFECYCLE_ERRORS.has(error?.code)) return;
			if (classifyRecoveryFailure(error).quiet) {
				// App-server transport silence is retried from the next fresh observation.
				// It is not a world-action failure that the player or agent must repair.
				if (verboseRecord !== null) this.#publishVerbose(agentId, verboseRecord.goalRevision, 'retry', 'Provider output was incomplete; retrying from the next fresh observation.', this.#connectionEpoch, {
					component: 'provider', boundary: 'planning', code: String(error?.code ?? 'EMPTY_PROVIDER_TURN'), state: 'retrying',
				});
				const retryAt = safeClockRead(this.#controlNow);
				if (retryAt === null) this.#providerRetryAfter.delete(agentId);
				else this.#providerRetryAfter.set(agentId, retryAt + EMPTY_TURN_RETRY_DELAY_MS);
				return;
			}
			if (verboseRecord !== null) this.#publishVerbose(agentId, verboseRecord.goalRevision, 'error', verboseErrorMessage(error), this.#connectionEpoch, {
				component: 'coordinator', boundary: 'agent_work', code: String(error?.code ?? 'COORDINATOR_ERROR'), state: 'degraded',
			});
			this.#emitRuntimeError(error);
			if (!this.#bridge.ready || !this.#registry.has(agentId)) return;
			const record = this.#registry.get(agentId);
			try {
				await this.#sendForEpoch(connectionEpoch, 'agent_error', agentId, {
					goalRevision: record.goalRevision,
					code: sanitizeDiagnosticErrorCode(error, { fallback: 'COORDINATOR_ERROR' }),
					message: sanitizeDiagnosticErrorMessage(error, { maxBytes: 2_048 }),
				});
			} catch (reportError) {
				if (!QUIET_LIFECYCLE_ERRORS.has(reportError?.code)) this.#emitRuntimeError(reportError);
			}
		} catch (reportFailure) {
			this.#emitRuntimeError(reportFailure);
		}
	}

	#emitRuntimeError(error) {
		try { this.emit('runtimeError', error); }
		catch { /* reporting must never reject agent control work */ }
	}

	/** One agent_death row per death (death-record.mjs): the receipt, the last 10 s observed, and the plan's step. */
	#traceDeath(record, death) {
		let step = null, doing = null;
		try { step = this.#taskViews.intent(record)?.step ?? null; doing = this.#taskViews.doingLine(record); }
		catch { /* the row stands without the plan's view */ }
		this.#writeTrace('agent_death', this.#deathRecorder.record(record, death, { step, doing }));
	}

	#writeTrace(event, fields) {
		if (event === 'native_tool_dispatch_started') this.#decisionLog?.linkAction(fields);
		this.#bodyPace.note(event, fields);
		if (this.#traceWriter === null) return;
		try {
			Promise.resolve(this.#traceWriter.write(event, fields)).catch(() => {});
			if (typeof this.#traceWriter.writeDiagnostic === 'function') Promise.resolve(this.#traceWriter.writeDiagnostic(event, fields)).catch(() => {});
		} catch { /* diagnostics cannot interrupt agent control */ }
	}

	#verboseReporter(agentId, goalRevision, { allowPublicAgentMessage = false, publicActivity = true, connectionEpoch = this.#connectionEpoch } = {}) {
		let publishedAgentMessage = false, qualityMessageCaptured = false;
		const reporter = (stage, message) => {
			try {
				if (stage === 'provider_event') { this.#traceProviderEvent(agentId, goalRevision, message); return; }
				// Usage statistics and account limits are per agent and per account, independent of the goal revision.
				if (stage === 'live_allowance') {
					const allowance = JSON.parse(message);
					this.#usageLedger.recordAllowance(allowance.provider ?? this.#registry.get(agentId)?.provider, allowance);
				}
				// Billing survives a goal change or disconnect even when the public view rejects the old turn.
				if (stage === 'live_usage') {
					const value = JSON.parse(message);
					const usageRecord = this.#registry.get(agentId) ?? {};
					const usageState = this.#traceUsageSamples.get(agentId) ?? { usage: null, usageSample: null };
					this.#traceUsageSamples.set(agentId, usageState);
					const usage = nativeUsageTraceFields(value, usageState, usageRecord);
					if (Object.keys(usage).length > 0) this.#writeTrace('native_token_usage', { agentId, goalRevision, scope: 'thread_total', sessionKey: createHash('sha256').update(String(value.threadId ?? '')).digest('hex'), usageSource: 'provider', ...usage });
					if (value.call !== null && typeof value.call === 'object') this.#writeTrace('native_model_call', { agentId, goalRevision, ...modelCallTraceFields(value) });
					if (this.#registry.get(agentId) !== null) this.#usageLedger.recordUsage(this.#registry.get(agentId), value);
					// The roster in the run trace, at most once a minute: runs without a client window keep the same numbers.
					if (Date.now() - this.#lastRosterTraceAt >= 60_000) { this.#lastRosterTraceAt = Date.now(); this.#writeTrace('usage_roster', this.usageRoster()); }
				}
				const viewRecord = this.#registry.get(agentId);
				if (process.env.ARENA_QUALITY_CAPTURE === '1' && allowPublicAgentMessage && !qualityMessageCaptured && ['quality_first_message', 'agent_message'].includes(stage)) {
					qualityMessageCaptured = true;
					void this.#providerTurnRecorder?.record({ agentId, goalRevision, traceId: 'quality-first-message', provider: viewRecord?.provider, model: viewRecord?.model, output: String(message).slice(0, 8192) });
				}
				if (viewRecord !== null && viewRecord.goalRevision === goalRevision && this.#isConnectionEpochCurrent(connectionEpoch)) {
					this.#taskViews.event(viewRecord, stage, message);
				}
				// Direct replies still require say's audience and successful Minecraft receipt.
				if (!publicActivity) return;
				if (allowPublicAgentMessage && stage === 'agent_message') {
					if (publishedAgentMessage) return;
					const publicMessage = sanitizePublicAgentMessage(message);
					if (publicMessage.length === 0) return;
					publishedAgentMessage = true;
					this.#publishVerbose(agentId, goalRevision, 'decision', publicMessage, connectionEpoch);
					return;
				}
			} catch { /* verbose reporting is observational */ }
		};
		return reporter;
	}

	/** Provider stage timestamps (turn sent, steer delivered) ride the verbose channel so providers need no trace dependency. */
	#traceProviderEvent(agentId, goalRevision, message) {
		let value;
		try { value = JSON.parse(message); } catch { return; }
		if (typeof value?.event !== 'string' || (!value.event.startsWith('native_provider_') && value.event !== 'native_tool_rejected')) return;
		const { event, ...fields } = value;
		this.#writeTrace(event, { agentId, goalRevision, ...fields });
	}

	#publishVerbose(agentId, goalRevision, stage, message, connectionEpoch = this.#connectionEpoch, transition = {}) {
		try {
			const viewRecord = this.#registry.get(agentId);
			if (viewRecord !== null && viewRecord.goalRevision === goalRevision && this.#isConnectionEpochCurrent(connectionEpoch)) this.#taskViews.event(viewRecord, stage, message);
			const bounded = sanitizeVerboseMessage(stage, message);
			if (bounded.length === 0) return;
			const identity = verboseTransitionIdentity(stage, bounded, transition);
			if (!this.#verboseTransitions.accept({ agentId, goalRevision, ...identity })) return;
			this.#sendVerbose(agentId, goalRevision, stage, bounded, connectionEpoch);
		} catch { /* verbose delivery is best effort */ }
	}

	#sendVerbose(agentId, goalRevision, stage, message, connectionEpoch) {
		if (stage !== 'decision' || !this.#isConnectionEpochCurrent(connectionEpoch) || !this.#bridge.ready || !VERBOSE_STAGES.includes(stage)) return;
		const current = this.#registry.get(agentId);
		if (current === null || current.goalRevision !== goalRevision || message.length === 0 || message.length > MAX_VERBOSE_MESSAGE_LENGTH) return;
		Promise.resolve(this.#sendForEpoch(connectionEpoch, 'verbose_event', agentId, { goalRevision, stage, message })).catch(() => {});
	}

	async #publishFullCatalog(connectionEpoch) {
		try {
			const catalog = await this.#codexService.catalog.refresh();
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			if (catalog.models.length === 0) {
				// With no provider to discover there is no recovery record and nothing to report.
				if (catalog.recovery != null) logCatalogGap('returned no models', catalog.recovery);
				return;
			}
			await this.#publishCatalog(catalog, connectionEpoch);
		} catch (error) {
			// The bridge keeps its current catalog and still retries discovery when empty.
			logCatalogGap('failed', error?.message);
		}
	}

	async #publishCatalog(snapshot, connectionEpoch = this.#connectionEpoch) {
		this.#lastCatalog = snapshot;
		for (const model of snapshot.models) registerDiscoveredPrice(model.provider ?? 'codex', model.id, { free: model.free === true, listPrice: model.listPrice ?? null });
		const providers = this.#providerDiscovery.rows(snapshot.models, this.#usageLedger.limitSummaries());
		// Only what this machine can run is offered: a provider whose CLI is missing or signed out lists no models.
		const usable = new Set(providers.filter((row) => row.installed !== false && row.signedIn !== false).map((row) => row.id));
		await this.#sendForEpoch(connectionEpoch, 'catalog_snapshot', 'server', {
			refreshedAtEpochMs: snapshot.refreshedAtEpochMs,
			// Discovery metadata travels in the providers rows; the model entries keep their wire shape.
			models: snapshot.models.filter((model) => usable.has(model.provider ?? 'codex'))
				.map(({ free, listPrice, isDefault, defaultReasoningEffort, ...wire }) => wire),
			providers,
		});
	}

	/** A finished discovery scan: account identity and Codex limits reach the usage ledger; Minecraft gets fresh rows. */
	#acceptDiscovery(state) {
		for (const [provider, account] of Object.entries(state.accounts ?? {})) {
			if (account === null) continue;
			this.#usageLedger.setAccount(provider, account);
			if (account.rateLimits) this.#usageLedger.recordAllowance(provider, account.rateLimits);
		}
		this.#usageLedger.evaluateAll();
		if (this.#lastCatalog !== null && this.#bridge.ready) {
			void this.#publishCatalog(this.#lastCatalog, this.#connectionEpoch).catch(() => {});
		}
	}

	/** Every agent's usage and the account rows ride on each task view, so one request serves any window layout. */
	#taskViewWithRoster(record) {
		const view = { ...this.#taskViews.snapshot(record), decision: this.#decisionLog?.latest(record.agentId, record.goalRevision, this.#nativeRuntime.runningAction(record)) ?? null };
		const records = [...this.#supportedAgentIds].map((agentId) => this.#registry.get(agentId)).filter((entry) => entry !== null);
		if (!records.some((entry) => entry.agentId === record.agentId)) records.push(record);
		const roster = this.#usageLedger.roster(records);
		const withRoster = { ...view, roster };
		if (Buffer.byteLength(JSON.stringify(withRoster)) <= TASK_VIEW_MAX_BYTES) return withRoster;
		const trimmed = { ...view, roster: { ...roster, agents: roster.agents.filter((row) => row.agentId === record.agentId) } };
		return Buffer.byteLength(JSON.stringify(trimmed)) <= TASK_VIEW_MAX_BYTES ? trimmed : view;
	}

	/** One notice per level change, to every agent on that account, plus a console line. */
	#publishUsageWarning({ provider, level, message, agents }) {
		try { console.error(`[usage] ${provider}: ${message}`); } catch { /* console output is best effort */ }
		this.#writeTrace('usage_limit_warning', { provider, level, message });
		if (!this.#bridge.ready) return;
		const connectionEpoch = this.#connectionEpoch;
		for (const agentId of agents) {
			if (!this.#supportedAgentIds.has(agentId)) continue;
			void this.#sendForEpoch(connectionEpoch, 'agent_notice', agentId, { severity: level === 'none' ? 'info' : 'warning', code: 'USAGE_LIMIT_WARNING', message }).catch(() => {});
		}
	}

	/** The usage roster for tools and tests: every agent's usage plus the account rows. */
	usageRoster() {
		const records = [...this.#supportedAgentIds].map((agentId) => this.#registry.get(agentId)).filter((entry) => entry !== null);
		return this.#usageLedger.roster(records);
	}

	async #publishGoalCompleted({ record, goalFingerprint, traceId }, connectionEpoch = this.#connectionEpoch) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch) || !this.#bridge.ready) throw codedRuntimeError('BRIDGE_NOT_READY', 'Minecraft bridge is not ready for completion verification');
		if (!this.#supportedAgentIds.has(record.agentId)) throw codedRuntimeError('AGENT_NOT_SUPPORTED', `Agent '${record.agentId}' is not in the reconciled bridge roster`);
		const profile = {
			provider: record.provider,
			model: record.model,
			reasoningEffort: record.reasoningEffort,
			serviceTier: record.serviceTier ?? defaultServiceTier(record.provider),
		};
		try {
			await this.#sendForEpoch(connectionEpoch, 'goal_completed', record.agentId, {
				goalRevision: record.goalRevision,
				goalFingerprint,
				traceId,
				profile,
			});
		} catch (error) {
			if (isTransientCompletionSendError(error)) throw error;
			throw codedRuntimeError('COMPLETION_SEND_FAILED', 'Minecraft bridge rejected completion verification', error);
		}
	}

	async #publishStatus(connectionEpoch = this.#connectionEpoch) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch) || !this.#bridge.ready) return;
		const records = this.#registry.list();
		const readyStates = new Set([DynamicAgentState.IDLE, DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING, DynamicAgentState.PAUSED, DynamicAgentState.COMPLETED]);
		const profiles = records.filter((record) => this.#supportedAgentIds.has(record.agentId));
		const healthIdentities = profiles.flatMap((profile) => ['create_agent', this.#usesNativeTools(profile) ? 'native_turn' : 'decide'].map((operation) => ({
			provider: profile.provider,
			model: profile.model,
			profileFingerprint: profileFingerprint(profile),
			operation,
		})));
		// The wire contract has one row per provider/model/operation. Publish the
		// least healthy profile's complete snapshot, retaining truthful quantiles
		// instead of averaging percentiles or masking an open profile circuit.
		const healthByOperation = new Map();
		const circuitRank = { closed: 0, half_open: 1, open: 2 };
		for (const identity of healthIdentities) {
			const snapshot = this.#healthRegistry.snapshot(identity);
			const key = JSON.stringify([identity.provider, identity.model, identity.operation]);
			const previous = healthByOperation.get(key);
			if (previous === undefined || circuitRank[snapshot.circuit] > circuitRank[previous.circuit]
				|| (snapshot.circuit === previous.circuit && (snapshot.failureRate > previous.failureRate
					|| (snapshot.failureRate === previous.failureRate && snapshot.count > previous.count)))) healthByOperation.set(key, snapshot);
		}
		const healthSnapshots = [...healthByOperation.values()].sort((left, right) => left.provider.localeCompare(right.provider)
			|| left.model.localeCompare(right.model) || left.operation.localeCompare(right.operation));
		const pressure = this.#scheduler.pressureSnapshot;
		let providerRecovery = [];
		try { providerRecovery = this.#codexService.recoverySnapshot?.() ?? []; }
		catch { /* optional status must not affect coordinator control */ }
		const components = providerRecoveryComponents(providerRecovery);
		try {
			const diagnostics = this.#traceWriter?.statusSnapshot?.();
			if (diagnostics !== null && diagnostics !== undefined) components.push(diagnostics);
		} catch { /* optional status must not affect coordinator control */ }
		try {
			const providerAudit = this.#providerTurnRecorder?.statusSnapshot?.();
			if (providerAudit !== null && providerAudit !== undefined) components.push(providerAudit);
		} catch { /* optional status must not affect coordinator control */ }
		await this.#sendForEpoch(connectionEpoch, 'coordinator_status', 'server', buildCoordinatorStatus({
			reconciled: this.#reconciledStatus,
			records,
			supportedAgentIds: this.#supportedAgentIds,
			readyStates,
			pressure: {
				active: pressure.active,
				pending: pressure.pending,
				maxConcurrent: pressure.maxConcurrent,
				maxPending: pressure.maxPending,
				warning: pressure.warning,
				mode: pressure.mode,
				configuredTarget: pressure.configuredTarget,
				target: pressure.target,
				minConcurrency: pressure.minConcurrency,
				maxConcurrency: pressure.maxConcurrency,
				urgentReserve: pressure.urgentReserve,
				ordinaryActiveLimit: pressure.ordinaryActiveLimit,
				activeOrdinary: pressure.activeOrdinary,
				activeUrgent: pressure.activeUrgent,
				pendingOrdinary: pressure.pendingOrdinary,
				pendingUrgent: pressure.pendingUrgent,
				growthCount: pressure.growthCount,
				backoffCount: pressure.backoffCount,
				lastChangeReason: pressure.lastChangeReason,
				healthyCompletions: pressure.healthyCompletions,
				ordinaryReservationRejections: pressure.ordinaryReservationRejections,
				urgentReservationRejections: pressure.urgentReservationRejections,
			},
			healthSnapshots: healthSnapshots.slice(0, 32),
			latencies: this.#latencyRegistry.snapshot(),
			bridgeSessionEpoch: connectionEpoch,
			runtimeGeneration: this.#runtimeGeneration,
			components,
		}));
	}

	#ledger(agentId) {
		let ledger = this.#factLedgers.get(agentId);
		if (ledger === undefined) {
			ledger = new FactLedger();
			this.#factLedgers.set(agentId, ledger);
		}
		return ledger;
	}

	#plannerContext(agentId) {
		const ledger = this.#ledger(agentId);
		const memory = this.#conversationMemory(agentId);
		const cursor = this.#contextCursors.get(agentId);
		const record = this.#registry.get(agentId);
		if (record === null || this.#serverInstanceId === null) {
			return {
				untrustedFacts: ledger.toPlannerFacts(),
				conversationContext: memory.toPlannerContext(),
				taskMemory: record === null ? null : this.#playerMemory.peekTaskContext(record),
			};
		}
		const binding = this.#contextBinding(record);
		return {
			factLedger: ledger,
			taskMemory: this.#playerMemory.peekTaskContext(record),
			conversationMemory: memory,
			contextCursor: cursor,
			contextBinding: binding,
			cursorBinding: cursor,
		};
	}

	#contextBinding(record) {
		const session = typeof this.#codexService.getAgent === 'function'
			? this.#codexService.getAgent(record.agentId)
			: null;
		let metadata = null;
		try { metadata = session?.sessionMetadata?.() ?? null; } catch { metadata = null; }
		const selectedProfile = {
			agentId: record.agentId,
			provider: record.provider,
			model: record.model,
			reasoningEffort: record.reasoningEffort,
			serviceTier: record.serviceTier ?? defaultServiceTier(record.provider),
		};
		const sessionFingerprint = metadata?.profileFingerprint ?? session?.profileFingerprint;
		const resolvedFingerprint = typeof sessionFingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(sessionFingerprint)
			? sessionFingerprint
			: profileFingerprint(selectedProfile);
		const sessionGeneration = metadata?.sessionGeneration ?? session?.sessionGeneration;
		return {
			agentId: record.agentId,
			profileFingerprint: resolvedFingerprint,
			sessionGeneration: Number.isSafeInteger(sessionGeneration) && sessionGeneration >= 1 ? sessionGeneration : 1,
			goalRevision: record.goalRevision,
			serverInstanceId: this.#serverInstanceId,
		};
	}

	#contextSnapshot(record) {
		return {
			factRevision: this.#ledger(record.agentId).delta(null).nextRevision,
			conversationSequence: this.#conversationMemory(record.agentId).delta(null).nextSequence,
		};
	}

	#rememberAcceptedContextCursor(record, snapshot = null) {
		if (this.#serverInstanceId === null) return;
		const binding = this.#contextBinding(record);
		// Accept only the exact delivered session/server/goal and captured revisions.
		if (snapshot == null || !contextCursorMatches(snapshot, binding)) return;
		const revisions = snapshot;
		const value = {
			...binding,
			factRevision: revisions.factRevision,
			conversationSequence: revisions.conversationSequence,
			providerAccepted: true,
		};
		const previous = this.#contextCursors.get(record.agentId);
		try {
			this.#contextCursors.set(record.agentId, previous === undefined ? createContextCursor(value) : advanceContextCursor(previous, value));
		} catch {
			// A replacement provider session starts from a full current baseline.
			this.#contextCursors.set(record.agentId, createContextCursor(value));
		}
		// The provider accepted an input that carried exactly these conversation messages.
		const sequences = Array.isArray(snapshot.deliveredConversationSequences) ? snapshot.deliveredConversationSequences.filter(Number.isSafeInteger) : [];
		if (sequences.length > 0) this.emit('conversationProcessed', { agentId: record.agentId, goalRevision: binding.goalRevision, sequences: [...sequences] });
	}

	#invalidateServerInstance(connectionEpoch) {
		this.#cancelGoalSpecRequests();
		this.#settleTaskRequests(undefined, 'BRIDGE_DISCONNECTED', 'Minecraft restarted before answering.');
		this.#healthRegistry.reset();
		this.#factLedgers.clear();
		this.#conversationMemories.clear();
		this.#contextCursors.clear();
		for (const inbox of this.#pendingConversationInboxes.values()) inbox.fence();
		this.#nativeConversationRecoveries.clear();
		this.#nativeObservationSignatures.clear();
		this.#hazardContacts.clear();
		this.#survivalRestartAt.clear();
		this.#survivalQuietSince.clear();
		this.#nativeWorldSignals.clear();
		this.#nativeConfirmationWaits.clear();
		this.#supervisedObservationRequests.clear();
		this.#conversationWakeTransactions.clear();
		this.#providerWork.clear();
		this.#providerProbeDeadlines.clear();
		this.#deferredProviderRecovery.clear();
		this.#programRuntimeEpochs.clear();
		this.#nativeRuntimeEpochs.clear();
		for (const record of this.#registry.list()) {
			this.#goalSupervisor.terminate(this.#supervisionKey(record));
			this.#advanceLifecycleGeneration(record.agentId);
			this.#programRuntime.dispose(record.agentId);
			void this.#nativeRuntime.dispose(record.agentId, 'server_replaced');
			this.#pendingAttention.delete(record.agentId);
			this.#attentionFlushes.delete(record.agentId);
			this.#providerRetryAfter.delete(record.agentId);
			try {
				Promise.resolve(this.#planner.interrupt(record.agentId, 'Minecraft server instance changed'))
					.catch((error) => this.#reportAgentError(record.agentId, error, connectionEpoch));
			} catch (error) {
				void this.#reportAgentError(record.agentId, error, connectionEpoch);
			}
		}
	}

	#goalSpecRequestKey(agentId, requestId) {
		return `${this.#serverInstanceId ?? 'disconnected'}\u0000${agentId}\u0000${requestId}`;
	}

	async #processGoalSpecRequest(key, entry) {
		if (this.#goalSpecRequests.get(key) !== entry || this.#serverInstanceId === null
				|| !this.#isConnectionEpochCurrent(entry.connectionEpoch) || entry.translating) return;
		if (entry.retryHandle !== null) {
			this.#clearGoalSpecTimeout(entry.retryHandle);
			entry.retryHandle = null;
		}
		if (entry.proposal !== null) {
			try {
				await this.#sendForEpoch(entry.connectionEpoch, 'goal_spec_proposal', entry.agentId, entry.proposal);
			} catch (error) {
				if (this.#goalSpecRequests.get(key) === entry) this.#emitRuntimeError(error);
			}
			if (this.#goalSpecRequests.get(key) === entry) this.#scheduleGoalSpecRequest(key, entry, GOAL_SPEC_PROPOSAL_RETRY_MS);
			return;
		}
		entry.translating = true;
		try {
			await this.#reconciliation;
			if (this.#goalSpecRequests.get(key) !== entry || this.#serverInstanceId === null
					|| !this.#isConnectionEpochCurrent(entry.connectionEpoch)) return;
			entry.proposal = await this.#planner.requestGoalSpec({
				agentId: entry.agentId,
				request: entry.request,
				...(entry.correctiveFeedback === null ? {} : { correctiveFeedback: entry.correctiveFeedback }),
			});
			if (entry.proposal.plan !== undefined) {
				this.#taskViews.suggest(entry.agentId, entry.request.originalRequest, entry.proposal.plan);
				const { plan, ...wireProposal } = entry.proposal;
				entry.proposal = wireProposal;
			}
			entry.attempts = 0;
		} catch (error) {
			if (this.#goalSpecRequests.get(key) !== entry) return;
			this.#emitRuntimeError(error);
			if (error?.code === 'STRICT_SPEND_AUXILIARY_DISABLED') {
				this.#forgetGoalSpecRequest(key, entry);
				await this.#reportAgentError(entry.agentId, error, entry.connectionEpoch);
				return;
			}
			const localFeedback = localGoalSpecFeedback(error, entry.rejectionAttempts + 1);
			if (localFeedback !== null) {
				entry.rejectionAttempts += 1;
				entry.correctiveFeedback = localFeedback;
				entry.proposal = null;
				if (entry.rejectionAttempts > MAX_GOAL_SPEC_CORRECTION_ATTEMPTS && (entry.serverRejected || fallbackCompiledDragonGoal(entry.request) === null)) {
					this.#forgetGoalSpecRequest(key, entry);
					await this.#reportAgentError(entry.agentId, codedRuntimeError('GOAL_SPEC_TRANSLATION_REJECTED',
						`Goal translation failed validation after ${entry.rejectionAttempts} proposals (${localFeedback.reasonCode}); the pending draft requires operator correction or cancellation`), entry.connectionEpoch);
					return;
				}
				if (entry.rejectionAttempts <= MAX_GOAL_SPEC_CORRECTION_ATTEMPTS) {
					this.#scheduleGoalSpecRequest(key, entry, Math.min(GOAL_SPEC_RETRY_MAX_MS, GOAL_SPEC_RETRY_BASE_MS * (2 ** (entry.rejectionAttempts - 1))));
					return;
				}
			}
			// Only an exact, server-constrained dragon goal may proceed when its
			// optional Luna advice is unavailable. Other translations keep retrying.
			if (!entry.serverRejected) {
				entry.proposal = fallbackCompiledDragonGoal(entry.request);
			}
			if (entry.proposal === null) {
				entry.attempts += 1;
				const delay = Math.min(GOAL_SPEC_RETRY_MAX_MS, GOAL_SPEC_RETRY_BASE_MS * (2 ** Math.min(entry.attempts - 1, 5)));
				this.#scheduleGoalSpecRequest(key, entry, delay);
				return;
			}
		} finally {
			entry.translating = false;
		}
		if (this.#goalSpecRequests.get(key) === entry) await this.#processGoalSpecRequest(key, entry);
	}

	#scheduleGoalSpecRequest(key, entry, delayMs) {
		if (entry.retryHandle !== null) this.#clearGoalSpecTimeout(entry.retryHandle);
		entry.retryHandle = this.#setGoalSpecTimeout(() => {
			entry.retryHandle = null;
			this.#run(() => this.#processGoalSpecRequest(key, entry), entry.connectionEpoch);
		}, delayMs);
	}

	#forgetGoalSpecRequest(key, entry) {
		if (this.#goalSpecRequests.get(key) !== entry) return;
		this.#goalSpecRequests.delete(key);
		if (entry.retryHandle !== null) this.#clearGoalSpecTimeout(entry.retryHandle);
		try { this.#planner.cancelGoalSpec?.(entry.agentId, entry.requestId); } catch { /* cancellation is best effort */ }
		entry.releaseCapacity();
		entry.resolveCompletion();
	}

	#cancelGoalSpecRequests(agentId = null) {
		for (const [key, request] of this.#goalSpecRequests) {
			if (agentId !== null && request.agentId !== agentId) continue;
			this.#goalSpecRequests.delete(key);
			if (request.retryHandle !== null) this.#clearGoalSpecTimeout(request.retryHandle);
			try { this.#planner.cancelGoalSpec?.(request.agentId, request.requestId); } catch { /* cancellation is best effort */ }
			request.releaseCapacity();
			request.resolveCompletion();
		}
	}

	#conversationMemory(agentId) {
		let memory = this.#conversationMemories.get(agentId);
		if (memory === undefined) {
			memory = new ConversationMemory();
			this.#conversationMemories.set(agentId, memory);
		}
		return memory;
	}

	#pendingConversationInbox(agentId) {
		let inbox = this.#pendingConversationInboxes.get(agentId);
		if (!inbox) {
			inbox = new PendingConversationInbox({ directory: this.#memoryDirectory, agentId });
			this.#pendingConversationInboxes.set(agentId, inbox);
		}
		return inbox;
	}

	async #admitConversation(agentId, event, connectionEpoch, wake = null) {
		const record = this.#registry.get(agentId);
		const ingested = this.#usesNativeTools(record)
			? await this.#pendingConversationInbox(agentId).append(this.#serverInstanceId, event, wake)
			: true;
		// A retry can find a durable append whose original caller saw an I/O failure.
		const retryPending = this.#usesNativeTools(record) && !ingested
			? await this.#pendingConversationInbox(agentId).needsDelivery(event.sequence) : false;
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) throw Object.assign(new Error('Conversation admission belongs to an obsolete connection'), { code: 'STALE_PLAN' });
		if (this.#usesNativeTools(record) && !ingested) return retryPending;
		const historyIngested = this.#conversationMemory(agentId).ingest(event);
		return this.#usesNativeTools(record) ? ingested : historyIngested;
	}

	async #nativeTurnInput(record, request, { deliverConversation = true, freshObservation = false } = {}) {
		if (request.nativeEvent === undefined) return request.input;
		const taskMemory = request.nativeEvent.event === 'program_planning_due' ? null : await this.#playerMemory.taskContext(record);
		const isCurrent = () => this.#registry.get(record.agentId)?.goalRevision === record.goalRevision
			&& this.#isConnectionEpochCurrent(request.connectionEpoch)
			&& this.#isLifecycleGenerationCurrent(record.agentId, request.lifecycleGeneration);
		if (!isCurrent()) throw Object.assign(new Error('Native input belongs to an obsolete lifecycle'), { code: 'STALE_PLAN' });
		this.#settleMovementLoopDelivery(request, false);
		this.#settleFailureDelivery(request, false);
		delete request.nativeConversationDelivery;
		request.deliveredPlayerRequests = [];
		const inbox = this.#pendingConversationInbox(record.agentId);
		await inbox.open(this.#serverInstanceId);
		if (!isCurrent()) throw Object.assign(new Error('Native input belongs to an obsolete lifecycle'), { code: 'STALE_PLAN' });
		const reservation = deliverConversation ? await inbox.reserve() : null;
		if (reservation) request.nativeConversationDelivery = { inbox, token: reservation.token, omittedEntries: 0 };
		try {
			if (!isCurrent()) throw Object.assign(new Error('Native input belongs to an obsolete lifecycle'), { code: 'STALE_PLAN' });
			const program = this.#nativeRuntime.programSnapshot(record, { presentDecision: true });
			const pendingProgram = program?.decision == null ? null : program;
			const latest = freshObservation || pendingProgram !== null || request.nativeEvent.status?.decision != null
				? this.#nativeRuntime.latestObservation(record) : null;
			// Observation wakes carry their sequence on the request, not the envelope.
			const triggeringSequence = request.nativeEvent.eventSequence ?? request.eventSequence;
			const refreshed = latest !== null && latest.eventSequence !== triggeringSequence;
			const owed = refreshed ? owedWakeEvents(request) : [];
			// The fresh observation is the current snapshot; a protected trigger's own facts travel as history.
			let nativeEvent = latest === null ? request.nativeEvent : {
				...request.nativeEvent, eventSequence: latest.eventSequence, observation: latest.observation,
				...(owed.length === 0 ? {} : { mergedEvents: owed }),
			};
			// Any wake can interrupt a decision. Keep the live handle and choices beside its fresh facts.
			if (pendingProgram !== null) {
				const historical = nativeEvent.programId !== undefined && nativeEvent.programId !== pendingProgram.programId;
				const history = historical ? owedWakeEvents(request) : [];
				const { result, ...current } = nativeEvent;
				nativeEvent = { ...current, programId: pendingProgram.programId, status: { ...pendingProgram,
					decision: { ...pendingProgram.decision, request: 'Call respondProgram before ending this turn: use this programId, goalRevision, decisionId, eventSequence and a listed directive; replace also needs source. Choose from the fresh facts.' } },
					...(!historical && result !== undefined ? { result } : {}),
					...(historical ? { event: 'program_attention', trigger: pendingProgram.decision.trigger,
						mergedEvents: history.length > 0 ? history : [{ ...nativeEvent, mergedEvents: undefined }] } : {}) };
			} else if (nativeEvent.status?.decision != null) {
				// Delivery can wait behind task-memory I/O while the model answers or the program ends.
				nativeEvent = { ...nativeEvent, status: program?.programId === nativeEvent.programId ? program : undefined };
			}
			// A failed last result is owed until the provider accepts this input, like the conversation reserved above.
			const failureReservation = {};
			const observation = this.#nativeRuntime.decorateObservation(record, nativeEvent.observation ?? {}, { reservation: failureReservation });
			if (failureReservation.failure !== undefined) request.failureDelivery = failureReservation.failure;
			if (failureReservation.steer !== undefined) request.failureSteer = failureReservation.steer;
			const loopState = this.#nativeWorldSignals.get(record.agentId);
			// Advisories have no delivery ownership. Leave loop facts for an observation-validated body event.
			const movementLoop = nativeEvent.event !== 'program_planning_due' && loopState?.movementLoopDue === true
				&& loopState.movementLoopValidatedVersion === loopState.movementLoopVersion
				&& loopState.movementLoopDelivery?.version !== loopState.movementLoopVersion;
			const isPlanning = nativeEvent.event === 'program_planning_due';
			const reflexRules = this.#nativeRuntime.reflexRules(record);
			const uncovered = isPlanning ? [] : uncoveredDangers(observation, reflexRules);
			const contextsOwed = !isPlanning && this.#contextTracker(record.agentId).owed();
			const { changed, strategy } = this.#situationChangeLine(record, request, nativeEvent, observation, uncovered, contextsOwed);
			const contexts = isPlanning ? null : this.#contextEntryLine(record, request, observation, reflexRules);
			const continuity = this.#taskViews.continuity(record, { observation, guardInstalled: this.#nativeRuntime.hasStandingGuard(record), guardCoverage: this.#nativeRuntime.standingGuardCoverage(record) });
			const guardOutcome = this.#nativeRuntime.guardFeedback(record);
			// Reflex rules the model armed and what fired since its last wake.
			const reflexes = this.#nativeRuntime.reflexReport(record);
			// Facts the wake filter held while the model's action ran (hits absorbed, items gained, routine updates).
			const whileActing = this.#wakeFilter.take(record.agentId, observation);
			const pace = continuity === null ? null : this.#bodyPace.line(record.agentId);
			const input = buildNativeEventInput(record, {
				...nativeEvent, movementLoop, taskMemory, progress: this.#taskViews.progress(record), goalNow: this.#taskViews.goalLine(record), doing: this.#taskViews.doingLine(record), skillFits: this.#taskViews.skillLine?.(record) ?? null,
				continuity: guardOutcome || reflexes || pace || whileActing ? { ...continuity, ...(guardOutcome ? { guardOutcome } : {}), ...(reflexes ? { reflexes } : {}), ...(whileActing ? { whileActing } : {}), ...(pace ? { pace } : {}) } : continuity, dangerSummary: request.dangerSummary,
				awaitingConfirmation: this.#awaitingNativeConfirmation(record, request.lifecycleGeneration),
				confirmationFacts: this.#nativeConfirmationWaits.get(record.agentId)?.facts ?? null,
				observation, actionReceipt: request.nativeEvent.observation?.lastResult, newContext: this.#pendingAssessment(record, request, nativeEvent, observation), changed, strategy, contexts, uncovered,
				runningActionStart: this.#runningActions.get(record.agentId) ?? null, runningAction: this.#nativeRuntime.runningAction(record),
				conversation: reservation?.conversation ?? { mode: 'unread', baseSequence: null, nextSequence: -1, entries: [] },
			});
			const builtPayload = JSON.parse(input.slice(input.indexOf('\n') + 1));
			request.survivalFacts = builtPayload;
			this.#noteAssessmentBuilt(record, request, input, builtPayload);
			if (movementLoop && (builtPayload.movementLoop === true || builtPayload.trigger === 'movement_loop')) {
				loopState.movementLoopDelivery = { version: loopState.movementLoopVersion };
				request.movementLoopDelivery = { state: loopState, delivery: loopState.movementLoopDelivery };
			}
			const contextTrimmed = builtPayload.contextTrimmed;
			if (contextTrimmed !== undefined) {
				this.#writeTrace('native_event_context_trimmed', { agentId: record.agentId, goalRevision: record.goalRevision, fields: contextTrimmed });
			}
			if (reservation) {
				const delivered = builtPayload.conversation;
				inbox.trim(reservation.token, delivered.entries.length);
				// takeTask may only credit a player whose message this turn actually delivered.
				request.deliveredPlayerRequests = delivered.entries
					.filter((entry) => ((entry.kind === 'player_message' && entry.scope === 'direct')
						|| (entry.kind === 'proximity_speech' && entry.scope === 'proximity')) && UUID_TEXT.test(entry.sourceId ?? ''))
					.map((entry) => ({ sequence: entry.sequence, sourceId: entry.sourceId.toLowerCase(), operator: entry.operator === true, text: entry.text }));
				request.nativeConversationDelivery.omittedEntries = delivered.omittedEntries + (reservation.more ? 1 : 0);
				request.nativeConversationDelivery.sequences = delivered.entries.map((entry) => entry.sequence).filter(Number.isSafeInteger);
			}
			return request.retryInstruction === undefined ? input : `${input}\n${request.retryInstruction}`;
		} catch (error) { this.#restoreNativeConversation(request); throw error; }
	}

	#assessmentContext(record) {
		let context = this.#eventContexts.get(record.agentId);
		if (context?.goalRevision !== record.goalRevision) {
			// A respawn often reaches the model as a new revision (respawn, disconnect, resume); the death's unread
			// assessment carries over so the first live call still re-reads the situation, delivered once.
			const carried = context?.pending > 0 ? 1 : 0;
			context = { goalRevision: record.goalRevision, dimension: context?.dimension ?? null, generation: carried, pending: carried, inFlight: null };
			this.#eventContexts.set(record.agentId, context);
		}
		return context;
	}

	/**
	 * Whether this event should ask the model to re-read where it is: a goal start, a death or respawn, or a dimension
	 * different from the last event built. The need stays pending through advisories, danger or confirmation events
	 * and failed deliveries, and is not repeated while one delivery that carries it is still in flight.
	 */
	#pendingAssessment(record, request, nativeEvent, observation) {
		const context = this.#assessmentContext(record);
		const raise = () => { context.generation += 1; context.pending = context.generation; };
		const dimension = observation?.world?.dimension ?? null;
		if (dimension !== null) {
			if (context.dimension !== null && dimension !== context.dimension) raise();
			context.dimension = dimension;
		}
		const died = nativeEvent?.event === 'player_death';
		if (died || NEW_CONTEXT_TRIGGERS.has(nativeEvent?.trigger)) raise();
		if (died || context.pending === 0) return false;
		const inFlight = context.inFlight;
		return !(inFlight?.generation === context.pending && this.#isLifecycleGenerationCurrent(record.agentId, inFlight.lifecycleGeneration)
			&& this.#isConnectionEpochCurrent(inFlight.connectionEpoch));
	}

	/**
	 * The changed line for this wake. It only rides on wakes that already happen; advisories have no delivery
	 * ownership, so they neither carry nor consume it.
	 */
	#situationChangeLine(record, request, nativeEvent, observation, uncovered = [], contextsOwed = false) {
		this.#settleSituationChange(request, false);
		if (nativeEvent?.event === 'program_planning_due') return { changed: null, strategy: null };
		let tracker = this.#situationChanges.get(record.agentId);
		if (tracker === undefined) {
			tracker = new SituationChangeTracker();
			this.#situationChanges.set(record.agentId, tracker);
		}
		const trigger = nativeEvent?.status?.decision?.trigger ?? nativeEvent?.trigger;
		const { text, strategy, token } = tracker.line(observation, {
			at: Date.now(), event: nativeEvent?.event, trigger: nativeEvent?.trigger,
			// Danger and low-health wakes already report the health they lost, and lava contact has its own instruction.
			hpReported: request.dangerSummary != null || DANGER_DECISION_TRIGGERS.has(trigger) || HEALING_EVENT_TRIGGERS.has(trigger),
			// The same rule buildNativeEventInput uses to attach the healing section, which states natural regeneration.
			healingReported: nativeEvent?.healing != null || HEALING_EVENT_TRIGGERS.has(trigger) || trigger === 'damage' && burnFacts(observation?.player) !== null,
			lavaReported: inHazardContact(observation?.player),
			strategyTopic: strategyReference.situationStrategyTopic?.(observation) ?? null,
			// Danger wakes carry the uncovered dangers in their own field; the line names a change of them on other wakes.
			uncovered, uncoveredReported: contextsOwed || DANGER_DECISION_TRIGGERS.has(trigger) || trigger === 'low_health',
		});
		request.situationChangeDelivery = { tracker, token };
		return { changed: text, strategy };
	}

	#trackRunningAction(agentId, observation) {
		const action = observation?.currentAction;
		if (action === undefined) return;
		if (action?.active !== true) { this.#runningActions.delete(agentId); return; }
		if (this.#runningActions.get(agentId)?.actionId === action.actionId) return;
		this.#runningActions.set(agentId, { actionId: action.actionId, health: observation.player?.health });
	}

	#contextTracker(agentId) {
		let tracker = this.#contextEntries.get(agentId);
		if (tracker === undefined) {
			tracker = new ContextEntryTracker();
			this.#contextEntries.set(agentId, tracker);
		}
		return tracker;
	}

	/** The owed context entries for this wake, settled with the situation line (delivered or kept owed). */
	#contextEntryLine(record, request, observation, rules) {
		const tracker = this.#contextTracker(record.agentId);
		if (!tracker.owed()) return null;
		const { value, token } = tracker.line(observation, rules);
		request.contextEntryDelivery = { tracker, token };
		return value;
	}

	#settleSituationChange(request, delivered) {
		const entries = request?.contextEntryDelivery;
		if (entries !== undefined) {
			delete request.contextEntryDelivery;
			entries.tracker.settle(entries.token, delivered);
		}
		const delivery = request?.situationChangeDelivery;
		if (delivery === undefined) return;
		delete request.situationChangeDelivery;
		delivery.tracker.settle(delivery.token, delivered);
	}

	/** Records which pending assessment this built input carries, so only its successful delivery clears it. */
	#noteAssessmentBuilt(record, request, input, payload) {
		delete request.assessmentDelivery;
		const context = this.#eventContexts.get(record.agentId);
		if (context?.goalRevision !== record.goalRevision || context.pending === 0) return;
		if (!isNewContextEventInput(input) || typeof payload.situation !== 'string') return;
		context.inFlight = { generation: context.pending, lifecycleGeneration: request.lifecycleGeneration, connectionEpoch: request.connectionEpoch };
		request.assessmentDelivery = { agentId: record.agentId, goalRevision: record.goalRevision, generation: context.pending };
	}

	#settleAssessmentDelivery(request, delivered) {
		const delivery = request?.assessmentDelivery;
		if (delivery === undefined) return;
		delete request.assessmentDelivery;
		const context = this.#eventContexts.get(delivery.agentId);
		if (context?.goalRevision !== delivery.goalRevision) return;
		if (context.inFlight?.generation === delivery.generation) context.inFlight = null;
		// A newer death or dimension change raised since this input was built still needs its own delivery.
		if (delivered && context.pending === delivery.generation) context.pending = 0;
	}

	// Like unread conversation, a loop fact remains owed through rejected or superseded delivery.
	#settleMovementLoopDelivery(request, delivered) {
		const pending = request?.movementLoopDelivery;
		if (pending === undefined) return;
		delete request.movementLoopDelivery;
		const { state, delivery } = pending;
		if (state.movementLoopDelivery === delivery) state.movementLoopDelivery = null;
		if (delivered && state.movementLoopVersion === delivery.version) state.movementLoopDue = false;
	}

	#settleFailureDelivery(request, delivered) {
		const steer = request?.failureSteer;
		if (steer !== undefined) {
			delete request.failureSteer;
			this.#nativeRuntime.settleFailureSteer(steer, delivered);
		}
		const token = request?.failureDelivery;
		if (token === undefined) return;
		delete request.failureDelivery;
		this.#nativeRuntime.settleFailureDelivery(token, delivered);
	}

	async #commitNativeConversation(request) {
		const delivery = request?.nativeConversationDelivery;
		if (delivery?.token) {
			await delivery.inbox.commit(delivery.token);
			delete delivery.token;
			// The provider accepted the turn that delivered exactly these messages.
			if (delivery.sequences?.length > 0) {
				this.emit('conversationProcessed', { agentId: request.agentId, goalRevision: request.goalRevision, sequences: [...delivery.sequences] });
			}
		}
		this.#settleAssessmentDelivery(request, true);
		this.#settleSituationChange(request, true);
		this.#settleMovementLoopDelivery(request, true);
		this.#settleFailureDelivery(request, true);
	}

	#restoreNativeConversation(request) {
		const delivery = request?.nativeConversationDelivery;
		if (delivery?.token) delivery.inbox.rollback(delivery.token);
		if (request) delete request.nativeConversationDelivery;
		this.#settleAssessmentDelivery(request, false);
		this.#settleSituationChange(request, false);
		this.#settleMovementLoopDelivery(request, false);
		this.#settleFailureDelivery(request, false);
	}

	#forgetNativeConversationRecovery(supervisionKey) {
		const recovery = this.#nativeConversationRecoveries.get(supervisionKey.agentId);
		if (recovery !== undefined && sameSupervisionKey(recovery.supervisionKey, supervisionKey)) {
			this.#nativeConversationRecoveries.delete(supervisionKey.agentId);
		}
	}

	#rememberConversationWake(transactionId, agentId, fingerprint) {
		this.#forgetConversationWakes(agentId);
		this.#conversationWakeTransactions.set(transactionId, { agentId, fingerprint });
		while (this.#conversationWakeTransactions.size > MAX_CONVERSATION_WAKE_TRANSACTIONS) {
			this.#conversationWakeTransactions.delete(this.#conversationWakeTransactions.keys().next().value);
		}
	}

	#forgetConversationWakes(agentId) {
		for (const [transactionId, transaction] of this.#conversationWakeTransactions) {
			if (transaction.agentId === agentId) this.#conversationWakeTransactions.delete(transactionId);
		}
	}

}

export function createDynamicCoordinator(configValue, dependencies = {}) {
	const decisionLog = dependencies.decisionLog ?? null;
	const originalTurnRecorder = dependencies.providerTurnRecorder ?? null;
	const providerTurnRecorder = decisionLog === null ? originalTurnRecorder : {
		record(fields) { originalTurnRecorder?.record(fields); decisionLog.record(fields); },
		async close() { await originalTurnRecorder?.close(); await decisionLog.close(); },
	};
	const coordinatorEnvironment = dependencies.env ?? process.env;
	const strictSpendGate = strictSpendRuntime(coordinatorEnvironment);
	const config = normalizeDynamicConfig(configValue, coordinatorEnvironment);
	rememberCredential(coordinatorEnvironment[config.bridge.secretEnvironmentVariable]);
	rememberCredential(config.bridge.secret);
	rememberCredential(coordinatorEnvironment.ARENA_AGENT_VOICE_SECRET);
	const providerEnvironments = Object.fromEntries(PROVIDER_IDS.map((provider) => [
		provider,
		createProviderChildEnvironment(provider, coordinatorEnvironment, config.bridge.secretEnvironmentVariable,
			config.voice.provider === 'openai' ? { speechApiKeyEnvironmentVariable: config.voice.openaiApiKeyEnvironmentVariable } : {}),
	]));
	const registry = dependencies.registry ?? new AgentRegistry({
		agentCap: config.limits.agentCap,
		queueCap: config.limits.goalQueueCap,
		now: dependencies.now ?? Date.now,
	});
	const scheduler = dependencies.scheduler ?? new PlanningScheduler({
		maxConcurrent: config.limits.planningConcurrency,
		maxPending: Math.max(0, config.limits.agentCap - config.limits.planningConcurrency),
		planningMode: config.limits.planningMode,
		minConcurrency: 4,
		maxConcurrency: config.limits.agentCap,
		urgentReserve: config.limits.urgentReserve,
		onPressure: (snapshot) => dependencies.onSchedulerPressure?.(snapshot),
		benchmarkRecorder: dependencies.benchmarkRecorder,
	});
	const workspaceManager = dependencies.workspaceManager ?? new AgentWorkspaceManager(config.workspaceRoot);
	const minecraftWorkspace = dependencies.minecraftWorkspace ?? new MinecraftAgentWorkspace({
		root: config.minecraftAgentRoot,
		templateRoot: config.minecraftAgentTemplateRoot,
	});
	// Tests and simulators get a monitor that never spawns; runCli injects the real one.
	const providerCliHealth = strictSpendGate ? createDisabledProviderCliHealthMonitor() : (dependencies.providerCliHealth ?? createDisabledProviderCliHealthMonitor());
	if (typeof providerCliHealth.configure === 'function') {
		providerCliHealth.configure({
			codex: { ...config.codex, ...(config.codex.launchProfile ?? {}), environment: providerEnvironments.codex, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable },
			claude: { ...config.claude, environment: providerEnvironments.claude, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable },
		});
	}
	// Discovery spawns the CLIs' read-only status and model-list commands, so it runs only where CLI probes may.
	const discoveryEnabled = providerCliHealth.enabled === true;
	const injectedProviders = dependencies.providerService ?? dependencies.codexService ?? null;
	const codexProvider = injectedProviders !== null ? null
		: new CodexService({ ...config.codex, environment: providerEnvironments.codex, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable }, { transport: dependencies.codexTransport, now: dependencies.now ?? Date.now, workspaceManager, minecraftWorkspace });
	const codexService = injectedProviders ?? new ProviderService({
		codex: codexProvider,
		claude: new ClaudeProviderService({ ...config.claude, environment: providerEnvironments.claude, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable }, {
			spawn: dependencies.claudeSpawn,
			terminate: dependencies.terminateProviderProcess,
			toolServer: dependencies.claudeToolServer,
			workspaceManager,
			minecraftWorkspace,
		}),
	}, { strictSpendGate, turnRecorder: providerTurnRecorder, now: dependencies.epochNow ?? Date.now });
	const healthRegistry = dependencies.healthRegistry ?? dependencies.planner?.healthRegistry ?? new ProviderHealthRegistry({ now: dependencies.healthNow ?? Date.now });
	const latencyRegistry = dependencies.latencyRegistry ?? new ControlLatencyRegistry();
	const bodyPace = dependencies.bodyPace ?? new BodyPace({ now: dependencies.epochNow ?? Date.now });
	const planner = dependencies.planner ?? new AgentPlanner({
		strictSpendGate,
		registry,
		scheduler,
		codexService,
		invalidDecisionRetries: config.limits.invalidDecisionRetries,
		healthRegistry,
		latencyRegistry,
		now: dependencies.plannerNow ?? dependencies.now,
		telemetrySink: dependencies.telemetrySink,
		nativeTimingSink: (event, fields) => { bodyPace.note(event, fields); return dependencies.traceWriter?.write(event, fields); },
		benchmarkRecorder: dependencies.benchmarkRecorder,
		turnRecorder: providerTurnRecorder,
		decisionLog,
	});
	const bridge = dependencies.bridge ?? new MultiplexedServerBridge(config.bridge, {
		audit: dependencies.protocolAudit,
		socketFactory: dependencies.socketFactory,
		schedule: dependencies.schedule,
		cancelSchedule: dependencies.cancelSchedule,
		scheduleDeadline: dependencies.scheduleDeadline,
		cancelDeadline: dependencies.cancelDeadline,
		currentRevision: (agentId) => registry.get(agentId)?.goalRevision ?? null,
	});
	let coordinator = null;
	const goalSupervisor = dependencies.goalSupervisor ?? new ActiveGoalSupervisor({
		requestObservation: (key, reason) => coordinator?.requestSupervisedObservation(key, reason) ?? false,
		clock: dependencies.goalClock ?? dependencies.controlNow ?? Date.now,
		schedule: dependencies.goalSchedule,
		cancelSchedule: dependencies.cancelGoalSchedule,
		stuckSchedule: dependencies.goalStuckSchedule,
		cancelStuckSchedule: dependencies.cancelGoalStuckSchedule,
		onExpire: (event) => coordinator?.handleLeaseExpired(event),
		onStuck: (event) => coordinator?.handleGoalStuck(event),
	});
	coordinator = new DynamicCoordinator({
		bodyPace,
		registry,
		scheduler,
		codexService,
		planner,
		bridge,
		healthRegistry,
		latencyRegistry,
		goalSupervisor,
		codexControlProtocol: config.codex.controlProtocol,
		memoryDirectory: Object.hasOwn(dependencies, 'memoryDirectory') ? dependencies.memoryDirectory : path.join(config.workspaceRoot, 'player-memory'),
		experience: experienceSettings(coordinatorEnvironment),
		runtimeSessionId: dependencies.runtimeSessionId,
		traceWriter: dependencies.traceWriter,
		providerTurnRecorder,
		decisionLog,
		runtimeGeneration: dependencies.runtimeGeneration,
		runtimeHooks: dependencies.runtimeHooks,
		controlNow: dependencies.controlNow,
		epochNow: dependencies.epochNow,
		setStatusInterval: dependencies.setStatusInterval,
		clearStatusInterval: dependencies.clearStatusInterval,
		healthSampler: dependencies.healthSampler,
		setGoalSpecTimeout: dependencies.setGoalSpecTimeout,
		clearGoalSpecTimeout: dependencies.clearGoalSpecTimeout,
		setSteerTimeout: dependencies.setSteerTimeout,
		clearSteerTimeout: dependencies.clearSteerTimeout,
		setWakeHoldTimeout: dependencies.setWakeHoldTimeout,
		...(dependencies.reflexDefaults === undefined ? {} : { reflexDefaults: dependencies.reflexDefaults }),
		reflexInstincts: instinctsEnabled(coordinatorEnvironment),
		kitHabit: kitHabitEnabled(coordinatorEnvironment),
		clearWakeHoldTimeout: dependencies.clearWakeHoldTimeout,
		taskRequestTimeoutMs: dependencies.taskRequestTimeoutMs,
		maxPendingAgentOperations: dependencies.maxPendingAgentOperations,
		maxPendingAgentTransactions: dependencies.maxPendingAgentTransactions,
		...(dependencies.nativeClock === undefined ? {} : { nativeClock: dependencies.nativeClock }),
		connectionOperationCap: dependencies.connectionOperationCap,
		agentOperationCap: dependencies.agentOperationCap,
		goalSpecRequestCap: dependencies.goalSpecRequestCap,
		benchmarkRecorder: dependencies.benchmarkRecorder,
		providerCliHealth,
		providerDiscovery: dependencies.providerDiscovery ?? new ProviderDiscovery({
			cliHealth: discoveryEnabled ? providerCliHealth : null,
			accountReaders: createAccountReaders({
				environments: providerEnvironments,
				executables: { claude: config.claude.executable },
				codexService: codexProvider,
			}),
		}),
	});
	return coordinator;
}

function defaultGoalSpecTimeout(callback, delayMs) {
	const handle = setTimeout(callback, delayMs);
	handle.unref?.();
	return handle;
}

async function runCli(reporter = new RuntimeErrorReporter()) {
	const { configPath } = parseDynamicCliArguments(process.argv.slice(2));
	const config = await loadDynamicConfig(configPath);
	const runtime = resolveDynamicCliRuntime(process.env);
	const traceWriter = new TraceWriter(runtime.tracePath, { diagnosticFilePath: runtime.diagnosticTracePath });
	const protocolAudit = runtime.protocolAuditPath === null ? null : createJsonlAudit(runtime.protocolAuditPath, { runId: runtime.runId, scenarioId: runtime.scenarioId });
	if (runtime.providerTurnsPath !== null) await mkdir(path.dirname(path.resolve(runtime.providerTurnsPath)), { recursive: true });
	const providerTurnRecorder = runtime.providerTurnsPath === null ? null : new ProviderTurnRecorder({
		runId: runtime.runId,
		scenarioId: runtime.scenarioId,
		privatePath: runtime.providerTurnsPath,
	});
	const decisionLog = new DecisionLog({ directory: runtime.decisionLogDirectory, enabled: runtime.decisionLogEnabled });
	const voiceSupervisor = createVoiceSupervisor(config, process.env);
	const coordinator = createDynamicCoordinator(config, {
		traceWriter, protocolAudit, providerTurnRecorder, decisionLog, runtimeGeneration: runtime.runtimeGeneration,
		runtimeHooks: { onRemoved: (agentId) => voiceSupervisor.removeAgent(agentId) },
		// Real agents launch real CLIs here, so the probes may spawn them.
		providerCliHealth: new ProviderCliHealthMonitor(),
	});
	const disposeDiagnostics = wireRuntimeDiagnostics(coordinator, reporter);
	try {
		await startCoordinatorControl(coordinator, voiceSupervisor);
	} catch (error) {
		await Promise.allSettled([coordinator.stop(), voiceSupervisor.close(), protocolAudit?.close()]);
		disposeDiagnostics();
		throw error;
	}
	let shutdownPromise = null;
	const shutdown = async () => {
		shutdownPromise ??= (async () => {
			await coordinator.stop();
			await voiceSupervisor.close();
			await protocolAudit?.close();
		})().finally(disposeDiagnostics);
		await shutdownPromise;
		process.exitCode = 0;
	};
	watchCaptureShutdown(process.env.ARENA_CAPTURE_SHUTDOWN_PATH, shutdown);
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
}

export async function startCoordinatorControl(coordinator, voiceSupervisor) {
	if (coordinator === null || typeof coordinator?.start !== 'function') {
		throw new TypeError('coordinator.start is required');
	}
	if (voiceSupervisor === null || typeof voiceSupervisor?.start !== 'function'
			|| typeof voiceSupervisor?.close !== 'function') {
		throw new TypeError('voiceSupervisor.start and voiceSupervisor.close are required');
	}
	if (typeof coordinator.once === 'function') {
		coordinator.once('shutdown', () => { void Promise.resolve(voiceSupervisor.close()).catch(() => {}); });
	}
	await coordinator.start();
	try { Promise.resolve(voiceSupervisor.start()).catch(() => {}); }
	catch { /* optional voice startup cannot reject coordinator control */ }
}

const CRITICAL_AUDIT_TYPES = new Set(['hello', 'hello_ack', 'registry_entry', 'registry_complete', 'agent_registered', 'goal_control']);

export function createJsonlAudit(filePath, metadata, dependencies = {}) {
	if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError('protocol audit path must be nonblank');
	const makeDirectory = dependencies.mkdir ?? mkdir;
	let queue;
	const sink = new RotatingJsonlSink(filePath, {
		...dependencies,
		inspect: dependencies.appendFile === undefined || dependencies.stat !== undefined
			|| dependencies.maxFileBytes !== undefined || dependencies.maxFileAgeMs !== undefined,
	});
	let closed = false;
	let closePromise = null;
	// Attach rejection handling immediately, including when no audit row ever arrives.
	const ready = Promise.resolve().then(() => makeDirectory(path.dirname(path.resolve(filePath)), { recursive: true }))
		.then(() => true, () => { queue.reportFailure(); return false; });
	// The default 64-row queue overflowed during the connection burst (a dozen catalog snapshots) and silently dropped the
	// agent_registered row, so the matrix runner never saw the goal start. Registration and goal rows must survive that burst.
	queue = new BestEffortDiagnosticQueue({ maxPending: 1_024, ...dependencies, ready });
	const requireReady = async () => {
		if (!await ready) throw new Error('protocol audit directory is unavailable');
	};
	// Handshake and registration rows are evidence the harness waits on. They bypass the 250 ms best-effort timeout
	// and retry while the sink is busy (for example a timed-out earlier append still holding the file).
	const criticalAttempts = dependencies.criticalAttempts ?? 40;
	const criticalDelayMs = dependencies.criticalRetryDelayMs ?? 50;
	let criticalChain = Promise.resolve();
	const writeCritical = (encoded) => {
		criticalChain = criticalChain.then(async () => {
			for (let attempt = 1; attempt <= criticalAttempts; attempt += 1) {
				try { await requireReady(); await sink.append(encoded, { encoding: 'utf8', flag: 'a' }, { waitForIdle: true }); return; }
				catch { if (attempt < criticalAttempts) await new Promise((resolve) => setTimeout(resolve, criticalDelayMs)); }
			}
			queue.reportFailure();
		}).catch(() => {});
	};
	const audit = (direction, envelope) => {
		if (closed) return Promise.resolve();
		try {
			const safeMetadata = sanitizeDiagnosticValue(metadata);
			const row = Object.assign(Object.create(null),
				safeMetadata !== null && typeof safeMetadata === 'object' && !Array.isArray(safeMetadata) ? safeMetadata : {},
				{ direction: sanitizeDiagnosticValue(direction), envelope: sanitizeDiagnosticValue(envelope) });
			const encoded = `${JSON.stringify(row)}\n`;
			if (CRITICAL_AUDIT_TYPES.has(row.envelope?.type)) writeCritical(encoded);
			else queue.submit(async () => { await requireReady(); await sink.append(encoded, { encoding: 'utf8', flag: 'a' }); });
		} catch { /* invalid audit evidence is observational */ }
		return Promise.resolve();
	};
	audit.close = () => {
		if (closePromise !== null) return closePromise;
		closed = true;
		const criticalClose = new Promise((resolve) => {
			const timer = setTimeout(() => { queue.reportFailure(); resolve(); }, dependencies.closeTimeoutMs ?? 1_000);
			criticalChain.then(() => { clearTimeout(timer); resolve(); });
		});
		closePromise = Promise.all([queue.close(), criticalClose]).then(() => undefined);
		return closePromise;
	};
	audit.statusSnapshot = () => Object.freeze({ ...queue.statusSnapshot('protocol_audit'), droppedCount: queue.droppedCount });
	return audit;
}

function requireDependency(value, name) {
	if (value === null || value === undefined) throw new TypeError(`${name} is required`);
	return value;
}

function defaultStatusInterval(callback, milliseconds) {
	const handle = setInterval(callback, milliseconds);
	handle.unref?.();
	return handle;
}

function safeClockRead(clock) {
	try {
		const value = clock();
		return Number.isFinite(value) && value >= 0 ? value : null;
	} catch {
		return null;
	}
}

function isTransientCompletionSendError(error) {
	return ['BRIDGE_NOT_READY', 'BRIDGE_DISCONNECTED', 'CONNECTION_BACKPRESSURE', 'AGENT_BACKPRESSURE'].includes(error?.code);
}

function verboseErrorMessage(error) {
	const code = String(error?.code ?? 'COORDINATOR_ERROR').slice(0, 128);
	return `${verboseErrorScope(code)} error (${code}).`;
}

function verboseRecoveryMessage(recovery) {
	if (recovery.quiet) return 'Provider output was incomplete; retrying from the next fresh observation.';
	if (recovery.blocked) return 'Provider access is unavailable; retrying automatically from fresh state.';
	return 'Provider work failed; recovering automatically from fresh state.';
}

function sanitizeVerboseMessage(stage, message) {
	const normalized = String(message ?? '')
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (stage === 'error') {
		const code = normalized.match(/\(([A-Z][A-Z0-9_]{1,127})\)/)?.[1]
			?? normalized.match(/\b[A-Z][A-Z0-9_]{2,127}\b/)?.[0]
			?? 'COORDINATOR_ERROR';
		const scope = /^(Provider|Planning|Coordinator) error \(/i.exec(normalized)?.[1] ?? verboseErrorScope(code);
		return `${scope[0].toUpperCase()}${scope.slice(1).toLowerCase()} error (${code}).`.slice(0, MAX_VERBOSE_MESSAGE_LENGTH);
	}
	return sanitizeVerboseOutput(normalized).slice(0, MAX_VERBOSE_MESSAGE_LENGTH);
}

function verboseDecisionSummary(decision) {
	return sanitizePublicNarrative(decision?.summary) || 'Plan accepted.';
}

function verboseTransitionIdentity(stage, message, value) {
	const defaults = {
		conversation: { component: 'conversation', boundary: 'message', code: 'MESSAGE_RECEIVED', state: 'ready' },
		decision: { component: 'provider', boundary: 'planning', code: 'PLAN_ACCEPTED', state: 'ready' },
		error: { component: 'coordinator', boundary: 'agent_work', code: 'COORDINATOR_ERROR', state: 'degraded' },
		lifecycle: { component: 'lifecycle', boundary: 'goal', code: 'LIFECYCLE_CHANGED', state: 'ready' },
		retry: { component: 'provider', boundary: 'planning', code: 'PROVIDER_RETRY', state: 'retrying' },
	}[stage] ?? { component: 'coordinator', boundary: stage, code: 'STATUS_CHANGED', state: 'ready' };
	return {
		component: String(value?.component ?? defaults.component).slice(0, 128),
		boundary: String(value?.boundary ?? defaults.boundary).slice(0, 128),
		code: String(value?.code ?? defaults.code).slice(0, 128),
		state: String(value?.state ?? defaults.state).slice(0, 128),
		detail: message,
	};
}

function sanitizePublicAgentMessage(message) {
	return sanitizePublicNarrative(message);
}

function sanitizePublicNarrative(message) {
	const source = typeof message === 'string' ? message : String(message ?? '');
	let raw = source.slice(0, MAX_PUBLIC_NARRATIVE_RAW_CHARS);
	if (source.length > MAX_PUBLIC_NARRATIVE_RAW_CHARS) raw = completePublicSentences(raw);
	const visible = sanitizeVerboseOutput(raw);
	if (visible.length === 0 || /^[{]/.test(visible)) return '';
	const boundary = publicNarrativeBoundary(visible);
	return visible.slice(0, boundary ?? visible.length).replace(/[\s,;:-]+$/, '').trim().slice(0, MAX_VERBOSE_MESSAGE_LENGTH);
}

function completePublicSentences(value) {
	let boundary = 0;
	for (const match of value.matchAll(/[.!?](?=\s|$)/g)) boundary = match.index + match[0].length;
	return value.slice(0, boundary);
}

function publicNarrativeBoundary(value) {
	const matches = [
		value.search(/\{/),
		value.search(/\[\s*\{/),
		value.search(/\b(?:action[_ -]?id|native[_ -]?action|action[_ -]?call|call[_ -]?id|tool[_ -]?(?:call|record|result)|trace[_ -]?id|uuid|diagnostic|program[_ -]?(?:step|compiled|replaced))\b/i),
		value.search(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i),
		value.search(/\bnative:[a-z0-9._-]+:\d+:\d+\b/i),
		value.search(/\baction-progress-\d+\b/i),
		value.search(/\bcall_[a-z0-9]{3,}\b/i),
		value.search(/\b[a-z0-9._-]+:\d+:\d+:\d+:program-\d+-\d+:\d+:\d+:(?:arena-state|step)-\d+\b/i),
		value.search(/\bprogram-\d+-\d+:\d+:\d+:(?:arena-state|step)-\d+\b/i),
		value.search(/\btrace-[a-z0-9._:-]+-\d+-\d+-[a-z][a-z0-9_-]*\b/i),
		value.search(/\b(?:calling|executing|invoking)\s+[a-z][a-z0-9_]*\s+with\s+(?:[a-z][a-z0-9_]*\s*=|\{)/i),
	].filter((index) => index >= 0);
	return matches.length === 0 ? null : Math.min(...matches);
}

function verboseErrorScope(code) {
	if (/^(?:AUTHENTICATION_REQUIRED|PROVIDER|TURN_|REQUEST_TIMEOUT|MISSING_(?:AGENT|FINAL)_MESSAGE|SPAWN_|APP_SERVER_)/.test(code)) return 'Provider';
	if (/(?:DECISION|PLANNER|PLANNING_TIMEOUT|PLAN_|PARSE|DIRECTIVE|ARENA_SCRIPT)/.test(code)) return 'Planning';
	return 'Coordinator';
}

function sanitizeVerboseOutput(message) {
	return String(message ?? '')
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]')
		.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_KEY]')
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_AUTH]')
		.replace(/(\b(?:secret|token|api[-_ ]?key|password|authorization)\b["']?\s*(?:[:=]\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
}

function finiteCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function stringList(value) { return Array.isArray(value) ? value.slice(0, 8).filter((entry) => typeof entry === 'string').map((entry) => entry.slice(0, 64)) : null; }

function nativeUsageTraceFields(value, state, record) {
	if (!['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'].some(key => finiteCount(value?.[key]) !== null)) return {};
	// Reuse the legacy flat usage schema without mutating the current goal's public view.
	updateUsage(state, record, value, Date.now());
	return state.usage ?? {};
}

export function modelCallTraceFields(value) {
	const call = value.call, last = value.last ?? {};
	const fields = { provider: typeof call.provider === 'string' ? call.provider : null, turnId: typeof call.turnId === 'string' ? call.turnId : null,
		modelCallId: typeof call.modelCallId === 'string' ? call.modelCallId : null,
		timingBasis: ['input-to-first-tool-request', 'usage-notification-only'].includes(call.timingBasis) ? call.timingBasis : null,
		handoffBudget: call.handoffBudget == null ? null : Object.fromEntries(['creditUsd', 'totalReadUsd', 'totalElectiveWriteUsd', 'lastWriteUsd', 'lastPayloadBytes', 'lastOverrunUsd', 'lastElectiveWriteUsd', 'reservedWriteUsd', 'unsettledDebtUsd'].filter(key => Number.isFinite(call.handoffBudget[key])).map(key => [key, call.handoffBudget[key]])),
		partialMessagesAccepted: typeof call.partialMessagesAccepted === 'boolean' ? call.partialMessagesAccepted : null,
		interrupted: typeof call.interrupted === 'boolean' ? call.interrupted : null, outputReconciled: typeof call.outputReconciled === 'boolean' ? call.outputReconciled : null,
		contextTokens: finiteCount(call.contextTokens), inputTokens: finiteCount(last.inputTokens), cachedInputTokens: finiteCount(last.cachedInputTokens),
		cacheWriteInputTokens: finiteCount(last.cacheWriteInputTokens), outputTokens: finiteCount(last.outputTokens), rotations: finiteCount(call.rotations),
		firstEventMs: finiteCount(call.firstEventMs), streamMs: finiteCount(call.streamMs), totalMs: finiteCount(call.totalMs),
		requestAt: finiteCount(call.requestAt), endedAt: finiteCount(call.endedAt), firstEventAt: finiteCount(call.firstEventAt), startMs: finiteCount(call.startMs), streamEvents: finiteCount(call.streamEvents),
		firstEventSource: ['stream', 'assistant'].includes(call.firstEventSource) ? call.firstEventSource : null,
		toolNames: stringList(call.toolNames), toolStartMs: Array.isArray(call.toolStartMs) ? call.toolStartMs.slice(0, 8).map(finiteCount).filter((entry) => entry !== null) : null };
	return Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== null && !(Array.isArray(field) && field.length === 0)));
}

export function turnUsageTraceFields(usage) {
	if (usage === null || typeof usage !== 'object') return {};
	const fields = { modelCalls: finiteCount(usage.calls), inputTokens: finiteCount(usage.input), cachedInputTokens: finiteCount(usage.cacheRead),
		cacheWriteInputTokens: finiteCount(usage.cacheWrite), outputTokens: finiteCount(usage.output), contextTokens: finiteCount(usage.contextTokens),
		costUsd: Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : null,
		// Included in the counts above: calls of an interrupted turn (a hazard reissue, for one) that reported nothing.
		interruptedModelCalls: finiteCount(usage.interrupted?.calls),
		interruptedTokens: usage.interrupted ? finiteCount(['input', 'cacheRead', 'cacheWrite', 'output'].reduce((sum, key) => sum + (usage.interrupted[key] ?? 0), 0)) : null };
	return Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== null));
}

function sameSupervisionKey(left, right) {
	return left?.agentId === right?.agentId
		&& left?.goalRevision === right?.goalRevision
		&& left?.lifecycleGeneration === right?.lifecycleGeneration
		&& left?.sessionEpoch === right?.sessionEpoch
		&& left?.profileFingerprint === right?.profileFingerprint;
}

function planningTraceId(agentId, goalRevision, lifecycleGeneration, kind) {
	const identity = String(agentId).replace(/[^A-Za-z0-9._:-]/g, '_');
	return `trace-${identity}-${goalRevision}-${lifecycleGeneration}-${kind}`.slice(0, 128);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const reporter = new RuntimeErrorReporter();
	runCli(reporter).catch((error) => {
		reporter.report(error, { phase: 'startup' });
		process.exitCode = 1;
	});
}

function logCatalogGap(outcome, detail) {
	try {
		const text = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null);
		console.error(`[provider-catalog] discovery ${outcome}: ${sanitizeDiagnosticText(text ?? '', { maxBytes: 2_048 })}`);
	} catch { /* console output is best effort */ }
}
