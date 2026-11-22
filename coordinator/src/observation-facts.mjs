// Observation facts: wake trigger classification, movement and knockback sampling, resource memory and hazard contact (moved from dynamic-main.mjs).
import { boundedResourceSightings, isDiscoveryBlock, resourceBlockFact } from './resource-sightings.mjs';
import { hasHeardSection } from './model-fact-encoding.mjs';
import { createHash } from 'node:crypto';
import { ownSighting } from './search-coverage.mjs';
import { retainedDangerFooting } from './danger-steer-coalescer.mjs';
import { carryNativeWakeEvents } from './native-wake-events.mjs';
import { DRAGON_PERCHED_TRIGGER } from './dragon-fight-facts.mjs';
// Never held for a running action nor waived by a program's reassessWhen (see classifyObservationTrigger).
export const DIMENSION_CHANGED_TRIGGER = 'dimension_changed';
// A seen lava flow due at the body within seconds (player.lavaFlow): the last moment a reply can still move it out.
export const LAVA_FLOW_TRIGGER = 'lava_flow';
const TOOL_BROKE_TRIGGER = 'tool_broke';
// Distinct block steps remembered for loop detection: a walk around a 3x3 ring (8 cells) can repeat once inside it.
const MAX_NATIVE_MOVEMENT_HISTORY = 16;
// A hit's knockback (0.4 blocks per tick with a hop, then drag and ground friction) has settled within about 12 ticks.
export const KNOCKBACK_SETTLE_MS = 600;
// An action's progress position can report the shove up to two ticks before the hurt observation that explains it.
export const KNOCKBACK_LEAD_MS = 100;
// The body's own ground speed: sneaking is 0.03 blocks per tick, sprinting with Speed II 0.18; a knockback starts at 0.4.
const SELF_PROPELLED_MIN_SPEED = 0.02;
const SELF_PROPELLED_MAX_SPEED = 0.25;
// Damage without an attacker's direction (vanilla damage type ids) pushes nobody, so it does not discount movement.
const NON_KNOCKBACK_DAMAGE = new Set(['in_fire', 'campfire', 'on_fire', 'lava', 'hot_floor', 'fall', 'fly_into_wall', 'drown', 'starve',
	'cactus', 'sweet_berry_bush', 'freeze', 'wither', 'magic', 'in_wall', 'cramming', 'dry_out', 'stalagmite', 'out_of_world', 'outside_border']);
const MAX_NATIVE_RESOURCE_MEMORY = 512;
const MAX_NATIVE_BROKEN_BLOCKS = 32;

export function factualProgressSignature(observation) {
	const projection = factualProgressProjection(observation);
	return createHash('sha256').update(JSON.stringify(sortFactualValue(projection))).digest('hex');
}

export function factualProgressDetails(observation) {
	const player = observation?.player ?? {};
	const position = observation?.position ?? player.position ?? player;
	return {
		position: {
			x: finiteOrNull(position?.x),
			y: finiteOrNull(position?.y),
			z: finiteOrNull(position?.z),
		},
		lastResult: observation?.lastResult?.present === true ? {
			actionType: observation.lastResult.actionType,
			state: observation.lastResult.state,
			reasonCode: observation.lastResult.reasonCode,
		} : null,
	};
}

function factualProgressProjection(observation) {
	const player = observation?.player ?? {};
	const position = observation?.position ?? player.position ?? player;
	return {
		position: [finiteOrNull(position?.x), finiteOrNull(position?.y), finiteOrNull(position?.z)],
		alive: player.dead === true ? false : player.alive ?? null,
		health: finiteOrNull(player.health),
		inventory: (observation?.inventory?.items ?? []).map((item) => ({ itemId: item?.itemId ?? item?.id ?? null, count: item?.count ?? null })),
		blocks: (observation?.blocks ?? []).map((block) => ({ x: block?.x ?? null, y: block?.y ?? null, z: block?.z ?? null, blockId: block?.blockId ?? block?.id ?? null, state: block?.state ?? block?.properties ?? null })),
		advancements: observation?.advancements ?? null,
		killEvidence: observation?.killEvidence ?? null,
	};
}

// Same value with every object's keys in sorted order, so equal facts serialize identically.
function sortFactualValue(value) {
	if (Array.isArray(value)) {
		const sorted = new Array(value.length);
		for (let index = 0; index < value.length; index += 1) sorted[index] = sortFactualValue(value[index]);
		return sorted;
	}
	if (value !== null && typeof value === 'object') {
		const keys = Object.keys(value).sort();
		const sorted = {};
		for (const key of keys) {
			if (key === '__proto__') Object.defineProperty(sorted, key, { value: sortFactualValue(value[key]), enumerable: true, writable: true, configurable: true });
			else sorted[key] = sortFactualValue(value[key]);
		}
		return sorted;
	}
	return value;
}

export function finiteOrNull(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * True when the only new perception is routine: sounds already summarised under `heard`, or the server echoing the
 * agent's own chat and action announcements ("<name> ...", "[name] Mining a block"), which its action results already carry.
 * Newly observed player-chat packets and advancement toasts remain facts for the next wake, preserving the base wake policy.
 */
export function routinePerceptionChange(payload, wireObservation, previousSequence, ownName = null, agentNames = []) {
	if (!Number.isSafeInteger(previousSequence)) return false;
	if (typeof payload?.trigger === 'string' && payload.trigger.trim().length > 0) return false;
	const changedFacts = Array.isArray(payload?.changedFacts) ? payload.changedFacts : [];
	if (changedFacts.length === 0 || !changedFacts.every((fact) => fact === 'perception')) return false;
	const events = Array.isArray(wireObservation.perception?.events) ? wireObservation.perception.events : [];
	const fresh = events.filter((event) => Number.isSafeInteger(event?.sequence) && event.sequence > previousSequence);
	const heard = hasHeardSection(wireObservation);
	return fresh.length > 0 && fresh.every((event) => ['player_chat', 'advancement_toast'].includes(event.type)
		|| (heard && event.type === 'sound') || ownEcho(event, ownName) || publicChatLine(event)
		// Every agent's activity line ("[name] Mining a block") is broadcast public chat: context, never a wake.
		|| agentNames.some((name) => ownEcho(event, name)));
}

/** Minecraft's line for an agent's public ("<name> text") or nearby ("[Nearby] <name> text") chat: context, never a wake. */
function publicChatLine(event) {
	return ['system_message', 'chat'].includes(event?.type) && typeof event.text === 'string' && /^(\[Nearby\] )?<[^<>\n]{1,64}> /.test(event.text);
}

function ownEcho(event, name) {
	if (typeof name !== 'string' || name.length === 0 || !['system_message', 'chat'].includes(event?.type) || typeof event.text !== 'string') return false;
	return event.text.startsWith(`[${name}] `) || event.text.startsWith(`<${name}> `);
}

/**
 * Drops the `sighted` fact when every new structure, built or point-of-interest row shows only blocks the agent placed
 * (placed: { x, y, z, blockId }), and the attention with it when nothing else changed and no reason was named.
 */
export function withoutOwnSightings(payload, wireObservation, placed) {
	const changedFacts = Array.isArray(payload?.changedFacts) ? payload.changedFacts : [];
	if (!changedFacts.includes('sighted')) return payload;
	const sighted = wireObservation?.sighted;
	const fresh = ['structures', 'built', 'poi'].flatMap((kind) => (Array.isArray(sighted?.[kind]) ? sighted[kind] : []).filter((row) => row?.new === true).map((row) => [kind, row]));
	if (fresh.length === 0 || !fresh.every(([kind, row]) => ownSighting(kind === 'structures' ? 'structure' : kind, row, placed))) return payload;
	const remaining = changedFacts.filter((fact) => fact !== 'sighted');
	const named = typeof payload.trigger === 'string' && payload.trigger.trim().length > 0;
	return { ...payload, changedFacts: remaining, ...(remaining.length === 0 && !named ? { attention: false } : {}) };
}

export const LAVA_HEARD_TRIGGER = 'lava_heard';
const LAVA_HEARD_NEAR = 16;
/** Lava among the remembered sounds within LAVA_HEARD_NEAR blocks. */
export function heardLavaNear(observation) {
	return (Array.isArray(observation?.heard) ? observation.heard : []).some((row) => typeof row?.sound === 'string' && row.sound.includes('lava')
		&& Number.isFinite(row.distance) && row.distance <= LAVA_HEARD_NEAR);
}

export function classifyObservationTrigger(payload, observation, signals = null) {
	const explicitTrigger = typeof payload.trigger === 'string' && payload.trigger.trim().length > 0 ? payload.trigger.trim().slice(0, 128) : null;
	// A known edge ahead is about a second away at walking speed, faster than any model round: it is never a wake reason
	// itself (authored standing orders and program watchers react to the stored sample). The server never sets attention
	// for it alone and marks a publication made only for it sampleOnly; a forced reason (an action result) keeps attention.
	const changedFacts = Array.isArray(payload.changedFacts) ? payload.changedFacts.filter((fact) => fact !== 'player.dropAhead') : [];
	const sampleOnly = payload.sampleOnly === true;
	const attention = payload.attention === true && !sampleOnly;
	if (explicitTrigger !== null && explicitTrigger !== 'projectile'
		&& (payload.priority === 'urgent' || NO_TASK_WAKE_TRIGGERS.has(explicitTrigger))) {
		return { attention: true, priority: 'urgent', trigger: explicitTrigger };
	}
	// Healing signals are classified on their own below; their names must not read as damage/air/fall facts.
	const joinedFacts = changedFacts.filter((value) => typeof value === 'string' && !value.startsWith('survival.')).join('|').toLowerCase();
	const player = observation?.player ?? {};
	if (changedFacts.includes('player.clouds')) return { attention: true, priority: 'urgent', trigger: 'cloud' };
	const flights = observation?.incomingProjectiles ?? player.incomingProjectiles ?? [];
	const before = signals?.previousPlayer;
	const healthDecreased = Number.isFinite(player.health) && Number.isFinite(before?.health) && player.health < before.health;
	// The server's health delta already means damage. When both samples are
	// available, also exclude healing from legacy/general-purpose deltas.
	const healthDelta = joinedFacts.includes('health') && (!Number.isFinite(before?.health) || !Number.isFinite(player.health) || healthDecreased);
	if (healthDecreased || healthDelta || joinedFacts.includes('attacker') || joinedFacts.includes('damage')) return { attention: true, priority: 'urgent', trigger: 'damage' };
	// Server-sensed threat edges (a mob starts targeting, a creeper swells or closes in, a ranged mob gets a
	// clear shot) wake the model before the first hit; the server latch debounces each mob and signal.
	if (changedFacts.some((fact) => typeof fact === 'string' && fact.startsWith('threats.'))) return { attention: true, priority: 'urgent', trigger: 'threat' };
	if (player.inLava === true || joinedFacts.includes('player.inlava')) return { attention: true, priority: 'urgent', trigger: 'lava' };
	// A seen flow due at the body soon wakes the model before contact. Native agents are debounced per agent
	// (lavaFlowWakeDue); without that state only a flow the previous sample lacked is news.
	if (imminentLavaFlow(player) !== null && (signals?.lavaFlowDue ?? imminentLavaFlow(before) === null)) return { attention: true, priority: 'urgent', trigger: LAVA_FLOW_TRIGGER };
	if (joinedFacts.includes('fire') || player.onFire === true || player.fire === true) return { attention: true, priority: 'urgent', trigger: 'fire' };
	if (joinedFacts.includes('air') && player.underWater === true) return { attention: true, priority: 'urgent', trigger: 'drowning' };
	if (joinedFacts.includes('suffoc') || joinedFacts.includes('air')) return { attention: true, priority: 'urgent', trigger: 'suffocation' };
	if (joinedFacts.includes('fall')) return { attention: true, priority: 'urgent', trigger: 'fall' };
	// The server lists only visible collision-course flights within two seconds, with shields/resistance accounted for.
	if (flights.some(row => row.damaging !== false && (row.new || row.imminentNew))) return { attention: true, priority: 'urgent', trigger: 'projectile' };
	// Debounced healing facts from Minecraft. Low health with no food while threatened is urgent so the model can
	// weigh a retreat; a safe chance to eat is ordinary attention. The model decides whether to eat or flee.
	if (changedFacts.includes('survival.low_health_no_food')) return { attention: true, priority: 'urgent', trigger: 'low_health' };
	// The dragon landing on the fountain is the melee window: about 5 s with nobody within 20 blocks, so it is not held.
	if (signals?.dragonPerch != null) return { attention: true, priority: 'urgent', trigger: DRAGON_PERCHED_TRIGGER };
	// An ordinary named observation cannot hide simultaneous survival facts.
	// A held tool breaking is seen and heard at once; the empty hand changes what every following action does. Its facts
	// ride on the observation (toolBroke), so a danger wake in the same sample carries them too.
	const toolBroke = signals?.toolBreak != null;
	if (explicitTrigger !== null && explicitTrigger !== 'projectile') {
		return { attention: true, priority: 'ordinary', trigger: signals?.dimensionChanged === true ? DIMENSION_CHANGED_TRIGGER : toolBroke ? TOOL_BROKE_TRIGGER : explicitTrigger };
	}
	// A real dimension edge (a portal; a respawn starts a new lifecycle instead) changes every fact the plan assumed.
	// It outranks every ordinary reason here, since the remembered dimension has already moved on and a routine
	// filter would otherwise swallow the crossing; urgent danger (a movement loop included) still wins.
	if (signals?.dimensionChanged === true) return signals.movementLoop === true ? { attention: true, priority: 'urgent', trigger: 'movement_loop' } : { attention: true, priority: 'ordinary', trigger: DIMENSION_CHANGED_TRIGGER };
	// The loop detector fires once, on the sample that closes the loop, so a flight in the same sample must not use it up.
	if (signals?.movementLoop === true) return { attention: true, priority: 'urgent', trigger: 'movement_loop' };
	if (toolBroke) return { attention: true, priority: 'ordinary', trigger: TOOL_BROKE_TRIGGER };
	if (explicitTrigger === 'projectile' || changedFacts.includes('projectile')) return { attention: true, priority: 'ordinary', trigger: 'projectile' };
	if (changedFacts.includes('survival.heal_opportunity')) return { attention: true, priority: 'ordinary', trigger: 'heal_opportunity' };
	// A structure came into view (new, or again after a minute): worth a look; the model decides whether to go.
	// Lava first heard within earshot of a pool (a player hears its pops and turns toward them): the model decides whether to look.
	if (changedFacts.includes('heard') && heardLavaNear(observation)) return { attention: true, priority: 'ordinary', trigger: LAVA_HEARD_TRIGGER };
	if (changedFacts.includes('sighted')) return { attention: true, priority: 'ordinary', trigger: 'structure_sighted' };
	if (changedFacts.includes('furnaces')) return { attention: true, priority: 'ordinary', trigger: 'furnace_ready' };
	if (signals?.resourceDiscovery === true) return { attention: true, priority: 'ordinary', trigger: 'resource_discovery', ...(signals.resourceSightings?.length ? { resourceSightings: signals.resourceSightings } : {}) };
	// sampleOnly: the sample was published only for the drop ahead; it is stored for orders and watchers, never a turn.
	if (!attention) return { attention: false, priority: 'ordinary', trigger: 'observation', ...(sampleOnly ? { sampleOnly: true } : {}) };
	return { attention: true, priority: 'ordinary', trigger: 'attention' };
}

/**
 * Records a block position (repeats collapse) and reports whether it newly completed a movement loop. While a hit's
 * knockback carries the body, and where it lands, the position is not a step the model walked, so it is not recorded.
 */
export function sampleMovement(state, positionKey, sampledAt, evidence) {
	const steps = state.positions;
	const shoved = state.knockbackNow === true
		|| (sampledAt !== null && state.knockbackUntil != null && sampledAt >= state.knockbackFrom && sampledAt <= state.knockbackUntil);
	if (positionKey !== null && !shoved && positionKey !== steps.at(-1)?.key) {
		// The first cell seen after the knockback settled is where it left the body, unless the body is walking there.
		if (state.knockbackLanding !== true || evidence === 'walking') {
			steps.push({ key: positionKey, at: sampledAt, evidence });
			if (steps.length > MAX_NATIVE_MOVEMENT_HISTORY) steps.shift();
		}
		state.knockbackLanding = false;
	} else if (positionKey !== null && !shoved) state.knockbackLanding = false;
	const looping = detectMovementLoop(steps.map((step) => step.key));
	// Repeated samples of the same unresolved loop are not new decisions.
	// Moving out of it rearms attention without an arbitrary cooldown.
	const movementLoop = looping && state.movementLoopActive !== true;
	state.movementLoopActive = looping;
	if (movementLoop) state.movementLoopVersion = (state.movementLoopVersion ?? 0) + 1;
	// The loop stays due until delivery succeeds; walking out of it retires an unreported loop.
	state.movementLoopDue = looping && (state.movementLoopDue === true || movementLoop);
	return movementLoop;
}

/**
 * A hit explains progress positions recorded since the previous observation: steps without walking evidence within
 * its lead, or whose body was carried (airborne or faster than it moves itself) or gave no evidence, are
 * withdrawn; the rest stay the steps the model walked. Steps left adjacent at one cell collapse as when sampled.
 */
export function withdrawShovedSteps(steps, previousObservedAt, hitAt) {
	if (hitAt === null) return;
	const since = previousObservedAt ?? -Infinity;
	for (let index = steps.length - 1; index >= 1; index -= 1) {
		const step = steps[index];
		if (step.at === null || step.at <= since) break;
		if (step.evidence !== 'walking' && (step.at >= hitAt - KNOCKBACK_LEAD_MS || step.evidence === 'carried' || step.evidence === null)) steps.splice(index, 1);
	}
	for (let index = steps.length - 1; index >= 1; index -= 1) if (steps[index].key === steps[index - 1].key) steps.splice(index, 1);
}

/**
 * What the body's own motion says: 'walking' (on the ground at a speed of its own), 'still', 'carried' (airborne or
 * faster than it moves itself), or null without a velocity. A body standing in a new cell after a hit was carried there.
 */
export function movementEvidence(velocity, onGround) {
	if (!Number.isFinite(velocity?.x) || !Number.isFinite(velocity?.z)) return null;
	const speed = Math.hypot(velocity.x, velocity.z);
	if (onGround === false || speed > SELF_PROPELLED_MAX_SPEED) return 'carried';
	return speed < SELF_PROPELLED_MIN_SPEED ? 'still' : 'walking';
}

/**
 * Detects a walk that repeats its own recent route: the last steps retrace the same sequence of blocks just before
 * them, for a route of any length (back and forth, a triangle, a square, a ring) that fits twice in the history.
 * Ordinary forward travel never repeats a sequence.
 */
export function detectMovementLoop(positionKeys) {
	if (!Array.isArray(positionKeys)) return false;
	for (let period = 2; period * 2 <= positionKeys.length; period += 1) {
		let repeats = true;
		for (let index = positionKeys.length - period; index < positionKeys.length && repeats; index += 1) {
			repeats = positionKeys[index] === positionKeys[index - period];
		}
		if (repeats) return true;
	}
	return false;
}

/** True when health fell from a hit that pushes the body (an attacker or projectile, not fire, lava or a fall). */
export function knockbackHurt(player, before) {
	if (!Number.isFinite(player?.health) || !Number.isFinite(before?.health) || player.health >= before.health) return false;
	return typeof player.hurtBy !== 'string' || !NON_KNOCKBACK_DAMAGE.has(player.hurtBy.split(' ')[0]);
}

// The block the feet are in, as on F3. Rounding would put the cell edge at the block centre, where paths walk.
export function nativeBlockPositionKey(player) {
	if (![player?.x, player?.y, player?.z].every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
	return `${Math.floor(player.x)},${Math.floor(player.y)},${Math.floor(player.z)}`;
}

/** Dispatch records establish action identity; pending breaks never explain a discovery. */
export function startOwnBreak(state, actionId, position) {
	state.brokenBlocks = (state.brokenBlocks ?? []).filter((broken) => broken.at !== null);
	state.brokenBlocks.push({ actionId, ...position, at: null, revealed: new Set() });
	if (state.brokenBlocks.length > MAX_NATIVE_BROKEN_BLOCKS) state.brokenBlocks.shift();
}

/** Only server-confirmed visible faces of this exact successful removal can explain a new block. */
export function settleOwnBreak(state, actionId, succeeded, endedAtEpochMs, evidence) {
	const broken = state.brokenBlocks?.find((entry) => entry.actionId === actionId && entry.at === null);
	if (broken === undefined) return;
	const target = evidence?.target;
	if (!succeeded || !Number.isSafeInteger(endedAtEpochMs) || target?.kind !== 'block'
		|| !['x', 'y', 'z'].every(axis => target.position?.[axis] === broken[axis])
		|| target.worldChanged !== true || evidence?.progress?.basis !== 'world_mutation' || evidence.progress.verified !== true || evidence.progress.value !== 1) {
		state.brokenBlocks = state.brokenBlocks.filter(entry => entry !== broken);
		return;
	}
	broken.at = endedAtEpochMs;
	for (const block of evidence.revealedBlocks ?? []) {
		const position = blockPosition(block.position);
		if (position === null || typeof block.blockId !== 'string') continue;
		const delta = { x: position.x - broken.x, y: position.y - broken.y, z: position.z - broken.z };
		const face = delta.x === 1 ? 'west' : delta.x === -1 ? 'east' : delta.y === 1 ? 'down' : delta.y === -1 ? 'up' : delta.z === 1 ? 'north' : 'south';
		if (Math.abs(delta.x) + Math.abs(delta.y) + Math.abs(delta.z) === 1 && block.face === face) {
			broken.revealed.add(`${position.x},${position.y},${position.z}:${block.blockId}`);
		}
	}
}

/** A proof belongs to the first post-result publication, never a later nearby arrival or an item. */
export function rememberResources(state, observation, record = {}, ownDiscard = null) {
	const observedAt = Number.isSafeInteger(observation?.observedAtEpochMs) ? observation.observedAtEpochMs : null;
	const confirmed = (state.brokenBlocks ?? []).filter(broken => broken.at !== null && observedAt !== null && observedAt >= broken.at);
	state.resourceSightings = [];
	for (const candidate of observedResourceCandidates(observation, record)) {
		if (state.resources.has(candidate.key)) continue;
		const suppressed = !candidate.item && confirmed.some(broken => broken.revealed.has(candidate.key))
			|| candidate.item && ownDiscard?.has(candidate.fact.itemId) === true;
		state.resources.add(candidate.key);
		if (!suppressed) state.resourceSightings.push({
			...(observedAt === null ? {} : { observedAtEpochMs: observedAt }),
			...(observation?.world?.dimension === undefined ? {} : { dimension: observation.world.dimension }),
			[candidate.item ? 'item' : 'block']: candidate.fact,
		});
	}
	state.brokenBlocks = (state.brokenBlocks ?? []).filter(broken => !confirmed.includes(broken));
	while (state.resources.size > MAX_NATIVE_RESOURCE_MEMORY) state.resources.delete(state.resources.values().next().value);
	const discovery = state.resourceSightings.length > 0;
	state.resourceSightings = boundedResourceSightings(record, state.resourceSightings);
	return discovery;
}

export function blockPosition(value) {
	return ['x', 'y', 'z'].every((axis) => Number.isSafeInteger(value?.[axis])) ? { x: value.x, y: value.y, z: value.z } : null;
}

function observedResourceCandidates(observation, record) {
	const candidates = [];
	for (const block of [...(observation?.blocks ?? []), ...(observation?.landmarks ?? [])]) {
		if (!isDiscoveryBlock(block, record)) continue;
		candidates.push({ key: `${block.x},${block.y},${block.z}:${block.blockId}`, item: false, fact: resourceBlockFact(block) });
	}
	for (const item of observation?.items ?? []) {
		if (typeof item?.stableId !== 'string' || typeof item?.itemId !== 'string') continue;
		candidates.push({ key: `item:${item.stableId}:${item.itemId}`, item: true, fact: { stableId: item.stableId, itemId: item.itemId, x: item.x, y: item.y, z: item.z } });
	}
	return candidates;
}

const DANGER_WAKE_TRIGGERS = new Set(['damage', 'threat', 'fire', 'lava', LAVA_FLOW_TRIGGER, 'drowning', 'suffocation', 'fall', 'projectile']);

// Only facts actually included in an input or tool result establish awareness. Seeing an entity before its
// threat edge still counts; a different entity of the same type must retain its own warning.
export function survivalFactKeys(facts, keys = new Set()) {
	if (facts === null || typeof facts !== 'object') return keys;
	const player = facts.player ?? facts.hud ?? facts;
	const threatRows = (value) => Array.isArray(value) ? value : value?.entries ?? [];
	// Model wakes list threats beside player (observation.threats) with the nearest as player.threat.
	const rows = [...threatRows(player.threats), ...(player !== facts ? threatRows(facts.threats) : []), ...(player.threat ? [player.threat] : []),
		...(Array.isArray(facts.entities) ? facts.entities : []), ...(player.incomingProjectiles ?? []),
		...(player.lastAttacker ? [player.lastAttacker] : [])];
	for (const row of rows) {
		const id = row?.stableId ?? row?.entityId ?? row?.id ?? row?.uuid;
		if (id !== undefined) keys.add(`entity:${id}`);
		else if (typeof row?.type === 'string') keys.add(`type:${row.type}`);
	}
	if (Number.isFinite(player.air) && player.air < 300) keys.add('air');
	if (typeof player.air === 'string') {
		const bubbles = player.air.match(/(\d+(?:\.\d+)?)\/10 bubbles/u);
		if (player.air.includes('underwater') || bubbles !== null && Number(bubbles[1]) < 10) keys.add('air');
	}
	if (Number.isFinite(player.fallDistance) && player.fallDistance > 0) keys.add('fall');
	for (const child of ['observation', 'postAction', 'world']) survivalFactKeys(facts[child], keys);
	return keys;
}

export function isSurvivalReissueTool(tool) {
	// Waiting is permitted for a no-task survival turn, but is still obsolete routine work during a reissue.
	if (tool?.kind === 'sequence') return tool.actions.every(isSurvivalReissueTool);
	return tool?.actionType !== 'wait' && isSelfPreservationTool(tool);
}

export function dangerWakeTrigger(request) {
	const event = request?.nativeEvent;
	return event?.event === 'program_attention'
		? event.status?.decision?.trigger ?? event.trigger ?? request?.trigger
		: event?.trigger ?? request?.trigger;
}

export function dangerWakeRank(request) {
	const trigger = dangerWakeTrigger(request);
	return DANGER_WAKE_TRIGGERS.has(trigger) ? (trigger === 'projectile' ? 1 : 2) : 0;
}

function attentionWinner(previous, next, priority) {
	const difference = dangerWakeRank(previous) - dangerWakeRank(next);
	if (difference !== 0) return difference > 0 ? previous : next;
	return next?.priority === priority ? next : previous;
}

export function mergeAttentionTrigger(previous, next) {
	const priority = previous?.priority === 'urgent' || next?.priority === 'urgent' ? 'urgent' : 'ordinary';
	const winner = attentionWinner(previous, next, priority);
	return {
		attention: previous?.attention === true || next?.attention !== false,
		priority,
		trigger: winner?.trigger ?? 'attention',
	};
}

export function mergePlannerRequest(previous, next) {
	if (previous != null && previous.goalRevision !== next.goalRevision) return next;
	let merged = carryNativeWakeEvents(previous, next, mergePlannerRequestFacts(previous, next));
	if (previous == null || previous.goalRevision !== next.goalRevision || merged.nativeEvent === undefined) return merged;
	if (previous.nativeEvent !== undefined && attentionWinner(previous, next, merged.priority) === previous
			&& (previous.priority === 'urgent' && next.priority !== 'urgent' || dangerWakeRank(previous) > dangerWakeRank(next))) {
		merged = { ...merged, nativeEvent: { ...previous.nativeEvent,
			observation: merged.nativeEvent.observation ?? previous.nativeEvent.observation,
			eventSequence: merged.nativeEvent.eventSequence ?? previous.nativeEvent.eventSequence,
			mergedEvents: merged.nativeEvent.mergedEvents, trigger: previous.nativeEvent.trigger ?? previous.trigger } };
	}
	if (previous.dangerWake === true) merged.dangerWake = true;
	const sightings = mergeResourceSightings(...[previous.nativeEvent, next.nativeEvent].flatMap(event =>
		[event?.resourceSightings, event?.status?.decision?.resourceSightings, event?.result?.resourceSightings]));
	return sightings.length === 0 ? merged : { ...merged, nativeEvent: { ...merged.nativeEvent, resourceSightings: sightings } };
}

function mergePlannerRequestFacts(previous, next) {
	if (previous === null || previous === undefined) return next;
	const fallDistance = previous.nativeEvent?.observation?.player?.fallDistance;
	if (previous.trigger === 'fall' && Number.isFinite(fallDistance) && fallDistance > 0
			&& fallDistance > (next.nativeEvent?.observation?.player?.fallDistance ?? 0))
		previous = { ...previous, dangerSummary: { ...previous.dangerSummary, fallDistance } };
	const priority = previous.priority === 'urgent' || next.priority === 'urgent' ? 'urgent' : 'ordinary';
	// A queued dimension change stays named over a later routine wake, which would otherwise be held for an action.
	const keepsDimension = previous.priority === next.priority && previous.trigger === DIMENSION_CHANGED_TRIGGER;
	const winner = keepsDimension && dangerWakeRank(next) === 0 ? previous : attentionWinner(previous, next, priority);
	let dangerSummary = mergeDangerSummary(previous.dangerSummary, next.dangerSummary);
	const footing = retainedDangerFooting(previous, next);
	if (footing !== undefined) dangerSummary = { ...dangerSummary, earlierFooting: footing };
	else if (dangerSummary?.earlierFooting !== undefined) {
		const { earlierFooting: superseded, ...rest } = dangerSummary;
		dangerSummary = Object.keys(rest).length === 0 ? undefined : rest;
	}
	const mergedDanger = dangerSummary === undefined ? {} : { dangerSummary };
	// A program that ended (or asked for a decision) while the model was still in a turn must not be replaced by the
	// plain observation that followed: the model would wake without the program's result and have to ask for it.
	const programEvent = previous.nativeEvent?.event;
	if (['program_ended', 'program_attention', 'program_handoff_rejected'].includes(programEvent) && next.nativeEvent?.event === 'observation'
			&& next.nativeEvent.conversationOnly !== true && previous.goalRevision === next.goalRevision) {
		const { programId, status, result } = previous.nativeEvent;
		const program = { ...(programId === undefined ? {} : { programId }), ...(status === undefined ? {} : { status }), ...(result === undefined ? {} : { result }) };
		// Danger leads the wake (its own event and trigger) but still carries the program's result or decision handle.
		if (next.priority === 'urgent') return { ...next, ...mergedDanger, priority, trigger: winner.trigger, nativeEvent: { ...next.nativeEvent, ...program } };
		return { ...next, ...mergedDanger, priority, trigger: winner.trigger, nativeEvent: { ...previous.nativeEvent, observation: next.nativeEvent.observation ?? previous.nativeEvent.observation,
			...(next.eventSequence === undefined ? {} : { eventSequence: next.eventSequence }) } };
	}
	// The newest facts ride under the kept trigger, so queued danger keeps its danger instruction; a crossing in those
	// facts stays a pending assessment for the next wake (see #pendingAssessment).
	const keptTrigger = previous.nativeEvent?.trigger ?? winner.trigger;
	const nativeEvent = winner === previous && next.nativeEvent?.event === 'observation' ? { nativeEvent: { ...next.nativeEvent, trigger: keptTrigger } } : {};
	return { ...next, ...mergedDanger, priority, trigger: winner.trigger, ...nativeEvent };
}

function mergeDangerSummary(previous, next) {
	if (previous == null) return next;
	if (next == null) return previous;
	return {
		foldedEvents: (previous.foldedEvents ?? 0) + (next.foldedEvents ?? 0),
		hitsSinceLastUpdate: (previous.hitsSinceLastUpdate ?? 0) + (next.hitsSinceLastUpdate ?? 0),
		healthAtLastUpdate: previous.healthAtLastUpdate ?? next.healthAtLastUpdate,
		healthNow: next.healthNow ?? previous.healthNow,
		attackers: [...new Set([...(previous.attackers ?? []), ...(next.attackers ?? [])])].slice(0, 4),
		...(previous.fallDistance || next.fallDistance ? { fallDistance: Math.max(previous.fallDistance ?? 0, next.fallDistance ?? 0) } : {}),
	};
}

/** Visible HUD facts in independent sections: a changing air bar must not resend a stable sky or screen. */
export function hudFacts(player, world, menu) {
	if (player == null || typeof player !== 'object' || player.dead === true) return null;
	const hud = {};
	// Copy observations, including approaching:false and signal names; absence never becomes a guessed threat or ETA.
	if (Array.isArray(player.threats) && player.threats.length > 0) hud.threats = player.threats;
	for (const key of ['harm', 'lastAttacker', 'recentDamage', 'clouds', 'groundAhead', 'brink']) if (player[key] != null) hud[key] = player[key];
	for (const key of ['suffocating', 'inLava', 'onFire']) if (typeof player[key] === 'boolean') hud[key] = player[key];
	if (player.hazard != null) hud.hazard = player.hazard;
	if (player.underWater === true) for (const key of ['airSecondsLeft', 'waterMotion', 'waterAbove', 'breathable']) {
		if (player[key] !== undefined) hud[key] = player[key];
	}
	if (Number.isFinite(player.health)) {
		hud.health = Number.isFinite(player.maxHealth) ? `${player.health}/${player.maxHealth}` : player.health;
	}
	if (typeof player.underWater === 'boolean' || Number.isFinite(player.airBubbles)) {
		const water = player.underWater === true ? 'underwater' : player.underWater === false ? 'above water' : '';
		hud.air = [water, ...(Number.isFinite(player.airBubbles) ? [`${player.airBubbles}/10 bubbles`] : [])].filter(Boolean).join(' ');
	}
	if (Number.isFinite(player.foodLevel)) hud.foodLevel = player.foodLevel;
	if (typeof player.hungerShaking === 'boolean') hud.hungerShaking = player.hungerShaking;
	// world.dayPhase is present only where the sky (or a clock) shows it. darkIn stays in world.
	if (world?.dayPhase !== undefined) hud.sky = world.dayPhase;
	if (typeof menu?.type === 'string' && 'containerId' in menu) hud.menuId = menu.type === 'minecraft:inventory' ? null : menu.type;
	return Object.keys(hud).length === 0 ? null : hud;
}

/** In lava or touching a fire block (Minecraft's hazard fact; a hot floor such as magma is not this), not fire resistant. */
export const SURVIVAL_EPISODE_QUIET_MS = 5_000;
export const SURVIVAL_RESTART_MIN_CALL_AGE_MS = 1_500;

/** Danger an observation shows on the body itself; nearby threats alone do not count (they persist all night). */
export function survivalDangerShown(player) {
	return (Number.isFinite(player.air) && player.air < 300) || player.underWater === true || player.suffocating === true
		|| (Number.isFinite(player.fallDistance) && player.fallDistance > 0) || player.onFire === true || inHazardContact(player)
		|| player.lastAttacker != null || player.recentDamage != null || (player.incomingProjectiles?.length ?? 0) > 0;
}

export function inHazardContact(player) {
	if (!(player?.inLava === true || player?.hazard === 'lava' || player?.hazard === 'fire')) return false;
	return !(Array.isArray(player.effects) && player.effects.some((effect) => effect?.effectId === 'minecraft:fire_resistance'));
}

/**
 * A danger steer while the body is in lava or stands in fire (not fire that merely follows it out). Lava contact also
 * costs health, so its event often arrives as damage, which outranks lava when triggers are classified.
 */
export function isHazardContactRequest(request) {
	const event = request?.nativeEvent;
	const trigger = event?.trigger ?? request?.trigger;
	if (request?.priority !== 'urgent' && !NO_TASK_WAKE_TRIGGERS.has(trigger) && trigger !== 'movement_loop') return false;
	const player = (event?.observation ?? request?.observation)?.player;
	// A seen flow due within seconds is contact to come: a call planning without it would answer after the lava arrived.
	return inHazardContact(player) || imminentLavaFlow(player) !== null;
}

// A seen flow due at a body cell within this many seconds wakes the model before contact. Lava kills in about 2.5 s once
// in it and Nether lava spreads a cell every 0.5 s; leave_lava's own pre-contact horizon is the same 4 s.
const LAVA_FLOW_WAKE_S = 4;
const flowCell = (text) => {
	const cell = typeof text === 'string' ? text.split(',').map(Number) : [];
	return cell.length === 3 && cell.every(Number.isSafeInteger) ? cell : null;
};

// A body stepping in and out of a flow's path (an action oscillating beside a Nether lava fall, d24 q-kmb0h6) shows the
// flow every other sample; one wake per this window is enough, the facts ride every later wake.
const LAVA_FLOW_REPEAT_MS = 10_000;

/** Whether this sample's imminent flow wakes the model: at most once per LAVA_FLOW_REPEAT_MS per agent (state is per agent). */
export function lavaFlowWakeDue(state, player, at) {
	if (imminentLavaFlow(player) === null) return false;
	if (Number.isFinite(state.lavaFlowWokeAt) && at - state.lavaFlowWokeAt < LAVA_FLOW_REPEAT_MS && at >= state.lavaFlowWokeAt) return false;
	state.lavaFlowWokeAt = at;
	return true;
}

/** player.lavaFlow as {from, at, inS} cells when it reaches a body cell within LAVA_FLOW_WAKE_S and the body is not in lava yet. */
export function imminentLavaFlow(player) {
	const flow = player?.lavaFlow;
	if (flow == null || player.inLava === true || !Number.isFinite(flow.inS) || flow.inS > LAVA_FLOW_WAKE_S) return null;
	if (Array.isArray(player.effects) && player.effects.some((effect) => effect?.effectId === 'minecraft:fire_resistance')) return null;
	const from = flowCell(flow.from), cell = flowCell(flow.at);
	return from === null || cell === null ? null : { from, at: cell, inS: flow.inS };
}

/**
 * The wake line for an advancing seen flow: where it comes from, the body cell, when, and the player's options. The
 * inflow cell is the one beside the reached cell toward the lava (above it for a straight fall); the step-out cell is
 * the one on the far side at the feet, named only when no seen lava fills it or lies under it. Facts only; nothing moves.
 */
export function lavaFlowLine(observation) {
	const flow = imminentLavaFlow(observation?.player);
	if (flow === null) return null;
	const [fx, , fz] = flow.from, [ax, ay, az] = flow.at;
	const alongX = Math.abs(fx - ax) >= Math.abs(fz - az);
	const dx = alongX ? Math.sign(fx - ax) : 0, dz = alongX ? 0 : Math.sign(fz - az);
	const falls = dx === 0 && dz === 0;
	const inflow = falls ? [ax, ay + 1, az] : [ax + dx, ay, az + dz];
	const feetY = Number.isFinite(observation?.position?.y) ? Math.floor(observation.position.y + 1e-6) : ay;
	const lava = new Set((Array.isArray(observation?.blocks) ? observation.blocks : [])
		.filter((row) => row?.blockId === 'minecraft:lava').map((row) => `${row.x},${row.y},${row.z}`));
	const away = falls ? null : [ax - dx, feetY, az - dz];
	const safe = away !== null && !lava.has(away.join()) && !lava.has([away[0], away[1] + 1, away[2]].join()) && !lava.has([away[0], away[1] - 1, away[2]].join()) ? away : null;
	const step = safe !== null ? `step out of its path to ${safe.join()}` : falls ? 'step out from under it' : 'step out of its path';
	return `Live Minecraft event: seen lava from ${flow.from.join()} reaches your cell ${flow.at.join()} in ~${flow.inS}s; lava kills ~2.5 s after contact. `
		+ `Before then: ${step}, dam its inflow ${inflow.join()} with a block, or arm lava_flowing -> leave_lava/place_block, faster than a reply.`;
}

function mergeResourceSightings(...groups) {
	// Goal relevance was established at discovery; coalescing only enforces the carrier bounds.
	return boundedResourceSightings(null, ...groups);
}
// Urgent facts that wake an agent with no task: the body is still the model's to defend.
export const NO_TASK_WAKE_TRIGGERS = new Set(['damage', 'threat', 'lava', LAVA_FLOW_TRIGGER, 'fire', 'suffocation', 'drowning', 'fall', 'low_health', 'low_health_food', 'cloud', 'projectile']);
// With no task, a danger-woken turn may defend the body only: these mirror Minecraft's own detached-action allowlist
// (AgentLifecycleReducer.isSelfPreservationAction). Everything else is a player request and needs takeTask.
const SELF_PRESERVATION_ACTIONS = new Set(['fight_target', 'flee_from', 'attack', 'use_ranged', 'block_with_shield', 'use_item',
	'select_item', 'select_tool', 'equip_item', 'navigate_to', 'travel_to', 'move_to', 'look_at', 'control', 'control_sequence', 'wait', 'dismount', 'wake_up']);
const SELF_PRESERVATION_READ_TOOLS = new Set(['observe', 'inspect', 'capabilities', 'action_status', 'cancel_action', 'lookAround']);
// Getting food is self-preservation too: picking up drops, and breaking only blocks that are food (Minecraft checks the
// block really is the expected one before breaking it, so these ids bound what a no-task agent can break).
// Minecraft also checks the live target: crops fully grown, berries ripe, a picked-up stack edible.
export const FOOD_PLANT_BLOCKS = Object.freeze(['minecraft:wheat', 'minecraft:carrots', 'minecraft:potatoes', 'minecraft:beetroots', 'minecraft:melon']);
const releasedInput = (frame) => frame?.attack === false && frame?.use === false;
function isSelfPreservationAction(action) {
	// Raw input may move and aim, but attack/use (which could break, place or open anything) goes through
	// fight_target, attack and use_item.
	if (action?.actionType === 'control') return releasedInput(action.arguments);
	if (action?.actionType === 'control_sequence') return Array.isArray(action.arguments?.frames) && action.arguments.frames.every(releasedInput);
	if (SELF_PRESERVATION_ACTIONS.has(action?.actionType) || ['pick_up_item', 'interact_block'].includes(action?.actionType)) return true;
	return action?.actionType === 'break_block' && FOOD_PLANT_BLOCKS.includes(action.arguments?.expectedBlockId);
}
export function isSelfPreservationTool(tool) {
	if (SELF_PRESERVATION_READ_TOOLS.has(tool?.kind)) return true;
	if (['action', 'start_action', 'replace_action'].includes(tool?.kind)) return isSelfPreservationAction(tool);
	if (tool?.kind === 'sequence') return Array.isArray(tool.actions) && tool.actions.every((action) => isSelfPreservationAction(action));
	return false;
}

export function asArray(value) {
	return Array.isArray(value) ? value : [];
}

export function nativeObservationSignature(observation) {
	return createHash('sha256').update(JSON.stringify(sortFactualValue(nativeActionableObservationProjection(observation)))).digest('hex');
}

// Beyond this range an entity's arrival or departure is a change, its wandering is not. Threats that target or
// approach the body are tracked separately in player.threats, which keeps every signal.
const SIGNATURE_ENTITY_DETAIL_RANGE = 16;

function nativeSignatureEntity({ distance, velocity, ...entity }) {
	if (Number.isFinite(distance) && distance > SIGNATURE_ENTITY_DETAIL_RANGE) {
		return { stableId: entity.stableId, type: entity.type, distant: true };
	}
	const block = { ...entity };
	for (const axis of ['x', 'y', 'z']) if (Number.isFinite(block[axis])) block[axis] = Math.floor(block[axis]);
	if (block.position && typeof block.position === 'object') {
		block.position = Object.fromEntries(Object.entries(block.position).map(([axis, value]) => [axis, Number.isFinite(value) ? Math.floor(value) : value]));
	}
	return block;
}

function nativeActionableObservationProjection(observation) {
	const projection = { ...observation };
	// Receipt/sample identity remains in raw facts, but is not a changed world fact.
	delete projection.observedAtEpochMs;
	delete projection.eventSequence;
	if (observation.freshness !== undefined) {
		const { observedAtEpochMs, eventSequence, afterEventSequence, ...freshness } = observation.freshness;
		projection.freshness = freshness;
	}
	delete projection.recovery;
	delete projection.options;
	delete projection.failureClass;
	delete projection.continuity;
	delete projection.lastLiveInventory;
	// Motion and view direction are not world facts: every heartbeat of a standing body jitters them.
	delete projection.velocity;
	delete projection.view;
	if (observation.player !== undefined) {
		projection.player = { ...observation.player };
		// Where the body stands, by block. Sub-block drift and where it looks change nothing a player would act on.
		for (const axis of ['x', 'y', 'z']) if (Number.isFinite(projection.player[axis])) projection.player[axis] = Math.floor(projection.player[axis]);
		delete projection.player.yaw;
		delete projection.player.pitch;
		// Saturation drains on its own; hunger (foodLevel) and health carry the change that matters.
		delete projection.player.saturation;
		if (observation.player.effects !== undefined) {
			projection.player.effects = observation.player.effects.map(({ duration, ...effect }) => effect);
		}
		// Counters that tick down on their own, and exits that shift with every step in lava; the facts they describe
		// change only with health, fire, inLava or position. The hazard kind rides inLava, fire and damage.
		delete projection.player.hazard;
		delete projection.player.fireTicks;
		delete projection.player.exits;
		delete projection.player.hurtBy;
		delete projection.player.recentDamage;
		delete projection.player.lavaSeen;
		// A flow on its way is a change when it appears or changes course, not as its arrival time counts down.
		if (observation.player.lavaFlow && typeof observation.player.lavaFlow === 'object') {
			const { inS, ...course } = observation.player.lavaFlow;
			projection.player.lavaFlow = course;
		}
	}
	if (Array.isArray(observation.items)) projection.items = observation.items.map(({ distance, ...item }) => item);
	if (Array.isArray(observation.entities)) projection.entities = observation.entities.map(nativeSignatureEntity);
	if (Array.isArray(observation.furnaces)) {
		projection.furnaces = observation.furnaces.map(({ observedAtEpochMs, estimatedReadyAtEpochMs, ...furnace }) => furnace);
	}
	if (Array.isArray(observation.nearbyContainers)) {
		projection.nearbyContainers = observation.nearbyContainers.map(({ distance, ...container }) => container);
	}
	if (observation.landmarks !== undefined) {
		projection.landmarks = observation.landmarks.map(({ distance, bearing, elevation, ...landmark }) => landmark);
	}
	if (observation.world !== undefined) {
		const { gameTime, dayTime, ...world } = observation.world;
		projection.world = world;
	}
	if (observation.interaction !== undefined) {
		const { useRemainingTicks, attackCooldown, ...interaction } = observation.interaction;
		projection.interaction = { ...interaction, attackReady: attackCooldown >= 1 };
	}
	return projection;
}
