// System 1's voice: a book of situation -> response rules (player knowledge written as tagged rules), matched to what
// the body perceives now and handed to the model as now.instinct, its own trained sense for this exact situation. The
// book is data loaded from MINEAGEN_INSTINCT_BOOK; with no book there is no instinct line and nothing changes.
//
// Rule: { id, tags: [...], when, do, priority 1-3 }. A rule applies when every tag holds now. Tags (all perceivable):
// dim:, place:, time:, health:, hunger:, threat:<mob>|many, has:/lacks:<item>, need:<thing>, event:, stage:.
import { readFileSync } from 'node:fs';

/** The most rules shown per wake: enough for the situation, few enough to read at a glance. */
export const INSTINCT_LINES = 3;
/** Each line is bounded so the book can never crowd the wake. */
export const INSTINCT_LINE_CHARS = 260;
// How much each tag pins a rule to this moment. Acute facts (a threat, an event, low health or hunger, lava beside you)
// come and go within seconds, so a rule keyed on one outranks rules keyed on standing facts (what is held, the stage),
// which stay true for many minutes; a dimension is ambient.
const TAG_WEIGHT = Object.freeze({ threat: 2, event: 2, need: 1.25, hunger: 0.5, health: 0.5, has: 0.75, lacks: 0.75, place: 1, stage: 0.5, time: 0.5, dim: 0.25 });
const ACUTE = Object.freeze({ 'health:low': 2, 'hunger:low': 1.5, 'place:near_lava': 1.5, 'time:night': 0.75, 'time:dusk': 0.75 });
/** A rule whose tags weigh less than this is ambient (true almost everywhere) and is never shown per wake. */
const AMBIENT_WEIGHT = 1;

const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'slime',
	'pillager', 'blaze', 'ghast', 'piglin', 'piglin_brute', 'hoglin', 'wither_skeleton', 'magma_cube', 'zombified_piglin', 'endermite', 'silverfish', 'ender_dragon']);
const MOB_TAG = Object.freeze({ husk: 'zombie', stray: 'skeleton', bogged: 'skeleton', cave_spider: 'spider' });
const THREAT_RANGE = 16;
const FOOD = /^(cooked_\w+|bread|baked_potato|golden_carrot|golden_apple|pumpkin_pie|\w+_stew|beetroot_soup|beef|porkchop|mutton|chicken|rabbit|cod|salmon|apple|carrot|potato|sweet_berries|glow_berries|melon_slice|beetroot|cookie|dried_kelp)$/;
const COOKED = /^(cooked_\w+|bread|baked_potato|golden_carrot|golden_apple|pumpkin_pie|\w+_stew|beetroot_soup)$/;
const BLOCKS = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|end_stone)$/;
const ARMOUR = /_(helmet|chestplate|leggings|boots)$/;
const WORN = new Set(['head', 'chest', 'legs', 'feet']);
const DIMENSION = Object.freeze({ 'minecraft:overworld': 'overworld', 'minecraft:the_nether': 'nether', 'minecraft:the_end': 'end' });
const SHORT = id => String(id ?? '').replace(/^minecraft:/, '');
// Events from what woke the model and the last body result (the observation alone holds only burning and lava).
const TRIGGER_EVENTS = Object.freeze({ damage: ['took_damage'], fall: ['took_damage', 'fell'], projectile: ['took_damage', 'shot_at'], respawn: ['respawned', 'lost_items'],
	drowning: ['drowning'], stuck: ['stuck'] });
const RESULT_EVENTS = Object.freeze({ TOOL_WORN: 'tool_low', NO_TOOL: 'tool_low', INVENTORY_FULL: 'inventory_full', DIG_STUCK: 'stuck', NO_ROUTE: 'stuck', NO_SEEN_ROUTE: 'stuck' });
/** The first in-game minutes of night (ticks 13000-14200) count as night falling. */
const NIGHT_FALLS = [13000, 14200];

/** Reads and checks a book file: a JSON array of rules, or { rules: [...] }. Throws on a malformed rule. */
export function loadInstinctBook(file) {
	const parsed = JSON.parse(readFileSync(file, 'utf8'));
	return checkBook(Array.isArray(parsed) ? parsed : parsed?.rules);
}

export function checkBook(rules) {
	if (!Array.isArray(rules) || rules.length === 0) throw new TypeError('instinct book must hold a non-empty array of rules');
	const ids = new Set();
	return Object.freeze(rules.map((rule, index) => {
		const where = `instinct book rule ${index}`;
		if (typeof rule?.id !== 'string' || !/^[a-z0-9-]+$/.test(rule.id) || ids.has(rule.id)) throw new TypeError(`${where}: id must be unique kebab-case`);
		ids.add(rule.id);
		if (!Array.isArray(rule.tags) || rule.tags.length === 0 || !rule.tags.every(tag => typeof tag === 'string' && /^[a-z_]+:[a-z_]+$/.test(tag))) throw new TypeError(`${where}: tags must be kind:value strings`);
		if (typeof rule.when !== 'string' || typeof rule.do !== 'string') throw new TypeError(`${where}: when and do must be text`);
		return Object.freeze({ id: rule.id, tags: Object.freeze([...rule.tags]), when: rule.when, do: rule.do, priority: [1, 2, 3].includes(rule.priority) ? rule.priority : 1 });
	}));
}

/** MINEAGEN_INSTINCT_BOOK names the book file; unset or "off" means no instinct lines. */
export function instinctBookPath(environment = {}) {
	const value = String(environment?.MINEAGEN_INSTINCT_BOOK ?? '').trim();
	return value === '' || value.toLowerCase() === 'off' ? null : value;
}

/**
 * The situation in book tags from one observation, plus what the observation cannot tell (unknown). Only perceived
 * facts: the inventory is fully known, so every item is has: or lacks:; place and stage are inferred conservatively.
 */
export function situationTags(observation, { trigger = null, enteredDimension = false } = {}) {
	const tags = new Set(), unknown = [];
	const player = observation?.player ?? {};
	const dim = DIMENSION[observation?.world?.dimension ?? observation?.dimension] ?? null;
	if (dim !== null) tags.add(`dim:${dim}`); else unknown.push('dim');
	const health = Number(player.health);
	if (Number.isFinite(health)) tags.add(health <= 8 ? 'health:low' : health <= 14 ? 'health:mid' : 'health:full'); else unknown.push('health');
	const food = Number(player.foodLevel);
	if (Number.isFinite(food)) tags.add(food <= 14 ? 'hunger:low' : 'hunger:ok'); else unknown.push('hunger');
	const dayTime = Number(observation?.world?.dayTime);
	if (dim === 'overworld' && Number.isFinite(dayTime)) {
		const d = ((dayTime % 24000) + 24000) % 24000;
		tags.add(`time:${d >= 13000 && d < 23000 ? 'night' : d >= 12000 && d < 13000 ? 'dusk' : 'day'}`);
		if (d >= NIGHT_FALLS[0] && d < NIGHT_FALLS[1]) tags.add('event:night_falls');
	}
	for (const event of TRIGGER_EVENTS[trigger] ?? []) tags.add(`event:${event}`);
	const resultEvent = RESULT_EVENTS[observation?.lastResult?.reasonCode];
	if (resultEvent !== undefined) tags.add(`event:${resultEvent}`);
	if (enteredDimension) tags.add('event:entered_dim');
	const items = (Array.isArray(observation?.inventory?.items) ? observation.inventory.items : []).filter(item => item && typeof item.itemId === 'string');
	const count = re => items.filter(item => re.test(SHORT(item.itemId))).reduce((n, item) => n + (Number(item.count) || 1), 0);
	const held = re => count(re) > 0;
	const worn = items.filter(item => WORN.has(item.slot) && ARMOUR.test(SHORT(item.itemId)));
	const pickIron = held(/^(iron|diamond|netherite)_pickaxe$/);
	const kit = {
		shield: held(/^shield$/), food: held(FOOD), cooked_food: held(COOKED), iron_pickaxe: pickIron, stone_pickaxe: pickIron || held(/^(stone|copper)_pickaxe$/),
		diamond_pickaxe: held(/^(diamond|netherite)_pickaxe$/), sword: held(/_sword$/), axe: held(/_axe$/), bow: held(/^(bow|crossbow)$/),
		armor: worn.length > 0, gold_armor: worn.some(item => SHORT(item.itemId).startsWith('golden_')), bucket: held(/^bucket$/), water_bucket: held(/^water_bucket$/),
		lava_bucket: held(/^lava_bucket$/), flint_and_steel: held(/^flint_and_steel$/), bed: held(/_bed$/), blocks: count(BLOCKS) >= 16, torches: held(/^torch$/),
		obsidian: held(/^obsidian$/), ender_pearls: held(/^ender_pearl$/), blaze_rods: held(/^blaze_rod$/), eyes_of_ender: held(/^ender_eye$/),
		iron: held(/^(iron_ingot|raw_iron)$/), gold: held(/^(gold_ingot|raw_gold)$/) || count(/^gold_nugget$/) >= 9, crafting_table: held(/^crafting_table$/),
		furnace: held(/^furnace$/), boat: held(/_boat$/),
	};
	for (const [item, has] of Object.entries(kit)) tags.add(`${has ? 'has' : 'lacks'}:${item}`);
	// Stage: the furthest of what the body holds and where it is.
	const buckets = count(/^(bucket|water_bucket|lava_bucket)$/);
	// Eye supply in rod and pearl terms: a rod makes two powder, each eye took one powder and one pearl. In the Nether the
	// stage moves on only once the supply makes the 12 eyes the End needs.
	const eyes = count(/^ender_eye$/), powder = count(/^blaze_powder$/);
	const rodsShort = count(/^blaze_rod$/) * 2 + powder + eyes < 12, pearlsShort = count(/^ender_pearl$/) + eyes < 12;
	const eyeStage = dim === 'nether' ? !rodsShort && !pearlsShort : kit.eyes_of_ender || ((kit.blaze_rods || powder > 0) && count(/^ender_pearl$/) >= 6);
	const stage = dim === 'end' ? 'end' : eyeStage ? 'eyes' : dim === 'nether' ? 'nether'
		: pickIron && buckets >= 1 && kit.flint_and_steel ? 'portal' : pickIron ? 'iron' : kit.stone_pickaxe ? 'stone' : 'start';
	tags.add(`stage:${stage}`);
	const need = new Set();
	if (stage === 'start') need.add(held(/^wooden_pickaxe$/) ? 'stone' : 'wood');
	if (stage === 'stone' || (stage === 'iron' && (!kit.shield || buckets < 2 || !kit.flint_and_steel))) need.add('iron');
	if (stage === 'portal' && count(/^obsidian$/) < 10) need.add('portal').add('obsidian').add('lava');
	if (stage === 'nether') { if (rodsShort) need.add('blaze_rods'); if (pearlsShort) need.add('ender_pearls'); }
	if (stage === 'eyes') need.add('stronghold');
	if (count(FOOD) < 4) need.add('food');
	// Place: underground below y 56 in the Overworld, surface at 64 and up; a cave the body reports seeing counts as one.
	const y = Number(player.y);
	const caves = Array.isArray(observation?.sighted?.caves) && observation.sighted.caves.length > 0;
	const blocks = [...(Array.isArray(observation?.blocks) ? observation.blocks : []), ...(Array.isArray(observation?.landmarks) ? observation.landmarks : [])];
	const near = block => Number.isFinite(block?.distance) ? block.distance <= 8
		: [block?.x, block?.y, block?.z, player.x, player.y, player.z].every(Number.isFinite) && Math.hypot(block.x - player.x, block.y - player.y, block.z - player.z) <= 8;
	if (blocks.some(block => block?.blockId === 'minecraft:lava' && near(block))) tags.add('place:near_lava');
	if (dim === 'overworld' && Number.isFinite(y)) {
		if (y < 56) { tags.add('place:underground'); if (caves) tags.add('place:cave'); }
		else if (y >= 64) tags.add('place:surface');
		else unknown.push('place');
	}
	if (tags.has('time:night') && tags.has('place:surface') && !kit.armor) need.add('shelter');
	for (const thing of need) tags.add(`need:${thing}`);
	// Threats: the body's sensed threats (player.threats) and hostiles in view, within range now; three or more
	// distinct ones is many. A row with no known distance is not taken as near.
	// A mob in view that the body reports calm (hostile:false, not targeting the agent) is no threat; a sensed one still is.
	const calm = row => row?.hostile === false && row?.targetingAgent !== true;
	const rows = [...(Array.isArray(player.threats) ? player.threats : []), ...(Array.isArray(observation?.entities) ? observation.entities.filter(row => !calm(row)) : [])];
	const hostiles = new Map();
	for (const row of rows) {
		const type = SHORT(row?.type);
		if (!HOSTILE.has(type) || !Number.isFinite(row.distance) || row.distance > THREAT_RANGE) continue;
		hostiles.set(row.stableId ?? row.uuid ?? `${type}@${row.distance}`, type);
	}
	for (const type of hostiles.values()) tags.add(`threat:${MOB_TAG[type] ?? type}`);
	if (hostiles.size >= 3) tags.add('threat:many');
	if (player.onFire === true || Number(player.fireTicks) > 0) tags.add('event:on_fire');
	if (player.inLava === true) tags.add('event:in_lava');
	return { tags: [...tags], unknown };
}

/** How specific a rule is: the summed weight of its tags. */
export function ruleWeight(rule) {
	return rule.tags.reduce((sum, tag) => sum + (ACUTE[tag] ?? TAG_WEIGHT[tag.slice(0, tag.indexOf(':'))] ?? 1), 0);
}

/**
 * The rules that hold now, scored by specificity plus priority (a life-saving rule counts as one more matching tag): every tag of a rule must be among the situation's
 * tags. Ambient rules (true almost everywhere) are left out. Returns [{ rule, weight }].
 */
export function rankRules(rules, tags, { limit = INSTINCT_LINES } = {}) {
	const now = new Set(tags);
	return rules
		.filter(rule => rule.tags.every(tag => now.has(tag)))
		.map(rule => ({ rule, weight: ruleWeight(rule) }))
		.filter(row => row.weight >= AMBIENT_WEIGHT)
		.sort((a, b) => (b.weight + b.rule.priority) - (a.weight + a.rule.priority) || a.rule.id.localeCompare(b.rule.id))
		.slice(0, limit);
}

/** The now.instinct lines for one observation: "<id>: when <when> -> <do>", bounded; null when none hold. */
export function instinctLines(rules, observation, { limit = INSTINCT_LINES, trigger = null, enteredDimension = false } = {}) {
	if (!Array.isArray(rules) || rules.length === 0) return null;
	const ranked = rankRules(rules, situationTags(observation, { trigger, enteredDimension }).tags, { limit });
	if (ranked.length === 0) return null;
	return ranked.map(({ rule }) => {
		const line = `${rule.id}: ${rule.when.replace(/\.$/, '')} -> ${rule.do}`;
		return line.length <= INSTINCT_LINE_CHARS ? line : `${line.slice(0, INSTINCT_LINE_CHARS - 3)}...`;
	});
}
