import assert from 'node:assert/strict';
import test from 'node:test';
import { routeLine, ROUTE_BYTES } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';
import { decodeModelFacts } from '../src/model-fact-encoding.mjs';
// These cases are the stock.foodFloor off arm (the route before the food floor); food-floor-route.test.mjs has the on arm.
process.env.MINEAGEN_FOOD_FLOOR = 'off';

const record = { agentId: 'portal-entry', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', goalRevision: 1 };
const sample = (health = 20, foodLevel = 20) => ({ ready: true, observedAtEpochMs: 1,
	world: { dimension: 'minecraft:overworld' }, player: { x: 229.5, y: -55, z: 7.5, health, foodLevel },
	inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:shield', count: 1, slot: 'offhand' },
		{ itemId: 'minecraft:bucket', count: 2 }, { itemId: 'minecraft:flint_and_steel', count: 1 }, { itemId: 'minecraft:white_wool', count: 2 }] },
});
const assertEntry = (message) => {
	assert.match(message, /enter the Nether through the lit portal now/);
	// PORTAL_ENTRY_PREP is read at module load, before the off-arm pin above: either arm's food clause.
	assert.match(message, /food stocks are optional unless health or hunger is low|carry 256\+ food points \(saturation \+ 3 hunger per item/);
};

for (const [health, hunger] of [[20, 20], [15, 20], [5, 20], [20, 6], [5, 6]]) test(`lit portal route names entry with recovery exception at health${health}/hunger${hunger}`, () => {
	const known = emptyKnown();
	known.frames.push({ dimension: 'minecraft:overworld', x: 229, y: -55, z: 7, obsidian: 10, lit: true });
	const message = routeLine({ observation: sample(health, hunger), known, evaluate: evaluatePlanCheck });
	assertEntry(message);
	assert.doesNotMatch(message, /top up|food 0\/10|blocks 0\/64|obtain cooked_beef/);
	assert.ok(Buffer.byteLength(message) <= ROUTE_BYTES);
});

test('a lit portal names entry even when casting supplies are no longer held', () => {
	const known = emptyKnown();
	known.frames.push({ dimension: 'minecraft:overworld', x: 229, y: -55, z: 7, obsidian: 10, lit: true });
	const observation = sample();
	observation.inventory.items = [{ itemId: 'minecraft:iron_pickaxe', count: 1 }];
	assertEntry(routeLine({ observation, known, evaluate: evaluatePlanCheck }));
	assert.doesNotMatch(routeLine({ observation, known: emptyKnown(), evaluate: evaluatePlanCheck }), /enter the Nether/);
});

for (const scenario of [
	{ state: 'SUCCEEDED', reasonCode: 'PORTAL_LIT', structure: 'nether_portal', guided: true },
	{ state: 'SUCCEEDED', reasonCode: 'PORTAL_LIT', structure: 'nether_portal', dimension: 'minecraft:the_nether', guided: false },
	{ state: 'FAILED', reasonCode: 'BUILD_NO_SITE', structure: 'nether_portal', guided: false },
	{ state: 'FAILED', reasonCode: 'PORTAL_LIT', structure: 'nether_portal', guided: false },
	{ state: 'SUCCEEDED', reasonCode: 'BUILT', structure: 'pillar', guided: false },
]) test(`portal result presentation only: ${scenario.structure}/${scenario.state}/${scenario.reasonCode}/${scenario.dimension ?? 'minecraft:overworld'}`, async () => {
	const commands = [], completed = [];
	const runtime = new NativeToolRuntime({ registry: { get: () => record }, bridge: { send: async (type, agentId, payload) => { commands.push({ type, payload }); } },
		trace: (event, fields) => { if (event === 'native_tool_action_completed') completed.push(fields); },
	});
	const observation = sample();
	if (scenario.dimension) observation.world.dimension = scenario.dimension;
	runtime.updateObservation(record, observation, { eventSequence: 1 });
	try {
		const tool = normalizeMinecraftToolCall('do_step', { verb: 'build', target: { structure: scenario.structure }, why: 'model chooses this construction step' });
		const handle = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'build', callId: 'build', tool }, record);
		assert.equal(handle.state, 'RUNNING');
		const original = '10/10 frame cells; is lit; step into the opening at 229,-54,7 (229.5, -54.0, 7.5) and wait 4 s to cross';
		const payload = { actionId: handle.actionId, goalRevision: 1, state: scenario.state, reasonCode: scenario.reasonCode,
			message: original, executionStarted: true, physicalAttempted: true };
		assert.equal(runtime.onActionResult(record, payload), true);
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'status', callId: 'status',
			tool: { kind: 'action_status', actionId: handle.actionId } }, record);
		assert.equal(result.state, payload.state);
		assert.equal(result.reasonCode, payload.reasonCode);
		assert.equal(result.actionId, handle.actionId);
		assert.equal(result.physicalAttempted, true);
		assert.equal(result.executionStarted, true);
		if (scenario.guided) {
			assertEntry(result.message); assert.ok(result.message.endsWith(original)); assertEntry(completed[0].message);
			// The result cannot see the inventory, so it names the portal bed's condition (C33) instead of calling the bed optional.
			assert.match(result.message, /place and use a bed by the portal first if a bed, 3 matching wool or sheep are in reach/);
			const shown = decodeModelFacts(JSON.parse(presentNativeToolResult(result, { kind: 'action_status' }).response.contentItems[0].text));
			assertEntry(shown.message); assert.match(shown.message, /229\.5, -54\.0, 7\.5/);
		}
		else assert.equal(result.message, original);
		assert.equal(payload.message, original, 'raw server receipt remains unchanged');
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(commands.filter(row => row.type === 'action_command').map(row => row.payload.actionType), ['build'], 'no automatic entry, food or bed action');
		assert.equal(commands.some(row => row.type === 'action_cancel'), false);
	} finally { await runtime.dispose(record.agentId, 'test_complete'); }
});
