import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, normalizeMinecraftToolCall, toolResultContent } from '../src/native-minecraft-tools.mjs';
import { runInventoryRepair } from '../src/inventory-repair.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const air = () => ({ itemId: 'minecraft:air', count: 0, fingerprint: '', damage: 0, maxDamage: 0 });
const pick = (damage = 129) => ({ itemId: 'minecraft:stone_pickaxe', count: 1, fingerprint: hash(`pick${damage}`), damage, maxDamage: 131, pickupAllowed: true });
function fixture() {
	const entries = Array.from({ length: 46 }, (_, slot) => ({ ...air(), slot, pickupAllowed: true }));
	entries[12] = { ...pick(), slot: 12 }; entries[40] = { ...pick(), slot: 40 };
	const menu = { type: 'minecraft:inventory', containerId: 0, stateId: 7, slotCount: 46, cursor: air() };
	const args = { menuId: menu.type, containerId: 0, stateId: 7, itemId: 'minecraft:stone_pickaxe',
		inputs: [12, 40].map(slot => ({ slot, fingerprint: entries[slot].fingerprint })), allowComponentLoss: true };
	return { entries, menu, args };
}

// In-memory vanilla-click effects only. This exercises production normalization,
// admission, dispatch and receipts; it does not certify Minecraft acceptance.
async function replay(mode = 'ordinary', setup = () => {}) {
	const f = fixture(); setup(f);
	const record = { agentId: 'repair', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' };
	let runtime, seq = 1, clicks = 0, pages = 0;
	const commands = [], occupancy = [];
	runtime = new NativeToolRuntime({ registry: { get: () => record },
		inspectObservation: async (_r, q) => {
			pages++;
			if (f.onInspect) await f.onInspect(runtime, record, q, clicks);
			if (mode === 'lifecycle' && clicks === 2) await runtime.dispose(record.agentId, 'test_cancelled');
			if (mode === 'inspection-error' && clicks === 1) throw new Error('inspection lost');
			if (mode === 'pagination-conflict' && q.offset > 0) f.menu.stateId++;
			const part = f.entries.slice(q.offset, q.offset + 12), next = q.offset + part.length;
			const columns = ['slot', 'itemId', 'count', 'fingerprint', 'damage', 'maxDamage', 'pickupAllowed'];
			return { menu: structuredClone(f.menu), entries: mode === 'packed-pages' ? { $rows: { columns, rows: part.map(s => columns.map(k => s[k])) } } : part, eventSequence: ++seq,
				coverage: { offset: q.offset, total: 46, nextOffset: next, hasMore: next < 46 } };
		}, bridge: { send: async (type, _id, payload) => {
			commands.push({ type, ...structuredClone(payload) });
			if (type !== 'action_command') return;
			const a = payload.arguments, old = f.entries[a.slot];
			assert.equal(payload.actionType, 'menu_click'); assert.equal(a.clickType, 'PICKUP');
			assert.equal(a.menuId, f.menu.type); assert.equal(a.containerId, f.menu.containerId);
			assert.equal(a.stateId, f.menu.stateId); assert.equal(a.expectedFingerprint, old.fingerprint);
			assert.equal(a.expectedItemId, old.itemId); assert.equal(a.expectedCount, old.count);
			clicks++;
			if (mode === 'stale-native' && clicks === 2 || mode === 'deposit-full' && clicks === 6) {
				queueMicrotask(() => runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: 1, state: 'FAILED', reasonCode: mode === 'deposit-full' ? 'DESTINATION_FULL' : 'MENU_STATE_CHANGED' })); return;
			}
			if (mode === 'publication-before' && clicks === 1) throw new Error('publication rejected before effect');
			if (mode === 'pending' && clicks === 1 || mode === 'pending-final' && clicks === 6) { runtime.interruptBlockingTool(record.agentId); return; }
			f.entries[a.slot] = { ...f.menu.cursor, slot: a.slot, pickupAllowed: true }; f.menu.cursor = { ...old }; delete f.menu.cursor.slot;
			if (a.slot === 0) { f.entries[1] = { ...air(), slot: 1 }; f.entries[2] = { ...air(), slot: 2 }; }
			else f.entries[0] = { ...(f.entries[1].count && f.entries[2].count ? pick(mode === 'bad-preview' ? 130 : Math.max(0, f.entries[1].damage + f.entries[2].damage - 131 - 6)) : air()), slot: 0 };
			if (mode === 'partial-existing' && clicks === 5) f.menu.cursor = air();
			if (mode === 'disappear-final' && clicks === 6) f.entries[12] = { ...air(), slot: 12 };
			if (mode === 'result-mismatch' && clicks === 5) f.menu.cursor = pick(120);
			if (mode === 'conflict' && clicks === 2) f.entries[40] = { ...pick(128), slot: 40 };
			if (mode === 'table-gone' && clicks === 6) f.entries[20] = { ...air(), slot: 20 };
			f.menu.stateId++;
			if (mode === 'publication-error' && clicks === 1) throw new Error('send failed after click');
			occupancy.push({ cursor: f.menu.cursor.count, input: [1, 2, 12, 40].reduce((n, i) => n + f.entries[i].count, 0) });
			queueMicrotask(() => {
				runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: 1,
					state: ((mode === 'partial-result' || mode === 'partial-existing') && clicks === 5 || mode === 'disappear-final' && clicks === 6) ? 'FAILED' : 'SUCCEEDED',
					reasonCode: ((mode === 'partial-result' || mode === 'partial-existing') && clicks === 5 || mode === 'disappear-final' && clicks === 6) ? 'MENU_INPUT_PARTIAL' : 'MENU_INPUT_APPLIED', executionStarted: true });
				if (mode === 'danger' && clicks === 2 || mode === 'taken-danger' && clicks === 5) runtime.interruptBlockingTool(record.agentId);
			});
		} } });
	try {
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: mode, callId: mode,
			tool: normalizeMinecraftToolCall('do_step', { verb: 'repair_inventory', target: f.args, why: 'repair observed worn picks; accept component loss' }) }, record);
		if (f.checkReleased) {
			const next = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'after', callId: 'after',
				tool: normalizeMinecraftToolCall('do_step', { verb: 'repair_inventory', target: f.args, why: 'check released reservation' }) }, record);
			assert.equal(next.reasonCode, 'MENU_STATE_CHANGED');
		}
		return { result, commands, clicks, pages, f, occupancy, shown: JSON.parse(toolResultContent(result).contentItems[0].text) };
	} finally { await runtime.dispose(record.agentId, 'test_complete'); }
}

test('repair requires explicit loss acknowledgement and exact observed input identities', () => {
	const { args } = fixture();
	const normalize = target => normalizeMinecraftToolCall('do_step', { verb: 'repair_inventory', target, why: 'repair' });
	assert.equal(normalize(args).kind, 'repair_inventory');
	for (const edit of [a => delete a.allowComponentLoss, a => a.allowComponentLoss = false, a => a.allowComponentLoss = 'true',
		a => a.inputs[1].slot = a.inputs[0].slot, a => a.inputs[0].slot = 5, a => delete a.inputs[0].fingerprint,
		a => a.itemId = 'minecraft:iron_axe', a => delete a.stateId, a => a.auto = true]) {
		const target = structuredClone(args); edit(target);
		assert.throws(() => normalize(target), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	}
	const tool = MINECRAFT_DYNAMIC_TOOLS.find(t => t.name === 'do_step');
	assert.deepEqual(tool.inputSchema.properties.target.properties.allowComponentLoss.enum, [true]);
	assert.deepEqual(tool.inputSchema.allOf[0].then.properties.target.required, ['allowComponentLoss']);
	assert.match(tool.description, /names, non-curse enchantments and other components/);
});
test('production repair handles same-ID same-fingerprint worn picks and reports actual result and absent table', async () => {
	const { result, clicks, pages, commands, shown, occupancy } = await replay();
	assert.equal(result.reasonCode, 'INVENTORY_REPAIRED'); assert.equal(clicks, 6); assert.ok(pages >= 28);
	assert.equal(result.produced.damage, 121); assert.equal(result.produced.maxDamage, 131);
	assert.equal(result.produced.fingerprint, pick(121).fingerprint); assert.equal(result.produced.slot, 12);
	assert.equal(result.carriedCraftingTables, 0); assert.equal(result.ownershipFresh, true);
	assert.equal(shown.produced.damage, 121); assert.equal(shown.carriedCraftingTables, 0);
	assert.deepEqual(commands.filter(c => c.type === 'action_command').map(c => c.arguments.slot), [12, 1, 40, 2, 0, 12]);
	assert.deepEqual(occupancy.map(o => o.cursor + o.input), [2, 2, 2, 2, 1, 1]);
});
test('production carried-table count uses final inspected carried slots, including offhand', async () => {
	const table = slot => ({ itemId: 'minecraft:crafting_table', count: 1, fingerprint: hash('table'), slot });
	const { result } = await replay('table-gone', f => { f.entries[20] = table(20); f.entries[45] = table(45); });
	assert.equal(result.carriedCraftingTables, 1);
});
test('production repair permits distinct observed damaged variants', async () => {
	const { result } = await replay('ordinary', f => { f.entries[40] = { ...pick(125), slot: 40 }; f.args.inputs[1].fingerprint = pick(125).fingerprint; });
	assert.equal(result.reasonCode, 'INVENTORY_REPAIRED'); assert.equal(result.produced.damage, 117);
});
test('production repair reads packed inspected slot rows', async () => {
	const { result } = await replay('packed-pages');
	assert.equal(result.reasonCode, 'INVENTORY_REPAIRED'); assert.equal(result.carriedCraftingTables, 0);
});
test('production repair rejects a concurrent body call and releases its reservation on failure', async () => {
	let checked = false;
	const { result } = await replay('bad-preview', f => { f.checkReleased = true; f.onInspect = async (runtime, record) => {
		if (checked) return; checked = true;
		const request = { agentId: record.agentId, goalRevision: 1, turnId: 'second', callId: 'second',
			tool: normalizeMinecraftToolCall('do_step', { verb: 'repair_inventory', target: f.args, why: 'concurrent request' }) };
		await assert.rejects(runtime.execute(request, record), { code: 'NATIVE_ACTION_IN_PROGRESS' });
	}; });
	assert.equal(checked, true); assert.equal(result.reasonCode, 'REPAIR_PREVIEW_INVALID');
});
for (const [mode, code, limit] of [['stale-native', 'MENU_STATE_CHANGED', 2], ['conflict', 'REPAIR_OWNERSHIP_CHANGED', 2],
	['pagination-conflict', 'MENU_STATE_CHANGED', 0], ['bad-preview', 'REPAIR_PREVIEW_INVALID', 4],
	['danger', 'DANGER', 2], ['lifecycle', 'CANCELLED', 2], ['inspection-error', 'REPAIR_INSPECTION_FAILED', 1],
	['partial-result', 'MENU_INPUT_PARTIAL', 5], ['pending', 'DANGER', 1], ['deposit-full', 'DESTINATION_FULL', 6],
	['taken-danger', 'DANGER', 5], ['result-mismatch', 'REPAIR_OWNERSHIP_CHANGED', 5]]) {
	test(`production repair ${mode} stops without retry or rollback`, async () => {
		const { result, clicks, commands } = await replay(mode);
		assert.equal(result.reasonCode, code); assert.equal(clicks, limit);
		assert.ok(commands.every(c => c.type !== 'action_command' || c.actionType === 'menu_click'));
		if (mode === 'partial-result') { assert.equal(result.produced.damage, 121); assert.equal(result.ownership.cursor.fingerprint, pick(121).fingerprint); }
		if (mode === 'deposit-full' || mode === 'taken-danger') { assert.equal(result.produced.damage, 121); assert.equal(result.ownership.cursor.count, 1); assert.equal(result.ownership.result.count, 0); }
		if (mode === 'result-mismatch') { assert.equal(result.produced, null); assert.equal(result.ownership.cursor.damage, 120); }
		if (mode === 'stale-native') assert.equal(result.ownership.cursor.fingerprint, pick().fingerprint);
		if (mode === 'lifecycle' || mode === 'inspection-error') { assert.equal(result.ownershipFresh, false); assert.equal(result.carriedCraftingTables, null); }
		if (mode === 'pending') { assert.ok(result.running.actionId); assert.equal(result.carriedCraftingTables, null); }
	});
}
for (const [code, edit] of [['MENU_STATE_CHANGED', f => f.args.stateId--], ['SOURCE_MISMATCH', f => f.args.inputs[0].fingerprint = hash('stale')],
	['SOURCE_MISMATCH', f => f.entries[40].itemId = 'minecraft:iron_pickaxe'], ['REPAIR_CURSOR_OCCUPIED', f => f.menu.cursor = pick()],
	['REPAIR_GRID_OCCUPIED', f => f.entries[3] = { ...pick(), slot: 3 }], ['REPAIR_INPUTS_UNSUPPORTED', f => f.entries[12].damage = 0],
	['REPAIR_INPUTS_UNSUPPORTED', f => f.entries[12].pickupAllowed = false], ['REPAIR_INPUTS_UNSUPPORTED', f => f.entries[12].count = 2]]) {
	test(`production repair preflight ${code} makes no mutation`, async () => {
		const { result, clicks } = await replay('preflight', edit); assert.equal(result.reasonCode, code); assert.equal(clicks, 0);
	});
}
test('unacknowledged direct repair cannot inspect or mutate', async () => {
	const result = await runInventoryRepair({ ...fixture().args, allowComponentLoss: false }, {
		stopped: () => false, interrupted: () => false,
		inspect: () => assert.fail('no inspection'), act: () => assert.fail('no click'),
	});
	assert.equal(result.reasonCode, 'REPAIR_LOSS_ACK_REQUIRED'); assert.equal(result.clicks, 0);
});
test('production repair dispatch failure after mutation still reports cursor ownership and recovery', async () => {
	const { result, clicks } = await replay('publication-error');
	assert.equal(clicks, 1); assert.equal(result.clicks, 1); assert.equal(result.recoveryNeeded, true);
	assert.equal(result.ownershipFresh, false); assert.equal(result.running.state, 'UNKNOWN'); assert.ok(result.running.actionId); assert.equal(result.carriedCraftingTables, null); assert.equal(result.ownership.cursor.itemId, 'minecraft:stone_pickaxe');
	assert.equal(result.ownership.inputs[0].count, 0);
});
test('missing menu rows never certify absent carried tables', async () => {
	const { result, clicks } = await replay('ordinary', f => { delete f.entries[20].fingerprint; });
	assert.equal(result.reasonCode, 'REPAIR_MENU_INCOMPLETE'); assert.equal(result.carriedCraftingTables, null); assert.equal(clicks, 0);
});

test('a full inventory repairs into its vacated source slot without a third vacancy', async () => {
 const {result, clicks} = await replay('ordinary', f => {for(let i=9;i<45;i++) if(!f.entries[i].count) f.entries[i]={...pick(),slot:i};});
 assert.equal(result.reasonCode,'INVENTORY_REPAIRED'); assert.equal(clicks,6); assert.equal(result.produced.slot,12);
});
test('publication uncertainty preserves exact action identity and unsettled ownership before application', async () => {
 const {result,commands,clicks,f}=await replay('publication-before'); const issued=commands.find(c=>c.type==='action_command');
 assert.equal(clicks,1); assert.equal(result.running?.actionId,issued.actionId); assert.equal(result.running.goalRevision,1);
 assert.equal(result.running.state,'UNKNOWN'); assert.equal(result.running.reasonCode,'DISPATCH_RESULT_UNKNOWN');
 assert.equal(result.ownershipFresh,false); assert.equal(result.carriedCraftingTables,null); assert.equal(result.produced,null);
 assert.equal(f.entries[12].count,1); assert.equal(f.menu.cursor.count,0);
});
test('pending final deposit cannot certify produced ownership or carried table count', async () => {
 const {result}=await replay('pending-final');
 assert.ok(result.running.actionId); assert.equal(result.ownershipFresh,false); assert.equal(result.produced,null); assert.equal(result.carriedCraftingTables,null);
});
test('partial output consumption never attributes a pre-existing identical pick as produced', async () => {
 const {result,f}=await replay('partial-existing',f=>{f.entries[20]={...pick(121),slot:20};});
 assert.equal(result.reasonCode,'MENU_INPUT_PARTIAL'); assert.equal(result.clicks,5); assert.equal(result.produced,null);
 assert.equal(f.entries[20].fingerprint,pick(121).fingerprint); assert.equal(result.ownership.cursor.count,0);
});
test('partial final deposit clears current produced ownership when output is absent', async () => {
 const {result}=await replay('disappear-final');
 assert.equal(result.reasonCode,'MENU_INPUT_PARTIAL'); assert.equal(result.clicks,6); assert.equal(result.produced,null);
 assert.equal(result.ownershipFresh,true); assert.equal(result.ownership.cursor.count,0); assert.equal(result.ownership.inputs[0].count,0);
});
