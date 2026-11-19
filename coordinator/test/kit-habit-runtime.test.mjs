import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

// The production obtain path (runtime, normalization, obtain-runner): the bridge applies crafts and equips to the
// inventory, so the kit habit runs on the same body calls a game would make.
const RECIPES = {
	'minecraft:bucket': { iron: 3, planks: 0, slot: 5 },
	'minecraft:shield': { iron: 1, planks: 6, slot: 6 },
	'minecraft:iron_chestplate': { iron: 8, planks: 0, slot: 7 },
	'minecraft:iron_boots': { iron: 4, planks: 0, slot: 8 },
};

async function obtainBucket({ kitHabit, iron = 4, health = 20 }) {
	const record = { agentId: 'kit-agent', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
	let sequence = 1;
	const commands = [];
	const observation = { world: { dimension: 'minecraft:overworld' },
		player: { x: 0.5, y: 64, z: 0.5, yaw: 0, health, air: 300, maxAir: 300, onGround: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_pickaxe', slot: 'mainhand', count: 1 }, { itemId: 'minecraft:iron_ingot', slot: 10, count: iron },
			{ itemId: 'minecraft:oak_planks', slot: 11, count: 8 }, { itemId: 'minecraft:crafting_table', slot: 1, count: 1 }] }, blocks: [] };
	for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) observation.blocks.push({ blockId: 'minecraft:stone', x, y: 63, z, placeableFaces: ['up'] });
	const take = (itemId, count) => {
		const row = observation.inventory.items.find(item => item.itemId === itemId);
		row.count -= count;
		observation.inventory.items = observation.inventory.items.filter(item => item.count > 0);
	};
	const runtime = new NativeToolRuntime({ kitHabit, registry: { get: () => record },
		requestObservation: async () => ({ observation: structuredClone(observation), eventSequence: ++sequence }),
		inspectObservation: async (_r, q) => ({ section: q.section, entries: observation.blocks, coverage: { hasMore: false }, eventSequence: ++sequence }),
		bridge: { send: async (type, _a, p) => {
			commands.push({ type, ...p });
			if (type !== 'action_command') return;
			assert.ok(commands.length < 80, 'bounded replay');
			const a = p.arguments;
			if (p.actionType === 'place_block') { observation.blocks.push({ blockId: a.itemId, x: a.x, y: a.y, z: a.z }); take(a.itemId, 1); }
			if (p.actionType === 'break_block') {
				observation.blocks = observation.blocks.filter(block => !(block.x === a.x && block.y === a.y && block.z === a.z && block.blockId === 'minecraft:crafting_table'));
				observation.inventory.items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 });
			}
			if (p.actionType === 'craft_table') {
				const recipe = RECIPES[a.recipeId];
				assert.ok(recipe, `unexpected recipe ${a.recipeId}`);
				take('minecraft:iron_ingot', recipe.iron);
				if (recipe.planks) take('minecraft:oak_planks', recipe.planks);
				observation.inventory.items.push({ itemId: a.recipeId, slot: recipe.slot, count: 1 });
			}
			if (p.actionType === 'equip_item') {
				const row = observation.inventory.items.find(item => item.slot === a.sourceSlot);
				assert.equal(row?.itemId, a.expectedItemId);
				row.slot = a.targetSlot;
			}
			queueMicrotask(() => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED', executionStarted: true }));
		} } });
	runtime.updateObservation(record, structuredClone(observation), { eventSequence: sequence });
	try {
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 't', callId: 'c',
			tool: normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'bucket', timeoutMs: 60000 }, why: 'kit habit acceptance' }) }, record);
		return { result, commands, items: observation.inventory.items };
	} finally { await runtime.dispose(record.agentId, 'test_complete'); }
}

test('after obtain succeeds, the body crafts the missing shield from held iron and wood and wears it', async () => {
	const { result, commands, items } = await obtainBucket({ kitHabit: true });
	assert.equal(result.state, 'SUCCEEDED', JSON.stringify(result));
	assert.deepEqual(result.kit, ['crafted shield', 'wore shield (offhand)']);
	assert.match(result.message, /kit: crafted shield, wore shield \(offhand\)/);
	assert.ok(items.some(item => item.itemId === 'minecraft:shield' && item.slot === 'offhand'));
	const crafts = commands.filter(c => c.actionType === 'craft_table').map(c => c.arguments.recipeId);
	assert.deepEqual(crafts, ['minecraft:bucket', 'minecraft:shield']);
	assert.ok(!commands.some(c => ['break_block', 'mine_vein', 'navigate_to'].includes(c.actionType) && c.arguments?.blockId !== undefined && /ore/.test(c.arguments.blockId)), 'no mining for kit');
});

test('with the habit off, or with the body hurt, obtain hands back exactly as before', async () => {
	for (const options of [{ kitHabit: false }, { kitHabit: true, health: 9 }]) {
		const { result, commands } = await obtainBucket(options);
		assert.equal(result.state, 'SUCCEEDED');
		assert.equal(result.kit, undefined, JSON.stringify(options));
		assert.deepEqual(commands.filter(c => c.actionType === 'craft_table').map(c => c.arguments.recipeId), ['minecraft:bucket']);
	}
});

test('iron the route still needs is not spent on armour; spare iron is', async () => {
	// 11 iron: bucket 3 leaves 8; shield 1 leaves 7; the second bucket (3) and flint and steel (1) are still owed, so 3
	// spare: too little for any piece.
	let { result } = await obtainBucket({ kitHabit: true, iron: 11 });
	assert.deepEqual(result.kit, ['crafted shield', 'wore shield (offhand)']);
	// 12 iron leaves 4 spare: boots, the only piece that fits.
	({ result } = await obtainBucket({ kitHabit: true, iron: 12 }));
	assert.deepEqual(result.kit, ['crafted shield', 'wore shield (offhand)', 'crafted iron_boots', 'wore iron_boots (feet)']);
	// 16 iron leaves 12 after the bucket and shield: 4 owed, 8 spare, enough for a chestplate.
	({ result } = await obtainBucket({ kitHabit: true, iron: 16 }));
	assert.deepEqual(result.kit, ['crafted shield', 'wore shield (offhand)', 'crafted iron_chestplate', 'wore iron_chestplate (chest)']);
});
