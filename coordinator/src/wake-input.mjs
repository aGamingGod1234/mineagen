// Wake input: builds the event input the model reads on each wake and compacts it to its byte budget (moved from dynamic-main.mjs).
import { workNotices } from './work-notices.mjs';
import { visibleObservation, visibleHealing, visibleEntity, visibleMenu } from './player-visible-facts.mjs';
import { isFailureResult, withFailureSchema } from './failure-schema.mjs';
import { compactStandingOrder } from './standing-orders.mjs';
import { presentEventHealing, presentEventObservation } from './event-observation-presentation.mjs';
import { boundedResourceSightings } from './resource-sightings.mjs';
import { compactProjectileObservation } from './projectile-attention.mjs';
import { encodeModelFacts, withoutHeardSoundEvents } from './model-fact-encoding.mjs';
import { NEW_CONTEXT_EVENT_INSTRUCTION, ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION } from './native-event-instructions.mjs';
import { respawnLead } from './respawn-recovery.mjs';
import { withToolWear } from './resource-facts.mjs';
import { PLANNING_TAIL_NOTE } from './native-tool-runtime.mjs';
import { situationFacts } from './situation-facts.mjs';
import { combatFacts } from './combat-facts.mjs';
import { leanInputEnabled } from './lean-input.mjs';
import { arrivalFacts, reportsDimensionChange } from './arrival-facts.mjs';
import { DRAGON_PERCHED_TRIGGER, dragonPerchLine } from './dragon-fight-facts.mjs';
import { SITUATION_CHANGED_FIELD, STRATEGY_POINTER_FIELD } from './situation-changes.mjs';
import { nightFor } from './night-cover.mjs';
import { boatKit } from './need-sources.mjs';
import { provenance } from './fact-provenance.mjs';
import { dangerGlance } from './danger-glance.mjs';
import { asArray, hudFacts, inHazardContact, LAVA_FLOW_TRIGGER, lavaFlowLine } from './observation-facts.mjs';
import { AWAITING_CONFIRMATION_EVENT_INSTRUCTION, burnFacts, BURNING_INSTRUCTION, compactHealingForEvent, DANGER_DECISION_TRIGGERS, dangerDecisionInstruction, dangerFactLine, FIRE_CONTACT_INSTRUCTION, HAZARD_CONTACT_INSTRUCTION, HEALING_EVENT_TRIGGERS, healingFacts, lowEligibleBody, NO_TASK_DANGER_INSTRUCTION, NO_TASK_HEAL_INSTRUCTION, survivalFactLine, TASK_HEAL_INSTRUCTION, threatOutlook } from './danger-lines.mjs';

const PLANNING_EVENT_INSTRUCTION = 'Planning due soon; prepare the next intention while the current routine runs. Advisory: no pending decisionId needed. Use current programVersion and timing; do not blindly renew or cancel the program.';

// An owed event the model has not seen yet (mergedEvents) keeps its own facts: what happened to the body and what the
// action or program reported. Its copy of the world (blocks, mobs, inventory, landmarks) is left out: the wake's own
// observation is always the newest, and in a long step 86 owed copies made one wake 1 MB.
const HISTORICAL_OBSERVATION_KEYS = ['observedAtEpochMs', 'eventSequence', 'player', 'perception', 'currentAction', 'lastResult', 'toolBroke',
	'death', 'deathScreen', 'recovery', 'failureClass'];
// Older failed receipts an owed program result re-attaches, beside its newest 8 receipts; the rest are counted.
const MAX_HISTORY_FAILED_RECEIPTS = 8;
const FAILED_RECEIPT_STATES = new Set(['FAILED', 'TIMED_OUT', 'REJECTED', 'CANCELLED']);
// The wake's own sample is the newest on every path but one: a steer that failed after newer wakes were queued is merged
// back on top of them. An owed event newer than the wake's own sample, or one that cannot be ordered, keeps its world.
// Each sample's own timestamp decides first (a merge can pair one request's sequence with another's sample); sequences
// order samples that carry no timestamp.
function newestFirst(entry, eventSequence, observation) {
	const ownAt = observation?.observedAtEpochMs, theirAt = entry?.observation?.observedAtEpochMs;
	if (Number.isFinite(ownAt) && Number.isFinite(theirAt)) return theirAt <= ownAt;
	if (Number.isFinite(ownAt) || Number.isFinite(theirAt)) return false;
	const own = Number.isFinite(observation?.eventSequence) ? observation.eventSequence : eventSequence;
	const theirs = Number.isFinite(entry?.observation?.eventSequence) ? entry.observation.eventSequence : entry?.eventSequence;
	return Number.isFinite(own) && Number.isFinite(theirs) && theirs <= own;
}
function historicalObservation(observation) {
	const kept = Object.fromEntries(HISTORICAL_OBSERVATION_KEYS.filter((key) => observation[key] !== undefined).map((key) => [key, observation[key]]));
	if (typeof observation.world?.dimension === 'string') kept.world = { dimension: observation.world.dimension };
	return kept;
}

export function buildNativeEventInput(record, { event, trigger, programId, status, result, mergedEvents, resourceSightings: queuedResourceSightings, planningLeadMs, eventSequence, taskMemory = null, progress = null, goalNow = null, doing = null, skillFits = null, continuity = null, dangerSummary = null, movementLoop = false, observation = {}, conversation = { mode: 'unread', baseSequence: -1, nextSequence: -1, entries: [] }, conversationOnly = false, awaitingConfirmation = false, confirmationFacts = null, dangerWake = false, selfCareWake = false, healing = null, newContext = false, changed = null, strategy = null, contexts = null, uncovered = null, runningActionStart = null, runningAction = null, actionReceipt = observation.lastResult, ownPours = [] } = {}) {
	const eventName = typeof event === 'string' && event.length > 0 ? event : event?.event;
	const normalizedEvent = typeof eventName === 'string' && eventName.length > 0 ? eventName : 'observation';
	const notice = normalizedEvent === 'program_planning_due' || conversationOnly === true ? [] : workNotices(observation, actionReceipt);
	// Read before presentation copies the observation: the drop clock rides on recovery as a non-enumerable field.
	const respawnRecovery = trigger === 'respawn' && conversationOnly !== true ? respawnLead(observation.recovery ?? null, observation) : null;
	observation = presentEventObservation(compactProjectileObservation(observation), { inventoryLimit: normalizedEvent === 'program_planning_due' ? 8 : 32 });
	const header = continuity !== null && typeof continuity === 'object' ? continuity : null;
	// The header's unresolved failure already states this result; the observation keeps only its replaceable handle.
	const lastResultInHeader = header?.failure !== undefined && typeof observation.lastResult?.actionId === 'string' && observation.lastResult.state !== 'SUCCEEDED'
		&& header.failure.startsWith(`${observation.lastResult.actionType} ${observation.lastResult.reasonCode}`);
	const eventPlanningLeadMs = status?.planningLeadMs ?? planningLeadMs ?? event?.planningLeadMs;
	// The model reads wear as usesLeft; programs keep the raw damage facts.
	const inventorySource = asArray(withToolWear(observation.inventory)?.items);
	const itemSource = asArray(observation.items);
	const entitySource = asArray(observation.entities).filter((entity) => entity?.type !== 'minecraft:item').map(visibleEntity);
	const blockSource = asArray(observation.blocks);
	const landmarkSource = Array.isArray(observation.landmarks) ? observation.landmarks : null;
	const nearbyContainerSource = Array.isArray(observation.nearbyContainers) ? observation.nearbyContainers : null;
	const optionSource = Array.isArray(observation.options) ? observation.options : null;
	const dangerTrigger = normalizedEvent === 'program_attention' ? status?.decision?.trigger ?? trigger : trigger;
	// A danger wake is read for one decision (fight, flee, cover, eat): it carries the facts for that decision and leaves
	// world detail (tag lists, distant landmarks, routine sounds, hit boxes) to observe/inspect (audit 2026-11-01 #9).
	const leanDanger = normalizedEvent !== 'program_planning_due' && isLeanDangerWake({ trigger: dangerTrigger, status, observation, conversationOnly, dangerWake });
	const inventoryRows = boundedEventArray(leanDanger ? inventorySource.map(leanDangerItemTags) : inventorySource, 32);
	const itemRows = boundedEventArray(leanDanger ? itemSource.map(leanDangerItemTags) : itemSource, 16);
	// Hostile or hunting mobs (including ones only heard behind the agent) survive the nearest-16 cut.
	const entityRows = boundedEventArray(leanDanger ? entitySource.map(leanDangerEntity) : entitySource, 16, isHazardousEventFact);
	// Pay for landing/burn danger facts with terrain detail. The full observation stays
	// queryable; coverage below names the omitted rows, and threat/inventory detail keeps its existing budget.
	const burningOrContact = (DANGER_DECISION_TRIGGERS.has(dangerTrigger) || dangerTrigger === 'low_health')
		&& (inHazardContact(observation.player) || burnFacts(observation.player) !== null);
	const blockRows = boundedEventArray(leanDanger ? blockSource.map(leanDangerBlockTags) : blockSource, burningOrContact ? 12 : 32,
		burningOrContact ? row => isHazardousEventFact(row) || row?.blockId === 'minecraft:water' : isHazardousEventFact);
	// Danger keeps the landmarks that change an escape (lava, fire, water); the rest are coverage-counted as omitted.
	const landmarkRows = landmarkSource === null ? null : boundedEventArray(leanDanger
		? landmarkSource.filter((row) => isHazardousEventFact(row) || LEAN_DANGER_LANDMARK_BLOCKS.has(row?.blockId)).map(leanDangerBlockTags) : landmarkSource, 32);
	const nearbyContainerRows = nearbyContainerSource === null ? null : boundedEventArray(nearbyContainerSource, 16);
	const optionRows = optionSource === null ? null : boundedEventArray(optionSource, 4);
	const compactObservation = {
		...(observation.observedAtEpochMs === undefined ? {} : { observedAtEpochMs: observation.observedAtEpochMs }),
		...(observation.eventSequence === undefined ? {} : { eventSequence: observation.eventSequence }),
		...(observation.freshness === undefined ? {} : { freshness: observation.freshness }),
		...(observation.coverage === undefined ? {} : { coverage: compactCoverageForEvent(observation.coverage) }),
		...(observation.perception === undefined ? {} : { perception: compactPerceptionForEvent(withoutHeardSoundEvents(observation.perception, observation)) }),
		...(observation.ready === undefined ? {} : { ready: observation.ready }),
		...(observation.status === undefined ? {} : { status: observation.status }),
		...(observation.velocity === undefined ? {} : { velocity: observation.velocity }),
		player: leanDanger ? leanDangerPlayer(visibleObservation(observation).player ?? {}) : visibleObservation(observation).player ?? {},
		inventory: {
			items: inventoryRows.values,
			...(observation.inventory?.selectedSlot === undefined ? {} : { selectedSlot: observation.inventory.selectedSlot }),
			...(observation.inventory?.selectedItem === undefined ? {} : { selectedItem: observation.inventory.selectedItem }),
			...(observation.inventory?.tagCounts === undefined ? {} : { tagCounts: leanDanger ? leanDangerTagCounts(observation.inventory.tagCounts) : observation.inventory.tagCounts }),
		},
		items: itemRows.values,
		entities: entityRows.values,
		...compactBlockDefaults(blockRows.values, landmarkRows?.values),
		...(observation.sighted === undefined ? {} : { sighted: observation.sighted }),
		...(observation.furnaces === undefined ? {} : { furnaces: observation.furnaces }),
		...(observation.toolBroke === undefined ? {} : { toolBroke: observation.toolBroke }),
		...(observation.leftBehind === undefined ? {} : { leftBehind: observation.leftBehind }),
		...(observation.ownStairs === undefined ? {} : { ownStairs: observation.ownStairs }),
		...(observation.descent === undefined ? {} : { descent: observation.descent }),
		...(observation.recentlySeen === undefined ? {} : { recentlySeen: observation.recentlySeen }),
		...(nearbyContainerRows === null ? {} : { nearbyContainers: nearbyContainerRows.values }),
		...(observation.world === undefined ? {} : { world: modelFacingWorld(visibleObservation(observation).world) }),
		...(observation.currentAction === undefined ? {} : { currentAction: runningActionFacts(observation.currentAction, runningActionStart, runningAction, visibleObservation(observation).player) }),
		...(observation.lastResult === undefined ? {} : { lastResult: lastResultInHeader ? { actionId: observation.lastResult.actionId } : observation.lastResult }),
		...(observation.interaction === undefined ? {} : { interaction: observation.interaction?.menu == null ? observation.interaction : { ...observation.interaction, menu: visibleMenu(observation.interaction.menu) } }),
		...(observation.death === undefined ? {} : { death: observation.death }),
		...(observation.deathScreen === undefined ? {} : { deathScreen: observation.deathScreen }),
		...(observation.recovery === undefined ? {} : { recovery: observation.recovery }),
		...(optionRows === null ? {} : { options: optionRows.values }),
		...(observation.failureClass === undefined ? {} : { failureClass: observation.failureClass }),
		...(observation.continuity === undefined ? {} : { continuity: observation.continuity }),
		...(observation.lastLiveInventory === undefined ? {} : { lastLiveInventory: observation.lastLiveInventory }),
		resultCoverage: {
			inventory: eventArrayCoverage(inventorySource, inventoryRows.values),
			items: eventArrayCoverage(itemSource, itemRows.values),
			entities: eventArrayCoverage(entitySource, entityRows.values),
			blocks: eventArrayCoverage(blockSource, blockRows.values),
			...(landmarkRows === null ? {} : { landmarks: eventArrayCoverage(landmarkSource, landmarkRows.values) }),
			...(nearbyContainerRows === null ? {} : { nearbyContainers: eventArrayCoverage(nearbyContainerSource, nearbyContainerRows.values) }),
			...(optionRows === null ? {} : { options: eventArrayCoverage(optionSource, optionRows.values) }),
		},
		...(leanDanger ? { omittedForDanger: LEAN_DANGER_NOTE } : {}),
	};
	const conversationEntries = Array.isArray(conversation) ? conversation : (Array.isArray(conversation?.entries) ? conversation.entries : []);
	// recipientId is always this agent and goalRevision is bookkeeping; the sender's name and operator flag stay.
	const unreadEntries = boundedEventArray(conversationEntries, Number.POSITIVE_INFINITY).values
		.map(({ recipientId, goalRevision, ...entry }) => entry);
	const unreadConversation = Array.isArray(conversation)
		? { mode: 'unread', baseSequence: null, nextSequence: conversation.at(-1)?.sequence ?? -1, entries: unreadEntries, omittedEntries: 0 }
		: {
			mode: 'unread',
			baseSequence: conversation?.baseSequence ?? null,
			nextSequence: conversation?.nextSequence ?? -1,
			entries: unreadEntries,
			omittedEntries: 0,
		};
	const isPlanningDue = normalizedEvent === 'program_planning_due';
	// A program's attention event names the program, so the decision carries the trigger that raised it.
	const effectiveTrigger = status?.decision?.trigger ?? trigger;
	// Burning damage (lava contact often classifies as damage) carries the burn and food facts too.
	const healingTrigger = HEALING_EVENT_TRIGGERS.has(effectiveTrigger) || effectiveTrigger === 'damage' && burnFacts(observation.player) !== null;
	const hazardContact = !isPlanningDue && inHazardContact(observation.player);
	const residualBurn = !isPlanningDue && !hazardContact && (observation.player?.onFire === true || burnFacts(observation.player) !== null);
	const needsFoodFacts = !isPlanningDue && (Number.isFinite(observation.player?.foodLevel) && observation.player.foodLevel <= 6 || lowEligibleBody(observation.player, 8, 0.4));
	const healingSource = healing ?? ((healingTrigger || needsFoodFacts || residualBurn) && Number.isFinite(observation.player?.health) ? healingFacts(observation) : null);
	const eventHealing = presentEventHealing(visibleHealing(compactHealingForEvent(healingSource, hazardContact), compactObservation.player));
	const outlook = isPlanningDue ? null : threatOutlook(observation);
	const hud = hudFacts(compactObservation.player, compactObservation.world, observation.interaction?.menu);
	// Move only facts present in the lead sections; runtime observations and tool results retain their full shapes.
	if (hud !== null) {
		for (const key of Object.keys(hud)) delete compactObservation.player[key];
		if (hud.air !== undefined) {
			delete compactObservation.player.airBubbles;
			delete compactObservation.player.underWater;
		}
		if (hud.health !== undefined) delete compactObservation.player.maxHealth;
		if (hud.menuId !== undefined) delete compactObservation.interaction.menu.menuId;
		if (hud.sky !== undefined) delete compactObservation.world.dayPhase;
	}
	const situation = isPlanningDue ? null : situationFacts(observation);
	// The side glance is stated once, in the danger line; the raw rows stay in the stored observation.
	const glance = isPlanningDue || conversationOnly === true ? null : dangerGlance(visibleObservation(observation).player);
	delete compactObservation.player.edges;
	const combat = isPlanningDue ? null : combatFacts(observation, { lean: leanInputEnabled(), ownPours });
	// Only the wake that first reports a dimension change: what the arrival spot shows before the first step.
	const arrival = isPlanningDue || !reportsDimensionChange(changed) ? null : arrivalFacts(observation);
	const pendingResourceSightings = boundedResourceSightings(record, queuedResourceSightings, status?.decision?.resourceSightings, result?.resourceSightings);
	const sightingClock = { observedAtEpochMs: compactObservation.observedAtEpochMs };
	const resourceSightings = historicalResourceSightings(pendingResourceSightings, compactObservation, sightingClock);
	const decision = status?.decision == null ? undefined : (({ resourceSightings, ...rest }) => rest)(status.decision);
	const payload = {
		event: normalizedEvent,
		...(mergedEvents === undefined ? {} : { mergedEvents: mergedEvents.map((entry) => {
			const input = buildNativeEventInput(record, entry);
			const { goal, goalSpec, goalRevision, mode, conversation, ...facts } = JSON.parse(input.slice(input.indexOf('\n') + 1));
			if (facts.program?.decision != null) {
				delete facts.program.decision.request;
				facts.program.decision.historical = true;
			}
			if (facts.program?.result !== undefined && entry.result !== undefined) {
				// Each owed program failure owns its receipts, including failures older than the usual receipt tail.
				for (const key of ['failure', 'message']) {
					if (entry.result[key] !== undefined) facts.program.result[key] = entry.result[key];
				}
				if (entry.result.receipts !== undefined) {
					const rows = entry.result.receipts;
					const olderFailed = rows.slice(0, Math.max(0, rows.length - 8)).filter((receipt) => FAILED_RECEIPT_STATES.has(receipt.state)).slice(-MAX_HISTORY_FAILED_RECEIPTS);
					facts.program.result.receipts = [...olderFailed, ...rows.slice(-8)];
					facts.program.result.omittedReceipts = (entry.result.omittedReceipts ?? 0) + rows.length - facts.program.result.receipts.length;
				}
			}
			if (facts.observation != null && typeof facts.observation === 'object' && newestFirst(entry, eventSequence, observation)) facts.observation = historicalObservation(facts.observation);
			return facts;
		}) }),
		trigger: typeof trigger === 'string' && trigger.length > 0 ? trigger : (isPlanningDue ? normalizedEvent : 'observation'),
		...(movementLoop && trigger !== 'movement_loop' ? { movementLoop: true } : {}),
		...(typeof doing === 'string' && doing.length > 0 ? { doing } : {}),
		// The plan's counted needs (have/need) and the step being worked, then the dangers around the body, lead every wake.
		...(typeof goalNow === 'string' && goalNow.length > 0 && !isPlanningDue && conversationOnly !== true ? { goalNow } : {}),
		// A goal skill whose preconditions hold now, beside the counts it serves (skill-fits.mjs).
		...(typeof skillFits === 'string' && skillFits.length > 0 && !isPlanningDue && conversationOnly !== true ? { skillFits } : {}),
		...(notice.length ? { notice } : {}),
		...(glance === null ? {} : { danger: glance }),
		// Danger and body/program ownership lead, then the working intent (now), then changed facts.
		...(hud === null ? {} : { hud }),
		// Repeated hits folded since the last update, so one steer carries what several used to.
		...(dangerSummary === null || dangerSummary === undefined ? {} : { dangerSinceLastUpdate: dangerSummary }),
		...(eventHealing === null || eventHealing === undefined ? {} : { healing: eventHealing }),
		...(outlook === null ? {} : { threatOutlook: outlook }),
		// Dangerous contexts just entered: each danger there and the armed rule that senses it, or the reflex vocabulary that could.
		...(Array.isArray(contexts) && contexts.length > 0 && !isPlanningDue ? { contexts } : {}),
		// Danger wakes: current dangers no armed rule senses.
		...(Array.isArray(uncovered) && uncovered.length > 0 && !isPlanningDue && (DANGER_DECISION_TRIGGERS.has(dangerTrigger) || dangerTrigger === 'low_health') ? { noRuleFor: uncovered } : {}),
		...(programId === undefined ? {} : { program: { programId,
			...(status === undefined ? {} : { state: status.state, engineState: status.engineState, programVersion: status.programVersion, deadlineEpochMs: status.deadlineEpochMs, planningLeadMs: status.planningLeadMs ?? eventPlanningLeadMs, planningBasis: status.planningBasis, ...(isPlanningDue ? { next: PLANNING_TAIL_NOTE } : {}), timing: status.timing, decision, pendingSuccessor: status.pendingSuccessor, ...(status.standingOrder == null ? {} : { standingOrder: compactStandingOrder(status.standingOrder) }) }),
			...(result === undefined ? {} : { result: { state: result.state, reasonCode: result.reasonCode, ...(typeof result.summary === 'string' ? { summary: result.summary } : {}), ...(isFailureResult(result) ? { failure: withFailureSchema(result).failure } : {}), ...(result.standingOrder == null ? {} : { standingOrder: compactStandingOrder(result.standingOrder) }), actions: result.actions, actionsSucceeded: result.actionsSucceeded, actionsFailed: result.actionsFailed, timing: result.timing, freshness: result.freshness, programVersion: result.programVersion, queueId: result.queueId, predecessorProgramId: result.predecessorProgramId, discardedSuccessor: result.discardedSuccessor, receipts: result.receipts?.slice(-8).map(wakeReceipt), omittedReceipts: Math.max(0, (result.receipts?.length ?? 0) - 8) + (result.omittedReceipts ?? 0) } }) } }),
		...(header === null ? {} : { now: header }),
		...(situation === null ? {} : { situation }),
		...(typeof changed === 'string' && !isPlanningDue ? { [SITUATION_CHANGED_FIELD]: changed } : {}),
		...(arrival === null ? {} : { arrival }),
		...(typeof strategy === 'string' && !isPlanningDue ? { [STRATEGY_POINTER_FIELD]: strategy } : {}),
		...(progress === null || header !== null ? {} : { progress }),
		...(combat === null ? {} : { combat }),
		// The goal and event instruction already state task ownership; HUD wakes need no duplicate mode label.
		...(hud === null ? { mode: conversationOnly === true ? 'conversation_only' : 'goal' } : {}),
		goal: record?.currentGoal ?? null,
		goalSpec: presentGoalSpec(record?.currentGoalSpec ?? null, record?.currentGoal),
		goalRevision: record?.goalRevision ?? 0,
		...(awaitingConfirmation ? { completion: { state: 'AWAITING_OPERATOR_CONFIRMATION', factsAtFinish: confirmationFacts ?? [] } } : {}),
		...(taskMemory === null ? {} : { taskMemory: presentTaskMemory(taskMemory, record?.agentId) }),
		...(eventSequence === undefined ? {} : { eventSequence }),
		...(resourceSightings.length === 0 ? {} : { resourceSightings }),
		observation: isPlanningDue ? compactPlanningDueObservation(compactObservation) : compactObservation,
		conversation: unreadConversation,
	};
	// Authoritative persisted steering has its own schema-derived bound. Reserve
	// its actual encoded bytes once, so even escaped/non-ASCII history cannot
	// consume the optional event/unread budget or force instructions out of it.
	// Budget the underlying wake independently: a loop flag must never trim danger or unread messages.
	const loopMetadataBytes = payload.movementLoop === true ? Buffer.byteLength(JSON.stringify({ movementLoop: true }), 'utf8') - 1 : 0;
	// Owed event history has already passed the same player-facing projection as an individual wake.
	// Reserve it separately so optional context trimming cannot erase an undelivered danger or failure.
	const mergedEventBytes = payload.mergedEvents === undefined ? 0 : Buffer.byteLength(JSON.stringify({ mergedEvents: payload.mergedEvents }), 'utf8');
	const eventBudgetBytes = 16_384 + Buffer.byteLength(JSON.stringify(payload.goal), 'utf8') + loopMetadataBytes + mergedEventBytes;
	// Appearance is optional visual detail. It must not push an otherwise fitting
	// wake into overflow compaction, which can discard hostile rows and block facts.
	if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > eventBudgetBytes) {
		for (const section of ['entities', 'blocks', 'landmarks']) {
			if (!Array.isArray(compactObservation[section])) continue;
			compactObservation[section] = compactObservation[section].map(({ appearance, ...facts }) => facts);
		}
		payload.observation = isPlanningDue ? compactPlanningDueObservation(compactObservation) : compactObservation;
	}
	let json = fitResourceSightings(payload, eventBudgetBytes);
	if (Buffer.byteLength(json, 'utf8') > eventBudgetBytes) {
		const overflowObservation = compactEventObservationForBudget(compactObservation);
		const overflowConversation = { ...unreadConversation, entries: [...unreadConversation.entries] };
		const overflowPayload = {
			...payload,
			observation: isPlanningDue ? compactPlanningDueObservation(overflowObservation) : overflowObservation,
			conversation: overflowConversation,
		};
		const overflowSightings = historicalResourceSightings(pendingResourceSightings, overflowPayload.observation, sightingClock);
		overflowPayload.resourceSightings = overflowSightings.length === 0 ? undefined : overflowSightings;
		json = fitResourceSightings(overflowPayload, eventBudgetBytes);
		// Player messages outrank optional context. If the compacted event still leaves
		// no room for the oldest unread message, fall back to core facts instead of
		// failing every later turn with the same oversized context.
		if (unreadConversation.entries.length > 0 && !fitsWithOldestMessage(overflowPayload, eventBudgetBytes)) {
			Object.assign(overflowPayload, minimalEventContext(overflowPayload));
			const minimalSightings = historicalResourceSightings(pendingResourceSightings, overflowPayload.observation, sightingClock);
			overflowPayload.resourceSightings = minimalSightings.length === 0 ? undefined : minimalSightings;
			json = fitResourceSightings(overflowPayload, eventBudgetBytes);
		}
		// Protect the oldest unread instructions. Later messages stay unread and
		// are delivered by a following turn, never acknowledged via a skipped tail.
		while (Buffer.byteLength(json, 'utf8') > eventBudgetBytes && overflowConversation.entries.length > 0) {
			overflowConversation.entries.pop();
			overflowConversation.omittedEntries += 1;
			overflowConversation.nextSequence = overflowConversation.entries.at(-1)?.sequence ?? unreadConversation.baseSequence ?? -1;
			json = JSON.stringify(overflowPayload);
		}
		if (unreadConversation.entries.length > 0 && overflowConversation.entries.length === 0) {
			throw Object.assign(new TypeError(`Native event context leaves no room for unread conversation sequence ${unreadConversation.entries[0].sequence}; messages remain unread. Reduce the event or task context before retrying.`), { code: 'NATIVE_CONVERSATION_BUDGET_EXCEEDED' });
		}
	}
	// Budget with every capacity identity, then abbreviate only what the final retained rows still prove.
	const retainedPayload = JSON.parse(json);
	if (typeof retainedPayload.situation === 'string') {
		retainedPayload.situation = situationFacts(observation, retainedPayload.observation?.inventory?.items);
		json = JSON.stringify(retainedPayload);
	}
	json = withItemDefaults(json);
	// Urgent program decisions get a factual danger line; fight_target and flee_from can run while the program
	// pauses or awaits an explicit decision, so the threat line says so instead of ordering a response.
	const dangerDecision = !isPlanningDue && status?.decision?.priority === 'urgent' && DANGER_DECISION_TRIGGERS.has(status.decision.trigger);
	const dangerLine = isPlanningDue || conversationOnly === true ? null : effectiveTrigger === DRAGON_PERCHED_TRIGGER
		? `${dragonPerchLine(observation)}${status?.decision ? ' Answer program decisions.' : ''}`
		: effectiveTrigger === LAVA_FLOW_TRIGGER ? lavaFlowLine(observation)
		: dangerFactLine(effectiveTrigger, visibleObservation(observation).player);
	const survivalLine = isPlanningDue || conversationOnly === true || effectiveTrigger === 'low_health_food' ? null : survivalFactLine(observation, { newContext });
	const burningInstruction = observation.player?.harm?.waterEvaporates === true || observation.world?.dimension === 'minecraft:the_nether'
		? BURNING_INSTRUCTION.replace('Water/rain extinguish;', 'Water evaporates here;') : BURNING_INSTRUCTION;
	let instruction = conversationOnly === true && dangerWake === true
		? NO_TASK_DANGER_INSTRUCTION
		: conversationOnly === true && selfCareWake === true
		? NO_TASK_HEAL_INSTRUCTION
		: conversationOnly === true
		? 'Player conversation. You have no active task. Only operator:true messages are tasks: if one asks you to do something, call takeTask (it defaults to the sender\'s words; use resume:true to continue a paused task), then end this turn; your task turn starts at once with every tool. Otherwise reply with say.'
		: isPlanningDue
		? PLANNING_EVENT_INSTRUCTION
		: hazardContact
			? `${observation.player?.hazard === 'fire' && observation.player?.inLava !== true ? FIRE_CONTACT_INSTRUCTION : HAZARD_CONTACT_INSTRUCTION}${dangerDecision ? ' Respond to the program after.' : ''}`
		: residualBurn
			? `${burningInstruction}${dangerDecision ? ' Respond to the program after.' : ''}`
		: dangerLine !== null
			? `${dangerLine}${dangerDecision ? ' Facts below are fresh; the program awaits your reply.' : ''}`
		: survivalLine !== null
			? `${survivalLine}${status?.decision ? ' Respond to the pending program decision after the immediate defense.' : ''}`
		: dangerDecision
			? dangerDecisionInstruction(status.decision.trigger)
			: awaitingConfirmation === true
				? AWAITING_CONFIRMATION_EVENT_INSTRUCTION
				: effectiveTrigger === 'low_health_food'
					? TASK_HEAL_INSTRUCTION
					// Danger keeps its own wake; the assessment stays pending for the next event (see #pendingAssessment).
					: newContext === true && !DANGER_DECISION_TRIGGERS.has(effectiveTrigger)
						? NEW_CONTEXT_EVENT_INSTRUCTION
						: status?.decision ? GENERIC_UPDATE_INSTRUCTION : GENERIC_FACTS_INSTRUCTION;
	// Danger and hazard lines stay as they are; the contexts field still rides on those wakes.
	if (Array.isArray(contexts) && contexts.length > 0 && !conversationOnly && !isPlanningDue && !hazardContact && !residualBurn && dangerLine === null && !dangerDecision && !DANGER_DECISION_TRIGGERS.has(effectiveTrigger)) {
		const entered = contexts.map((row) => row.entered).join(', ');
		// From-scratch games 22 Nov: 10 of 14 deaths were unarmoured bodies out on the surface at night; the wake listed the
		// dangers but never the cover a player takes.
		// Night is when endermen walk the surface: one within 16 m with a boat trap on offer (the hunt line) is a pearl worth
		// the seconds before cover, and the cover line alone sent the body digging past it (s1 boat-trap A/B, 26 Nov).
		const enderNear = (visibleObservation(observation).entities ?? []).some((row) => row?.type === 'minecraft:enderman' && Number.isFinite(row.distance) && row.distance <= 16);
		// With no boat in hand the trap starts with a 7 s craft, and the one enderman of ab1c wandered out of view during it.
		const items = observation.inventory?.items ?? [];
		const pearlsDone = items.reduce((sum, item) => sum + (/^minecraft:ender_(pearl|eye)$/.test(item?.itemId ?? '') && item.count > 0 ? item.count : 0), 0) >= 12;
		const kit = boatKit(items);
		const boatFirst = !enderNear && !pearlsDone && kit.boats === 0 && kit.planks >= 5 ? ` ${NIGHT_BOAT_LINE}` : '';
		// 48 games 22-26 Nov: 214 endermen seen, 26 ever within 16 m; the cover line kept 49% of night minutes underground.
		// With pearls short and a way to kill one (a sword or axe, or a boat trap), the night is the pearl hunt.
		const hunter = !pearlsDone && (kit.boats > 0 || kit.planks >= 5 || items.some((item) => /_(sword|axe)$/.test(item?.itemId ?? '') && item.count > 0));
		const cover = contexts.some((row) => row.lasts === 'night') && nightFor(observation) === 'night'
			? hunter ? ` ${NIGHT_HUNT_LINE}${boatFirst}` : ` ${NIGHT_COVER_LINE}${enderNear ? ` ${NIGHT_ENDERMAN_LINE}` : boatFirst}` : '';
		instruction = instruction === GENERIC_UPDATE_INSTRUCTION || instruction === GENERIC_FACTS_INSTRUCTION
			? `Live Minecraft event: entered ${entered}. contexts lists each danger there and which armed reflex senses it.${cover}${status?.decision ? ' Answer program decisions.' : ''}`
			: `${instruction} Entered ${entered}: contexts lists its dangers and armed reflexes.${cover}`;
	}
	// Respawn wakes 2026-10-23: after 35 End deaths and the Nether deaths the model rebuilt from nothing beside the
	// portal while its kit waited minutes away; where the drops are, how long they last and the way back lead the wake.
	if (respawnRecovery !== null && instruction.startsWith(NEW_CONTEXT_EVENT_INSTRUCTION)) {
		instruction = `${NEW_CONTEXT_EVENT_INSTRUCTION} ${respawnRecovery}${instruction.slice(NEW_CONTEXT_EVENT_INSTRUCTION.length)}`;
	}
	if (!conversationOnly && !isPlanningDue && !awaitingConfirmation) {
		const recovery = failureRecoveryInstruction(observation, status, header?.failure);
		if ((instruction === GENERIC_UPDATE_INSTRUCTION || instruction === GENERIC_FACTS_INSTRUCTION) && recovery !== null) instruction = recovery;
		const menu = observation.interaction?.menu;
		const player = visibleObservation(observation).player;
		// An open container can coexist with danger before its next threshold-crossing event.
		if (typeof menu?.type === 'string' && menu.type !== 'minecraft:inventory' && 'containerId' in menu
			&& (player?.underWater === true || player?.onFire === true || player?.inLava === true
				|| player?.suffocating === true || player?.lastAttacker != null || player?.threats?.length > 0)) {
			const response = player.underWater === true ? 'get air' : inHazardContact(player) ? 'move horizontally out of fire/lava' : 'defend or escape';
			instruction = `Danger with ${menu.type} open. Use one sequence: menu_close (menuId:"${menu.type}"), then ${response}. Closing alone gives no protection.${status?.decision ? ' Respond to the pending program decision after.' : ''}`;
		}
	}
	if (!conversationOnly && !isPlanningDue) {
		const dead = deathInstruction(normalizedEvent, observation, taskMemory, record?.name);
		if (dead !== null) instruction = dead;
	}
	// Survival facts and finished-goal ownership must both reach the model, including lava/fire wakes.
	if (awaitingConfirmation) {
		if (instruction !== AWAITING_CONFIRMATION_EVENT_INSTRUCTION) instruction += ` ${AWAITING_CONFIRMATION_EVENT_INSTRUCTION}`;
		if (confirmationFacts?.some(fact => fact.type !== 'operator_confirmed' && fact.satisfied === true)) {
			instruction += ' Minecraft verified the factual goal conditions at your last finish check (completion.factsAtFinish). Only operator confirmation remains; keep waiting without repeating the work.';
		}
	}
	// Provider bookkeeping keeps receipt identity even when the presentation budget removed it.
	// encodeNativeEventInput removes this internal field before sending model-facing text.
	const receipt = actionReceipt;
	if (typeof receipt?.actionId === 'string' && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(receipt.state)) {
		const delivered = JSON.parse(json);
		if (delivered.observation?.lastResult?.actionId !== receipt.actionId || delivered.observation?.lastResult?.state !== receipt.state) {
			delivered._actionReceipt = { actionId: receipt.actionId, state: receipt.state, ...(receipt.reasonCode === undefined ? {} : { reasonCode: receipt.reasonCode }) };
			json = JSON.stringify(delivered);
		}
	}
	if (mergedEvents !== undefined) {
		const delivered = JSON.parse(json);
		for (const historical of delivered.mergedEvents) {
			// Share only identical ordinary context with the final current snapshot, after its budget is fitted.
			// Historical danger/player facts and failure receipts stay explicit, including across context handoff.
			const same = [];
			for (const key of ['blocks', 'landmarks', 'entities', 'items', 'nearbyContainers', 'inventory', 'world', 'resultCoverage']) {
				if (historical.observation?.[key] !== undefined
					&& JSON.stringify(historical.observation[key]) === JSON.stringify(delivered.observation?.[key])) {
					same.push(key);
					delete historical.observation[key];
				}
			}
			if (same.length > 0) historical.observationFieldsEqualToCurrent = same;
		}
		json = JSON.stringify(delivered);
	}
	// Coverage must keep one shape when HUD or running-action facts appear and disappear.
	const presented = JSON.parse(json);
	compactRoutineCoverage(presented.observation);
	return `${compactEventInstruction(instruction)}\n${JSON.stringify(presented)}`;
}

// Transpose the repeated labels, preserving every count and omission after budget trimming.
function compactRoutineCoverage(observation) {
	const coverage = observation.resultCoverage;
	if (!coverage || Object.values(coverage).some(detail => !detail || typeof detail !== 'object'
		|| Object.keys(detail).some(key => !['availableInSnapshot', 'omitted'].includes(key)))) return;
	observation.snapshotCounts = Object.fromEntries(Object.entries(coverage).map(([section, detail]) => [section, detail.availableInSnapshot]));
	const omitted = Object.entries(coverage).filter(([, detail]) => detail.omitted !== undefined);
	if (omitted.length) observation.omittedRows = Object.fromEntries(omitted.map(([section, detail]) => [section, detail.omitted]));
	delete observation.resultCoverage;
}

export function compactEventInstruction(instruction) {
	if (instruction === GENERIC_UPDATE_INSTRUCTION) return 'Update; answer program decisions.';
	if (instruction === GENERIC_FACTS_INSTRUCTION) return 'Update; act on fresh facts.';
	// The encoder recognizes this exact boundary to retain orientation on context changes.
	if (instruction === NEW_CONTEXT_EVENT_INSTRUCTION) return ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION;
	return instruction.replace(/^Live Minecraft event[.:] /, '')
		.replace('Facts below are fresh; the program awaits your reply.', 'Reply to the program.')
		.replace('Player conversation. You have no active task.', 'Conversation; no active task.')
		.replace('Held jump rises ~0.8m/s in lava.', 'Held jump: ~0.8m/s up.')
		.replace('Burn continues after exit; time unknown.', 'Burn after exit; time unknown.')
		.replace('burn continues after exit.', 'burn after exit.')
		.replace('threat, see player.threats. fight_target and flee_from work while the program awaits you.', 'Threat: fight_target/flee_from work while program awaits reply.')
		.replace('defensive handler finished; result and fresh facts below. The program awaits your reply.', 'Handler finished; result/facts below. Reply to the program.')
		.replace('Your finished goal awaits operator confirmation: do not redo it or re-run finish. Waiting never blocks new requests: act on player messages now with any tool, as part of your task, then call finish again when done.', 'Goal awaits operator confirmation: do not redo it or re-run finish. New player requests allow every tool as part of your task; act now, then finish again.')
		.replace('You have no active task; any finished task stays finished, so do not redo it.', 'No active task; do not redo finished work.')
		.replace('If a message asks you to do something, call takeTask', 'For a task request, call takeTask')
		.replace("it defaults to the sender's words; use resume:true to continue a paused task", 'defaults to sender text; resume:true resumes a paused task');
}

const TRAVEL_ACTION_TYPES = new Set(['move_to', 'navigate_to', 'travel_to']);
// What the running action is committed to, from the arguments it was started with (travel destination and the straight
// distance left to it, a fight's own bailout), and the hearts lost since it was first seen running, as the HUD drew
// them. Only a drop is news: the action's own result reports how it ended.
function runningActionFacts(action, start, authored, player) {
	if (action?.active !== true) return action;
	const facts = { ...action };
	const args = authored?.actionId === action.actionId ? authored.arguments ?? {} : {};
	if (TRAVEL_ACTION_TYPES.has(action.actionType) && [args.x, args.y, args.z].every(Number.isFinite)) {
		facts.to = `${args.x},${args.y},${args.z}`;
		if ([player?.x, player?.y, player?.z].every(Number.isFinite)) facts.left = Math.round(Math.hypot(args.x - player.x, args.y - player.y, args.z - player.z));
	} else if (action.actionType === 'travel_to' && [args.x, args.z].every(Number.isFinite)) {
		facts.to = `${args.x},${args.z}`;
		if ([player?.x, player?.z].every(Number.isFinite)) facts.left = Math.round(Math.hypot(args.x - player.x, args.z - player.z));
	}
	if (action.actionType === 'fight_target' && Number.isFinite(args.fleeAtHealth)) facts.fleeAtHealth = args.fleeAtHealth;
	// A dig runs for minutes: its goal stays in view while it digs.
	if (action.actionType === 'dig_to') facts.to = `${args.pattern ?? 'stairs'}${Number.isFinite(args.y) ? ` y${args.y}` : ''}${Number.isFinite(args.x) ? ` x${args.x}` : ''}${Number.isFinite(args.z) ? ` z${args.z}` : ''}${args.heading ? ` ${args.heading}` : ''}`;
	if (start?.actionId === action.actionId && Number.isFinite(start.health) && Number.isFinite(player?.health)) {
		const before = Math.ceil(start.health), now = Math.ceil(player.health);
		if (now < before) facts.hurtWhileRunning = `${before}->${now}`;
	}
	return facts;
}

// No preference for keeping running work: currentAction states what runs and what it has cost, and the model weighs it.
// Restating the cancel contract here changed no decision in the evals and cost ~70 B on every running wake.
export const GENERIC_UPDATE_INSTRUCTION = 'Update. Use fresh facts for the goal; answer program decisions.';
// Without a pending decision, naming one sent the model to programStatus before eating or fleeing (decision evals).
export const GENERIC_FACTS_INSTRUCTION = 'Update. Use fresh facts for the goal.';

function failureRecoveryInstruction(observation, status, unresolvedFailure) {
	if (status?.decision != null) return null;
	const failed = observation.lastResult;
	if (!isFailureResult(failed) && typeof unresolvedFailure !== 'string') return null;
	const current = observation.currentAction;
	if (current?.active === true) {
		// An unrelated old result must not turn every running action into a retry wake.
		const sameKind = isFailureResult(failed) && failed.actionType === current.actionType
			|| typeof unresolvedFailure === 'string' && unresolvedFailure.startsWith(`${current.actionType} `);
		if (!sameKind) return null;
		return `Your ${current.actionType} is running; lastResult describes an earlier action. End this turn to let it continue unless fresh facts require a changed action. No status lookup is needed.`;
	}
	const reason = isFailureResult(failed) ? `${failed.actionType ?? 'action'} ${failed.reasonCode}` : unresolvedFailure;
	const repair = FAILURE_REPAIR_HINTS[failed?.reasonCode] ?? 'Read the reported blocker and current facts; repair that cause or choose a feasible alternative.';
	return `Action failed: ${reason}. Keep the existing goal; choose its next unmet step from these fresh facts. Skip gathering resources already sufficient for that step. Repair this attempt only if still useful: ${repair} Mining needs room for drops and the right harvest tier (stone: wooden+, iron ore: stone+, diamond/gold/redstone: iron+). Use drop_item only on expendable stacks if room is needed; batch known setup with the useful action in sequence. Make progress now; no status lookup or unchanged retry.`;
}

// Live death wakes 2026-10-20 (71 in 22 games) led with "Update" or the failure of an action the death had already ended
// (38 of them, e.g. "Action failed: fight_target ... Make progress now"); none named the death. While dead the only
// action is respawn: a model that respawned straight into the zombies camping the spawn point died six times in three
// minutes, each time hit within ~5 s, before its first post-respawn call. The death and what waits there are the news.
function deathInstruction(event, observation, taskMemory, name) {
	const player = visibleObservation(observation).player ?? {};
	if (!(player.dead === true || event === 'player_death' && player.dead !== false && !(player.health > 0))) return null;
	const raw = typeof observation.death?.cause === 'string' ? observation.death.cause.trim() : '';
	// Vanilla death messages begin with the player's name.
	const cause = (typeof name === 'string' && name.length > 0 && raw.startsWith(`${name} `) ? raw.slice(name.length + 1) : raw).replace(/^was /, '') || 'cause unknown';
	// Respawning at night lands an empty-handed body in the pack that killed it (game 13: 4 deaths in 3 minutes).
	const night = nightFor({ ...observation, player: { ...player, dead: false, armor: 0 } }) === 'night' ? ` ${RESPAWN_NIGHT_LINE}` : '';
	return `Died: ${cause}. While dead only respawn acts. Respawn keeps the goal; then choose dropped-item recovery or re-kit from fresh inventory.${night}${respawnSurroundings(observation, taskMemory)}`;
}
const NIGHT_COVER_LINE = 'With no armour a player spends the night under cover: rest (bed, walls or a dug hole) until dawn, or dig down and work underground.';
const NIGHT_HUNT_LINE = 'Pearls are short and Overworld nights are when endermen walk the surface: a player hunts them on open ground near cover instead of resting or digging down. Stay on the surface with a dug hole or walls a few steps away, walk to within 16 m of any calm enderman seen within 48 m, then trap it in a boat or fight it from full health; step into cover while other hostiles crowd you or under 10 health, then come back out.';
const NIGHT_ENDERMAN_LINE = 'An enderman within 16 m is the exception when the hunt line offers a boat trap: trap and kill it first (under a minute), then take cover.';
const NIGHT_BOAT_LINE = 'Before cover, a player holding 5 spare Overworld planks crafts one boat (about 7 s) and keeps it: night endermen wander off in the seconds a craft takes, and a boat in hand makes the trap place, stare and fight.';
const RESPAWN_NIGHT_LINE = 'It is night: after respawn, rest first (with no blocks it digs a hole), then recover or re-kit at dawn.';

// Hostiles seen now around where the next respawn lands: the set respawn, else the last respawn in this dimension (the
// world spawn area). Nothing is said when that point is unknown or nothing hostile is seen near it.
function respawnSurroundings(observation, taskMemory) {
	const death = observation.death ?? {};
	const dimension = observation.world?.dimension ?? death.dimensionId ?? null;
	const finite = (cell) => [cell?.x, cell?.y, cell?.z].every(Number.isFinite);
	let point = null;
	let label = null;
	const set = { x: death.respawnX, y: death.respawnY, z: death.respawnZ };
	if (finite(set)) {
		if ((death.respawnDimensionId ?? dimension) === dimension) { point = set; label = 'Set respawn'; }
	} else {
		const last = asArray(taskMemory?.deaths).map(entry => entry?.respawnedAt)
			.filter(cell => finite(cell) && (cell.dimension ?? dimension) === dimension).at(-1);
		if (last !== undefined) { point = last; label = 'No bed set; last respawn'; }
	}
	if (point === null) return '';
	const near = asArray(observation.entities).filter(entity => entity?.hostile === true && Number.isFinite(entity.x) && Number.isFinite(entity.z)
		&& Math.hypot(entity.x - point.x, entity.z - point.z) <= 16);
	if (near.length === 0) return '';
	const counts = new Map();
	for (const entity of near) {
		const type = typeof entity.type === 'string' ? entity.type.replace(/^minecraft:/, '') : 'unknown';
		counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	const list = [...counts].map(([type, count]) => count > 1 ? `${type} x${count}` : type).join(', ');
	return ` ${label} ${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.z)}: hostiles within 16 blocks of it now: ${list}.`;
}

// Options for the model, not a selected action or a claim that unseen geometry is safe.
const FAILURE_REPAIR_HINTS = {
	TARGET_NOT_VISIBLE: 'Clear or move around the obstruction, or choose another visible target; mine aims itself.',
	TARGET_TOO_FAR: 'Choose a closer supported position within reach before retrying.',
	NO_STANDABLE_PATH: 'Choose a supported arrival cell with feet/head clearance, or change the obstructing terrain.',
	NO_PATH: 'Choose another approach or change the terrain blocking the route.',
	PATH_BLOCKED: 'Choose another approach or clear the reported obstruction.',
	TARGET_CHANGED: 'Use the currently observed block identity or choose another target.',
	TARGET_OCCUPIED: 'Choose an empty placement cell or clear its occupant first.',
	NO_PLACEMENT_SUPPORT: 'Choose a placement with an adjacent solid support face.',
	ITEM_NOT_IN_HOTBAR: 'Move the needed item to the hotbar with select_tool or menu_click.',
	HOTBAR_SLOT_OCCUPIED: 'Choose an empty hotbar slot or rearrange the occupied destination.',
	RECIPE_INPUTS_UNAVAILABLE: 'Acquire the missing ingredients before crafting again.',
};

// The model reads the completion predicate; the request text is already the goal, and the
// fingerprint and creation tick are bookkeeping that only defeat same-as-previous omission.
function presentGoalSpec(spec, goal) {
	if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return spec;
	const { fingerprint, createdAtTick, originalRequest, ...rest } = spec;
	return { ...(originalRequest === undefined || originalRequest === goal ? {} : { originalRequest }), ...rest };
}

// Task memory as a wake shows it: store revisions, scope identity and authorship stamps change or
// repeat without telling the model anything, and a changed revision alone re-sent the whole summary.
const TASK_MEMORY_BOOKKEEPING = ['worldId', 'revision', 'currentGoalRevision', 'historical', 'query'];
const TASK_ENTRY_BOOKKEEPING = ['goalRevision', 'source', 'historical'];
function presentTaskMemory(summary, agentId) {
	if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return summary;
	const result = {};
	for (const [key, value] of Object.entries(summary)) {
		if (TASK_MEMORY_BOOKKEEPING.includes(key)) continue;
		result[key] = Array.isArray(value) ? value.map(entry => presentTaskEntry(entry, agentId)) : value;
	}
	return result;
}
function presentTaskEntry(entry, agentId) {
	// Model notes: `source` today; a provenance envelope's `src` beginning "told" after that lands.
	const authored = entry?.source === 'model_authored' || typeof entry?.src === 'string' && entry.src.startsWith('told');
	if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || !authored) return entry;
	const copy = { ...entry };
	for (const key of TASK_ENTRY_BOOKKEEPING) delete copy[key];
	// Another agent's shared entry keeps its author.
	if (copy.agentId === agentId) delete copy.agentId;
	return copy;
}

function fitResourceSightings(payload, budget) {
	let json = JSON.stringify(payload);
	while (Buffer.byteLength(json, 'utf8') > budget && payload.resourceSightings?.length) {
		payload.resourceSightings = payload.resourceSightings.slice(0, -1);
		if (payload.resourceSightings.length === 0) delete payload.resourceSightings;
		json = JSON.stringify(payload);
	}
	return json;
}

// Dated sightings remain facts after they leave view; they must not masquerade as a current block or item.
// A sighting reaches the model with its fact envelope (src: source and age) instead of a raw wall clock.
function historicalResourceSightings(sightings, observation, now = observation) {
	return (sightings ?? []).filter(sighting => {
		if (sighting.dimension !== undefined && sighting.dimension !== observation.world?.dimension) return true;
		if (sighting.block) return ![...(observation.blocks ?? []), ...(observation.landmarks ?? [])].some(block =>
			block.x === sighting.block.x && block.y === sighting.block.y && block.z === sighting.block.z && block.blockId === sighting.block.blockId);
		return !(observation.items ?? []).some(item => item.stableId === sighting.item?.stableId && item.itemId === sighting.item?.itemId);
	}).map(({ observedAtEpochMs, ...sighting }) => ({ ...sighting, src: provenance('seen', { observedAtEpochMs }, now) }));
}

// Clock ticks change every wake, which would re-send the whole world section; situation carries the coarse day phase
// and biome instead. Programs, memory and watchers keep the raw facts from the runtime observation.
function modelFacingWorld(world) {
	if (world === null || typeof world !== 'object') return world;
	const { gameTime, dayTime, biome, ...rest } = world;
	return rest;
}

export const NEW_CONTEXT_TRIGGERS = new Set(['start', 'replace', 'respawn']);
export const CONTEXT_ENTRY_TRIGGER = 'context_entry';
export const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_TASK_REQUEST_TIMEOUT_MS = 10_000;
const MINIMAL_TASK_MEMORY_BYTES = 2_048;
const MINIMAL_RECEIPTS = 2;
const MINIMAL_OBSERVATION_FIELDS = new Set(['observedAtEpochMs', 'eventSequence', 'freshness', 'ready', 'status', 'player', 'inventory', 'sighted', 'leftBehind', 'ownStairs', 'descent', 'currentAction', 'lastResult', 'death', 'deathScreen', 'recovery', 'failureClass', 'continuity', 'resultCoverage']);

function fitsWithOldestMessage(payload, budgetBytes) {
	const probe = { ...payload, conversation: { ...payload.conversation, entries: payload.conversation.entries.slice(0, 1) } };
	return Buffer.byteLength(JSON.stringify(probe), 'utf8') <= budgetBytes;
}

// Core facts only: where the agent is, what it holds and what just happened.
// contextTrimmed lists what was dropped, largest first with original byte sizes,
// so the model can look it up again and traces show which context outgrew the budget.
function minimalEventContext(payload) {
	const observation = payload.observation ?? {};
	const sizes = {};
	const minimalObservation = {};
	for (const [key, value] of Object.entries(observation)) {
		if (key === 'world') minimalObservation.world = compactWorldForEvent(value);
		else if (MINIMAL_OBSERVATION_FIELDS.has(key)) minimalObservation[key] = value;
		else sizes[`observation.${key}`] = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
	}
	if (observation.inventory !== undefined) {
		minimalObservation.inventory = { ...observation.inventory, items: asArray(observation.inventory.items).slice(0, 8) };
	}
	// Omission counts must describe the rows this event keeps; dropped sections keep zero rows.
	if (minimalObservation.resultCoverage !== undefined) {
		minimalObservation.resultCoverage = retainedEventCoverage(minimalObservation.resultCoverage, Object.fromEntries(Object.keys(minimalObservation.resultCoverage)
			.map((section) => [section, asArray(section === 'inventory' ? minimalObservation.inventory?.items : minimalObservation[section]).length])));
	}
	const result = { observation: minimalObservation };
	if (payload.taskMemory !== undefined) {
		const encoded = JSON.stringify(payload.taskMemory);
		const bytes = Buffer.byteLength(encoded, 'utf8');
		if (bytes > MINIMAL_TASK_MEMORY_BYTES) {
			sizes.taskMemory = bytes;
			result.taskMemory = { truncated: true, excerpt: truncateUtf8(encoded, MINIMAL_TASK_MEMORY_BYTES) };
		}
	}
	const programResult = payload.program?.result;
	if (Array.isArray(programResult?.receipts) && programResult.receipts.length > MINIMAL_RECEIPTS) {
		sizes['program.result.receipts'] = Buffer.byteLength(JSON.stringify(programResult.receipts), 'utf8');
		result.program = { ...payload.program, result: { ...programResult, receipts: programResult.receipts.slice(-MINIMAL_RECEIPTS), omittedReceipts: (programResult.omittedReceipts ?? 0) + programResult.receipts.length - MINIMAL_RECEIPTS } };
	}
	result.contextTrimmed = Object.fromEntries(Object.entries(sizes).sort(([, left], [, right]) => right - left).slice(0, 12));
	return result;
}

function truncateUtf8(text, maxBytes) {
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1;
	// Never end on the first half of a surrogate pair.
	if (end > 0 && end < text.length) {
		const code = text.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	}
	return text.slice(0, end);
}

function boundedEventArray(value, limit, preserve = null) {
	const source = asArray(value);
	const retained = source.slice(0, limit);
	if (retained.length >= source.length || typeof preserve !== 'function') return { values: retained, omitted: source.length - retained.length };
	let replacement = retained.length - 1;
	for (let index = retained.length; index < source.length && replacement >= 0; index++) {
		if (!preserve(source[index])) continue;
		while (replacement >= 0 && preserve(retained[replacement])) replacement -= 1;
		if (replacement < 0) break;
		retained[replacement] = source[index];
		replacement -= 1;
	}
	return { values: retained, omitted: source.length - retained.length };
}

function eventArrayCoverage(source, retained) {
	return { availableInSnapshot: source.length, ...(source.length <= retained.length ? {} : { omitted: source.length - retained.length }) };
}

function compactEventObservationForBudget(observation) {
	const inventoryRows = boundedEventArray(compactEventRows(observation.inventory?.items), 16, isHazardousEventFact);
	const itemRows = boundedEventArray(compactEventRows(observation.items), 8, isHazardousEventFact);
	const entityRows = boundedEventArray(compactEventRows(observation.entities), 8, isHazardousEventFact);
	const blockRows = boundedEventArray(compactEventRows(observation.blocks), 12, isHazardousEventFact);
	const landmarkRows = Array.isArray(observation.landmarks)
		? boundedEventArray(compactEventRows(observation.landmarks), 12, isHazardousEventFact)
		: null;
	const nearbyContainerRows = Array.isArray(observation.nearbyContainers)
		? boundedEventArray(compactEventRows(observation.nearbyContainers), 8, isHazardousEventFact)
		: null;
	const optionRows = Array.isArray(observation.options)
		? boundedEventArray(compactEventRows(observation.options), 2)
		: null;
	const resultCoverage = retainedEventCoverage(observation.resultCoverage, {
		inventory: inventoryRows.values.length,
		items: itemRows.values.length,
		entities: entityRows.values.length,
		blocks: blockRows.values.length,
		...(landmarkRows === null ? {} : { landmarks: landmarkRows.values.length }),
		...(nearbyContainerRows === null ? {} : { nearbyContainers: nearbyContainerRows.values.length }),
		...(optionRows === null ? {} : { options: optionRows.values.length }),
	});
	return {
		...observation,
		inventory: { ...observation.inventory, items: inventoryRows.values },
		items: itemRows.values,
		entities: entityRows.values,
		...compactBlockOmissions(blockRows.values),
		...(observation.blockDefaults === undefined ? {} : { blockDefaults: observation.blockDefaults }), ...(observation.blockTags === undefined ? {} : { blockTags: retainedBlockTags(observation.blockTags, [...blockRows.values, ...(landmarkRows?.values ?? [])]) }),
		...(landmarkRows === null ? {} : { landmarks: landmarkRows.values }),
		...(nearbyContainerRows === null ? {} : { nearbyContainers: nearbyContainerRows.values }),
		...(optionRows === null ? {} : { options: optionRows.values }),
		...(observation.world === undefined ? {} : { world: compactWorldForEvent(observation.world) }),
		...(observation.lastResult === undefined ? {} : { lastResult: compactLastResultForEvent(observation.lastResult) }),
		...(observation.recovery === undefined ? {} : { recovery: compactRecoveryForEvent(observation.recovery) }),
		...(observation.coverage === undefined ? {} : { coverage: compactCoverageForEvent(observation.coverage) }),
		...(observation.perception === undefined ? {} : { perception: compactPerceptionForEvent(observation.perception) }),
		resultCoverage,
	};
}

function compactPlanningDueObservation(observation) {
	const inventoryRows = boundedEventArray(compactEventRows(observation.inventory?.items), 8, isHazardousEventFact);
	const itemRows = boundedEventArray(compactEventRows(observation.items), 4, isHazardousEventFact);
	const entityRows = boundedEventArray(compactEventRows(observation.entities), 4, isHazardousEventFact);
	const blockRows = boundedEventArray(compactEventRows(observation.blocks), 8, isHazardousEventFact);
	const resultCoverage = retainedEventCoverage(observation.resultCoverage, {
		inventory: inventoryRows.values.length,
		items: itemRows.values.length,
		entities: entityRows.values.length,
		blocks: blockRows.values.length,
		landmarks: 0,
		nearbyContainers: 0,
		options: 0,
	});
	const metadata = Object.fromEntries(['observedAtEpochMs', 'eventSequence', 'freshness', 'coverage', 'ready', 'status', 'velocity', 'perception']
		.filter((field) => observation[field] !== undefined)
		.map((field) => [field, observation[field]]));
	return {
		...metadata,
		player: observation.player ?? {},
		inventory: { ...observation.inventory, items: inventoryRows.values },
		items: itemRows.values,
		entities: entityRows.values,
		...compactBlockOmissions(blockRows.values),
		...(observation.blockDefaults === undefined ? {} : { blockDefaults: observation.blockDefaults }), ...(observation.blockTags === undefined ? {} : { blockTags: retainedBlockTags(observation.blockTags, blockRows.values) }),
		...(observation.sighted === undefined ? {} : { sighted: observation.sighted }),
		...(observation.furnaces === undefined ? {} : { furnaces: observation.furnaces }),
		...(observation.toolBroke === undefined ? {} : { toolBroke: observation.toolBroke }),
		...(observation.leftBehind === undefined ? {} : { leftBehind: observation.leftBehind }),
		...(observation.ownStairs === undefined ? {} : { ownStairs: observation.ownStairs }),
		...(observation.descent === undefined ? {} : { descent: observation.descent }),
		...(observation.recentlySeen === undefined ? {} : { recentlySeen: observation.recentlySeen }),
		...(observation.world === undefined ? {} : { world: compactWorldForEvent(observation.world) }),
		...(observation.currentAction === undefined ? {} : { currentAction: observation.currentAction }),
		...(observation.lastResult === undefined ? {} : { lastResult: compactLastResultForEvent(observation.lastResult) }),
		...(observation.interaction === undefined ? {} : { interaction: observation.interaction }),
		...(observation.death === undefined ? {} : { death: observation.death }),
		...(observation.deathScreen === undefined ? {} : { deathScreen: observation.deathScreen }),
		...(observation.recovery === undefined ? {} : { recovery: compactRecoveryForEvent(observation.recovery) }),
		...(observation.failureClass === undefined ? {} : { failureClass: observation.failureClass }),
		...(observation.continuity === undefined ? {} : { continuity: observation.continuity }),
		...(observation.lastLiveInventory === undefined ? {} : { lastLiveInventory: observation.lastLiveInventory }),
		resultCoverage,
	};
}

function retainedEventCoverage(coverage, retainedCounts) {
	if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) return coverage;
	return Object.fromEntries(Object.entries(coverage).map(([section, detail]) => {
		if (detail === null || typeof detail !== 'object' || retainedCounts[section] === undefined) return [section, detail];
		const available = Number.isSafeInteger(detail.availableInSnapshot) ? detail.availableInSnapshot : detail.retained;
		const retained = retainedCounts[section];
		const { retained: previousRetained, omitted: previousOmitted, ...facts } = detail;
		return [section, { ...facts, ...(available <= retained ? {} : { omitted: available - retained }) }];
	}));
}

const COMPACT_EVENT_ROW_FIELDS = ['uuid', 'stableId', 'type', 'name', 'position', 'x', 'y', 'z', 'distance', 'blockId', 'itemId', 'count', 'slot', 'tags', 'velocity', 'bounds', 'pickable', 'parentId', 'partName', 'state', 'bearing', 'elevation', 'id', 'feasible', 'moveTo', 'reason', 'cause', 'hazard', 'damage', 'maxDamage', 'usesLeft', 'fingerprint', 'hotbar', 'displayName', 'maxStackSize', 'hostile', 'alive', 'health', 'maxHealth', 'targetingAgent', 'swelling', 'fuse', 'appearance', 'perceivedBy', 'potentialRisk', 'risk', 'expectedHitDamage', 'blastDamageIfBroken', 'withinInteractionRange', 'capabilities'];

// Two item row fields usually follow from the row itself: displayName is the item id in title case ("minecraft:oak_planks"
// is "Oak Planks") and hotbar is true exactly for numbered slots 0-8. Matching values are left out of the finished event and
// the rule is stated once; any other value (a renamed stack, "Raw Porkchop" for porkchop) stays on its row. This runs after
// every budget decision, so what the event keeps is unchanged, and only when the encoded event gets smaller: never grows.
export const EVENT_ITEM_DEFAULTS = 'Omitted item fields: displayName = itemId path in title case; hotbar = slot 0-8.';
function defaultItemName(itemId) {
	return itemId.slice(itemId.indexOf(':') + 1).split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
function withoutDefaultItemFields(rows) {
	if (!Array.isArray(rows)) return rows;
	return rows.map((row) => {
		if (row === null || typeof row !== 'object' || Array.isArray(row) || typeof row.itemId !== 'string') return row;
		const { displayName, hotbar, ...rest } = row;
		return {
			...rest,
			...(displayName === undefined || displayName === defaultItemName(row.itemId) ? {} : { displayName }),
			...(hotbar === undefined || hotbar === (Number.isInteger(row.slot) && row.slot >= 0 && row.slot < 9) ? {} : { hotbar }),
		};
	});
}
function withItemDefaults(json) {
	const payload = JSON.parse(json);
	const observation = payload?.observation;
	if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) return json;
	const items = withoutDefaultItemFields(observation.items);
	const compact = {
		...payload,
		observation: Object.fromEntries(Object.entries(observation).flatMap(([key, value]) => {
			if (key === 'inventory' && value !== null && typeof value === 'object' && Array.isArray(value.items)) return [[key, { ...value, items: withoutDefaultItemFields(value.items) }]];
			if (key === 'items') return [[key, items], ['itemDefaults', EVENT_ITEM_DEFAULTS]];
			return [[key, value]];
		})),
	};
	if (compact.observation.itemDefaults === undefined) compact.observation.itemDefaults = EVENT_ITEM_DEFAULTS;
	const encodedBytes = (value) => Buffer.byteLength(JSON.stringify(encodeModelFacts(value)), 'utf8');
	const compactJson = JSON.stringify(compact);
	return encodedBytes(compact) < encodedBytes(payload) && compactJson.length < json.length ? compactJson : json;
}

// Blocks are about half of every event. Most rows repeat values that follow from the row itself.
export const EVENT_BLOCK_DEFAULTS = 'Omitted block fields mean: stableId "x,y,z", bounds one full cube, state {}, tags from blockTags[blockId].';
// Only these exact generation-only tags are omitted. Spawn floors, mob interactions and
// player-triggered growth are gameplay facts; unknown and datapack tags remain visible.
const WORLDGEN_BLOCK_TAGS = new Set([
	'#minecraft:overworld_carver_replaceables',
	'#minecraft:nether_carver_replaceables',
	'#minecraft:sculk_replaceable_world_gen',
	'#minecraft:stone_ore_replaceables',
	'#minecraft:geode_invalid_blocks',
	'#minecraft:lava_pool_stone_cannot_replace',
	'#minecraft:ice_spike_replaceable',
	'#minecraft:trail_ruins_replaceable',
	'#minecraft:forest_rock_can_place_on',
]);
function playerBlockTags(row) {
	if (row === null || typeof row !== 'object' || !Array.isArray(row.tags)) return row;
	return { ...row, tags: row.tags.filter((tag) => typeof tag !== 'string' || !WORLDGEN_BLOCK_TAGS.has(tag)) };
}

function compactBlockDefaults(blocks, landmarks) {
	blocks = blocks.map(playerBlockTags);
	landmarks = landmarks?.map(playerBlockTags);
	let omitted = false;
	// Block tags belong to the block type, so each blockId's tags are listed once when every row agrees.
	const tagsById = new Map();
	for (const block of [...blocks, ...(landmarks ?? [])]) {
		if (block === null || typeof block !== 'object' || typeof block.blockId !== 'string' || !Array.isArray(block.tags)) continue;
		const encoded = JSON.stringify(block.tags);
		tagsById.set(block.blockId, tagsById.has(block.blockId) && tagsById.get(block.blockId) !== encoded ? null : encoded);
	}
	const blockTags = Object.fromEntries([...tagsById].filter(([, encoded]) => encoded !== null).map(([blockId, encoded]) => [blockId, JSON.parse(encoded)]));
	const values = blocks.map((block) => {
		if (block === null || typeof block !== 'object' || Array.isArray(block)) return block;
		const compact = { ...block };
		if (Object.hasOwn(blockTags, compact.blockId) && Array.isArray(compact.tags)) { delete compact.tags; omitted = true; }
		if (compact.stableId === `${compact.x},${compact.y},${compact.z}`) { delete compact.stableId; omitted = true; }
		if (isFullCubeBounds(compact.bounds)) { delete compact.bounds; omitted = true; }
		if (compact.state !== null && typeof compact.state === 'object' && !Array.isArray(compact.state) && Object.keys(compact.state).length === 0) { delete compact.state; omitted = true; }
		return compact;
	});
	let landmarkOmitted = false;
	const landmarkValues = landmarks?.map((landmark) => {
		if (landmark === null || typeof landmark !== 'object' || Array.isArray(landmark)) return landmark;
		const compact = { ...landmark };
		if (compact.stableId === `${compact.x},${compact.y},${compact.z}`) { delete compact.stableId; omitted = landmarkOmitted = true; }
		if (Object.hasOwn(blockTags, compact.blockId) && Array.isArray(compact.tags)) { delete compact.tags; omitted = landmarkOmitted = true; }
		return compact;
	});
	const rows = { blocks: values, ...(landmarkValues === undefined ? {} : { landmarks: landmarkValues }), ...(landmarkOmitted ? { landmarkDefaults: 'Omitted landmark stableId means x,y,z; tags come from blockTags[blockId].' } : {}) };
	if (!omitted) return rows;
	return { ...rows, blockDefaults: EVENT_BLOCK_DEFAULTS, ...(Object.keys(blockTags).length === 0 ? {} : { blockTags }) };
}

function compactBlockOmissions(blocks) {
	const omittedFields = blocks[0]?.omittedFields;
	if (!Array.isArray(omittedFields) || blocks.length < 2 || !blocks.every((row) => JSON.stringify(row?.omittedFields) === JSON.stringify(omittedFields))) return { blocks };
	return { blocks: blocks.map(({ omittedFields: _omitted, ...row }) => row), blockOmittedFields: omittedFields };
}

function retainedBlockTags(blockTags, rows) {
	const retained = new Set(rows.map((row) => row?.blockId));
	const kept = Object.fromEntries(Object.entries(blockTags ?? {}).filter(([blockId]) => retained.has(blockId))
		.map(([blockId, tags]) => [blockId, Array.isArray(tags) ? playerBlockTags({ tags }).tags : tags]));
	return Object.keys(kept).length === 0 ? undefined : kept;
}

function isFullCubeBounds(bounds) {
	return Array.isArray(bounds) && bounds.length === 1 && bounds[0] !== null && typeof bounds[0] === 'object'
		&& Object.keys(bounds[0]).length === 6 && bounds[0].minX === 0 && bounds[0].minY === 0 && bounds[0].minZ === 0
		&& bounds[0].maxX === 1 && bounds[0].maxY === 1 && bounds[0].maxZ === 1;
}

function compactEventRows(value) {
	return asArray(value).map((entry) => {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
		const compact = Object.fromEntries(COMPACT_EVENT_ROW_FIELDS.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]]));
		if (Object.keys(compact).length === 0) return entry;
		const omittedFields = [...new Set([...(entry.omittedFields ?? []), ...Object.keys(entry).filter((field) => field !== 'omittedFields' && !COMPACT_EVENT_ROW_FIELDS.includes(field))])];
		return omittedFields.length === 0 ? compact : { ...compact, omittedFields };
	});
}

/**
 * The wakes read for one survival decision: a danger trigger, low health, hazard contact or burning, a program's urgent
 * danger decision, a fight that bailed out on low health, and the no-task danger wake.
 */
export function isLeanDangerWake({ trigger, status, observation = {}, conversationOnly = false, dangerWake = false } = {}) {
	if (conversationOnly === true) return dangerWake === true;
	if (DANGER_DECISION_TRIGGERS.has(trigger) || trigger === 'low_health') return true;
	if (status?.decision?.priority === 'urgent' && DANGER_DECISION_TRIGGERS.has(status.decision.trigger)) return true;
	if (inHazardContact(observation.player) || observation.player?.onFire === true || burnFacts(observation.player) !== null) return true;
	return observation.currentAction?.active !== true && observation.lastResult?.reasonCode === 'LOW_HEALTH_BAILOUT';
}

export const LEAN_DANGER_NOTE = 'Danger wake: block and item tags other than mining, tool, weapon, food and armour tags, landmarks other than hazards and water, routine sound rows and entity bounds are left out; coordinates are rounded to 0.1. observe or inspect returns them.';
// Tags a defence or escape can turn on: what digs or places where, and what is a weapon, tool, food or armour.
const LEAN_DANGER_BLOCK_TAG = /^#minecraft:(mineable\/|needs_|logs$|logs_that_burn$|planks$|replaceable$|climbable$|fire$|campfires$|leaves$|dirt$|sand$)/;
const LEAN_DANGER_ITEM_TAG = /^#c:(foods|tools|armors|shields)(\/|$)|^#minecraft:(swords|axes|pickaxes|shovels|hoes|planks|logs|arrows|head_armor|chest_armor|leg_armor|foot_armor|meat|fishes)$/;
const LEAN_DANGER_LANDMARK_BLOCKS = new Set(['minecraft:water', 'minecraft:lava', 'minecraft:fire', 'minecraft:soul_fire', 'minecraft:magma_block', 'minecraft:powder_snow']);
// Sounds of the fight itself and of footsteps: the threat rows already carry the mobs that made them.
const LEAN_DANGER_ROUTINE_SOUND = /^entity\.[a-z_]+\.(hurt|step|death|ambient|attack|swim|splash|eat|burp)(\.|$)|^entity\.player\.|^block\.[a-z_]+\.(step|break|place|hit|fall)$/;

function leanDangerBlockTags(row) {
	if (row === null || typeof row !== 'object' || !Array.isArray(row.tags)) return row;
	return { ...row, tags: row.tags.filter((tag) => typeof tag !== 'string' || LEAN_DANGER_BLOCK_TAG.test(tag)) };
}

function leanDangerItemTags(row) {
	if (row === null || typeof row !== 'object' || !Array.isArray(row.tags)) return row;
	return { ...row, tags: row.tags.filter((tag) => typeof tag !== 'string' || LEAN_DANGER_ITEM_TAG.test(tag)) };
}

function leanDangerTagCounts(tagCounts) {
	if (tagCounts === null || typeof tagCounts !== 'object' || Array.isArray(tagCounts)) return tagCounts;
	return Object.fromEntries(Object.entries(tagCounts).filter(([tag]) => LEAN_DANGER_ITEM_TAG.test(tag)));
}

const roundTenth = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
const roundHundredth = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : value;

function leanDangerEntity(row) {
	if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
	const { bounds: _bounds, ...lean } = row;
	for (const axis of ['x', 'y', 'z']) if (axis in lean) lean[axis] = roundTenth(lean[axis]);
	if (lean.velocity !== null && typeof lean.velocity === 'object' && !Array.isArray(lean.velocity)) {
		lean.velocity = Object.fromEntries(Object.entries(lean.velocity).map(([axis, value]) => [axis, roundHundredth(value)]));
	}
	return lean;
}

function leanDangerPlayer(player) {
	if (player === null || typeof player !== 'object') return player;
	const lean = { ...player };
	for (const axis of ['x', 'y', 'z']) if (axis in lean) lean[axis] = roundTenth(lean[axis]);
	if (Array.isArray(lean.heard)) {
		const heard = lean.heard.filter((row) => typeof row?.sound !== 'string' || !LEAN_DANGER_ROUTINE_SOUND.test(row.sound));
		if (heard.length === 0) delete lean.heard;
		else lean.heard = heard;
	}
	return lean;
}

function isHazardousEventFact(value) {
	if (value === null || typeof value !== 'object') return false;
	if (value.hostile === true && value.alive !== false) return true;
	if (value.targetingAgent === true || value.swelling === true) return true;
	// An active risk (engaging the agent right now) is kept under budget like a hostile.
	if (typeof value.risk === 'number') return true;
	const text = ['blockId', 'itemId', 'type', 'name', 'reason', 'cause', 'hazard'].map((field) => value[field]).filter((field) => typeof field === 'string').join(' ');
	return /lava|fire|magma|cactus|campfire|tnt|creeper|ghast|blaze|wither|warden|dragon|hostile/i.test(text);
}

function compactRecoveryForEvent(recovery) {
	if (recovery === null || typeof recovery !== 'object') return recovery;
	return {
		...(recovery.lastDeath === undefined ? {} : { lastDeath: recovery.lastDeath }),
		...(Array.isArray(recovery.lastLostInventory) ? { lastLostInventory: recovery.lastLostInventory.slice(0, 16) } : {}),
		...(Array.isArray(recovery.alreadyHave) ? { alreadyHave: recovery.alreadyHave.slice(-32) } : {}),
		...(Array.isArray(recovery.doNotRedo) ? { doNotRedo: recovery.doNotRedo.slice(0, 24) } : {}),
		...(typeof recovery.facts === 'string' ? { facts: recovery.facts } : {}),
	};
}

/** A program receipt in a wake: a failed step keeps its code; the program result's own failure explains the end. */
function wakeReceipt(receipt) {
	if (!isFailureResult(receipt)) return receipt;
	const { message: _message, failure: _failure, executionStarted: _started, physicalAttempted: _attempted, repeatedFailure: _repeat, ...rest } = receipt;
	return rest;
}

function compactLastResultForEvent(lastResult) {
	if (lastResult === null || typeof lastResult !== 'object') return lastResult;
	return {
		...(lastResult.state === undefined ? {} : { state: lastResult.state }),
		...(lastResult.reasonCode === undefined ? {} : { reasonCode: lastResult.reasonCode }),
		// The runtime attaches a failure only on its first delivery; a compact wake must not lose it.
		...(lastResult.failure === undefined ? {} : { failure: lastResult.failure }),
	};
}

function compactWorldForEvent(world) {
	if (world === null || typeof world !== 'object') return world;
	return {
		...(world.worldId === undefined ? {} : { worldId: world.worldId }),
		...(world.dimension === undefined ? {} : { dimension: world.dimension }),
		...(world.dimensionId === undefined ? {} : { dimensionId: world.dimensionId }),
		...(world.dayPhase === undefined ? {} : { dayPhase: world.dayPhase }),
		...(world.darkIn === undefined ? {} : { darkIn: world.darkIn }),
		...(world.raining === undefined ? {} : { raining: world.raining }),
		...(world.thundering === undefined ? {} : { thundering: world.thundering }),
	};
}

// placeableFacesFor / placeableFacesStandIn say which item placeableFaces was judged for; the faces mean nothing without it.
const COVERAGE_EVENT_FIELDS = ['returned', 'total', 'omittedByWire', 'complete', 'hasMore', 'nextOffset', 'placeableFacesFor', 'placeableFacesStandIn'];

function compactCoverageForEvent(coverage) {
	if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) return coverage;
	return {
		...coverage,
		...(coverage.sections === null || typeof coverage.sections !== 'object' || Array.isArray(coverage.sections)
			? {}
			: { sections: Object.fromEntries(Object.entries(coverage.sections).map(([section, detail]) => [section,
				detail === null || typeof detail !== 'object' || Array.isArray(detail) ? detail : Object.fromEntries(
					COVERAGE_EVENT_FIELDS.filter((field) => detail[field] !== undefined).map((field) => [field, detail[field]]),
				)])) }),
	};
}

function compactPerceptionForEvent(perception) {
	if (perception === null || typeof perception !== 'object' || Array.isArray(perception)) return perception;
	return {
		...perception,
		...(Array.isArray(perception.events) ? { events: perception.events.slice(-8), ...(perception.events.length <= 8 ? {} : { omittedEvents: perception.events.length - 8 }) } : {}),
		...(Array.isArray(perception.bossBars) ? { bossBars: perception.bossBars.slice(-16), ...(perception.bossBars.length <= 16 ? {} : { omittedBossBars: perception.bossBars.length - 16 }) } : {}),
	};
}
