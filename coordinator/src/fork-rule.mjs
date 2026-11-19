// The low-health fork rule: what a body at low health does by itself (eat carried food, or let health regenerate while
// it waits) and when the choice is the model's (a fork, named with its numbers). Pure, and the one eat path: obtain's
// recovery eats through eatCalls, and the model's heal options (dynamic-main.mjs healingOptions) name the same calls.
import { searchDanger } from './search-danger.mjs';

// Vanilla regenerates health only while the food bar is at 18 or more (any level in Peaceful).
export const REGENERATING_FOOD_LEVEL = 18;
// Natural regeneration spends 6 exhaustion per health point: 1.5 food points of saturation or food bar.
const FOOD_PER_HEALTH = 1.5;
// Regeneration is waited out until health reaches this (eating aims higher; see obtain-runner.mjs recover()).
export const REGEN_RESUME_HEALTH = 10;

/** What in the body's own state is danger now: in lava, burning, suffocating, air nearly gone, falling far. */
export function bodyDanger(o) {
	const p = o?.player ?? {};
	if (p.inLava) return 'in lava';
	if (p.onFire) return 'on fire';
	if (p.suffocating) return 'suffocating';
	if (Number.isFinite(p.air) && Number.isFinite(p.maxAir) && p.air < p.maxAir / 3) return `air ${p.air}/${p.maxAir}`;
	if (Number.isFinite(p.fallDistance) && p.fallDistance > 4) return `falling ${Math.round(p.fallDistance)} blocks`;
	return null;
}

/**
 * Whether health regenerates on its own, as vanilla decides it: never with the naturalRegeneration gamerule off; in
 * Peaceful at any food level; otherwise only while the food bar is 18 or more. Null when the food level is unknown.
 */
export function naturalRegeneration(player, world) {
	if (world?.naturalRegeneration === false) return false;
	if (world?.difficulty === 'peaceful') return true;
	return Number.isFinite(player?.foodLevel) ? player.foodLevel >= REGENERATING_FOOD_LEVEL : null;
}

/**
 * The carried food that can be eaten right now: the server's healFood (best safe food edible at this hunger, sent when it
 * differs from bestFood), else bestFood when it is edible now. Steak at full hunger cannot start eating; a golden apple can.
 */
export function carriedFoodToEat(facts) {
	if (facts?.healFood?.itemId) return facts.healFood;
	const food = facts?.bestFood;
	if (!food?.itemId) return null;
	return food.alwaysEdible === true || !(Number.isFinite(facts.foodLevel) && facts.foodLevel >= 20) ? food : null;
}

// The offhand's inventory slot: its food is eaten with the off hand, with nothing to select.
const OFFHAND_SLOT = 40;

/**
 * The body calls that eat one carried food ({slot, itemId}): select it on the hotbar (or bring it there from slots 9-35
 * into the selected slot), then hold use for 2 s (eating takes 1.6 s); offhand food is used with the off hand. Null for a
 * slot no call reaches (armor slots).
 */
export function eatCalls(food, selectedSlot = 0) {
	if (food.slot === OFFHAND_SLOT) return [{ actionType: 'use_item', arguments: { durationMs: 2000, hand: 'off' } }];
	if (!Number.isSafeInteger(food.slot) || food.slot < 0 || food.slot > 35) return null;
	const use = { actionType: 'use_item', arguments: { durationMs: 2000, expectedItemId: food.itemId } };
	if (food.slot <= 8) return [{ actionType: 'select_item', arguments: { itemId: food.itemId } }, use];
	const hotbarSlot = Number.isSafeInteger(selectedSlot) && selectedSlot >= 0 && selectedSlot <= 8 ? selectedSlot : 0;
	return [{ actionType: 'select_tool', arguments: { sourceSlot: food.slot, hotbarSlot, expectedItemId: food.itemId, minRemainingDurability: 0 } }, use];
}

/**
 * What a body at low health does now: { fork, starved? } (the model's choice, with the reason), { recover: 'eat', food } or
 * { recover: 'regen' }. A body hazard or a mob search-danger cannot leave alone is a fork, and so is a mob it would fight:
 * recovery does not fight. Then carried food it can eat, then regeneration that the saturation and food bar above 17 can
 * pay for up to REGEN_RESUME_HEALTH. Facts the sample lacks count as no food and no regeneration: a fork, never a wait.
 */
export function lowHealthFork(o) {
	const hazard = bodyDanger(o);
	if (hazard !== null) return { fork: hazard };
	const judged = searchDanger(o);
	if (judged?.fork !== undefined) return { fork: judged.fork };
	if (judged?.handle === 'fight') return { fork: `${judged.why}: recovering does not fight` };
	const player = o?.player ?? {};
	const food = player.canHealNow === true ? carriedFoodToEat(player) : null;
	if (food !== null && eatCalls(food) !== null) return { recover: 'eat', food };
	const health = Number.isFinite(player.health) ? player.health : null;
	const level = Number.isFinite(player.foodLevel) ? player.foodLevel : null;
	const saturation = Number.isFinite(player.saturation) ? player.saturation : null;
	const regen = naturalRegeneration(player, o?.world);
	const numbers = `health ${health ?? '?'}, food ${level ?? '?'}, saturation ${saturation ?? '?'}`;
	// starved: the fork is only the lack of food or regeneration, not danger (a body already back near the line may go on).
	if (o?.world?.naturalRegeneration === false) return { fork: `${numbers}: no food to eat and natural regeneration is off`, starved: true };
	if (regen === true && health !== null) {
		if (o?.world?.difficulty === 'peaceful') return { recover: 'regen' };
		const budget = (saturation ?? 0) + Math.max(0, (level ?? 0) - 17);
		if (budget >= FOOD_PER_HEALTH * Math.max(0, REGEN_RESUME_HEALTH - health)) return { recover: 'regen' };
	}
	return { fork: `${numbers}: no food to eat, and regeneration (food 18 or more) cannot pay for the climb to ${REGEN_RESUME_HEALTH}`, starved: true };
}
