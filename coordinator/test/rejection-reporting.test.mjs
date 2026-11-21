import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { ProtocolV2Error, validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { validateAction } from '../src/schema.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, factToWireObservation, start } from './fixtures/dynamic-main-fixture.mjs';

// Every rejected input says what was wrong and what is accepted, in the trace and in what the model reads.

const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };

function rejection(name, args) {
	try { normalizeMinecraftToolCall(name, args); }
	catch (error) { return error; }
	assert.fail(`${name} accepted ${JSON.stringify(args)}`);
}

async function tracedCoordinator() {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
	planner.requestNativeTurn = async (request) => { planner.requests.push(request); return { toolCalls: 0 }; };
	const rows = [];
	const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: CONFIG });
	return { ...run, rows };
}

test('an observation missing world.gameTime leaves a trace row naming the field', async () => {
	const { bridge, coordinator, rows } = await tracedCoordinator();
	try {
		bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat the game.' } });
		bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, attention: true, observedAtEpochMs: 1, changedFacts: ['blocks'],
			observation: { player: { x: 0, y: 64, z: 0 }, items: [], entities: [], blocks: [], inventory: { items: [] },
				world: { dimension: 'minecraft:overworld', dayTime: 1, raining: false, thundering: false } } } });
		await eventually(() => rows.some(({ event }) => event === 'observation_rejected'));
		const row = rows.find(({ event }) => event === 'observation_rejected');
		assert.equal(row.agentId, 'agent-a');
		assert.equal(row.goalRevision, 1);
		assert.equal(row.eventSequence, 1);
		assert.match(row.reason, /world\.gameTime/);
		// The server is still told, as before.
		await eventually(() => bridge.sent.some(({ type }) => type === 'agent_error'));
	} finally {
		await coordinator.stop();
	}
});

test('a bridge rejection, dropped or fatal, leaves a trace row with its code and reason', async () => {
	const { bridge, coordinator, rows } = await tracedCoordinator();
	try {
		let wireError;
		const wire = factToWireObservation({ world: { dimension: 'minecraft:overworld', dayTime: 1, raining: false, thundering: false } }, 1, 1, false, 1);
		try { validateProtocolV2Payload('observation', wire); }
		catch (error) { wireError = error; }
		assert.ok(wireError instanceof ProtocolV2Error);
		assert.equal(wireError.message, "world field 'gameTime' is required", 'the real wire validator is what rejects it');
		coordinator.on('runtimeError', () => {});
		bridge.emit('protocolError', wireError);
		const dropped = new ProtocolV2Error('INBOUND_MESSAGE_REJECTED', 'Dropped one observation, connection kept (1 so far with this error): MISSING_FIELD world field \'gameTime\' is required');
		bridge.emit('messageRejected', { error: dropped, type: 'observation', agentId: 'agent-a', messageId: 'm-1', count: 1, connectionEpoch: 1 });
		const fatal = rows.find(({ event }) => event === 'bridge_protocol_error');
		assert.ok(fatal, 'the fatal rejection is traced');
		assert.equal(fatal.code, wireError.code);
		assert.match(fatal.reason, /gameTime/);
		const kept = rows.find(({ event }) => event === 'bridge_message_rejected');
		assert.ok(kept, 'the dropped message is traced');
		assert.deepEqual({ code: kept.code, type: kept.type, agentId: kept.agentId, count: kept.count }, { code: 'INBOUND_MESSAGE_REJECTED', type: 'observation', agentId: 'agent-a', count: 1 });
		assert.match(kept.reason, /gameTime/);
	} finally {
		await coordinator.stop();
	}
});

test('pick_up_item with a name says it needs a seen item stableId', () => {
	const error = rejection('act', { actionType: 'pick_up_item', arguments: { targetSelector: 'nearest_item' } });
	assert.equal(error.code, 'INVALID_MINECRAFT_TOOL_ARGUMENTS');
	assert.match(error.message, /stableId/);
	assert.match(error.message, /nearest_item/, 'the rejected value is echoed');
	assert.ok(error.message.length <= 160, error.message);
	// Other entity targets say the same for their kind; a UUID still passes.
	assert.match(rejection('act', { actionType: 'fight_target', arguments: { targetId: 'nearest_hostile' } }).message, /stableId.*nearest_hostile/);
	assert.doesNotThrow(() => validateAction({ type: 'pick_up_item', targetSelector: '123e4567-e89b-12d3-a456-426614174000' }));
});

test('closed-set arguments name the accepted values and the rejected one', () => {
	const cases = [
		['observe', { view: 'diff' }, 'diff', ['full', 'changes']],
		['capabilities', { section: 'everything' }, 'everything', ['all', 'program', 'control', 'strategy', 'howto']],
		['inspect', { section: 'mobs' }, 'mobs', ['observation', 'entities', 'hud']],
		['taskMemory', { operation: 'query', query: { kind: 'notes' } }, 'notes', ['place', 'route', 'trail']],
		['queryMemory', { kind: 'places' }, 'places', ['notes', 'receipts', 'unresolved']],
		['say', { message: 'hi', audience: 'team' }, 'team', ['public', 'direct', 'proximity']],
		['respondProgram', { programId: 'p', goalRevision: 1, decisionId: 'd', directive: 'skip' }, 'skip', ['continue', 'pause', 'replace', 'finish']],
	];
	for (const [tool, args, asked, accepted] of cases) {
		const { message } = rejection(tool, args);
		for (const value of accepted) assert.ok(message.includes(value), `${tool}: ${message}`);
		assert.ok(message.includes(asked), `${tool} echoes '${asked}': ${message}`);
	}
	const topic = rejection('capabilities', { section: 'control', topic: 'flying' }).message;
	assert.match(topic, /flying/);
	assert.match(topic, /capabilities\(\{section:"control"\}\)/, 'a long topic list points at its index');
});
