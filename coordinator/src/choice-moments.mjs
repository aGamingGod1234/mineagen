/**
 * Choice moments (MINEAGEN_CHOICE_TOOL=on; off by default).
 *
 * Decision tests on 190 recorded game moments found the in-game model knows the player-like response (it names it
 * 85-89% of the time when asked) but its tool call follows its running step instead (60%). When it picks the response
 * with one structured call and something else carries it out, 81% of picks are player-like; when it must then make
 * the move itself, only 66% are. So at a flagged moment the wake lists the responses a player weighs, the model answers
 * with choose_response, and the coordinator runs an existing body step for the chosen key. A key with no body step
 * goes back to the model to carry out; a "carry on" key leaves the running step alone.
 */
import { activeContexts, lavaNear } from './danger-contexts.mjs';
import { nextKitStep } from './kit-habit.mjs';

export function choiceToolEnabled(environment = process.env) {
	const value = String(environment?.MINEAGEN_CHOICE_TOOL ?? '').trim().toLowerCase();
	return value === 'on' || value === 'true' || value === '1';
}

/** What a player weighs at each moment. Keys are what choose_response accepts. */
export const CHOICE_MENUS = Object.freeze({
	low_health: { retreat_eat: 'get away from danger and eat or rest to heal', block_in: 'wall yourself in with blocks and heal inside', fight: 'fight whatever is hurting you', keep_working: 'carry on with the current work' },
	threat: { fight: 'fight it', block_shield: 'raise the shield and block, then deal with it', retreat_cover: 'break line of sight, back off, pillar or wall off', ignore: 'ignore it and carry on with the current work' },
	lava_seen: { avoid_block: 'keep clear of it or block it off before going on', use_lava: 'use it: fill a bucket or cast obsidian with water', carry_on: 'carry on with the current work and ignore it' },
	respawned: { recover_items: 'go straight back to the death spot and pick up the dropped items', restart_here: 'start over where you are: wood, tools and food first', shelter_first: 'find or build shelter first, then decide' },
	entered_dim: { scan_secure: 'stand still, look around for hazards, note the portal position and secure the area', head_out: 'head out at once toward the goal', go_back: 'go back through the portal' },
	night_falls: { shelter: 'build a shelter or dig into the ground or a hill and seal it', sleep: 'sleep in a bed', work_surface: 'keep working on the surface', work_underground: 'go or stay underground and keep mining there' },
	cave_seen: { enter_cave: 'go into the cave and scan its walls for ore', own_tunnel: 'keep digging your own tunnel or staircase', elsewhere: 'leave and go somewhere else' },
	kit_gap: { craft_shield: 'craft a shield now (smelting the iron first if it is raw) and put it in the off hand', craft_armour: 'craft iron armour now (chestplate first) and wear it', carry_on: 'carry on with the current work' },
	food_stored: { food_to_hotbar: 'move food into the hotbar so it can be eaten at once', eat_now: 'eat now', get_more_food: 'go and get or cook more food', carry_on: 'carry on with the current work' },
});

export const MOMENT_TEXT = Object.freeze({
	low_health: 'Your health has dropped to 8 or less.', threat: 'A hostile mob has just started targeting you.', lava_seen: 'Lava is close by.',
	respawned: 'You just died and respawned; your items dropped where you died.', entered_dim: 'You just came through a portal into another dimension.',
	night_falls: 'Night has just fallen.', cave_seen: 'You can see a cave opening next to you while you still need ore.',
	kit_gap: 'Your kit is missing a piece you could make from what you carry.', food_stored: 'You carry food, but none of it is in your hotbar.',
});

/** Keys that leave the running step alone. */
const CARRY_ON = new Set(['keep_working', 'ignore', 'carry_on', 'restart_here', 'head_out', 'work_surface', 'work_underground', 'own_tunnel']);
// The same kind is not asked again within this window, so a long fight or a cave in view does not repeat the menu.
// Lava is asked rarely: in the Nether it is in view most of the time. Night is asked once per night (a night is 7 min).
const REPEAT_MS = Object.freeze({ low_health: 20_000, threat: 20_000, lava_seen: 180_000, respawned: 30_000, entered_dim: 30_000, night_falls: 600_000, cave_seen: 120_000, kit_gap: 300_000, food_stored: 300_000 });
// The goal line names the next base resource ("...; next: iron"); a cave matters while that is an ore.
const ORE_NEXT = /\bnext: (?:iron|coal|gold|diamonds?|redstone)\b/;
// A known cave in the task facts: "cave(air 62/125) 12m S dy+12 y42 @8,42,-200". Only one close enough to walk into now.
const CAVE_LEAD = /\bcave\(air \d+\/\d+\) (\d+)m[^;@|]*@(-?\d+),(-?\d+),(-?\d+)/g;
const CAVE_NEAR_BLOCKS = 32;
// Lava only when it is close: in the Nether it is in view most of the time, and the lava reflexes cover contact.
const LAVA_CLOSE_BLOCKS = 4;
// An open offer is answered from the facts of its own moment; after this the moment is over.
const OFFER_TTL_MS = 60_000;

export const CHOOSE_RESPONSE_TOOL = Object.freeze({
	type: 'function', name: 'choose_response',
	description: 'When a wake lists responses for a moment, pick one by its key; the body carries it out at once and reports back.',
	inputSchema: { type: 'object', properties: { choice: { type: 'string', description: 'a key from the listed responses' }, why: { type: 'string' } }, required: ['choice'], additionalProperties: false },
});

/**
 * The live signals a wake shows: the decorated observation, the wake trigger, its change line, the task facts text
 * (options and known sources, where cave leads appear) and the goal line (its "next:" resource).
 */
export function momentSignals({ observation = {}, trigger = null, changed = null, taskFacts = null, goalNow = null } = {}) {
	const player = observation?.player ?? {};
	// Only hostiles that target the player: a mob merely nearby is not this moment.
	const threats = rows(player.threats).filter((t) => t && t.alive !== false && (t.targeting === true || t.targetingAgent === true || (Array.isArray(t.signals) && t.signals.includes('targeting'))));
	const changedText = typeof changed === 'string' ? changed : '';
	const kit = safe(() => nextKitStep(observation));
	const dimension = observation?.world?.dimension ?? observation?.dimension ?? null;
	const overworld = dimension === null || /overworld/.test(String(dimension));
	const cave = overworld && typeof goalNow === 'string' && ORE_NEXT.test(goalNow) && typeof taskFacts === 'string'
		? [...taskFacts.matchAll(CAVE_LEAD)].find((m) => Number(m[1]) <= CAVE_NEAR_BLOCKS) ?? null : null;
	const contexts = safe(() => activeContexts(observation)) ?? new Set();
	return {
		health: Number.isFinite(player.health) ? player.health : null,
		threats,
		// The death screen is not the respawn: only respawn acts while dead, so the choice waits for the living body.
		dead: player.dead === true,
		respawned: /\brespawned\b/.test(changedText) || trigger === 'respawn' || (trigger === 'player_death' && player.dead !== true),
		dimensionChanged: /\bdimension \S+->\S+/.test(changedText) || trigger === 'dimension_changed',
		nightBegan: /\bnight began\b/.test(changedText),
		// Night on the surface only (activeContexts); underground the night changes little.
		nightNow: contexts.has('night'),
		lava: safe(() => lavaNear(observation, LAVA_CLOSE_BLOCKS)) === true,
		foodToHotbar: kit?.kind === 'hotbar' ? kit : null,
		shieldCraft: kit?.kind === 'craft' && kit.itemId === 'minecraft:shield',
		cave: cave ? { x: Number(cave[2]), y: Number(cave[3]), z: Number(cave[4]) } : null,
		lastDeath: observation?.recovery?.lastDeath ?? null,
		dimension,
		position: blockPosition(observation),
		block: buildingBlock(observation),
		facing: facing(player.yaw),
	};
}

/** The one moment kind these signals flag, most urgent first, or null. */
export function flagMoment(s) {
	if (s.dead) return null;
	if (s.respawned) return 'respawned';
	if (s.health !== null && s.health <= 8) return 'low_health';
	if (s.threats.length > 0) return 'threat';
	if (s.dimensionChanged) return 'entered_dim';
	if (s.lava) return 'lava_seen';
	if (s.cave) return 'cave_seen';
	if (s.shieldCraft) return 'kit_gap';
	if (s.foodToHotbar) return 'food_stored';
	if (s.nightBegan || s.nightNow) return 'night_falls';
	return null;
}

/** The wake line for a moment: what happened, the call to make, and the keys with their meanings. */
export function momentLine(kind) {
	const keys = Object.entries(CHOICE_MENUS[kind]).map(([key, meaning]) => `${key} = ${meaning}`).join('; ');
	return `${MOMENT_TEXT[kind]} First call choose_response with what a skilled player would do now; the body carries it out. Responses: ${keys}.`;
}

/** Per agent: which moment was last offered and when each kind was last asked. */
export class ChoiceMoments {
	#now; #agents = new Map();
	constructor({ now = Date.now } = {}) { this.#now = now; }
	/** Flags a moment for this wake, or null (nothing flagged, or the same kind was asked recently). */
	offer(agentId, signals) {
		const kind = flagMoment(signals);
		const agent = this.#agent(agentId);
		if (kind === null) return null;
		const at = this.#now();
		if (at - (agent.asked.get(kind) ?? -Infinity) < REPEAT_MS[kind]) return null;
		agent.asked.set(kind, at);
		agent.offered = { kind, signals, at };
		return { kind, line: momentLine(kind) };
	}
	offered(agentId) {
		const offered = this.#agents.get(agentId)?.offered ?? null;
		return offered !== null && this.#now() - offered.at <= OFFER_TTL_MS ? offered : null;
	}
	clear(agentId) { const agent = this.#agents.get(agentId); if (agent) agent.offered = null; }
	#agent(agentId) {
		if (!this.#agents.has(agentId)) this.#agents.set(agentId, { asked: new Map(), offered: null });
		return this.#agents.get(agentId);
	}
}

/**
 * What the body does for a chosen key: {kind:'carry_on'}, {kind:'call', name, args} (a model-facing tool call the
 * coordinator makes in the model's place), or {kind:'hand_back'} when no body step does it.
 */
export function planChoice(kind, key, s) {
	const menu = CHOICE_MENUS[kind];
	if (!menu || !Object.hasOwn(menu, key)) return { kind: 'invalid' };
	if (CARRY_ON.has(key)) return { kind: 'carry_on' };
	const nearest = [...(s?.threats ?? [])].filter((t) => typeof threatId(t) === 'string').sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
	const act = (actionType, args) => ({ kind: 'call', name: 'act', args: { actionType, arguments: args } });
	const step = (verb, target, why) => ({ kind: 'call', name: 'do_step', args: { verb, target, why } });
	switch (`${kind}.${key}`) {
		case 'threat.retreat_cover': case 'low_health.retreat_eat':
			return nearest ? act('flee_from', { targetId: threatId(nearest), distance: 16, timeoutMs: 10_000 }) : { kind: 'hand_back' };
		case 'threat.fight': case 'low_health.fight':
			return nearest ? act('fight_target', { targetId: threatId(nearest), timeoutMs: 30_000 }) : { kind: 'hand_back' };
		case 'threat.block_shield': return act('block_with_shield', { durationMs: 3000 });
		case 'low_health.block_in': case 'night_falls.shelter': case 'respawned.shelter_first':
			return s?.position && s.block ? step('build_shelter', { ...s.position, opening: s.facing ?? 'north', itemId: s.block, roof: true }, 'Wall in and wait it out safely.') : { kind: 'hand_back' };
		case 'food_stored.food_to_hotbar': {
			const f = s?.foodToHotbar;
			return f ? act('select_tool', { sourceSlot: f.sourceSlot, hotbarSlot: f.hotbarSlot, expectedItemId: f.itemId, minRemainingDurability: 0 }) : { kind: 'hand_back' };
		}
		case 'kit_gap.craft_shield': return step('obtain', { item: 'minecraft:shield' }, 'Make a shield before going on.');
		case 'kit_gap.craft_armour': return step('obtain', { item: 'minecraft:iron_chestplate' }, 'Make iron armour before going on.');
		case 'respawned.recover_items': {
			const d = s?.lastDeath;
			// The recovery record names the death's dimension dimensionId; drops in another dimension go back to the model.
			const died = d?.dimensionId ?? d?.dimension ?? null;
			if (!d || ![d.x, d.y, d.z].every(Number.isFinite) || died === null || (s.dimension !== null && died !== s.dimension)) return { kind: 'hand_back' };
			return step('travel_to', { x: Math.round(d.x), y: Math.round(d.y), z: Math.round(d.z), tolerance: 2 }, 'Go back for the dropped items.');
		}
		case 'cave_seen.enter_cave': {
			const c = s?.cave;
			return c ? step('travel_to', { x: c.x, y: c.y, z: c.z, tolerance: 2, throughCaves: true }, 'Go into the cave and scan its walls for ore.') : { kind: 'hand_back' };
		}
		default: return { kind: 'hand_back' };
	}
}

/**
 * The same plan when a body action is already running (a new action would be refused): urgent moves replace it,
 * moving food waits for it to end, and an obtain (foreground) cancels it first. Returns [plan, cancelFirst].
 */
export function againstRunning(plan, running, goalRevision) {
	if (plan.kind !== 'call' || running == null || typeof running.actionId !== 'string') return { plan, cancel: null };
	const cancel = { name: 'cancelAction', args: { actionId: running.actionId, goalRevision } };
	if (plan.name === 'act' && plan.args.actionType === 'select_tool') return { plan: { ...plan, args: { ...plan.args, after: running.actionId } }, cancel: null };
	if (plan.name === 'act') return { plan: { ...plan, name: 'replaceAction', args: { actionId: running.actionId, goalRevision, ...plan.args } }, cancel: null };
	if (plan.name === 'do_step' && BACKGROUND_VERBS.has(plan.args.verb)) {
		return { plan: { ...plan, name: 'replaceAction', args: { actionId: running.actionId, goalRevision, actionType: plan.args.verb, arguments: plan.args.target } }, cancel: null };
	}
	return { plan, cancel };
}
const BACKGROUND_VERBS = new Set(['travel_to', 'build_shelter']);

/** The choose_response result text the model reads, from what the body did. */
export function choiceResultText(kind, key, plan, body = null) {
	const meaning = CHOICE_MENUS[kind]?.[key];
	if (plan.kind === 'invalid') return `${JSON.stringify(key)} is not a listed response${kind ? ` (keys: ${Object.keys(CHOICE_MENUS[kind]).join(', ')})` : '; no moment is open'}. Carry on with your next call.`;
	if (plan.kind === 'carry_on') return `Chosen: ${meaning}. The running step goes on; make your next call as usual.`;
	if (plan.kind === 'hand_back') return `Chosen: ${meaning}. No body step does this by itself: make the tool call that does it now.`;
	const what = plan.name === 'do_step' ? plan.args.verb : plan.args.actionType;
	const state = body?.state;
	if (body?.executed === false || ['REJECTED', 'FAILED', 'CANCELLED'].includes(state)) {
		return `Chosen: ${meaning}. The body could not do it (${what}: ${String(body?.reasonCode ?? state ?? 'refused')}); make the tool call that does it now.`;
	}
	return `Chosen: ${meaning}. The body ${state === 'SUCCEEDED' ? 'did' : 'started'} ${what} for it.`;
}

function rows(value) {
	if (Array.isArray(value)) return value;
	if (Array.isArray(value?.entries)) return value.entries;
	return [];
}

const BUILDING = /^minecraft:(cobblestone|cobbled_deepslate|dirt|stone|deepslate|netherrack|andesite|diorite|granite|tuff|blackstone|sandstone|[a-z_]+_planks)$/;
function buildingBlock(o) {
	const stacks = (Array.isArray(o?.inventory?.items) ? o.inventory.items : []).filter((item) => item?.count >= 8 && BUILDING.test(item.itemId ?? ''));
	return stacks.sort((a, b) => b.count - a.count)[0]?.itemId ?? null;
}
// Minecraft yaw: 0 south, 90 west, 180 north, -90 east.
function facing(yaw) {
	if (!Number.isFinite(yaw)) return null;
	return ['south', 'west', 'north', 'east'][Math.round((((yaw % 360) + 360) % 360) / 90) % 4];
}
function blockPosition(o) {
	const p = o?.position ?? o?.player ?? {};
	return [p.x, p.y, p.z].every(Number.isFinite) ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;
}
function threatId(t) { return t?.uuid ?? t?.id ?? t?.stableId ?? null; }
function safeKitStep(observation) { return safe(() => nextKitStep(observation)); }
function safe(fn) { try { return fn(); } catch { return null; } }
