// The route room's stand-in (test-iron-kit-live.mjs).
import { scoreboardCounter } from './damage-counter.mjs';

/** The full iron kit: an iron (or better) pickaxe, a shield, two buckets (any fill) and flint and steel. */
export function kitHeld(o) {
	const items = (o?.inventory?.items ?? []).filter(i => i?.count > 0);
	const count = re => items.filter(i => re.test(i.itemId ?? '')).reduce((n, i) => n + i.count, 0);
	return count(/^minecraft:(iron|diamond|netherite)_pickaxe$/) > 0 && count(/^minecraft:shield$/) > 0
		&& count(/^minecraft:(bucket|water_bucket|lava_bucket)$/) >= 2 && count(/^minecraft:flint_and_steel$/) > 0;
}

/** Time in minutes when a full kit is seen within the lane's budget. */
export function kitMinutes(o, elapsedMs, budgetMs) {
	return elapsedMs <= budgetMs && kitHeld(o) ? Math.round(elapsedMs / 600) / 100 : null;
}

export function routeToolTimeout(kind, remainingMs) {
	// The obtain tool requires at least one minute. Leave the call unstarted when it cannot fit.
	const minimum = kind === 'obtain' ? 60_000 : 1;
	const limit = kind === 'obtain' ? 1_200_000 : 120_000;
	return remainingMs >= minimum ? Math.min(limit, remainingMs) : null;
}

/** Unset counters count as zero. Any unreadable counter makes the total unknown. */
export async function kitStatTotal(command, agent, objectives) {
	let total = 0;
	for (const objective of objectives) {
		const score = await scoreboardCounter(command, agent, objective, { unsetIsZero: true }).catch(() => null);
		if (score === null) return null;
		total += score;
	}
	return total;
}

/**
 * The first call a route line names, as a model reading it would make it: { kind: 'obtain', item, count } |
 * { kind: 'find_animal' } | { kind: 'equip_shield' } | null. A low-hunger suffix ("obtain cooked_beef on the way") is
 * taken first: a hungry player eats before going on.
 */
export function routeCall(line) {
	const text = String(line ?? '').replace(/^usual next step:\s*/, '').replace(/\s*\([^()]*\)\s*$/, '');
	const restock = /low hunger\/health, food \d+ held: obtain ([a-z_]+)/.exec(text);
	if (restock) return { kind: 'obtain', item: restock[1], count: null, restock: true };
	if (/^equip_item shield/.test(text)) return { kind: 'equip_shield' };
	if (/^look for nearby cows/.test(text)) return { kind: 'find_animal' };
	const obtain = /obtain ([#a-z_:]+)(?: count (\d+))?/.exec(text);
	if (obtain) return { kind: 'obtain', item: obtain[1].replace(/^minecraft:/, ''), count: obtain[2] ? Number(obtain[2]) : null, then: /then equip_item it to offhand/.test(text) ? 'equip_shield' : null };
	return null;
}
