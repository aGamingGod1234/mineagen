// Danger lines: fight steering, the danger and survival fact lines, and the healing facts a wake shows (moved from dynamic-main.mjs).
import { visibleObservation } from './player-visible-facts.mjs';
import { sanitizeDiagnosticErrorCode, sanitizeDiagnosticErrorMessage } from './diagnostic-sanitizer.mjs';
import { carriedFoodToEat, eatCalls, naturalRegeneration } from './fork-rule.mjs';
import { asArray, FOOD_PLANT_BLOCKS, isSelfPreservationTool, LAVA_FLOW_TRIGGER } from './observation-facts.mjs';

export function nativeSteerInterruption(request) { return steerInterruption(request, true); }

function steerInterruption(request, countHits) {
	const event = request?.nativeEvent;
	// Undelivered danger keeps its original facts even if the newest observation no longer shows it.
	if (event?.mergedEvents?.some(nativeEvent => steerInterruption({ nativeEvent }, countHits) === 'danger')) return 'danger';
	const trigger = event?.event === 'program_attention'
		? event.status?.decision?.trigger ?? event.trigger ?? request?.trigger
		: event?.trigger ?? request?.trigger;
	if (countHits && (trigger === 'damage' || request?.dangerSummary?.hitsSinceLastUpdate > 0)) return 'danger';
	if (['lava', LAVA_FLOW_TRIGGER, 'fire', 'drowning', 'suffocation', 'fall', 'cloud'].includes(trigger)) return 'danger';
	const observation = event?.observation ?? request?.observation ?? {};
	const flights = observation?.player?.incomingProjectiles ?? observation?.incomingProjectiles ?? [];
	if (trigger === 'projectile' && flights.some(row => row.damaging !== false)) return 'danger';
	const threats = Array.isArray(observation?.player?.threats) ? observation.player.threats
		: Array.isArray(observation?.threats?.entries) ? observation.threats.entries : [];
	return threats.some((threat) => {
		const type = typeof threat?.type === 'string' ? threat.type.toLowerCase() : '';
		const creeper = type.includes('creeper');
		const signals = Array.isArray(threat?.signals) ? threat.signals : [];
		// A drawn bow interrupts only as its own threat edge; it stays visible while held and must not cut every steer.
		return signals.includes('imminent') || trigger === 'threat' && signals.includes('ranged_aiming')
			|| creeper && (threat.swelling === true || signals.includes('swelling') || signals.includes('creeper_close'));
	}) ? 'danger' : null;
}

const FIGHT_ACTION_TYPES = new Set(['fight_target', 'fight_until']);
// The same bands the danger coalescer reports at: crossing one changes what a sensible choice is.
const FIGHT_STEER_HEALTH_BANDS = Object.freeze([14, 10, 6]);
// fight_until bails out at 6 when no fleeAtHealth is given (ServerFightUntilController.DEFAULT_FLEE_AT_HEALTH).
const FIGHT_UNTIL_DEFAULT_FLEE_AT_HEALTH = 6;

/**
 * The health bands that cut a running fight. A fight with a bail-out line hands back by itself there, so its hits are
 * absorbed down to max(line, 6), and only that line cuts. fight_target without fleeAtHealth never bails out
 * (CombatPlanning.shouldBailOut), so it keeps every band.
 */
function fightSteerBands(running) {
	const given = running.arguments?.fleeAtHealth;
	const line = Number.isFinite(given) ? given : running.actionType === 'fight_until' ? FIGHT_UNTIL_DEFAULT_FLEE_AT_HEALTH : null;
	return line === null ? FIGHT_STEER_HEALTH_BANDS : [Math.max(line, 6)];
}

function steerAttackers(request) {
	const attackers = [], types = new Set();
	const add = (event, fallbackTrigger) => {
		const attacker = event?.observation?.player?.lastAttacker;
		const trigger = event?.status?.decision?.trigger ?? event?.trigger ?? fallbackTrigger;
		if (attacker != null || trigger === 'damage') {
			attackers.push(attacker ?? {});
			types.add(attacker?.type);
		}
		const merged = event?.mergedEvents ?? [];
		const retainedHits = merged.reduce((count, entry) => count + add(entry), 0);
		// The current envelope also appears in mergedEvents; count original damage events only once.
		return merged.length > 0 ? retainedHits : trigger === 'damage' ? 1 : 0;
	};
	const retainedHits = add(request?.nativeEvent ?? request, request?.trigger);
	for (const type of request?.dangerSummary?.attackers ?? []) if (typeof type === 'string') types.add(type);
	// A type-only summary cannot establish which individuals caused hits missing from the retained history.
	const identitiesComplete = !(request?.dangerSummary?.hitsSinceLastUpdate > retainedHits)
		&& [...types].every(type => attackers.some(attacker => attacker.type === type));
	return { attackers, types, identitiesComplete };
}

function steerHealth(request) {
	const summary = request?.dangerSummary?.healthNow;
	if (Number.isFinite(summary)) return summary;
	const health = (request?.nativeEvent?.observation ?? request?.observation)?.player?.health;
	return Number.isFinite(health) ? health : null;
}

/**
 * Whether a danger steer should cut the agent's running fight short. A fight the model chose already answers hits
 * from the mob it is fighting, so those hits reach the model with the next steer instead of interrupting the fight
 * every two seconds. Anything new still interrupts: hazards, projectiles, escalating threats, an attacker outside the
 * fight, an unknown attacker, or health falling into a lower band (14, 10, 6) since the fight started or last cut. A
 * fight with a bail-out line absorbs those bands down to max(fleeAtHealth, 6), and only that line cuts (fightSteerBands).
 * Pure: returns { interruption, absorbed, cut }. The caller stores `cut` as the new reference only when it actually
 * interrupts, so evaluating the same steer twice gives the same answer.
 */
export function fightSteerDecision(request, running, state = null) {
	const interruption = nativeSteerInterruption(request);
	if (interruption !== 'danger' || !FIGHT_ACTION_TYPES.has(running?.actionType)) return { interruption, absorbed: false, cut: null };
	const health = steerHealth(request);
	const reference = state?.actionId === running.actionId ? state.health : running.startHealth ?? health;
	const cut = { interruption, absorbed: false, cut: { actionId: running.actionId, health } };
	if (steerInterruption(request, false) === 'danger') return cut;
	// Standing in lava or fire, or burning, is never the fight's business, whatever trigger carried it.
	const player = (request?.nativeEvent?.observation ?? request?.observation)?.player ?? {};
	if (player.inLava === true || player.onFire === true || player.hazard != null) return cut;
	const bands = fightSteerBands(running);
	const band = (value) => bands.filter(threshold => value <= threshold).length;
	if (health === null || reference == null || band(health) > band(reference)) return cut;
	const { attackers, types, identitiesComplete } = steerAttackers(request);
	if (types.size === 0) return cut;
	const args = running.arguments ?? {};
	// A fight that follows through on attackers handles any hostile mob attacker itself; players stay the model's call.
	const takesAttackers = running.actionType === 'fight_target' && (args.continueWithAttackers === true
		|| ['nearest_attacker', 'highest_risk'].includes(args.targetPolicy));
	const mob = (type) => typeof type === 'string' && type !== 'minecraft:player';
	const covered = [...types].every(mob) && (takesAttackers
		|| (running.actionType === 'fight_until'
			? [...types].every(type => args.mob === type || args.mob === type.replace(/^minecraft:/, ''))
			: identitiesComplete && typeof args.targetId === 'string' && args.targetId.length > 0
				&& attackers.every(attacker => attacker.uuid === args.targetId)));
	if (!covered) return cut;
	return { interruption: null, absorbed: true, cut: null };
}
// Sent only on lava or fire-block contact, in place of the generic event line.
export const HAZARD_CONTACT_INSTRUCTION = 'Live Minecraft event: lava/fire contact. Move horizontally out now, holding jump toward higher exits (player.exits up1). Jump alone may leave you in lava. Lava costs ~8 HP/s; burn continues after exit. Escape before food or guards.';
// A fire block (a blaze fireball leaves one where it lands) is not lava: no jump or swim, and staying adds burn time.
export const FIRE_CONTACT_INSTRUCTION = 'Live Minecraft event: standing in fire. It re-ignites you each tick; the burn grows while you stay. Step to a fire-free cell (harm.exits); breaking the fire block also puts it out. Burn continues after exit. Escape before food or guards.';
export const BURNING_INSTRUCTION = 'Live Minecraft event: burn continues after exit. Move clear of nearby fire/lava first. Water/rain extinguish; fire resistance blocks damage. Burn time unknown; food in healing.';
export const DANGER_DECISION_TRIGGERS = new Set(['damage', 'threat', 'lava', LAVA_FLOW_TRIGGER, 'fire', 'suffocation', 'fall', 'drowning', 'cloud', 'projectile', 'defensive_handler_completed']);
const at = (cell) => [cell?.x, cell?.y, cell?.z].every(Number.isFinite) ? `${cell.x},${cell.y},${cell.z}` : null;
// The threat line names what a player could do with what the body carries, in no preferred order. d41 deck c4/c5:
// the line listed melee, flight and cover but never the bow, and the model never drew a carried bow from inside a shelter.
const RANGED_AMMO = new Set(['minecraft:arrow', 'minecraft:spectral_arrow', 'minecraft:tipped_arrow']);
// Mobs that shoot from range; a shield raised toward them blocks the shot.
const RANGED_MOBS = new Set(['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged', 'minecraft:pillager', 'minecraft:blaze']);
/** A shield in either hand of the shown inventory. */
function shieldHeld(observation) {
	const items = observation?.continuity?.rememberedSections?.includes('inventory') ? null : observation?.inventory?.items;
	return Array.isArray(items) && items.some(e => e?.count > 0 && e.itemId === 'minecraft:shield' && (e.slot === 'offhand' || e.slot === 'mainhand'));
}
export function carriedCombatOptions(observation) {
	const items = observation?.continuity?.rememberedSections?.includes('inventory') || !Array.isArray(observation?.inventory?.items) ? null
		: observation.inventory.items.filter(e => e?.count > 0);
	const count = test => (items ?? []).filter(e => test(e.itemId)).reduce((sum, e) => sum + e.count, 0);
	// Vanilla: a crossbow draws arrows from anywhere in the inventory but loads rockets only from either hand; a shield blocks from either hand.
	const inHand = e => e.slot === 'mainhand' || e.slot === 'offhand';
	const arrows = count(id => RANGED_AMMO.has(id)), rockets = (items ?? []).filter(e => inHand(e) && e.itemId === 'minecraft:firework_rocket').reduce((sum, e) => sum + e.count, 0);
	const ranged = items === null ? ['use_ranged (needs a bow or crossbow and ammunition; inventory not shown)']
		: [...(count(id => id === 'minecraft:bow') && arrows ? [`use_ranged (bow, ${arrows} arrows)`] : []),
			...(count(id => id === 'minecraft:crossbow') && arrows + rockets ? [`use_ranged (crossbow, ${[arrows ? `${arrows} arrows` : '', rockets ? `${rockets} rockets` : ''].filter(Boolean).join(', ')})`] : [])];
	const shield = ['offhand', 'mainhand'].map(slot => (items ?? []).find(e => e.slot === slot && e.itemId === 'minecraft:shield')).find(Boolean);
	return ['fight_target (melee)', ...ranged, ...(shield ? [`block_with_shield (${shield.slot === 'offhand' ? 'offhand' : 'main-hand'} shield)`] : []), 'flee_from', 'supported cover placement', 'do_step escape (cover from shooters, out of water or a hole; hands back once safe)',
		'digging in (a 1x1 hole 2 deep with one block over it is fully enclosed; dirt breaks by hand in under 1 s)'].join(', ');
}
// A fresh context or unrelated event can carry an already unsafe body without a new danger edge.
export function survivalFactLine(observation, { newContext = false } = {}) {
	const { player = {}, world = {} } = visibleObservation(observation);
	if (player.dead === true || player.health <= 0 || ['creative', 'spectator'].includes(player.gameMode)) return null;
	if (player.suffocating === true) return dangerFactLine('suffocation', player);
	if (player.underWater === true && player.airSecondsLeft <= 7.5) return dangerFactLine('drowning', player);
	const threats = asArray(player.threats);
	const creeper = threats.find(threat => threat.type === 'minecraft:creeper' && (threat.swelling === true || threat.signals?.some(signal => ['creeper_close', 'imminent'].includes(signal))));
	if (creeper) return `Live Minecraft event: creeper ${creeper.uuid} ${creeper.distance}m away${creeper.swelling === true ? ', swelling' : ''}. Choose flee_from now, including during a fight with another mob. Replace the active action with your escape if needed; fighting the other target does not handle this explosion. Use observed footing; the escape call can carry reflexes for the rest of the encounter.`;
	if (observation.currentAction?.active !== true && observation.lastResult?.reasonCode === 'LOW_HEALTH_BAILOUT') return 'Live Minecraft event: combat stopped at your bailout health; read the receipt for the bounded retreat outcome or why no retreat was attempted. Repeating the same threshold cannot attack while health remains below it. Choose flee_from, reachable cover, digging in (a 1x1 hole 2 deep with one block over it is fully enclosed; dirt breaks by hand in under 1 s) or a shield now, then heal once clear. Use fresh attacker UUIDs; do not resume exposed work.';
	if (threats.some(threat => threat.targeting === true || threat.swelling === true || threat.signals?.includes('attacked') || threat.signals?.includes('imminent') || threat.signals?.includes('creeper_close'))) {
		if (lowEligibleBody(player, 10, 0.5)) {
			// A shooter is answered by the shield a player already holds: 2 of 3 skeleton deaths on 19 Nov came with the
			// shield lines offering only flight, cover or a hole.
			// ranged_sight is only a line of sight; aiming, targeting or a hit means it is after this body.
			const engaged = threat => threat.targeting === true || threat.signals?.some(signal => ['attacked', 'ranged_aiming'].includes(signal));
			const shooter = shieldHeld(observation) ? threats.find(threat => engaged(threat) && (RANGED_MOBS.has(threat.type) || /(^|:)(bow|crossbow)$/.test(threat.holding ?? ''))) : undefined;
			const shield = shooter ? `, or block_with_shield facing the ${String(shooter.type).replace(/^minecraft:/, '')} ${shooter.uuid ?? ''} (a raised shield stops its shots from the front) and fight_target it once in reach`.replace(/ {2,}/g, ' ') : '';
			return `Live Minecraft event: nearby attacker and low health. Choose flee_from, reachable cover or digging in (a 1x1 hole 2 deep with one block over it is fully enclosed; dirt breaks by hand in under 1 s)${shield} now; break contact before eating. At fleeAtHealth, a pursuing fight attempts a bounded retreat; read its actual outcome. Use player.threats UUIDs and observed footing.${edgeNote(player)}`;
		}
		const calm = asArray(observation.entities).filter(entity => ['minecraft:piglin', 'minecraft:zombified_piglin'].includes(entity.type) && entity.hostile === false && entity.targetingAgent !== true && entity.alive !== false && entity.distance <= 4);
		if (calm.some(entity => entity.type === 'minecraft:piglin')) return `Live Minecraft event: nearby attacker beside a calm piglin. Sword sweeps can provoke its group despite worn gold. Choose separation or cover now, or a held axe with attack when in reach; fight_target selects its own hotbar weapon. Use the hostile target UUID, not the calm piglin.${edgeNote(player)}`;
		// Run d9-nether-e: a fight_target sweep at a blaze hurt a calm zombified piglin 1.3 m away; it killed the agent 13 s later.
		if (calm.length) return `Live Minecraft event: nearby attacker beside a calm zombified piglin ${Math.round(Math.min(...calm.map(entity => entity.distance)) * 10) / 10}m away. A sword sweep or stray hit makes it and every zombified piglin within 35 blocks hostile. Choose separation or cover now, or a held axe with attack when in reach; fight_target selects its own hotbar weapon. Use the hostile target UUID, not the calm one.${edgeNote(player)}`;
		return `Live Minecraft event: nearby threat (player.threats). Options with current gear and footing, in no order: ${carriedCombatOptions(observation)}. After blocked flight or a failed cover search, build cover or open a different exit before exposed work. Flee creepers; break contact at low health before eating. Use the reported target UUID. That call can carry reflexes for the next shots, burning or low health.${edgeNote(player)}`;
	}
	if (player.inWater === true && player.underWater === false && player.onGround === false && player.passenger !== true) {
		return 'Live Minecraft event: eyes above water, body still afloat without footing. Released input sinks. do_step escape swims to the nearest bank and steps out; or choose a reachable shore/air pocket from observed terrain. Guard deletion cancels its current swim or float input; replace it with your next water action before doing stationary work.';
	}
	if (Number.isFinite(player.foodLevel) && player.foodLevel <= 6) return 'Live Minecraft event: low food; sprint is unavailable at 6 or below and regeneration needs 18+. Once clear of immediate danger eat carried food, or obtain visible food if empty. healing.options and player.bestFood give the available calls and slots; choose the food action now.';
	if (lowEligibleBody(player, 8, 0.4) && Number.isFinite(player.foodLevel) && player.foodLevel < 18) return `Live Minecraft event: low health. Food ${player.foodLevel}/20 cannot regenerate health. Eat carried food or obtain a visible food source before routine work; regeneration needs 18+. Use healing.options and current footing for the first food step.`;
	if (lowEligibleBody(player, 8, 0.4)) return 'Live Minecraft event: low health. Choose safe recovery before exposed travel or combat. Food 18+ permits regeneration; at full food ordinary eating cannot start. Eat if needed, retreat to cover or do safe nearby work while healing. Reuse these fresh facts for your first action.';
	if (!newContext && world.dayPhase === 'sunset' && player.skyOpen === true) return 'Live Minecraft event: sunset under open sky. Account for night before exposed travel: choose nearby shelter, light, sleep or defensible local work according to gear and food. Take the chosen preparation action from these fresh facts.';
	return null;
}
/**
 * A11: drowning, cloud and projectile wakes read "Update; answer program decisions." with the danger only in JSON.
 * The lead line states the one fact each needs (time left, where it ends, what hits when); the model picks the response.
 */
export function dangerFactLine(trigger, player) {
	if (player == null || typeof player !== 'object') return null;
	if (trigger === 'suffocation' && player.suffocating === true) {
		return 'Live Minecraft event: suffocating inside a solid block. Break the observed block at your head or open a reachable side exit now; sand/gravel can refill the shaft. Stop pillaring. If a program owns the body, cancelProgram with its current handle, then escape; repeated damage can stale a replace decision. Full food does not remove the obstruction.';
	}
	if (trigger === 'fall') {
		if (player.onGround === false && player.fallDistance > 0 && player.harm?.source === 'minecraft:fell_out_of_world') return `Live Minecraft event: falling into the void, ${player.fallDistance} blocks so far: nothing is below to the world's bottom, so no landing or water bucket stops it. An ender pearl thrown onto ground you saw is the only way back.`;
		if (player.onGround === false && player.fallDistance > 0) return `Live Minecraft event: already falling ${player.fallDistance} blocks${Number.isFinite(player.fallDamage) ? `; current fall damage estimate ${player.fallDamage} HP` : ''}. Released input or sneak cannot undo a fall. Choose reachable water or a carried water bucket landing if feasible; do not jump forward again. Prevention requires verified footing before leaving the edge.`;
		if (player.dropAhead) return 'Live Minecraft event: drop ahead on your movement heading. Choose to stop forward/jump input before the edge, then a supported route or place a step from safe footing. Unknown depth is not a safe short drop. Sneak protects grounded edges, not airborne landings.';
	}
	if (trigger === 'drowning') {
		const air = Number.isFinite(player.airSecondsLeft) ? ` ${player.airSecondsLeft}s air left;` : '';
		const breath = player.breathable, cell = at(breath);
		return `Live Minecraft event: drowning.${air}${cell === null ? ' No breathable cell seen.' : ` Breathable ${cell}${Number.isFinite(breath.distance) ? ` ${breath.distance}m` : ''}${typeof breath.direction === 'string' ? ` ${breath.direction}` : ''}.`} Surfacing alone does not advance a route. do_step escape (stops the running step) swims to air and out onto dry footing, then hands back; or choose moveTo travel or an air pocket (doors create air).`;
	}
	if (trigger === 'cloud') {
		const cloud = (Array.isArray(player.clouds) ? player.clouds : []).find(row => row?.harmful === true);
		if (cloud === undefined) return null;
		const rate = Number.isFinite(player.harm?.hpLossPerSecond) ? ` ${player.harm.hpLossPerSecond} HP/s;` : '';
		const exit = at(cloud.nearestExit);
		return `Live Minecraft event: harmful cloud${cloud.contact === true ? ' contact' : ''}.${rate}${exit === null ? ' Exit unseen.' : ` Nearest exit ${exit}.`}${edgeNote(player)}`;
	}
	if (trigger === 'projectile') {
		const flight = (Array.isArray(player.incomingProjectiles) ? player.incomingProjectiles : []).find(row => row?.damaging !== false);
		if (flight === undefined || typeof flight.type !== 'string') return null;
		return `Live Minecraft event: incoming ${flight.type.replace(/^minecraft:/, '')}${Number.isFinite(flight.etaSeconds) ? ` hits in ${flight.etaSeconds}s` : ''}${Number.isFinite(flight.bearing) ? `, bearing ${flight.bearing}` : ''}.${edgeNote(player)}`;
	}
	return null;
}
// A dodge or a fight is chosen from the danger line alone; the edge beside the body is what turns a hit into a fall.
// LivingEntity.knockback(0.4): about 0.4 blocks/tick away from the hitter and 0.4 up, so the body leaves the ground
// (sneak's edge stop only holds a grounded body) and carries about 3 blocks. Fall damage is the drop minus 3, unarmoured.
export function edgeNote(player) {
	return dropNote(player) + standNote(player);
}
function dropNote(player) {
	const footing = player?.footing;
	// A drop within knockback reach but not beside the feet carries its distance.
	const where = Number.isFinite(footing?.distance) && footing.distance > 0 ? `${footing.distance} blocks from you` : 'beside you';
	if (footing?.into === 'void' && Number.isFinite(footing.yaw)) return ` Void edge ${where} at yaw ${footing.yaw}.`;
	if (Number.isFinite(footing?.drop) && footing.drop >= 4 && footing.into !== 'water' && Number.isFinite(footing.yaw)) {
		const plus = footing.atLeast === true ? '+' : '';
		const landing = footing.into === 'lava' ? ' into lava' : `, a fall costs ~${footing.drop - 3}${plus} HP${Number.isFinite(player.health) ? ` of your ${Math.round(player.health)}` : ''}`;
		return ` Open drop ${footing.drop}${plus} blocks ${where} at yaw ${footing.yaw}${landing}. A hit knocks you about 3 blocks away from the hitter, airborne, so sneaking does not hold the edge; a solid block on that side stops the push.`;
	}
	if (player?.dropAhead?.into === 'void' && Number.isFinite(player.dropAhead.at)) return ` Void ${player.dropAhead.at} blocks ahead.`;
	return '';
}
// Shooters whose volleys a roof and walls stop; a covered stand is news only against them or off a push-safe cell.
const RANGED_THREAT = /^minecraft:(blaze|ghast|skeleton|stray|bogged|pillager|piglin)$/;
/**
 * FightingPosition (mod): the nearest seen cell with no open drop within a hit's push, and the nearest such cell with a
 * roof and 2+ full-block walls. Runs d9-nether-d, d11-nether-a/g were knocked off fortress bridges (one at full health)
 * and every blaze death of 2026-10-21 was spent placing cover one block per turn in the open.
 */
export function standNote(player) {
	const stand = player?.stand;
	if (stand == null || typeof stand !== 'object' || stand.here == null) return '';
	const cell = row => `${row.x},${row.y},${row.z}, ${row.steps} step${row.steps === 1 ? '' : 's'}`;
	const walls = row => `${row.roof ? 'roof' : 'no roof'}, ${row.walls} wall${row.walls === 1 ? '' : 's'}${row.open ? `, open ${row.open}` : ''}`;
	const ranged = asArray(player.threats).some(threat => RANGED_THREAT.test(threat?.type ?? ''));
	const parts = [];
	if (stand.here.pushSafe !== true) {
		parts.push(stand.pushSafe ? `Nearest push-safe stand (no open drop within 3 blocks): ${cell(stand.pushSafe)} (${walls(stand.pushSafe)}).`
			: `No push-safe stand within ${stand.searchedSteps ?? 12} steps of seen footing.`);
	}
	if (stand.covered && (ranged || stand.here.pushSafe !== true) && !(stand.pushSafe && stand.pushSafe.x === stand.covered.x && stand.pushSafe.y === stand.covered.y && stand.pushSafe.z === stand.covered.z)) {
		parts.push(`Nearest roofed push-safe stand: ${cell(stand.covered)} (${walls(stand.covered)}); shots reach it only through open sides.`);
	}
	return parts.length ? ` ${parts.join(' ')}` : '';
}
export function dangerDecisionInstruction(trigger) {
	if (trigger === 'threat') {
		return 'Live Minecraft event: threat, see player.threats. fight_target and flee_from work while the program awaits you.';
	}
	if (trigger === 'suffocation') return 'Live Minecraft event: suffocation. Facts below are fresh; the program awaits your reply.';
	if (trigger === 'fall') return 'Live Minecraft event: fall danger. Facts below are fresh; the program awaits your reply.';
	if (trigger === 'defensive_handler_completed') return 'Live Minecraft event: defensive handler finished; result and fresh facts below. The program awaits your reply.';
	return 'Live Minecraft event: danger. Facts below are fresh; the program awaits your reply.';
}
// Berries are picked by right-click, as in vanilla.
export const FOOD_BERRY_BLOCKS = Object.freeze(['minecraft:sweet_berry_bush', 'minecraft:cave_vines', 'minecraft:cave_vines_plant']);
export function isConfirmationContextTool(tool) {
	return isSelfPreservationTool(tool)
		|| ['query_memory', 'program_status'].includes(tool.kind)
		|| (tool.kind === 'task_plan' && tool.operation === 'read')
		|| (tool.kind === 'task_memory' && tool.operation === 'query')
		|| (tool.kind === 'action' && tool.actionType === 'chat');
}

// Passive animals that drop food, and dropped items worth picking up to eat.
const FOOD_ANIMALS = new Set(['minecraft:cow', 'minecraft:mooshroom', 'minecraft:pig', 'minecraft:sheep', 'minecraft:chicken', 'minecraft:rabbit',
	'minecraft:cod', 'minecraft:salmon', 'minecraft:hoglin']);
const FOOD_ITEM = /^minecraft:(?:cooked_)?(?:beef|porkchop|mutton|chicken|rabbit|cod|salmon)$|^minecraft:(?:apple|golden_apple|enchanted_golden_apple|bread|carrot|golden_carrot|potato|baked_potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|mushroom_stew|rabbit_stew|beetroot_soup|dried_kelp)$/;
const RIPE_AGE = { 'minecraft:wheat': 7, 'minecraft:carrots': 7, 'minecraft:potatoes': 7, 'minecraft:beetroots': 3, 'minecraft:sweet_berry_bush': 2 };
const LOW_HEALTH_FRACTION = 0.5;
const LOW_HEALTH_POINTS = 6;
const RECOVERED_FRACTION = 0.7;
// Starving on Hard drains one point at a time; only a real further drop wakes again.
const FURTHER_DROP_POINTS = 2;
// With a task, low health and food in reach gets one urgent nudge at 4 hearts (or 40%), then again only after 2+ more
// health is lost or new food comes into reach, never more often than every 10 s.
const HEAL_NUDGE_POINTS = 8;
const HEAL_NUDGE_FRACTION = 0.4;
// Low-health wakes obtain's own recovery answers (see the fold at the step-fold point).
export const LOW_HEALTH_RECOVERY_TRIGGERS = new Set(['low_health_food', 'low_health']);
const HEAL_NUDGE_INTERVAL_MS = 10_000;
const MAX_SEEN_FOOD = 64;
// Events that carry healing facts (and options) even when the caller passed none.
export const HEALING_EVENT_TRIGGERS = new Set(['low_health_food', 'low_health_idle', 'heal_opportunity', 'low_health', 'fire', 'lava']);

/**
 * Whether low health should wake an agent with no task, and the health level to remember. One wake per level: it
 * rearms only after the agent recovers to 70% or loses 2+ more health. Takeover, creative/spectator and death never
 * wake, nor does a body that is already regenerating (food bar 18+) with no food carried or in view to add.
 * `health: null` clears the memory.
 */
export function lowHealthWake(observation, wokenAtHealth = null) {
	const player = observation?.player;
	const health = Number.isFinite(player?.health) ? player.health : null;
	if (health === null || player.dead === true || health <= 0) return { wake: false, health: wokenAtHealth };
	const maxHealth = Number.isFinite(player.maxHealth) && player.maxHealth > 0 ? player.maxHealth : 20;
	if (health >= maxHealth * RECOVERED_FRACTION) return { wake: false, health: null };
	const low = health <= Math.max(LOW_HEALTH_POINTS, maxHealth * LOW_HEALTH_FRACTION);
	if (!low || player.operatorControlled === true || ['creative', 'spectator'].includes(player.gameMode)) return { wake: false, health: wokenAtHealth };
	if (wokenAtHealth !== null && health > wokenAtHealth - FURTHER_DROP_POINTS) return { wake: false, health: wokenAtHealth };
	const facts = healingFacts(observation);
	const nothingToEat = facts.bestFood === null && Object.values(facts.foodSources).every((rows) => rows.length === 0);
	if (nothingToEat && facts.naturalRegen === true) return { wake: false, health: wokenAtHealth };
	return { wake: true, health };
}

/** A low body that is ours to wake: alive, survival or adventure, not taken over, at or below the given level. */
export function lowEligibleBody(player, points, fraction) {
	const health = Number.isFinite(player?.health) ? player.health : null;
	if (health === null || player.dead === true || health <= 0 || player.operatorControlled === true || ['creative', 'spectator'].includes(player.gameMode)) return false;
	const maxHealth = Number.isFinite(player.maxHealth) && player.maxHealth > 0 ? player.maxHealth : 20;
	return health <= Math.max(points, maxHealth * fraction);
}

/** Stable keys of the food in reach: carried best food, then drops, animals and ripe plants in view. */
export function foodSourceKeys(facts) {
	const sources = facts?.foodSources ?? {};
	return [
		...(carriedFoodToEat(facts)?.itemId ? [`carried:${carriedFoodToEat(facts).itemId}`] : []),
		...(sources.drops ?? []).map((drop) => `drop:${drop.stableId}`),
		...(sources.animals ?? []).map((animal) => `animal:${animal.stableId}`),
		...(sources.plants ?? []).filter((plant) => plant.ripe !== false).map((plant) => `plant:${plant.x},${plant.y},${plant.z}`),
	];
}

function canEatNow(facts) {
	return !(Number.isFinite(facts?.foodLevel) && facts.foodLevel >= 20) || facts?.canEat === true;
}

function rememberFood(seen, keys) {
	return [...new Set([...seen, ...keys])].slice(-MAX_SEEN_FOOD);
}

/**
 * The no-task heal wake (lowHealthWake) plus food that comes into reach after it: a drop thrown to the agent or an
 * animal walking up is a chance the model has not seen yet, so it wakes once more for each new source while still low.
 * `latch` is { health, seenFood } or null; the result's latch is null once the body recovered.
 */
export function healWakeVerdict(observation, latch = null) {
	const verdict = lowHealthWake(observation, latch?.health ?? null);
	if (verdict.health === null) return { wake: false, latch: null };
	const facts = healingFacts(observation);
	const keys = foodSourceKeys(facts);
	const seen = latch?.seenFood ?? [];
	const fresh = keys.some((key) => !seen.includes(key));
	const wake = verdict.wake || (latch !== null && fresh && canEatNow(facts) && lowEligibleBody(observation.player, LOW_HEALTH_POINTS, LOW_HEALTH_FRACTION));
	return { wake, latch: { health: verdict.health, seenFood: rememberFood(seen, keys) } };
}

/**
 * With a task: whether low health with reachable food should raise one urgent attention edge. Fires at 4 hearts
 * (or 40%) while safe and able to eat, then again only after 2+ more health is lost or new food comes into reach,
 * at most every 10 s; recovering to 70% resets it. `latch` is { health, seenFood, atMs } or null.
 */
export function healNudgeVerdict(observation, latch = null, nowMs = null) {
	const player = observation?.player ?? {};
	const maxHealth = Number.isFinite(player.maxHealth) && player.maxHealth > 0 ? player.maxHealth : 20;
	if (Number.isFinite(player.health) && player.health >= maxHealth * RECOVERED_FRACTION) return { nudge: false, latch: null };
	if (!lowEligibleBody(player, HEAL_NUDGE_POINTS, HEAL_NUDGE_FRACTION) || player.safe === false) return { nudge: false, latch };
	const facts = healingFacts(observation);
	const keys = foodSourceKeys(facts);
	if (keys.length === 0 || !canEatNow(facts)) return { nudge: false, latch };
	// Only food that changes what the agent can eat right now repeats the nudge: carried food or a new drop. Animals
	// and crops passing by while walking are already in the first nudge's options and would repeat it every 10 s.
	const ownKeys = keys.filter((key) => key.startsWith('carried:') || key.startsWith('drop:'));
	const seen = latch?.seenFood ?? [];
	const lower = latch === null || player.health <= latch.health - FURTHER_DROP_POINTS;
	const fresh = ownKeys.some((key) => !seen.includes(key));
	const spaced = latch === null || !Number.isFinite(nowMs) || !Number.isFinite(latch.atMs) || nowMs - latch.atMs >= HEAL_NUDGE_INTERVAL_MS;
	if (!(lower || fresh) || !spaced) return { nudge: false, latch: latch === null ? null : { ...latch, seenFood: rememberFood(seen, ownKeys) } };
	return { nudge: true, options: facts.options.length, latch: { health: player.health, seenFood: rememberFood(seen, ownKeys), atMs: nowMs } };
}

/**
 * Concrete ways to get food now, nearest first, as the native calls that do it. They are facts about reach, not a plan:
 * the model chooses whether and which.
 */
export function healingOptions(facts) {
	const options = [];
	const away = (distance) => (Number.isFinite(distance) ? ` ${distance} blocks away` : '');
	const carried = carriedFoodToEat(facts);
	// The same calls obtain's recovery makes (fork-rule.mjs eatCalls): the one eat path.
	// use_item's optional expectedItemId is left out of the text (the item is named once already); select_tool needs its own.
	const calls = carried ? eatCalls(carried) : null;
	if (calls) options.push(`eat carried ${carried.itemId}: ${calls.map(({ actionType, arguments: args }) => `${actionType} ${Object.entries(args)
		.filter(([key]) => actionType !== 'use_item' || key !== 'expectedItemId').map(([key, value]) => `${key}:${value}`).join(',')}`).join(', then ')}`);
	for (const drop of facts.foodSources.drops.slice(0, 2)) options.push(`pick up ${drop.count ?? 1}x ${drop.itemId}${away(drop.distance)}: pick_up_item targetSelector ${drop.stableId}, then eat it`);
	for (const animal of facts.foodSources.animals.slice(0, 1)) options.push(`hunt ${animal.type}${away(animal.distance)}: fight_target targetId ${animal.stableId}, pick_up_item its drop, eat it`);
	for (const plant of facts.foodSources.plants.filter((row) => row.ripe !== false).slice(0, 1)) {
		options.push(`harvest ${plant.blockId} at ${plant.x},${plant.y},${plant.z}${away(plant.distance)}: ${plant.harvest === 'interact' ? 'interact_block' : 'break_block'}, pick up, eat`);
	}
	return options;
}

/**
 * Reference to the approaching threat that reaches contact range soonest. Its ETA and risks remain in player.threats.
 * Null when nothing approaches.
 */
export function threatOutlook(observation) {
	const threats = Array.isArray(observation?.player?.threats) ? observation.player.threats : [];
	const soonest = threats.filter((threat) => threat?.approaching === true && Number.isFinite(threat.etaSeconds))
		.sort((left, right) => left.etaSeconds - right.etaSeconds)[0];
	if (soonest === undefined) return null;
	if (typeof soonest.uuid === 'string' && soonest.uuid.length > 0) return { soonestContact: soonest.uuid };
	const then = Number.isFinite(soonest.contactRisk) ? `, about ${soonest.contactRisk} there` : '';
	return `${soonest.type} ${soonest.uuid} is ${soonest.distance} blocks away closing at ${soonest.closingSpeed} blocks/s: contact range in ${soonest.etaSeconds} s (risk ${soonest.risk} now${then}).`;
}

// Upper bound at the current food/saturation, not promised recovery: saturation is spent by healing and damage can
// outpace it. Peaceful has an additional player regeneration path, so leave that rate unknown here.
function regenerationRateMax(player, world) {
	const enabled = naturalRegeneration(player, world);
	if (enabled === false) return 0;
	if (enabled === null || world?.difficulty === 'peaceful') return null;
	if (player.foodLevel < 20) return 0.25;
	if (!Number.isFinite(player.saturation)) return null;
	return player.saturation > 0 ? Math.ceil(Math.min(player.saturation, 6) / 3 * 1000) / 1000 : 0.25;
}

export function compactHealingForEvent(source, hazardContact) {
	if (source == null) return source;
	if (hazardContact) {
		const { foodLevel, saturation, naturalRegen, bestFood, healFood, burn, canEat } = source;
		return { foodLevel, saturation, naturalRegen, bestFood, ...(healFood === undefined ? {} : { healFood }), burn, canEat };
	}
	const { foodSources, options, ...facts } = source;
	return { ...facts,
		...(foodSources && Object.values(foodSources).some(rows => rows.length > 0) ? { foodSources } : {}),
		...(hazardContact || options === undefined ? {} : { options }),
	};
}

/** The facts a no-task low-health turn needs: health, hunger, carried food and the nearest food sources in view. */
export function healingFacts(observation) {
	const player = observation?.player ?? {};
	const list = (value) => (Array.isArray(value) ? value : []);
	const at = (row) => (['x', 'y', 'z'].every((axis) => Number.isFinite(row?.[axis]) && Number.isFinite(player[axis]))
		? Math.round(Math.hypot(row.x - player.x, row.y - player.y, row.z - player.z) * 10) / 10 : null);
	const nearest = (rows, limit) => rows.map(({ source, ...row }) => ({ ...row, distance: Number.isFinite(source?.distance) ? source.distance : at(source) }))
		.sort((left, right) => (left.distance ?? Infinity) - (right.distance ?? Infinity)).slice(0, limit);
	const animals = list(observation?.entities).filter((entity) => FOOD_ANIMALS.has(entity?.type) && entity.alive !== false)
		.map((entity) => ({ stableId: entity.stableId, type: entity.type, source: entity }));
	const plants = list(observation?.blocks).filter((block) => FOOD_PLANT_BLOCKS.includes(block?.blockId) || FOOD_BERRY_BLOCKS.includes(block?.blockId)).map((block) => {
		const age = Number(block.state?.age);
		const ripe = block.blockId in RIPE_AGE ? (Number.isFinite(age) ? age >= RIPE_AGE[block.blockId] : null)
			: block.blockId.startsWith('minecraft:cave_vines') ? (block.state?.berries === undefined ? null : String(block.state.berries) === 'true') : true;
		return { x: block.x, y: block.y, z: block.z, blockId: block.blockId, harvest: FOOD_BERRY_BLOCKS.includes(block.blockId) ? 'interact' : 'mine', ...(ripe === null ? {} : { ripe }), source: block };
	});
	const drops = list(observation?.items).filter((item) => FOOD_ITEM.test(item?.itemId ?? ''))
		.map((item) => ({ stableId: item.stableId, itemId: item.itemId, count: item.count, source: item }));
	const facts = {
		health: player.health ?? null, maxHealth: player.maxHealth ?? 20, foodLevel: player.foodLevel ?? null, saturation: player.saturation ?? null,
		naturalRegen: naturalRegeneration(player, observation?.world),
		regenHPPerSecondMax: regenerationRateMax(player, observation?.world),
		canEat: typeof player.canEat === 'boolean' ? player.canEat : !player.bestFood ? false : player.bestFood.alwaysEdible === true ? true
			: Number.isFinite(player.foodLevel) ? player.foodLevel < 20 : null,
		bestFood: player.bestFood ?? null, ...(player.healFood ? { healFood: player.healFood } : {}),
		safe: player.safe ?? null, threats: list(player.threats).length,
		foodSources: { animals: nearest(animals, 4), plants: nearest(plants, 4), drops: nearest(drops, 4) },
	};
	const burn = burnFacts(player);
	return { ...facts, ...(burn === null ? {} : { burn }), options: healingOptions(facts) };
}

/**
 * Burn left and its raw cost: on_fire deals 1 HP each second through armour (Resistance and Fire Protection still
 * reduce it; lava itself hurts about 8 HP/s while the body stays in it). Null when not burning.
 */
export function burnFacts(player) {
	if (!(Number.isFinite(player?.fireTicks) && player.fireTicks > 0)) return null;
	const seconds = Math.ceil(player.fireTicks / 20);
	const resistance = Array.isArray(player.effects) ? player.effects.find((effect) => effect?.effectId === 'minecraft:fire_resistance') : null;
	const protectedTicks = resistance == null ? 0 : Number.isFinite(resistance.duration) && resistance.duration >= 0 ? resistance.duration : Infinity;
	return { seconds, rawDamage: Math.floor(Math.max(0, player.fireTicks - protectedTicks) / 20) };
}
/** Code and bounded reason of a rejected input, for its trace row. */
export function rejectionTraceFields(error, fallbackCode) {
	return { code: sanitizeDiagnosticErrorCode(error, { fallback: fallbackCode }), reason: sanitizeDiagnosticErrorMessage(error, { maxBytes: 512 }) };
}

export const NO_TASK_HEAL_INSTRUCTION = 'Live Minecraft event: low health. You have no active task; any finished task stays finished, so do not redo it. Recovering is your call. healing.regenFoodReady reports hunger eligibility under vanilla rules; damage may outpace recovery. healing.options lists the food in reach as exact calls: eat carried food, pick_up_item a food drop, fight_target a passive animal and pick up its drop, mine fully grown crops or melon, or interact with ripe berries; then eat. Other work is a player request and needs takeTask.';
export const TASK_HEAL_INSTRUCTION = 'Live Minecraft event: low health with food in reach. Whether to recover before continuing the task is your call. healing.regenFoodReady reports hunger eligibility under vanilla rules; damage may outpace recovery. healing.options lists the food in reach as exact calls (eat carried food; pick_up_item a food drop; fight_target a passive animal and pick up its drop). Respond explicitly to pending program decisions.';
export const NO_TASK_DANGER_INSTRUCTION = 'Live Minecraft event: danger. You have no active task; any finished task stays finished, so do not redo it. Options include: fight_target, flee_from, eat or drink, shield or totem, equip armor and weapons, move away. Other work is a player request and needs takeTask.';
// Waiting for the operator only means "do not redo the finished work or re-run finish"; it never blocks new requests.
export const AWAITING_CONFIRMATION_EVENT_INSTRUCTION = 'Live Minecraft event. Your finished goal awaits operator confirmation: do not redo it or re-run finish. You still own your body: defend, flee, escape lava/fire, breathe, eat or equip as needed without operator permission; this leaves confirmation pending. Only operator:true direct/voice requests may change work; other messages supply facts or invite replies. After handling a new operator request, call finish again.';
