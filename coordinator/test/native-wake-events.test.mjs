import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePlannerRequest, buildNativeEventInput, nativeSteerInterruption } from '../src/dynamic-main.mjs';
import { DangerSteerCoalescer } from '../src/danger-steer-coalescer.mjs';
import { protectedNativeWake } from '../src/native-wake-events.mjs';
import { decodeModelFacts, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';

const record = { goalRevision: 1, currentGoal: 'Gather wood.' };
const parse = input => JSON.parse(input.slice(input.indexOf('\n') + 1));
const wake = (trigger, sequence) => ({ goalRevision: 1, priority: 'urgent', trigger,
	nativeEvent: { event: 'observation', trigger, eventSequence: sequence,
		observation: { player: { health: 20 - sequence, lastAttacker: { type: `attacker-${sequence}` } }, world: { dimension: 'minecraft:overworld' } } } });
const ended = (sequence, state = 'SUCCEEDED') => ({ goalRevision: 1, priority: 'ordinary', trigger: 'program_ended',
	nativeEvent: { event: 'program_ended', programId: `program-${sequence}`, eventSequence: sequence,
		result: { state, reasonCode: `result-${sequence}`, receipts: [{ actionId: `action-${sequence}`, state, reasonCode: `receipt-${sequence}` }] }, observation: { player: { health: 20 } } } });

const protectedKinds = {
	danger: sequence => ({ ...wake('threat', sequence), nativeEvent: { ...wake('threat', sequence).nativeEvent,
		observation: { player: { health: 20, threats: [{ type: 'minecraft:skeleton', signals: ['ranged_aiming'] }] } } } }),
	failure: sequence => ended(sequence, 'FAILED'),
	operator: sequence => ({ ...wake('conversation', sequence), nativeEvent: { ...wake('conversation', sequence).nativeEvent, conversationOnly: true } }),
	decision: sequence => ({ goalRevision: 1, priority: 'urgent', trigger: 'attention', nativeEvent: {
		event: 'program_attention', eventSequence: sequence, programId: `p-${sequence}`,
		status: { engineState: 'PAUSED', decision: { decisionId: `decision-${sequence}`, trigger: 'attention' } } } }),
};
for (const [firstKind, first] of Object.entries(protectedKinds)) for (const [secondKind, second] of Object.entries(protectedKinds)) {
	test(`protected pair ${firstKind} then ${secondKind} retains both original envelopes`, () => {
		const a = first(1), b = second(2);
		const merged = mergePlannerRequest(a, b);
		assert.equal(protectedNativeWake(merged), true);
		assert.equal(merged.nativeEvent.mergedEvents.length, 2);
		for (const original of [a, b]) assert.deepEqual(merged.nativeEvent.mergedEvents.find(event => event.eventSequence === original.nativeEvent.eventSequence),
			{ ...original.nativeEvent, trigger: original.nativeEvent.trigger ?? original.nativeEvent.status?.decision?.trigger ?? original.trigger });
		if ([firstKind, secondKind].includes('danger')) {
			assert.equal(merged.priority, 'urgent');
			assert.equal(merged.trigger, 'threat');
			assert.equal(merged.nativeEvent.trigger, 'threat');
			assert.equal(nativeSteerInterruption(merged), 'danger');
		}
	});
}

for (const trigger of ['damage', 'threat', 'fire', 'lava', 'drowning', 'suffocation', 'fall', 'projectile']) {
	for (const dangerFirst of [true, false]) test(`${trigger} leads an equally urgent DM, danger first=${dangerFirst}`, () => {
		const danger = wake(trigger, 1), dm = protectedKinds.operator(2);
		const merged = mergePlannerRequest(...(dangerFirst ? [danger, dm] : [dm, danger]));
		assert.equal(merged.trigger, trigger);
		assert.equal(merged.nativeEvent.trigger, trigger);
		assert.deepEqual(merged.nativeEvent.mergedEvents.map(event => event.eventSequence), dangerFirst ? [1, 2] : [2, 1]);
	});
}

test('a carried program decision does not hide the leading observation danger from a later DM', () => {
	const merged = [protectedKinds.decision(1), protectedKinds.danger(2), protectedKinds.operator(3)].reduce(mergePlannerRequest, null);
	assert.equal(merged.nativeEvent.trigger, 'threat');
	assert.equal(merged.nativeEvent.mergedEvents.length, 3);
	assert.equal(nativeSteerInterruption(merged), 'danger');
});

for (const trigger of ['damage', 'threat', 'fire', 'lava', 'drowning', 'fall', 'projectile', 'action_failure']) {
	for (const dangerFirst of [true, false]) test(`${trigger} history survives program merge, danger first=${dangerFirst}`, () => {
		const danger = wake(trigger, 1), program = ended(2);
		const merged = mergePlannerRequest(...(dangerFirst ? [danger, program] : [program, danger]));
		const payload = parse(buildNativeEventInput(record, merged.nativeEvent));
		assert.equal(payload.trigger, trigger);
		assert.equal(payload.mergedEvents.length, 2);
		const historical = payload.mergedEvents.find(event => event.trigger === trigger);
		assert.equal(historical.hud.health, 19);
		assert.equal(historical.hud.lastAttacker.type, 'attacker-1');
		const encoded = decodeModelFacts(parse(encodeNativeEventInput(buildNativeEventInput(record, merged.nativeEvent))));
		const encodedHistory = encoded.mergedEvents.find(event => event.trigger === trigger);
		assert.equal(encodedHistory.hud.health, 19, 'historical health survives provider encoding');
		assert.equal(encodedHistory.hud.lastAttacker.type, 'attacker-1');
		assert.ok(payload.mergedEvents.some(event => event.program?.result.reasonCode === 'result-2'));
	});
}

test('distinct failures and paused decision handles survive arbitrary later merges and encoding', () => {
	const requests = [ended(1, 'FAILED'), ended(2, 'FAILED'), ended(3)];
	for (let index = 4; index <= 5; index++) requests.push({ goalRevision: 1, priority: 'ordinary', trigger: 'attention',
		nativeEvent: { event: 'program_attention', programId: `p-${index}`, status: { engineState: 'PAUSED', decision: { decisionId: `decision-${index}`, trigger: 'attention' } } } });
	const merged = requests.reduce(mergePlannerRequest, null);
	const payload = decodeModelFacts(parse(encodeNativeEventInput(buildNativeEventInput(record, merged.nativeEvent))));
	assert.equal(payload.mergedEvents.length, 5);
	for (const id of [1, 2]) assert.ok(payload.mergedEvents.some(event => event.program?.result.reasonCode === `result-${id}`));
	for (const id of [4, 5]) assert.ok(payload.mergedEvents.some(event => event.program?.decision?.decisionId === `decision-${id}`));
	assert.equal(mergePlannerRequest(merged, requests[0]).nativeEvent.mergedEvents.length, 5, 'retry does not duplicate an identical envelope');
});

test('protected history exceeds optional context budget without dropping a danger or unread DM', () => {
	let request = null;
	for (let index = 1; index <= 50; index++) request = mergePlannerRequest(request, wake('damage', index));
	const payload = parse(buildNativeEventInput(record, { ...request.nativeEvent, conversation: { mode: 'unread', entries: [
		{ sequence: 1, kind: 'player_message', text: 'First operator DM' }, { sequence: 2, kind: 'player_message', text: 'Second operator DM' },
	] } }));
	assert.equal(payload.mergedEvents.length, 50);
	assert.deepEqual(payload.mergedEvents.map(event => event.eventSequence), Array.from({ length: 50 }, (_, i) => i + 1));
	assert.equal(payload.conversation.entries.length, 2);
	assert.equal(mergePlannerRequest(request, { ...ended(51), goalRevision: 2 }).nativeEvent.mergedEvents, undefined);
});

test('repeat-danger folding carries every original edge on the next boundary flush', () => {
	const coalescer = new DangerSteerCoalescer();
	coalescer.noteDelivered(wake('damage', 1), 0);
	assert.equal(coalescer.offer(wake('damage', 2), 10).action, 'fold');
	assert.equal(coalescer.offer(wake('damage', 3), 20).action, 'fold');
	const request = coalescer.flush(30);
	assert.deepEqual(request.nativeEvent.mergedEvents.map(event => event.eventSequence), [2, 3]);
});

test('owed history remains protected under a later ordinary observation', () => {
	const failure = { ...wake('action_failure', 1), priority: 'ordinary' };
	const ordinary = { ...wake('observation', 2), priority: 'ordinary' };
	const merged = mergePlannerRequest(failure, ordinary);
	assert.equal(merged.nativeEvent.trigger, 'observation');
	assert.equal(protectedNativeWake(merged), true);
	assert.equal(merged.nativeEvent.mergedEvents[0].trigger, 'action_failure');
});

test('a leading urgent decision keeps its own program identity when another program ends', () => {
	const decision = { goalRevision: 1, priority: 'urgent', trigger: 'threat', nativeEvent: {
		event: 'program_attention', programId: 'paused-program', status: { engineState: 'PAUSED', decision: { decisionId: 'paused-decision', priority: 'urgent', trigger: 'threat' } },
	} };
	const payload = parse(buildNativeEventInput(record, mergePlannerRequest(decision, ended(2)).nativeEvent));
	assert.equal(payload.program.programId, 'paused-program');
	assert.equal(payload.program.decision.decisionId, 'paused-decision');
	assert.ok(payload.mergedEvents.some(event => event.program?.programId === 'program-2'));
});

test('an owed event keeps its own facts and failed receipts but not its copy of the world', () => {
	const blocks = Array.from({ length: 32 }, (_, x) => ({ x, y: 64, z: 0, blockId: 'minecraft:stone' }));
	const first = ended(1, 'FAILED'), next = ended(2);
	first.nativeEvent.observation.blocks = blocks;
	first.nativeEvent.observation.lastResult = { actionId: 'action-1', state: 'FAILED', reasonCode: 'NO_PATH' };
	next.nativeEvent.observation.blocks = blocks.slice(0, 8);
	first.nativeEvent.result.receipts = Array.from({ length: 20 }, (_, index) => ({ actionId: `a-${index}`, state: index === 0 ? 'FAILED' : 'SUCCEEDED', reasonCode: `r-${index}`, message: `receipt-${index}` }));
	const before = parse(buildNativeEventInput(record, first.nativeEvent));
	const payload = parse(buildNativeEventInput(record, mergePlannerRequest(first, next).nativeEvent));
	const history = payload.mergedEvents[0];
	assert.equal(history.observation.blocks, undefined, 'the owed event leaves its world rows out');
	assert.deepEqual(history.observation.player, before.observation.player);
	assert.deepEqual(history.observation.lastResult, before.observation.lastResult);
	assert.equal(payload.observation.blocks.length, 8, 'the wake itself carries the newest world');
	assert.equal(history.program.result.receipts.length, 9);
	assert.equal(history.program.result.receipts[0].message, 'receipt-0');
	assert.equal(history.program.result.omittedReceipts, 11);
});

test('older failed receipts of an owed result are capped at 8 beside its newest 8', () => {
	const first = ended(1, 'FAILED'), next = wake('threat', 3);
	first.nativeEvent.result.receipts = Array.from({ length: 64 }, (_, index) => ({ actionId: `a-${index}`, state: 'FAILED', reasonCode: `r-${index}` }));
	first.nativeEvent.result.failure = 'the whole program failed';
	const history = parse(buildNativeEventInput(record, mergePlannerRequest(next, first).nativeEvent)).mergedEvents.find((entry) => entry.program?.result !== undefined);
	assert.equal(history.program.result.receipts.length, 16);
	assert.equal(history.program.result.omittedReceipts, 48);
	assert.equal(history.program.result.receipts.at(-1).actionId, 'a-63', 'the newest receipt is kept');
	assert.equal(history.program.result.failure, 'the whole program failed');
});

test('86 owed danger wakes from a long step stay in order and the wake stays bounded', () => {
	// Fresh r5: a 13.7 min obtain kept the model's turn open; 86 owed wakes reached the model at its end in one 1 MB wake.
	const world = (sequence) => ({ blocks: Array.from({ length: 120 }, (_, x) => ({ x: x + sequence, y: 64, z: sequence, blockId: 'minecraft:stone' })),
		entities: Array.from({ length: 12 }, (_, index) => ({ uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, type: 'minecraft:zombie', x: index + sequence, y: 64, z: 0, distance: 8 + index })),
		inventory: { items: Array.from({ length: 30 }, (_, slot) => ({ slot, itemId: 'minecraft:cobblestone', count: 64 - slot })) } });
	let merged = null;
	for (let sequence = 1; sequence <= 86; sequence += 1) {
		const next = wake('damage', sequence);
		next.nativeEvent.observation.player.health = 20 - (sequence % 10);
		Object.assign(next.nativeEvent.observation, world(sequence));
		merged = merged === null ? next : mergePlannerRequest(merged, next);
	}
	const input = buildNativeEventInput(record, merged.nativeEvent);
	const payload = parse(input);
	assert.equal(payload.mergedEvents.length, 86, 'every owed event is still listed');
	assert.deepEqual(payload.mergedEvents.map((entry) => entry.eventSequence ?? entry.observation?.eventSequence), Array.from({ length: 86 }, (_, index) => index + 1));
	assert.ok(payload.mergedEvents.every((entry) => entry.observation.blocks === undefined && entry.observation.entities === undefined && entry.observation.inventory === undefined));
	assert.ok(Buffer.byteLength(input) < 200_000, `wake ${Buffer.byteLength(input)} bytes`);
	// The raw queue is untouched: steering still reads each owed event's full facts.
	assert.equal(merged.nativeEvent.mergedEvents[0].observation.blocks.length, 120);
});

test('a promoted aiming threat row interrupts and reaches model input', () => {
	const skeleton = '00000000-0000-4000-8000-000000000009';
	const entries = Array.from({ length: 7 }, (_, index) => ({ uuid: `00000000-0000-4000-8000-00000000000${index}`, type: 'minecraft:zombie', distance: 6, signals: ['attacked'] }));
	entries.push({ uuid: skeleton, type: 'minecraft:skeleton', distance: 10, signals: ['targeting', 'ranged_sight', 'ranged_aiming'] });
	const request = { goalRevision: 1, priority: 'urgent', trigger: 'threat',
		nativeEvent: { event: 'observation', trigger: 'threat', eventSequence: 9, observation: { player: { health: 20, threats: entries } } } };
	assert.equal(nativeSteerInterruption(request), 'danger');
	const input = buildNativeEventInput(record, request.nativeEvent);
	assert.match(input, /ranged_aiming/);
	assert.ok(input.includes(skeleton.slice(-12)) || input.includes(skeleton), 'the aiming threat is identified in model input');
});

for (const [trigger, player, lead] of [
	['drowning', { underWater: true, air: 60, maxAir: 300, breathable: { x: 4, y: 65, z: 8, distance: 1, direction: 'up' } }, /drowning\. 3s air left; Breathable 4,65,8 1m up/],
	['cloud', { clouds: [{ harmful: true, contact: true, nearestExit: { x: 4, y: 64, z: 8 } }], harm: { source: 'minecraft:dragon_breath', hpLossPerSecond: 3 } }, /harmful cloud contact\. 3 HP\/s; Nearest exit 4,64,8/],
	['projectile', { incomingProjectiles: [{ type: 'minecraft:small_fireball', damaging: true, etaSeconds: 0.4, bearing: 20 }] }, /incoming small_fireball hits in 0.4s, bearing 20/],
]) test(`${trigger} wake and program decision lead with the current danger facts`, () => {
	for (const event of ['observation', 'program_attention']) {
		const input = buildNativeEventInput(record, { event, trigger, observation: { player },
			...(event === 'program_attention' ? { status: { engineState: 'SUSPENDED', decision: { decisionId: 'd1', trigger, priority: 'urgent' } } } : {}) });
		assert.match(input.split('\n')[0], lead);
		assert.doesNotMatch(input.split('\n')[0], /Update; act on fresh facts/);
	}
});

test('F1 air feedback distinguishes surfacing from travel and offers refill and route choices', () => {
	const input = buildNativeEventInput(record, { event: 'observation', trigger: 'drowning', observation: {
		player: { underWater: true, air: 290, maxAir: 300, waterMotion: 'sinking', breathable: { x: 666.5, y: 62.75, z: 2522.5, distance: 2, direction: 'up' } },
	} });
	assert.match(input.split('\n')[0], /14.5s air left; Breathable 666.5,62.75,2522.5 2m up/);
	assert.match(input.split('\n')[0], /Surfacing alone does not advance a route.*do_step escape.*swims to air and out onto dry footing.*moveTo travel.*doors create air/);
	assert.doesNotMatch(input.split('\n')[0], /hold jump/);
});

test('afloat recovery is explained after surfacing, including when the air bar is full', () => {
	for (const air of [0, 140, 300]) {
		const player = { health: 14, inWater: true, underWater: false, onGround: false, air, maxAir: 300 };
		const lead = patch => buildNativeEventInput(record, { event: 'observation', trigger: 'attention',
			observation: { player: { ...player, ...patch }, currentAction: { active: false } } }).split('\n')[0];
		assert.match(lead({}), /body still afloat.*Released input sinks.*Guard deletion cancels/);
		for (const patch of [{ onGround: true }, { inWater: false }, { passenger: true }, { dead: true }]) {
			assert.doesNotMatch(lead(patch), /body still afloat/);
		}
	}
});

test('ground-ahead facts reach model event HUD before any movement command', () => {
	const groundAhead = { status: 'unknown', at: 0.5, drop: 0, atLeast: true };
	const input = decodeModelFacts(parse(encodeNativeEventInput(buildNativeEventInput(record, {
		event: 'observation', trigger: 'attention', observation: { player: { health: 20, onGround: true, groundAhead } },
	}))));
	assert.deepEqual(input.observation.groundAhead, groundAhead);
});
