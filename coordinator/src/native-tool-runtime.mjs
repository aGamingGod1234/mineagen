import { createHash, randomUUID } from 'node:crypto';
import { validateTraceId } from './control-latency-registry.mjs';
import { ExplorationOccupancy, extractPosition as observationPosition, observationWorldId } from './explore-frontier.mjs';
import { hasDurableObservationFacts, RecoveryProgressStore } from './recovery-progress-wrap.mjs';
import { RepeatedFailureLedger } from './repeated-failure.mjs';
import { failureChange, failureFacts, isFailureResult, triedText } from './failure-schema.mjs';
import { classifyBodyFailure, composeTwoCallView } from './two-call-llm-wrap.mjs';
import { DugStairs, PlacedWorkstations } from './resource-facts.mjs';
import { howto, howtoHoldings } from './howto.mjs';
import { minecraftCapabilities, normalizeMinecraftToolCall, toolAdjustments, toolResultContent, withAdjustments } from './native-minecraft-tools.mjs';
import { runObtain } from './obtain-runner.mjs';
import { resolveObtainItem } from './obtain-plan.mjs';
import { KIT_CRAFT_TIMEOUT_MS, keepKit } from './kit-habit.mjs';
import { runInventoryRepair } from './inventory-repair.mjs';
import { PORTAL_ENTRY_NEXT, PORTAL_ENTRY_PREP } from './skill-fits.mjs';
import { NativeProgramExecutor } from './native-program-executor.mjs';
import { nativeOperationRejection } from './native-operation-contract.mjs';
import { parseArenaScript } from './arena-script/parser.mjs';
import { arenaScriptDiagnosticFields } from './arena-script/errors.mjs';
import { compileProgramPrecondition, evaluateProgramPrecondition } from './program-precondition.mjs';
import { MAX_STANDING_SOURCE_BYTES, StandingOrderBook, standingOrderCause, guardEpisodeFacts } from './standing-orders.mjs';
import { ReflexBook } from './reflexes.mjs';
import { searchFor } from './find-search.mjs';
import { STEP_ACTIONS } from './wake-filter.mjs';
import { CONTEXT_TRIGGERS, SURVIVAL_TRIGGERS } from './arena-script/program-engine.mjs';
import { defaultServiceTier } from './constants.mjs';
import { actionLeaseTimeoutMs, requestedActionTimeoutMs } from './work-lease-supervisor.mjs';
import { PLAN_COUNT_ACTIONS, countSkillDurationMs, planCountDefault } from './plan-count.mjs';
import { WALL_CLOCK, completeClock } from './game-clock.mjs';

const FORGET_REASONS = /agent_removed|server_replaced|coordinator_stopped/;
const TERMINAL_ACTION_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
/** Heartbeat retries for one failure whose steers the provider keeps rejecting, before it waits for the next turn. */
const MAX_FAILURE_STEER_ATTEMPTS = 3;
// Standalone calls whose next decision depends on the changed inventory or body get one fresh terminal sample.
// use_item is sampled only when it eats or drinks (see #consumesHeldItem): a shield or bow user must react at once.
// Run-2 action/read joins: fresh views are also needed after turning (8 Sol inspect transitions)
// and raw move_to (2 Opus inspect transitions), alongside the existing mining/navigation facts.
const POST_ACTION_OBSERVATION_TYPES = new Set(['pick_up_item', 'break_block', 'dig_to', 'navigate_to', 'travel_to', 'move_to', 'look_at', 'craft_inventory', 'craft_table', 'use_item']);
const DRINKS = new Set(['minecraft:potion', 'minecraft:honey_bottle', 'minecraft:milk_bucket', 'minecraft:ominous_bottle']);
const TRAVEL_ACTIONS = new Set(['navigate_to', 'move_to', 'travel_to']);
// Survey's clear-air sight range, stated once in the survey tool description.
const SURVEY_FULL_RANGE = 256;
// The server publishes its post-result observation in the same tick as the result. Live, with eight agents on a
// loaded machine, the first one arrived a median 13 ms and p95 34 ms after the result; 40 ms (under one tick)
// held the miss rate at 0.2% of results, and 75 ms did no better. Past it the explicit request takes over, so a
// miss costs at most this much. The wait only starts once an agent's last results were each followed by a
// publication, so a server that does not publish after results (or an agent whose publication was missed)
// keeps requesting at once.
const POST_RESULT_PUBLICATION_GRACE_MS = 40;
const PUBLICATION_EVIDENCE_RESULTS = 2;
// A danger interrupt that lands on a sequence step with steps after it waits this long, in total per call, for quick
// steps to finish. Live (rx113 rooms), Opus answered skeletons and blazes with [equip shield, select sword,
// fight_target]; the arrow steer cut the 0.25 s equip, the fight never started, and three turns in a row repeated it.
// Equip, select and place steps finish in 0.1-0.3 s, so the steer still arrives at the first step that takes time.
const SEQUENCE_STEP_SETTLE_MS = 800;
const EXPIRED = Symbol('expired');
// The model may answer danger with these while its program is paused for a decision, without first
// settling the program decision; the paused program keeps its decision for a later respondProgram.
// escape is the emergency step: like fight and flee it may borrow the body from a program paused for a danger decision.
const PAUSED_PROGRAM_DANGER_ACTIONS = new Set(['fight_target', 'flee_from', 'escape']);
const GUARD_DEFENSIVE_ACTIONS = new Set(['fight_target', 'flee_from', 'block_with_shield', 'use_item', 'respawn']);
const GUARD_OVERRIDE_KINDS = new Set(['action', 'start_action', 'run_program', 'sequence', 'lookAround', 'gather', 'find', 'obtain', 'repair_inventory', 'finish']);
// A direct model body command takes the body from a firing reflex. Starting a program does not: the program pauses under it.
// replace_action is one too; it yields in its own branch, once the replacement is accepted and before the old action is cancelled.
const REFLEX_YIELD_KINDS = new Set(['action', 'start_action', 'sequence', 'lookAround', 'gather', 'find', 'obtain', 'repair_inventory']);
const STOOD_STILL_KINDS = new Set(['action', 'start_action', 'run_program', 'sequence', 'lookAround', 'gather', 'find', 'obtain', 'repair_inventory']);
const BODY_SEEN_VERBS = new Set(['travel_to', 'dig_to']);
const STEP_RUNNING_NOTE = 'End your turn: the step runs on its own and you are woken when it ends or the body stops it, or for danger your reflexes did not handle, chat or death.';
// keepGoing: at most this many legs in one chain, so a model that never replies still gets a completion wake.
export const MAX_KEEP_GOING_LEGS = 8;
// A leg that moved the body less than this is no progress (blocked heading), so the chain stops and hands back.
const KEEP_GOING_MIN_PROGRESS_BLOCKS = 1;
const RUNNING_ACTION_STATES = new Set(['RUNNING', 'PREPARING', 'CANCELLING', 'CANCELLATION_UNCONFIRMED']);
// Body calls that may carry reflex rules to install before they act (run_program installs its own).
const REFLEX_CARRIER_KINDS = new Set(['action', 'sequence', 'gather', 'find', 'obtain', 'standing_order']);
// Firing outcomes during which the reflex held the body (a paused program's action was not running).
const REFLEX_HELD_OUTCOMES = new Set(['done', 'timeout', 'failed', 'preempted', 'yielded']);
// Game time per server tick (the body's GameClock), and the smallest server-lag shortfall worth moving a program deadline for.
const GAME_MS_PER_TICK = 50;
const LAG_CREDIT_MIN_MS = 250;
const LAG_SAME_TICK_MS = 1000;
/** What a planning notice tells the model about its next call. */
export const PLANNING_TAIL_NOTE = 'Send the next runProgram or body call when ready, covering every step you can already plan: it starts the moment this program ends naturally (any other ending returns NOT_STARTED with its status).';
/**
 * A program that ran out of source on a successful last action, with no decision owed: queued or waiting work may start.
 * Earlier failed actions the source passed over do not count (d21 Sol: 6 of 29 queued successors were dropped for one
 * TARGET_AIR); the successor's precondition or the model's own call judges the fresh facts.
 */
function endedNaturally(outcome) {
	if (outcome?.state !== 'YIELDED' || outcome.reasonCode !== 'PROGRAM_EXHAUSTED' || outcome.decision != null) return false;
	const last = Array.isArray(outcome.receipts) ? outcome.receipts.at(-1) : undefined;
	return last === undefined ? outcome.actionsFailed === 0 && outcome.actionsSucceeded === outcome.actions : last.state === 'SUCCEEDED';
}
// Rejections about handles or body ownership carry the current handles so the next call can succeed.
const HANDLE_CONTRACT_CODES = new Set(['STALE_PROGRAM_DECISION', 'PROGRAM_REPLACEMENT_REQUIRED', 'STALE_ACTION', 'STALE_PROGRAM', 'NATIVE_PROGRAM_IN_PROGRESS', 'NATIVE_ACTION_IN_PROGRESS', 'CANCELLATION_IN_PROGRESS']);
// Waiting only stops repeating the finished work; new operator requests stay the model's to act on.
export const AWAITING_CONFIRMATION_MESSAGE = 'The remaining condition requires operator confirmation. Report completion once, then end this turn when safe. Do not repeat the finished work or finish checks while waiting. You still own your body: defend, flee, escape hazards, breathe, eat or equip as needed without operator permission; confirmation stays pending. Only operator:true direct/voice requests may change work; other messages supply facts or invite replies. After handling a new operator request, call finish again.';


export class NativeToolRuntime {
	#bridge;
	#registry;
	#onFinish;
	#trace;
	// When each body last finished an action with nothing dispatched since: a body call arriving later reports how long
	// the body stood still waiting for it (stoodStillMs), the cost of deciding one call at a time.
	#bodyIdleSince = new Map();
	#disposals = new Set();
	#bodyDispatches = new Map();
	#observations = new Map();
	#portalSearches = new Map();
	#lastLive = new Map();
	#actions = new Map();
	#completions = new Map();
	#staleActions = new Map();
	#occupancy;
	#memoryLoads = new Map();
	#memoryReady = new Set();
	#pendingSpatial = new Map();
	// The generation of each agent's latest spatial observation, drawn from one counter that is never reset or reused,
	// so a delayed forgetting disposal can tell whether any later body already wrote.
	#spatialWrites = new Map();
	#spatialGeneration = 0;
	#recovery = new RecoveryProgressStore();
	#placedWorkstations = new PlacedWorkstations();
	#lastSweeps = new Map();
	// Remembered places a search went to and did not see its target at, or could not reach: later searches skip them.
	#missedPlaces = new Map();
	// The last spot each body stood on under open sky: the way up out of a wet hole or a flooded chamber ends there.
	#openSky = new Map();
	#dugStairs = new DugStairs();
	#decorateObservation;
	#requestObservation;
	#inspectObservation;
	#inspectedTargets = new Map();
	#notebook;
	#executionSettings;
	#memoryOperation;
	#taskContext; #memoryObservation;
	#taskPlan;
	#planVocabulary;
	#knownStations;
	#planNeeds;
	#programExecutor;
	#programRuns = new Map();
	#programResults = new Map();
	// Model waits on a running program (they never own the body), and detached program ends no tool result has reported yet.
	#programWaits = new Map();
	#unreportedProgramEnds = new Map();
	#onProgramEvent;
	#onWorkStarted;
	#planningLeadTime;
	#onModelActionCancelled;
	#sweeps = new Map();
	#sessionId;
	#receipts = new Map();
	/** Structured break evidence per terminal result, for authored programs only: the model already reads it in the message. */
	#breakOutcomes = new WeakMap();
	// Private request metadata follows the bounded receipt lifetime; actionStatus never exposes it.
	#receiptRequests = new WeakMap();
	#repeatedFailures = new RepeatedFailureLedger();
	// Where the last body action ended, so the next one starts from a sample no older than that end.
	#bodyEnds = new Map();
	// Delivered action identities, bounded to the same 64-entry history as receipts.
	#deliveredFailures = new Map();
	// Independent reservations per agent and action, until each input is consumed or rejected.
	#reservedFailures = new Map();
	// Wake protection for a retained failure: 'inflight' while a steer carrying it awaits the provider, 'settled' once one
	// was accepted. Absent means still owed. Kept apart from #deliveredFailures, which also counts tool results the
	// adapter has not published yet and only dedupes the failure text.
	#failureSteers = new Map();
	// Undelivered requests survive turn cleanup, bounded like the receipt history.
	#failedRequests = new Map();
	#executionEpochs = new Map();
	#postResultSamples = new Map();
	// keepGoing chains by agent: every leg's actionId names the chain, so the model's first handle stays usable.
	#legChains = new Map();
	// The chain the next model body action dispatched for this agent joins (set just before that dispatch).
	#pendingLegChains = new Map();
	#publicationStreaks = new Map();
	#sequenceFinishReservations = new Map();
	#blockingToolRuns = new Map();
	// A do_step that runs to its result (gather, craft, smelt) while it runs; background steps are their running action.
	#steps = new Map();
	// The admitted background do_step per agent: its intent's action id, the leg running now and its until sighting.
	#stepRuns = new Map();
	// Workstations obtain placed and has not picked up yet, per agent, across obtain calls.
	#obtainPlaced = new Map();
	#kitHabit = false;
	// Agents whose next blocking body tool starts already interrupted: a danger steer is waiting for a tool boundary the
	// model has not reached, so the tool it issues next was chosen without the danger (see interruptBlockingTool).
	#armedDangerInterrupts = new Set();
	#communications = new Map();
	#standing;
	#standingFiring = new Map();
	#standingYielding = new Map();
	#reflexes;
	#sequence = 0;
	#publicationGraceMs;
	#sequenceStepSettleMs;
	// Gameplay time (searches, gather, obtain, waits, program deadlines): wall time unless a fixture passes a game clock.
	#clock;
	// The executor the runtime built on a game clock already pays server lag in its deadline (no wall-time lag credit).
	#executorOnGameClock = false;

	constructor({
		// { now(), sleep(ms), setTimeout?, clearTimeout?, observe? } (game-clock.mjs); it is fed every stored sample.
		clock = WALL_CLOCK,
		bridge,
		registry = null,
		onFinish = async () => ({ state: 'FINISH_REQUESTED' }),
		trace = () => {},
		decorateObservation = null,
		requestObservation = null,
		inspectObservation = null,
		notebook = null,
		executionSettings = null,
		memoryOperation = null,
		taskContext = null,
		taskPlan = null,
		planVocabulary = null,
		knownStations = null,
		planNeeds = null,
		memoryObservation = null,
		programExecutor = null,
		onProgramEvent = () => {},
		onWorkStarted = () => () => {},
		planningLeadTime = () => null,
		onModelActionCancelled = () => {},
		sessionId = randomUUID(),
		occupancy = new ExplorationOccupancy(),
		publicationGraceMs = POST_RESULT_PUBLICATION_GRACE_MS,
		sequenceStepSettleMs = SEQUENCE_STEP_SETTLE_MS,
		standingOrders = new StandingOrderBook(clock === WALL_CLOCK ? {} : { now: () => clock.now() }),
		// The coordinator passes a book with the default survival rules; standalone runtimes (probes, tests) hold the model's rules only.
		reflexBook = new ReflexBook({ defaults: [], ...(clock === WALL_CLOCK ? {} : { now: () => clock.now() }) }),
		// After each obtain that succeeds, keep the kit from held items (kit-habit.mjs). Off for bare runtimes and tests.
		kitHabit = false,
	} = {}) {
		if (typeof bridge?.send !== 'function') throw new TypeError('bridge.send must be a function');
		this.#clock = completeClock(clock);
		if (registry !== null && typeof registry?.get !== 'function') throw new TypeError('registry.get must be a function');
		if (typeof onFinish !== 'function') throw new TypeError('onFinish must be a function');
		if (typeof trace !== 'function') throw new TypeError('trace must be a function');
		if (decorateObservation !== null && typeof decorateObservation !== 'function') throw new TypeError('decorateObservation must be a function');
		if (requestObservation !== null && typeof requestObservation !== 'function') throw new TypeError('requestObservation must be a function');
		if (inspectObservation !== null && typeof inspectObservation !== 'function') throw new TypeError('inspectObservation must be a function');
		if (notebook !== null && ['writeNote', 'query', 'recordReceipt'].some((method) => typeof notebook[method] !== 'function')) throw new TypeError('notebook must support writeNote, query, and recordReceipt');
		if (executionSettings !== null && typeof executionSettings !== 'function') throw new TypeError('executionSettings must be a function');
		if (memoryOperation !== null && typeof memoryOperation !== 'function') throw new TypeError('memoryOperation must be a function');
		if (taskContext !== null && typeof taskContext !== 'function') throw new TypeError('taskContext must be a function');
		if (memoryObservation !== null && typeof memoryObservation !== 'function') throw new TypeError('memoryObservation must be a function');
		if (programExecutor !== null && ['run', 'onObservation', 'cancel'].some((method) => typeof programExecutor?.[method] !== 'function')) throw new TypeError('programExecutor must support run, onObservation, and cancel');
		if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(sessionId)) throw new TypeError('sessionId must be 1..128 safe identifier characters');
		this.#kitHabit = kitHabit === true;
		if (['ingest', 'candidates', 'load', 'flush', 'clear'].some((method) => typeof occupancy?.[method] !== 'function')) throw new TypeError('occupancy must support observed-memory lifecycle and candidate queries');
		this.#bridge = bridge;
		this.#registry = registry;
		this.#onFinish = onFinish;
		this.#trace = (event, fields) => {
			if (event === 'native_tool_dispatch_started' && fields?.actionType !== 'chat') {
				this.#bodyIdleSince.delete(fields.agentId);
				this.#bodyDispatches.set(fields.actionId, fields.agentId);
				if (this.#bodyDispatches.size > 256) this.#bodyDispatches.delete(this.#bodyDispatches.keys().next().value);
			} else if (event === 'native_tool_action_completed' && this.#bodyDispatches.get(fields?.actionId) === fields.agentId) {
				this.#bodyDispatches.delete(fields.actionId);
				this.#bodyIdleSince.set(fields.agentId, Date.now());
			}
			try {
				const completion = trace(event, fields);
				if (completion !== undefined) Promise.resolve(completion).catch(() => {});
			} catch { /* diagnostics cannot interrupt gameplay */ }
		};
		this.#decorateObservation = decorateObservation;
		this.#requestObservation = requestObservation;
		this.#inspectObservation = inspectObservation;
		this.#notebook = notebook;
		this.#executionSettings = executionSettings;
		this.#memoryOperation = memoryOperation;
		this.#taskContext = taskContext;
		this.#taskPlan = taskPlan;
		if (planVocabulary !== null && typeof planVocabulary !== 'function') throw new TypeError('planVocabulary must be a function');
		this.#planVocabulary = planVocabulary;
		this.#knownStations = knownStations;
		if (planNeeds !== null && typeof planNeeds !== 'function') throw new TypeError('planNeeds must be a function');
		this.#planNeeds = planNeeds;
		this.#memoryObservation = memoryObservation;
		this.#programExecutor = programExecutor ?? (this.#clock === WALL_CLOCK ? new NativeProgramExecutor({ sessionId })
			// The cancel acknowledgement is a bridge round trip, not body time, so it keeps wall-time timers.
			: new NativeProgramExecutor({ sessionId, now: this.#clock.now, setTimeoutFn: this.#clock.setTimeout, clearTimeoutFn: this.#clock.clearTimeout, acknowledgementSetTimeoutFn: setTimeout, acknowledgementClearTimeoutFn: clearTimeout }));
		this.#executorOnGameClock = programExecutor === null && this.#clock !== WALL_CLOCK;
		if (typeof onProgramEvent !== 'function') throw new TypeError('onProgramEvent must be a function');
		this.#onProgramEvent = onProgramEvent;
		if (typeof onWorkStarted !== 'function') throw new TypeError('onWorkStarted must be a function');
		this.#onWorkStarted = onWorkStarted;
		if (typeof planningLeadTime !== 'function') throw new TypeError('planningLeadTime must be a function');
		this.#planningLeadTime = planningLeadTime;
		if (typeof onModelActionCancelled !== 'function') throw new TypeError('onModelActionCancelled must be a function');
		this.#onModelActionCancelled = onModelActionCancelled;
		this.#sessionId = sessionId.length <= 36 ? sessionId : createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
		this.#occupancy = occupancy;
		if (!Number.isFinite(publicationGraceMs) || publicationGraceMs < 0) throw new TypeError('publicationGraceMs must be a nonnegative number');
		this.#publicationGraceMs = publicationGraceMs;
		if (!Number.isFinite(sequenceStepSettleMs) || sequenceStepSettleMs < 0) throw new TypeError('sequenceStepSettleMs must be a nonnegative number');
		this.#sequenceStepSettleMs = sequenceStepSettleMs;
		this.#standing = standingOrders;
		this.#reflexes = reflexBook;
	}

	async initializeMemory(agentId) {
		if (this.#memoryReady.has(agentId)) return;
		let pending = this.#memoryLoads.get(agentId);
		if (pending === undefined) {
			pending = Promise.resolve().then(() => this.#occupancy.load(agentId)).then(() => {
				for (const observation of this.#pendingSpatial.get(agentId) ?? []) this.#occupancy.ingest(agentId, observation, { snapshot: false, admitted: true });
				this.#pendingSpatial.delete(agentId);
				this.#memoryReady.add(agentId);
			});
			this.#memoryLoads.set(agentId, pending);
		}
		try { await pending; }
		finally { if (this.#memoryLoads.get(agentId) === pending) this.#memoryLoads.delete(agentId); }
	}

	#rememberSpatial(agentId, observation) {
		this.#spatialWrites.set(agentId, ++this.#spatialGeneration);
		// Only samples admitted in event-sequence order reach here.
		if (this.#memoryReady.has(agentId)) { this.#occupancy.ingest(agentId, observation, { snapshot: false, admitted: true }); return; }
		const queued = this.#pendingSpatial.get(agentId) ?? [];
		queued.push(observation);
		this.#pendingSpatial.set(agentId, queued.slice(-32));
		this.initializeMemory(agentId).catch((error) => this.#trace('native_spatial_memory_failed', { agentId, reasonCode: error?.code ?? 'MEMORY_LOAD_FAILED' }));
	}

	async #flushSpatial(agentId) {
		await this.initializeMemory(agentId);
		await this.#occupancy.flush(agentId);
	}

	updateObservation(record, observation, options = {}) {
		const stored = this.#storeObservation(record, observation, options);
		if (stored) this.#notePublishedSample(record);
		return stored;
	}

	/**
	 * The server publishes an attention observation after every action result, in
	 * the same tick and after physics. Only pushes delivered in wire order after the
	 * result count, so a requested sample taken before the result cannot satisfy it.
	 */
	#notePublishedSample(record) {
		const pending = this.#postResultSamples.get(record.agentId);
		if (pending === undefined || pending.goalRevision !== record.goalRevision || pending.published) return;
		// A forced local update (a synthetic death notice) is stored at the last live sequence, which is no newer
		// than the result: it must neither satisfy the barrier nor count as proof that the server published.
		const stored = this.#observations.get(record.agentId);
		if (stored?.goalRevision !== record.goalRevision || stored.eventSequence <= pending.eventSequence) return;
		pending.published = true;
		this.#publicationStreaks.set(record.agentId, (this.#publicationStreaks.get(record.agentId) ?? 0) + 1);
		pending.wake?.();
	}

	#storeObservation(record, observation, { eventSequence = 0, conversation = undefined, force = false, attention = false, priority, trigger, changedFacts, resourceSightings } = {}, reuseWorldFacts = false) {
		validateRecord(record);
		if (!Number.isSafeInteger(eventSequence) || eventSequence < 0) throw new TypeError('eventSequence must be a nonnegative safe integer');
		if (force !== true && force !== false) throw new TypeError('force must be a boolean');
		const latest = this.#observations.get(record.agentId);
		if (!force && latest?.goalRevision === record.goalRevision && eventSequence <= latest.eventSequence) return false;
		const storedSequence = force && latest?.goalRevision === record.goalRevision
			? Math.max(eventSequence, latest.eventSequence)
			: eventSequence;
		const raw = mergeDeathObservation(observation ?? {}, this.#lastLive.get(record.agentId));
		// Keep one owned raw snapshot for both internal consumers. Public snapshot
		// methods still clone at their boundaries, so sharing here does not expose
		// mutable coordinator state while avoiding a duplicate deep copy per update.
		const storedObservation = structuredClone(raw);
		const program = this.#programRuns.get(record.agentId);
		// Remember invalidation even if the player returns before storage resolves.
		const lookupWorld = program?.noteLookupWorld;
		if (lookupWorld != null && (record.goalRevision !== program.goalRevision
			|| observationWorldId(storedObservation) !== lookupWorld.worldId || storedObservation.world?.dimension !== lookupWorld.dimension
			|| storedObservation.ready === false || storedObservation.death != null || storedObservation.status === 'PLAYER_DEAD' || storedObservation.player?.dead === true)) program.noteLookupInvalidated = true;
		const successor = program?.pendingSuccessor ?? program?.handoff;
		const queueWorld = successor?.world ?? program?.queueWorld;
		if (queueWorld != null && (record.goalRevision !== program.goalRevision
			|| !sameProgramWorld(storedObservation, queueWorld)
			|| (program.handoff && attention && priority === 'urgent'))) {
			program.queueAdmission = (program.queueAdmission ?? 0) + 1;
			program.pendingSuccessor = null;
			program.handoffInvalidated = 'SUCCESSOR_CONTEXT_CHANGED';
		}
		if (hasDurableObservationFacts(raw) && raw.ready !== false && raw.death == null && raw.status !== 'PLAYER_DEAD' && raw.player?.dead !== true) {
			this.#lastLive.set(record.agentId, {
				observation: storedObservation,
				eventSequence: storedSequence,
				goalRevision: record.goalRevision,
			});
		}
		const recovery = reuseWorldFacts ? this.#recovery.snapshot(record.agentId, raw) : this.#recovery.remember(record.agentId, record.goalRevision, raw);
		this.#memoryObservation?.(record, storedObservation, { owned: true, recoveryDeath: recovery?.lastDeath ?? null });
		// A quiet heartbeat is a new sighting. Ingest only its supplied spatial
		// facts (without a snapshot), so absent identities/properties keep their age.
		this.#rememberSpatial(record.agentId, storedObservation);
		const player = storedObservation.player;
		if (player?.skyOpen === true && player.onGround !== false && [player.x, player.y, player.z].every(Number.isFinite)) {
			this.#openSky.set(record.agentId, { x: player.x, y: player.y, z: player.z, dimension: storedObservation.world?.dimension ?? null });
		}
		this.#observations.set(record.agentId, {
			goalRevision: record.goalRevision,
			eventSequence: storedSequence,
			goal: record.currentGoal ?? null,
			goalSpec: record.currentGoalSpec ?? null,
			observation: storedObservation,
			...(conversation === undefined ? {} : { conversation: structuredClone(conversation) }),
		});
		// The bridge also wakes the planner after a receipt or an explicit sample.
		// Those empty deltas must not interrupt the routine that requested them.
		// Preserve real fact changes, explicit triggers, and urgent notifications.
		const administrativeWake = Array.isArray(changedFacts) && changedFacts.length === 0
			&& priority !== 'urgent' && (trigger === undefined || trigger === 'attention');
		this.#programExecutor.onObservation(record, { observation: storedObservation, eventSequence: storedSequence, attention: attention && !administrativeWake, ...(priority === undefined ? {} : { priority }), ...(trigger === undefined ? {} : { trigger }), ...(resourceSightings === undefined ? {} : { resourceSightings }) });
		// Reflexes first: a guard reads whether a reflex holds the body on this same sample.
		this.#considerReflexes(record, storedObservation);
		this.#clock.observe?.(storedObservation);
		this.#creditServerLag(record, storedObservation);
		this.#considerStandingOrders(record, storedObservation);
		return true;
	}

	/**
	 * Reuses durable facts when the actionable signature matches, but refreshes raw
	 * observations because clocks, effect durations, and cooldowns are excluded from it.
	 */
	refreshObservation(record, observation, { eventSequence = 0, conversation = undefined } = {}) {
		validateRecord(record);
		if (!Number.isSafeInteger(eventSequence) || eventSequence < 0) throw new TypeError('eventSequence must be a nonnegative safe integer');
		const latest = this.#observations.get(record.agentId);
		if (latest === undefined || latest.goalRevision !== record.goalRevision || eventSequence <= latest.eventSequence) return false;
		const stored = this.#storeObservation(record, observation, {
			eventSequence,
			conversation: conversation ?? latest.conversation,
		}, true);
		if (stored) this.#notePublishedSample(record);
		return stored;
	}

	snapshotLive(agentId) {
		const live = this.#lastLive.get(agentId);
		return live === undefined ? null : structuredClone(live);
	}

	hasStandingGuard(record) {
		return this.#standing.list(record.agentId).some(order => order.guard === true);
	}

	guardFeedback(record) {
		const feedback = this.#standing.feedback(record.agentId);
		const run = this.#programRuns.get(record.agentId);
		const active = this.#actions.get(record.agentId);
		return feedback && run?.standingGuard && active ? `${feedback}; ${run.standingOrder.id} running ${active.actionType}` : feedback;
	}
	standingGuardCoverage(record) { return this.#standing.guardCoverage(record.agentId); }

	/** The wake line for reflexes: installed rules and firing reports since the last wake (consumed here). */
	reflexReport(record) { return this.#reflexes.takeReport(record.agentId); }

	reflexList(record) { return this.#reflexes.list(record.agentId); }

	/** The mod's latest reflex firing reports (not consumed), for the wake filter. */
	reflexEvents(record) { return this.#reflexes.events(record.agentId); }

	/** Installed rule definitions with their live state, for the danger coverage lines. */
	reflexRules(record) { return this.#reflexes.rules(record.agentId); }

	/** Install, replace or remove reflex rules and send the complete set to the mod. Never moves the body by itself. */
	async #setReflexes(record, entries) {
		this.#assertCurrent(record);
		const { changed } = this.#reflexes.apply(record.agentId, entries);
		if (changed) await this.#sendReflexes(record);
		this.#trace('reflexes_set', { agentId: record.agentId, goalRevision: record.goalRevision, changed,
			entries: entries.map((entry) => entry.remove ? `-${entry.id}` : `${entry.id}:${entry.kind}:${entry.do.type}`) });
		return this.#reflexes.list(record.agentId);
	}

	async #sendReflexes(record, { yieldFiring = false } = {}) {
		await this.#bridge.send('reflex_update', record.agentId, this.#reflexes.payload(record.agentId, { yieldFiring }));
	}

	/** Read the mod's reflex report on a stored sample: re-send a set it lacks, and wake the model when a report asks to. */
	#considerReflexes(record, observation) {
		const { agentId } = record;
		if (observation?.ready === false) return;
		// Rules scoped to a context (lasts) end with it, and the default rules arm at spawn, respawn and a dimension change;
		// the new set goes to the mod at once.
		const stanceBefore = this.#reflexes.stance(agentId);
		const contextChanged = this.#reflexes.observeContext(agentId, observation);
		// A first stance (spawn) is not a change; a change with every stance rule replaced by the model still is one.
		const stance = this.#reflexes.stance(agentId);
		if (stanceBefore !== null && stance !== null && stance !== stanceBefore) this.#trace('stance_changed', { agentId, goalRevision: record.goalRevision, from: stanceBefore, stance, source: 'auto' });
		if (contextChanged) {
			this.#trace('reflexes_context_changed', { agentId, goalRevision: record.goalRevision, rules: this.#reflexes.list(agentId).map((row) => row.id) });
			void this.#sendReflexes(record).catch((error) => this.#trace('reflexes_send_failed', { agentId, reasonCode: error?.code ?? 'REFLEX_SEND_FAILED' }));
		}
		if (!this.#reflexes.has(agentId) && observation?.reflexes === undefined) return;
		const firingBefore = this.#reflexes.firing(agentId);
		const { events, wake, resend } = this.#reflexes.observe(agentId, observation?.reflexes);
		if (events.length > 0) this.#trace('reflexes_fired', { agentId, goalRevision: record.goalRevision, events: events.map((event) => `${event.id}:${event.outcome}`) });
		if (resend) void this.#sendReflexes(record).catch((error) => this.#trace('reflexes_send_failed', { agentId, reasonCode: error?.code ?? 'REFLEX_SEND_FAILED' }));
		this.#creditReflexTime(record, events);
		const stop = this.#reflexes.stopFiring(agentId);
		if (stop !== null) void this.#stopForReflex(record, stop).catch((error) => this.#trace('reflex_stop_failed', { agentId, id: stop, reasonCode: error?.code ?? 'REFLEX_STOP_FAILED' }));
		// A guard that waited for the firing gets its turn on the sample after the firing ends.
		if (firingBefore && !this.#reflexes.firing(agentId)) this.#reconsiderStandingOrders(record);
		if (!wake) return;
		const latest = this.#observations.get(agentId);
		if (latest?.goalRevision !== record.goalRevision) return;
		try {
			Promise.resolve(this.#onProgramEvent(record, { event: 'reflex_report', priority: 'ordinary', goalRevision: record.goalRevision,
				observation: structuredClone(latest.observation), eventSequence: latest.eventSequence }))
				.catch((error) => this.#trace('reflex_wake_failed', { code: error?.code ?? 'REFLEX_WAKE_FAILED' }));
		} catch (error) { this.#trace('reflex_wake_failed', { code: error?.code ?? 'REFLEX_WAKE_FAILED' }); }
	}

	/**
	 * A firing paused the program's action; the time it held the body is not the program's. The program's deadline and
	 * its work lease move out by that time (at most doubling the program's own timeoutMs).
	 */
	#creditReflexTime(record, events) {
		const pausedMs = events.filter((event) => REFLEX_HELD_OUTCOMES.has(event.outcome)).reduce((sum, event) => sum + event.ms, 0);
		if (pausedMs <= 0) return;
		const run = this.#programRuns.get(record.agentId);
		if (run?.state !== 'RUNNING' || run.goalRevision !== record.goalRevision || typeof this.#programExecutor.extendDeadline !== 'function') return;
		const credit = this.#programExecutor.extendDeadline(record.agentId, run.programId, pausedMs);
		if (!(credit > 0)) return;
		if (run.deadlineEpochMs != null) run.deadlineEpochMs += credit;
		run.releaseWork?.extend?.(credit);
		this.#trace('reflex_time_credited', { agentId: record.agentId, programId: run.programId, creditMs: credit });
	}

	/**
	 * The body counts its time limits in server ticks (GameClock), so on a lagging server its own timeout comes later in
	 * wall time. The program's deadline is wall time: it moves out by the wall time the server fell behind the game clock
	 * while the program ran, so the body's own timeout (with its facts) still comes before PROGRAM_DEADLINE. Both stamps
	 * come from the same server sample. Only spans in which the world ticked count: a frozen world (tick freeze) stops game
	 * time but not the server tick count the body reads. The shortfall is a running sum, so tick jitter cancels out and a
	 * fast server (/tick rate above 20) earns nothing. The credit has its own bound (three program timeouts).
	 */
	#creditServerLag(record, observation) {
		const run = this.#programRuns.get(record.agentId);
		if (this.#executorOnGameClock || run?.state !== 'RUNNING' || run.goalRevision !== record.goalRevision || typeof this.#programExecutor.extendDeadlineForLag !== 'function') return;
		const epochMs = observation?.observedAtEpochMs, gameTime = observation?.world?.gameTime;
		if (!Number.isFinite(epochMs) || !Number.isSafeInteger(gameTime)) return;
		const last = run.lagClock;
		// A sample from the same tick (an action result and a requested sample, or a death notice stamped with the last
		// live gameTime) keeps the old anchor, so the wall time before it still counts once the world ticks again. Only a
		// stall of a second or more with no tick re-anchors, as a frozen world. An out-of-order sample is ignored.
		if (last !== undefined && (epochMs < last.epochMs || (gameTime === last.gameTime && epochMs - last.epochMs < LAG_SAME_TICK_MS))) return;
		run.lagClock = { epochMs, gameTime, behindMs: last?.behindMs ?? 0, creditedMs: last?.creditedMs ?? 0 };
		if (last === undefined || gameTime <= last.gameTime) return;
		run.lagClock.behindMs += epochMs - last.epochMs - (gameTime - last.gameTime) * GAME_MS_PER_TICK;
		const due = Math.round(run.lagClock.behindMs - run.lagClock.creditedMs);
		if (due < LAG_CREDIT_MIN_MS) return;
		run.lagClock.creditedMs += due;
		const credit = this.#programExecutor.extendDeadlineForLag(record.agentId, run.programId, due);
		if (!(credit > 0)) return;
		if (run.deadlineEpochMs != null) run.deadlineEpochMs += credit;
		run.releaseWork?.extend?.(credit);
		this.#trace('lag_time_credited', { agentId: record.agentId, programId: run.programId, creditMs: credit, behindMs: run.lagClock.creditedMs });
	}

	/**
	 * A firing `stop` rule holds the body still; here the running program or action is cancelled, so the firing ends and
	 * its report wakes the model. Called once per firing.
	 */
	async #stopForReflex(record, ruleId) {
		const { agentId } = record;
		this.#trace('reflex_stop', { agentId, goalRevision: record.goalRevision, id: ruleId });
		const run = this.#programRuns.get(agentId);
		if (run !== undefined && run.goalRevision === record.goalRevision && !run.settled) {
			run.pendingSuccessor = null;
			await this.#cancelProgram(record, { kind: 'cancel_program', programId: run.programId, goalRevision: record.goalRevision });
			return;
		}
		const active = this.#actions.get(agentId);
		if (active !== undefined && active.goalRevision === record.goalRevision) {
			active.cancelledBy = `reflex:${ruleId}`;
			await this.#cancelAction(record, { actionId: active.actionId, goalRevision: active.goalRevision }, { invalidateProgram: false });
		}
	}

	hasProgram(record, programId) {
		const run = this.#programRuns.get(record.agentId);
		return run?.goalRevision === record.goalRevision && (programId === undefined || run.programId === programId);
	}

	programSnapshot(record, { presentDecision = false } = {}) {
		if (!this.hasProgram(record)) return null;
		return this.#programStatus(record, undefined, { deliverWarnings: false, presentDecision });
	}

	remindProgramDecision(record) { return this.#programExecutor.remindDecision?.(record) === true; }

	/** True while an action the model itself started (not one a program authored) owns the body. */
	hasModelAction(record) {
		const active = this.#actions.get(record.agentId);
		return active !== undefined && active.goalRevision === record.goalRevision && active.engineActionId === undefined;
	}

	/**
	 * The verb of the step that owns the body, or null: a do_step still running to its result, or the model's own long
	 * body action (however it was started). While one runs only surprises wake the model (wake-filter.mjs stepFolds).
	 */
	runningStep(record) {
		const step = this.#steps.get(record.agentId);
		if (step?.goalRevision === record.goalRevision) return step.verb;
		const run = this.#stepRuns.get(record.agentId);
		if (run?.goalRevision === record.goalRevision && this.#actions.get(record.agentId)?.actionId === run.actionId) return run.verb;
		const active = this.#actions.get(record.agentId);
		return active !== undefined && active.goalRevision === record.goalRevision && active.engineActionId === undefined && STEP_ACTIONS.has(active.actionType) ? active.actionType : null;
	}

	/**
	 * True while a find search (do_step find, or obtain's search for a source) drives the body: it answers the danger it
	 * can itself (search-danger.mjs), so the coordinator holds those steers (dynamic-main.mjs).
	 */
	searching(record) {
		return this.#blockingToolRuns.get(record.agentId)?.searching === true;
	}

	/**
	 * Obtain's low-health recovery state for the running blocking tool: 'armed' while a non-food obtain runs (it will eat
	 * or regenerate at low health itself), 'active' while it recovers, else null. dynamic-main folds the low-health wakes.
	 */
	recovering(record) {
		return this.#blockingToolRuns.get(record.agentId)?.recovering ?? null;
	}

	/** The body action this coordinator started, with the arguments it was authored with, or null. */
	runningAction(record) {
		const active = this.#actions.get(record.agentId);
		if (active === undefined || active.goalRevision !== record.goalRevision) return null;
		return { actionId: active.actionId, actionType: active.actionType, arguments: structuredClone(active.arguments) };
	}

	canPrepareProgram(record, programId, programVersion) {
		if (!this.hasProgram(record, programId)) return false;
		const status = this.#programStatus(record, programId);
		return status.state === 'RUNNING' && status.engineState === 'ACTIVE'
			&& status.programVersion === programVersion && status.decision == null;
	}

	/**
	 * Stops the running blocking tool for danger, or, given forkStop {reasonCode, message}, for that fork: the run is
	 * interruptedBy 'fork' and obtain ends with the stop's own code and line instead of DANGER.
	 */
	interruptBlockingTool(agentId, { armNext = false, forkStop = null } = {}) {
		if (forkStop === null) {
			this.#wakeProgramWaits(agentId, 'danger');
			// Advice must yield to danger before the asynchronous action interruption marker catches up.
			const action = this.#actions.get(agentId);
			if (action?.actionType === 'cast_obsidian') action.suppressCastResumeAdvice = true;
		}
		const run = this.#blockingToolRuns.get(agentId);
		if (run === undefined) {
			if (armNext && forkStop === null) this.#armedDangerInterrupts.add(agentId);
			return false;
		}
		// Danger outranks a fork: it replaces an earlier fork stop, and a later fork stop leaves it standing.
		if (forkStop === null) { run.interruptedBy = 'danger'; run.forkStop = null; }
		else if (run.interruptedBy !== 'danger') { run.interruptedBy = 'fork'; run.forkStop = { reasonCode: forkStop.reasonCode, message: forkStop.message ?? null }; }
		run.resolveInterruption();
		return true;
	}

	/** The danger steer that armed the next blocking tool reached the model (or its turn ended). */
	disarmBlockingInterrupt(agentId) {
		this.#armedDangerInterrupts.delete(agentId);
	}

	/**
	 * deliver: true marks a failed lastResult delivered now (tool results); false leaves it pending (internal reads).
	 * reservation: an object that receives the failure this view carries as `failure`, which stays pending until
	 * settleFailureDelivery(reservation.failure, accepted) reports whether the provider accepted the input.
	 */
	decorateObservation(record, observation = {}, { deliver = true, reservation = null } = {}) {
		validateRecord(record);
		const latest = this.#observations.get(record.agentId);
		const cached = latest?.goalRevision === record.goalRevision ? latest.observation : undefined;
		const live = this.#lastLive.get(record.agentId)?.observation;
		const source = resolveDecorateSource(observation, cached, live);
		// Cached and live snapshots share one owned raw object. Give callers an
		// isolated view when decoration falls back to either store (including death
		// merging), while the normal durable-observation path remains allocation-free.
		const ownedSource = source === cached || source === live || isSparseDeathObservation(observation)
			? structuredClone(source)
			: source;
		// Model input can await memory while newer observations arrive. Rendering
		// that older view must not rewind the gain-accounting inventory baseline.
		// Direct sparse death notifications still capture the last live inventory.
		if (isSparseDeathObservation(observation) && hasDurableObservationFacts(source)) {
			this.#recovery.remember(record.agentId, record.goalRevision, source);
		}
		// Exploration facts come from exploreFrontier on request, not from every observation.
		const view = composeTwoCallView(ownedSource, this.#recovery.snapshot(record.agentId, ownedSource), {
			agentId: record.agentId,
			goal: record.currentGoal ?? record.currentGoalSpec?.originalRequest ?? null,
		});
		const leftBehind = this.#placedWorkstations.leftBehind(record.agentId, view);
		const ownStairs = this.#dugStairs.near(record.agentId, view);
		const descent = this.#dugStairs.descent(record.agentId, view);
		// Explicit resource ids and words from the model's own active plan steps also select remembered sightings.
		const vocabulary = this.#planVocabulary?.(record, ownedSource?.world?.worldId ?? null) ?? null;
		const recentlySeen = this.#occupancy.recentlySeen?.(record.agentId, ownedSource, record, vocabulary);
		return this.#withLastFailure(record, deliver, reservation, { ...view, ...(leftBehind.length === 0 ? {} : { leftBehind }), ...(ownStairs.length === 0 ? {} : { ownStairs }), ...(descent === null ? {} : { descent }), ...(recentlySeen == null ? {} : { recentlySeen }) });
	}

	/**
	 * A failed last result reaches the model once in the shared failure format, with the runtime's own facts (changed,
	 * repeat) when it holds the receipt. Once delivered, by a direct tool result or an earlier view, later views keep
	 * only its identity and code instead of resending the same text.
	 */
	#withLastFailure(record, deliver, reservation, view) {
		const last = view?.lastResult;
		// Internal reads (frontier, sweeps, successor handoff) never reach the model, so they deliver nothing.
		if (!deliver || last?.present !== true || !isFailureResult(last)) return view;
		// The model already holds the action's handle; a view names only what ended and how.
		const identity = { actionType: last.actionType, state: last.state, reasonCode: last.reasonCode };
		// An input still in flight already carries it, like the assessment and conversation it travels with.
		const key = JSON.stringify([record.goalRevision, last.actionId]);
		if (reservation !== null && typeof last.actionId === 'string' && this.#failureSteers.get(record.agentId)?.get(key) !== 'settled') {
			let steers = this.#failureSteers.get(record.agentId);
			if (steers === undefined) this.#failureSteers.set(record.agentId, steers = new Map());
			const prior = steers.get(key);
			reservation.steer = { agentId: record.agentId, goalRevision: record.goalRevision, actionId: last.actionId,
				rejections: typeof prior === 'number' ? prior : 0 };
			steers.set(key, 'inflight');
			while (steers.size > 64) steers.delete(steers.keys().next().value);
		}
		if (this.#deliveredFailures.get(record.agentId)?.has(key)
			|| this.#reservedFailures.get(record.agentId)?.has(key)) return { ...view, lastResult: identity };
		if (reservation !== null) {
			reservation.failure = { agentId: record.agentId, goalRevision: record.goalRevision, actionId: last.actionId };
			let pending = this.#reservedFailures.get(record.agentId);
			if (pending === undefined) this.#reservedFailures.set(record.agentId, pending = new Map());
			pending.set(key, reservation.failure);
		}
		const receipt = this.#receipts.get(record.agentId)?.findLast((entry) => entry.actionId === last.actionId && entry.goalRevision === record.goalRevision);
		// The view names the action, so only tried is redundant. Without a receipt the change is unknown, never "nothing".
		const { tried: receiptTried, ...facts } = receipt?.failure ?? failureFacts({ code: last.reasonCode, blockedBy: typeof last.message === 'string' ? last.message : undefined,
			changed: failureChange({ executionStarted: last.executionStarted, physicalAttempted: last.physicalAttempted }) });
		// A wake may follow unrelated events in a fresh context that never saw the failed call.
		const request = this.#failedRequests.get(record.agentId)?.get(last.actionId);
		const tried = reservation === null ? undefined : receiptTried ?? (request?.goalRevision === record.goalRevision ? request.tried : undefined);
		if (reservation === null) this.#markFailureDelivered(record, last.actionId);
		return { ...view, lastResult: { ...identity, failure: tried === undefined ? facts : { tried, ...facts } } };
	}

	/**
	 * Whether a wake must still steer the model about this retained failure: not yet carried by an accepted steer and
	 * not already in flight. A rejected steer leaves it owed again.
	 */
	failureSteerOwed(record, lastResult) {
		if (!isFailureResult(lastResult) || typeof lastResult?.actionId !== 'string') return false;
		const state = this.#failureSteers.get(record.agentId)?.get(JSON.stringify([record.goalRevision, lastResult.actionId]));
		// A failure whose steers keep being rejected stays owed to the next turn's input but stops steering, on
		// changed and unchanged snapshots alike, so a turn that never accepts steers cannot become a steering loop.
		return state === undefined || (typeof state === 'number' && state < MAX_FAILURE_STEER_ATTEMPTS);
	}

	/**
	 * Counts a wake scheduled to steer about this failure. Counted at scheduling, not when its input is built, so an
	 * attempt rejected before the provider ever asked for its input still uses up a retry.
	 */
	noteFailureSteerAttempt(record, lastResult) {
		if (!this.failureSteerOwed(record, lastResult)) return;
		let steers = this.#failureSteers.get(record.agentId);
		if (steers === undefined) this.#failureSteers.set(record.agentId, steers = new Map());
		const key = JSON.stringify([record.goalRevision, lastResult.actionId]);
		const state = steers.get(key);
		steers.set(key, (typeof state === 'number' ? state : 0) + 1);
		while (steers.size > 64) steers.delete(steers.keys().next().value);
	}

	/** True once a steer carrying this failure was accepted by the provider for the current goal. */
	failureSteerSettled(record, actionId) {
		return typeof actionId === 'string'
			&& this.#failureSteers.get(record.agentId)?.get(JSON.stringify([record.goalRevision, actionId])) === 'settled';
	}

	/** Settles a steer token from decorateObservation: accepted settles the failure, rejected leaves it owed. */
	settleFailureSteer(token, accepted) {
		if (token === null || typeof token !== 'object') return;
		const steers = this.#failureSteers.get(token.agentId);
		const key = JSON.stringify([token.goalRevision, token.actionId]);
		if (steers?.get(key) !== 'inflight') return;
		// A rejection keeps the attempts counted at scheduling (at least this one), bounding retries (failureSteerOwed).
		steers.set(key, accepted ? 'settled' : Math.max(1, token.rejections ?? 0));
	}

	/** Settles a failure reserved by decorateObservation: accepted input delivers it; rejected input leaves it owed. */
	settleFailureDelivery(token, accepted) {
		if (token === null || typeof token !== 'object') return;
		const pending = this.#reservedFailures.get(token.agentId);
		const key = JSON.stringify([token.goalRevision, token.actionId]);
		if (pending?.get(key) !== token) return;
		pending.delete(key);
		if (pending.size === 0) this.#reservedFailures.delete(token.agentId);
		if (accepted) this.#markFailureDelivered(token, token.actionId);
	}

	/** A tool result that returns a terminal failed receipt to the model delivers that failure. */
	#noteFailureReturned(record, result) {
		const receipt = result?.state === 'IDLE' ? result.lastResult : result;
		if (isFailureResult(receipt) && typeof receipt.actionId === 'string' && receipt.goalRevision === record.goalRevision) this.#markFailureDelivered(record, receipt.actionId);
	}

	#markFailureDelivered(record, actionId) {
		let delivered = this.#deliveredFailures.get(record.agentId);
		if (delivered === undefined) this.#deliveredFailures.set(record.agentId, delivered = new Set());
		delivered.add(JSON.stringify([record.goalRevision, actionId]));
		while (delivered.size > 64) delivered.delete(delivered.values().next().value);
		const requests = this.#failedRequests.get(record.agentId);
		if (requests?.get(actionId)?.goalRevision === record.goalRevision) requests.delete(actionId);
	}

	hasCurrent(record) {
		const latest = this.#observations.get(record.agentId);
		return latest?.goalRevision === record.goalRevision;
	}

	latestObservation(record) {
		validateRecord(record);
		const latest = this.#observations.get(record.agentId);
		return latest?.goalRevision === record.goalRevision
			? { eventSequence: latest.eventSequence, observation: structuredClone(latest.observation) }
			: null;
	}

	async execute(request, record, { lifecycleGeneration = null } = {}) {
		validateRecord(record);
		validateRequest(request, record);
		if (lifecycleGeneration !== null && (!Number.isSafeInteger(lifecycleGeneration) || lifecycleGeneration < 0)) throw new TypeError('lifecycleGeneration must be a nonnegative safe integer or null');
		const idleSince = STOOD_STILL_KINDS.has(request.tool.kind) && request.tool.actionType !== 'chat'
			&& !this.#actions.has(record.agentId) && !this.#programRuns.has(record.agentId) ? this.#bodyIdleSince.get(record.agentId) : undefined;
		const arrivedAt = Date.now();
		try {
			let result = await this.#executeTool(request, record, lifecycleGeneration);
			if (idleSince !== undefined && result !== null && typeof result === 'object' && !Array.isArray(result)) result = { ...result, stoodStillMs: Math.max(0, arrivedAt - idleSince) };
			// These results report the latest program's end to the model.
			if (['program_status', 'respond_program', 'cancel_program'].includes(request.tool.kind) && result?.programId === this.#unreportedProgramEnds.get(record.agentId)?.programId
				&& this.#programRuns.get(record.agentId)?.programId !== result.programId) this.#unreportedProgramEnds.delete(record.agentId);
			return result;
		} catch (error) {
			if (HANDLE_CONTRACT_CODES.has(error?.code) && error.current === undefined) {
				try { error.current = this.#currentHandles(record, { actionId: request.tool.actionId }); } catch { /* the rejection itself stays authoritative */ }
			}
			if (error !== null && typeof error === 'object' && error.failure === undefined && typeof error.code === 'string') {
				// The ledger makes repeated rejections visible like body failures.
				const latest = this.#observations.get(record.agentId);
				const repeat = this.#repeatedFailures.record(record.agentId, { goalRevision: record.goalRevision, actionType: request.tool.actionType ?? request.tool.kind,
					arguments: request.tool.arguments ?? null, state: 'FAILED', reasonCode: error.code, ...this.#failureStamp(latest?.goalRevision === record.goalRevision ? latest.observation : null) });
				// A publication failure carries the actionId it may already have sent.
				error.failure = failureFacts({ code: error.code, changed: error.actionId === undefined ? 'nothing' : 'unknown', blockedBy: String(error.message ?? '').slice(0, 512), repeat: repeat ?? undefined });
			}
			throw error;
		}
	}

	/**
	 * Compact current handles after a rejected handle or ownership request: who owns the body, the exact
	 * program/decision/action handles and the operations they accept now. Facts only; it chooses nothing.
	 */
	#currentHandles(record, { actionId } = {}) {
		const current = { goalRevision: record.goalRevision, body: 'free' };
		const run = this.#programRuns.get(record.agentId);
		if (run?.goalRevision === record.goalRevision) {
			const status = this.#programStatus(record, run.programId);
			const decision = status.decision == null ? null : { decisionId: status.decision.decisionId, eventSequence: status.decision.eventSequence, trigger: status.decision.trigger, directives: status.decision.directives };
			current.body = 'program';
			current.program = { programId: run.programId, state: status.state, ...(status.programVersion === undefined ? {} : { programVersion: status.programVersion }), ...(decision === null ? {} : { decision }) };
		} else {
			const ended = this.#programResults.get(record.agentId);
			if (ended?.goalRevision === record.goalRevision) current.program = { programId: ended.programId, state: ended.state, reasonCode: ended.reasonCode };
		}
		const active = this.#actions.get(record.agentId);
		if (active?.goalRevision === record.goalRevision) {
			const status = this.#actionStatus(record, active.actionId);
			if (active.engineActionId === undefined || run?.goalRevision !== record.goalRevision) current.body = 'action';
			current.action = { actionId: active.actionId, actionType: active.actionType, state: status.state };
		} else {
			const latest = this.#receipts.get(record.agentId)?.findLast(entry => entry.goalRevision === record.goalRevision && entry.actionType !== 'chat');
			const receipt = typeof actionId === 'string' ? this.#actionStatus(record, actionId) : latest;
			if (receipt !== undefined && receipt.state !== 'UNKNOWN_ACTION') current.action = { actionId: receipt.actionId, ...(receipt.actionType === undefined ? {} : { actionType: receipt.actionType }), state: receipt.state, ...(receipt.reasonCode === undefined ? {} : { reasonCode: receipt.reasonCode }) };
		}
		const next = [];
		const actionHandle = { actionId: current.action?.actionId, goalRevision: record.goalRevision };
		for (const [name, kind] of [['actionStatus', 'action_status'], ['cancelAction', 'cancel_action'], ['replaceAction', 'replace_action']]) {
			if (this.#operationRejection(record, { ...actionHandle, kind, actionType: 'fight_target' }) === null) next.push(name);
		}
		if (current.program?.decision !== undefined && current.program.decision.directives.length > 0) next.push('respondProgram');
		for (const [name, kind] of [['programStatus', 'program_status'], ['cancelProgram', 'cancel_program']]) {
			if (this.#operationRejection(record, { kind, programId: current.program?.programId, goalRevision: record.goalRevision }) === null) next.push(name);
		}
		if (next.length > 0) current.next = next;
		return current;
	}

	#operationRejection(record, tool) {
		const { agentId } = record;
		return nativeOperationRejection({ goalRevision: record.goalRevision, program: this.#programRuns.get(agentId),
			action: [this.#actions.get(agentId), this.#communications.get(agentId)].find(entry => entry?.actionId === tool.actionId),
			terminal: this.#actions.has(agentId) ? null : this.#terminalActionReceipt(record, tool.actionId, tool.goalRevision),
			finishing: this.#sequenceFinishReservations.has(agentId), sweeping: this.#sweeps.has(agentId),
			blocking: this.#blockingToolRuns.has(agentId), completing: this.#completions.has(agentId),
			pausedReplacement: this.#dangerActionWhilePaused(tool, record),
		}, tool);
	}

	/** respondProgram refuses continue/replace while the model's own fight/flee taken under the paused program owns the body. */
	#dangerActionHoldsPausedProgram(record) {
		return this.#actions.get(record.agentId)?.pausedProgram === true;
	}

	async #executeTool(request, record, lifecycleGeneration) {
		if (request.tool.step !== undefined) return this.#executeStep(request, record, lifecycleGeneration);
		if (request.tool.inspectAfter !== undefined) {
			// The model's follow-up read, taken once the body work has ended. A call still running (interrupted by
			// danger) returns without it: the model decides about the body first.
			const { inspectAfter, ...tool } = request.tool;
			const result = await this.#executeTool({ ...request, tool }, record, lifecycleGeneration);
			if (result === null || typeof result !== 'object' || result.state === 'RUNNING' || result.state === 'PREPARING') return result;
			let inspected;
			try { inspected = { state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await this.#inspect(inspectAfter, record) }; }
			catch (error) { inspected = { state: 'FAILED', reasonCode: error?.code ?? 'INSPECTION_FAILED', message: String(error?.message ?? error).slice(0, 512) }; }
			return { ...result, inspected };
		}
		if (request.tool.reflexes !== undefined && REFLEX_CARRIER_KINDS.has(request.tool.kind)) {
			// Rules first, as a rules-only runProgram followed by this call would: a direct command then yields any firing.
			const { reflexes: entries, ...tool } = request.tool;
			const reflexes = await this.#setReflexes(record, entries);
			let result;
			try { result = await this.#executeTool({ ...request, tool }, record, lifecycleGeneration); }
			catch (error) { throw Object.assign(error, { reflexes }); }
			return result !== null && typeof result === 'object' ? { ...result, reflexes } : result;
		}
		// Every leg's handle names its keepGoing chain, so status, cancel, replace and after reach the leg running now.
		request = this.#withLegChainHandle(record, request);
		if (GUARD_OVERRIDE_KINDS.has(request.tool.kind) && request.tool.actionType !== 'chat' && this.#programRuns.get(record.agentId)?.standingGuard === true) {
			await this.#yieldStandingGuard(record);
		}
		if (REFLEX_YIELD_KINDS.has(request.tool.kind) && request.tool.actionType !== 'chat' && this.#reflexes.firing(record.agentId)) {
			const epoch = this.#executionEpoch(record.agentId);
			await this.#sendReflexes(record, { yieldFiring: true });
			// A death or a new goal during the yield ends this call: nothing may dispatch onto a body that is no longer this one.
			if (this.#executionEpoch(record.agentId) !== epoch) throw codedError('STALE_NATIVE_TOOL', 'Lifecycle changed while the reflex yielded the body');
		}
		if (request.tool.kind === 'reflexes') return { state: 'REFLEXES', reflexes: await this.#setReflexes(record, request.tool.reflexes) };
		if (request.tool.kind === 'observe') return this.#observe(record);
		if (request.tool.kind === 'task_plan') {
			if (this.#taskPlan === null) throw codedError('PLAN_UNAVAILABLE', 'Task planning view is unavailable');
			return this.#taskPlan(record, request.tool);
		}
		if (request.tool.kind === 'inspect') return this.#inspect(request.tool, record);
		if (request.tool.kind === 'capabilities') {
			if (request.tool.section === 'howto') {
				const placedStations = [...this.#placedWorkstations.rows(record.agentId), ...(this.#knownStations?.(record) ?? [])];
				return howto(request.tool.topic, howtoHoldings({ observation: this.#observations.get(record.agentId)?.observation ?? null, placedStations }), { offset: request.tool.offset ?? 0 });
			}
			if (['program', 'control', 'strategy'].includes(request.tool.section)) return { ...minecraftCapabilities(request.tool), ...await this.#executionMetadata(record) };
			return { ...minecraftCapabilities(), ...await this.#executionMetadata(record), ...await this.#memorySummary(record), runtime: { freshObservations: this.#requestObservation !== null, focusedInspection: this.#inspectObservation !== null, notebook: this.#notebook !== null || this.#memoryOperation !== null, asynchronousActions: true, cancellation: true, reactivePrograms: { available: true, background: true, engine: 'ArenaScript', modelAuthored: true, plannerCalls: false } } };
		}
		if (request.tool.kind === 'action_status') {
			const status = this.#actionStatus(record, request.tool.actionId);
			this.#noteFailureReturned(record, status);
			return status;
		}
		if (request.tool.kind === 'program_status') return this.#programStatus(record, request.tool.programId);
		if (request.tool.kind === 'queue_program') return this.#queueProgram(request, record);
		if (request.tool.kind === 'cancel_queued_program') return this.#cancelQueuedProgram(record, request.tool);
		if (request.tool.kind === 'cancel_program') return this.#cancelProgram(record, request.tool);
		if (request.tool.kind === 'standing_order') return this.#standingOrder(request, record);
		if (request.tool.kind === 'respond_program') {
			const run = this.#programRuns.get(record.agentId);
			const answered = this.#programExecutor.status?.(record)?.decision;
			await this.#programExecutor.respond(record, request.tool, { pausedAction: this.#dangerActionHoldsPausedProgram(record) });
			this.#trace('native_program_responded', { agentId: record.agentId, goalRevision: record.goalRevision, programId: request.tool.programId,
				directive: request.tool.directive, trigger: answered?.trigger ?? null,
				...(request.tool.directive === 'replace' ? programSourceSummary(request.tool.source) : {}) });
			if (run && ['replace', 'pause', 'finish'].includes(request.tool.directive)) run.pendingSuccessor = null;
			if (['pause', 'finish'].includes(request.tool.directive)) await run.result;
			return { ...this.#programStatus(record, request.tool.programId),
				...(answered?.resourceSightings?.length ? { resourceSightings: answered.resourceSightings } : {}) };
		}
		if (request.tool.kind === 'cancel_action') return this.#cancelAction(record, request.tool);
		if (request.tool.kind === 'notebook' || request.tool.kind === 'query_memory' || request.tool.kind === 'task_memory') return this.#memory(request, record);
		if (request.tool.after !== undefined) return this.#executeAfter(request, record, lifecycleGeneration);
		if (request.tool.kind === 'action' && request.tool.actionType === 'chat') return this.#executeAction(request, record, request.tool);
		if (request.tool.kind === 'replace_action') {
			const rejected = this.#operationRejection(record, request.tool);
			if (rejected !== null) throw codedError(rejected.code, rejected.message);
			// Yield before the cancel: otherwise the reflex holding the body keeps it, or default defend takes the body in the
			// idle gap the cancel leaves, and the replacement starts paused under it. Each path yields only once the replace
			// is certain to go on (past every refusal), so a refused replace ends no firing.
			// A failed yield is traced, never thrown: the old action may already be cancelled, and the replacement must still run.
			const yieldFiring = request.tool.actionType === 'chat' ? null
				: () => (this.#reflexes.firing(record.agentId) ? this.#sendReflexes(record, { yieldFiring: true })
					.catch((error) => this.#trace('reflexes_send_failed', { agentId: record.agentId, path: 'replace_action', reasonCode: error?.code ?? 'REFLEX_SEND_FAILED' }))
					: Promise.resolve());
			this.#answerLegChain(record, request.tool.actionId);
			const pausedProgram = this.#programRuns.has(record.agentId);
			const interrupted = pausedProgram ? this.#interruptedPausedDangerAction(record) : null;
			if (interrupted !== null) return this.#withBlockingToolRun(record, run => this.#replaceInterruptedDangerAction(request, record, { ...request.tool, kind: 'action' }, interrupted, run, { pausedProgram, yieldFiring }));
			const previous = this.#actions.has(record.agentId) ? null : this.#terminalActionReceipt(record, request.tool.actionId, request.tool.goalRevision);
			if (previous !== null) return this.#startReplacementAsNewAction(request, record, previous, { pausedProgram, yieldFiring });
			return this.#withBlockingToolRun(record, run => this.#replaceAction(request, record, run, yieldFiring));
		}
		// keepGoing runs until the model's reply: its next body call stops the running leg first, then runs as asked.
		// Only an unanswered leg awaits here, so every other call keeps its exact dispatch timing.
		const endedLeg = this.#legChainOwnsBody(record, request.tool) ? await this.#endLegChainForReply(record, request.tool) : null;
		if (endedLeg !== null) {
			const result = await this.#executeTool(request, record, lifecycleGeneration);
			return result !== null && typeof result === 'object' ? { ...result, replacedAction: endedLeg } : result;
		}
		if (request.tool.keepGoing === true) return this.#executeKeepGoing(request, record, lifecycleGeneration);
		if (this.#sequenceFinishReservations.has(record.agentId)) throw codedError('NATIVE_ACTION_IN_PROGRESS', 'A finishing native sequence owns the player until its fresh sample and goal verification settle');
		if (this.#sweeps.has(record.agentId)) throw codedError('NATIVE_ACTION_IN_PROGRESS', 'A camera sweep owns this player until sampling completes');
		if (this.#programRuns.has(record.agentId)) {
			if (this.#dangerActionWhilePaused(request.tool, record)) {
				const interruptedHere = this.#interruptedPausedDangerAction(record);
				if (interruptedHere !== null) {
					// The model's own paused-program fight/flee was interrupted by danger: switch it by its exact handle.
					const switchTool = { ...request.tool, kind: 'action' };
					return this.#withBlockingToolRun(record, (run) => this.#replaceInterruptedDangerAction(request, record, switchTool, interruptedHere, run, { pausedProgram: true }));
				}
				const tool = { ...request.tool, kind: 'action' };
				const execute = () => this.#executeAction(request, record, tool, null, request.tool.kind !== 'start_action', null, null, { pausedProgram: true });
				return request.tool.kind === 'action' ? this.#withBlockingToolRun(record, execute) : execute();
			}
			if (isWaitTool(request.tool)) return this.#waitOnProgram(record, request.tool.arguments.durationMs);
			const tail = this.#programRuns.get(record.agentId);
			if (tail?.planningNoticed === true && tail.standingGuard !== true && this.canPrepareProgram(record, tail.programId, this.#programStatus(record, tail.programId).programVersion)) {
				const predecessor = await this.#awaitProgramTail(record, tail);
				if (predecessor.started) {
					const result = await this.#executeTool(request, record, lifecycleGeneration);
					return result !== null && typeof result === 'object' ? { ...result, predecessor: predecessor.predecessor } : result;
				}
				return predecessor.result;
			}
			throw codedError('NATIVE_PROGRAM_IN_PROGRESS', 'A model-authored program owns this player; use programStatus and cancelProgram before issuing another body operation (fight_target/flee_from are allowed while it is paused for your decision)');
		}
		if (isWaitTool(request.tool)) {
			// A background program reported as just started can end before this turn's wait arrives; its end
			// event is still queued behind the turn, so the wait reports it instead of idling the body.
			const ended = this.#unreportedProgramEnds.get(record.agentId);
			if (ended?.goalRevision === record.goalRevision && ended.turnId === request.turnId) {
				this.#unreportedProgramEnds.delete(record.agentId);
				return { state: 'SUCCEEDED', reasonCode: 'PROGRAM_ENDED', waitedMs: 0, program: this.#programStatus(record, ended.programId) };
			}
		}
		if (request.tool.kind === 'run_program') {
			this.#unreportedProgramEnds.delete(record.agentId);
			// Rules first, so the program starts with its reflexes already armed.
			const reflexes = request.tool.reflexes === undefined ? null : await this.#setReflexes(record, request.tool.reflexes);
			if (reflexes === null) return this.#runProgram(request, record);
			const result = await this.#runProgram(request, record);
			return result !== null && typeof result === 'object' ? { ...result, reflexes } : result;
		}
		if (request.tool.kind === 'start_action') return this.#executeAction(request, record, { ...request.tool, kind: 'action' }, null, false);
		if (request.tool.kind === 'finish') return this.#finish(request, record, lifecycleGeneration);
		if (request.tool.kind === 'explore_frontier') return this.#exploreFrontier(request, record);
		const tool = constrainGoalBoundNavigation(request.tool, record.currentGoalSpec);
		if (tool.kind === 'sequence') return this.#withBlockingToolRun(record,
			(run) => this.#executeSequence({ ...request, tool }, record, this.#executionEpoch(record.agentId), lifecycleGeneration, run));
		if (tool.kind === 'gather') return this.#withBlockingToolRun(record, (run) => this.#executeGather(request, record, tool, this.#executionEpoch(record.agentId), run));
		if (tool.kind === 'find') return this.#withBlockingToolRun(record, (run) => this.#executeFind(request, record, tool, this.#executionEpoch(record.agentId), run));
		if (tool.kind === 'obtain') return this.#withBlockingToolRun(record, (run) => this.#executeObtain(request, record, tool, this.#executionEpoch(record.agentId), run));
		if (tool.kind === 'repair_inventory') return this.#withBlockingToolRun(record, async run => {
			const epoch = this.#executionEpoch(record.agentId);
			const current = () => this.#executionEpoch(record.agentId) === epoch;
			let ordinal = 0;
			return runInventoryRepair(tool.arguments, {
				stopped: () => !current(), interrupted: () => run.interruptedBy !== null,
				inspect: async query => {
					if (!current()) throw codedError('NATIVE_ACTION_CANCELLED', 'Repair inspection outlived its lifecycle');
					const result = await this.#inspect({ kind: 'inspect', ...query }, record, { withSearch: false });
					if (!current()) throw codedError('NATIVE_ACTION_CANCELLED', 'Repair inspection outlived its lifecycle');
					return result;
				},
				act: async args => {
					if (!current()) throw codedError('NATIVE_ACTION_CANCELLED', 'Repair cancelled before click');
					if (run.interruptedBy !== null) return { state: 'INTERRUPTED', reasonCode: 'DANGER' };
					return this.#executeAction(request, record, normalizeMinecraftToolCall('act', { actionType: 'menu_click', arguments: args }), ++ordinal);
				},
			});
		});
		if (tool.kind === 'lookAround') {
			const reused = this.#recentSweep(record, tool);
			if (reused !== null) return reused;
			return this.#withBlockingToolRun(record, async (run) => {
				const sweep = {};
				this.#sweeps.set(record.agentId, sweep);
				try {
					const result = await this.#executeLookAround(request, record, tool, this.#executionEpoch(record.agentId), run);
					const at = gatherBodyAt(this.#observations.get(record.agentId)?.observation ?? {});
					if (result?.state === 'SUCCEEDED' && at !== null) this.#lastSweeps.set(record.agentId, { goalRevision: record.goalRevision, at: this.#clock.now(), from: at, key: sweepKey(tool), result });
					return result;
				}
				finally { if (this.#sweeps.get(record.agentId) === sweep) this.#sweeps.delete(record.agentId); }
			});
		}
		if (tool.kind !== 'action') throw codedError('INVALID_NATIVE_TOOL', 'Native tool did not normalize to an action');
		if (['fight_target', 'flee_from'].includes(tool.actionType)) {
			const interrupted = this.#actions.get(record.agentId);
			if (interrupted?.interruptedBy === 'danger') {
				return this.#withBlockingToolRun(record, (run) => this.#replaceInterruptedDangerAction(request, record, tool, interrupted, run));
			}
		}
		return tool.actionType === 'chat'
			? this.#executeAction(request, record, tool)
			: this.#withBlockingToolRun(record, () => this.#executeAction(request, record, tool));
	}

	/**
	 * One do_step: carried reflexes are armed first (as on act), then the step's call runs exactly as the model could have
	 * made it. Only an admitted background step (its action running) becomes the current intent, tied to that action id,
	 * and only that id's intent is retired when the step ends (its keepGoing legs included). A rejected step, or one not
	 * started after its predecessor, leaves the running step's intent alone. gather, craft and smelt end inside this call.
	 */
	async #executeStep(request, record, lifecycleGeneration) {
		const { step, reflexes: entries, ...tool } = request.tool;
		const reflexes = entries === undefined ? null : await this.#setReflexes(record, entries);
		const background = tool.kind === 'start_action';
		const entry = { goalRevision: record.goalRevision, verb: step.verb, ...(step.seen === undefined ? {} : { seen: step.seen }), intentId: null, actionId: null, seenWoken: false };
		if (!background) this.#steps.set(record.agentId, entry);
		// An emergency arrives mid-step (drowning under a dig, a skeleton during travel): escape stops the running body
		// action itself instead of being refused as busy, which would cost the model a cancel call first.
		// As replaceAction: the cancel must end the old action, and a lifecycle change during it (death, a new goal) stops
		// the escape from starting on a body that is no longer this one. The dispatch path yields a firing reflex itself.
		const running = step.verb === 'escape' && !this.#programRuns.has(record.agentId) && !this.#legChainOwnsBody(record, tool) ? this.#actions.get(record.agentId) : undefined;
		let replaced = null;
		if (running !== undefined && running.goalRevision === record.goalRevision && running.cancelling !== true && running.engineActionId === undefined) {
			const expectedEpoch = this.#actionCancellationEpoch(record, running);
			const cancelled = await this.#cancelAction(record, { kind: 'cancel_action', actionId: running.actionId, goalRevision: running.goalRevision });
			if (this.#executionEpoch(record.agentId) !== expectedEpoch) throw codedError('STALE_NATIVE_TOOL', 'Lifecycle changed while stopping the step escape replaces');
			if (!TERMINAL_ACTION_STATES.has(cancelled.state)) throw codedError('CANCEL_ACK_UNCONFIRMED', 'escape needs the running step to be stopped first');
			replaced = replacementReceipt(cancelled, running.actionId);
		}
		let result;
		try { result = await this.#executeTool({ ...request, tool }, record, lifecycleGeneration); }
		catch (error) { throw reflexes === null ? error : Object.assign(error, { reflexes }); }
		finally { if (this.#steps.get(record.agentId) === entry) this.#steps.delete(record.agentId); }
		if (result === null || typeof result !== 'object') return result;
		const admitted = background && RUNNING_ACTION_STATES.has(result.state) && typeof result.actionId === 'string';
		if (admitted) await this.#beginStep(record, entry, result.actionId, step);
		const { seen: _seen, ...shown } = step;
		return { ...result, step: { ...shown, ...(admitted ? { started: true, next: STEP_RUNNING_NOTE } : {}) }, ...(reflexes === null ? {} : { reflexes }), ...(replaced === null ? {} : { replacedAction: replaced }) };
	}

	async #beginStep(record, entry, actionId, step) {
		entry.intentId = actionId;
		entry.actionId = actionId;
		this.#stepRuns.set(record.agentId, entry);
		if (this.#taskPlan !== null) {
			// No world observation yet or no goal: the step still runs; the intent is only its label.
			try { await this.#taskPlan(record, { kind: 'task_plan', operation: 'intent', actionId, intent: { step: step.verb, why: step.why, ...(step.until === undefined ? {} : { until: step.until }) } }); }
			catch { /* the intent is presentation; the body call decides the result */ }
		}
		this.#watchStepEnd(record, entry);
	}

	/** Follows the step's action (and each keepGoing leg after it) and retires the step when the last one ends. */
	#watchStepEnd(record, entry) {
		const active = this.#actions.get(record.agentId);
		if (active === undefined || active.actionId !== entry.actionId || active.goalRevision !== entry.goalRevision) { void this.#retireStep(record, entry); return; }
		active.result.then(async () => {
			// A keepGoing chain decides its next leg from this leg's result; the step goes on while a leg of its chain runs.
			if (active.legChain !== undefined) await active.legChain.decision;
			const next = this.#actions.get(record.agentId);
			if (active.legChain !== undefined && next?.legChain === active.legChain && next.actionId !== active.actionId) {
				entry.actionId = next.actionId;
				this.#watchStepEnd(record, entry);
				return;
			}
			await this.#retireStep(record, entry);
		}, () => this.#retireStep(record, entry));
	}

	async #retireStep(record, entry) {
		if (this.#stepRuns.get(record.agentId) === entry) this.#stepRuns.delete(record.agentId);
		if (this.#taskPlan === null || entry.intentId === null) return;
		try { await this.#taskPlan(record, { kind: 'task_plan', operation: 'retire_intent', actionId: entry.intentId }); }
		catch { /* a changed goal already retired it */ }
	}

	/**
	 * The block a running step's until "seen:<id>" names, the first time a sample shows it, for a verb whose body does not
	 * stop itself on it (travel_to and dig_to do, with TARGET_SEEN). Null otherwise; reports each step's sighting once.
	 */
	stepSighting(record, observation) {
		const entry = this.#stepRuns.get(record.agentId);
		if (entry?.goalRevision !== record.goalRevision || entry.seen === undefined || entry.seenWoken || BODY_SEEN_VERBS.has(entry.verb)) return null;
		if (observation?.continuity?.rememberedSections?.includes('blocks')) return null;
		const shown = [...(observation?.blocks ?? []), ...(observation?.landmarks ?? [])].some((row) => row?.blockId === entry.seen && row.visible !== false && row.remembered !== true);
		if (!shown) return null;
		entry.seenWoken = true;
		return entry.seen;
	}

	/** The request with any earlier keepGoing leg handle mapped to the leg running now (or the chain's last leg). */
	#withLegChainHandle(record, request) {
		const chain = this.#legChains.get(record.agentId);
		if (chain === undefined || chain.goalRevision !== record.goalRevision) return request;
		const tool = request.tool;
		const field = tool.after !== undefined ? 'after' : ['action_status', 'cancel_action', 'replace_action'].includes(tool.kind) ? 'actionId' : null;
		if (field === null || !chain.ids.has(tool[field])) return request;
		return tool[field] === chain.currentId ? request : { ...request, tool: { ...tool, [field]: chain.currentId } };
	}

	/** Accepted controls stop continuation before any asynchronous cancellation or predecessor wait. */
	#answerLegChain(record, actionId) {
		const chain = this.#legChains.get(record.agentId);
		if (chain?.goalRevision === record.goalRevision && chain.ids.has(actionId)) chain.replied = true;
	}

	/**
	 * The model's next body call while its keepGoing leg runs: that leg stops (acknowledged) and the call runs as asked.
	 * Returns the stopped leg's receipt, or null when no unanswered keepGoing leg owns the body.
	 */
	#legChainOwnsBody(record, tool) {
		if (!STOOD_STILL_KINDS.has(tool.kind) || tool.actionType === 'chat') return false;
		const active = this.#actions.get(record.agentId);
		const chain = this.#legChains.get(record.agentId);
		return active !== undefined && chain !== undefined && active.legChain === chain && !chain.replied && active.goalRevision === record.goalRevision;
	}

	async #endLegChainForReply(record, tool) {
		if (!this.#legChainOwnsBody(record, tool)) return null;
		const active = this.#actions.get(record.agentId);
		const chain = this.#legChains.get(record.agentId);
		chain.replied = true;
		const expectedEpoch = this.#actionCancellationEpoch(record, active);
		const cancelled = await this.#cancelAction(record, { actionId: active.actionId, goalRevision: record.goalRevision });
		if (this.#executionEpoch(record.agentId) !== expectedEpoch) throw codedError('STALE_NATIVE_TOOL', 'Lifecycle changed while stopping the keepGoing leg');
		if (!TERMINAL_ACTION_STATES.has(cancelled.state)) throw codedError('CANCEL_ACK_UNCONFIRMED', 'The keepGoing leg must stop before this call runs');
		this.#trace('native_keep_going_replied', { agentId: record.agentId, goalRevision: record.goalRevision, actionId: active.actionId, legs: chain.legs, state: cancelled.state });
		return replacementReceipt(cancelled, active.actionId);
	}

	/**
	 * act/startAction with after: wait for that handle to end, then run this action only if it succeeded. The body
	 * works while the model decides the next step; danger during the wait returns before anything starts.
	 */
	async #executeAfter(request, record, lifecycleGeneration) {
		const expectedEpoch = this.#executionEpoch(record.agentId);
		const { after, ...tool } = request.tool;
		const active = this.#actions.get(record.agentId);
		let predecessor;
		let resolved = null;
		if (active?.actionId === after && active.goalRevision === record.goalRevision) {
			if (active.engineActionId !== undefined) throw codedError('STALE_ACTION', `after:${after} names a program action; queue work after a program with queueProgram`);
			this.#answerLegChain(record, after);
			const settled = await this.#awaitPredecessor(record, active);
			if (settled.type === 'error') throw settled.error;
			if (settled.type === 'interruption') {
				const status = this.#actionStatus(record, after);
				if (RUNNING_ACTION_STATES.has(status.state)) {
					return { state: 'NOT_STARTED', reasonCode: 'AFTER_INTERRUPTED', interruptedBy: 'danger', predecessor: status,
						recoveryHint: `${tool.actionType} did not start. replaceAction with actionId ${after} and your authored fight_target/flee_from switches now; cancelAction with the same actionId stops it.` };
				}
				predecessor = status;
			} else {
				resolved = settled.value;
				predecessor = { actionId: after, actionType: active.actionType, ...settled.value };
			}
		} else {
			const receipt = this.#terminalActionReceipt(record, after, record.goalRevision);
			if (receipt === null) throw codedError('STALE_ACTION', `after:${after} is neither the running body action nor the latest ended one`);
			this.#answerLegChain(record, after);
			predecessor = structuredClone(receipt);
		}
		if (predecessor.state === 'SUCCEEDED') {
			if (this.#executionEpoch(record.agentId) !== expectedEpoch) throw codedError('STALE_NATIVE_TOOL', 'Lifecycle changed while waiting for the predecessor');
			const result = await this.#executeTool({ ...request, tool }, record, lifecycleGeneration);
			const summary = { actionId: predecessor.actionId, actionType: predecessor.actionType, state: predecessor.state, reasonCode: predecessor.reasonCode,
				...(predecessor.durationMs === undefined ? {} : { durationMs: predecessor.durationMs }) };
			return result !== null && typeof result === 'object' ? { ...result, predecessor: summary } : result;
		}
		// The failure reaches the model here, with fresh facts, instead of as a later event.
		if (isFailureResult(predecessor)) this.#markFailureDelivered(record, after);
		this.#trace('native_after_not_started', { agentId: record.agentId, goalRevision: record.goalRevision, after, actionType: tool.actionType, predecessorState: predecessor.state, reasonCode: predecessor.reasonCode ?? null });
		const { source: _source, ...receipt } = predecessor;
		return this.#withPostAction(record, { state: 'NOT_STARTED', reasonCode: 'PREDECESSOR_NOT_SUCCEEDED', predecessor: receipt,
			message: `${tool.actionType} was not started because ${after} ended ${predecessor.state}${predecessor.reasonCode ? ` ${predecessor.reasonCode}` : ''}; decide from these facts.` },
		this.#executionEpoch(record.agentId), resolved);
	}

	/** The predecessor's terminal result, or a danger interruption of this wait (as a blocking body tool sees one). */
	#awaitPredecessor(record, active) {
		const settle = (interruption) => Promise.race([
			active.result.then((value) => ({ type: 'result', value }), (error) => ({ type: 'error', error })),
			interruption.then(() => ({ type: 'interruption' })),
		]);
		const existing = this.#blockingToolRuns.get(record.agentId);
		return existing === undefined ? this.#withBlockingToolRun(record, (run) => settle(run.interruption)) : settle(existing.interruption);
	}

	/**
	 * keepGoing: run the leg as asked; each time a leg succeeds with progress, the same leg starts again at once, so the
	 * body keeps going while the model reads the result. The chain ends at the model's next body call, cancelAction,
	 * replaceAction or after; at a leg that sees its requested target, fails, is interrupted or makes no progress;
	 * or after MAX_KEEP_GOING_LEGS.
	 */
	async #executeKeepGoing(request, record, lifecycleGeneration) {
		const { keepGoing: _keepGoing, ...tool } = request.tool;
		const chain = { goalRevision: record.goalRevision, ids: new Set(), currentId: null, legs: 0, replied: false, ended: null, decision: Promise.resolve(),
			record, request: { ...request, tool: { kind: 'action', actionType: tool.actionType, arguments: structuredClone(tool.arguments) } } };
		this.#legChains.set(record.agentId, chain);
		this.#pendingLegChains.set(record.agentId, chain);
		let result;
		try { result = await this.#executeTool({ ...request, tool }, record, lifecycleGeneration); }
		finally { if (this.#pendingLegChains.get(record.agentId) === chain) this.#pendingLegChains.delete(record.agentId); }
		if (chain.legs === 0) {
			if (this.#legChains.get(record.agentId) === chain) this.#legChains.delete(record.agentId);
			return result;
		}
		if (result === null || typeof result !== 'object' || RUNNING_ACTION_STATES.has(result.state)) return result;
		await chain.decision;
		const running = this.#actions.get(record.agentId);
		if (running?.legChain === chain && running.actionId !== chain.firstId) {
			return { ...result, continuing: { actionId: running.actionId, leg: chain.legs, note: 'The body keeps going: your next body call stops this leg and runs; cancelAction stops it.' } };
		}
		return chain.ended === null || ['FAILED', 'CANCELLED', 'TIMED_OUT', 'INTERRUPTED'].includes(chain.ended) ? result : { ...result, keepGoing: { stopped: chain.ended } };
	}

	/** A model body action that was dispatched as the next leg of a keepGoing chain. */
	#joinLegChain(record, active, chain) {
		active.legChain = chain;
		if (chain.legs === 0) chain.firstId = active.actionId;
		chain.ids.add(active.actionId);
		chain.currentId = active.actionId;
		chain.legs += 1;
		active.result.then((outcome) => { chain.decision = this.#nextLeg(record, active, chain, outcome); }, () => {});
	}

	async #nextLeg(record, previous, chain, outcome) {
		const { agentId } = record;
		if (chain.replied || this.#legChains.get(agentId) !== chain) return;
		const stop = (reason) => {
			chain.ended = reason;
			this.#trace('native_keep_going_stopped', { agentId, goalRevision: chain.goalRevision, actionId: previous.actionId, legs: chain.legs, reason });
		};
		if (outcome?.state !== 'SUCCEEDED') return stop(outcome?.state ?? 'UNKNOWN');
		// Seeing the requested landmark completes the whole trip, even when this leg made progress.
		if (outcome.reasonCode === 'TARGET_SEEN') return stop(outcome.reasonCode);
		if (previous.interruptedBy !== undefined) return stop('INTERRUPTED');
		if (chain.legs >= MAX_KEEP_GOING_LEGS) return stop('LEG_LIMIT');
		const from = previous.startPosition?.position;
		const ended = this.#bodyEnds.get(agentId);
		const to = ended?.goalRevision === chain.goalRevision ? ended.position : null;
		if (from == null || to == null || Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) < KEEP_GOING_MIN_PROGRESS_BLOCKS) return stop('NO_PROGRESS');
		if (this.#actions.has(agentId) || this.#programRuns.has(agentId) || this.#completions.has(agentId) || this.#sequenceFinishReservations.has(agentId) || this.#sweeps.has(agentId)) return stop('BODY_BUSY');
		const current = this.#registry?.get(agentId);
		if (this.#registry !== null && current?.goalRevision !== chain.goalRevision) return stop('STALE_PLAN');
		this.#pendingLegChains.set(agentId, chain);
		try {
			await this.#executeAction({ ...chain.request, callId: `${chain.request.callId ?? 'keep-going'}-leg${chain.legs + 1}` }, chain.record, chain.request.tool, null, false, null, null, { issuer: 'skill_leg' });
			this.#trace('native_keep_going_leg_started', { agentId, goalRevision: chain.goalRevision, actionId: chain.currentId, leg: chain.legs });
		} catch (error) { stop(error?.code ?? 'LEG_NOT_STARTED'); }
		finally { if (this.#pendingLegChains.get(agentId) === chain) this.#pendingLegChains.delete(agentId); }
	}

	/**
	 * Runs cancel, handing it beforeCancel: the yield starts once the cancel passes its own check, its reflex update sent
	 * ahead of the cancel on the bridge, and is awaited once the cancel settles.
	 */
	async #cancelWithYield(record, tool, yieldFiring, options) {
		let yielded = null;
		const beforeCancel = yieldFiring === null ? null : () => { yielded = yieldFiring(); yielded.catch(() => {}); };
		const cancelled = await this.#cancelAction(record, tool, { ...options, beforeCancel });
		if (yielded !== null) await yielded;
		return cancelled;
	}

	async #replaceAction(request, record, blockingRun, yieldFiring = null) {
		const expectedEpoch = this.#actionCancellationEpoch(record, this.#actions.get(record.agentId));
		const cancelled = await this.#cancelWithYield(record, request.tool, yieldFiring, { blockingRun });
		if (cancelled.interruptedBy !== undefined) return cancelled;
		if (this.#executionEpoch(record.agentId) !== expectedEpoch) throw codedError('STALE_NATIVE_TOOL', 'Lifecycle changed while cancelling the replaced action');
		// Any authoritative terminal result releases the old action, even if it beat the cancel to the server.
		if (!TERMINAL_ACTION_STATES.has(cancelled.state)) throw codedError('CANCEL_ACK_UNCONFIRMED', 'Replacement needs the previous action to be terminal');
		try {
			const issued = {};
			const result = await this.#executeAction(request, record, { ...request.tool, kind: 'action' }, null, true, null, null, { issued });
			// Always return the predecessor's terminal receipt, so the model and handle bookkeeping can close it,
			// and the successor's own ID, which is the handle a later replaceAction must name.
			return { ...withSuccessorId(issued, result), replacedAction: replacementReceipt(cancelled, request.tool.actionId) };
		} catch (error) {
			error.replacedAction = replacementReceipt(cancelled, request.tool.actionId);
			throw error;
		}
	}

	async #replaceInterruptedDangerAction(request, record, tool, interrupted, blockingRun, { pausedProgram = false, yieldFiring = null } = {}) {
		const expectedEpoch = this.#actionCancellationEpoch(record, interrupted);
		const cancelled = await this.#cancelWithYield(record, { actionId: interrupted.actionId, goalRevision: record.goalRevision }, yieldFiring, { blockingRun });
		if (cancelled.interruptedBy !== undefined) return cancelled;
		if (this.#executionEpoch(record.agentId) !== expectedEpoch) throw codedError('STALE_NATIVE_TOOL', 'Lifecycle changed while replacing the interrupted action');
		if (!TERMINAL_ACTION_STATES.has(cancelled.state)) throw codedError('CANCEL_ACK_UNCONFIRMED', 'Replacement needs the previous action to be terminal');
		try {
			const issued = {};
			const result = await this.#executeAction(request, record, tool, null, true, null, null, { pausedProgram, issued });
			return { ...withSuccessorId(issued, result), replacedAction: replacementReceipt(cancelled, interrupted.actionId) };
		} catch (error) {
			error.replacedAction = replacementReceipt(cancelled, interrupted.actionId);
			throw error;
		}
	}

	async #withBlockingToolRun(record, operation) {
		if (this.#blockingToolRuns.has(record.agentId)) throw codedError('NATIVE_ACTION_IN_PROGRESS', 'A blocking native body tool is already running');
		let resolveInterruption;
		const interruption = new Promise((resolve) => { resolveInterruption = resolve; });
		let releaseWork = null;
		const run = {
			interruption, resolveInterruption, interruptedBy: null, forkStop: null, sequence: null, lookAround: null, searching: false, recovering: null,
			settleBudgetMs: this.#sequenceStepSettleMs, activeActions: 0, finished: false, released: false,
			retainAction: (timeoutMs) => {
				if (releaseWork === null) releaseWork = this.#onWorkStarted(record, 'action', { timeoutMs });
			},
			trackAction: (result) => {
				run.activeActions += 1;
				const settle = () => {
					run.activeActions -= 1;
					if (releaseWork !== null && run.finished && run.activeActions === 0 && !run.released) { run.released = true; releaseWork(); }
				};
				void result.then(settle, settle);
			},
			finish: () => {
				run.finished = true;
				if (releaseWork !== null && run.activeActions === 0 && !run.released) { run.released = true; releaseWork(); }
			},
		};
		this.#blockingToolRuns.set(record.agentId, run);
		if (this.#armedDangerInterrupts.delete(record.agentId)) {
			run.interruptedBy = 'danger';
			run.resolveInterruption();
			this.#trace('native_tool_danger_interrupt_armed', { agentId: record.agentId, goalRevision: record.goalRevision });
		}
		try { return await operation(run); }
		finally {
			run.finish();
			if (this.#blockingToolRuns.get(record.agentId) === run) this.#blockingToolRuns.delete(record.agentId);
		}
	}

	/**
	 * True when the model chose fight_target/flee_from while its program is suspended awaiting a decision and owns
	 * no body action. The program stays paused with its decision intact; respondProgram later resumes, replaces or
	 * ends it. Nothing here chooses an action: it only removes the respondProgram/programStatus detour under danger.
	 */
	#dangerActionWhilePaused(tool, record) {
		if (!['action', 'start_action', 'replace_action'].includes(tool.kind) || !PAUSED_PROGRAM_DANGER_ACTIONS.has(tool.actionType)) return false;
		const interrupted = this.#interruptedPausedDangerAction(record);
		if (interrupted !== null) {
			// escape (a start_action) may take over a borrowed fight or flee too: falling into water mid-fight needs it.
			return tool.kind === 'action' || (tool.kind === 'start_action' && tool.actionType === 'escape')
				|| (tool.kind === 'replace_action' && tool.actionId === interrupted.actionId && tool.goalRevision === interrupted.goalRevision);
		}
		if (!this.#pausedProgramForDanger(record)) return false;
		if (tool.kind === 'replace_action') return this.#terminalActionReceipt(record, tool.actionId, tool.goalRevision) !== null;
		return true;
	}

	#pausedProgramForDanger(record, { ownsAction = false } = {}) {
		const run = this.#programRuns.get(record.agentId);
		if (run?.goalRevision !== record.goalRevision || run.state !== 'RUNNING' || run.epoch !== this.#executionEpoch(record.agentId)) return false;
		const status = this.#programExecutor.status?.(record);
		return status?.decision != null && status.engineState === 'SUSPENDED' && (ownsAction || !this.#actions.has(record.agentId));
	}

	/** The model's own fight/flee taken while the program is paused, once danger interrupted its blocking call; else null. */
	#interruptedPausedDangerAction(record) {
		const active = this.#actions.get(record.agentId);
		if (active === undefined || active.pausedProgram !== true || active.interruptedBy !== 'danger' || active.goalRevision !== record.goalRevision) return null;
		return this.#pausedProgramForDanger(record, { ownsAction: true }) ? active : null;
	}

	#terminalActionReceipt(record, actionId, goalRevision) {
		if (goalRevision !== record.goalRevision) return null;
		const latest = this.#receipts.get(record.agentId)?.findLast((entry) => entry.goalRevision === goalRevision && entry.actionType !== 'chat');
		return latest !== undefined && latest.actionId === actionId && TERMINAL_ACTION_STATES.has(latest.state) ? latest : null;
	}

	async #startReplacementAsNewAction(request, record, previous, { pausedProgram = false, yieldFiring = null } = {}) {
		try {
			// Nothing to cancel: the predecessor already ended, so the yield goes just before the replacement starts.
			if (yieldFiring !== null) await yieldFiring();
			const started = await this.#executeAction(request, record, { ...request.tool, kind: 'action' }, null, false, null, null, { pausedProgram });
			return { ...started, startedAs: 'start_action', replacedAction: replacementReceipt(previous, previous.actionId) };
		} catch (error) {
			error.replacedAction = replacementReceipt(previous, previous.actionId);
			throw error;
		}
	}

	// `lean` returns the stored sample itself (no copy, no model-facing decoration) for internal callers that only read it.
	async #observe(record, { includeMetadata = true, afterResult = null, lean = false, deliver = true } = {}) {
		const epoch = this.#executionEpoch(record.agentId);
		await this.initializeMemory(record.agentId);
		if (this.#executionEpoch(record.agentId) !== epoch) throw codedError('STALE_NATIVE_TOOL', 'Observation request outlived its lifecycle');
		const previous = this.#observations.get(record.agentId);
		const afterEventSequence = previous?.goalRevision === record.goalRevision ? previous.eventSequence : 0;
		let freshness = { fresh: false, reasonCode: 'FRESH_OBSERVATION_UNAVAILABLE' };
		if (this.#requestObservation !== null) {
			const pending = afterResult === null ? undefined : this.#postResultSamples.get(record.agentId);
			if (pending?.result === afterResult && pending.goalRevision === record.goalRevision) {
				await this.#awaitPostResultSample(record, epoch, afterEventSequence, pending);
				// Fresh means a stored sample newer than the one the result was fenced at, whoever delivered it.
				const sampled = this.#observations.get(record.agentId);
				if (sampled?.goalRevision !== record.goalRevision || sampled.eventSequence <= pending.eventSequence) await this.#requestSample(record, epoch, pending.eventSequence);
				freshness = { fresh: true, afterEventSequence: pending.eventSequence };
			} else {
				await this.#requestSample(record, epoch, afterEventSequence);
				freshness = { fresh: true, afterEventSequence };
			}
			this.#assertCurrent(record);
			if (this.#executionEpoch(record.agentId) !== epoch) throw codedError('STALE_NATIVE_TOOL', 'Observation request outlived its lifecycle');
		}
		const latest = this.#observations.get(record.agentId);
		const facts = latest?.goalRevision === record.goalRevision
			? lean ? { eventSequence: latest.eventSequence, observation: latest.observation } : structuredClone(latest)
			: { eventSequence: 0, goal: record.currentGoal ?? null, goalSpec: record.currentGoalSpec ?? null, observation: {} };
		delete facts.goalRevision;
		if (!lean) facts.observation = this.#decorate(record, facts.observation ?? {}, { deliver });
		// Internal continuations need fresh world facts, not model-facing metadata.
		const metadata = includeMetadata ? { ...await this.#executionMetadata(record), ...await this.#memorySummary(record) } : {};
		this.#assertCurrent(record);
		if (this.#executionEpoch(record.agentId) !== epoch) throw codedError('STALE_NATIVE_TOOL', 'Observation request outlived its lifecycle');
		return { ...facts, ...metadata, freshness: { ...freshness, eventSequence: facts.eventSequence, observedAtEpochMs: facts.observation.observedAtEpochMs ?? null, ...(facts.observation.continuity?.rememberedSections === undefined ? {} : { rememberedSections: [...facts.observation.continuity.rememberedSections] }) } };
	}

	async #requestSample(record, epoch, afterEventSequence) {
		const sampled = await this.#requestObservation(record, { afterEventSequence });
		this.#assertCurrent(record);
		if (this.#executionEpoch(record.agentId) !== epoch) throw codedError('STALE_NATIVE_TOOL', 'Observation request outlived its lifecycle');
		if (!Number.isSafeInteger(sampled?.eventSequence) || sampled.eventSequence <= afterEventSequence || sampled.observation === null || typeof sampled.observation !== 'object' || Array.isArray(sampled.observation)) throw codedError('FRESH_OBSERVATION_REQUIRED', 'Observation callback did not return a newer server sample');
		this.#storeObservation(record, sampled.observation, { eventSequence: sampled.eventSequence, conversation: sampled.conversation });
	}

	/**
	 * Uses the server's post-result publication when it is already here or arrives
	 * first. The server publishes it in the same tick as the result, while an explicit
	 * request is only answered a tick later, so the request is held back for a short
	 * grace period: sent at once it cost the server one more observation per action.
	 * The request remains the guarantee when the publication does not come.
	 */
	async #awaitPostResultSample(record, epoch, afterEventSequence, pending) {
		if (pending.published) return;
		pending.publication ??= new Promise((resolve) => { pending.wake = resolve; });
		const published = pending.publication;
		if ((this.#publicationStreaks.get(record.agentId) ?? 0) >= PUBLICATION_EVIDENCE_RESULTS && this.#publicationGraceMs > 0) {
			const startedAt = performance.now();
			let timer;
			const expired = new Promise((resolve) => { timer = setTimeout(resolve, this.#publicationGraceMs, EXPIRED); });
			try { if (await Promise.race([published, expired]) !== EXPIRED) return; }
			finally { clearTimeout(timer); }
			if (pending.published) return;
			// A busy event loop runs an expired timer before it reads the socket, so a publication that already
			// arrived is handled in the poll phase after this timer. One check-phase turn lets it count.
			await new Promise((resolve) => setImmediate(resolve));
			if (pending.published) return;
			if (this.#executionEpoch(record.agentId) !== epoch) throw codedError('STALE_NATIVE_TOOL', 'Observation request outlived its lifecycle');
			this.#trace('native_post_result_publication_missed', { agentId: record.agentId, goalRevision: record.goalRevision, waitedMs: Math.round(performance.now() - startedAt) });
		}
		const requested = this.#requestSample(record, epoch, afterEventSequence);
		// A superseded request still stores its newer sample under the same lifecycle checks.
		requested.catch(() => {});
		try { await Promise.race([published, requested]); }
		catch (error) {
			// An observation already on the wire may still be queued behind the
			// action-result handler. Give that queued publication one event-loop
			// turn to arrive before treating an inspection error as authoritative.
			if (!pending.published) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			if (!pending.published) throw error;
		}
		// The request answered first: the server did not publish in time, so stop waiting for it.
		if (!pending.published) this.#publicationStreaks.set(record.agentId, 0);
	}

	async #memorySummary(record) {
		const taskMemory = await this.#taskContext?.(record);
		const worldId = this.#worldId(record);
		if (worldId === null || typeof this.#notebook?.listUnresolved !== 'function') return taskMemory == null ? {} : { taskMemory };
		const page = await this.#notebook.listUnresolved(record.agentId, { worldId, offset: 0, limit: 4 });
		this.#assertCurrent(record);
		return { ...(taskMemory == null ? {} : { taskMemory }), unresolvedActions: { worldId, total: page.total, nextOffset: page.nextOffset, ...(page.evictedReceipts === undefined ? {} : { evictedReceipts: page.evictedReceipts }), entries: (page.entries ?? []).map(({ actionId, actionType, goalRevision, state, reasonCode }) => ({ actionId, actionType, goalRevision, state, reasonCode })), historical: true, query: { kind: 'unresolved', offset: 0, limit: 20 } } };
	}

	async #executionMetadata(record) {
		if (this.#executionSettings === null) return {};
		const executionSettings = await this.#executionSettings(record);
		this.#assertCurrent(record);
		return { executionSettings: structuredClone(executionSettings) };
	}

	/** Install, replace or delete one model-authored standing order. Installing never moves the body by itself. */
	async #standingOrder(request, record) {
		this.#assertCurrent(record);
		const { agentId } = record;
		const tool = request.tool;
		if (tool.when === undefined) {
			const deleted = this.#standing.delete(agentId, tool.id);
			await this.#yieldStandingGuard(record, tool.id);
			this.#reportClosedGuardEpisodes(agentId);
			this.#trace('standing_order_deleted', { agentId, goalRevision: record.goalRevision, id: tool.id, deleted });
			return { state: deleted ? 'DELETED' : 'UNKNOWN_STANDING_ORDER', id: tool.id, standingOrders: this.#standing.list(agentId) };
		}
		let source = tool.source;
		if (tool.noteKey !== undefined) source = (await this.#findProgramNote(request, record, tool.noteKey, () => this.#assertCurrent(record))).text;
		if (Buffer.byteLength(source, 'utf8') > MAX_STANDING_SOURCE_BYTES) throw codedError('STANDING_ORDER_TOO_LARGE', `A standing order source must be at most ${MAX_STANDING_SOURCE_BYTES} UTF-8 bytes`);
		// Orders fire on facts that usually come with urgent danger, which pauses a program unless its source says otherwise.
		if (parseArenaScript(source).survivalPolicy !== 'continue_and_notify') throw codedError('STANDING_ORDER_WOULD_PAUSE', 'Guard unchanged. Replace its same id after adding program.onUnhandledAttention(mode, { survival: "continue_and_notify" }); never delete before replacement validation');
		this.#clearStaleGuards(record);
		this.#standing.set(agentId, { id: tool.id, template: tool.template, when: tool.when, source, parameters: tool.parameters,
			maxActions: tool.maxActions, timeoutMs: tool.timeoutMs, ttlS: tool.ttlS, guard: tool.guard, goalRevision: record.goalRevision, goalText: record.currentGoal });
		await this.#yieldStandingGuard(record, tool.id);
		this.#reportClosedGuardEpisodes(agentId);
		this.#trace('standing_order_set', { agentId, goalRevision: record.goalRevision, id: tool.id, guard: tool.guard === true, origin: tool.template ? 'template' : tool.noteKey ? 'note' : 'source', when: tool.when, ttlS: tool.ttlS, ...programSourceSummary(source) });
		// A condition that already holds fires on the current facts, as a player already burning acts at once.
		const latest = this.#observations.get(agentId);
		if (latest?.goalRevision === record.goalRevision) this.#considerStandingOrders(record, latest.observation);
		return { state: 'STANDING', id: tool.id,
			...(tool.template === undefined ? {} : { template: tool.template, parameters: structuredClone(tool.parameters) }),
			standingOrders: this.#standing.list(agentId) };
	}

	#clearStaleGuards(record) {
		this.#standing.clearGuards(record.agentId, order => order.goalRevision === record.goalRevision && order.goalText === record.currentGoal);
		const run = this.#programRuns.get(record.agentId);
		if (run?.standingGuard && !this.#standing.isCurrent(record.agentId, run.guardOrder)) {
			void this.#yieldStandingGuard(run.record).catch(error => this.#trace('standing_order_failed', { agentId: record.agentId, reasonCode: error?.code }));
		}
	}

	/** Explicit model body commands and policy edits supersede the currently executing guard, after input release. */
	async #yieldStandingGuard(record, id = undefined) {
		const run = this.#programRuns.get(record.agentId);
		if (run?.standingGuard !== true || (id !== undefined && run.standingOrder?.id !== id)) return;
		const token = { epoch: this.#executionEpoch(record.agentId) };
		this.#standingYielding.set(record.agentId, token);
		try {
			await this.#cancelProgram(record, { kind: 'cancel_program', programId: run.programId, goalRevision: record.goalRevision });
			if (this.#executionEpoch(record.agentId) !== token.epoch) throw codedError('STALE_NATIVE_TOOL', 'Body changed while yielding the standing guard');
		} finally { if (this.#standingYielding.get(record.agentId) === token) this.#standingYielding.delete(record.agentId); }
	}

	/** Track order conditions on a stored sample and start the first due order when the body can be handed to it. */
	#considerStandingOrders(record, observation) {
		const { agentId } = record;
		if (!this.#standing.has(agentId)) return;
		this.#clearStaleGuards(record);
		if (observation?.ready === false || observation?.death != null || observation?.status === 'PLAYER_DEAD' || observation?.player?.dead === true) {
			this.#standing.rearm(agentId);
			return;
		}
		let order;
		try { order = this.#standing.evaluate(agentId, observation); }
		catch (error) { this.#trace('standing_order_evaluation_failed', { agentId, reasonCode: error?.code ?? 'STANDING_ORDER_FAILED' }); return; }
		this.#reportClosedGuardEpisodes(agentId);
		// A due order that cannot take the body now stays due while its condition holds and is retried on later samples.
		const epoch = this.#executionEpoch(agentId);
		if (order === null || this.#standingFiring.get(agentId)?.epoch === epoch || this.#standingYielding.get(agentId)?.epoch === epoch || this.#standingOrderBlocker(record, order) !== null) return;
		if (!order.guard) this.#standing.markFired(agentId, order.id);
		const token = { epoch };
		this.#standingFiring.set(agentId, token);
		void this.#fireStandingOrder(record, order, standingOrderCause(observation))
			.catch((error) => this.#trace('standing_order_failed', { agentId, id: order.id, reasonCode: error?.code ?? 'STANDING_ORDER_FAILED' }))
			.finally(() => { if (this.#standingFiring.get(agentId) === token) this.#standingFiring.delete(agentId); });
	}

	/** A due order waits for the body; once an action settles or a program pauses, try it on the latest sample. */
	#reconsiderStandingOrders(record) {
		if (!this.#standing.has(record.agentId)) return;
		setImmediate(() => {
			const latest = this.#observations.get(record.agentId);
			if (latest?.goalRevision === record.goalRevision) this.#considerStandingOrders(record, latest.observation);
		});
	}

	/**
	 * Legacy orders wait for a paused program. Guards can interrupt routine programs, but wait for direct model
	 * defenses and other orders. Cancellation must release the predecessor's input before starting the handler.
	 */
	#standingOrderBlocker(record, order) {
		const { agentId } = record;
		if (this.#sequenceFinishReservations.has(agentId) || this.#sweeps.has(agentId) || this.#completions.has(agentId)) return 'BODY_BUSY';
		const run = this.#programRuns.get(agentId);
		if (run !== undefined && (run.standingOrder !== undefined || run.goalRevision !== record.goalRevision || (!order.guard && !this.#pausedProgramForDanger(record)))) return 'PROGRAM_RUNNING';
		const active = this.#actions.get(agentId);
		if (active !== undefined && (active.cancelling || !active.dispatched || active.dispatchPending === true || (!order.guard && active.engineActionId !== undefined) || active.goalRevision !== record.goalRevision)) return 'ACTION_SETTLING';
		if (order.guard && GUARD_DEFENSIVE_ACTIONS.has(active?.actionType)) return 'MODEL_DEFENSE';
		// A firing reflex is the faster answer to the same danger; the guard waits for it to end and then fires only if
		// its condition still holds (reconsidered when the firing ends). Default defend is not one: it holds the body
		// until the model's command, and an order is that command written ahead (it fires before contact and holds while
		// a mob chases, so waiting for it kept the model's own escape off for the whole chase; review of PR #176).
		if (this.#reflexes.firing(agentId) && !this.#reflexes.firingStandsIn(agentId)) return 'REFLEX_FIRING';
		return null;
	}

	async #fireStandingOrder(record, order, cause) {
		const { agentId } = record;
		const firedAtMs = Date.now();
		// A firing belongs to the body that was sampled. If that body's lifecycle ends while preemption is awaited
		// (death, respawn), drop it; the preserved order is reconsidered against the replacement body's own sample.
		const epoch = this.#executionEpoch(agentId);
		const stale = () => {
			if (this.#executionEpoch(agentId) === epoch && this.#standing.isCurrent(agentId, order) && this.#standingYielding.get(agentId)?.epoch !== epoch) return false;
			this.#trace('standing_order_stale', { agentId, id: order.id });
			this.#reconsiderStandingOrders(record);
			return true;
		};
		const preempted = [];
		this.#trace('standing_order_fired', { agentId, goalRevision: record.goalRevision, id: order.id, cause });
		const paused = this.#programRuns.get(agentId);
		if (paused !== undefined) {
			preempted.push({ programId: paused.programId });
			paused.pendingSuccessor = null;
			await this.#cancelProgram(record, { kind: 'cancel_program', programId: paused.programId, goalRevision: record.goalRevision });
			if (stale()) return;
			if (this.#programRuns.has(agentId)) throw codedError('STANDING_ORDER_BODY_BUSY', 'The paused program did not release the body');
		}
		if (this.#standingOrderBlocker(record, order) !== null) return;
		const active = this.#actions.get(agentId);
		if (active !== undefined && active.engineActionId === undefined) {
			preempted.push({ actionId: active.actionId, actionType: active.actionType });
			active.cancelledBy = `standing:${order.id}`;
			// A cancellation without an acknowledgement still runs the order; its start then reports the busy body.
			await this.#cancelAction(record, { actionId: active.actionId, goalRevision: active.goalRevision }, { invalidateProgram: false }).catch(() => {});
			if (stale()) return;
		}
		// As a direct command does, the order takes the body from default defend before its first action (the mod reports
		// the firing as yielded).
		if (this.#reflexes.firingStandsIn(agentId)) await this.#sendReflexes(record, { yieldFiring: true });
		if (stale()) return;
		if (this.#programRuns.has(agentId)) throw codedError('STANDING_ORDER_BODY_BUSY', 'Another program took the body first');
		if (order.guard) {
			if (!order.truth) return;
			this.#standing.markFired(agentId, order.id);
		}
		// issuer: the order's commands are its own, not the model's (C17); its first command dispatches before run.standingOrder is set.
		const request = { agentId, goalRevision: record.goalRevision, turnId: `standing-${order.id}`, callId: `standing-${order.id}-${order.fired}`, issuer: order.guard ? 'guard' : 'standing_order',
			tool: { kind: 'run_program', source: order.source, background: true, maxActions: order.maxActions, timeoutMs: order.timeoutMs,
				...(order.parameters === undefined ? {} : { parameters: order.parameters }) } };
		const started = this.#runProgram(request, record);
		const run = this.#programRuns.get(agentId);
		if (run?.request === request) {
			run.standingOrder = { id: order.id, when: order.when, firedAtMs, cause, ...(preempted.length === 0 ? {} : { preempted }) };
			run.standingGuard = order.guard;
			const { unhandledPolicy, survivalPolicy } = parseArenaScript(order.source);
			run.standingPolicy = { unhandledPolicy, survivalPolicy };
			if (order.guard) {
				run.guardOrder = order;
				run.guardEpisode = order.episode;
				run.guardEpisode.run = run;
				run.guardEpisode.running = true;
				Object.assign(run.standingOrder, guardEpisodeFacts(run.guardEpisode));
				if (run.guardEpisode.activations === 1) this.#programEvent(run, { event: 'program_guard_activated', status: this.#programStatus(record, run.programId), priority: 'urgent' });
			}
		}
		await started;
	}

	#reportClosedGuardEpisodes(agentId) {
		for (const episode of this.#standing.takeClosedEpisodes(agentId)) this.#reportGuardEpisodeEnd(episode);
	}

	#reportGuardEpisodeEnd(episode) {
		if (!episode.closed || episode.running || episode.reported || episode.result == null) return;
		episode.reported = true;
		const result = { ...episode.result, standingOrder: { ...episode.run.standingOrder, ...guardEpisodeFacts(episode) } };
		this.#programEvent(episode.run, { event: 'program_ended', result, priority: 'ordinary' });
	}

	#createProgramRun(request, record) {
		const epoch = this.#executionEpoch(record.agentId);
		let resolve, reject;
		const result = new Promise((done, fail) => { resolve = done; reject = fail; });
		let detach;
		const attentionResult = new Promise(done => { detach = done; });
		const run = { epoch, request, goalRevision: record.goalRevision, programId: `native-program-${this.#sessionId}-${++this.#sequence}`,
			state: 'PREPARING', settled: false, result, resolve, reject, detach, detached: request.tool.background === true, record, deadlineEpochMs: null };
		// The runtime owns this lease even after a background handle or advisory
		// returns to the provider. Preparation and handoff sampling are bounded too.
		run.releaseWork = this.#onWorkStarted(record, 'program', { timeoutMs: request.tool.timeoutMs ?? 30_000, programId: run.programId });
		return { run, attentionResult };
	}

	async #runProgram(request, record) {
		const { run, attentionResult } = this.#createProgramRun(request, record);
		this.#programRuns.set(record.agentId, run);
		// Own the body before any asynchronous notebook lookup. The returned handle
		// has the same lifetime and cancellation rules as a foreground program.
		void this.#executeProgram(request, record, run).then(
			(outcome) => this.#settleProgram(record.agentId, run, outcome),
			(error) => this.#settleProgram(record.agentId, run, { state: 'FAILED', reasonCode: error?.code ?? 'PROGRAM_EXECUTION_FAILED', message: String(error?.message ?? error).slice(0, 512), ...arenaScriptDiagnosticFields(error) }, error),
		);
		return request.tool.background === true ? this.#programStatus(record, run.programId) : Promise.race([run.result, attentionResult]);
	}

	#assertQueueAuthority(record, tool, run) {
		this.#assertCurrent(record);
		if (tool.goalRevision !== record.goalRevision || this.#programRuns.get(record.agentId) !== run
			|| run?.epoch !== this.#executionEpoch(record.agentId)
			|| !this.canPrepareProgram(record, tool.afterProgramId, tool.programVersion)) {
			throw codedError('STALE_PROGRAM', 'Successor needs the exact running program version with no pending decision');
		}
		const latest = this.#observations.get(record.agentId);
		const world = latest?.goalRevision === record.goalRevision ? liveProgramWorld(latest.observation) : null;
		if (world === null) throw codedError('LIVE_PROGRAM_CONTEXT_REQUIRED', 'Successor needs a live player and explicit world and dimension');
		return world;
	}

	async #queueProgram(request, record) {
		const tool = request.tool;
		const run = this.#programRuns.get(record.agentId);
		const world = this.#assertQueueAuthority(record, tool, run);
		const precondition = compileProgramPrecondition(tool.precondition);
		const admission = run.queueAdmission = (run.queueAdmission ?? 0) + 1;
		run.queueWorld = world;
		let source = tool.source;
		if (tool.noteKey !== undefined) {
			source = (await this.#findProgramNote(request, record, tool.noteKey, () => {
				const current = this.#assertQueueAuthority(record, tool, run);
				if (run.queueAdmission !== admission || current.worldId !== world.worldId || current.dimension !== world.dimension) throw codedError('STALE_PROGRAM', 'Successor preparation was superseded or its world changed');
			})).text;
		}
		// Compile before replacing an existing queue, and freeze the resolved source.
		parseArenaScript(source);
		const currentWorld = this.#assertQueueAuthority(record, tool, run);
		if (run.queueAdmission !== admission || currentWorld.worldId !== world.worldId || currentWorld.dimension !== world.dimension) throw codedError('STALE_PROGRAM', 'Successor preparation was superseded or its world changed');
		const successor = Object.freeze({ queueId: `native-queue-${this.#sessionId}-${++this.#sequence}`,
			afterProgramId: tool.afterProgramId, goalRevision: tool.goalRevision, programVersion: tool.programVersion,
			world: Object.freeze(world), precondition, sourceOrigin: tool.noteKey === undefined ? 'source' : 'note',
			request: { ...request, tool: { kind: 'run_program', source, background: true, parameters: tool.parameters,
				maxActions: tool.maxActions, timeoutMs: tool.timeoutMs, observationIntervalMs: tool.observationIntervalMs,
				expectedDurationMs: tool.expectedDurationMs } } });
		run.pendingSuccessor = successor;
		this.#trace('native_program_successor_queued', { agentId: record.agentId, ...successorSummary(successor) });
		return { state: 'QUEUED', programId: run.programId, goalRevision: run.goalRevision, pendingSuccessor: successorSummary(successor) };
	}

	#cancelQueuedProgram(record, tool) {
		this.#assertCurrent(record);
		const run = this.#programRuns.get(record.agentId);
		const successor = run?.pendingSuccessor;
		if (tool.goalRevision !== record.goalRevision || successor?.queueId !== tool.queueId || run.programId !== tool.afterProgramId) throw codedError('STALE_PROGRAM_QUEUE', 'Cancellation does not match the exact pending successor');
		run.pendingSuccessor = null;
		run.queueAdmission = (run.queueAdmission ?? 0) + 1;
		return { state: 'CANCELLED', queueId: tool.queueId, afterProgramId: tool.afterProgramId, goalRevision: tool.goalRevision };
	}

	#settleProgram(agentId, run, outcome, error = null) {
		if (run.settled) return;
		run.settled = true;
		let changedGuardOutcome = false;
		if (run.guardEpisode !== undefined) {
			changedGuardOutcome = this.#standing.finishGuard(agentId, run.guardOrder, run.guardEpisode, outcome);
			Object.assign(run.standingOrder, guardEpisodeFacts(run.guardEpisode));
			run.standingOrder.outcome = this.#standing.orderFeedback(run.guardOrder);
		}
		const result = { ...outcome, programId: run.programId, goalRevision: run.goalRevision, ...(run.standingOrder === undefined ? {} : { standingOrder: { ...run.standingOrder } }) };
		this.#trace('native_program_ended', { agentId, goalRevision: run.goalRevision, programId: run.programId,
			termination: programTermination(outcome), state: outcome.state ?? null, reasonCode: outcome.reasonCode ?? null,
			...(outcome.decision?.trigger === undefined ? {} : { pendingTrigger: outcome.decision.trigger }),
			...(outcome.trigger === undefined ? {} : { trigger: outcome.trigger }),
			programVersion: outcome.programVersion ?? null, actions: outcome.actions ?? 0,
			actionsSucceeded: outcome.actionsSucceeded ?? 0, actionsFailed: outcome.actionsFailed ?? 0,
			...(run.startedAtMs === undefined ? {} : { durationMs: Math.max(0, Date.now() - run.startedAtMs) }) });
		const successor = run.pendingSuccessor;
		run.pendingSuccessor = null;
		const handoff = successor != null && error === null && endedNaturally(outcome)
			&& outcome.programVersion === successor.programVersion && this.#executionEpoch(agentId) === run.epoch
			&& this.#programRuns.get(agentId) === run;
		if (successor != null && !handoff) result.discardedSuccessor = { ...successorSummary(successor), reasonCode: 'PREDECESSOR_NOT_SUCCESSFULLY_EXHAUSTED' };
		if (handoff) {
			run.endedWithFailures = outcome.actionsFailed ?? 0;
			// Reserve the body synchronously before any fresh-sample await or callback.
			const next = this.#createProgramRun(successor.request, run.record).run;
			next.handoff = successor;
			this.#programRuns.set(agentId, next);
			result.successorProgramId = next.programId;
			this.#programResults.set(agentId, result);
			void this.#startSuccessor(run, next, successor).then(
				outcome => this.#settleProgram(agentId, next, outcome),
				error => this.#settleProgram(agentId, next, { state: 'FAILED', reasonCode: error?.code ?? 'SUCCESSOR_EXECUTION_FAILED' }),
			);
		}
		if (this.#programRuns.get(agentId) === run) {
			this.#programRuns.delete(agentId);
			if (this.#executionEpoch(agentId) === run.epoch) this.#programResults.set(agentId, result);
			if (run.detached && this.#executionEpoch(agentId) === run.epoch) {
				this.#unreportedProgramEnds.set(agentId, { programId: run.programId, goalRevision: run.goalRevision, turnId: run.request.turnId });
			}
		}
		this.#wakeProgramWaits(agentId, 'ended');
		// Acquire successor ownership above before releasing the predecessor.
		run.releaseWork();
		if (error !== null && run.request.tool.background !== true) run.reject(error);
		else run.resolve(result);
		if (run.guardEpisode !== undefined) {
			run.guardEpisode.running = false;
			run.guardEpisode.result = result;
			if ((changedGuardOutcome || ['STANDING_CONTINUE_FAILED', 'STANDING_DECISION_REQUIRED'].includes(outcome.reasonCode)) && !run.guardEpisode.closed) this.#programEvent(run, { event: 'program_ended', result, priority: 'urgent' });
			this.#reportGuardEpisodeEnd(run.guardEpisode);
		} else if (!handoff && run.detached && this.#executionEpoch(agentId) === run.epoch
			// A waiting tail call reports a natural end in its own result; another wake would re-decide work already sent.
			&& !(run.tailCallWaiting === true && error === null && endedNaturally(outcome))) {
			this.#programEvent(run, { event: 'program_ended', result });
		}
		if (!handoff) this.#reconsiderStandingOrders(run.record);
	}

	async #startSuccessor(previous, run, successor) {
		const record = run.record;
		try {
			this.#assertCurrent(record);
			if (run.settled || this.#programRuns.get(record.agentId) !== run || run.epoch !== this.#executionEpoch(record.agentId)) throw codedError('STALE_PROGRAM', 'Successor lost execution authority');
			if (previous.handoffInvalidated || !sameProgramWorld(this.#observations.get(record.agentId)?.observation, successor.world)) throw codedError('SUCCESSOR_CONTEXT_CHANGED', 'Successor world or live player changed');
			const before = this.#observations.get(record.agentId)?.eventSequence ?? 0;
			const proof = previous.postResultSample;
			// Reuse only the exact raw snapshot consumed after the final action result.
			// A later observation or action invalidates this proof, even in the same world.
			const reuse = proof !== undefined && proof.result === previous.lastActionResult
				&& proof.snapshot === this.#observations.get(record.agentId)
				&& previous.epoch === run.epoch && proof.snapshot.goalRevision === record.goalRevision;
			const facts = reuse ? null : await this.#observe(record, { includeMetadata: false, deliver: false });
			const latest = this.#observations.get(record.agentId);
			this.#assertCurrent(record);
			if (run.settled || this.#programRuns.get(record.agentId) !== run || run.epoch !== this.#executionEpoch(record.agentId)) throw codedError('STALE_PROGRAM', 'Successor lost execution authority');
			if (latest?.goalRevision !== record.goalRevision || (!reuse && (facts.freshness.fresh !== true || latest.eventSequence <= before))) throw codedError('FRESH_OBSERVATION_REQUIRED', 'Successor needs a new authoritative sample after predecessor completion');
			if (run.handoffInvalidated || !sameProgramWorld(latest.observation, successor.world)) throw codedError('SUCCESSOR_CONTEXT_CHANGED', 'Successor world or live player changed');
			if ((latest.observation.continuity?.rememberedSections?.length ?? 0) > 0) throw codedError('FRESH_OBSERVATION_REQUIRED', 'Successor prerequisites cannot use remembered sections');
			// Use the raw authoritative snapshot, never decorated remembered facts.
			if (!evaluateProgramPrecondition(successor.precondition, { observation: latest.observation, parameters: successor.request.tool.parameters })) throw codedError('SUCCESSOR_PRECONDITION_FALSE', 'The agent-authored successor prerequisite is not true');
			run.handoff = null;
			const execution = this.#executeProgram(successor.request, record, run);
			this.#programEvent(run, { event: 'program_handoff_started', predecessorProgramId: previous.programId, queueId: successor.queueId,
				...(previous.endedWithFailures > 0 ? { predecessorActionsFailed: previous.endedWithFailures } : {}), status: this.#programStatus(record, run.programId) });
			return await execution;
		} catch (error) {
			if (run.handoff != null) {
				// Cancellation may have released this reservation while sampling. A late
				// callback must not wake the planner over a replacement program.
				if (run.settled || this.#programRuns.get(record.agentId) !== run || run.epoch !== this.#executionEpoch(record.agentId)) return { state: 'CANCELLED', reasonCode: 'STALE_PROGRAM' };
				run.detached = false; // One rejection event, rather than a duplicate terminal wake.
				const result = { state: 'YIELDED', reasonCode: error?.code ?? 'SUCCESSOR_PRECONDITION_FAILED', queueId: successor.queueId, predecessorProgramId: previous.programId };
				this.#settleProgram(record.agentId, run, result);
				this.#programEvent(run, { event: 'program_handoff_rejected', result });
				return result;
			}
			throw error;
		}
	}

	/**
	 * A wait while the model's own program runs, as a player watches their routine: the program keeps the body,
	 * and the wait returns at its duration or as soon as the program ends, asks for a decision or danger interrupts.
	 */
	async #waitOnProgram(record, durationMs) {
		const run = this.#programRuns.get(record.agentId);
		if (run?.goalRevision !== record.goalRevision) throw codedError('NATIVE_PROGRAM_IN_PROGRESS', 'A model-authored program owns this player');
		const startedAt = performance.now();
		const waited = (reasonCode, extra = {}) => {
			const program = this.#programStatus(record, run.programId);
			if (this.#programRuns.get(record.agentId) !== run && this.#unreportedProgramEnds.get(record.agentId)?.programId === run.programId) this.#unreportedProgramEnds.delete(record.agentId);
			return { state: 'SUCCEEDED', reasonCode, waitedMs: Math.round(performance.now() - startedAt), ...extra, program };
		};
		if (this.#programStatus(record, run.programId).decision != null) return waited('PROGRAM_DECISION_PENDING');
		let wake;
		const woken = new Promise((resolve) => { wake = resolve; });
		const waits = this.#programWaits.get(record.agentId) ?? new Set();
		waits.add(wake);
		this.#programWaits.set(record.agentId, waits);
		let timer;
		const elapsed = new Promise((resolve) => { timer = this.#clock.setTimeout(resolve, durationMs, 'elapsed'); });
		try {
			const reason = await Promise.race([elapsed, woken, run.result.then(() => 'ended', () => 'ended')]);
			if (reason === 'danger') return waited('WAIT_INTERRUPTED', { interruptedBy: 'danger' });
			return waited(reason === 'ended' ? 'PROGRAM_ENDED' : reason === 'decision' ? 'PROGRAM_DECISION' : 'WAIT_ELAPSED');
		} finally {
			this.#clock.clearTimeout(timer);
			waits.delete(wake);
			if (waits.size === 0 && this.#programWaits.get(record.agentId) === waits) this.#programWaits.delete(record.agentId);
		}
	}

	/**
	 * The next body call after program_planning_due: the model prepared it while the program finished, so it starts the
	 * moment the program ends naturally instead of being rejected and re-decided. Any other ending (failure, decision,
	 * danger, deadline, cancellation) returns the predecessor's status and leaves the call unstarted for a new decision.
	 */
	async #awaitProgramTail(record, run) {
		const startedAt = performance.now();
		let wake;
		const woken = new Promise((resolve) => { wake = resolve; });
		const waits = this.#programWaits.get(record.agentId) ?? new Set();
		waits.add(wake);
		this.#programWaits.set(record.agentId, waits);
		let reason;
		run.tailCallWaiting = true;
		try {
			reason = await Promise.race([woken, run.result.then(() => 'ended', () => 'ended')]);
		} finally {
			run.tailCallWaiting = false;
			waits.delete(wake);
			if (waits.size === 0 && this.#programWaits.get(record.agentId) === waits) this.#programWaits.delete(record.agentId);
		}
		const waitedMs = Math.round(performance.now() - startedAt);
		this.#assertCurrent(record);
		const ended = reason === 'ended' || this.#programRuns.get(record.agentId) !== run;
		const outcome = ended ? this.#programResults.get(record.agentId) : null;
		const natural = ended && outcome?.programId === run.programId && endedNaturally(outcome) && !this.#programRuns.has(record.agentId);
		this.#trace('native_program_tail_call', { agentId: record.agentId, goalRevision: run.goalRevision, programId: run.programId, waitedMs, started: natural,
			reason: natural ? 'PROGRAM_EXHAUSTED' : ended ? (outcome?.reasonCode ?? 'PROGRAM_ENDED') : reason === 'danger' ? 'DANGER' : 'PROGRAM_DECISION' });
		if (natural) {
			if (this.#unreportedProgramEnds.get(record.agentId)?.programId === run.programId) this.#unreportedProgramEnds.delete(record.agentId);
			return { started: true, predecessor: { programId: run.programId, state: outcome.state, reasonCode: outcome.reasonCode, actions: outcome.actions ?? 0,
				actionsFailed: outcome.actionsFailed ?? 0, waitedMs, ...(outcome.failure === undefined ? {} : { failure: outcome.failure }) } };
		}
		return { started: false, result: { state: 'NOT_STARTED', reasonCode: ended ? 'PREDECESSOR_DID_NOT_EXHAUST' : reason === 'danger' ? 'WAIT_INTERRUPTED' : 'PROGRAM_DECISION_PENDING',
			waitedMs, executed: false, program: this.#programStatus(record, run.programId) } };
	}

	#wakeProgramWaits(agentId, reason) {
		for (const wake of this.#programWaits.get(agentId) ?? []) wake(reason);
	}

	#programEvent(run, event) {
		const latest = this.#observations.get(run.record.agentId);
		if (this.#executionEpoch(run.record.agentId) !== run.epoch || latest?.goalRevision !== run.goalRevision) return;
		try {
			Promise.resolve(this.#onProgramEvent(run.record, { ...event, programId: run.programId, goalRevision: run.goalRevision,
				observation: structuredClone(latest.observation), eventSequence: latest.eventSequence })).catch(error => this.#trace('program_notification_failed', { code: error?.code ?? 'PROGRAM_NOTIFICATION_FAILED' }));
		} catch (error) { this.#trace('program_notification_failed', { code: error?.code ?? 'PROGRAM_NOTIFICATION_FAILED' }); }
	}

	#programStatus(record, programId, options = { deliverWarnings: true }) {
		this.#assertCurrent(record);
		const run = this.#programRuns.get(record.agentId);
		if (run?.goalRevision === record.goalRevision && (programId === undefined || programId === run.programId)) {
			const status = { programId: run.programId, goalRevision: run.goalRevision, state: run.state,
				deadlineEpochMs: run.deadlineEpochMs, maxActions: run.request.tool.maxActions ?? 64,
				action: this.#actionStatus(record), ...this.#programExecutor.status?.(record, { pausedAction: this.#dangerActionHoldsPausedProgram(record), ...options }),
				...(run.pendingSuccessor == null ? {} : { pendingSuccessor: successorSummary(run.pendingSuccessor) }),
				...(run.standingOrder === undefined ? {} : { standingOrder: { ...run.standingOrder, ...(run.guardEpisode === undefined ? {} : guardEpisodeFacts(run.guardEpisode)) } }) };
			return status;
		}
		const result = this.#programResults.get(record.agentId);
		if (result?.goalRevision === record.goalRevision && (programId === undefined || programId === result.programId)) return structuredClone(result);
		return { state: programId === undefined ? 'IDLE' : 'UNKNOWN_PROGRAM', goalRevision: record.goalRevision, ...(programId === undefined ? {} : { programId }) };
	}

	async expireProgram(record, programId) {
		const run = this.#programRuns.get(record.agentId);
		if (run?.goalRevision !== record.goalRevision || run.programId !== programId || run.epoch !== this.#executionEpoch(record.agentId)) return null;
		run.pendingSuccessor = null;
		run.queueAdmission = (run.queueAdmission ?? 0) + 1;
		if (run.state === 'PREPARING') {
			this.#settleProgram(record.agentId, run, { state: 'TIMED_OUT', reasonCode: 'PROGRAM_DEADLINE' });
		} else if (typeof this.#programExecutor.expire === 'function') {
			await this.#programExecutor.expire(record, programId);
		} else {
			await this.#programExecutor.cancel(record.agentId, 'PROGRAM_DEADLINE');
		}
		return run.result;
	}

	async #cancelProgram(record, tool) {
		this.#assertCurrent(record);
		const run = this.#programRuns.get(record.agentId);
		const rejected = this.#operationRejection(record, tool);
		if (rejected !== null) throw codedError(rejected.code, rejected.message);
		const preparing = run.state === 'PREPARING';
		run.pendingSuccessor = null;
		run.state = 'CANCELLING';
		if (preparing) this.#settleProgram(record.agentId, run, { state: 'CANCELLED', reasonCode: 'MODEL_CANCELLED' });
		else await this.#programExecutor.cancel(record.agentId, 'MODEL_CANCELLED');
		return run.result;
	}

	async #executeProgram(request, record, run) {
		const { epoch } = run;
		let source = request.tool.source;
		if (request.tool.noteKey !== undefined) {
			run.noteLookupWorld = { worldId: this.#worldId(record), dimension: this.#observations.get(record.agentId)?.observation.world?.dimension };
			source = (await this.#findProgramNote(request, record, request.tool.noteKey, () => {
				this.#assertCurrent(record);
				if (run.settled || run.noteLookupInvalidated || epoch !== this.#executionEpoch(record.agentId) || this.#programRuns.get(record.agentId) !== run) throw codedError('NATIVE_PROGRAM_CANCELLED', 'Saved program lookup outlived its execution authority');
			})).text;
			run.noteLookupWorld = null;
		}
		this.#assertCurrent(record);
		if (run.settled || run.noteLookupInvalidated || epoch !== this.#executionEpoch(record.agentId) || this.#programRuns.get(record.agentId) !== run) throw codedError('NATIVE_PROGRAM_CANCELLED', 'Saved program lookup outlived its execution authority');
		if (this.#actions.has(record.agentId) || this.#completions.has(record.agentId)) throw codedError('NATIVE_ACTION_IN_PROGRESS', 'An action or completion verification already owns this player');
		const latest = this.#observations.get(record.agentId);
		if (latest?.goalRevision !== record.goalRevision) throw codedError('CURRENT_OBSERVATION_REQUIRED', 'A current player observation is required before running a program');
		run.state = 'RUNNING';
		run.startedAtMs = Date.now();
		// On the executor's clock, so the reported deadline is the one that ends the program.
		run.deadlineEpochMs = (this.#executorOnGameClock ? this.#clock.now() : run.startedAtMs) + (request.tool.timeoutMs ?? 30_000);
		this.#trace('native_program_started', { agentId: record.agentId, goalRevision: run.goalRevision, programId: run.programId,
			origin: request.tool.noteKey === undefined ? 'source' : 'note', background: request.tool.background === true,
			...(run.handoff == null ? {} : { successor: true }), ...programSourceSummary(source),
			maxActions: request.tool.maxActions ?? 64, timeoutMs: request.tool.timeoutMs ?? 30_000 });
		// Measured model latency sets the lead; the executor requires two seconds of overlap when it is unavailable.
		let planningLeadMs;
		try {
			const measured = this.#planningLeadTime(record);
			if (Number.isFinite(measured) && measured > 0) planningLeadMs = Math.ceil(measured);
		} catch { /* Telemetry must not prevent authorised work. */ }
		// The executor samples right after each action returns; that one sample may use
		// the server's post-result publication. Later interval samples still request.
		let lastActionResult = null;
		return await this.#programExecutor.run(record, { source, parameters: request.tool.parameters, expectedDurationMs: request.tool.expectedDurationMs, programId: run.programId, maxActions: request.tool.maxActions, timeoutMs: request.tool.timeoutMs, observationIntervalMs: request.tool.observationIntervalMs, planningLeadMs, provenance: nativeMemoryProvenance(request, record) }, {
			onPlanningDue: (_status, { planningLeadMs, basis } = {}) => {
				if (this.#programRuns.get(record.agentId) !== run || this.#executionEpoch(record.agentId) !== run.epoch) return;
				// With no planner measurement, foreground callers still await their result;
				// the final-action hint is for an already detached body.
				if (planningLeadMs == null && request.tool.background !== true) return;
				const status = { ...this.#programStatus(record, run.programId), planningLeadMs, planningBasis: basis };
				if (run.pendingSuccessor != null || !this.canPrepareProgram(record, run.programId, status.programVersion)) return;
				const wasDetached = run.detached;
				run.detached = true;
				run.planningNoticed = true;
				run.detach({ ...status, advisory: 'program_planning_due', next: PLANNING_TAIL_NOTE });
				this.#trace('native_program_planning_due', { agentId: record.agentId, goalRevision: run.goalRevision,
					programId: run.programId, programVersion: status.programVersion, planningLeadMs, planningBasis: basis, timing: status.timing });
				if (wasDetached) this.#programEvent(run, { event: 'program_planning_due', status, priority: 'ordinary' });
			},
			onDecision: (_status, { priority } = {}) => {
				if (this.#programRuns.get(record.agentId) !== run || this.#executionEpoch(record.agentId) !== run.epoch) return;
				const status = this.#programStatus(record, run.programId);
				const deliver = (current) => {
					// The authored attention policy suspended the body: say which trigger paused it, once per decision.
					if (current.engineState === 'SUSPENDED' && current.decision?.decisionId !== run.pausedDecisionId) {
						run.pausedDecisionId = current.decision?.decisionId;
						this.#trace('native_program_paused', { agentId: record.agentId, goalRevision: run.goalRevision, programId: run.programId,
							programVersion: current.programVersion, trigger: current.decision?.trigger ?? null, priority: priority ?? current.decision?.priority ?? null });
					}
					const wasDetached = run.detached;
					run.detached = true;
					run.detach(current);
					this.#wakeProgramWaits(record.agentId, 'decision');
					if (wasDetached) this.#programEvent(run, { event: 'program_attention', status: current, priority });
					this.#reconsiderStandingOrders(record);
				};
				// An order whose own source declared continue_and_notify for this kind of attention keeps running as authored;
				// holding its end for that notice would leave the body idle after the reflex. Its program_ended result reports
				// it. A guard needing a new model decision ends its handler and frees the slot for the next firing.
				if (standingOrderContinues(run, status)) {
					const { decisionId, eventSequence } = status.decision;
					queueMicrotask(() => {
						if (this.#programRuns.get(record.agentId) !== run || this.#executionEpoch(record.agentId) !== run.epoch) return;
						try {
							this.#programExecutor.respond(record, { programId: run.programId, goalRevision: run.goalRevision, decisionId, eventSequence, directive: 'continue' }, { authoredPolicy: true });
							run.standingOrder.continuedAttention = (run.standingOrder.continuedAttention ?? 0) + 1;
						} catch (error) {
							this.#trace('standing_order_continue_failed', { agentId: record.agentId, programId: run.programId, reasonCode: error?.code ?? 'RESPOND_FAILED' });
							// A held order run would keep the slot until its deadline and block the next firing (A11 G1: 20 s).
							// End it; its program_ended result carries the pending decision and receipts.
							if (this.#programRuns.get(record.agentId) === run) {
								run.pendingSuccessor = null;
								run.state = 'CANCELLING';
								void this.#programExecutor.cancel(record.agentId, 'STANDING_CONTINUE_FAILED');
							}
						}
					});
					return;
				}
				if (run.standingGuard) {
					queueMicrotask(() => {
						if (this.#programRuns.get(record.agentId) !== run || this.#executionEpoch(record.agentId) !== run.epoch) return;
						run.state = 'CANCELLING';
						void this.#programExecutor.cancel(record.agentId, 'STANDING_DECISION_REQUIRED');
					});
					return;
				}
				deliver(status);
			},
			observation: structuredClone(latest.observation), eventSequence: latest.eventSequence,
			executeAction: async (command) => {
				if (this.#programRuns.get(record.agentId) !== run || this.#executionEpoch(record.agentId) !== run.epoch) throw codedError('NATIVE_PROGRAM_CANCELLED', 'Program no longer has execution authority');
				run.postResultSample = undefined;
				run.lastActionResult = null;
				const result = await this.#executeAction(request, record, { kind: 'action', actionType: command.action.type, arguments: command.action.arguments }, null, true, command, null,
					{ issuer: request.issuer ?? 'program' });
				if (run.standingGuard) this.#standing.recordGuardAction(run.guardOrder, command.action.type, result);
				lastActionResult = result;
				run.lastActionResult = result;
				const receipt = this.#receipts.get(record.agentId)?.findLast((entry) => entry.engineActionId === command.actionId);
				const breakOutcome = this.#breakOutcomes.get(result);
				return { ...result, ...(receipt === undefined ? {} : { actionId: receipt.actionId }), ...(breakOutcome === undefined ? {} : { breakOutcome: structuredClone(breakOutcome) }) };
			},
			cancelAction: (commandId) => {
				const active = this.#actions.get(record.agentId);
				if (active?.engineActionId !== commandId) return { state: 'NO_MATCHING_ACTION' };
				if (active.cancelling) return active.result;
				return this.#cancelAction(record, { actionId: active.actionId, goalRevision: active.goalRevision }, { invalidateProgram: false });
			},
			inspect: async (query) => {
				const tool = normalizeMinecraftToolCall('inspect', query);
				return withAdjustments({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await this.#inspect(tool, record) }, toolAdjustments(tool));
			},
			refreshObservation: async () => {
				const afterResult = lastActionResult;
				lastActionResult = null;
				const facts = await this.#observe(record, { includeMetadata: false, afterResult, lean: true });
				if (facts.freshness.fresh !== true) throw codedError('FRESH_OBSERVATION_REQUIRED', 'Program continuation needs a new authoritative player observation');
				const snapshot = this.#observations.get(record.agentId);
				const pending = this.#postResultSamples.get(record.agentId);
				if (afterResult !== null && afterResult === run.lastActionResult && pending?.result === afterResult
					&& snapshot?.goalRevision === record.goalRevision && snapshot.eventSequence === facts.eventSequence
					&& snapshot.eventSequence > pending.eventSequence && this.#executionEpoch(record.agentId) === run.epoch
					&& this.#programRuns.get(record.agentId) === run) run.postResultSample = { result: afterResult, snapshot };
				return { observation: facts.observation, eventSequence: facts.eventSequence };
			},
			memoryOperation: (operation) => this.#programMemory(request, record, operation),
		});
	}

	async #findProgramNote(request, record, key, assertAuthority) {
		const worldId = this.#worldId(record);
		const check = () => {
			assertAuthority();
			if (this.#worldId(record) !== worldId) throw codedError('NATIVE_PROGRAM_CANCELLED', 'Saved program lookup outlived its world');
		};
		let page;
		try {
			// Query-shaped arguments let older injected memory adapters return their
			// first page without a second read. find_note treats text as an exact key.
			page = await this.#programMemory(request, record, { operation: 'find_note', arguments: { kind: 'notes', text: key, offset: 0, limit: 64 } });
		} catch (error) {
			check();
			if (error?.code !== 'INVALID_MEMORY_OPERATION') throw error;
		}
		check();
		const matches = note => note?.key === key && (note.worldId === undefined || note.worldId === worldId);
		let note;
		if (page != null && Object.hasOwn(page, 'note')) note = matches(page.note) ? page.note : null;
		else {
			let offset = 0;
			for (;;) {
				if (page === undefined) page = await this.#programMemory(request, record, { operation: 'query', arguments: { kind: 'notes', text: key, offset, limit: 64 } });
				check();
				note = page?.entries?.find(matches);
				if (note || !Number.isSafeInteger(page?.nextOffset) || page.nextOffset <= offset) break;
				offset = page.nextOffset;
				page = undefined;
			}
		}
		if (!note) throw codedError('PROGRAM_NOTE_NOT_FOUND', 'No saved program exists at that exact notebook key');
		return note;
	}

	async #programMemory(request, record, operation) {
		if (this.#memoryOperation !== null) return this.#memoryOperation(record, operation);
		if (this.#notebook === null) throw codedError('MEMORY_UNAVAILABLE', 'Durable agent memory is unavailable');
		const worldId = this.#worldId(record);
		if (worldId === null) throw codedError('WORLD_ID_REQUIRED', 'A current observed world identity is required for durable memory');
		if (operation.operation === 'find_note' && typeof this.#notebook.findNote === 'function') {
			return { state: 'SUCCEEDED', reasonCode: 'NOTE_LOOKED_UP', note: await this.#notebook.findNote(record.agentId, { worldId, key: operation.arguments.text }) };
		}
		const tool = normalizeMinecraftToolCall(operation.operation === 'write' ? 'notebook' : 'queryMemory', operation.arguments);
		if (tool.kind === 'notebook') return { state: 'SUCCEEDED', reasonCode: 'NOTE_WRITTEN', note: await this.#notebook.writeNote(record.agentId, { worldId, key: tool.key, text: tool.text, goalRevision: record.goalRevision, provenance: operation.provenance ?? nativeMemoryProvenance(request, record) }) };
		return { state: 'SUCCEEDED', reasonCode: 'MEMORY_QUERIED', ...await this.#notebook.query(record.agentId, { worldId, kind: tool.memoryKind, offset: tool.offset, limit: tool.limit, ...(tool.text === undefined ? {} : { text: tool.text }) }) };
	}

	async #inspect(tool, record, { withSearch = true } = {}) {
		if (this.#inspectObservation === null) throw codedError('INSPECTION_UNAVAILABLE', 'Focused server inspection is unavailable; observe returns its explicit coverage limits');
		const epoch = this.#executionEpoch(record.agentId);
		const { kind: _kind, ...query } = tool;
		const result = JSON.parse(toolResultContent(await this.#inspectObservation(record, query)).contentItems[0].text);
		this.#assertCurrent(record);
		if (this.#executionEpoch(record.agentId) !== epoch) throw codedError('STALE_NATIVE_TOOL', 'Inspection request outlived its lifecycle');
		if (Number.isSafeInteger(result?.eventSequence) && result.eventSequence >= 0 && tool.section === 'entities') {
			const targets = this.#inspectedTargets.get(record.agentId) ?? new Map();
			for (const entry of result.entries ?? []) {
				const targetId = entry.uuid ?? entry.stableId;
				if (typeof targetId !== 'string') continue;
				targets.delete(targetId);
				targets.set(targetId, { goalRevision: record.goalRevision, eventSequence: result.eventSequence });
			}
			while (targets.size > 128) targets.delete(targets.keys().next().value);
			this.#inspectedTargets.set(record.agentId, targets);
		}
		if (tool.section === 'survey' && result?.survey !== undefined) this.#rememberSurvey(record, query, result, withSearch);
		return structuredClone(result);
	}

	/** The sample a repeated failure is counted at, with its time on the gameplay clock (the ledger's 60 s window). */
	#failureStamp(observation) {
		return { observation, at: this.#clock.at(observation), now: this.#clock.now() };
	}

	/** Height changes along a finished move, and known footing near a target that had none. Facts only. */
	/**
	 * The body position this action starts from: the newer of the latest observation and where the previous body action
	 * ended. Its age says how stale it is at dispatch, so a reported movement is never the sum of two actions.
	 */
	#startSample(record, latest) {
		// Both sides on the gameplay clock: wall time in production, game time under a fixture's game clock.
		const now = this.#clock.now();
		const seen = latest?.goalRevision === record.goalRevision ? observationPosition(latest.observation) : null;
		const seenAt = this.#clock.at(latest?.observation);
		const ended = this.#bodyEnds.get(record.agentId);
		const endedSample = ended?.goalRevision === record.goalRevision ? ended : null;
		const pick = endedSample !== null && (seen === null || seenAt === null || endedSample.at >= seenAt) ? endedSample : seen === null ? null : { position: seen, at: seenAt };
		return pick === null ? null : { position: pick.position, ageMs: pick.at === null ? null : Math.max(0, now - pick.at) };
	}

	#travelFacts(record, active, reasonCode, actionObservation, message) {
		const facts = {};
		const terminal = actionObservation !== null && typeof actionObservation === 'object' && observationPosition(actionObservation) !== null ? actionObservation : null;
		const travel = this.#occupancy.endTravel?.(record.agentId, terminal) ?? null;
		if (travel !== null && (Math.abs(travel.feetDy) >= 1 || travel.descendedAtLeast > 0 || travel.climbedAtLeast > 0)) facts.travel = travel;
		// A failed move after a recent walk that keeps crossing its own track: the player can see it is circling.
		if (reasonCode !== 'DESTINATION_REACHED') {
			const latest = terminal ?? this.#observations.get(record.agentId)?.observation;
			const recent = latest === undefined ? null : this.#occupancy.recentTravel?.(record.agentId, latest) ?? null;
			if (recent !== null && recent.revisits >= 4 && recent.net * 4 <= recent.walked) facts.recentTravel = recent;
		}
		if (reasonCode === 'NO_STANDABLE_PATH' && !String(message ?? '').startsWith('Start')) {
			const latest = this.#observations.get(record.agentId)?.observation;
			const footing = latest === undefined ? [] : this.#occupancy.knownFooting?.(record.agentId, latest, active.arguments) ?? [];
			if (footing.length > 0) facts.knownFooting = footing;
			if (footing.some((spot) => spot.footing === 'seen_surface')) facts.knownFootingNote = 'seen_surface: only seen; footing, headroom and hazards unverified';
		}
		return facts;
	}

	#actionStatus(record, actionId) {
		const active = actionId === undefined
			? this.#actions.get(record.agentId) ?? this.#communications.get(record.agentId)
			: [this.#actions.get(record.agentId), this.#communications.get(record.agentId)].find((entry) => entry?.actionId === actionId);
		if (active?.goalRevision === record.goalRevision && (actionId === undefined || active.actionId === actionId)) {
			return { actionId: active.actionId, goalRevision: active.goalRevision, actionType: active.actionType, state: !active.dispatched ? 'PREPARING' : active.cancelling ? 'CANCELLING' : active.cancellationUncertain ? 'CANCELLATION_UNCONFIRMED' : 'RUNNING', ...(active.progress === undefined ? {} : { progress: structuredClone(active.progress) }), ...(active.interruptedBy === undefined ? {} : { interruptedBy: active.interruptedBy }) };
		}
		if (actionId !== undefined) {
			const receipt = this.#receipts.get(record.agentId)?.findLast((entry) => entry.actionId === actionId && entry.goalRevision === record.goalRevision);
			return receipt === undefined ? { state: 'UNKNOWN_ACTION', actionId, goalRevision: record.goalRevision } : structuredClone(receipt);
		}
		const lastResult = this.#receipts.get(record.agentId)?.findLast((entry) => entry.goalRevision === record.goalRevision);
		return { state: 'IDLE', goalRevision: record.goalRevision, ...(lastResult === undefined ? {} : { lastResult: structuredClone(lastResult) }) };
	}

	#retainReceipt(record, active, result) {
		const existing = this.#receipts.get(record.agentId)?.findLast((entry) => entry.actionId === active.actionId);
		if (existing?.source === 'server_action_result' && result.source !== 'server_action_result') return existing;
		const receipt = { actionId: active.actionId, goalRevision: active.goalRevision, actionType: active.actionType, ...(active.engineActionId === undefined ? {} : { engineActionId: active.engineActionId }), ...result };
		if (result.state === 'UNKNOWN') this.#receiptRequests.set(receipt, {
			arguments: structuredClone(active.arguments), startPosition: structuredClone(active.startPosition),
			fromProgram: active.fromProgram, inSequence: active.inSequence,
		});
		const receipts = (this.#receipts.get(record.agentId) ?? []).filter((entry) => entry.actionId !== active.actionId);
		receipts.push(receipt);
		this.#receipts.set(record.agentId, receipts.slice(-64));
		return receipt;
	}

	async #journal(method, agentId, active, details = {}, options = {}) {
		if (active.worldId == null || typeof this.#notebook?.[method] !== 'function') return;
		// The dimension it was dispatched in, so a result that arrives after a portal still names the right cell.
		return this.#notebook[method](agentId, { worldId: active.worldId, actionId: active.actionId, goalRevision: active.goalRevision, actionType: active.actionType, ...(active.dimension == null ? {} : { dimension: active.dimension }), ...details }, options);
	}

	// An action that never reached the bridge is settled history, not an unknown outcome to reconcile.
	// Notebook adapters without recordNotSent keep the older unknown record.
	#journalUnsent(agentId, active, reasonCode) {
		return this.#journal(typeof this.#notebook?.recordNotSent === 'function' ? 'recordNotSent' : 'recordUnknown', agentId, active, { reasonCode });
	}

	#actionCancellationEpoch(record, active) {
		const epoch = this.#executionEpoch(record.agentId);
		const run = this.#programRuns.get(record.agentId);
		// A borrowed action preserves only its still-live program, not its historical ownership flag.
		const preservesProgram = active?.pausedProgram === true && active.goalRevision === record.goalRevision
			&& run?.goalRevision === record.goalRevision && !run.settled && run.epoch === epoch;
		return preservesProgram ? epoch : epoch + 1;
	}

	async #cancelAction(record, tool, { invalidateProgram = true, blockingRun = null, beforeCancel = null } = {}) {
		const actionMap = [this.#actions, this.#communications].find((actions) => actions.get(record.agentId)?.actionId === tool.actionId);
		const active = actionMap?.get(record.agentId);
		const rejected = this.#operationRejection(record, { ...tool, kind: 'cancel_action' });
		if (rejected !== null) throw codedError(rejected.code, rejected.message);
		// The cancel goes on from here, with no await before it is sent: a replace's yield starts now and reaches the bridge first.
		beforeCancel?.();
		this.#answerLegChain(record, tool.actionId);
		active.cancelling = true;
		active.cancellationUncertain = false;
		// cancelAction and replaceAction both end what the model was waiting on; wakes held for it are released.
		if (active.engineActionId === undefined) {
			try { this.#onModelActionCancelled(record); } catch { /* the hook only releases held wakes */ }
		}
		const cancellationEpoch = this.#actionCancellationEpoch(record, active);
		if (invalidateProgram && cancellationEpoch !== this.#executionEpoch(record.agentId)) {
			this.#executionEpochs.set(record.agentId, cancellationEpoch);
			if (this.#programRuns.has(record.agentId)) Promise.resolve(this.#programExecutor.cancel(record.agentId, 'MODEL_CANCELLED')).catch((error) => this.#trace('native_program_cancel_failed', { agentId: record.agentId, reasonCode: error?.code ?? 'PROGRAM_CANCEL_FAILED' }));
		}
		if (!active.dispatched) {
			active.cancelledBeforeDispatch = true;
			actionMap.delete(record.agentId);
			const result = { state: 'CANCELLED', reasonCode: 'CANCELLED_BEFORE_DISPATCH', executionStarted: false, physicalAttempted: false, source: 'coordinator_before_dispatch' };
			this.#retainReceipt(record, active, result);
			active.resolve(result);
			await this.#journalUnsent(record.agentId, active, 'CANCELLED_BEFORE_DISPATCH');
			return result;
		}
		let publication;
		try { publication = Promise.resolve(this.#bridge.send('action_cancel', record.agentId, { goalRevision: active.goalRevision, actionId: active.actionId })); }
		catch (error) { publication = Promise.reject(error); }
		try {
			// Socket drain may lag the exact server receipt. Publication success alone
			// cannot release physical authority; the deadline includes publication too.
			const cancellation = withDeadline(Promise.race([active.result, publication.then(() => active.result)]), 10_000, 'CANCEL_ACK_TIMEOUT', 'Cancellation has no authoritative acknowledgement; the action may still be running').catch((error) => {
				active.cancelling = false;
				active.cancellationUncertain = error?.code === 'CANCEL_ACK_TIMEOUT';
				throw error;
			});
			if (blockingRun === null) return await cancellation;
			const outcome = await Promise.race([
				cancellation.then((value) => ({ type: 'result', value }), (error) => ({ type: 'error', error })),
				blockingRun.interruption.then(() => ({ type: 'interruption' })),
			]);
			if (outcome.type === 'error') throw outcome.error;
			if (outcome.type === 'interruption') {
				const status = this.#actionStatus(record, tool.actionId);
				if (['RUNNING', 'PREPARING', 'CANCELLING', 'CANCELLATION_UNCONFIRMED'].includes(status.state)) {
					return { ...status, interruptedBy: blockingRun.interruptedBy ?? 'danger',
						recoveryHint: `Cancellation for actionId ${tool.actionId} was requested; wait for actionStatus before issuing another body action.` };
				}
				return await active.result;
			}
			return outcome.value;
		} catch (error) {
			active.cancelling = false;
			active.cancellationUncertain = error?.code === 'CANCEL_ACK_TIMEOUT';
			throw error;
		}
	}

	async #memory(request, record) {
		if (request.tool.kind === 'task_memory') {
			if (this.#memoryOperation === null) throw codedError('MEMORY_UNAVAILABLE', 'Task memory is unavailable');
			const { kind, ...argumentsValue } = request.tool;
			return this.#memoryOperation(record, { operation: 'task', arguments: argumentsValue });
		}
		const tool = request.tool;
		if (this.#memoryOperation !== null) {
			const operation = tool.kind === 'notebook' ? 'write' : 'query';
			const args = operation === 'write' ? { key: tool.key, text: tool.text } : { kind: tool.memoryKind, offset: tool.offset ?? 0, limit: tool.limit, ...(tool.text === undefined ? {} : { text: tool.text }) };
			return this.#memoryOperation(record, { operation, arguments: args, provenance: nativeMemoryProvenance(request, record) });
		}
		if (this.#notebook === null) throw codedError('MEMORY_UNAVAILABLE', 'Durable agent memory is unavailable');
		const worldId = this.#worldId(record);
		if (worldId === null) throw codedError('WORLD_ID_REQUIRED', 'A current observed world identity is required for durable memory');
		if (tool.kind === 'notebook') return this.#notebook.writeNote(record.agentId, { worldId, key: tool.key, text: tool.text, goalRevision: record.goalRevision, provenance: nativeMemoryProvenance(request, record) });
		return this.#notebook.query(record.agentId, { worldId, kind: tool.memoryKind, offset: tool.offset ?? 0, limit: tool.limit, ...(tool.text === undefined ? {} : { text: tool.text }) });
	}

	#dimension(record) {
		const latest = this.#observations.get(record.agentId);
		const dimension = latest?.goalRevision === record.goalRevision ? latest.observation?.world?.dimension : null;
		return typeof dimension === 'string' && dimension.length > 0 ? dimension : null;
	}

	#worldId(record) {
		const latest = this.#observations.get(record.agentId);
		const worldId = latest?.goalRevision === record.goalRevision ? observationWorldId(latest.observation) : null;
		return typeof worldId === 'string' && worldId.length > 0 ? worldId : null;
	}

	#assertCurrent(record) {
		const current = this.#registry?.get(record.agentId);
		if (this.#registry !== null && (current == null || current.goalRevision !== record.goalRevision)) throw codedError('STALE_NATIVE_TOOL', 'Agent goal changed while waiting for tool data');
	}

	#decorate(record, observation = {}, options = {}) {
		if (this.#decorateObservation !== null) return this.#decorateObservation(record, observation, options);
		return this.decorateObservation(record, observation, options);
	}

	/**
	 * Records a completed survey attempt at the pose and sight range the server reported, and its structure rows; the
	 * result keeps only coverage facts that vary.
	 */
	#rememberSurvey(record, query, result, withSearch) {
		const observation = this.#observations.get(record.agentId)?.observation;
		if (observation === undefined) return;
		const coverage = result.coverage ?? {};
		// Only an explicit complete finished its scan budget; a missing flag proves nothing.
		const complete = coverage.complete === true;
		const range = Number.isFinite(coverage.rangeBlocks) ? coverage.rangeBlocks : null;
		const coversStructures = (!Array.isArray(query.include) || query.include.length === 0 || query.include.includes('structures'))
			&& !(Array.isArray(query.exclude) && query.exclude.includes('structures'));
		const eye = coverage.eye;
		const attempt = complete && coversStructures && range !== null && [eye?.x, eye?.y, eye?.z, coverage.yaw, coverage.pitch].every(Number.isFinite)
			? { x: eye.x, y: eye.y, z: eye.z, yaw: coverage.yaw, pitch: coverage.pitch, range, ...(Number.isSafeInteger(coverage.gameTime) ? { tick: coverage.gameTime } : {}) } : null;
		this.#occupancy.recordSurvey?.(record.agentId, observation, { attempt, survey: result.survey });
		// The fixed ranges are in the tool description; repeating them in every result costs bytes. A fog-shortened range is a fact.
		if (result.coverage !== undefined) result.coverage = { complete, ...(range !== null && range < SURVEY_FULL_RANGE ? { rangeBlocks: range } : {}) };
		if (withSearch) {
			const search = this.#occupancy.coverage?.(record.agentId, observation);
			if (search != null) result.search = search;
		}
	}

	async #exploreFrontier(request, record) {
		const epoch = this.#executionEpoch(record.agentId);
		const facts = await this.#observe(record, { includeMetadata: false, deliver: false });
		this.#assertCurrent(record);
		if (this.#executionEpoch(record.agentId) !== epoch) throw codedError('STALE_NATIVE_TOOL', 'Frontier request outlived its lifecycle');
		// observe hydrates memory and ingests the new sample before candidates run.
		const result = { ...this.#occupancy.candidates(record.agentId, facts.observation, request.tool.arguments ?? {}), freshness: facts.freshness };
		this.#flushSpatial(record.agentId).catch((error) => this.#trace('native_spatial_memory_failed', { agentId: record.agentId, reasonCode: error?.code ?? 'MEMORY_WRITE_FAILED' }));
		return result;
	}

	async #executeLookAround(request, record, tool, executionEpoch, blockingRun, { ground = false } = {}) {
		const source = this.#observations.get(record.agentId)?.observation ?? {};
		const input = source.interaction?.input ?? {};
		const selectedSlot = Number.isSafeInteger(input.selectedSlot) && input.selectedSlot >= 0 && input.selectedSlot <= 8
			? input.selectedSlot : 0;
		const hand = input.hand === 'off_hand' ? 'off' : 'main';
		const results = [];
		const views = [];
		const surveys = [];
		for (let index = 0; index < tool.steps; index += 1) {
			if (this.#executionEpoch(record.agentId) !== executionEpoch) throw codedError('NATIVE_ACTION_CANCELLED', 'Camera sweep cancelled before its next step');
			blockingRun.lookAround = { runningStep: index + 1, completedSteps: results.length, remainingSteps: tool.steps - index - 1 };
			const action = {
				kind: 'action',
				actionType: 'control',
				arguments: {
					forward: 0, strafe: 0, jump: false, sneak: false, sprint: false,
					attack: false, use: false,
					yaw: wrapDegrees(tool.centerYaw + ((index + 1) * 360) / tool.steps),
					pitch: tool.pitch, selectedSlot, hand, ticks: tool.ticksPerStep,
				},
			};
			const result = await this.#executeAction(request, record, action, index);
			results.push({ actionType: action.actionType, ...result });
			if (result.state === 'RUNNING') return { ...result, lookAround: blockingRun.lookAround, results, ...sweepSightings(views) };
			if (result.state !== 'SUCCEEDED') return { state: result.state, completed: results.length, failedAt: index, results, ...sweepSightings(views) };
			const facts = await this.#observe(record, { includeMetadata: false, afterResult: result, deliver: false });
			if (facts.freshness.fresh !== true) throw codedError('FRESH_OBSERVATION_REQUIRED', 'Camera sweep needs a fresh observation at each heading');
			views.push(sweepView(facts, action.arguments));
			// Each heading is surveyed only once the body faces it: no free 360.
			if (tool.survey !== undefined) surveys.push({ yaw: action.arguments.yaw, result: await this.#inspect({ kind: 'inspect', ...tool.survey }, record, { withSearch: false }) });
		}
		const finalYaw = views.at(-1)?.yaw ?? tool.centerYaw;
		const search = tool.survey === undefined ? null : this.#occupancy.coverage?.(record.agentId, this.#observations.get(record.agentId)?.observation ?? {});
		// Successful turns carry no facts beyond completed; the sightings are the result.
		return { state: 'SUCCEEDED', completed: results.length, ...sweepSightings(views), ...(tool.survey === undefined ? {} : { survey: { ...mergeSurveys(surveys, finalYaw, tool.survey.limit), ...(search == null ? {} : { search }) } }),
			...(ground ? { ground: views.map(groundOfView) } : {}) };
	}

	/**
	 * obtain: the whole chain to hold an item (obtain-runner.mjs), each move an ordinary body call made here as gather
	 * makes its own: act, mine, moveTo and gather itself, from fresh observations, with no model turn between them.
	 * Danger interrupting the blocking run ends it with what is done so far.
	 */
	async #executeObtain(request, record, tool, executionEpoch, blockingRun) {
		let steps = 0;
		const current = () => this.#executionEpoch(record.agentId) === executionEpoch;
		const interrupted = () => blockingRun.interruptedBy !== null;
		const halted = () => ({ state: 'INTERRUPTED', reasonCode: blockingRun.forkStop?.reasonCode ?? 'DANGER' });
		const run = async (name, args) => {
			if (!current()) throw codedError('NATIVE_ACTION_CANCELLED', 'obtain cancelled before its next step');
			if (interrupted()) return halted();
			steps += 1;
			let normalized;
			try { normalized = normalizeMinecraftToolCall(name, args); }
			catch (error) { return { state: 'FAILED', reasonCode: error?.code ?? 'INVALID_MINECRAFT_TOOL_ARGUMENTS', message: String(error?.message ?? error).slice(0, 300) }; }
			const actions = normalized.kind === 'sequence' ? normalized.actions.map((action) => ({ kind: 'action', ...action })) : [normalized];
			let result = null;
			for (const action of actions) {
				try { result = await this.#executeAction(request, record, action, steps); }
				catch (error) {
					if (!current()) throw error;
					return { state: 'FAILED', reasonCode: error?.code ?? 'ACTION_ERROR', message: String(error?.message ?? error).slice(0, 300) };
				}
				if (result?.state !== 'SUCCEEDED') break;
			}
			return result;
		};
		const body = {
			observe: async () => {
				if (!current()) throw codedError('NATIVE_ACTION_CANCELLED', 'obtain cancelled');
				const facts = await this.#observe(record, { includeMetadata: false, deliver: false });
				if (facts.freshness?.fresh !== true) throw codedError('FRESH_OBSERVATION_REQUIRED', 'obtain needs a fresh observation at each step');
				return facts.observation ?? {};
			},
			act: (actionType, args) => run('act', { actionType, arguments: args }),
			mine: (args) => run('mine', args),
			moveTo: (args) => run('moveTo', args),
			gather: async ({ itemIds, ...args }) => {
				if (!current()) throw codedError('NATIVE_ACTION_CANCELLED', 'obtain cancelled before its next step');
				if (interrupted()) return halted();
				const normalized = normalizeMinecraftToolCall('gather', { itemId: itemIds[0], ...args });
				try { return await this.#executeGather(request, record, { ...normalized, arguments: { ...normalized.arguments, itemIds } }, executionEpoch, blockingRun); }
				catch (error) {
					if (!current()) throw error;
					return { state: 'FAILED', reasonCode: error?.code ?? 'ACTION_ERROR', message: String(error?.message ?? error).slice(0, 300) };
				}
			},
			// A place obtain could not reach (an ore across a cave): kept with the searches' missed places, so find no longer
			// reports it or its vein as a sighting.
			missPlace: (place, why) => this.#searchBody(request, record, executionEpoch, blockingRun, 'obtain').missPlace(place, why),
			// The last open-sky spot the body stood on (kept from every sample): a way out of water it filled in with no dry
			// ground stood on during this obtain.
			openSky: () => this.#searchBody(request, record, executionEpoch, blockingRun, 'obtain').openSky(),
			// A source obtain cannot see is found by find's own search (find-search.mjs), on the same body and blocking run.
			search: async (target, options) => {
				if (!current()) throw codedError('NATIVE_ACTION_CANCELLED', 'obtain cancelled before its search');
				// find's steps show in obtain's own log (they were invisible: a death inside a search left no trail).
				const searchBody = this.#searchBody(request, record, executionEpoch, blockingRun, 'obtain');
				const progress = searchBody.progress;
				searchBody.progress = (facts) => { progress(facts); this.#trace('native_obtain_step', { agentId: record.agentId, goalRevision: record.goalRevision, step: steps, text: `find: ${facts.label}` }); };
				blockingRun.searching = true;
				try { return await searchFor(target, searchBody, options); }
				catch (error) {
					if (!current()) throw error;
					return { state: 'FAILED', reasonCode: error?.code ?? 'ACTION_ERROR', message: String(error?.message ?? error).slice(0, 300) };
				}
				finally { blockingRun.searching = false; }
			},
			// Every visible block in the 13x7x13 cube round the body (a sample lists at most 8 of a kind): where a station fits.
			blocksNear: async () => {
				const rows = [];
				try {
					for (let offset = 0; offset < 160; offset += 32) {
						const page = await this.#inspect({ kind: 'inspect', section: 'blocks', offset, limit: 32 }, record, { withSearch: false });
						const entries = Array.isArray(page?.entries) ? page.entries : page?.entries?.$rows ? page.entries.$rows.rows.map((row) => Object.fromEntries(page.entries.$rows.columns.map((column, index) => [column, row[index]]))) : [];
						rows.push(...entries);
						if (page?.coverage?.hasMore !== true) break;
					}
				} catch { /* the sample's own rows still serve */ }
				return rows;
			},
			stopped: () => !current(),
			interrupted,
			// The fork that stopped this run ({reasonCode, message}), or null for danger: obtain ends with its code.
			forkStop: () => blockingRun.forkStop,
			recovering: (state) => { blockingRun.recovering = state; },
			note: (text) => {
				blockingRun.obtain = { step: steps, label: text };
				this.#trace('native_obtain_step', { agentId: record.agentId, goalRevision: record.goalRevision, step: steps, text });
			},
		};
		// Stations an earlier obtain placed and did not pick up (danger ended it) are this call's to pick up, and the
		// furnace loads it left smelting are this call's to take out. Flooded approaches share this per-agent ledger.
		if (!this.#obtainPlaced.has(record.agentId)) this.#obtainPlaced.set(record.agentId, { placed: [], loads: [], approaches: [] });
		const kept = this.#obtainPlaced.get(record.agentId);
		const stations = { now: this.#clock.now, placed: kept.placed, loads: kept.loads, approaches: kept.approaches };
		const result = await runObtain(tool.arguments, body, stations);
		if (!this.#kitHabit || result?.state !== 'SUCCEEDED' || interrupted() || !current()) return result;
		// The kit habit (kit-habit.mjs): from what is held, keep a shield, armour and food in reach before handing back.
		// What this obtain handed back is kept from kit crafts (obtain iron_ingot count 3 keeps its 3 ingots).
		const asked = resolveObtainItem(tool.arguments?.item ?? '');
		const reserved = asked.ids.length > 0 ? { ids: asked.ids, count: Number.isSafeInteger(tool.arguments?.count) && tool.arguments.count > 0 ? tool.arguments.count : 1 } : null;
		let kit;
		const stop = {};
		try {
			// Furnace loads an earlier obtain left are the next obtain's to collect, not a kit craft's walk.
			kit = await keepKit(body, (item) => runObtain({ item, count: 1, timeoutMs: KIT_CRAFT_TIMEOUT_MS }, body, { ...stations, loads: [] }),
				{ stopped: () => interrupted() || !current(), reserved, stop });
		} catch (error) {
			if (!current()) throw error;
			kit = [`stopped (${error?.code ?? 'error'})`];
		}
		const halt = stop.result ?? null;
		const cut = interrupted() || ['INTERRUPTED', 'RUNNING', 'PREPARING'].includes(halt?.state);
		if (kit.length === 0 && !cut) return result;
		this.#trace('native_obtain_step', { agentId: record.agentId, goalRevision: record.goalRevision, step: steps, text: `kit: ${kit.join(', ')}` });
		const message = `${result.message ?? 'obtained'}; kit: ${kit.join(', ')}`;
		if (!cut) return { ...result, kit, message };
		// Danger during kit upkeep is handed back as obtain's own interruption: the item is held, the action still running
		// (an equip, a kit craft's leg) is the model's to replace or cancel.
		const running = halt?.state === 'INTERRUPTED' ? halt.running ?? null
			: typeof halt?.actionId === 'string' ? { actionId: halt.actionId, ...(halt.recoveryHint ? { recoveryHint: halt.recoveryHint } : {}) } : null;
		return { ...result, ...halted(), ...(halt?.state === 'INTERRUPTED' && halt.reasonCode ? { reasonCode: halt.reasonCode } : {}),
			...(running === null ? {} : { running }), kit,
			message: `${message}; stopped for danger after the item was obtained; decide, then carry on` };
	}

	/**
	 * gather: break seen blocks of the asked ids, the one nearest the last broken first (a whole tree, then the next),
	 * walking into reach and picking up the drops, until the body holds the asked count. Each step is an ordinary body
	 * action (moveTo, mine, pick_up_item) chosen from a fresh observation; no model turn between them. The recorded Oct 29
	 * Terra game took 6 calls for 4 logs (chop 2, craft, chop 1, craft...) and fiddled with the camera at each tree.
	 */
	async #executeGather(request, record, tool, executionEpoch, blockingRun) {
		const { itemId, count, blockIds, radius, timeoutMs } = tool.arguments;
		// obtain asks for any of several items (any log): each counts toward the count and each drop is picked up.
		const counted = new Set(tool.arguments.itemIds ?? [itemId]);
		const wanted = new Set(blockIds);
		const now = this.#clock.now, startedAt = now();
		const failed = new Set(), triedItems = new Set(), reasons = [];
		let last = null, broken = 0, picked = 0, misses = 0, steps = 0, held = 0, startHeld = null, lookedUp = null, sweeps = 0, farWalks = 0;
		const step = async (call, label) => {
			if (this.#executionEpoch(record.agentId) !== executionEpoch) throw codedError('NATIVE_ACTION_CANCELLED', 'gather cancelled before its next step');
			steps += 1;
			blockingRun.gather = { step: steps, label, broken, picked, held };
			const normalized = normalizeMinecraftToolCall(call.name, call.arguments);
			const actions = normalized.kind === 'sequence' ? normalized.actions.map((action) => ({ kind: 'action', ...action })) : [normalized];
			let result = null;
			for (const action of actions) {
				result = await this.#executeAction(request, record, action, steps);
				if (result.state !== 'SUCCEEDED') break;
			}
			return result;
		};
		const end = (state, reasonCode, why) => ({ state, reasonCode, held, broken, picked, steps,
			message: `${why}. Holding ${held} ${itemId} (asked ${count}, ${held - (startHeld ?? held)} gained); broke ${broken} block(s), picked up ${picked} drop(s) in ${steps} step(s) over ${Math.round((now() - startedAt) / 1000)} s` });
		while (true) {
			if (this.#executionEpoch(record.agentId) !== executionEpoch) throw codedError('NATIVE_ACTION_CANCELLED', 'gather cancelled before its next step');
			const facts = await this.#observe(record, { includeMetadata: false, deliver: false });
			if (facts.freshness?.fresh !== true) throw codedError('FRESH_OBSERVATION_REQUIRED', 'gather needs a fresh observation at each step');
			const o = facts.observation ?? {};
			held = (o.inventory?.items ?? []).filter((item) => counted.has(item?.itemId)).reduce((sum, item) => sum + (item.count ?? 0), 0);
			startHeld ??= held;
			if (held >= count) return end('SUCCEEDED', 'GATHER_DONE', `Gathered: holding ${count} or more ${itemId}`);
			const health = o.player?.health;
			if (Number.isFinite(health) && health <= 8) return end('FAILED', 'LOW_HEALTH', `Health ${health}: stopped gathering`);
			if (now() - startedAt >= timeoutMs) return end('TIMED_OUT', 'GATHER_TIMEOUT', `timeoutMs ${timeoutMs} ran out`);
			if (misses >= 3) return end('FAILED', 'GATHER_STUCK', `3 targets in a row out of reach (${reasons.slice(-3).join('; ')})`);
			const body = gatherBodyAt(o);
			if (body === null) throw codedError('FRESH_OBSERVATION_REQUIRED', 'gather needs the body position');
			// Drops first: a broken log's item lies at the trunk until it is walked over.
			const drop = (o.items ?? []).filter((row) => counted.has(row?.itemId) && typeof row.stableId === 'string' && !triedItems.has(row.stableId)
				&& [row.x, row.y, row.z].every(Number.isFinite) && Math.hypot(row.x - body.x, row.y - body.y, row.z - body.z) <= 8)
				.sort((a, b) => Math.hypot(a.x - body.x, a.z - body.z) - Math.hypot(b.x - body.x, b.z - body.z))[0];
			if (drop !== undefined) {
				triedItems.add(drop.stableId);
				const result = await step({ name: 'act', arguments: { actionType: 'pick_up_item', arguments: { targetSelector: drop.stableId, timeoutMs: gatherStepTimeout(30_000, startedAt + timeoutMs, now()) } } }, 'pick up');
				if (result?.state === 'SUCCEEDED') picked += 1;
				continue;
			}
			let target = gatherTarget(o, wanted, radius, body, last, failed);
			// Nothing within the 6-block observation: as a player, look up the trunk just cut (its next log hides in the
			// leaves), then search what is in view out to 24 blocks, then look round once and search every heading.
			if (target === null && last !== null && lookedUp !== `${last.x},${last.y},${last.z}`) {
				lookedUp = `${last.x},${last.y},${last.z}`;
				await step({ name: 'act', arguments: { actionType: 'look_at', arguments: { x: last.x + 0.5, y: last.y + 1.5, z: last.z + 0.5 } } }, 'look up the trunk');
				continue;
			}
			if (target === null) {
				const search = { include: [...wanted].slice(0, 4).map((id) => `blocks:${id}`), limit: 8 };
				const rowsOf = (result) => (result?.survey?.blocks ?? []).filter((row) => wanted.has(row?.blockId) && [row.x, row.y, row.z].every(Number.isSafeInteger)
					&& !failed.has(`${row.x},${row.y},${row.z}`) && Math.hypot(row.x + 0.5 - body.x, row.z + 0.5 - body.z) <= radius);
				let rows = [];
				try {
					rows = rowsOf(await this.#inspect({ kind: 'inspect', section: 'survey', ...search }, record, { withSearch: false }));
					if (rows.length === 0 && sweeps < 2) {
						sweeps += 1;
						const yaw = Number.isFinite(o.player?.yaw) ? o.player.yaw : 0;
						const sweep = normalizeMinecraftToolCall('lookAround', { centerYaw: ((yaw + 180) % 360 + 360) % 360 - 180, pitch: 10, steps: 4, ticksPerStep: 2, survey: search });
						if (this.#executionEpoch(record.agentId) !== executionEpoch) throw codedError('NATIVE_ACTION_CANCELLED', 'gather cancelled before its next step');
						steps += 1;
						blockingRun.gather = { step: steps, label: 'look around', broken, picked, held };
						rows = rowsOf(await this.#executeLookAround(request, record, sweep, executionEpoch, blockingRun));
					}
				} catch (error) {
					// Bulk terrain (stone, gravel, dirt) is not searchable: gather goes on with what is in view.
					if (!['INSPECTION_UNAVAILABLE', 'INVALID_INSPECTION'].includes(error?.code)) throw error;
				}
				const far = rows.sort((a, b) => Math.hypot(a.x - body.x, a.z - body.z) - Math.hypot(b.x - body.x, b.z - body.z))[0];
				if (far !== undefined) target = { x: far.x, y: far.y, z: far.z, blockId: far.blockId, far: true };
			}
			if (target === null) return end(broken > 0 ? 'SUCCEEDED' : 'FAILED', 'NO_TARGET', `No seen ${[...wanted].map((id) => id.replace(/^minecraft:/, '')).join('/')} within ${radius} blocks${broken > 0 ? ' any more' : ''}: look around or move closer, then gather again`);
			const key = `${target.x},${target.y},${target.z}`;
			if (!gatherInReach(body, target)) {
				const stand = gatherStand(o, wanted, target, body);
				const moved = await step({ name: 'moveTo', arguments: { x: stand.x, y: stand.y, z: stand.z, tolerance: 1.5, timeoutMs: gatherStepTimeout(20_000, startedAt + timeoutMs, now()) } }, 'walk');
				const after = gatherBodyAt((await this.#observe(record, { includeMetadata: false, deliver: false })).observation ?? {});
				// A walk toward a far sighting brings the exact blocks into the 6-block observation; the next step picks them.
				if (target.far && after !== null && !gatherInReach(after, target)) {
					failed.add(key);
					if (++farWalks > 6) return end('FAILED', 'GATHER_STUCK', `6 walks toward far sightings without one in reach (last ${key}: ${moved?.reasonCode ?? 'no move'})`);
					continue;
				}
				if (after === null || !gatherInReach(after, target)) {
					reasons.push(`${key}: ${moved?.state === 'SUCCEEDED' ? 'still out of reach' : moved?.reasonCode ?? 'no move'}`);
					failed.add(key);
					misses += 1;
					continue;
				}
			}
			const result = await step({ name: 'mine', arguments: { x: target.x, y: target.y, z: target.z, expectedBlockId: target.blockId, autoAim: true, timeoutMs: gatherStepTimeout(15_000, startedAt + timeoutMs, now()) } }, 'break');
			// Broken but nothing dropped for want of the right tool (a worn-out pickaxe, stone by hand): a player sees nothing
			// fall and stops. Scripted gate seed 1: 22 stone blocks punched by hand, 8 s each, for no cobblestone.
			if (result?.state === 'SUCCEEDED' && /no block drops without correct tool/i.test(String(result?.message ?? '')))
				return end('FAILED', 'NO_TOOL', `${target.blockId.replace(/^minecraft:/, '')} at ${key} broke with no drop: ${String(result.message).match(/needs [^;]+/)?.[0] ?? 'the right tool is not held'}`);
			if (result?.state === 'SUCCEEDED') { broken += 1; last = target; misses = 0; sweeps = 0; continue; }
			reasons.push(`${key}: ${result?.reasonCode ?? 'not broken'}`);
			failed.add(key);
			misses += 1;
		}
	}

	/**
	 * find: search for a block, biome, mob or structure as a player does and stop the moment it is seen (find-search.mjs
	 * decides how). Every move is an ordinary body action (lookAround, travel_to, dig_to, fight_target) from a fresh
	 * sample; no model turn between them. A target with no body-side sighting check (a mob, biome or structure) is
	 * watched on samples during each leg, and the leg is cancelled when it shows.
	 */
	async #executeFind(request, record, tool, executionEpoch, blockingRun) {
		const { timeoutMs, within, ...target } = tool.arguments;
		blockingRun.searching = true;
		try { return await searchFor(target, this.#searchBody(request, record, executionEpoch, blockingRun, 'find'), { timeoutMs, within }); }
		finally { blockingRun.searching = false; }
	}

	/** The body a search drives: fresh samples, a look around, single body actions with a sighting watch, and memory. */
	#searchBody(request, record, executionEpoch, blockingRun, label) {
		const { agentId } = record;
		let steps = 0;
		const world = this.#observations.get(agentId)?.observation?.world;
		const scope = `${record.goalRevision}:${world?.worldId}:${world?.dimension}`;
		if (this.#portalSearches.get(agentId)?.scope !== scope) this.#portalSearches.set(agentId, { scope, state: {} });
		const eyeSearchState = this.#portalSearches.get(agentId).state;
		const live = () => { if (this.#executionEpoch(agentId) !== executionEpoch) throw codedError('NATIVE_ACTION_CANCELLED', `${label} cancelled before its next step`); };
		const latest = () => this.#observations.get(agentId)?.observation ?? {};
		return {
			eyeSearchState,
			now: () => this.#clock.now(),
			progress: (facts) => { blockingRun[label] = { step: steps, ...facts }; },
			observe: async () => {
				live();
				const facts = await this.#observe(record, { includeMetadata: false, deliver: false });
				if (facts.freshness?.fresh !== true) throw codedError('FRESH_OBSERVATION_REQUIRED', `${label} needs a fresh observation at each step`);
				return facts.observation ?? {};
			},
			look: async ({ pitch, survey }) => {
				live();
				steps += 1;
				const yaw = Number.isFinite(latest().player?.yaw) ? latest().player.yaw : 0;
				const sweep = normalizeMinecraftToolCall('lookAround', { centerYaw: ((yaw + 180) % 360 + 360) % 360 - 180, pitch, steps: 4, ticksPerStep: 2, survey });
				try { return await this.#executeLookAround(request, record, sweep, executionEpoch, blockingRun, { ground: true }); }
				catch (error) { if (error?.code === 'INSPECTION_UNAVAILABLE') return null; throw error; }
			},
			act: async (actionType, args, { watch = null } = {}) => {
				live();
				steps += 1;
				// escape is a step the model starts with do_step, hidden from its act; a helper (find's wet hole) runs it as the
				// same body action do_step escape starts, with that step's 60 s timeout.
				const action = actionType === 'escape' ? { kind: 'action', actionType, arguments: { timeoutMs: 60_000, ...args } }
					: normalizeMinecraftToolCall('act', { actionType, arguments: args });
				if (action.kind !== 'action') throw codedError('INVALID_NATIVE_TOOL', `${label} expected one body action for ${actionType}`);
				let seen = null, running = true, timer = null, wake = null, release = null;
				// Samples arrive with each published change; a watched leg also asks for one every 2 s. The leg's end wakes the
				// sleep and releases a sample still on its way, so the next leg never waits on the watcher (the sleep cost about
				// 1.5 s after every failed search leg).
				const stopped = new Promise((resolve) => { release = resolve; });
				const stop = () => { running = false; this.#clock.clearTimeout(timer); wake?.(); release(null); };
				const watcher = watch === null ? null : (async () => {
					while (running) {
						await new Promise((resolve) => { wake = resolve; timer = this.#clock.setTimeout(resolve, 2_000); });
						if (!running || this.#executionEpoch(agentId) !== executionEpoch) return;
						let sample = latest();
						try { sample = (await Promise.race([this.#observe(record, { includeMetadata: false, deliver: false }), stopped]))?.observation ?? sample; } catch { /* the latest pushed sample stands */ }
						if (!running) return;
						seen = watch(sample);
						if (seen === null) continue;
						const active = this.#actions.get(agentId);
						if (active !== undefined && active.goalRevision === record.goalRevision) {
							try { await this.#cancelAction(record, { actionId: active.actionId, goalRevision: record.goalRevision }, { invalidateProgram: false, blockingRun }); } catch { /* it ended on its own */ }
						}
						return;
					}
				})();
				let result;
				try { result = await this.#executeAction(request, record, action, steps); }
				finally { stop(); }
				await watcher;
				return seen === null ? result : { ...result, seen };
			},
			frontier: (observation) => {
				try { return this.#occupancy.candidates(agentId, observation, { radius: 64, limit: 24 }); } catch { return null; }
			},
			known: (observation, blocks = /(^|:)(lava|[a-z_]+_ore|ancient_debris)$/) => {
				try { return this.#occupancy.knownSources?.(agentId, observation, blocks) ?? null; } catch { return null; }
			},
			openSky: () => {
				const row = this.#openSky.get(agentId);
				return row === undefined || row.dimension !== (latest().world?.dimension ?? null) ? null : { x: row.x, y: row.y, z: row.z };
			},
			missedPlaces: () => {
				const dimension = latest().world?.dimension ?? null;
				return (this.#missedPlaces.get(agentId) ?? []).filter((row) => row.dimension === dimension);
			},
			missPlace: (place, why) => {
				const rows = this.#missedPlaces.get(agentId) ?? [];
				rows.push({ x: place.x, y: place.y, z: place.z, dimension: latest().world?.dimension ?? null, why: String(why ?? '').slice(0, 64),
					...(typeof place.blockId === 'string' ? { blockId: place.blockId } : {}) });
				if (rows.length > MISSED_PLACES) rows.shift();
				this.#missedPlaces.set(agentId, rows);
			},
			places: async () => {
				if (this.#memoryOperation === null) return [];
				const page = await this.#memoryOperation(record, { operation: 'task', arguments: { operation: 'query', query: { kind: 'place', limit: 32 } } });
				const rows = [];
				const collect = (value, depth = 0) => {
					if (depth > 4 || value === null || typeof value !== 'object') return;
					if (Array.isArray(value)) { for (const entry of value) collect(entry, depth + 1); return; }
					if (value.position !== undefined && [value.position?.x, value.position?.y, value.position?.z].every(Number.isFinite)) { rows.push(value); return; }
					for (const entry of Object.values(value)) collect(entry, depth + 1);
				};
				collect(page);
				return rows;
			},
		};
	}

	/**
	 * A look-around asking the same as one finished under a minute ago, within 8 blocks of where it ran and with no
	 * threat in view now, returns that sweep without turning the camera again. The recorded Oct 29 Terra game swept 9 times
	 * in 5 minutes, mostly a few blocks apart; the camera spinning was what he saw. A threat in view always sweeps.
	 */
	#recentSweep(record, tool) {
		const last = this.#lastSweeps.get(record.agentId);
		const observation = this.#observations.get(record.agentId)?.observation ?? {};
		const at = gatherBodyAt(observation);
		if (last === undefined || last.goalRevision !== record.goalRevision || at === null || last.key !== sweepKey(tool)) return null;
		const ageMs = this.#clock.now() - last.at, moved = Math.hypot(at.x - last.from.x, at.y - last.from.y, at.z - last.from.z);
		const threats = observation.player?.threats ?? observation.threats?.entries ?? observation.threats ?? [];
		if (ageMs > SWEEP_REUSE_MS || moved > SWEEP_REUSE_BLOCKS || (Array.isArray(threats) && threats.length > 0)) return null;
		return { ...last.result, reused: `same view as ${Math.round(ageMs / 1000)} s ago, ${Math.round(moved)} blocks from here; the camera did not turn` };
	}

	async #executeSequence(request, record, executionEpoch, lifecycleGeneration = null, blockingRun) {
		const finishToken = request.tool.finish === undefined ? null : {};
		if (finishToken !== null) {
			if (this.#sequenceFinishReservations.has(record.agentId)) throw codedError('NATIVE_ACTION_IN_PROGRESS', 'A finishing native sequence already owns this player');
			this.#sequenceFinishReservations.set(record.agentId, finishToken);
		}
		try {
			const startingEventSequence = this.#observations.get(record.agentId)?.goalRevision === record.goalRevision
				? this.#observations.get(record.agentId).eventSequence : 0;
			const results = [];
			let failedAt;
			let lastResult = null;
			let hasPostActionFacts = false;
			for (let index = 0; index < request.tool.actions.length; index += 1) {
				if (this.#executionEpoch(record.agentId) !== executionEpoch) throw codedError('NATIVE_ACTION_CANCELLED', 'Native sequence cancelled before its next action');
				const action = request.tool.actions[index];
				// Classified before dispatch: eating the last food removes the evidence that it was food.
				// After an earlier step the hand may have changed (select, swap, control) before its observation arrives, so a
				// later use_item takes the sample rather than trusting the cached hand.
				hasPostActionFacts ||= index > 0 && action.actionType === 'use_item' || this.#needsPostActionFacts(record, action);
				blockingRun.sequence = { runningStep: index + 1, completedSteps: results.length, remainingSteps: request.tool.actions.length - index - 1 };
				// The first step is the model's own choice (its response); later steps carry out the plan it already made.
				lastResult = await this.#executeAction(request, record, { kind: 'action', ...action }, index, true, null, finishToken, index === 0 ? { issuer: 'model' } : undefined);
				if (lastResult.state === 'RUNNING') return { ...lastResult,
					sequence: blockingRun.sequence, ...(results.length === 0 ? {} : { results }) };
				results.push({ actionType: action.actionType, ...lastResult });
				if (lastResult.state !== 'SUCCEEDED') { failedAt = index; break; }
			}
			const outcome = { state: failedAt === undefined ? 'SUCCEEDED' : results.at(-1).state, completed: results.length, ...(failedAt === undefined ? {} : { failedAt }), results };
			if (finishToken === null) return hasPostActionFacts
				? this.#withPostAction(record, outcome, executionEpoch, lastResult) : outcome;

			if (failedAt !== undefined) {
				const withFacts = hasPostActionFacts ? await this.#withPostAction(record, outcome, executionEpoch, lastResult) : outcome;
				return { ...withFacts, finish: { state: 'SKIPPED', reasonCode: 'ACTION_FAILED' } };
			}

			const withFreshFacts = await this.#withPostAction(record, outcome, executionEpoch, lastResult);
			const facts = withFreshFacts.postAction;
			if (facts?.freshness?.fresh !== true || !Number.isSafeInteger(facts.eventSequence) || facts.eventSequence <= startingEventSequence) {
				return { ...withFreshFacts, finish: { state: 'SKIPPED', reasonCode: 'FRESH_OBSERVATION_REQUIRED' } };
			}
			try {
				this.#assertCurrent(record);
				if (this.#executionEpoch(record.agentId) !== executionEpoch) throw codedError('STALE_NATIVE_TOOL', 'Sequence lifecycle changed before goal verification');
			} catch (error) {
				return { ...withFreshFacts, finish: { state: 'SKIPPED', reasonCode: error?.code ?? 'STALE_NATIVE_TOOL' } };
			}
			const finishRequest = { ...request, tool: { kind: 'finish', summary: request.tool.finish.summary } };
			const finish = await this.#finish(finishRequest, record, lifecycleGeneration, finishToken);
			return { ...withFreshFacts, finish };
		} finally {
			if (finishToken !== null && this.#sequenceFinishReservations.get(record.agentId) === finishToken) this.#sequenceFinishReservations.delete(record.agentId);
		}
	}

	/**
	 * The direct tool as #executeAction will dispatch it (plan count mode applied); the planner budgets the call's lease
	 * from this. Sequences and other kinds are returned unchanged.
	 */
	effectiveTool(tool, record) {
		if (tool === null || typeof tool !== 'object' || !PLAN_COUNT_ACTIONS.has(tool.actionType)) return tool;
		return this.#planCounted(tool, record, true).tool;
	}

	#planCounted(tool, record, direct) {
		let needs = [];
		if (direct && this.#planNeeds !== null) { try { needs = this.#planNeeds(record) ?? []; } catch { needs = []; } }
		const seen = this.#observations.get(record.agentId);
		const entities = direct && seen?.goalRevision === record.goalRevision ? seen.observation?.entities ?? [] : [];
		return planCountDefault(tool, { needs, entities });
	}

	async #executeAction(request, record, tool, sequenceIndex = null, waitForCompletion = true, programCommand = null, sequenceFinishToken = null, { pausedProgram = false, issued = null, issuer = null } = {}) {
		// All native routes, including replacement and authored programs, meet here.
		tool = constrainNavigationAction(tool, record.currentGoalSpec);
		// A fight the model called directly on a mob whose drop its plan counts runs to that count (plan-count.mjs).
		let planCount = null;
		if (PLAN_COUNT_ACTIONS.has(tool.actionType)) {
			const counted = this.#planCounted(tool, record, sequenceIndex === null && programCommand === null);
			tool = counted.tool;
			planCount = counted.note ?? null;
			if (planCount !== null && waitForCompletion) {
				const durationMs = countSkillDurationMs(tool);
				if (durationMs !== null) { try { request.extendLease?.(durationMs); } catch { /* the lease is the planner's */ } }
			}
		}
		// Classified before dispatch: eating the last food removes the evidence that it was food.
		const sampleAfter = sequenceIndex === null && programCommand === null && this.#needsPostActionFacts(record, tool);
		const communication = tool.actionType === 'chat';
		const actionMap = communication ? this.#communications : this.#actions;
		const finishReservation = this.#sequenceFinishReservations.get(record.agentId);
		if (!communication && finishReservation !== undefined && finishReservation !== sequenceFinishToken) throw codedError('NATIVE_ACTION_IN_PROGRESS', 'A finishing native sequence owns the player');
		const executionEpoch = this.#executionEpoch(record.agentId);
		const bodyAction = this.#actions.get(record.agentId);
		if (communication && this.#communications.has(record.agentId)) throw codedError('NATIVE_ACTION_IN_PROGRESS', 'A chat is still being delivered; wait for its result before sending another say call');
		if (!communication && bodyAction !== undefined) {
			const message = tool.actionType === 'fight_target' && bodyAction.actionType === 'fight_target'
				? `A fight_target owns the body as actionId ${bodyAction.actionId}; use replaceAction with that actionId and your authored fight_target to switch targets, or cancelAction with the same actionId to stop it.`
				: `Body action ${bodyAction.actionId} is still running; use replaceAction with that actionId and your authored fight_target/flee_from to switch now, cancelAction with the same actionId to stop it, or send this call with after:"${bodyAction.actionId}" to start it once that action succeeds.`;
			throw codedError('NATIVE_ACTION_IN_PROGRESS', message);
		}
		if (!communication && this.#completions.has(record.agentId)) throw codedError('NATIVE_COMPLETION_IN_PROGRESS', 'Goal completion verification is already running');

		const ordinal = ++this.#sequence;
		const identity = `${this.#sessionId}:${ordinal}:${safeSegment(record.agentId).slice(0, 32)}:${record.goalRevision}`;
		// The envelope and authorship must identify the same trace at the wire boundary.
		const traceId = validateTraceId(programCommand?.provenance.traceId ?? `native-${identity.replaceAll(':', '-')}`);
		const actionId = `native:${identity}`;
		// Callers that must report this exact action (replacements) read its ID here, not from later receipts.
		if (issued !== null) issued.actionId = actionId;
		const targetId = tool.arguments?.targetId ?? tool.arguments?.targetSelector;
		const latest = this.#observations.get(record.agentId);
		const currentTarget = latest?.goalRevision === record.goalRevision
			&& !latest.observation.continuity?.rememberedSections?.includes('entities')
			&& latest.observation.entities?.some((entry) => (entry.uuid ?? entry.stableId) === targetId) === true;
		const inspected = currentTarget ? undefined : this.#inspectedTargets.get(record.agentId)?.get(targetId);
		const eventSequence = inspected?.goalRevision === record.goalRevision ? inspected.eventSequence : latest?.eventSequence ?? 0;
		const payload = {
			traceId,
			goalRevision: record.goalRevision,
			actionId,
			actionType: tool.actionType,
			arguments: structuredClone(tool.arguments),
			provenance: {
				provider: record.provider,
				model: record.model,
				reasoningEffort: record.reasoningEffort,
				serviceTier: record.serviceTier ?? defaultServiceTier(record.provider),
				traceId,
				programId: `native-${safeSegment(request.turnId)}`.slice(0, 256),
				programVersion: 1,
				sourceStepId: `${safeSegment(request.callId)}${sequenceIndex === null ? '' : `:${sequenceIndex + 1}`}`.slice(0, 256),
				eventSequence,
			},
		};
		// Explicit issuer for audits (C17): never inferred from the programId prefix, which programs and legs share.
		const commandIssuer = issuer ?? (programCommand !== null ? 'program' : sequenceIndex !== null ? 'skill_leg' : 'model');
		if (programCommand !== null) {
			const provenance = programCommand.provenance;
			payload.provenance = { provider: provenance.provider, model: provenance.model ?? provenance.modelIdentity, reasoningEffort: provenance.reasoningEffort, serviceTier: provenance.serviceTier, traceId: provenance.traceId, programId: provenance.programId, programVersion: provenance.version, sourceStepId: provenance.stepId, eventSequence: inspected?.goalRevision === record.goalRevision ? inspected.eventSequence : provenance.authorizingEventSequence ?? provenance.eventSequence, ...(provenance.watcherId == null ? {} : { watcherId: provenance.watcherId }) };
		}
		payload.provenance.issuer = commandIssuer;
		let resolveAction;
		let rejectAction;
		const result = new Promise((resolve, reject) => { resolveAction = resolve; rejectAction = reject; });
		result.catch(() => {});
		const blockingRun = waitForCompletion ? this.#blockingToolRuns.get(record.agentId) ?? null : null;
		const startedFrom = record.goalRevision === this.#observations.get(record.agentId)?.goalRevision ? observationPosition(this.#observations.get(record.agentId)?.observation) : null;
		const active = { actionId, goalRevision: record.goalRevision, actionType: tool.actionType, arguments: structuredClone(tool.arguments), from: startedFrom, worldId: this.#worldId(record), dimension: this.#dimension(record), result, resolve: resolveAction, reject: rejectAction, dispatched: false, dispatchPending: true, startPosition: this.#startSample(record, latest), ...(programCommand === null ? {} : { engineActionId: programCommand.actionId, fromProgram: true }), ...(sequenceIndex === null ? {} : { inSequence: true }), ...(waitForCompletion && programCommand === null ? { awaited: true } : {}), ...(pausedProgram ? { pausedProgram: true } : {}) };
		if (blockingRun !== null) {
			blockingRun.trackAction(result);
		}
		if (!waitForCompletion) {
			// The action's own timeout ends it; the lease only catches a result that never comes (a fixed 125 s lease
			// cancelled long travel, digging and portal builds mid-way).
			const releaseWork = this.#onWorkStarted(record, 'action', { timeoutMs: actionLeaseTimeoutMs(requestedActionTimeoutMs(tool)) });
			void result.then(releaseWork, releaseWork);
		}
		actionMap.set(record.agentId, active);
		if (!communication && programCommand === null && sequenceIndex === null) {
			const chain = this.#pendingLegChains.get(record.agentId);
			if (chain !== undefined && chain.goalRevision === record.goalRevision) {
				this.#pendingLegChains.delete(record.agentId);
				this.#joinLegChain(record, active, chain);
			}
		}
		if (TRAVEL_ACTIONS.has(tool.actionType)) this.#occupancy.beginTravel?.(record.agentId);
		const failPublication = async (error) => {
			if (actionMap.get(record.agentId) === active) actionMap.delete(record.agentId);
			const completed = this.#receipts.get(record.agentId)?.findLast((entry) => entry.actionId === actionId && entry.source === 'server_action_result');
			if (completed !== undefined) return;
			const reasonCode = active.dispatched ? 'DISPATCH_RESULT_UNKNOWN' : 'DISPATCH_NOT_SENT';
			this.#retainReceipt(record, active, { state: 'UNKNOWN', reasonCode, source: 'coordinator_uncertain', worldId: active.worldId });
			try { await (active.dispatched ? this.#journal('recordUnknown', record.agentId, active, { reasonCode }) : this.#journalUnsent(record.agentId, active, reasonCode)); }
			catch (journalError) { this.#trace('native_receipt_persistence_failed', { agentId: record.agentId, actionId, reasonCode: journalError?.code ?? 'MEMORY_WRITE_FAILED' }); }
			Object.assign(error, { actionId, goalRevision: record.goalRevision });
			active.publicationError = error;
			rejectAction(error);
		};
		let publication = Promise.resolve();
		const callId = request.callId ?? null;
		const dispatchStartedAt = performance.now();
		active.startedAtMs = dispatchStartedAt;
		this.#trace('native_tool_dispatch_started', { agentId: record.agentId, goalRevision: record.goalRevision, traceId, actionId, actionType: payload.actionType, callId });
		try {
			if (typeof this.#notebook?.recordDispatch === 'function' && active.worldId !== null) {
				const written = Promise.withResolvers(), timing = {};
				const durable = this.#journal('recordDispatch', record.agentId, active, { arguments: active.arguments }, { onWritten: written.resolve, timing });
				// Adapters without a write-ahead callback retain the original durable barrier.
				durable.then(written.resolve, written.reject);
				void durable.then(() => this.#trace('native_tool_journal_synced', { agentId: record.agentId, goalRevision: record.goalRevision, traceId, actionId, callId, ...timing }),
					(error) => this.#trace('native_receipt_persistence_failed', { agentId: record.agentId, actionId, reasonCode: error?.code ?? 'MEMORY_WRITE_FAILED', phase: 'dispatch_sync' }));
				await written.promise;
				this.#trace('native_tool_journal_written', { agentId: record.agentId, goalRevision: record.goalRevision, traceId, actionId, callId, durability: 'write_ahead', ...timing, journalMs: Math.round((performance.now() - dispatchStartedAt) * 10) / 10 });
			}
			if (actionMap.get(record.agentId) !== active) return waitForCompletion ? result : this.#actionStatus(record, actionId);
			const current = this.#registry?.get(record.agentId);
			if (this.#registry !== null && (current === null || current === undefined || current.goalRevision !== record.goalRevision)) {
				throw codedError('STALE_PLAN', 'Native action became stale before bridge send');
			}
			active.dispatched = true;
			const sendStartedAt = performance.now();
			publication = Promise.resolve(this.#bridge.send('action_command', record.agentId, payload)).then(() => {
				active.dispatchPending = false;
				this.#trace('native_tool_command_sent', { agentId: record.agentId, goalRevision: record.goalRevision, traceId, actionId, actionType: payload.actionType, callId,
					eventSequence: payload.provenance.eventSequence, programId: payload.provenance.programId, issuer: commandIssuer,
					dispatchMs: Math.round((performance.now() - dispatchStartedAt) * 10) / 10, sendMs: Math.round((performance.now() - sendStartedAt) * 10) / 10 });
			}, failPublication);
		} catch (error) {
			await failPublication(error);
		}
		if (!waitForCompletion) {
			await Promise.race([publication, result]);
			if (active.publicationError !== undefined) throw active.publicationError;
		}
		if (!waitForCompletion) return this.#actionStatus(record, actionId);
		let outcome;
		if (blockingRun === null) outcome = await result;
		else {
			const settledResult = result.then((value) => ({ type: 'result', value }));
			let settled = await Promise.race([settledResult, blockingRun.interruption.then(() => ({ type: 'interruption' }))]);
			if (settled.type === 'interruption' && blockingRun.sequence?.remainingSteps > 0 && blockingRun.settleBudgetMs > 0) {
				// Game time: the steps it waits on (equip, select, place) take a few ticks.
				const settleNow = this.#clock === WALL_CLOCK ? () => performance.now() : this.#clock.now;
				const settleStartedAt = settleNow();
				let timer;
				settled = await Promise.race([settledResult,
					new Promise((resolve) => { timer = this.#clock.setTimeout(resolve, blockingRun.settleBudgetMs, { type: 'interruption' }); })]);
				this.#clock.clearTimeout(timer);
				blockingRun.settleBudgetMs -= settleNow() - settleStartedAt;
			}
			if (settled.type === 'interruption') {
				const status = this.#actionStatus(record, actionId);
				if (status.state === 'RUNNING' || status.state === 'PREPARING') {
					blockingRun?.retainAction(actionLeaseTimeoutMs(requestedActionTimeoutMs(tool)));
					active.interruptedBy = blockingRun.interruptedBy ?? 'danger';
					return { ...status, interruptedBy: active.interruptedBy,
						recoveryHint: `replaceAction with actionId ${actionId} and your authored fight_target/flee_from switches now; cancelAction with the same actionId stops it.${blockingRun.sequence === null && blockingRun.lookAround === null ? '' : ' Later steps were not started.'}` };
				}
				outcome = await result;
			} else outcome = settled.value;
		}
		if (planCount !== null && outcome !== null && typeof outcome === 'object') outcome = { ...outcome, countMode: planCount };
		// Intermediate turns/moves in an already authored batch need no decision sample.
		// Sequences sample after their final step; programs still refresh before evaluating code.
		if (sampleAfter && ['look_at', 'move_to'].includes(tool.actionType) && request.hasQueuedBodyAction?.() === true) {
			this.#trace('native_tool_post_action_sampled', { agentId: record.agentId, goalRevision: record.goalRevision, traceId, actionId, callId, waitMs: 0, skipped: 'queued_body_action' });
			return outcome;
		}
		if (!sampleAfter) return outcome;
		const sampleStartedAt = performance.now();
		const sampled = await this.#withPostAction(record, outcome, executionEpoch, outcome);
		this.#trace('native_tool_post_action_sampled', { agentId: record.agentId, goalRevision: record.goalRevision, traceId, actionId, callId, waitMs: Math.round((performance.now() - sampleStartedAt) * 10) / 10 });
		return sampled;
	}

	#needsPostActionFacts(record, tool) {
		return POST_ACTION_OBSERVATION_TYPES.has(tool.actionType) && (tool.actionType !== 'use_item' || this.#consumesHeldItem(record, tool));
	}

	/** Whether this use_item eats or drinks the held item (food-tagged, potion, milk, honey), from the latest facts. */
	#consumesHeldItem(record, tool) {
		const observation = this.#observations.get(record.agentId)?.observation;
		const offhand = tool.arguments?.hand === 'off';
		const heldId = typeof tool.arguments?.expectedItemId === 'string' ? tool.arguments.expectedItemId
			: offhand ? observation?.interaction?.offHandItemId : observation?.interaction?.mainHandItemId;
		if (typeof heldId !== 'string') return false;
		if (DRINKS.has(heldId)) return true;
		const items = Array.isArray(observation?.inventory?.items) ? observation.inventory.items : [];
		return items.some((item) => item?.itemId === heldId && Array.isArray(item.tags) && item.tags.includes('#c:foods'));
	}

	async #withPostAction(record, outcome, executionEpoch, afterResult = null) {
		if (this.#requestObservation === null) return outcome;
		try {
			this.#assertCurrent(record);
			if (this.#executionEpoch(record.agentId) !== executionEpoch) throw codedError('STALE_NATIVE_TOOL', 'Action lifecycle has ended');
			return { ...outcome, postAction: await this.#observe(record, { afterResult }) };
		} catch (error) {
			return { ...outcome, postAction: { freshness: { fresh: false }, reasonCode: error?.code ?? 'OBSERVATION_UNAVAILABLE',
				message: 'The action result above is authoritative. Fresh follow-up facts are unavailable; observe before choosing a dependent action.' } };
		}
	}

	onActionProgress(record, payload = {}) {
		const active = [this.#actions.get(record.agentId), this.#communications.get(record.agentId)]
			.find((entry) => entry?.actionId === payload.actionId);
		if (active === undefined || active.goalRevision !== record.goalRevision || active.actionId !== payload.actionId) return false;
		if (payload.goalRevision !== undefined && payload.goalRevision !== active.goalRevision) return false;
		const observation = payload.actionObservation === undefined ? undefined : structuredClone(payload.actionObservation);
		active.progress = { ...(payload.progress === undefined ? {} : { value: payload.progress }), ...(payload.elapsedMs === undefined ? {} : { elapsedMs: payload.elapsedMs }), ...(observation === undefined ? {} : { actionObservation: modelActionObservation(observation) }) };
		this.#trace('native_tool_action_progress', {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			actionId: active.actionId,
			...(payload.progress === undefined ? {} : { progress: payload.progress }),
			...(payload.elapsedMs === undefined ? {} : { elapsedMs: payload.elapsedMs }),
			...(payload.serverTick === undefined ? {} : { serverTick: payload.serverTick }),
			...(observation === undefined ? {} : { actionObservation: observation }),
		});
		return true;
	}

	onActionResult(record, payload = {}) {
		if (!TERMINAL_ACTION_STATES.has(payload.state)) return false;
		let actionMap = this.#actions;
		let active = actionMap.get(record.agentId);
		if (active?.actionId !== payload.actionId) {
			actionMap = this.#communications;
			active = actionMap.get(record.agentId);
		}
		if (active === undefined || active.actionId !== payload.actionId) {
			const unresolved = this.#receipts.get(record.agentId)?.findLast((entry) => entry.actionId === payload.actionId && entry.goalRevision === record.goalRevision && entry.state === 'UNKNOWN');
			active = unresolved === undefined ? undefined : { ...unresolved, ...this.#receiptRequests.get(unresolved), resolve: () => {} };
		}
		if (active === undefined || active.goalRevision !== record.goalRevision || active.actionId !== payload.actionId) return false;
		if (payload.goalRevision !== undefined && payload.goalRevision !== active.goalRevision) return false;
		if (actionMap.get(record.agentId) === active) actionMap.delete(record.agentId);
		const observation = payload.actionObservation;
		const recovery = hasAuthoritativeActionObservation(observation)
			? this.#recovery.snapshot(record.agentId, observation)
			: null;
		const state = String(payload.state ?? 'FAILED').slice(0, 64);
		const reasonCode = String(payload.reasonCode ?? '').slice(0, 128);
		const failureClass = classifyBodyFailure(reasonCode, state);
		const travel = TRAVEL_ACTIONS.has(active.actionType) ? this.#travelFacts(record, active, reasonCode, observation, payload.message) : {};
		const repeatedFailure = active.actionType === 'chat' ? null : this.#repeatedFailures.record(record.agentId, {
			goalRevision: record.goalRevision, actionType: active.actionType, arguments: active.arguments, state, reasonCode, ...this.#failureStamp(observation) });
		const rawMessage = payload.message === undefined ? undefined : String(payload.message).slice(0, 2_048);
		let message = state === 'SUCCEEDED' && reasonCode === 'PORTAL_LIT' && active.actionType === 'build'
			&& active.arguments?.structure === 'nether_portal' && active.dimension === 'minecraft:overworld'
			? `Next stage: ${PORTAL_ENTRY_NEXT}; ${PORTAL_ENTRY_PREP}.${rawMessage ? ` ${rawMessage}` : ''}`.slice(0, 2_048) : rawMessage;
		const currentBody = this.#observations.get(record.agentId)?.observation;
		const partialFrame = /; frame at (-?\d+),(-?\d+),(-?\d+) axis ([xz]): [1-9]\/10 cells seen cast\b/.exec(rawMessage ?? '');
		if (state === 'FAILED' && ['NO_STAND_SPOT', 'FRAME_CELL_UNSEEN', 'FRAME_CELL_BLOCKED', 'NO_LAVA_IN_REACH'].includes(reasonCode)
			&& active.actionType === 'cast_obsidian' && active.arguments?.frame === true && active.dimension === 'minecraft:overworld'
			&& !active.cancelling && !active.interruptedBy && !active.suppressCastResumeAdvice && partialFrame
			&& !this.#armedDangerInterrupts.has(record.agentId) && this.#blockingToolRuns.get(record.agentId)?.interruptedBy !== 'danger'
			&& observation?.death == null && observation?.status !== 'PLAYER_DEAD' && observation?.player?.dead !== true
			&& !(observation?.player?.health <= 0)
			&& currentBody?.death == null && currentBody?.status !== 'PLAYER_DEAD' && currentBody?.player?.dead !== true
			&& !(currentBody?.player?.health <= 0)) {
			// Only the body's selected geometry can authorize a pinned retry. Keep all native receipt facts.
			const [, x, y, z, axis] = partialFrame;
			const resume = `Partial frame: retry with do_step({verb:"cast_obsidian",target:{frame:true,resume:true,x:${x},y:${y},z:${z},axis:"${axis}"},why:"resume this frame"}). `;
			const cap = reasonCode === 'NO_LAVA_IN_REACH'
				? 'Cooling may cap the used pool with cobblestone. Inspect from dry footing; if a cap is seen, expose one from the side, never the block you stand on. Hidden lava is unconfirmed; otherwise find more source lava or carry obsidian. ' : '';
			if (resume.length + cap.length + rawMessage.length <= 2_048) message = resume + cap + rawMessage;
			else if (resume.length + rawMessage.length <= 2_048) message = resume + rawMessage;
		}
		const failed = isFailureResult({ state, reasonCode });
		const result = {
			state,
			reasonCode,
			durationMs: Math.max(0, Math.round(performance.now() - active.startedAtMs)),
			...(failed ? { failure: failureFacts({
				code: reasonCode,
				...(active.fromProgram || active.inSequence ? { tried: triedText(active.actionType, active.arguments) } : {}),
				changed: failureChange({ executionStarted: payload.executionStarted, physicalAttempted: payload.physicalAttempted,
					from: active.startPosition?.position, fromAgeMs: active.startPosition?.ageMs, to: observationPosition(observation) }),
				// A cancellation often arrives without server text; the coordinator knows who stopped it.
				blockedBy: message || (active.interruptedBy ? `interrupted by ${active.interruptedBy}` : active.cancelling ? 'your cancelAction or replaceAction' : undefined),
				repeat: repeatedFailure ?? undefined,
			}) } : {}),
			...travel,
			...(message === undefined ? {} : { message }),
			...(payload.executionStarted === undefined ? {} : { executionStarted: payload.executionStarted === true }),
			...(payload.physicalAttempted === undefined ? {} : { physicalAttempted: payload.physicalAttempted === true }),
			...(payload.actionObservation === undefined ? {} : { actionObservation: modelActionObservation(payload.actionObservation) }),
			...(payload.cause === undefined ? {} : { cause: payload.cause }),
			...(recovery === null ? {} : { recovery }),
			...(failureClass === null ? {} : { failureClass }),
			...(active.cancelledBy === undefined ? {} : { cancelledBy: active.cancelledBy }),
		};
		// A blocking call returns this failure itself; views need not repeat it.
		if (failed && active.awaited) this.#markFailureDelivered(record, active.actionId);
		if (failed && !active.awaited) {
			let requests = this.#failedRequests.get(record.agentId);
			if (requests === undefined) this.#failedRequests.set(record.agentId, requests = new Map());
			requests.set(active.actionId, { goalRevision: record.goalRevision, tried: triedText(active.actionType, active.arguments) });
			while (requests.size > 64) requests.delete(requests.keys().next().value);
		}
		const endedAt = observationPosition(observation);
		if (endedAt !== null && active.actionType !== 'chat') this.#bodyEnds.set(record.agentId, { goalRevision: record.goalRevision, position: endedAt,
			at: this.#clock.at(observation) ?? this.#clock.now() });
		this.#retainReceipt(record, active, { ...result, source: 'server_action_result' });
		if (payload.breakOutcome !== undefined) this.#breakOutcomes.set(result, payload.breakOutcome);
		// The receipt's cell is in the world and dimension the action was dispatched in, even if the body has moved since.
		const latest = this.#observations.get(record.agentId)?.observation;
		const moved = latest !== undefined && (active.worldId != null && latest.world?.worldId !== active.worldId || active.dimension != null && latest.world?.dimension !== active.dimension);
		// Game ticks are per world: after a move, the latest sample's tick is not a clock of the dispatch world, so it is dropped.
		const dispatched = latest === undefined ? undefined : { ...latest, ...(moved ? { worldTick: undefined } : {}), world: { ...(moved ? (({ gameTime, ...world }) => world)(latest.world ?? {}) : latest.world), ...(active.worldId == null ? {} : { worldId: active.worldId }), ...(active.dimension == null ? {} : { dimension: active.dimension }) } };
		this.#occupancy.recordResourceResult?.(record.agentId, dispatched, { actionType: active.actionType, arguments: active.arguments, state, reasonCode, message: payload.message ?? null, observedAtEpochMs: payload.observedAtEpochMs ?? null });
		this.#placedWorkstations.onActionResult(record.agentId, { actionType: active.actionType, arguments: active.arguments, state, observedAtEpochMs: payload.observedAtEpochMs, actionObservation: payload.actionObservation }, dispatched);
		this.#dugStairs.onActionResult(record.agentId, { actionType: active.actionType, arguments: active.arguments, from: active.from ?? null, to: endedAt ?? observationPosition(latest),
			at: this.#clock.at({ observedAtEpochMs: payload.observedAtEpochMs, world: observation?.world }) ?? this.#clock.now() }, dispatched);
		// The same own receipt reaches every store that remembers the cell, so none keeps a station the agent broke.
		this.#recovery.recordResult?.(record.agentId, dispatched, { actionType: active.actionType, arguments: active.arguments, state, reasonCode, observedAtEpochMs: payload.observedAtEpochMs });
		if (this.#notebook !== null && active.worldId != null) {
			try {
				Promise.resolve(this.#notebook.recordReceipt(record.agentId, terminalReceipt(active, payload))).catch((error) => this.#trace('native_receipt_persistence_failed', { agentId: record.agentId, actionId: active.actionId, reasonCode: error?.code ?? 'MEMORY_WRITE_FAILED' }));
			} catch (error) { this.#trace('native_receipt_persistence_failed', { agentId: record.agentId, actionId: active.actionId, reasonCode: error?.code ?? 'MEMORY_WRITE_FAILED' }); }
		}
		this.#flushSpatial(record.agentId).catch((error) => this.#trace('native_spatial_memory_failed', { agentId: record.agentId, reasonCode: error?.code ?? 'MEMORY_WRITE_FAILED' }));
		this.#trace('native_tool_action_completed', { agentId: record.agentId, goalRevision: record.goalRevision, actionId: active.actionId, ...result, ...serverTimingTraceFields(payload) });
		if (active.actionType !== 'chat') {
			const latest = this.#observations.get(record.agentId);
			this.#postResultSamples.set(record.agentId, { result, goalRevision: record.goalRevision, published: false, wake: null, publication: null,
				eventSequence: latest?.goalRevision === record.goalRevision ? latest.eventSequence : 0 });
		}
		active.resolve(result);
		this.#reconsiderStandingOrders(record);
		return true;
	}

	async reconcileActionReceipt(agentId, payload = {}) {
		if (typeof payload.actionId !== 'string' || !payload.actionId.startsWith('native:') || !TERMINAL_ACTION_STATES.has(payload.state) || typeof this.#notebook?.findReceipt !== 'function') return false;
		const existing = await this.#notebook.findReceipt(agentId, { actionId: payload.actionId });
		if (existing === null || existing.goalRevision !== payload.goalRevision || payload.actionType !== undefined && existing.actionType !== payload.actionType) return false;
		await this.#notebook.recordReceipt(agentId, terminalReceipt(existing, payload));
		return true;
	}

	isActionResultStale(record, payload = {}) {
		const stale = this.#staleActions.get(record.agentId);
		return stale?.has(actionResultKey(payload.goalRevision, payload.actionId)) === true;
	}

	onCompletionResult(record, payload = {}) {
		const active = this.#completions.get(record.agentId);
		if (active === undefined || active.goalRevision !== record.goalRevision) return false;
		if (payload.traceId !== active.traceId || payload.goalFingerprint !== active.goalFingerprint) return false;
		this.#completions.delete(record.agentId);
		const facts = structuredClone(Array.isArray(payload.facts) ? payload.facts : []);
		const unmet = facts.filter((fact) => fact.satisfied === false);
		const awaitingConfirmation = payload.verified !== true && payload.reasonCode === 'PREDICATE_FAILED'
			&& unmet.length > 0 && unmet.every((fact) => fact.type === 'operator_confirmed');
		active.resolve({
			state: payload.verified === true ? 'COMPLETED' : awaitingConfirmation ? 'AWAITING_OPERATOR_CONFIRMATION' : 'ACTIVE',
			verified: payload.verified === true,
			reasonCode: String(payload.reasonCode ?? '').slice(0, 128),
			facts,
			...(awaitingConfirmation ? { message: `${facts.some(fact => fact.type !== 'operator_confirmed' && fact.satisfied === true) ? 'Minecraft verified the factual goal conditions. Only operator confirmation remains. ' : ''}${AWAITING_CONFIRMATION_MESSAGE}` } : {}),
		});
		return true;
	}

	async dispose(agentId, reason = 'disposed') {
		// A latch that never rejects, so disposeAll can wait for this run without handling its failure for the caller.
		let settle;
		const settled = new Promise((resolve) => { settle = resolve; });
		this.#disposals.add(settled);
		try { return await this.#disposeOnce(agentId, reason); }
		finally { this.#disposals.delete(settled); settle(); }
	}

	async #disposeOnce(agentId, reason) {
		this.#obtainPlaced.get(agentId)?.approaches.splice(0);
		this.#executionEpochs.set(agentId, this.#executionEpoch(agentId) + 1);
		const spatialWrites = this.#spatialWrites.get(agentId) ?? 0;
		// Terminal handles from the previous body cannot authorize work after death or respawn.
		if (['goal_dead', 'goal_respawn', 'dead_registration_replaced'].includes(reason)) {
			this.#receipts.delete(agentId);
			this.#failedRequests.delete(agentId);
		}
		// A new goal revision retires authored intent; death/respawn keep the same goal and its policies.
		if (/^goal_(?!dead$|respawn$)/.test(String(reason))) this.#standing.clearGuards(agentId);
		// Orders keep their source and remaining time, but their condition starts afresh in the next body.
		this.#standing.rearm(agentId);
		// A disposed body tool may still be unwinding an observation or metadata
		// read. Remove its interruption slot now so a newer lifecycle can own it;
		// the old call's finally block is identity-checked and cannot clear the new one.
		this.#blockingToolRuns.delete(agentId);
		this.#steps.delete(agentId);
		this.#stepRuns.delete(agentId);
		this.#armedDangerInterrupts.delete(agentId);
		this.#sequenceFinishReservations.delete(agentId);
		const chain = this.#legChains.get(agentId);
		if (chain !== undefined) chain.stopped = true;
		this.#legChains.delete(agentId);
		this.#pendingLegChains.delete(agentId);
		const program = this.#programRuns.get(agentId);
		program?.releaseWork();
		if (program?.state === 'PREPARING') this.#settleProgram(agentId, program, { state: 'CANCELLED', reasonCode: 'NATIVE_PROGRAM_CANCELLED' }, codedError('NATIVE_PROGRAM_CANCELLED', 'Program preparation outlived its lifecycle'));
		this.#programRuns.delete(agentId);
		this.#programResults.delete(agentId);
		this.#sweeps.delete(agentId);
		Promise.resolve(this.#programExecutor.cancel(agentId, reason)).catch((error) => this.#trace('native_program_cancel_failed', { agentId, reasonCode: error?.code ?? 'PROGRAM_CANCEL_FAILED' }));
		// Physical authority is released before waiting on persistence below.
		if (FORGET_REASONS.test(String(reason))) {
			this.#standing.clear(agentId);
			this.#reflexes.clear(agentId);
			this.#recovery.forget(agentId);
			this.#placedWorkstations.clear(agentId);
			this.#lastSweeps.delete(agentId);
			this.#missedPlaces.delete(agentId);
			this.#dugStairs.clear(agentId);
			this.#lastLive.delete(agentId);
			this.#receipts.delete(agentId);
			this.#repeatedFailures.forget(agentId);
			this.#bodyEnds.delete(agentId);
			this.#deliveredFailures.delete(agentId);
			this.#failedRequests.delete(agentId);
			this.#publicationStreaks.delete(agentId);
		}
		this.#reservedFailures.delete(agentId);
		this.#failureSteers.delete(agentId);
		this.#observations.delete(agentId);
		this.#inspectedTargets.delete(agentId);
		this.#postResultSamples.delete(agentId);
		const active = this.#actions.get(agentId);
		const communication = this.#communications.get(agentId);
		const completion = this.#completions.get(agentId);
		if (completion !== undefined) {
			this.#completions.delete(agentId);
			completion.reject(codedError('NATIVE_COMPLETION_CANCELLED', `Native completion cancelled: ${String(reason).slice(0, 128)}`));
		}
		for (const running of [active, communication]) {
			if (running === undefined) continue;
			const actionMap = running.actionType === 'chat' ? this.#communications : this.#actions;
			actionMap.delete(agentId);
			this.#rememberStaleAction(agentId, running);
			running.reject(codedError('NATIVE_ACTION_CANCELLED', `Native action cancelled: ${String(reason).slice(0, 128)}`));
			if (running.dispatched && !running.cancelling) {
				try { await this.#bridge.send('action_cancel', agentId, { goalRevision: running.goalRevision, actionId: running.actionId }); }
				catch {}
			}
			try { await (running.dispatched ? this.#journal('recordUnknown', agentId, running, { reasonCode: 'LIFECYCLE_ENDED_BEFORE_RESULT' }) : this.#journalUnsent(agentId, running, 'CANCELLED_BEFORE_DISPATCH')); }
			catch (error) { this.#trace('native_receipt_persistence_failed', { agentId, actionId: running.actionId, reasonCode: error?.code ?? 'MEMORY_WRITE_FAILED' }); }
		}
		try { await this.#flushSpatial(agentId); }
		catch (error) { this.#trace('native_spatial_memory_failed', { agentId, reasonCode: error?.code ?? 'MEMORY_WRITE_FAILED' }); }
		// A replacement body (e.g. after server_replaced) may already have observed while this disposal awaited
		// persistence; that spatial state now belongs to it and must not be forgotten with the retiring one.
		if (FORGET_REASONS.test(String(reason)) && (this.#spatialWrites.get(agentId) ?? 0) === spatialWrites) {
			this.#portalSearches.delete(agentId);
			this.#occupancy.clear(agentId);
			this.#memoryReady.delete(agentId);
			this.#pendingSpatial.delete(agentId);
		}
		return active !== undefined || completion !== undefined;
	}

	#executionEpoch(agentId) { return this.#executionEpochs.get(agentId) ?? 0; }

	#rememberStaleAction(agentId, active) {
		let stale = this.#staleActions.get(agentId);
		if (stale === undefined) {
			stale = new Set();
			this.#staleActions.set(agentId, stale);
		}
		stale.add(actionResultKey(active.goalRevision, active.actionId));
		while (stale.size > 32) stale.delete(stale.values().next().value);
	}

	async disposeAll(reason = 'coordinator_stopped') {
		const agentIds = new Set([
			...this.#observations.keys(),
			...this.#actions.keys(),
			...this.#communications.keys(),
			...this.#completions.keys(),
			...this.#programRuns.keys(),
			...this.#sweeps.keys(),
			...this.#sequenceFinishReservations.keys(),
			...this.#lastLive.keys(),
		]);
		await Promise.allSettled([...agentIds].map((agentId) => this.dispose(agentId, reason)));
		// A dispose started earlier without a waiter (a lease expiry) has already cleared the maps above but may still be
		// writing spatial memory; shutdown must not report done while it writes.
		await Promise.allSettled([...this.#disposals]);
		if (FORGET_REASONS.test(String(reason))) this.#recovery.clear();
	}

	async #finish(request, record, lifecycleGeneration, sequenceFinishToken = null) {
		const finishReservation = this.#sequenceFinishReservations.get(record.agentId);
		if (finishReservation !== undefined && finishReservation !== sequenceFinishToken) throw codedError('NATIVE_COMPLETION_IN_PROGRESS', 'A finishing native sequence owns the player');
		if (this.#actions.has(record.agentId)) throw codedError('NATIVE_ACTION_IN_PROGRESS', 'The Minecraft body is already executing an action');
		if (this.#completions.has(record.agentId)) throw codedError('NATIVE_COMPLETION_IN_PROGRESS', 'Goal completion verification is already running');
		const goalFingerprint = record.currentGoalSpec?.fingerprint;
		if (typeof goalFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(goalFingerprint)) {
			throw codedError('GOAL_SPEC_REQUIRED', 'Minecraft has not supplied an immutable goal specification');
		}
		const ordinal = ++this.#sequence;
		const traceId = validateTraceId(`native-complete-${this.#sessionId}-${ordinal}-${safeSegment(record.agentId).slice(0, 32)}-${record.goalRevision}`);
		const profile = {
			provider: record.provider,
			model: record.model,
			reasoningEffort: record.reasoningEffort,
			serviceTier: record.serviceTier ?? defaultServiceTier(record.provider),
		};
		let resolveCompletion;
		let rejectCompletion;
		const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
		const pending = {
			goalRevision: record.goalRevision,
			traceId,
			goalFingerprint,
			resolve: resolveCompletion,
			reject: rejectCompletion,
		};
		this.#completions.set(record.agentId, pending);
		const failPublication = (error) => {
			if (this.#completions.get(record.agentId) === pending) this.#completions.delete(record.agentId);
			rejectCompletion(error);
		};
		try {
			Promise.resolve(this.#bridge.send('goal_completed', record.agentId, {
				goalRevision: record.goalRevision,
				goalFingerprint,
				traceId,
				profile,
			})).catch(failPublication);
		} catch (error) {
			failPublication(error);
		}
		const result = await completion;
		if (result.verified) await this.#onFinish({ record, request, result, lifecycleGeneration });
		return result;
	}
}

export function constrainGoalBoundNavigation(tool, goalSpec) {
	if (tool?.kind === 'sequence') {
		return { ...tool, actions: tool.actions.map((action) => constrainNavigationAction(action, goalSpec)) };
	}
	if (tool?.kind === 'action') return constrainNavigationAction(tool, goalSpec);
	return tool;
}

function constrainNavigationAction(action, goalSpec) {
	if (action?.actionType !== 'navigate_to') return action;
	const args = action.arguments ?? {};
	const radius = matchingPositionRadius(goalSpec?.predicate, args);
	if (radius === undefined) return action;
	if (radius < 0.01) {
		throw codedError('GOAL_TOLERANCE_UNREPRESENTABLE', 'The active position goal radius is below the navigation tool minimum');
	}
	if (args.tolerance <= radius) return action;
	return { ...action, arguments: { ...args, tolerance: radius } };
}

function matchingPositionRadius(predicate, args) {
	if (predicate?.type === 'position_within') {
		return args.x === predicate.x && args.y === predicate.y && args.z === predicate.z
			? predicate.radius
			: undefined;
	}
	const children = (predicate?.predicates ?? []).map((child) => matchingPositionRadius(child, args));
	// any_of is met by any one branch. Only when every branch bounds this same destination is there a mandatory bound,
	// the loosest; a branch elsewhere or of another kind may already be satisfied, so it imposes none.
	if (predicate?.type === 'any_of') return children.length > 0 && children.every((radius) => radius !== undefined) ? Math.max(...children) : undefined;
	// all_of needs every matching bound, so the tightest wins.
	const bounds = children.filter((radius) => radius !== undefined);
	return bounds.length === 0 ? undefined : Math.min(...bounds);
}

/** True only for attention the order's own source declared continue_and_notify for, on a running (not paused) order. */
function standingOrderContinues(run, status) {
	const decision = status?.decision;
	if (run.standingOrder === undefined || run.standingPolicy === undefined || decision == null || status.engineState !== 'ACTIVE') return false;
	if (decision.actionFailure !== undefined || decision.trigger === 'defensive_handler_completed' || CONTEXT_TRIGGERS.has(decision.trigger)) return false;
	const survival = decision.priority === 'urgent' && SURVIVAL_TRIGGERS.has(decision.trigger);
	return (survival ? run.standingPolicy.survivalPolicy : run.standingPolicy.unhandledPolicy) === 'continue_and_notify';
}

function validateRecord(record) {
	if (record === null || typeof record !== 'object') throw new TypeError('record must be an object');
	for (const field of ['agentId', 'provider', 'model', 'reasoningEffort']) {
		if (typeof record[field] !== 'string' || record[field].length === 0) throw new TypeError(`record.${field} must be nonblank`);
	}
	if (!Number.isSafeInteger(record.goalRevision) || record.goalRevision < 0) throw new TypeError('record.goalRevision must be a nonnegative safe integer');
}

function isWaitTool(tool) {
	return tool?.kind === 'action' && tool.actionType === 'wait' && Number.isSafeInteger(tool.arguments?.durationMs);
}

function validateRequest(request, record) {
	if (request === null || typeof request !== 'object') throw new TypeError('native tool request must be an object');
	if (request.agentId !== record.agentId || request.goalRevision !== record.goalRevision) throw codedError('STALE_NATIVE_TOOL', 'Native tool request does not match the active agent goal');
	if (typeof request.turnId !== 'string' || request.turnId.length === 0) throw new TypeError('native tool turnId must be nonblank');
	if (typeof request.callId !== 'string' || request.callId.length === 0) throw new TypeError('native tool callId must be nonblank');
	if (request.tool === null || typeof request.tool !== 'object') throw new TypeError('native tool must be normalized');
}

function hasAuthoritativeActionObservation(observation) {
	return observation !== null && typeof observation === 'object'
		&& (observation.inventory !== undefined || observation.death != null);
}

function resolveDecorateSource(observation, cached, live) {
	if (isSparseDeathObservation(observation) && hasDurableObservationFacts(cached ?? {})) return cached;
	if (isSparseDeathObservation(observation) && hasDurableObservationFacts(live ?? {})) {
		return mergeDeathObservation(observation, { observation: live });
	}
	if (hasDurableObservationFacts(observation)) return observation;
	return cached ?? live ?? observation;
}

function isSparseDeathObservation(observation) {
	return observation?.death != null
		&& observation.inventory === undefined
		&& observation.player === undefined
		&& observation.world === undefined;
}

function mergeDeathObservation(observation, lastLive) {
	if (observation?.death == null || lastLive == null) return observation;
	const live = lastLive.observation ?? lastLive;
	if (live === null || typeof live !== 'object') return observation;
	return {
		...live,
		...observation,
		ready: false,
		status: 'PLAYER_DEAD',
		player: {
			...(typeof live.player === 'object' && live.player !== null ? live.player : {}),
			...(typeof observation.player === 'object' && observation.player !== null ? observation.player : {}),
			dead: true,
			health: 0,
			x: observation.death.x,
			y: observation.death.y,
			z: observation.death.z,
		},
		inventory: observation.inventory ?? { items: [] },
		lastLiveInventory: live.inventory ?? null,
		continuity: { sameGoal: true, phase: 'dead', rememberedSections: ['position', 'velocity', 'view', 'blocks', 'landmarks', 'entities', 'nearbyContainers', 'interaction', 'world'].filter((section) => live[section] !== undefined && observation[section] === undefined) },
		death: observation.death,
	};
}

function safeSegment(value) { return String(value).replace(/[^A-Za-z0-9._:-]/g, '_') || 'item'; }
/** Java-side clocks of a terminal result for the latency trace: accepted, started and ended. Never shown to the model. */
function serverTimingTraceFields(payload) {
	const timing = payload?.timing ?? {};
	const fields = { javaElapsedMs: payload?.elapsedMs, javaEndedAtEpochMs: payload?.observedAtEpochMs, javaAcceptedAtEpochMs: timing.acceptedAtEpochMs,
		javaStartedAtEpochMs: timing.startedAtEpochMs, javaStartedTick: timing.startedTick, javaEndedTick: timing.endedTick };
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => Number.isSafeInteger(value)));
}

/** Grounding, teleports and break-attribution evidence stay coordinator-side; travel and observed resources carry the facts. */
function modelActionObservation(value) {
	const { onGround: _onGround, teleportTick: _teleportTick, revealedBlocks: _revealedBlocks, ...rest } = structuredClone(value);
	return rest;
}

function terminalReceipt(active, payload) {
	return {
		worldId: active.worldId, actionId: active.actionId, goalRevision: active.goalRevision, actionType: active.actionType,
		state: payload.state, reasonCode: String(payload.reasonCode ?? '').slice(0, 128),
		...(payload.cause === undefined ? {} : { cause: payload.cause }),
		...(typeof payload.executionStarted === 'boolean' ? { executionStarted: payload.executionStarted } : {}),
		...(typeof payload.physicalAttempted === 'boolean' ? { physicalAttempted: payload.physicalAttempted } : {}),
		...(payload.actionObservation === undefined ? {} : { actionObservation: structuredClone(payload.actionObservation) }),
		...(Number.isSafeInteger(payload.actionObservation?.worldTick) ? { tick: payload.actionObservation.worldTick } : {}),
	};
}
function nativeMemoryProvenance(request, record) { return { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier ?? defaultServiceTier(record.provider), goalRevision: record.goalRevision, turnId: request.turnId, callId: request.callId }; }
function wrapDegrees(value) {
	const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
	return wrapped === -180 ? 180 : wrapped;
}
function actionResultKey(goalRevision, actionId) { return `${goalRevision}:${String(actionId ?? '')}`; }
function liveProgramWorld(observation) {
	if (observation?.ready !== true || observation.death != null || observation.status === 'PLAYER_DEAD' || observation.player?.dead === true) return null;
	const worldId = observation.world?.worldId ?? observation.worldId;
	const dimension = observation.world?.dimension;
	if (typeof worldId !== 'string' || worldId.length === 0 || typeof dimension !== 'string' || dimension.length === 0) return null;
	return { worldId, dimension };
}

function sameProgramWorld(observation, expected) {
	const world = liveProgramWorld(observation);
	return world !== null && world.worldId === expected.worldId && world.dimension === expected.dimension;
}

function successorSummary(successor) {
	return { queueId: successor.queueId, afterProgramId: successor.afterProgramId, goalRevision: successor.goalRevision,
		programVersion: successor.programVersion, state: 'QUEUED', maxActions: successor.request.tool.maxActions ?? 64,
		timeoutMs: successor.request.tool.timeoutMs ?? 30_000, sourceOrigin: successor.sourceOrigin };
}

/** Size and a short fingerprint of model-authored source, so traces can tell programs apart without logging them. */
export function programSourceSummary(source) {
	if (typeof source !== 'string') return {};
	return { sourceBytes: Buffer.byteLength(source, 'utf8'), sourceHash: createHash('sha256').update(source).digest('hex').slice(0, 12) };
}

/** Why a program run ended, in one word a trace reader can count. */
export function programTermination(outcome) {
	const reason = outcome?.reasonCode;
	if (outcome?.state === 'CANCELLED') return 'cancelled';
	if (outcome?.state === 'TIMED_OUT') return 'timed_out';
	if (outcome?.state === 'FAILED' || outcome?.state === 'UNKNOWN') return 'failed';
	if (reason === 'PROGRAM_EXHAUSTED') return 'exhausted';
	if (reason === 'PROGRAM_FINISH_REQUESTED') return 'finished';
	if (reason === 'MODEL_PAUSED') return 'paused_by_model';
	if (reason === 'PROGRAM_CHECKPOINT') return 'checkpoint';
	if (reason === 'PROGRAM_ACTION_LIMIT') return 'action_limit';
	if (reason === 'PROGRAM_IDLE') return 'idle';
	if (reason === 'MODEL_DECISION_REQUIRED') return 'decision_required';
	return 'yielded';
}

function withSuccessorId(issued, result) {
	return result !== null && typeof result === 'object' && typeof result.actionId !== 'string' && typeof issued.actionId === 'string' && TERMINAL_ACTION_STATES.has(result.state)
		? { actionId: issued.actionId, ...result } : result;
}
function replacementReceipt(previous, actionId) {
	return { actionId, state: previous.state, reasonCode: previous.reasonCode };
}
function codedError(code, message) { return Object.assign(new Error(message), { code }); }

async function withDeadline(promise, timeoutMs, code, message) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(codedError(code, message)), timeoutMs); timer.unref?.(); })]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Merges the surveys of a camera sweep: one row per thing (the nearest sighting kept), at most limit per section,
 * nearest first, with bearings turned relative to the final heading so they stay right after the sweep. Far-sight rows
 * are matched by the stable id Minecraft gives each thing; caves and veins (no id) by kind within 8 blocks. Threats are
 * the union over every heading, each at its latest sighting; the biome comes from the last heading.
 */
export function mergeSurveys(surveys, finalYaw, limit = 4) {
	const sections = new Map();
	const threats = new Map();
	let complete = true;
	const turn = (row, yaw) => Number.isFinite(row?.bearing) ? { ...row, bearing: Math.round(wrapDegrees(yaw + row.bearing - finalYaw)) } : { ...row };
	for (const { yaw, result } of surveys) {
		if (result?.coverage?.complete === false) complete = false;
		for (const entry of Array.isArray(result?.threats?.entries) ? result.threats.entries : []) {
			const key = typeof entry?.uuid === 'string' ? entry.uuid : JSON.stringify(entry);
			threats.delete(key);
			threats.set(key, turn(entry, yaw));
		}
		for (const [section, rows] of Object.entries(result?.survey ?? {})) {
			if (!Array.isArray(rows)) continue;
			const merged = sections.get(section) ?? [];
			sections.set(section, merged);
			for (const row of rows) {
				const turned = turn(row, yaw);
				const index = merged.findIndex((other) => typeof row.id === 'string' ? other.id === row.id
					: (other.blockId ?? null) === (row.blockId ?? null) && Math.hypot(other.x - row.x, other.y - row.y, other.z - row.z) <= 8);
				if (index < 0) merged.push(turned);
				else if ((turned.distance ?? Infinity) < (merged[index].distance ?? Infinity)) merged[index] = turned;
			}
		}
	}
	const last = surveys.at(-1)?.result ?? {};
	return {
		...Object.fromEntries([...sections].map(([section, rows]) => [section, [...rows].sort((left, right) => (left.distance ?? 0) - (right.distance ?? 0)).slice(0, limit)])
			.filter(([, rows]) => rows.length > 0)),
		...(last.standingIn === undefined ? {} : { standingIn: last.standingIn }),
		...(threats.size === 0 && last.threats?.bestWeapon === undefined ? {} : { threats: {
			entries: [...threats.values()].sort((left, right) => (left.distance ?? 0) - (right.distance ?? 0)),
			...(last.threats?.bestWeapon === undefined ? {} : { bestWeapon: last.threats.bestWeapon }),
		} }),
		headings: surveys.length,
		complete,
	};
}

// Additional sightings share this budget; baseline-listed sightings are retained even when it binds.
const SWEEP_SAMPLE_BYTES = 1000;
const SWEEP_HEADING_BYTES = 1400;
const SWEEP_SECTIONS = ['entities', 'blocks', 'items', 'landmarks'];
const SWEEP_REPRESENTATIVE_FIELDS = {
	entities: ['entityType', 'type', 'kind', 'stableId', 'uuid'],
	blocks: ['blockId', 'type', 'kind', 'stableId', 'uuid'],
	items: ['itemId', 'type', 'kind', 'stableId', 'uuid'],
	landmarks: ['blockId', 'itemId', 'type', 'kind', 'stableId', 'uuid'],
};

// One heading's compact sightings, each identified by what and where it is so a later heading can supersede it.
// The same coordinates in another dimension are another place, so the dimension is part of the identity.
const SWEEP_REUSE_MS = 60_000, SWEEP_REUSE_BLOCKS = 8;
// Missed places kept per agent: enough for a game's worth of searches, oldest dropped first.
const MISSED_PLACES = 64;
/** What a look-around asks: pitch and survey, and for a part turn its heading; where a full turn starts does not change what it sees. */
function sweepKey(tool) {
	return JSON.stringify([Math.round(tool.pitch / 15), tool.steps >= 4 ? 'full' : Math.round(tool.centerYaw / 45), tool.survey ?? null]);
}

/** The body's feet position in a live or test sample (live samples have no top-level position). */
/** A gather step's own timeout, ended by gather's deadline (an obtain inside it passes only what is left of its own). */
export function gatherStepTimeout(wantMs, deadlineAt, now = Date.now()) {
	return Math.max(1_000, Math.min(wantMs, deadlineAt - now));
}

function gatherBodyAt(observation) {
	const value = observation?.position ?? observation?.player?.position ?? observation?.player;
	return value && [value.x, value.y, value.z].every(Number.isFinite) ? { x: value.x, y: value.y, z: value.z } : null;
}

/** Within a player's block reach (4.5 from the eye to the block centre). */
function gatherInReach(body, block) {
	return Math.hypot(block.x + 0.5 - body.x, block.y + 0.5 - (body.y + 1.62), block.z + 0.5 - body.z) <= 4.4;
}

/** Seen blocks of the wanted ids within radius; the same tree (within 2.5 of the last broken) first, then the nearest. */
function gatherTarget(observation, wanted, radius, body, last, failed) {
	const rows = [...(observation.blocks ?? []), ...(observation.world?.landmarks ?? observation.landmarks ?? []), ...(observation.routeMemory?.seenResources ?? [])];
	const seen = new Map();
	for (const row of rows) {
		if (!wanted.has(row?.blockId) || ![row.x, row.y, row.z].every(Number.isSafeInteger)) continue;
		const key = `${row.x},${row.y},${row.z}`;
		if (failed.has(key) || seen.has(key)) continue;
		if (Math.hypot(row.x + 0.5 - body.x, row.z + 0.5 - body.z) > radius) continue;
		seen.set(key, { x: row.x, y: row.y, z: row.z, blockId: row.blockId });
	}
	const eye = { x: body.x, y: body.y + 1.62, z: body.z };
	const distance = (block, from) => Math.hypot(block.x + 0.5 - from.x, block.y + 0.5 - from.y, block.z + 0.5 - from.z);
	const sameTree = last === null ? [] : [...seen.values()].filter((block) => Math.hypot(block.x - last.x, block.z - last.z) <= 2.5 && Math.abs(block.y - last.y) <= 6);
	const pool = sameTree.length ? sameTree : [...seen.values()];
	return pool.sort((a, b) => distance(a, eye) - distance(b, eye))[0] ?? null;
}

/** Where to stand for a block: beside its column on the body's side, at the column's lowest seen wanted block (the trunk foot). */
function gatherStand(observation, wanted, target, body) {
	const rows = [...(observation.blocks ?? []), ...(observation.world?.landmarks ?? observation.landmarks ?? []), ...(observation.routeMemory?.seenResources ?? [])];
	const footY = rows.filter((row) => wanted.has(row?.blockId) && row.x === target.x && row.z === target.z && Number.isSafeInteger(row.y))
		.reduce((low, row) => Math.min(low, row.y), target.y);
	const dx = body.x - (target.x + 0.5), dz = body.z - (target.z + 0.5);
	const step = Math.abs(dx) >= Math.abs(dz) ? { x: Math.sign(dx) || 1, z: 0 } : { x: 0, z: Math.sign(dz) || 1 };
	return { x: target.x + 0.5 + step.x, y: footY, z: target.z + 0.5 + step.z };
}

/**
 * What one heading of a sweep showed of the ground ahead, from its surface samples (landmarks) past the ground at the
 * body's feet (GROUND_AHEAD blocks): how many were open water and how many anything else, and the farthest of those. A
 * search reads it as a player reads the view: all sea that way, or land.
 */
const GROUND_AHEAD = 12;
export function groundOfView(view) {
	const landmarks = view.sections[SWEEP_SECTIONS.indexOf('landmarks')] ?? [];
	let water = 0, land = 0, farthestLand = 0;
	for (const { compact } of landmarks) {
		if (typeof compact.blockId !== 'string' || !(compact.distance >= GROUND_AHEAD)) continue;
		if (/(^|:)(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(compact.blockId)) water += 1;
		else { land += 1; if (Number.isFinite(compact.distance)) farthestLand = Math.max(farthestLand, compact.distance); }
	}
	return { yaw: view.yaw, water, land, farthestLand: Math.round(farthestLand) };
}

function sweepView(facts, { yaw, pitch }) {
	const observation = facts.observation;
	const dimension = observation.world?.dimension ?? null;
	const sources = SWEEP_SECTIONS.map((section) => observation.continuity?.rememberedSections?.includes(section) ? []
		: (section === 'landmarks' ? observation.world?.landmarks ?? observation.landmarks : observation[section]) ?? []);
	const sections = sources.map((entries, sectionIndex) => entries.filter(Boolean).map((entry, index) => {
			const section = SWEEP_SECTIONS[sectionIndex];
			const compact = Object.fromEntries(['uuid', 'stableId', 'type', 'entityType', 'itemId', 'blockId', 'kind', 'position', 'x', 'y', 'z', 'distance', 'parentId', 'partName']
				.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]]));
			const baselineBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');
			const baselineField = SWEEP_REPRESENTATIVE_FIELDS[section].find((name) => compact[name] !== undefined);
			const baselineType = baselineField === undefined ? null : `${baselineField}:${JSON.stringify(compact[baselineField])}`;
			const at = compact.position ?? { x: compact.x, y: compact.y, z: compact.z };
			const key = compact.uuid ?? compact.stableId ?? (at.x === undefined ? `entry:${index}`
				: JSON.stringify([compact.entityType ?? compact.type ?? compact.itemId ?? compact.blockId ?? compact.kind, at.x, at.y, at.z]));
			// A block's stableId is its "x,y,z", which its coordinates already state.
			if (compact.stableId !== undefined && compact.stableId === `${compact.x},${compact.y},${compact.z}`) delete compact.stableId;
			// Tenths are finer than a historical sighting needs.
			for (const field of ['x', 'y', 'z', 'distance']) if (Number.isFinite(compact[field])) compact[field] = Math.round(compact[field] * 10) / 10;
			if (compact.position !== null && typeof compact.position === 'object') compact.position = Object.fromEntries(Object.entries(compact.position).map(([axis, value]) => [axis, Number.isFinite(value) ? Math.round(value * 10) / 10 : value]));
			const field = SWEEP_REPRESENTATIVE_FIELDS[section].find((name) => compact[name] !== undefined);
			return { id: `${dimension}|${section}:${key}`, type: field === undefined ? null : `${section}:${field}:${JSON.stringify(compact[field])}`, compact, baselineBytes, baselineType };
		}));
	return { yaw, pitch, eventSequence: facts.eventSequence, observedAtEpochMs: observation.observedAtEpochMs ?? null, dimension, sections,
		sourceCounts: sources.map((entries) => entries.length) };
}

// Reproduce the former per-heading admission order and byte accounting before compacting. Keeping its selected
// identities also preserves repeated terrain that can support a model-chosen destination, not just mobs/types.
function baselineSweepSightings(view) {
	const counts = [...view.sourceCounts];
	let size = Buffer.byteLength(JSON.stringify({ historical: true, yaw: view.yaw, pitch: view.pitch, eventSequence: view.eventSequence,
		observedAtEpochMs: view.observedAtEpochMs, dimension: view.dimension, ...Object.fromEntries(SWEEP_SECTIONS.map((section) => [section, []])),
		omitted: Object.fromEntries(SWEEP_SECTIONS.map((section, index) => [section, counts[index]])) }), 'utf8');
	const passes = [0, 1].map(() => SWEEP_SECTIONS.map(() => []));
	view.sections.forEach((entries, sectionIndex) => {
		const seen = new Set();
		for (const entry of entries) {
			const pass = entry.baselineType !== null && seen.has(entry.baselineType) ? 1 : 0;
			if (entry.baselineType !== null) seen.add(entry.baselineType);
			passes[pass][sectionIndex].push(entry);
		}
	});
	const retained = [];
	for (const pass of passes) {
		for (let index = 0; index < Math.max(0, ...pass.map((entries) => entries.length)); index += 1) {
			for (const [sectionIndex, entries] of pass.entries()) {
				const entry = entries[index];
				if (entry === undefined) continue;
				const omitted = counts[sectionIndex];
				const grown = size + entry.baselineBytes + (omitted < view.sourceCounts[sectionIndex] ? 1 : 0)
					+ String(omitted - 1).length - String(omitted).length;
				if (grown > SWEEP_HEADING_BYTES) continue;
				size = grown;
				counts[sectionIndex] -= 1;
				retained.push(entry.id);
			}
		}
	}
	return retained;
}

// Priority order of one heading's sightings, as three passes: the first sighting of each type (interleaved across
// sections so one dense section cannot crowd out another), then further mobs, then repeated terrain. The type set
// is the caller's, so the passes can be ranked per heading or across the sweep.
function sweepPasses(sections, seenTypes) {
	const bySection = [0, 1, 2].map(() => SWEEP_SECTIONS.map(() => []));
	sections.forEach((entries, sectionIndex) => entries.forEach((entry) => {
		const pass = entry.type === null || !seenTypes.has(entry.type) ? 0 : SWEEP_SECTIONS[sectionIndex] === 'entities' ? 1 : 2;
		if (entry.type !== null) seenTypes.add(entry.type);
		bySection[pass][sectionIndex].push({ sectionIndex, entry });
	}));
	return bySection.map((lists) => Array.from({ length: Math.max(0, ...lists.map((list) => list.length)) }, (_, index) => lists.map((list) => list[index]).filter(Boolean)).flat());
}

// A heading as the model reads it: empty sections and zero omissions left out, so an absent section means
// nothing new was seen there.
function presentSweepHeading(sample, omittedCounts) {
	const omitted = Object.fromEntries(SWEEP_SECTIONS.map((section, index) => [section, omittedCounts[index]]).filter(([, count]) => count > 0));
	return { ...Object.fromEntries(Object.entries(sample).filter(([, value]) => !Array.isArray(value) || value.length > 0)),
		...(Object.keys(omitted).length === 0 ? {} : { omitted }) };
}

/**
 * Historical sightings preserve each heading without presenting earlier targets as current facts. Neighbouring
 * headings overlap, so each sighting is listed once, under the last heading that saw it (its newest facts); the
 * same coordinates in another dimension are another place. Every sighting admitted by the former per-heading
 * budget stays listed; additional sightings share one budget across the sweep, so a crowded heading
 * can use room a bare one left, and omitted counts only what that budget left out.
 */
function sweepSightings(views) {
	const dimension = views[0]?.dimension ?? null;
	const lastSeen = new Map();
	views.forEach((view, heading) => view.sections.forEach((entries) => entries.forEach(({ id }) => lastSeen.set(id, heading))));
	const sources = views.map((view, heading) => {
		const listed = new Set();
		return view.sections.map((entries) => entries.filter(({ id }) => {
			if (lastSeen.get(id) !== heading || listed.has(id)) return false;
			listed.add(id);
			return true;
		}));
	});
	const frame = (view) => ({ yaw: view.yaw, pitch: view.pitch, eventSequence: view.eventSequence, observedAtEpochMs: view.observedAtEpochMs,
		...(view.dimension === dimension ? {} : { dimension: view.dimension }), ...Object.fromEntries(SWEEP_SECTIONS.map((section) => [section, []])) });
	const measure = (sample, omittedCounts) => Buffer.byteLength(JSON.stringify(presentSweepHeading(sample, omittedCounts)), 'utf8');
	const guaranteed = new Set(views.flatMap(baselineSweepSightings));
	// The guaranteed sightings are listed first; then the shared budget admits more in the same priority order,
	// interleaved across headings. These remain historical sightings, not chosen targets.
	const seenTypes = new Set();
	const passes = sources.map((sections) => sweepPasses(sections, seenTypes));
	const samples = views.map(frame);
	const omittedCounts = (heading) => sources[heading].map((entries, sectionIndex) => entries.length - samples[heading][SWEEP_SECTIONS[sectionIndex]].length);
	// The presented sweep is a fixed frame plus comma-joined samples, so only the changed heading is re-measured.
	const sizes = samples.map((_, heading) => measure(samples[heading], omittedCounts(heading)));
	let total = Buffer.byteLength(JSON.stringify({ historical: true, dimension, samples: [] }), 'utf8') + Math.max(0, samples.length - 1) + sizes.reduce((sum, size) => sum + size, 0);
	const budget = SWEEP_SAMPLE_BYTES * views.length;
	for (const tier of ['guaranteed', 'shared']) {
		for (const pass of [0, 1, 2]) {
			const longest = Math.max(0, ...passes.map((headingPasses) => headingPasses[pass].length));
			for (let index = 0; index < longest; index += 1) {
				for (const [heading, headingPasses] of passes.entries()) {
					const item = headingPasses[pass][index];
					if (item === undefined || guaranteed.has(item.entry.id) !== (tier === 'guaranteed')) continue;
					const section = SWEEP_SECTIONS[item.sectionIndex];
					// Listing an entry adds its bytes and a comma; its omitted count loses at most a digit, or its whole key
					// (with the omitted object) when it is the last one left out.
					const lastOmitted = omittedCounts(heading)[item.sectionIndex] === 1;
					if (tier === 'shared' && total + Buffer.byteLength(JSON.stringify(item.entry.compact), 'utf8') - (lastOmitted ? 48 : 0) > budget) continue;
					samples[heading][section].push(item.entry.compact);
					const size = measure(samples[heading], omittedCounts(heading));
					if (tier === 'shared' && total - sizes[heading] + size > budget) samples[heading][section].pop();
					else { total += size - sizes[heading]; sizes[heading] = size; }
				}
			}
		}
	}
	return { historical: true, dimension, samples: samples.map((sample, heading) => presentSweepHeading(sample, omittedCounts(heading))) };
}
