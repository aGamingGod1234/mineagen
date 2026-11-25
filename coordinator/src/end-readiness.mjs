// End readiness (late-game wall, order 11b): what the End fight wants carried, and the fixes in reach now. A note on the
// route line, never its head: no fresh game ever carried a bow into the End, and staged End starts died to breath and
// falls. Only fixes whose inputs are held or in view are named (the in-reach gate); an obtain of a kit item that handed
// back this life drops that fix (the release), so the note never holds the route.

const id = value => String(value ?? '').replace(/^minecraft:/, '');
const ARMOUR_SLOTS = new Set(['head', 'chest', 'legs', 'feet']);
const FOOD = /^(cooked_(beef|porkchop|mutton|chicken|rabbit|cod|salmon)|bread|baked_potato|golden_carrot|pumpkin_pie|rabbit_stew|mushroom_stew|beetroot_soup|beef|porkchop|mutton|chicken|rabbit|cod|salmon|apple|carrot|potato|sweet_berries|glow_berries|melon_slice|beetroot|cookie|dried_kelp|golden_apple)$/;
const RAW_MEAT = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/;
const BLOCKS = /^(cobblestone|cobbled_deepslate|dirt|stone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt|end_stone|netherrack|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|[a-z_]+_planks)$/;
const MINEABLE = /^minecraft:(stone|deepslate|cobblestone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|end_stone|andesite|diorite|granite|tuff)$/;
const WOOL = /^([a-z_]+)_wool$/;

export const END_KIT = Object.freeze({ arrows: 32, food: 16, blocks: 32, pillarBlocks: 64 });

/** Kit item ids whose obtain hands back release that fix: the ids the fixes below ask obtain for. */
export const KIT_ITEMS = /^minecraft:(arrow|bow|water_bucket|[a-z_]+_bed|cooked_(beef|porkchop|mutton|chicken|rabbit|cod|salmon)|cobblestone|iron_chestplate|iron_boots|shield)$/;

/**
 * { missing: [short names], fixes: [obtain steps] } for the End kit, or null without a fresh live sample.
 * handedBack: kit item ids (minecraft:...) whose obtain came back failed this life.
 */
export function endKit(o, { handedBack = new Set() } = {}) {
	const stale = section => o?.continuity?.rememberedSections?.includes(section);
	if (o?.ready !== true || o.player?.dead === true || stale('inventory') || !Array.isArray(o.inventory?.items)) return null;
	const items = o.inventory.items.filter(i => i?.count > 0);
	const count = re => items.filter(i => re.test(id(i.itemId))).reduce((n, i) => n + i.count, 0);
	const released = item => handedBack.has(`minecraft:${item}`);
	const seen = stale('blocks') ? [] : [...(o.blocks ?? []), ...(o.landmarks ?? [])].filter(b => b?.visible !== false && b?.remembered !== true);
	const missing = [], fixes = [];
	const fix = (item, step) => { if (!released(item)) fixes.push(step); };
	const pickaxe = count(/_pickaxe$/) > 0;
	const blocks = count(BLOCKS);

	const bow = count(/^bow$/) > 0, arrows = count(/^(arrow|spectral_arrow|tipped_arrow)$/);
	// Arrow-free: pillar up to each crystal and break it by hand, which takes blocks.
	const arrowFree = !bow && blocks >= END_KIT.pillarBlocks;
	if (!bow && !arrowFree) {
		missing.push(`bow (or ${END_KIT.pillarBlocks} blocks to pillar to crystals)`);
		if (count(/^string$/) >= 3 && (count(/^stick$/) >= 3 || count(/_planks$/) >= 2 || count(/_(log|stem)$/) >= 1)) fix('bow', 'obtain bow');
	}
	if (bow && arrows < END_KIT.arrows) {
		missing.push(`arrows ${arrows}/${END_KIT.arrows}`);
		const flint = count(/^flint$/), feathers = count(/^feather$/);
		const sets = Math.min(flint, feathers);
		if (sets > 0 && (count(/^stick$/) > 0 || count(/_planks$/) > 0 || count(/_(log|stem)$/) > 0)) fix('arrow', `obtain arrow count ${arrows + Math.min(sets * 4, END_KIT.arrows - arrows + 3)}`);
	}
	const worn = items.filter(i => ARMOUR_SLOTS.has(i.slot) && !/^golden_/.test(id(i.itemId))).length;
	if (worn < 2) {
		missing.push(`armour ${worn}/2 worn`);
		if (!items.some(i => i.slot === 'chest') && count(/^iron_ingot$/) >= 8) fix('iron_chestplate', 'obtain iron_chestplate, then equip_item it');
	}
	const food = count(FOOD);
	if (food < END_KIT.food) {
		missing.push(`food ${food}/${END_KIT.food}`);
		const raw = items.find(i => RAW_MEAT.test(id(i.itemId)));
		if (raw) fix(`cooked_${id(raw.itemId)}`, `obtain cooked_${id(raw.itemId)} count ${count(new RegExp(`^cooked_${id(raw.itemId)}$`)) + raw.count}`);
	}
	if (blocks < END_KIT.blocks) {
		missing.push(`blocks ${blocks}/${END_KIT.blocks}`);
		if (pickaxe && seen.some(b => MINEABLE.test(b.blockId ?? ''))) fix('cobblestone', `obtain cobblestone count ${count(/^cobblestone$/) + END_KIT.blocks - blocks}`);
	}
	if (count(/^water_bucket$/) === 0) {
		missing.push('water bucket');
		if (count(/^bucket$/) > 0 && seen.some(b => b.blockId === 'minecraft:water')) fix('water_bucket', 'obtain water_bucket');
	}
	if (count(/_bed$/) === 0) {
		missing.push('bed');
		const wool = new Map();
		for (const i of items) { const m = WOOL.exec(id(i.itemId)); if (m) wool.set(m[1], (wool.get(m[1]) ?? 0) + i.count); }
		const colour = [...wool].find(([, n]) => n >= 3)?.[0];
		if (colour) fix(`${colour}_bed`, `obtain ${colour}_bed`);
	}
	return { missing, fixes };
}

/** The route-line note: fixes in reach first, then what is still missing; null with a full kit. */
export function endKitNote(o, options) {
	const kit = endKit(o, options);
	if (kit === null || kit.missing.length === 0) return null;
	const fixes = kit.fixes.length > 0 ? `${kit.fixes.join(', ')}; ` : '';
	return `End kit: ${fixes}lacks ${kit.missing.join(', ')}`;
}
