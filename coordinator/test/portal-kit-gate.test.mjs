import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';

// The kit check at the portal (native-tool-runtime.mjs #portalKitGate): in 9 of 29 Nether entries of the 25 Nov fresh
// games a kit line was shown and the model walked into the portal anyway. A walk to a known portal while the route asks
// for kit first is refused once with the step; the same walk again within a minute goes in short.
const tick = () => new Promise(resolve => setImmediate(resolve));
const LINE = 'usual next step: obtain iron_chestplate, then equip_item it to chest (iron 3 held; kit before the Nether)';

function harness(t, gate) {
	const record = { agentId: 'agent-kit', provider: 'codex', model: 'test', reasoningEffort: 'high', goalRevision: 1 };
	const sent = [], traces = [];
	const current = { player: { x: 0, y: 64, z: 0, health: 20 }, world: { dimension: 'minecraft:overworld' }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} } };
	const runtime = new NativeToolRuntime({
		bridge: { send: async (type, agentId, payload) => sent.push({ type, agentId, payload: validateProtocolV2Payload(type, payload) }) },
		requestObservation: async (_record, { afterEventSequence }) => ({ observation: current, eventSequence: afterEventSequence + 1 }),
		programExecutor: new NativeProgramExecutor(), trace: (event, fields) => traces.push({ event, ...fields }),
		portalKit: () => gate.value,
	});
	t.after(() => runtime.disposeAll());
	runtime.updateObservation(record, current, { eventSequence: 1 });
	let callId = 0;
	const call = (name, args) => runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'turn', callId: String(++callId), tool: normalizeMinecraftToolCall(name, args) }, record);
	return { call, commands: () => sent.filter(e => e.type === 'action_command'), traces };
}
const walk = (x, z) => ({ verb: 'travel_to', target: { x, y: 64, z, tolerance: 1 }, why: 'go in' });

test('a walk to the portal while the kit line shows is refused once and sends nothing; the repeat goes', async t => {
	const h = harness(t, { value: { line: LINE, portals: [{ x: 30, y: 64, z: 7 }] } });
	const refused = await h.call('do_step', walk(31, 7)).catch(e => e);
	assert.equal(refused.code, 'KIT_CONFIRM_REQUIRED');
	assert.match(refused.message, /^Kit check at the portal: obtain iron_chestplate/);
	assert.equal(h.commands().length, 0);
	h.call('do_step', walk(31, 7)).catch(() => {});
	await tick();
	assert.equal(h.commands().length, 1, 'the repeat reaches the body');
	assert.ok(h.traces.some(r => r.event === 'native_portal_kit_refused') && h.traces.some(r => r.event === 'native_portal_kit_confirmed'));
});

test('walks elsewhere, and any walk with no kit line up, are never held', async t => {
	const gate = { value: { line: LINE, portals: [{ x: 30, y: 64, z: 7 }] } };
	const h = harness(t, gate);
	h.call('do_step', walk(60, 7)).catch(() => {});
	await tick();
	assert.equal(h.commands().length, 1);
	const other = harness(t, { value: null });
	other.call('do_step', walk(30, 7)).catch(() => {});
	await tick();
	assert.equal(other.commands().length, 1);
});
