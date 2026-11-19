// The kit habit: game sense the body keeps on its own after each obtain that succeeds, from what it already holds and
// with no extra mining: a shield in the off hand, iron armour worn from spare iron, food in reach of the eat reflex.
// CP2r (16 games): the shield was owned 45-53% of the time, lost only by dying and back after 2 of 11 such deaths;
// armour was worn in 0 of 16 games though 12 of them held 9+ iron at some point; the eat reflex slept 53-66% of the
// time with no food in the hotbar; and the model followed route advice for these steps in about a third of cases.

/** The habit stays out of the way while hurt: low health is recovery's job, not kit's. */
export const KIT_MIN_HEALTH = 10;
/** Most steps one obtain adds: a craft and its equip, a hotbar move and an equip left over from before. */
export const KIT_MAX_STEPS = 4;
/** Each kit craft runs from held materials, so it needs no search; a minute covers placing a table and crafting. */
export const KIT_CRAFT_TIMEOUT_MS = 60_000;

const FOOD = /^minecraft:(cooked_(beef|porkchop|mutton|chicken|rabbit|cod|salmon)|bread|baked_potato|golden_carrot|pumpkin_pie|rabbit_stew|mushroom_stew|beetroot_soup|beef|porkchop|mutton|rabbit|cod|salmon|apple|carrot|potato|sweet_berries|glow_berries|melon_slice|beetroot|cookie|dried_kelp)$/;
// Iron pieces in the order of armour points per iron (chestplate 6 for 8, leggings 5 for 7, boots 2 for 4, helmet 2 for 5).
const ARMOUR = Object.freeze([
	{ itemId: 'minecraft:iron_chestplate', slot: 'chest', iron: 8, part: /_chestplate$/ },
	{ itemId: 'minecraft:iron_leggings', slot: 'legs', iron: 7, part: /_leggings$/ },
	{ itemId: 'minecraft:iron_boots', slot: 'feet', iron: 4, part: /_boots$/ },
	{ itemId: 'minecraft:iron_helmet', slot: 'head', iron: 5, part: /_helmet$/ },
]);
const PLANKS = /^minecraft:[a-z_]+_planks$/;
const LOGS = /^minecraft:[a-z_]+_(log|wood|stem|hyphae)$/;

const numbered = item => Number.isInteger(item.slot) && item.slot >= 0 && item.slot <= 35;
const inHotbar = item => item.slot === 'mainhand' || item.slot === 'offhand' || item.hotbar === true || Number.isInteger(item.slot) && item.slot <= 8;

/**
 * Iron the rest of the route still needs from what is held now: an iron pickaxe (3), the shield (1), two buckets (3
 * each, a filled one counts) and flint and steel (1). Only iron beyond this goes to armour, so the habit never slows the
 * route to the portal.
 */
export function ironReserved(items) {
	const has = re => items.some(item => re.test(item.itemId ?? ''));
	const buckets = items.filter(item => /^minecraft:(bucket|water_bucket|lava_bucket)$/.test(item.itemId ?? '')).reduce((n, item) => n + item.count, 0);
	return (has(/^minecraft:(iron|diamond|netherite)_pickaxe$/) ? 0 : 3) + (has(/^minecraft:shield$/) ? 0 : 1)
		+ Math.max(0, 2 - buckets) * 3 + (has(/^minecraft:flint_and_steel$/) ? 0 : 1);
}

/**
 * The next kit step from a fresh observation, or null when the kit is kept or the body is hurt:
 * {kind:'equip', sourceSlot, targetSlot, itemId}, {kind:'hotbar', sourceSlot, hotbarSlot, itemId} or {kind:'craft', itemId}.
 * Equips come first (free), then food in reach, then a shield, then one armour piece from spare iron.
 */
export function nextKitStep(o) {
	const items = (o?.inventory?.items ?? []).filter(item => item?.count > 0 && typeof item.itemId === 'string');
	if (!Array.isArray(o?.inventory?.items)) return null;
	const health = o?.player?.health;
	if (!Number.isFinite(health) || health < KIT_MIN_HEALTH) return null;
	const worn = slot => items.some(item => item.slot === slot);
	const shields = items.filter(item => item.itemId === 'minecraft:shield');
	if (!shields.some(item => item.slot === 'offhand' || item.slot === 'mainhand')) {
		const stored = shields.find(numbered);
		if (stored) return { kind: 'equip', sourceSlot: stored.slot, targetSlot: 'offhand', itemId: stored.itemId };
	}
	for (const piece of ARMOUR) {
		if (worn(piece.slot)) continue;
		const stored = items.find(item => numbered(item) && piece.part.test(item.itemId));
		if (stored) return { kind: 'equip', sourceSlot: stored.slot, targetSlot: piece.slot, itemId: stored.itemId };
	}
	const food = items.filter(item => FOOD.test(item.itemId));
	if (food.length > 0 && !food.some(inHotbar)) {
		const stored = food.find(numbered);
		const taken = new Set(items.filter(item => Number.isInteger(item.slot) && item.slot <= 8).map(item => item.slot));
		if (Number.isInteger(o.inventory.selectedSlot)) taken.add(o.inventory.selectedSlot);
		const free = [8, 7, 6, 5, 4, 3, 2, 1, 0].find(slot => !taken.has(slot));
		if (stored && free !== undefined) return { kind: 'hotbar', sourceSlot: stored.slot, hotbarSlot: free, itemId: stored.itemId };
	}
	const count = re => items.filter(item => re.test(item.itemId)).reduce((n, item) => n + item.count, 0);
	const ingots = count(/^minecraft:iron_ingot$/);
	const wood = count(PLANKS) + 4 * count(LOGS);
	// The iron pickaxe comes first: its 3 ingots are never spent on the shield (obtain iron_ingot count 3 for it would hand back 2).
	const pickaxeOwed = items.some(item => /^minecraft:(iron|diamond|netherite)_pickaxe$/.test(item.itemId)) ? 0 : 3;
	if (shields.length === 0 && ingots >= 1 + pickaxeOwed && wood >= 6) return { kind: 'craft', itemId: 'minecraft:shield' };
	const spare = ingots - ironReserved(items);
	for (const piece of ARMOUR) {
		if (worn(piece.slot) || items.some(item => piece.part.test(item.itemId))) continue;
		if (piece.iron <= spare) return { kind: 'craft', itemId: piece.itemId };
	}
	return null;
}

/** MINEAGEN_KIT_HABIT=off turns the habit off (an A/B round's off arm); it is on otherwise. */
export function kitHabitEnabled(environment = {}) {
	return String(environment?.MINEAGEN_KIT_HABIT ?? '').trim().toLowerCase() !== 'off';
}

/**
 * Runs kit steps after an obtain: body is obtain's body (observe, act), craft(itemId) runs a nested obtain for one held
 * item. Stops at the first step that does not succeed, a repeated craft, or KIT_MAX_STEPS. Returns the steps done.
 */
export async function keepKit(body, craft, { stopped = () => false } = {}) {
	const done = [], crafted = new Set();
	for (let index = 0; index < KIT_MAX_STEPS && !stopped(); index += 1) {
		const step = nextKitStep(await body.observe());
		if (step === null) break;
		let result;
		const name = step.itemId.replace(/^minecraft:/, '');
		if (step.kind === 'equip') result = await body.act('equip_item', { sourceSlot: step.sourceSlot, targetSlot: step.targetSlot, expectedItemId: step.itemId });
		else if (step.kind === 'hotbar') result = await body.act('select_tool', { sourceSlot: step.sourceSlot, hotbarSlot: step.hotbarSlot, expectedItemId: step.itemId, minRemainingDurability: 0 });
		else {
			if (crafted.has(step.itemId)) break;
			crafted.add(step.itemId);
			result = await craft(step.itemId);
		}
		if (result?.state !== 'SUCCEEDED') {
			done.push(`${step.kind} ${name} stopped (${result?.reasonCode ?? result?.state ?? 'no result'})`);
			break;
		}
		done.push(step.kind === 'equip' ? `wore ${name} (${step.targetSlot})` : step.kind === 'hotbar' ? `${name} to hotbar ${step.hotbarSlot}` : `crafted ${name}`);
	}
	return done;
}
