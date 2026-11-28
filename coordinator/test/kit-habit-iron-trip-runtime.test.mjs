import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

process.env.MINEAGEN_NETHER_KIT = 'off';

const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

// kit.ironTripArmour through the production obtain path: after an iron kit obtain down a mine, the kit habit runs a
// nested obtain for the chestplate's raw iron, at most once per IRON_TOPUP_SPACING_MS per agent. This replay has no ore,
// so the top-up's search gives out; what is checked is who opens a top-up, how often, and what the model is told.
async function session() {
	const record = { agentId: 'trip-agent', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
	let sequence = 1;
	const traces = [];
	const observation = { world: { dimension: 'minecraft:overworld' },
		player: { x: 0.5, y: 20, z: 0.5, yaw: 0, health: 20, air: 300, maxAir: 300, onGround: true, skyOpen: false },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_pickaxe', slot: 'mainhand', count: 1 }, { itemId: 'minecraft:shield', slot: 'offhand', count: 1 },
			{ itemId: 'minecraft:iron_ingot', slot: 10, count: 6 }, { itemId: 'minecraft:oak_planks', slot: 11, count: 8 }, { itemId: 'minecraft:crafting_table', slot: 1, count: 1 }, { itemId: 'minecraft:flint', slot: 12, count: 1 }] }, blocks: [] };
	for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) observation.blocks.push({ blockId: 'minecraft:stone', x, y: 19, z, placeableFaces: ['up'] });
	const take = (itemId, count) => {
		const row = observation.inventory.items.find(item => item.itemId === itemId);
		row.count -= count;
		observation.inventory.items = observation.inventory.items.filter(item => item.count > 0);
	};
	const runtime = new NativeToolRuntime({ kitHabit: true, registry: { get: () => record }, trace: (event, fields) => { traces.push({ event, ...fields }); },
		requestObservation: async () => ({ observation: structuredClone(observation), eventSequence: ++sequence }),
		inspectObservation: async (_r, q) => ({ section: q.section, entries: observation.blocks, coverage: { hasMore: false }, eventSequence: ++sequence }),
		bridge: { send: async (type, _a, p) => {
			if (type !== 'action_command') return;
			const a = p.arguments;
			if (p.actionType === 'place_block') { observation.blocks.push({ blockId: a.itemId, x: a.x, y: a.y, z: a.z }); take(a.itemId, 1); }
			if (p.actionType === 'break_block') {
				const table = block => block.x === a.x && block.y === a.y && block.z === a.z && block.blockId === 'minecraft:crafting_table';
				if (observation.blocks.some(table)) observation.inventory.items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 });
				observation.blocks = observation.blocks.filter(block => !table(block));
			}
			if (p.actionType === 'craft_table' || p.actionType === 'craft_inventory') {
				assert.ok(['minecraft:bucket', 'minecraft:flint_and_steel'].includes(a.recipeId), `unexpected recipe ${a.recipeId}`);
				take('minecraft:iron_ingot', a.recipeId === 'minecraft:bucket' ? 3 : 1);
				if (a.recipeId === 'minecraft:flint_and_steel') take('minecraft:flint', 1);
				observation.inventory.items.push({ itemId: a.recipeId, slot: 5, count: 1 });
			}
			// The search finds nothing: every leg ends at once with no ore seen.
			const state = ['craft_table', 'craft_inventory', 'place_block', 'break_block', 'equip_item', 'select_tool'].includes(p.actionType) ? 'SUCCEEDED' : 'FAILED';
			queueMicrotask(() => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state, reasonCode: state === 'SUCCEEDED' ? 'ACTION_COMPLETED' : 'NO_PATH', executionStarted: true }));
		} } });
	runtime.updateObservation(record, structuredClone(observation), { eventSequence: sequence });
	const obtain = async (item) => runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 't', callId: `c-${item}`,
		tool: normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item, timeoutMs: 60000 }, why: 'iron trip armour acceptance' }) }, record);
	return { obtain, traces, dispose: () => runtime.dispose(record.agentId, 'test_complete') };
}

test('an iron kit obtain down a mine opens one top-up; the next iron kit obtain soon after does not', { timeout: 60_000 }, async () => {
	const { obtain, traces, dispose } = await session();
	try {
		const first = await obtain('bucket');
		assert.equal(first.state, 'SUCCEEDED', JSON.stringify(first));
		assert.equal(traces.filter(row => row.event === 'native_iron_topup').length, 1);
		assert.match(first.message, /kit: mining the iron_chestplate's iron stopped \(/);
		const second = await obtain('flint_and_steel');
		assert.equal(second.state, 'SUCCEEDED', JSON.stringify(second));
		assert.equal(traces.filter(row => row.event === 'native_iron_topup').length, 1, 'spaced out: no second top-up within 5 minutes');
	} finally { await dispose(); }
});

test('with MINEAGEN_IRON_TRIP_ARMOUR=off the iron kit obtain hands back with no top-up', { timeout: 60_000 }, async () => {
	process.env.MINEAGEN_IRON_TRIP_ARMOUR = 'off';
	const { obtain, traces, dispose } = await session();
	try {
		const result = await obtain('bucket');
		assert.equal(result.state, 'SUCCEEDED', JSON.stringify(result));
		assert.equal(traces.filter(row => row.event === 'native_iron_topup').length, 0);
		assert.doesNotMatch(result.message, /iron_chestplate/);
	} finally { delete process.env.MINEAGEN_IRON_TRIP_ARMOUR; await dispose(); }
});
