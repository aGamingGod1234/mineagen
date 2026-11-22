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
 * stays in the chest. read: the chest's slots were read (it now counts as opened). The close is sent even when a stop
 * cut the taking short; closed: false when it did not land (the caller closes the screen at its next step).
 */
/** A block's faces, the one most toward an eye at `from` ({ x, y (feet), z }) first; the top first without one. */
export function facesToward(cell, from) {
	const all = ['up', 'north', 'south', 'east', 'west', 'down'];
	if (![from?.x, from?.y, from?.z].every(Number.isFinite)) return all;
	const dx = from.x - (cell.x + 0.5), dz = from.z - (cell.z + 0.5), eye = from.y + 1.62;
	const side = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
	const other = Math.abs(dx) >= Math.abs(dz) ? (dz > 0 ? 'south' : 'north') : (dx > 0 ? 'east' : 'west');
	const first = eye > cell.y + 2 ? ['up', side, other] : [side, other, 'up'];
	return [...first, ...all.filter((face) => !first.includes(face))];
}

export async function lootChest(body, cell, { wanted = [], heldItem = 'minecraft:air', from = null } = {}) {
	const take = (id) => wanted.includes(bare(id)) || LOOT_KEEP.test(bare(id));
	// The face toward the eye first (the top only from above), then the others: a chest's top under a roof or a wall
	// between is TARGET_OBSTRUCTED from where the body stands.
	let opened = null;
	for (const face of facesToward(cell, from)) {
		opened = await body.act('interact_block', { x: cell.x, y: cell.y, z: cell.z, face, hand: 'main', expectedItemId: heldItem });
		if (opened?.reasonCode !== 'TARGET_OBSTRUCTED') break;
	}
	if (opened?.state !== 'SUCCEEDED') return { ok: false, read: false, taken: {}, why: `open the chest at ${cell.x},${cell.y},${cell.z}: ${opened?.reasonCode ?? 'failed'}` };
	const taken = {};
	let menu = null, stuck = null, read = false, closed = null;
	try {
	for (let turn = 0; turn < MAX_TAKES; turn++) {
		let page;
		try { page = await body.menu(); } catch (error) { stuck = `menu unreadable: ${String(error?.message ?? error).slice(0, 80)}`; break; }
		// The runtime's player view names a container screen by menuId (visibleMenu); the raw inspection by type.
		menu = page?.menu ? { ...page.menu, type: page.menu.menuId ?? page.menu.type } : null;
		if (!menu || !/chest|generic_9x|barrel/.test(String(menu.type ?? ''))) { stuck = `no chest menu open (${menu?.type ?? 'none'}; page ${Object.keys(page ?? {}).slice(0, 8).join(',')}${page?.state ? ` ${page.state}` : ''})`; menu = null; break; }
		read = true;
		const chestSlots = Math.max(0, (menu.slotCount ?? 0) - PLAYER_SLOTS);
		// What the plan asked for first, then what a player keeps: a full inventory takes the wanted stacks.
		const candidates = pageRows(page).filter((row) => Number.isSafeInteger(row.slot) && row.slot < chestSlots && row.count > 0
			&& bare(row.itemId) !== 'air' && take(row.itemId) && !(taken[`skip:${row.slot}`]));
		const next = candidates.find((row) => wanted.includes(bare(row.itemId))) ?? candidates[0];
		if (!next) break;
		const result = await body.act('menu_click', { menuId: menu.type, containerId: menu.containerId, stateId: menu.stateId, slot: next.slot, button: 0,
			clickType: 'QUICK_MOVE', expectedItemId: next.itemId, expectedCount: next.count, ...(next.fingerprint ? { expectedFingerprint: next.fingerprint } : {}) });
		if (['INTERRUPTED', 'CANCELLED', 'TIMED_OUT'].includes(result?.state)) { stuck = `stopped: ${result.reasonCode ?? result.state}`; break; }
		if (result?.state !== 'SUCCEEDED' || result.reasonCode === 'MENU_INPUT_NO_CHANGE') { taken[`skip:${next.slot}`] = true; continue; }
		taken[bare(next.itemId)] = (taken[bare(next.itemId)] ?? 0) + next.count;
	}
	} finally {
	if (menu) {
		try {
			const last = await body.menu();
			const m = last?.menu ? { ...last.menu, type: last.menu.menuId ?? last.menu.type } : menu;
			const shut = await body.act('menu_close', { menuId: m.type, containerId: m.containerId, stateId: m.stateId });
			closed = shut?.state === 'SUCCEEDED';
		} catch { closed = false; }
	}
	}
	for (const key of Object.keys(taken)) if (key.startsWith('skip:')) delete taken[key];
	return { ok: stuck === null && closed !== false, read, closed, stopped: stuck !== null && stuck.startsWith('stopped'), taken, why: stuck ?? (closed === false ? 'the chest did not close' : null) };
}
