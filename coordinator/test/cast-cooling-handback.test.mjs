import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';
import { decodeModelFacts } from '../src/model-fact-encoding.mjs';

const record = { agentId: 'cast-cooling', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', goalRevision: 1 };
const original = (count = 8) => `No lava source in reach after a full look around. New obsidian seen: 1; frame at 250,-52,-284 axis z: ${count}/10 cells seen cast (missing 250,-48,-283 250,-48,-282); clicks: water poured 1, lava poured 1, water scooped 1, lava taken 0, blocks placed 4; lava sources seen within 16: 0; carried water_bucket 1, lava_bucket 0, bucket 1`;

for (const scenario of [
	{ count: 8, guided: true }, { count: 1, guided: true }, { count: 9, guided: true },
	{ count: 0 }, { count: 10 }, { count: 18 },
	{ count: 8, state: 'CANCELLED' }, { count: 8, state: 'SUCCEEDED' },
	{ count: 8, code: 'NO_STAND_SPOT', guided: true }, { count: 8, frame: false },
	{ count: 8, code: 'FRAME_CELL_UNSEEN', guided: true }, { count: 8, code: 'FRAME_CELL_BLOCKED', guided: true },
	{ count: 8, code: 'DAMAGE_TAKEN' }, { count: 8, code: 'PLAYER_DEAD' },
	{ count: 8, dead: true }, { count: 8, health: 0 },
	{ count: 8, dimension: 'minecraft:the_nether' }, { message: 'No lava source in reach' },
	{ message: `Long native detail: ${'x'.repeat(1500)} ${original(8)}`, guided: true, resumeOnly: true },
	{ message: `Long native detail: ${'x'.repeat(1670)} ${original(8)}` },
]) test(`cooling handback ${JSON.stringify(scenario)}`, async () => {
	const sent = [];
	const runtime = new NativeToolRuntime({ registry: { get: () => record }, bridge: { send: async (type, agentId, payload) => sent.push({ type, payload }) } });
	runtime.updateObservation(record, { ready: true, world: { dimension: scenario.dimension ?? 'minecraft:overworld' },
		player: { x: 249.5, y: -52, z: -282.5, health: 20, foodLevel: 20 } }, { eventSequence: 1 });
	try {
		const tool = normalizeMinecraftToolCall('do_step', { verb: 'cast_obsidian', target: { x: 249, y: -53, z: -279, axis: 'z', frame: scenario.frame ?? true }, why: 'finish the chosen frame' });
		const handle = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'cast', callId: 'cast', tool }, record);
		assert.equal(handle.state, 'RUNNING');
		const payload = { actionId: handle.actionId, goalRevision: 1, state: scenario.state ?? 'FAILED', reasonCode: scenario.code ?? 'NO_LAVA_IN_REACH',
			message: scenario.message ?? original(scenario.count), executionStarted: true, physicalAttempted: true, ...(scenario.dead || scenario.health === 0 ? { actionObservation: { player: { dead: scenario.dead ?? false, health: scenario.health ?? 0 } } } : {}) };
		const raw = structuredClone(payload);
		assert.equal(runtime.onActionResult(record, payload), true);
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'read', callId: 'read',
			tool: { kind: 'action_status', actionId: handle.actionId } }, record);
		assert.equal(result.state, payload.state);
		assert.equal(result.reasonCode, payload.reasonCode);
		assert.equal(result.actionId, handle.actionId);
		assert.equal(result.physicalAttempted, true);
		assert.equal(result.executionStarted, true);
		assert.deepEqual(payload, raw, 'server receipt is untouched');
		if (scenario.guided) {
			assert.ok(result.message.endsWith(raw.message), 'physical frame, click and inventory facts survive');
			const shown = decodeModelFacts(JSON.parse(presentNativeToolResult(result, { kind: 'action_status' }).response.contentItems[0].text));
			assert.match(shown.failure.blockedBy, /^Partial frame: retry with do_step/);
			assert.match(shown.failure.blockedBy, /resume:true,x:250,y:-52,z:-284,axis:"z"/);
			if ((scenario.code ?? 'NO_LAVA_IN_REACH') === 'NO_LAVA_IN_REACH' && !scenario.resumeOnly) {
			assert.match(shown.failure.blockedBy, /may cap.*Inspect from dry footing; if a cap is seen/);
			assert.match(shown.failure.blockedBy, /never the block you stand on/);
			assert.match(shown.failure.blockedBy, /Hidden lava is unconfirmed/);
			}
			assert.match(shown.failure.blockedBy, /frame at 250,-52,-284 axis z/);
			assert.match(shown.failure.blockedBy, /carried water_bucket 1, lava_bucket 0, bucket 1/);
		} else {
			assert.equal(result.message, raw.message);
			if (raw.message.length > 1700) {
				const shown = decodeModelFacts(JSON.parse(presentNativeToolResult(result, { kind: 'action_status' }).response.contentItems[0].text));
				assert.equal(shown.failure.blockedBy, raw.message, 'long native facts survive production delivery in full');
			}
		}
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(sent.filter(row => row.type === 'action_command').map(row => row.payload.actionType), ['cast_obsidian'], 'no automatic look, break, travel or retry');
	} finally { await runtime.dispose(record.agentId, 'test_complete'); }
});
