// obtain's loot step: open one chest the body stands by, take what the plan needs and what a player keeps (LOOT_KEEP),
// close it. The chest's contents are rolled when it is first opened, so they are read from the open menu, never guessed.
import { LOOT_KEEP } from './loot-sources.mjs';

const PLAYER_SLOTS = 36;
const MAX_TAKES = 27;
const bare = (value) => String(value ?? '').replace(/^minecraft:/, '');

/** Rows of an inspected page: plain entries or the compact { $rows: { columns, rows } } form. */
export function pageRows(page) {
	const entries = page?.entries;
	if (Array.isArray(entries)) return entries;
	if (entries?.$rows) return entries.$rows.rows.map((row) => Object.fromEntries(entries.$rows.columns.map((column, index) => [column, row[index]])));
	return [];
}

/**
 * Opens the chest at cell, takes every stack of `wanted` (bare ids) or LOOT_KEEP, closes it. body: { act(type, args),
 * menu() -> inspected 'menu' page, observe() }. Returns { ok, taken: { id: count }, why }. A stack that no longer fits
 * stays in the chest; the chest still counts as opened.
 */
export async function lootChest(body, cell, { wanted = [], heldItem = 'minecraft:air' } = {}) {
	const take = (id) => wanted.includes(bare(id)) || LOOT_KEEP.test(bare(id));
	const opened = await body.act('interact_block', { x: cell.x, y: cell.y, z: cell.z, face: 'up', hand: 'main', expectedItemId: heldItem });
	if (opened?.state !== 'SUCCEEDED') return { ok: false, taken: {}, why: `open the chest at ${cell.x},${cell.y},${cell.z}: ${opened?.reasonCode ?? 'failed'}` };
	const taken = {};
	let menu = null, stuck = null;
	for (let turn = 0; turn < MAX_TAKES; turn++) {
		let page;
		try { page = await body.menu(); } catch (error) { stuck = `menu unreadable: ${String(error?.message ?? error).slice(0, 80)}`; break; }
		menu = page?.menu ?? null;
		if (!menu || !/chest|generic_9x|barrel/.test(String(menu.type ?? ''))) { stuck = `no chest menu open (${menu?.type ?? 'none'})`; menu = null; break; }
		const chestSlots = Math.max(0, (menu.slotCount ?? 0) - PLAYER_SLOTS);
		const next = pageRows(page).find((row) => Number.isSafeInteger(row.slot) && row.slot < chestSlots && row.count > 0
			&& bare(row.itemId) !== 'air' && take(row.itemId) && !(taken[`skip:${row.slot}`]));
		if (!next) break;
		const result = await body.act('menu_click', { menuId: menu.type, containerId: menu.containerId, stateId: menu.stateId, slot: next.slot, button: 0,
			clickType: 'QUICK_MOVE', expectedItemId: next.itemId, expectedCount: next.count, ...(next.fingerprint ? { expectedFingerprint: next.fingerprint } : {}) });
		if (result?.state !== 'SUCCEEDED' || result.reasonCode === 'MENU_INPUT_NO_CHANGE') { taken[`skip:${next.slot}`] = true; continue; }
		taken[bare(next.itemId)] = (taken[bare(next.itemId)] ?? 0) + next.count;
	}
	if (menu) {
		try {
			const last = await body.menu();
			const m = last?.menu ?? menu;
			await body.act('menu_close', { menuId: m.type, containerId: m.containerId, stateId: m.stateId });
		} catch { /* a menu that closed on its own needs no close */ }
	}
	for (const key of Object.keys(taken)) if (key.startsWith('skip:')) delete taken[key];
	return { ok: stuck === null, taken, why: stuck };
}
