// InventoryMenu constants, verified against the native inventoryMenuSlot mapping and
// InventoryMenu's RESULT_SLOT/CRAFT_SLOT_START/INV_SLOT_START/USE_ROW_SLOT_END.
const MENU = 'minecraft:inventory', AIR = 'minecraft:air';
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const empty = (s) => s?.itemId === AIR && s.count === 0;
const same = (a, b) => a?.itemId === b?.itemId && a?.count === b?.count && a?.fingerprint === b?.fingerprint;
const fact = (s) => s && Object.fromEntries(['slot', 'itemId', 'count', 'fingerprint', 'damage', 'maxDamage'].filter(k => s[k] !== undefined).map(k => [k, s[k]]));
const usable = (s) => s?.count === 1 && Number.isSafeInteger(s.damage) && Number.isSafeInteger(s.maxDamage) && s.damage > 0 && s.damage < s.maxDamage;
const rows = (page) => Array.isArray(page.entries) ? page.entries : page.entries?.$rows
	? page.entries.$rows.rows.map(row => Object.fromEntries(page.entries.$rows.columns.map((k, i) => [k, row[i]]))) : [];

// Every page must belong to one unchanged menu. Missing rows are unknown, never empty.
async function snapshot(body) {
	let menu, entries = [];
	for (let offset = 0; offset < 46;) {
		const page = await body.inspect({ section: 'menu', offset, limit: 32 });
		const m = page.menu, c = page.coverage, part = rows(page);
		if (m?.type !== MENU || m.containerId !== 0 || !Number.isSafeInteger(m.stateId) || m.slotCount !== 46) fail('REPAIR_MENU_UNSUPPORTED');
		if (!menu) menu = m;
		if (m.stateId !== menu.stateId || !same(m.cursor, menu.cursor)) fail('MENU_STATE_CHANGED');
		if (c?.offset !== offset || c.total !== 46 || c.omittedEntry || !part.length || part.some((s, i) => s.slot !== offset + i || typeof s.fingerprint !== 'string'
			|| typeof s.itemId !== 'string' || !Number.isSafeInteger(s.count) || s.count < 0)) fail('REPAIR_MENU_INCOMPLETE');
		entries.push(...part);
		const next = offset + part.length;
		if (c.nextOffset !== next || c.hasMore !== (next < 46)) fail('REPAIR_MENU_INCOMPLETE');
		offset = next;
	}
	if (entries.length !== 46 || !menu.cursor || typeof menu.cursor.fingerprint !== 'string') fail('REPAIR_MENU_INCOMPLETE');
	return { menu, entries };
}

export async function runInventoryRepair(args, body) {
	let last = null, preview = null, producedAt = null, pending = null, clicks = 0, fresh = false;
	let state = 'FAILED', reasonCode = 'REPAIR_NOT_STARTED';
	const stop = () => { if (body.stopped()) fail('CANCELLED'); if (body.interrupted()) fail('DANGER'); };
	const read = async () => { fresh = false; const s = await snapshot(body); last = s; fresh = true; return s; };
	const click = async (slot, expected, cursor, observed = () => {}) => {
		stop();
		const before = await read();
		stop();
		if (before.menu.stateId !== lastExpected.menu.stateId || before.entries.some((s, i) => !same(s, lastExpected.entries[i])) || !same(before.menu.cursor, cursor)) fail('MENU_STATE_CHANGED');
		const s = before.entries[slot];
		if (!same(s, expected)) fail('SOURCE_MISMATCH');
		fresh = false;
		clicks++;
		let receipt;
		try { receipt = await body.act({ menuId: MENU, containerId: before.menu.containerId, stateId: before.menu.stateId,
			slot: s.slot, button: 0, clickType: 'PICKUP', expectedItemId: s.itemId, expectedCount: s.count, expectedFingerprint: s.fingerprint }); } catch (error) {
			if (error?.actionId && Number.isSafeInteger(error.goalRevision)) {
				pending = { actionId: error.actionId, goalRevision: error.goalRevision, state: 'UNKNOWN', reasonCode: 'DISPATCH_RESULT_UNKNOWN' };
				fail('REPAIR_ACTION_PENDING');
			}
			throw error;
		}
		if (['UNKNOWN', 'RUNNING', 'PREPARING', 'CANCELLING', 'CANCELLATION_UNCONFIRMED'].includes(receipt?.state)) { pending = receipt; fail('REPAIR_ACTION_PENDING'); }
		const after = await read();
		observed(after);
		// Even a failed/partial native receipt can have changed physical ownership.
		if (receipt?.state !== 'SUCCEEDED') fail(receipt?.reasonCode ?? 'REPAIR_CLICK_FAILED');
		stop();
		return after;
	};
	let lastExpected;
	try {
		// Also guard direct internal callers; normalized model calls require the same acknowledgement.
		if (args.allowComponentLoss !== true) fail('REPAIR_LOSS_ACK_REQUIRED');
		stop();
		lastExpected = await read();
		const { menu, entries } = lastExpected;
		if (menu.type !== args.menuId || menu.containerId !== args.containerId || menu.stateId !== args.stateId) fail('MENU_STATE_CHANGED');
		if (!empty(menu.cursor)) fail('REPAIR_CURSOR_OCCUPIED');
		if (entries.slice(0, 5).some(s => !empty(s))) fail('REPAIR_GRID_OCCUPIED');
		if (!Array.isArray(args.inputs) || args.inputs.length !== 2 || args.inputs[0].slot === args.inputs[1].slot) fail('REPAIR_INPUTS_INVALID');
		const inputs = args.inputs.map(input => {
			if (!Number.isSafeInteger(input.slot) || input.slot < 9 || input.slot >= 45) fail('REPAIR_INPUTS_INVALID');
			const s = entries[input.slot];
			if (s.fingerprint !== input.fingerprint || s.itemId !== args.itemId) fail('SOURCE_MISMATCH');
			if (!usable(s) || s.pickupAllowed !== true || !/^minecraft:(wooden|stone|copper|iron|golden|diamond|netherite)_pickaxe$/.test(s.itemId)) fail('REPAIR_INPUTS_UNSUPPORTED');
			return s;
		});
		if (inputs[0].maxDamage !== inputs[1].maxDamage) fail('REPAIR_INPUTS_UNSUPPORTED');
		const clear = menu.cursor;
		const transferMatches = (after, edits, carried) => same(after.menu.cursor, carried)
			&& after.entries.every((s, i) => i === 0 || same(s, edits[i] ?? lastExpected.entries[i]));
		const changed = (after, edits, carried) => {
			if (!transferMatches(after, edits, carried)) fail('REPAIR_OWNERSHIP_CHANGED');
			lastExpected = after;
		};
		for (let i = 0; i < 2; i++) {
			const source = inputs[i], grid = i + 1;
			let after = await click(source.slot, source, clear);
			changed(after, { [source.slot]: clear }, source);
			after = await click(grid, lastExpected.entries[grid], source);
			changed(after, { [grid]: source }, clear);
		}
		preview = lastExpected.entries[0];
		const remaining = s => s.maxDamage - s.damage;
		if (preview.itemId !== args.itemId || preview.count !== 1 || !preview.fingerprint || preview.pickupAllowed !== true
			|| !Number.isSafeInteger(preview.damage) || preview.damage < 0 || preview.maxDamage !== inputs[0].maxDamage
			|| !inputs.every(s => remaining(preview) > remaining(s))) fail('REPAIR_PREVIEW_INVALID');
		let after = await click(0, preview, clear, snapshot => {
			if (empty(snapshot.entries[0]) && transferMatches(snapshot, { 1: clear, 2: clear }, preview)) producedAt = 'cursor';
		});
		if (!empty(after.entries[0])) fail('REPAIR_RESULT_NOT_CONSUMED');
		changed(after, { 1: clear, 2: clear }, preview);
		after = await click(inputs[0].slot, lastExpected.entries[inputs[0].slot], preview, snapshot => {
			if (transferMatches(snapshot, { [inputs[0].slot]: preview }, clear)) producedAt = inputs[0].slot;
		});
		changed(after, { [inputs[0].slot]: preview }, clear);
		state = 'SUCCEEDED'; reasonCode = 'INVENTORY_REPAIRED';
	} catch (error) {
		reasonCode = body.stopped() ? 'CANCELLED' : body.interrupted() ? 'DANGER' : error?.code ?? 'REPAIR_INSPECTION_FAILED';
		// No retry, rollback or close: never move a stack whose ownership is now uncertain.
		if (reasonCode !== 'REPAIR_LOSS_ACK_REQUIRED') { try { await read(); } catch { fresh = false; } }
		if (body.stopped()) reasonCode = 'CANCELLED';
		else if (body.interrupted()) reasonCode = 'DANGER';
		state = reasonCode === 'CANCELLED' ? 'CANCELLED' : reasonCode === 'DANGER' ? 'INTERRUPTED' : 'FAILED';
	}
	const owned = last && { menuId: last.menu.type, containerId: last.menu.containerId, stateId: last.menu.stateId,
		cursor: fact(last.menu.cursor), grid: last.entries.slice(1, 5).map(fact), result: fact(last.entries[0]),
		inputs: (args.inputs ?? []).map(input => fact(last.entries[input.slot])) };
	// A matching old stack elsewhere is not evidence that this transaction produced it.
	const settledFresh = fresh && !pending;
	const located = last && (producedAt === 'cursor' ? last.menu.cursor : Number.isInteger(producedAt) ? last.entries[producedAt] : null);
	const produced = settledFresh && same(located, preview) ? fact(located) : null;
	return { state, reasonCode, clicks, allowComponentLoss: args.allowComponentLoss === true, produced,
		preview: fact(preview), ownership: owned, ownershipFresh: settledFresh, ...(pending ? { running: pending } : {}),
		carriedCraftingTables: fresh && !pending ? last.entries.slice(9, 46).filter(s => s.itemId === 'minecraft:crafting_table').reduce((n, s) => n + s.count, 0) : null,
		recoveryNeeded: state !== 'SUCCEEDED' && (clicks > 0 || !fresh),
		...(state === 'SUCCEEDED' ? {} : { next: 'Read ownershipFresh and running first. Reconcile any exact running action with actionStatus before choosing recovery; inspect the current menu; no retry, rollback, close or pickup was assumed.' }) };
}
