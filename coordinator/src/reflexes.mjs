import { RULE_LIFETIMES, lifetimeEnded, lifetimeStart } from './danger-contexts.mjs';
import { getSwitch } from './switches.mjs';

/** Reflex rules run in the mod between model turns, so hazards can be handled before the model responds.
 * Model-authored rules and the default survival rules share one authoritative set across goal revisions. */

export const MAX_REFLEXES = 12;
export const DEFAULT_REFLEXES = Object.freeze([
	{ id: 'default-lava', kind: 'trigger', priority: 9, when: [{ type: 'in_lava' }], do: { type: 'leave_lava' }, ttlMs: 3_600_000 },
	// A tunnel flow can reach the body before the model answers; the existing escape also handles pre-contact lava.
	{ id: 'default-lava-flow', kind: 'trigger', priority: 9, when: [{ type: 'lava_flowing', withinS: 4 }], do: { type: 'leave_lava' }, ttlMs: 3_600_000 },
	{ id: 'default-fire', kind: 'trigger', priority: 8, when: [{ type: 'in_fire' }], do: { type: 'leave_fire' }, ttlMs: 3_600_000 },
	{ id: 'default-air', kind: 'trigger', priority: 8, when: [{ type: 'air_below', bubbles: 3 }], do: { type: 'swim_up' }, ttlMs: 3_600_000 },
	{ id: 'default-edge', kind: 'stance', priority: 7, when: [{ type: 'edge_near', within: 2, direction: 'any', drop: 4 }], do: { type: 'brace' }, ttlMs: 3_600_000 },
	// Dangers that kill inside one model round: a lit fuse is 1.5 s, an arrow under a second, a falling block at once.
	// Vanilla cancels a fuse once the creeper is more than 7 blocks away, so 8 blocks of sprint ends it.
	{ id: 'default-creeper', kind: 'trigger', priority: 9, when: [{ type: 'creeper_fusing', within: 5 }], do: { type: 'sprint_away', blocks: 8 }, ttlMs: 3_600_000 },
	{ id: 'default-suffocate', kind: 'trigger', priority: 9, when: [{ type: 'suffocating' }], do: { type: 'dig_out' }, ttlMs: 3_600_000 },
	{ id: 'default-fireball', kind: 'trigger', priority: 8, when: [{ type: 'fireball_incoming', withinS: 1.5, deflectable: true }], do: { type: 'deflect' }, ttlMs: 3_600_000 },
	// Item-dependent defaults sleep while the item is missing (ReflexEngine), so they never fire empty-handed.
	// drawn: also a bow drawn at you (or a loaded crossbow aimed at you), as the arrow alone came too late (CP2r: started 2 ticks before impact, 28 of 36
	// hits with a shield in hand unblocked). 10 s, not the 4 s trigger default: two skeletons drawing in turn hold the
	// condition true, and four timed-out firings in a row would switch the rule off.
	{ id: 'default-arrow', kind: 'trigger', priority: 7, when: [{ type: 'incoming_projectile', withinS: 0.6, drawn: true }], do: { type: 'shield' }, maxMs: 10_000, ttlMs: 3_600_000 },
	// The same drawn bow with no shield in either hand (it sleeps while one is held): step across the shot's line. Shieldless,
	// the body stood still facing the archer and took every arrow (no-shield archers room: died 10 of 10, 35-39 HP taken).
	// A hold like default-arrow: its release grace bridges a volley, so two skeletons do not fire it 40 times a minute.
	// Priority 6, under default-retreat: at 7 a volley held the body through the low-health run (only a higher priority
	// preempts), and over default-defend, so a draw takes the body from defend's stand to step aside.
	{ id: 'default-arrow-dodge', kind: 'trigger', priority: 6, when: [{ type: 'incoming_projectile', withinS: 0.6, drawn: true }], do: { type: 'dodge' }, maxMs: 10_000, ttlMs: 3_600_000 },
	// Air and fire must interrupt a retreat already in progress; only a strictly higher priority preempts.
	{ id: 'default-retreat', kind: 'trigger', priority: 7, when: [{ type: 'health_below', value: 7 }, { type: 'hostile_near', within: 6 }], do: { type: 'sprint_away', blocks: 10 }, cooldownMs: 5_000, ttlMs: 3_600_000 },
	// Each firing eats one item. A stance retries after cooldown while hungry and releases if a hostile comes within 8 blocks.
	// Below 18, not 14: health regrows only at hunger 18+. Practice room (hurt to 12, hunger 16, bread in the bag): at 14 the
	// body never ate and stayed at 12 in 10 of 10 runs; at 18 it ate and healed to 20 in 10 of 10.
	{ id: 'default-eat', kind: 'stance', priority: 3, when: [{ type: 'hunger_below', value: 18 }, { type: 'hostile_near', within: 8, not: true }], do: { type: 'eat' }, cooldownMs: 20_000, ttlMs: 3_600_000 },
	{ id: 'default-defend', kind: 'stance', priority: 5, when: [{ type: 'attacked', withinS: 4 }], do: { type: 'defend' }, ttlMs: 3_600_000 },
	// Bow skeletons as well as blazes (issue 2, K8): skeleton arrows were 21 of 54 deaths, most with a flee running in the open.
	// 8 s, not the 4 s trigger default: a walk of 8 steps, a look around and a stop to block each shot on the way (about 1.25 s
	// a shot) can pass 4 s, and a timed-out trigger counts toward the four failures that switch it off.
	{ id: 'default-blaze-cover', kind: 'trigger', priority: 6, when: [{ type: 'health_below', value: 11 }, { type: 'exposed', within: 12, mobs: ['minecraft:blaze', 'minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'] }], do: { type: 'take_cover', within: 8 }, maxMs: 8_000, cooldownMs: 5_000, ttlMs: 3_600_000 },
	// 8 s for the same reason: it runs the same take_cover, stops to block included.
	{ id: 'default-cover', kind: 'trigger', priority: 6, when: [{ type: 'health_below', value: 6 }, { type: 'attacked', withinS: 3 }], do: { type: 'take_cover', within: 8 }, maxMs: 8_000, ttlMs: 3_600_000 },
	// Owed drops (issue 2, 1b): a fight leaves its drops while a hostile is within 16 blocks and nothing went back for them.
	// Its own rule, not part of defend, whose 4 s hold would cut a 12 s collect short. Lowest priority: every other
	// instinct and any command pre-empt it. 20 s covers the collect and the walk back.
	{ id: 'default-owed-drops', kind: 'trigger', priority: 2, when: [{ type: 'drops_owed' }], do: { type: 'collect_drops' }, maxMs: 20_000, cooldownMs: 5_000, ttlMs: 3_600_000 },
].map((rule) => Object.freeze(rule)));
/**
 * Defaults armed only in one dimension: on entering it (as at spawn or respawn) and removed on leaving. The End (late-game
 * wall, order 12): breath killed 5 of 6 staged End deaths, 3 with no rule at all. default-breath is a hazard floor in the
 * mod (ReflexScheduler.FLOOR_HAZARDS has cloud_near): it fires while the breath is within 2 blocks (a sprinting body
 * overshoots 1), a model command waits under it until the run ends out of the cloud, and the loop limits never switch it off. Its run (sprint_away) refuses headings into a
 * cloud or toward the void and ends stepped back off a brink. default-end-throw steps inland when the dragon swoops at a
 * body standing near a deep drop, the throw that ends in the void.
 */
export const DIMENSION_REFLEXES = Object.freeze({
	'minecraft:the_end': Object.freeze([
		{ id: 'default-breath', kind: 'trigger', priority: 9, when: [{ type: 'cloud_near', within: 2 }], do: { type: 'sprint_away', blocks: 10 }, maxMs: 6_000, ttlMs: 3_600_000 },
		{ id: 'default-end-throw', kind: 'trigger', priority: 8, when: [{ type: 'dragon_charging', within: 48 }, { type: 'edge_near', within: 3, direction: 'any', drop: 16 }], do: { type: 'away_from_edge', blocks: 6 }, maxMs: 6_000, cooldownMs: 3_000, ttlMs: 3_600_000 },
		// Endermen killed 13 of 16 bodies in the judged dragon fight. A body standing between commands keeps a level view,
		// and one group of calm endermen in it turned hostile together (eye contact on all four): the guard turns the view
		// off a calm one's eyes. Priority 8 outranks retreat and defend but never preempts breath (9) or end-throw (8),
		// whose runs already keep the view off enderman eyes (EndermanGaze.clearPitch); 2 s covers the turn.
		{ id: 'default-gaze', kind: 'trigger', priority: 8, when: [{ type: 'enderman_gaze', within: 64 }], do: { type: 'look_away' }, maxMs: 2_000, ttlMs: 3_600_000 },
		// An angry enderman near the body teleports beside it faster than it can run or build: a player empties the water
		// bucket at the feet, and the spreading water hurts and teleports any enderman that steps in. Any angry one within 8
		// counts, not only one already after the body (targeting: true): measured in the judged End rooms, deaths were 34
		// of 40 on main, 25 of 40 with any angry enderman and 23 of 28 with only one after the body. The water stays, so the
		// bucket is spent and the rule sleeps (item-dependent rules never fire empty-handed), and so does a falling -> place
		// water_bucket clutch: fall and void deaths were 8 of 40 on main and 7 of 40 with this rule. The pour then holds the
		// body in its water while an angry enderman is within 16 and scoops it back once none is (at most 10 s, less with the
		// dragon near): left behind, the bucket stayed empty for the next one (dragon room on main: 9 of 14 deaths endermen).
		{ id: 'default-ender-water', kind: 'trigger', priority: 8, when: [{ type: 'enderman_provoked', within: 8 }], do: { type: 'place', item: 'minecraft:water_bucket', where: 'feet' }, maxMs: 12_000, cooldownMs: 10_000, ttlMs: 3_600_000 },
	].map((rule) => Object.freeze(rule))),
});
const MOST_DIMENSION_REFLEXES = Math.max(0, ...Object.values(DIMENSION_REFLEXES).map((rules) => rules.length));
export const DEFAULT_REFLEX_IDS = Object.freeze(new Set([...DEFAULT_REFLEXES, ...Object.values(DIMENSION_REFLEXES).flat()].map((rule) => rule.id)));
// The mod runs at most this many rules (ReflexSpec.MAX_RULES): the cap of every rule-set bound on the wire (C24). The
// model's own rules plus the defaults (with the most any dimension adds) must fit it, so a new default needs a raise on
// both sides first.
export const MAX_REFLEX_RULES = 32;
if (MAX_REFLEXES + DEFAULT_REFLEXES.length + MOST_DIMENSION_REFLEXES > MAX_REFLEX_RULES) throw new Error(`reflex rules ${MAX_REFLEXES} + ${DEFAULT_REFLEXES.length} + ${MOST_DIMENSION_REFLEXES} exceed the mod's ${MAX_REFLEX_RULES}`);

/**
 * Issue 2 Step 2: the instincts arm, on by default so practice rooms play as model games do. MINEAGEN_INSTINCTS set to
 * a comma list without `instincts` (for example `off`) turns it off; the mod reads the same variable, and the coordinator
 * runs with the mod's environment, so one variable defines the arm. Off, the rule set, the wake line and the route line
 * are what they were before.
 */
export function instinctsEnabled(environment = {}) {
	return getSwitch('instincts', environment).value;
}

/**
 * The automatic stance (D3): the brain need not set one. It is only numbers in the default rules below, so the wire and
 * older mods see ordinary rules (C23). steady equals DEFAULT_REFLEXES.
 */
export const STANCES = Object.freeze(['steady', 'fight', 'cautious', 'fortress']);
// fortress (wall breaker rods): a wither skeleton within 16 blocks in the Nether. Wither skeletons caused 12 of 28 staged
// fortress deaths (6 of 13 in the rod gate), most on open decks with the floors of the fight stance; near them the body
// backs off and takes cover early, fight or not. A blaze spawner hold's cell keeps them out, and the mod holds these back
// while the body is in that cell.
export const STANCE_SETTINGS = Object.freeze({
	'default-retreat': Object.freeze({ condition: 'health_below', steady: 7, fight: 4, cautious: 10, fortress: 14 }),
	'default-cover': Object.freeze({ condition: 'health_below', steady: 6, fight: 4, cautious: 9, fortress: 12 }),
	'default-blaze-cover': Object.freeze({ condition: 'health_below', steady: 11, fight: 8, cautious: 14, fortress: 16 }),
	// Heal (Step 2 item 2): health regrows only at hunger 18+, so eat below 18 in every stance. Hazard floor rules (8-9),
	// retreat (7), cover (6) and defend (5) outrank eat (3), and it holds off with a hostile within 8 (any fight in reach).
	'default-eat': Object.freeze({ condition: 'hunger_below', steady: 18, fight: 18, cautious: 18, fortress: 18 }),
});
// A new stance takes effect once it has held this long, so a flicker does not resend the set.
export const STANCE_DWELL_MS = 3_000;
const STANCE_FIGHTS = new Set(['fight_target', 'fight_until', 'use_ranged']);
const CAUTIOUS_HEALTH = 8;
// Cautious from low health lasts until health is back to this, so regeneration around 8 does not flip it each second.
const CAUTIOUS_CLEAR_HEALTH = 10;
// fortress starts with a wither skeleton within this many blocks and lasts while one is within the clear range.
export const FORTRESS_WITHER_RANGE = 16;
const FORTRESS_CLEAR_RANGE = 20;

/** The nearest live wither skeleton the body perceives now (not a remembered one), or Infinity. */
function nearestWither(observation) {
	if (observation?.continuity?.rememberedSections?.includes('entities')) return Infinity;
	let nearest = Infinity;
	for (const entity of observation?.entities ?? []) {
		if (entity?.type === 'minecraft:wither_skeleton' && entity.alive !== false && Number.isFinite(entity.distance)) nearest = Math.min(nearest, entity.distance);
	}
	return nearest;
}

/** steady, fight, cautious or fortress from the running verb and what the body perceives; previous only adds hysteresis. */
export function resolveAutoStance(observation, previous = 'steady') {
	const action = observation?.currentAction;
	const dimension = observation?.world?.dimension;
	// Before fight: a fight's lower floors are what let wither skeletons kill on fortress decks.
	if (dimension === 'minecraft:the_nether' && nearestWither(observation) <= (previous === 'fortress' ? FORTRESS_CLEAR_RANGE : FORTRESS_WITHER_RANGE)) return 'fortress';
	if (action?.active === true && STANCE_FIGHTS.has(action.actionType)) return 'fight';
	if (dimension === 'minecraft:the_nether' || dimension === 'minecraft:the_end') return 'cautious';
	const health = observation?.player?.health;
	if (Number.isFinite(health) && (health <= CAUTIOUS_HEALTH || previous === 'cautious' && health < CAUTIOUS_CLEAR_HEALTH)) return 'cautious';
	return 'steady';
}

/** A default rule with its stance numbers; any other rule is returned as a copy. */
export function materializeDefault(rule, stance = 'steady') {
	const copy = structuredClone(rule);
	const setting = STANCE_SETTINGS[rule.id];
	if (setting === undefined || !STANCES.includes(stance)) return copy;
	for (const condition of copy.when) if (condition.type === setting.condition && condition.not !== true) condition.value = setting[stance];
	return copy;
}
export const MAX_REFLEX_CONDITIONS = 4;
export const REFLEX_ID = /^[A-Za-z0-9_-]{1,32}$/;
const RESOURCE_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
export const TOOL_KINDS = Object.freeze(['any', 'axe', 'hoe', 'pickaxe', 'shield', 'shovel', 'sword']);
export const PLACE_WHERE = Object.freeze(['ahead', 'below', 'feet']);
// After this long without the mod echoing the current revision, the set is sent again (a lost message or a reconnect).
export const REFLEX_RESEND_MS = 1_500;
export const MAX_REFLEX_REPORT_BYTES = 700;
// The mod's longest rule lifetime (ReflexSpec.MAX_TTL_MS); a rule with no ttlS lasts 600 s there.
const MAX_REFLEX_TTL_MS = 3_600_000;
// A rule this close to its ttl is named in the wake line, so its expiry is not a surprise.
export const EXPIRY_WARNING_S = 120;

const number = (min, max, required = false) => ({ kind: 'number', min, max, required });
const ids = () => ({ kind: 'ids' });
const tool = () => ({ kind: 'tool' });
const item = (required = false) => ({ kind: 'item', required });
const where = () => ({ kind: 'where', required: true });
const choice = (...words) => ({ kind: 'choice', words });
const bool = () => ({ kind: 'bool' });
const entityId = () => ({ kind: 'entityId' });
const COORDINATE = 30_000_000;

/** Condition type -> parameters. Every value is something a player perceives (sight, hearing, the HUD). */
export const REFLEX_CONDITIONS = Object.freeze({
	// drawn: also true while a visible mob holds a bow drawn at you, or a loaded crossbow while it targets you, before its arrow flies.
	incoming_projectile: { withinS: number(0.05, 2), projectiles: ids(), drawn: bool() },
	hostile_near: { within: number(1, 32, true), mobs: ids(), targetId: entityId() },
	target_in_reach: { mobs: ids() },
	health_below: { value: number(1, 40, true) },
	air_below: { bubbles: number(1, 10, true) },
	hunger_below: { value: number(1, 20, true) },
	tool_broke: { tool: tool() },
	on_fire: {},
	in_lava: {},
	in_fire: {},
	on_hot_floor: {},
	inventory_full: {},
	item_nearby: { within: number(1, 8), items: ids() },
	// A kill's drop you left behind, last seen within 16 blocks: only after 3 s idle, no hostile near, health 10+, not sheltered.
	drops_owed: {},
	tool_low: { uses: number(1, 256, true), tool: tool() },
	falling: { blocks: number(1, 64, true) },
	saturation_empty: {},
	night: {},
	stack_used_up: { item: item() },
	fireball_incoming: { withinS: number(0.05, 3), deflectable: bool() },
	creeper_fusing: { within: number(1, 16) },
	enderman_gaze: { within: number(1, 64) },
	enderman_provoked: { within: number(1, 64), targeting: bool() },
	edge_near: { within: number(1, 4), direction: choice('ahead', 'behind', 'left', 'right', 'moving', 'any'), drop: number(2, 64) },
	lava_near: { within: number(1, 4) },
	lava_flowing: { withinS: number(0.5, 6) },
	attacked_from_behind: { within: number(1, 8) },
	exposed: { within: number(1, 48, true), mobs: ids() },
	cloud_near: { within: number(0, 4) },
	// The dragon seen flying at you: its flight line passes within about 10 blocks in the next 3 s.
	dragon_charging: { within: number(8, 96) },
	// Digging (midgame): the head inside a solid block, as falling sand or gravel lands on it.
	suffocating: {},
	// A mob hurt you within withinS seconds, or a hostile's shot lands within 1 s.
	attacked: { withinS: number(1, 10) },
});

/** Action type -> parameters. Every action is a player input (keys, view, hotbar, a recharged swing). */
export const REFLEX_ACTIONS = Object.freeze({
	shield: { counter: bool() },
	attack: {},
	step_back: { blocks: number(1, 4) },
	eat: {},
	select: { tool: tool(), item: item() },
	swim_up: {},
	pickup: { within: number(1, 8) },
	// Walks to the owed kill drops (12 s, junk thrown for room), then back to where you stood; each drop is tried once.
	collect_drops: {},
	place: { item: item(true), where: where() },
	stop: {},
	deflect: {},
	sprint_away: { blocks: number(2, 24) },
	move_to_cell: { x: number(-COORDINATE, COORDINATE, true), y: number(-2_048, 2_048, true), z: number(-COORDINATE, COORDINATE, true), sprint: bool() },
	sneak: {},
	look_away: {},
	place_block: { item: item(), count: number(1, 2) },
	take_cover: { within: number(2, 10) },
	away_from_edge: { blocks: number(2, 12) },
	dig_out: {},
	leave_fire: {},
	leave_lava: {},
	// Never takes the body: while its condition holds, a hit's shove toward a drop is walked back in any stance.
	brace: {},
	// Idle or over any action but fight_target, fight_until, use_ranged and flee_from (it ends when one starts): shield
	// toward shots and attackers, the best hotbar weapon at one in reach.
	defend: {},
	// No shield in either hand: strafe across a drawn bow's line around release, the other way on the next draw.
	dodge: {},
});

function codedError(code, message) { return Object.assign(new Error(message), { code }); }
function invalid(message) { throw codedError('INVALID_REFLEX', message); }
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const RULE_FIELDS = ['id', 'kind', 'priority', 'when', 'do', 'until', 'maxS', 'cooldownS', 'ttlS', 'lasts', 'maxFirings', 'wake'];
const LASTS_TEXT = { night: 'until dawn', dimension: 'in this dimension', lava: 'near lava' };

function onlyKeys(value, allowed, path) {
	for (const key of Object.keys(value)) {
		if (allowed.includes(key)) continue;
		// A rule field written inside when/do is a misplaced field, not an unknown one: say where it goes.
		const rule = path.match(/^(reflexes\[\d+\])\.(?:when|do|until)/)?.[1];
		if (rule !== undefined && RULE_FIELDS.includes(key)) invalid(`${path} has ${key}, a rule field: put it on ${rule} beside when/do; ${path} allows ${allowed.join(', ')}`);
		invalid(`${path} has unknown field ${key}; allowed: ${allowed.join(', ')}`);
	}
}

function resourceId(value, path) {
	if (typeof value !== 'string' || value.length === 0) invalid(`${path} must be an id like minecraft:blaze`);
	const id = (value.includes(':') ? value : `minecraft:${value}`).toLowerCase();
	if (!RESOURCE_ID.test(id) || id.length > 128) invalid(`${path} has an invalid id ${value}`);
	return id;
}

function params(value, table, path, reserved) {
	onlyKeys(value, [...reserved, ...Object.keys(table)], path);
	const result = {};
	for (const [name, spec] of Object.entries(table)) {
		const raw = value[name];
		const field = `${path}.${name}`;
		if (raw === undefined) {
			if (spec.required) invalid(`${field} is required for ${value.type}`);
			continue;
		}
		if (spec.kind === 'number') {
			if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < spec.min || raw > spec.max) invalid(`${field} must be a number between ${spec.min} and ${spec.max}`);
			result[name] = raw;
		} else if (spec.kind === 'entityId') {
			if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) invalid(`${field} must be a UUID`);
			result[name] = raw.toLowerCase();
		} else if (spec.kind === 'ids') {
			if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) invalid(`${field} must list 1..8 ids like minecraft:blaze`);
			result[name] = [...new Set(raw.map((entry, index) => resourceId(entry, `${field}[${index}]`)))];
		} else if (spec.kind === 'choice') {
			if (!spec.words.includes(raw)) invalid(`${field} must be one of ${spec.words.join(', ')}`);
			result[name] = raw;
		} else if (spec.kind === 'bool') {
			if (typeof raw !== 'boolean') invalid(`${field} must be boolean`);
			result[name] = raw;
		} else if (spec.kind === 'tool') {
			if (!TOOL_KINDS.includes(raw)) invalid(`${field} must be one of ${TOOL_KINDS.join(', ')}`);
			result[name] = raw;
		} else if (spec.kind === 'where') {
			if (!PLACE_WHERE.includes(raw)) invalid(`${field} must be one of ${PLACE_WHERE.join(', ')}`);
			result[name] = raw;
		} else {
			result[name] = resourceId(raw, field);
		}
	}
	return result;
}

function conditions(value, path) {
	const rows = Array.isArray(value) ? value : [value];
	if (rows.length === 0 || rows.length > MAX_REFLEX_CONDITIONS) invalid(`${path} needs 1..${MAX_REFLEX_CONDITIONS} conditions (all must hold)`);
	return rows.map((row, index) => {
		const field = Array.isArray(value) ? `${path}[${index}]` : path;
		if (!isObject(row)) invalid(`${field} must be a condition object like {type:"hostile_near",within:12}`);
		const table = REFLEX_CONDITIONS[row.type];
		if (table === undefined) invalid(`${field}.type ${JSON.stringify(row.type)} is not a reflex condition; use one of ${Object.keys(REFLEX_CONDITIONS).join(', ')}`);
		if (row.not !== undefined && typeof row.not !== 'boolean') invalid(`${field}.not must be boolean`);
		return { type: row.type, ...(row.not === true ? { not: true } : {}), ...params(row, table, field, ['type', 'not']) };
	});
}

function seconds(value, path, min, max) {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`${path} must be seconds between ${min} and ${max}`);
	return Math.round(value * 1_000);
}

/**
 * One model entry: a full rule (installed or replacing the same id) or {id, remove:true} (id "*" removes all).
 * Returns the canonical wire rule, or {id, remove:true}.
 */
export function normalizeReflexEntry(entry, index = 0) {
	const path = `reflexes[${index}]`;
	if (!isObject(entry)) invalid(`${path} must be an object`);
	if (entry.remove !== undefined) {
		if (entry.remove !== true) invalid(`${path}.remove must be true`);
		onlyKeys(entry, ['id', 'remove'], path);
		if (entry.id !== '*' && (typeof entry.id !== 'string' || !REFLEX_ID.test(entry.id))) invalid(`${path}.id must be a reflex id or "*"`);
		return { id: entry.id, remove: true };
	}
	onlyKeys(entry, RULE_FIELDS, path);
	if (typeof entry.id !== 'string' || !REFLEX_ID.test(entry.id)) invalid(`${path}.id must be 1..32 letters, digits, _ or -`);
	const kind = entry.kind ?? 'trigger';
	if (!['trigger', 'stance'].includes(kind)) invalid(`${path}.kind must be trigger (fires once when its condition becomes true) or stance (holds while it is true)`);
	if (entry.priority !== undefined && (!Number.isInteger(entry.priority) || entry.priority < 1 || entry.priority > 9)) invalid(`${path}.priority must be an integer 1..9 (survival high, work low)`);
	if (entry.when === undefined) invalid(`${path}.when is required`);
	const when = conditions(entry.when, `${path}.when`);
	if (when.every((condition) => condition.not === true)) invalid(`${path}.when needs at least one condition that is not negated`);
	if (!isObject(entry.do)) invalid(`${path}.do must be an action object like {type:"shield"}`);
	const table = REFLEX_ACTIONS[entry.do.type];
	if (table === undefined) invalid(`${path}.do.type ${JSON.stringify(entry.do.type)} is not a reflex action; use one of ${Object.keys(REFLEX_ACTIONS).join(', ')}`);
	const action = { type: entry.do.type, ...params(entry.do, table, `${path}.do`, ['type']) };
	if (action.type === 'select' && (action.tool === undefined) === (action.item === undefined)) invalid(`${path}.do select needs exactly one of tool or item`);
	const until = entry.until === undefined ? undefined : conditions(entry.until, `${path}.until`);
	if (entry.maxFirings !== undefined && (!Number.isInteger(entry.maxFirings) || entry.maxFirings < 1 || entry.maxFirings > 1_000)) invalid(`${path}.maxFirings must be an integer 1..1000`);
	if (entry.wake !== undefined && typeof entry.wake !== 'boolean') invalid(`${path}.wake must be boolean`);
	const maxMs = seconds(entry.maxS, `${path}.maxS`, 0.25, kind === 'stance' && action.type === 'shield' ? 600 : 20);
	const cooldownMs = seconds(entry.cooldownS, `${path}.cooldownS`, 0.25, 60);
	const ttlMs = seconds(entry.ttlS, `${path}.ttlS`, 1, 3_600);
	if (entry.lasts !== undefined && !RULE_LIFETIMES.includes(entry.lasts)) invalid(`${path}.lasts must be one of ${RULE_LIFETIMES.join(', ')} (night: until dawn; dimension: until you leave this dimension; lava: until you are away from lava)`);
	return {
		id: entry.id, kind, ...(entry.priority === undefined ? {} : { priority: entry.priority }), when, do: action,
		...(until === undefined ? {} : { until }), ...(maxMs === undefined ? {} : { maxMs }), ...(cooldownMs === undefined ? {} : { cooldownMs }),
		// stop exists to hand the moment back to the model, so it wakes unless the rule says wake:false.
		...(ttlMs === undefined ? {} : { ttlMs }), ...(entry.lasts === undefined ? {} : { lasts: entry.lasts }), ...(entry.maxFirings === undefined ? {} : { maxFirings: entry.maxFirings }), ...(entry.wake === true || (entry.wake === undefined && action.type === 'stop') ? { wake: true } : {}),
	};
}

export function normalizeReflexEntries(value) {
	if (!Array.isArray(value)) invalid('reflexes must be an array of rules ({id, when, do, ...}) or {id, remove:true}');
	if (value.length > MAX_REFLEXES) invalid(`reflexes holds at most ${MAX_REFLEXES} entries`);
	const entries = value.map((entry, index) => normalizeReflexEntry(entry, index));
	const ids = entries.filter((entry) => entry.remove !== true).map((entry) => entry.id);
	if (new Set(ids).size !== ids.length) invalid('reflexes lists the same id twice');
	return entries;
}

/**
 * What a rule's action needs that the latest sample shows the body lacks, else null: the mod's own check
 * (ReflexActions.lacks) for the items a rule names, so the arm result says it before the mod echoes the set.
 */
export function reflexLacks(action, observation) {
	const items = observation?.inventory?.items;
	if (!Array.isArray(items) || action === undefined) return null;
	const inHand = (item) => item.hotbar === true || item.slot === 'mainhand' || item.slot === 'offhand';
	const has = (where, id) => items.some((item) => where(item) && item.itemId === id);
	switch (action.type) {
		case 'place': return has(inHand, action.item) ? null : `no ${action.item} in hotbar or offhand`;
		case 'place_block': return action.item === undefined || has((item) => item.hotbar === true || item.slot === 'mainhand', action.item) ? null : `no ${action.item} in hotbar`;
		case 'select': return action.item === undefined || has((item) => typeof item.slot === 'number' || item.slot === 'mainhand' || item.slot === 'offhand', action.item) ? null : `no ${action.item} in inventory`;
		case 'shield': return has((item) => item.slot === 'mainhand' || item.slot === 'offhand', 'minecraft:shield') ? null : 'no shield in either hand';
		default: return null;
	}
}

function eventLine(event) {
	const seconds = event.ms >= 1_000 ? ` ${(event.ms / 1_000).toFixed(1)} s` : '';
	const verb = { done: 'done', timeout: 'hit maxS', failed: 'failed', preempted: 'preempted', yielded: 'yielded', disabled: 'DISABLED', expired: 'expired', removed: 'removed' }[event.outcome] ?? event.outcome;
	return `${event.id} ${verb}${['done', 'timeout', 'preempted', 'yielded'].includes(event.outcome) ? seconds : ''}${event.detail ? `: ${event.detail}` : ''}`;
}

/** The authoritative rule sets, per agent. Rules persist across goal revisions; they end by expiry or the model. */
const MAX_REMEMBERED_POURS = 4;
// A bucket reaches 4.5 m from the eye (survival block reach); from the feet allow the eye height and a block's half-diagonal.
const SCOOP_REACH = 7;
// A block row's fluid: minecraft:water is a source, minecraft:flowing_water is not; level 0 is a source. Unknown counts as one.
const waterSourceRow = b => b.fluid?.type !== undefined ? b.fluid.type === 'minecraft:water' : b.state?.level === undefined || String(b.state.level) === '0';

export class ReflexBook {
	#agents = new Map();
	// The latest live sample per agent, kept apart from #agents so seeing one never opens a rule book (a book's first
	// mod report must still count as new once the model installs rules).
	#samples = new Map();
	#now;
	#defaults;
	#dimensionDefaults;
	#instincts;
	#pours = new Map();
	// The latest sample that carried the inventory: a scoop is read against it, so a sample without one between hides none.
	#stocked = new Map();

	/** dimensionDefaults: {dimension: rules} armed only there; by default DIMENSION_REFLEXES with the production defaults. */
	// instincts defaults to the switch (on unless MINEAGEN_INSTINCTS lists something else), so a practice room's book plays as
	// the coordinator's does in a model game.
	constructor({ now = Date.now, defaults = DEFAULT_REFLEXES, dimensionDefaults = defaults === DEFAULT_REFLEXES ? DIMENSION_REFLEXES : {}, instincts = instinctsEnabled(process.env) } = {}) {
		this.#now = now; this.#defaults = defaults; this.#dimensionDefaults = dimensionDefaults; this.#instincts = instincts === true;
	}

	#agent(agentId) {
		let agent = this.#agents.get(agentId);
		if (agent === undefined) {
			agent = { rules: new Map(), revision: 0, sentAtMs: null, lastSeq: 0, pending: [], status: null, lifetimes: new Map(),
				// Ids holding the default definition now, ids the model switched off, and the last live context seen.
				defaults: new Set(), declined: new Set(), dimension: null, dead: false, seenLive: false,
				// The automatic stance (instincts arm only) and a different one waiting out its dwell.
				stance: 'steady', pendingStance: null, pendingSince: 0 };
			this.#agents.set(agentId, agent);
		}
		return agent;
	}

	/** Applies normalized entries (install/replace/remove); throws before changing anything when the result is too large. */
	apply(agentId, entries) {
		const agent = this.#agent(agentId);
		const next = new Map(agent.rules);
		const defaults = new Set(agent.defaults), declined = new Set(agent.declined);
		for (const entry of entries) {
			if (entry.remove === true) {
				// "*" removes the model's own rules; a default rule is switched off by its id.
				if (entry.id === '*') { for (const id of [...next.keys()]) if (!defaults.has(id)) next.delete(id); }
				else {
					next.delete(entry.id);
					if (defaults.delete(entry.id) || DEFAULT_REFLEX_IDS.has(entry.id)) declined.add(entry.id);
				}
			} else {
				next.set(entry.id, entry);
				defaults.delete(entry.id);
			}
		}
		const own = [...next.keys()].filter((id) => !defaults.has(id));
		if (own.length > MAX_REFLEXES) throw codedError('REFLEX_LIMIT', `At most ${MAX_REFLEXES} reflexes of your own besides the default rules; remove some by id first (installed: ${[...agent.rules.keys()].join(', ')})`);
		const changed = entries.length > 0;
		if (changed) {
			agent.rules = next;
			agent.defaults = defaults;
			agent.declined = declined;
			agent.revision += 1;
			// A rule with a context lifetime starts it from the latest sample; a replaced or removed one drops its old state.
			for (const id of [...agent.lifetimes.keys()]) if (next.get(id)?.lasts === undefined) agent.lifetimes.delete(id);
			for (const entry of entries) {
				if (entry.remove === true || entry.lasts === undefined) continue;
				agent.lifetimes.set(entry.id, lifetimeStart(entry.lasts, this.#samples.get(agentId) ?? null, this.#now()));
			}
		}
		return { changed, rules: [...next.values()] };
	}

	/**
	 * Ends rules whose context lifetime is over on this live sample (dawn, another dimension, away from lava): they are
	 * removed like a model removal and reported as expired in the next wake. Returns whether the set changed.
	 */
	observeContext(agentId, observation) {
		this.#forgetScoopedPour(agentId, this.#stocked.get(agentId), observation);
		if (Array.isArray(observation?.inventory?.items)) this.#stocked.set(agentId, observation);
		this.#samples.set(agentId, observation);
		const armed = this.#armDefaults(agentId, observation);
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return armed;
		const ended = [];
		for (const [id, state] of agent.lifetimes) {
			const why = lifetimeEnded(state, observation, this.#now());
			if (why !== null) ended.push([id, why]);
		}
		if (ended.length === 0) return armed;
		for (const [id, why] of ended) {
			agent.lifetimes.delete(id);
			agent.rules.delete(id);
			agent.pending.push({ id, outcome: 'expired', detail: why });
		}
		agent.pending = agent.pending.slice(-16);
		agent.revision += 1;
		return true;
	}

	/**
	 * Arms the default rules that are missing: on the first live sample (spawn), after a respawn and at a dimension change
	 * (which also end the model's switch-offs), and on any later sample for a default that expired or the mod dropped.
	 * Returns whether the set changed.
	 */
	#armDefaults(agentId, observation) {
		// With no defaults the book opens only when the model installs rules (its first mod report then counts as new).
		if (this.#defaults.length === 0) return false;
		const agent = this.#agent(agentId);
		if (observation?.player?.dead === true || observation?.death != null || observation?.status === 'PLAYER_DEAD') {
			agent.dead = true;
			return false;
		}
		const dimension = observation?.world?.dimension;
		if (observation?.ready === false || typeof dimension !== 'string') return false;
		const event = !agent.seenLive ? 'spawn' : agent.dead ? 'respawn' : dimension !== agent.dimension ? 'dimension' : null;
		agent.seenLive = true;
		agent.dead = false;
		agent.dimension = dimension;
		if (event !== null) agent.declined.clear();
		const restanced = this.#instincts && this.#settleStance(agent, observation, event !== null);
		const here = this.#dimensionDefaults[dimension] ?? [];
		// A dimension's own defaults leave with it (only while still held as defaults: a model replacement is the model's).
		const gone = Object.values(this.#dimensionDefaults).flat().filter((rule) => !here.includes(rule) && agent.defaults.has(rule.id));
		for (const rule of gone) { agent.rules.delete(rule.id); agent.defaults.delete(rule.id); }
		const missing = [...this.#defaults, ...here].filter((rule) => !agent.rules.has(rule.id) && !agent.declined.has(rule.id));
		if (missing.length === 0 && !restanced && gone.length === 0) return false;
		for (const rule of missing) {
			agent.rules.set(rule.id, this.#instincts ? materializeDefault(rule, agent.stance) : structuredClone(rule));
			agent.defaults.add(rule.id);
		}
		agent.revision += 1;
		return true;
	}

	/**
	 * Moves the automatic stance after its dwell (at once at spawn, respawn or a dimension change) and rewrites the
	 * defaults still held as defaults with its numbers. Returns whether a rule changed.
	 */
	#settleStance(agent, observation, now) {
		const candidate = resolveAutoStance(observation, agent.stance);
		if (candidate === agent.stance) agent.pendingStance = null;
		// fortress takes effect at once: a wither skeleton closes 16 blocks in about the 3 s dwell.
		else if (now || candidate === 'fortress') { agent.stance = candidate; agent.pendingStance = null; }
		else if (agent.pendingStance !== candidate) { agent.pendingStance = candidate; agent.pendingSince = this.#now(); }
		else if (this.#now() - agent.pendingSince >= STANCE_DWELL_MS) { agent.stance = candidate; agent.pendingStance = null; }
		let changed = false;
		for (const base of this.#defaults) {
			if (!agent.defaults.has(base.id) || !agent.rules.has(base.id)) continue;
			const next = materializeDefault(base, agent.stance);
			if (JSON.stringify(next) === JSON.stringify(agent.rules.get(base.id))) continue;
			agent.rules.set(base.id, next);
			changed = true;
		}
		return changed;
	}

	/** The automatic stance (instincts arm), else null. */
	stance(agentId) { return this.#instincts ? this.#agents.get(agentId)?.stance ?? null : null; }

	isDefault(agentId, id) { return this.#agents.get(agentId)?.defaults.has(id) === true; }

	/** The installed rule definitions with the mod's live state (disabled rules say so), for coverage checks. */
	rules(agentId) {
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return [];
		const states = new Map(this.list(agentId).map(row => [row.id, row]));
		return [...agent.rules.values()].map(rule => {
			const row = states.get(rule.id);
			return { ...rule, state: row?.state, ...(row?.lacks ? { lacks: row.lacks } : {}) };
		});
	}

	has(agentId) { return (this.#agents.get(agentId)?.rules.size ?? 0) > 0; }

	/** The mod's latest firing reports as it sent them ({seq, id, outcome, ...}); not consumed. */
	events(agentId) { return this.#agents.get(agentId)?.status?.events ?? []; }

	payload(agentId, { yieldFiring = false } = {}) {
		const agent = this.#agent(agentId);
		agent.sentAtMs = this.#now();
		// The mod knows ttlMs only: a rule scoped to a context gets the longest ttl unless it set its own; the coordinator
		// ends it when the context ends.
		const rules = [...agent.rules.values()].map(({ lasts, ...rule }) => ({
			...rule,
			...(lasts !== undefined && rule.ttlMs === undefined ? { ttlMs: MAX_REFLEX_TTL_MS } : {}),
			// Ownership is bookkeeping, not an id convention: a replacement belongs to the model.
			...(agent.defaults.has(rule.id) ? { coordinatorDefault: true } : {}),
		}));
		return { revision: agent.revision, rules: structuredClone(rules), yield: yieldFiring };
	}

	/** Whether the mod reports a firing now (a direct model command then takes the body from it). */
	firing(agentId) { return this.#agents.get(agentId)?.status?.firing != null; }

	/**
	 * Whether the firing now is the default defend rule: it holds the body only until the model's command arrives,
	 * so a standing order (a command the model wrote ahead) takes the body from it as a direct command does.
	 */
	firingStandsIn(agentId) {
		const agent = this.#agents.get(agentId);
		const id = agent?.status?.firing?.id;
		return id != null && agent.defaults.has(id) && agent.rules.get(id)?.do.type === 'defend';
	}

	/**
	 * The id of a firing `stop` rule not handled yet (returned once per firing), else null. The coordinator then cancels
	 * the running program or action; the mod holds the body still meanwhile.
	 */
	stopFiring(agentId) {
		const agent = this.#agents.get(agentId);
		const firing = agent?.status?.firing;
		if (firing == null || agent.rules.get(firing.id)?.do.type !== 'stop') return null;
		if (agent.stopHandled === firing.id) return null;
		agent.stopHandled = firing.id;
		return firing.id;
	}

	/**
	 * Reads the reflex status from a stored observation. Returns new firing reports, whether one asks to wake the model,
	 * and whether the mod lacks the current set (so the caller re-sends it).
	 */
	observe(agentId, status) {
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return { events: [], wake: false, resend: false };
		if (status !== undefined) agent.status = status;
		if (status !== undefined && status.firing?.id !== agent.stopHandled) agent.stopHandled = null;
		// The mod restarted its sequence (a reconnect cleared its rules): treat what it reports as new.
		if (status !== undefined && status.events.length > 0 && status.events.at(-1).seq < agent.lastSeq) agent.lastSeq = 0;
		const events = (status?.events ?? []).filter((event) => event.seq > agent.lastSeq);
		for (const event of events) agent.lastSeq = Math.max(agent.lastSeq, event.seq);
		for (const event of events) this.#notePour(agentId, event.detail);
		// A pour held against an angry enderman reports its cell while it runs, so one that ends preempted or yielded (whose
		// end report names the rule or the command instead) is remembered too; its scoop is read from the inventory.
		if (typeof status?.firing?.detail === 'string') this.#notePour(agentId, status.firing.detail);
		// Only a report acknowledging the current definitions can retire them. An old revision may
		// contain an expiry for an id the model has since deliberately replaced.
		if (status?.revision === agent.revision && !status.error) {
			const live = new Set(status.rules.map(row => row.id));
			for (const id of agent.rules.keys()) if (!live.has(id)) {
				agent.rules.delete(id);
				agent.lifetimes.delete(id);
				if (!events.some(event => event.id === id && event.outcome === 'expired'))
					agent.pending.push({ id, outcome: 'expired', detail: 'no longer installed on server' });
			}
		}
		agent.pending.push(...events);
		agent.pending = agent.pending.slice(-16);
		const behind = agent.revision > 0 && (status === undefined || status.revision !== agent.revision);
		const resend = behind && agent.sentAtMs !== null && this.#now() - agent.sentAtMs >= REFLEX_RESEND_MS;
		return { events, wake: events.some((event) => event.wake === true), resend };
	}

	// A place firing of a water bucket reports its cell ("placed minecraft:water_bucket at feet X,Y,Z"), at its end however it
	// ended and while it holds the body in the water; the source stays there until scooped. The bot's block rows are the
	// cells nearest its feet, so a few blocks off they show only the flow.
	#notePour(agentId, detail) {
		const cell = /placed minecraft:water_bucket at (?:feet )?(-?\d+),(-?\d+),(-?\d+)/.exec(detail ?? '');
		if (!cell) return;
		const dimension = this.#samples.get(agentId)?.world?.dimension ?? null;
		const [x, y, z] = cell.slice(1).map(Number);
		const pours = (this.#pours.get(agentId) ?? []).filter(p => !(p.x === x && p.y === y && p.z === z && p.dimension === dimension));
		this.#pours.set(agentId, [{ x, y, z, dimension }, ...pours].slice(0, MAX_REMEMBERED_POURS));
	}

	// A scooped source turns to air, and the observation lists no air rows, so a scoop is read from the inventory: one more
	// water bucket than the last sample, with a remembered pour within a bucket's reach that is not still listed as a
	// source, forgets the nearest such pour.
	#forgetScoopedPour(agentId, before, after) {
		const pours = this.#pours.get(agentId);
		// Both samples must carry the inventory: one without it would read as zero buckets and the next as a scoop.
		if (!pours?.length || !Array.isArray(before?.inventory?.items) || !Array.isArray(after?.inventory?.items)) return;
		const buckets = sample => sample.inventory.items
			.reduce((sum, item) => sum + (item?.itemId === 'minecraft:water_bucket' && Number.isFinite(item.count) ? item.count : 0), 0);
		if (buckets(after) <= buckets(before)) return;
		const at = after.position ?? after.player?.position;
		const dimension = after.world?.dimension ?? null;
		if (![at?.x, at?.y, at?.z].every(Number.isFinite)) return;
		const reach = p => p.dimension === dimension ? Math.hypot(p.x + 0.5 - at.x, p.y + 0.5 - at.y, p.z + 0.5 - at.z) : Infinity;
		// A pour the new sample still lists as a water source was not the one scooped.
		const sources = new Set(after.blocks?.filter?.(b => b?.blockId === 'minecraft:water' && waterSourceRow(b)).map(b => `${b.x},${b.y},${b.z}`) ?? []);
		const nearest = pours.filter(p => reach(p) <= SCOOP_REACH && !sources.has(`${p.x},${p.y},${p.z}`)).sort((a, b) => reach(a) - reach(b))[0];
		if (nearest) this.#pours.set(agentId, pours.filter(p => p !== nearest));
	}

	/**
	 * The water sources this agent's reflexes poured, newest first, in the observation's dimension. A pour whose cell the
	 * observation lists as anything but a water source (a block, or only flow) is forgotten; a scoop, which leaves air and no row, is read from the inventory.
	 */
	pours(agentId, observation) {
		const dimension = observation?.world?.dimension ?? null;
		const rows = new Map((Array.isArray(observation?.blocks) ? observation.blocks : []).map(b => [`${b?.x},${b?.y},${b?.z}`, b]));
		const kept = (this.#pours.get(agentId) ?? []).filter(p => {
			const row = p.dimension === dimension ? rows.get(`${p.x},${p.y},${p.z}`) : undefined;
			return row === undefined || row.blockId === 'minecraft:water' && waterSourceRow(row);
		});
		if (kept.length === 0) this.#pours.delete(agentId); else this.#pours.set(agentId, kept);
		return kept.filter(p => p.dimension === dimension).map(({ x, y, z }) => ({ x, y, z }));
	}

	/** The rules as programs and the model read them: installed definitions joined with the mod's live state. */
	list(agentId) {
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return [];
		const live = new Map((agent.status?.revision === agent.revision ? agent.status.rules : []).map((row) => [row.id, row]));
		return [...agent.rules.values()].map((rule) => {
			const row = live.get(rule.id);
			// The rule arms either way; a missing item is a fact for the model (the mod's word once it echoes the set).
			const lacks = row === undefined ? reflexLacks(rule.do, this.#samples.get(agentId)) : row.lacks ?? null;
			return { id: rule.id, kind: rule.kind, ...(agent.defaults.has(rule.id) ? { default: true } : {}), ...(rule.lasts === undefined ? {} : { lasts: rule.lasts }), ...(row === undefined ? { state: 'pending' } : { state: row.state, fired: row.fired, expiresInS: row.expiresInS, ...(row.disabled ? { disabled: row.disabled } : {}) }), ...(lacks ? { lacks } : {}) };
		});
	}

	/** One wake line: installed rules and the firing reports since the last wake (consumed). Null when there is nothing. */
	takeReport(agentId) {
		const agent = this.#agents.get(agentId);
		if (agent === undefined || (agent.rules.size === 0 && agent.pending.length === 0)) return null;
		// Lifetime next to each id: its context, or the seconds left once the ttl is near (default 600 s when unset).
		const armed = this.list(agentId).map((row) => `${row.id}${row.kind === 'stance' ? '(stance)' : ''}${row.state === 'disabled' ? '(disabled)' : ''}${row.lacks ? `(${row.lacks})` : ''}${row.lasts !== undefined ? `(${LASTS_TEXT[row.lasts]})`
			: Number.isFinite(row.expiresInS) && row.expiresInS <= EXPIRY_WARNING_S ? `(expires in ${row.expiresInS} s)` : ''}`);
		// Expiries are listed apart from firings, so a lapsed rule is never trimmed away as an old firing.
		const expired = agent.pending.filter((event) => event.outcome === 'expired').map((event) => `${event.id}${event.detail ? ` (${event.detail})` : ''}`);
		const reports = agent.pending.filter((event) => event.outcome !== 'expired').map(eventLine);
		agent.pending = [];
		const error = agent.status?.error ? `; mod rejected the set: ${agent.status.error}` : '';
		const stance = this.#instincts && agent.defaults.size > 0 ? `; stance ${agent.stance} (auto)` : '';
		const head = `${armed.length > 0 ? `armed ${armed.join(', ')}` : 'none armed'}${stance}${expired.length > 0 ? `; expired: ${expired.join(', ')}` : ''}`;
		let line = `${head}${reports.length > 0 ? `; fired: ${reports.join('; ')}` : ''}${error}`;
		while (Buffer.byteLength(line, 'utf8') > MAX_REFLEX_REPORT_BYTES && reports.length > 1) {
			reports.shift();
			line = `${head}; fired (latest): ${reports.join('; ')}${error}`;
		}
		line = Buffer.byteLength(line, 'utf8') > MAX_REFLEX_REPORT_BYTES ? `${line.slice(0, MAX_REFLEX_REPORT_BYTES - 3)}...` : line;
		// Show authored definitions only in spare report space, keeping firing/failure evidence first.
		const definitions = [];
		for (const rule of agent.rules.values()) {
			if (agent.defaults.has(rule.id)) continue;
			const definition = { id: rule.id, kind: rule.kind, priority: rule.priority ?? 5, when: rule.when, do: rule.do, ...(rule.lasts === undefined ? {} : { lasts: rule.lasts }) };
			const candidate = `${line}; rules: ${JSON.stringify([...definitions, definition])}`;
			if (Buffer.byteLength(candidate, 'utf8') <= MAX_REFLEX_REPORT_BYTES) definitions.push(definition);
		}
		return definitions.length > 0 ? `${line}; rules: ${JSON.stringify(definitions)}` : line;
	}

	clear(agentId) { this.#agents.delete(agentId); this.#samples.delete(agentId); this.#pours.delete(agentId); this.#stocked.delete(agentId); }
}
