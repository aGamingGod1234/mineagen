import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationWakes, canonicalConversationEntry } from '../src/conversation-memory.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { buildNativeEventInput, routinePerceptionChange } from '../src/dynamic-main.mjs';

const PLAYER = '11111111-1111-4111-8111-111111111111';
const event = (kind, scope, extra = {}) => ({ sequence: 1, kind, sourceId: PLAYER, recipientId: 'agent-a', scope, text: 'hello',
	goalRevision: 0, observedAtEpochMs: 1, ...extra });

test('conversation wake table: DMs from anyone and the operator\'s nearby speech wake; public chat never does', () => {
	const rows = [
		['operator DM', event('player_message', 'direct', { operator: true }), true],
		['other player DM', event('player_message', 'direct'), true],
		['agent DM', event('agent_message', 'direct'), true],
		['agent public chat', event('agent_message', 'public'), false],
		['agent nearby speech', event('agent_message', 'proximity'), false],
		['operator nearby speech', event('proximity_speech', 'proximity', { operator: true }), true],
		['other player nearby speech', event('proximity_speech', 'proximity'), false],
	];
	for (const [label, value, wakes] of rows) {
		assert.equal(conversationWakes(value), wakes, label);
		assert.equal(conversationWakes(canonicalConversationEntry(value)), wakes, `${label} after the inbox stores it`);
	}
});

test('conversation events carry the sender name and an operator flag that is only present when true', () => {
	const normalized = validateProtocolV2Payload('conversation_event', event('player_message', 'direct', { sourceName: 'ExamplePlayer', operator: true }));
	assert.equal(normalized.sourceName, 'ExamplePlayer');
	assert.equal(normalized.operator, true);
	assert.equal(Object.hasOwn(validateProtocolV2Payload('conversation_event', event('player_message', 'direct', { operator: false })), 'operator'), false);
	assert.throws(() => validateProtocolV2Payload('conversation_event', event('player_message', 'direct', { operator: 'yes' })), /operator must be boolean/);
	assert.equal(canonicalConversationEntry(event('player_message', 'direct', { sourceName: 'Alex' })).sourceName, 'Alex');
});

test('the model sees who wrote each message and whether they are the operator, without internal routing fields', () => {
	const input = buildNativeEventInput({ agentId: 'agent-a', goalRevision: 0, currentGoal: null }, {
		event: 'player_message', trigger: 'conversation', conversationOnly: true, observation: {},
		conversation: { mode: 'unread', baseSequence: 0, nextSequence: 2, entries: [
			canonicalConversationEntry(event('player_message', 'direct', { sourceName: 'ExamplePlayer', operator: true })),
			canonicalConversationEntry(event('player_message', 'direct', { sequence: 2, sourceId: '22222222-2222-4222-8222-222222222222', sourceName: 'Alex' })),
		] },
	});
	const payload = JSON.parse(input.slice(input.indexOf('\n') + 1));
	assert.deepEqual(payload.conversation.entries, [
		{ sequence: 1, kind: 'player_message', sourceId: PLAYER, sourceName: 'ExamplePlayer', operator: true, scope: 'direct', text: 'hello', observedAtEpochMs: 1 },
		{ sequence: 2, kind: 'player_message', sourceId: '22222222-2222-4222-8222-222222222222', sourceName: 'Alex', scope: 'direct', text: 'hello', observedAtEpochMs: 1 },
	]);
	assert.match(input, /Only operator:true messages are tasks/);
});

test('Minecraft\'s lines for public and nearby chat ride the next wake; DM lines still wake', () => {
	const payload = { attention: true, changedFacts: ['perception'] };
	const wire = (text) => ({ perception: { events: [{ sequence: 4, type: 'system_message', text }] } });
	assert.equal(routinePerceptionChange(payload, wire('<Axiom> anyone have iron?'), 3, 'Iris'), true, 'another agent\'s public chat');
	assert.equal(routinePerceptionChange(payload, wire('[Nearby] <Axiom> over here'), 3, 'Iris'), true, 'another agent\'s nearby speech');
	assert.equal(routinePerceptionChange(payload, { perception: { events: [{ sequence: 4, type: 'player_chat', text: '<Steve> hi all' }] } }, 3, 'Iris'), true, 'vanilla public chat');
	assert.equal(routinePerceptionChange(payload, wire('[Axiom] Mining a block'), 3, 'Iris', ['Iris', 'Axiom']), true, "another agent's activity line");
	assert.equal(routinePerceptionChange(payload, wire('[Axiom] Mining a block'), 3, 'Iris'), false, 'an unknown bracketed name keeps its wake');
	assert.equal(routinePerceptionChange(payload, wire('[DM] Alex -> Iris: hi'), 3, 'Iris', ['Iris', 'Axiom']), false, 'a DM line still wakes');
	assert.equal(routinePerceptionChange(payload, wire('You may not rest now; there are monsters nearby'), 3, 'Iris'), false, 'other system messages keep their wake');
});

test('a default-named bot\'s activity lines, shown under its label rather than its player name, do not wake other bots', async () => {
	const { AgentRegistry } = await import('../src/agent-registry.mjs');
	const { agentLineNames } = await import('../src/observation-facts.mjs');
	const registry = new AgentRegistry();
	// The server's agent_registered payload for two bots that kept their default names.
	for (const [agentId, name, chatLabel] of [['agent-a', 'Claude_Opus_5_5', 'Opus 5.5'], ['agent-b', 'Claude_Opus_5_52', 'Opus 5.5 2']]) {
		const payload = validateProtocolV2Payload('agent_registered', { schemaVersion: 1, agentId, name, chatLabel, provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low',
			gameMode: 'survival', skinVariant: 'variant-0', state: 'IDLE', goalRevision: 0, queue: [], createdAtEpochMs: 1, updatedAtEpochMs: 1 });
		registry.register(payload);
	}
	const names = agentLineNames(registry.list());
	const payload = { attention: true, changedFacts: ['perception'] };
	const wire = (text) => ({ perception: { events: [{ sequence: 4, type: 'system_message', text }] } });
	assert.equal(routinePerceptionChange(payload, wire('[Opus 5.5 2] Working on it.'), 3, 'Claude_Opus_5_5', names, 'Opus 5.5'), true, "another bot's activity line");
	assert.equal(routinePerceptionChange(payload, wire('[Opus 5.5] Mining a block'), 3, 'Claude_Opus_5_5', [], 'Opus 5.5'), true, 'its own activity line');
	assert.equal(routinePerceptionChange(payload, wire('<Claude_Opus_5_52> anyone have iron?'), 3, 'Claude_Opus_5_5', names, 'Opus 5.5'), true, 'chat still matches the player name');
	assert.equal(routinePerceptionChange(payload, wire('[Server] restarting soon'), 3, 'Claude_Opus_5_5', names, 'Opus 5.5'), false, 'an unknown bracketed name keeps its wake');
});
