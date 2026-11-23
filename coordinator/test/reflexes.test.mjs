import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildNativeEventInput, nativeObservationSignature } from '../src/dynamic-main.mjs';
import { createInterpreterFacts } from '../src/arena-script/facts.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { DEFAULT_REFLEXES, DIMENSION_REFLEXES, MAX_REFLEXES, MAX_REFLEX_REPORT_BYTES, REFLEX_ACTIONS, REFLEX_CONDITIONS, REFLEX_RESEND_MS, ReflexBook, normalizeReflexEntries, MAX_REFLEX_RULES } from '../src/reflexes.mjs';

const SHIELD = { id: 'blaze-shield', kind: 'stance', priority: 7, when: [{ type: 'hostile_near', within: 12, mobs: ['blaze'] }], do: { type: 'shield' }, maxS: 8 };
const SWAP = { id: 'tool-swap', when: { type: 'tool_broke', tool: 'pickaxe' }, do: { type: 'select', tool: 'pickaxe' }, wake: true };

test('runProgram({reflexes}) alone installs rules in canonical wire form; with source it rides on the program', () => {
	const tool = normalizeMinecraftToolCall('runProgram', { reflexes: [SHIELD, SWAP] });
	assert.equal(tool.kind, 'reflexes');
	assert.deepEqual(tool.reflexes[0], { id: 'blaze-shield', kind: 'stance', priority: 7, when: [{ type: 'hostile_near', within: 12, mobs: ['minecraft:blaze'] }], do: { type: 'shield' }, maxMs: 8000 });
	assert.deepEqual(tool.reflexes[1], { id: 'tool-swap', kind: 'trigger', when: [{ type: 'tool_broke', tool: 'pickaxe' }], do: { type: 'select', tool: 'pickaxe' }, wake: true });
	const program = normalizeMinecraftToolCall('runProgram', { source: 'await player.wait(1);', background: true, reflexes: [{ id: 'swap', remove: true }] });
	assert.equal(program.kind, 'run_program');
	assert.deepEqual(program.reflexes, [{ id: 'swap', remove: true }]);
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { reflexes: [SHIELD], background: true }), /takes only reflexes/);
	// The reflexes tool is the same rules-only install, offered even when the program tools are not.
	assert.deepEqual(normalizeMinecraftToolCall('reflexes', { reflexes: [SHIELD, SWAP] }), tool);
	assert.deepEqual(normalizeMinecraftToolCall('reflexes', { reflexes: [] }), { kind: 'reflexes', reflexes: [] }, 'an empty list only lists the set');
	assert.deepEqual(normalizeMinecraftToolCall('reflexes', { reflexes: [{ id: 'swap', remove: true }] }).reflexes, [{ id: 'swap', remove: true }]);
	assert.throws(() => normalizeMinecraftToolCall('reflexes', { reflexes: [SHIELD], source: 'await player.wait(1);' }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	assert.throws(() => normalizeMinecraftToolCall('reflexes', {}), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
});

test('act, sequence and a standing order carry reflexes, so the call answering a danger also arms its rules', () => {
	const equip = { actionType: 'equip_item', arguments: { sourceSlot: 2, targetSlot: 'offhand', expectedItemId: 'minecraft:shield' } };
	const act = normalizeMinecraftToolCall('act', { ...equip, reflexes: [SHIELD] });
	assert.deepEqual(act, { ...normalizeMinecraftToolCall('act', equip), reflexes: normalizeReflexEntries([SHIELD]) });
	const sequence = normalizeMinecraftToolCall('sequence', { actions: [equip, { actionType: 'select_item', arguments: { itemId: 'minecraft:iron_sword' } }], reflexes: [SWAP] });
	assert.equal(sequence.kind, 'sequence');
	assert.deepEqual(sequence.reflexes, normalizeReflexEntries([SWAP]));
	const standing = normalizeMinecraftToolCall('runProgram', { standing: { id: 'low', when: 'player.state().health < 8', guard: true }, source: 'await player.wait(1);', reflexes: [SHIELD] });
	assert.equal(standing.kind, 'standing_order');
	assert.deepEqual(standing.reflexes, normalizeReflexEntries([SHIELD]));
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { standing: { id: 'low' }, reflexes: [SHIELD] }), /Deleting a standing order takes only standing.id/);
	assert.throws(() => normalizeMinecraftToolCall('act', { ...equip, reflexes: [{ ...SHIELD, do: { type: 'shield', maxS: 1 } }] }), /do has maxS, a rule field: put it on reflexes\[0\]/);
});

test('invalid reflexes are refused with errors that name the field and the allowed vocabulary', () => {
	const refuse = (entry, pattern) => assert.throws(() => normalizeReflexEntries([entry]), pattern);
	refuse({ ...SHIELD, when: { type: 'teleport' } }, /is not a reflex condition; use one of incoming_projectile, hostile_near/);
	refuse({ ...SHIELD, when: { type: 'hostile_near' } }, /reflexes\[0\]\.when\.within is required/);
	refuse({ ...SHIELD, when: { type: 'hostile_near', within: 100 } }, /between 1 and 32/);
	refuse({ ...SHIELD, when: { type: 'on_fire', not: true } }, /at least one condition that is not negated/);
	refuse({ ...SHIELD, do: { type: 'select', tool: 'pickaxe', item: 'minecraft:stone_pickaxe' } }, /exactly one of tool or item/);
	refuse({ ...SHIELD, do: { type: 'fly' } }, /is not a reflex action; use one of shield, attack/);
	refuse({ ...SHIELD, kind: 'always' }, /trigger \(fires once/);
	refuse({ ...SHIELD, maxS: 601 }, /maxS must be seconds between 0.25 and 600/);
	refuse({ ...SHIELD, extra: 1 }, /unknown field extra/);
	assert.throws(() => normalizeReflexEntries([SHIELD, SHIELD]), /same id twice/);
});

test('the coordinator vocabulary matches the mod vocabulary (ReflexSpec.java)', () => {
	const java = readFileSync(new URL('../../src/main/java/dev/agaminggod/mineagen/server/runtime/reflex/ReflexSpec.java', import.meta.url), 'utf8');
	const declared = (kind) => [...java.matchAll(new RegExp(`\\t\\t${kind}\\("([a-z_]+)"`, 'g'))].map((match) => match[1]).sort();
	assert.deepEqual(declared('condition'), Object.keys(REFLEX_CONDITIONS).sort());
	assert.deepEqual(declared('action'), Object.keys(REFLEX_ACTIONS).sort());
	for (const [type, params] of Object.entries(REFLEX_CONDITIONS)) for (const name of Object.keys(params)) assert.match(java, new RegExp(`condition\\("${type}"[^;]*"${name}"`), `${type}.${name}`);
});

test('the book replaces by id, removes, bounds the set, and reports firings once in a short wake line', () => {
	let now = 0;
	const book = new ReflexBook({ now: () => now });
	book.apply('a', normalizeReflexEntries([SHIELD, SWAP]));
	assert.equal(book.payload('a').revision, 1);
	assert.throws(() => book.apply('a', normalizeReflexEntries(Array.from({ length: MAX_REFLEXES - 1 }, (_, index) => ({ ...SWAP, id: `r${index}` })))), /At most 12 reflexes/);
	assert.equal(book.list('a').length, 2, 'a refused apply changes nothing');
	const status = { revision: 1, rules: [{ id: 'blaze-shield', kind: 'stance', state: 'armed', fired: 1, expiresInS: 590 }, { id: 'tool-swap', kind: 'trigger', state: 'disabled', fired: 4, expiresInS: 590, disabled: 'fired 4x in a row without progress; last: no pickaxe in hotbar' }],
		events: [{ seq: 1, id: 'blaze-shield', outcome: 'done', ms: 6200, detail: 'blocked 3 hit(s)' }, { seq: 2, id: 'tool-swap', outcome: 'failed', ms: 50, detail: 'no pickaxe in hotbar', wake: true }] };
	const observed = book.observe('a', status);
	assert.equal(observed.events.length, 2);
	assert.equal(observed.wake, true);
	assert.equal(observed.resend, false);
	const report = book.takeReport('a');
	assert.ok(report.startsWith('armed blaze-shield(stance), tool-swap(disabled); fired: blaze-shield done 6.2 s: blocked 3 hit(s); tool-swap failed: no pickaxe in hotbar'));
	assert.deepEqual(JSON.parse(report.split('; rules: ')[1]), [SHIELD, SWAP].map(rule => ({ id: rule.id, kind: rule.kind ?? 'trigger', priority: rule.priority ?? 5, when: normalizeReflexEntries([rule])[0].when, do: rule.do })));
	assert.equal(book.observe('a', status).events.length, 0, 'a report is delivered once');
	assert.ok(book.takeReport('a').startsWith('armed blaze-shield(stance), tool-swap(disabled); rules: '));
	book.apply('a', normalizeReflexEntries([{ id: '*', remove: true }]));
	assert.equal(book.list('a').length, 0);
	assert.equal(book.observe('a', undefined).resend, false, 'a just-sent set is not re-sent at once');
	now += REFLEX_RESEND_MS;
	assert.equal(book.observe('a', undefined).resend, true, 'a set the mod does not echo is re-sent');
});

test('protocol carries reflex_update and the observation reflex status', () => {
	const payload = validateProtocolV2Payload('reflex_update', { revision: 2, rules: normalizeReflexEntries([SHIELD]), yield: false });
	assert.equal(payload.rules[0].id, 'blaze-shield');
	assert.throws(() => validateProtocolV2Payload('reflex_update', { revision: 2, rules: [], yield: false, extra: 1 }));
	// A full set: every rule the model may arm plus the defaults. The wire once capped this at 12 and refused it.
	const full = normalizeReflexEntries(Array.from({ length: MAX_REFLEXES }, (_, index) => ({ ...SHIELD, id: `rule-${index}` }))).concat(DEFAULT_REFLEXES);
	assert.equal(validateProtocolV2Payload('reflex_update', { revision: 3, rules: full, yield: false }).rules.length, MAX_REFLEXES + DEFAULT_REFLEXES.length);
	assert.match(readFileSync(new URL('../../src/main/java/dev/agaminggod/mineagen/server/runtime/reflex/ReflexSpec.java', import.meta.url), 'utf8'),
		new RegExp(`MAX_RULES = ${MAX_REFLEX_RULES};`), 'the mod accepts the same full set');
	// C24: both wire bounds cap at the mod's 32, one more rule is refused, and the full set (with the End's own defaults) fits.
	assert.equal(MAX_REFLEX_RULES, 32);
	assert.ok(MAX_REFLEXES + DEFAULT_REFLEXES.length + DIMENSION_REFLEXES['minecraft:the_end'].length <= MAX_REFLEX_RULES);
	const over = Array.from({ length: MAX_REFLEX_RULES + 1 }, (_, index) => ({ ...full[0], id: `rule-${index}` }));
	assert.throws(() => validateProtocolV2Payload('reflex_update', { revision: 4, rules: over, yield: false }), 'one rule over the cap is refused on the wire');
	const statusRow = (index) => ({ id: `rule-${index}`, kind: 'stance', state: 'armed', fired: 0, expiresInS: 599 });
	assert.throws(() => validateProtocolV2Payload('observation', { ...wire(), goalRevision: 3, observedAtEpochMs: 1, status: 'ready', eventSequence: 4, attention: false, changedFacts: [],
		reflexes: { revision: 2, rules: Array.from({ length: MAX_REFLEX_RULES + 1 }, (_, index) => statusRow(index)), events: [] } }), 'a status with 27 rows is refused');
	assert.equal(validateProtocolV2Payload('observation', { ...wire(), goalRevision: 3, observedAtEpochMs: 1, status: 'ready', eventSequence: 4, attention: false, changedFacts: [],
		reflexes: { revision: 2, rules: Array.from({ length: MAX_REFLEX_RULES }, (_, index) => statusRow(index)), events: [] } }).reflexes.rules.length, MAX_REFLEX_RULES);
	// State.rule stays final: a stance flip builds a new State instead of swapping the rule in place.
	assert.match(readFileSync(new URL('../../src/main/java/dev/agaminggod/mineagen/server/runtime/reflex/ReflexScheduler.java', import.meta.url), 'utf8'),
		/final ReflexSpec\.Rule rule;/, 'State.rule is final');
	const observation = validateProtocolV2Payload('observation', { ...wire(), goalRevision: 3, observedAtEpochMs: 1, status: 'ready', eventSequence: 4, attention: false, changedFacts: [],
		reflexes: { revision: 2, firing: { id: 'blaze-shield', ms: 900, detail: 'shield raised' }, rules: [{ id: 'blaze-shield', kind: 'stance', state: 'firing', fired: 1, expiresInS: 599 }], events: [] } });
	assert.equal(observation.reflexes.firing.id, 'blaze-shield');
	const facts = createInterpreterFacts(adaptObservation(observation));
	assert.equal(facts.world.state.reflexes.rules[0].state, 'firing', 'programs read world.state().reflexes');
});

function wire(player = {}) {
	return { ready: true, position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, view: { yaw: 0, pitch: 0 },
		player: { health: 20, maxHealth: 20, armor: 0, foodLevel: 20, saturation: 5, gameMode: 'survival', onGround: true, inWater: false, onFire: false,
			air: 300, maxAir: 300, suffocating: false, fallDistance: 0, effects: [], ...player },
		inventory: { items: [], selectedItem: 'minecraft:air' }, entities: [], blocks: [], nearbyContainers: [],
		world: { dimension: 'minecraft:overworld', gameTime: 1, dayTime: 1, raining: false, thundering: false },
		currentAction: { active: false }, lastResult: { present: false } };
}

const record = (goalRevision = 3) => ({ agentId: 'agent-a', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'standard', goalRevision, currentGoal: 'beat the game' });
const call = (tool, goalRevision = 3, id = 'call-1') => ({ agentId: 'agent-a', goalRevision, turnId: 'turn-1', callId: id, tool });

test('the runtime sends the set, yields a firing to a direct command, wakes on wake reports and keeps rules across goal revisions', async () => {
	const sent = [];
	const events = [];
	let sequence = 1;
	const runtime = new NativeToolRuntime({
		// The model's own rules alone (the default rules have their own test).
		reflexBook: new ReflexBook({ defaults: [] }),
		bridge: { send: async (type, agentId, payload) => { sent.push({ type, payload }); } },
		requestObservation: async () => ({ observation: adaptObservation(wire()), eventSequence: ++sequence }),
		onProgramEvent: (_record, event) => { events.push(event); },
	});
	const observe = (reflexes, goalRevision = 3) => runtime.updateObservation(record(goalRevision), adaptObservation({ ...wire(), ...(reflexes === undefined ? {} : { reflexes }) }), { eventSequence: ++sequence });
	observe(undefined);
	const installed = await runtime.execute(call(normalizeMinecraftToolCall('runProgram', { reflexes: [SHIELD, SWAP] })), record());
	assert.equal(installed.state, 'REFLEXES');
	assert.deepEqual(installed.reflexes.map((row) => row.state), ['pending', 'pending']);
	const update = sent.find((entry) => entry.type === 'reflex_update');
	assert.deepEqual(update.payload, { revision: 1, rules: normalizeReflexEntries([SHIELD, SWAP]), yield: false });

	const rules = [{ id: 'blaze-shield', kind: 'stance', state: 'firing', fired: 1, expiresInS: 599 }, { id: 'tool-swap', kind: 'trigger', state: 'armed', fired: 0, expiresInS: 599 }];
	observe({ revision: 1, firing: { id: 'blaze-shield', ms: 400 }, rules, events: [] });
	assert.equal(runtime.reflexList(record())[0].state, 'firing');
	sent.length = 0;
	await runtime.execute(call(normalizeMinecraftToolCall('startAction', { actionType: 'look_at', arguments: { x: 1, y: 64, z: 1 } }), 3, 'call-2'), record()).catch(() => {});
	assert.deepEqual(sent[0], { type: 'reflex_update', payload: { revision: 1, rules: normalizeReflexEntries([SHIELD, SWAP]), yield: true } }, 'a direct command takes the body from the firing first');

	observe({ revision: 1, rules, events: [{ seq: 1, id: 'tool-swap', outcome: 'done', ms: 50, detail: 'selected minecraft:iron_pickaxe in slot 2', wake: true }] });
	assert.equal(events.at(-1)?.event, 'reflex_report', 'a wake:true report wakes the model');
	const line = runtime.reflexReport(record());
	assert.match(line, /tool-swap done: selected minecraft:iron_pickaxe in slot 2/);
	const input = buildNativeEventInput(record(), { event: 'reflex_report', trigger: 'reflex_report', observation: adaptObservation(wire()), continuity: { reflexes: line } });
	assert.match(input, /"reflexes":"armed blaze-shield\(stance\), tool-swap; fired: tool-swap done/);

	await runtime.dispose('agent-a', 'goal_revised');
	assert.equal(runtime.reflexList(record(4)).length, 2, 'rules persist across goal revisions');
});

test('a direct action installs its carried rules before it acts and reports them, even when the action is refused', async () => {
	const sent = [];
	let sequence = 1;
	const runtime = new NativeToolRuntime({
		// The model's own rules alone (the default rules have their own test).
		reflexBook: new ReflexBook({ defaults: [] }),
		bridge: { send: async (type, agentId, payload) => { sent.push({ type, payload }); } },
		requestObservation: async () => ({ observation: adaptObservation(wire()), eventSequence: ++sequence }),
	});
	runtime.updateObservation(record(), adaptObservation(wire()), { eventSequence: ++sequence });
	const tool = normalizeMinecraftToolCall('act', { actionType: 'look_at', arguments: { x: 1, y: 64, z: 1 }, reflexes: [SHIELD] });
	const pending = runtime.execute(call(tool), record()).catch((error) => error);
	for (let i = 0; i < 50 && sent.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(sent[0], { type: 'reflex_update', payload: { revision: 1, rules: normalizeReflexEntries([SHIELD]), yield: false } }, 'rules reach the mod before the action');
	assert.ok(sent.length >= 2 && sent.slice(1).every((entry) => !JSON.stringify(entry.payload ?? {}).includes('blaze-shield')), 'the action itself carries no rules');
	assert.equal(runtime.reflexList(record()).length, 1);
	await runtime.dispose('agent-a', 'goal_revised');
	const outcome = await pending;
	assert.deepEqual(outcome?.reflexes?.map((row) => row.id), ['blaze-shield'], 'the result or failure lists the installed rules');
});

test('authored rule details use spare wake space without displacing firing failures', () => {
 const book = new ReflexBook();
 book.apply('a', normalizeReflexEntries(Array.from({ length: MAX_REFLEXES }, (_, i) => ({ ...SWAP, id: `swap-${i}` }))));
 book.observe('a', { revision: 1, rules: Array.from({ length: MAX_REFLEXES }, (_, i) => ({ id: `swap-${i}`, state: 'armed', fired: 0, expiresInS: 600 })), events: [
  { seq: 1, id: 'swap-0', outcome: 'failed', ms: 50, detail: 'no pickaxe in hotbar ' + 'x'.repeat(180) },
  { seq: 2, id: 'swap-1', outcome: 'failed', ms: 50, detail: 'no shield in either hand ' + 'y'.repeat(180) },
 ] });
 const report = book.takeReport('a');
 assert.ok(Buffer.byteLength(report) <= MAX_REFLEX_REPORT_BYTES);
 assert.match(report, /no pickaxe in hotbar/);
 assert.match(report, /no shield in either hand/);
 const details = report.split('; rules: ')[1];
 if (details) assert.ok(JSON.parse(details).length < MAX_REFLEXES);
 const quiet = book.takeReport('a');
 assert.ok(Buffer.byteLength(quiet) <= MAX_REFLEX_REPORT_BYTES);
 assert.ok(JSON.parse(quiet.split('; rules: ')[1]).length > 0);
});

test('a rule armed without the item its action needs says so at once and when the item is later lost; it still arms', () => {
	const book = new ReflexBook({ now: () => 1_000 });
	const sample = (items) => ({ inventory: { items } });
	const CLUTCH = { id: 'fall-guard', when: { type: 'falling', blocks: 5 }, do: { type: 'place', item: 'water_bucket', where: 'below' } };
	book.observeContext('a', sample([{ itemId: 'minecraft:bucket', slot: 3, hotbar: true }, { itemId: 'minecraft:water_bucket', slot: 20, hotbar: false }]));
	book.apply('a', normalizeReflexEntries([CLUTCH, SHIELD]));
	const armed = book.list('a');
	assert.equal(armed.find((row) => row.id === 'fall-guard').lacks, 'no minecraft:water_bucket in hotbar or offhand', 'a bucket in the main inventory is out of reach of a clutch');
	assert.equal(armed.find((row) => row.id === 'blaze-shield').lacks, 'no shield in either hand');
	assert.equal(armed.find((row) => row.id === 'fall-guard').state, 'pending', 'the rule still arms');
	book.observeContext('a', sample([{ itemId: 'minecraft:water_bucket', slot: 'offhand' }, { itemId: 'minecraft:shield', slot: 'mainhand' }]));
	assert.ok(book.list('a').every((row) => row.lacks === undefined), 'held items clear the fact');
	// Once the mod echoes the set, its word (the live inventory) is the fact: a lost bucket shows on the next report.
	const status = { revision: 1, rules: [{ id: 'fall-guard', kind: 'trigger', state: 'armed', fired: 0, expiresInS: 590, lacks: 'no minecraft:water_bucket in hotbar or offhand' },
		{ id: 'blaze-shield', kind: 'stance', state: 'armed', fired: 0, expiresInS: 590 }], events: [] };
	const observation = validateProtocolV2Payload('observation', { ...wire(), goalRevision: 3, observedAtEpochMs: 1, status: 'ready', eventSequence: 4, attention: false, changedFacts: [], reflexes: status });
	assert.equal(observation.reflexes.rules[0].lacks, 'no minecraft:water_bucket in hotbar or offhand', 'the protocol carries the fact');
	book.observe('a', status);
	assert.equal(book.list('a').find((row) => row.id === 'fall-guard').lacks, 'no minecraft:water_bucket in hotbar or offhand');
	assert.match(book.takeReport('a'), /armed fall-guard\(no minecraft:water_bucket in hotbar or offhand\), blaze-shield/);
});

test('lava_flowing arms with withinS 0.5-6, and a flow counting down is not a new observation fact', () => {
	const [rule] = normalizeReflexEntries([{ id: 'flow', when: { type: 'lava_flowing', withinS: 3 }, do: { type: 'leave_lava' } }]);
	assert.deepEqual(rule.when, [{ type: 'lava_flowing', withinS: 3 }]);
	assert.throws(() => normalizeReflexEntries([{ id: 'flow', when: { type: 'lava_flowing', withinS: 0.2 }, do: { type: 'leave_lava' } }]), /withinS/);
	assert.throws(() => normalizeReflexEntries([{ id: 'flow', when: { type: 'lava_flowing', within: 3 }, do: { type: 'leave_lava' } }]), /within/);
	const observation = (flow) => ({ player: { health: 20, lavaFlow: flow } });
	const sooner = nativeObservationSignature(observation({ from: '1,64,0', at: '0,64,0', inS: 1 }));
	assert.equal(nativeObservationSignature(observation({ from: '1,64,0', at: '0,64,0', inS: 1.5 })), sooner, 'only the arrival time changed');
	assert.notEqual(nativeObservationSignature(observation({ from: '1,65,0', at: '0,64,0', inS: 1 })), sooner, 'the flow changed course');
	assert.notEqual(nativeObservationSignature({ player: { health: 20 } }), sooner, 'a flow appearing is a change');
});


test('a named shield stance holds for a model thinking gap without widening other action bounds', () => {
 const targetId = '550e8400-e29b-41d4-a716-446655440000';
 const [rule] = normalizeReflexEntries([{...SHIELD, maxS:600, when:{type:'hostile_near',within:24,targetId}}]);
 assert.equal(rule.maxMs,600000);
 assert.equal(rule.when[0].targetId,targetId);
 assert.throws(()=>normalizeReflexEntries([{...SHIELD,kind:'trigger',maxS:60}]),/between 0.25 and 20/);
 assert.throws(()=>normalizeReflexEntries([{...SHIELD,do:{type:'sneak'},maxS:60}]),/between 0.25 and 20/);
 assert.throws(()=>normalizeReflexEntries([{...SHIELD,when:{type:'hostile_near',within:24,targetId:'blaze'}}]),/must be a UUID/);
});

test('the protocol accepts the mod reporting every default rule plus a full set of the model\'s rules', () => {
	const row = (id) => ({ id, kind: 'trigger', state: 'armed', fired: 0, expiresInS: 600 });
	// In the End the set also holds that dimension's defaults (DIMENSION_REFLEXES).
	const rules = [...DEFAULT_REFLEXES.map((rule) => row(rule.id)), ...DIMENSION_REFLEXES['minecraft:the_end'].map((rule) => row(rule.id)), ...Array.from({ length: MAX_REFLEXES }, (_, index) => row(`own-${index}`))];
	const observation = (reflexes) => validateProtocolV2Payload('observation', { ...wire(), goalRevision: 3, observedAtEpochMs: 1, status: 'ready', eventSequence: 4, attention: false, changedFacts: [], reflexes });
	assert.equal(observation({ revision: 1, rules, events: [] }).reflexes.rules.length, DEFAULT_REFLEXES.length + DIMENSION_REFLEXES['minecraft:the_end'].length + MAX_REFLEXES,
		'defaults plus the model\'s first rule passed 12 and the bridge refused every observation after it');
	assert.throws(() => observation({ revision: 1, rules: [...rules, row('one-too-many')], events: [] }), /reflexes\.rules/);
});

test('a do_step carries the same rule as act and mine: normalized alike and armed before its action is sent', async () => {
	const LAVA_FLOW = { id: 'flow-out', kind: 'trigger', priority: 9, when: { type: 'lava_flowing', withinS: 3 }, do: { type: 'leave_lava' }, ttlS: 600 };
	const direct = normalizeMinecraftToolCall('act', { actionType: 'dig_to', arguments: { y: 16 }, reflexes: [LAVA_FLOW] }).reflexes;
	assert.deepEqual(normalizeMinecraftToolCall('mine', { x: 1, y: 40, z: 1, reflexes: [LAVA_FLOW] }).reflexes, direct);
	const step = normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { y: 16 }, why: 'iron near y16', reflexes: [LAVA_FLOW] });
	assert.deepEqual(step.reflexes, direct, 'the step carries the rule exactly as the direct calls do');
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { y: 16 }, why: 'x', reflexes: [{ id: 'bad', when: { type: 'no_such' }, do: { type: 'leave_lava' } }] }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	const sent = [];
	let sequence = 1;
	const runtime = new NativeToolRuntime({
		reflexBook: new ReflexBook({ defaults: [] }),
		bridge: { send: async (type, agentId, payload) => { sent.push({ type, payload }); } },
		requestObservation: async () => ({ observation: adaptObservation(wire()), eventSequence: ++sequence }),
	});
	runtime.updateObservation(record(), adaptObservation(wire()), { eventSequence: ++sequence });
	const result = await runtime.execute(call(step), record());
	const order = sent.map(({ type }) => type).filter((type) => ['reflex_update', 'action_command'].includes(type));
	assert.deepEqual(order.slice(0, 2), ['reflex_update', 'action_command'], 'the rule reaches the mod before the step\'s action');
	assert.deepEqual(sent.find(({ type }) => type === 'reflex_update').payload.rules, direct);
	assert.equal(result.state, 'RUNNING');
	assert.deepEqual(result.reflexes.map((row) => row.id), ['flow-out'], 'the step result lists the installed rules, as act does');
	await runtime.dispose('agent-a', 'goal_revised');
});

test('replace_action yields a firing the coordinator knows of before it cancels the old action, and only then', async () => {
	const run = async ({ firing, actionId }) => {
		const sent = [];
		let sequence = 1;
		const runtime = new NativeToolRuntime({
			reflexBook: new ReflexBook({ defaults: [] }),
			bridge: { send: async (type, agentId, payload) => { sent.push({ type, payload }); } },
			requestObservation: async () => ({ observation: adaptObservation(wire()), eventSequence: ++sequence }),
		});
		runtime.updateObservation(record(), adaptObservation(wire()), { eventSequence: ++sequence });
		await runtime.execute(call(normalizeMinecraftToolCall('runProgram', { reflexes: [SHIELD] })), record());
		const handle = await runtime.execute(call({ kind: 'start_action', actionType: 'wait', arguments: { durationMs: 100 } }, 3, 'call-2'), record());
		const rules = [{ id: 'blaze-shield', kind: 'stance', state: firing ? 'firing' : 'armed', fired: firing ? 1 : 0, expiresInS: 599 }];
		runtime.updateObservation(record(), adaptObservation({ ...wire(), reflexes: { revision: 1, ...(firing ? { firing: { id: 'blaze-shield', ms: 400 } } : {}), rules, events: [] } }), { eventSequence: ++sequence });
		sent.length = 0;
		const replace = call({ kind: 'replace_action', actionId: actionId ?? handle.actionId, goalRevision: 3, actionType: 'look_at', arguments: { x: 2, y: 64, z: 3 } }, 3, 'call-3');
		const pending = runtime.execute(replace, record()).catch((error) => error);
		for (let i = 0; i < 50 && !sent.some((entry) => entry.type !== 'reflex_update'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		if (actionId === undefined) runtime.onActionResult(record(), { actionId: handle.actionId, state: 'CANCELLED', reasonCode: 'ACTION_CANCELLED' });
		for (let i = 0; i < 50 && actionId === undefined && !sent.some((entry) => entry.type === 'action_command'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		const successor = sent.find((entry) => entry.type === 'action_command');
		if (successor !== undefined) runtime.onActionResult(record(), { actionId: successor.payload.actionId, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' });
		const outcome = await pending;
		const types = sent.map((entry) => entry.type === 'reflex_update' ? `reflex_update:${entry.payload.yield}` : entry.type);
		await runtime.dispose('agent-a', 'goal_revised');
		return { types, outcome };
	};
	const known = await run({ firing: true });
	assert.equal(known.types[0], 'reflex_update:true', `the yield goes first: ${known.types}`);
	const cancel = known.types.findIndex((type) => type !== 'reflex_update:true');
	assert.ok(cancel > 0 && known.types[cancel] !== 'action_command', `then the old action's cancel: ${known.types}`);
	assert.ok(known.types.indexOf('action_command') > cancel, `then the replacement: ${known.types}`);
	assert.equal(known.outcome.replacedAction?.state, 'CANCELLED');

	const idle = await run({ firing: false });
	assert.ok(!idle.types.includes('reflex_update:true'), `no firing known, no yield: ${idle.types}`);
	assert.ok(idle.types.includes('action_command'), 'the replacement still runs');

	const refused = await run({ firing: true, actionId: 'unknown' });
	assert.equal(refused.outcome?.code, 'STALE_ACTION');
	assert.deepEqual(refused.types, [], 'a refused replacement leaves the firing alone');
});

test('a replace_action whose yield fails to send still cancels the old action and starts the replacement', async () => {
	const sent = [], traced = [];
	let sequence = 1;
	const runtime = new NativeToolRuntime({
		reflexBook: new ReflexBook({ defaults: [] }),
		trace: (event, fields) => traced.push({ event, ...fields }),
		bridge: { send: async (type, agentId, payload) => {
			if (type === 'reflex_update' && payload.yield === true) throw Object.assign(new Error('bridge closed'), { code: 'BRIDGE_SEND_FAILED' });
			sent.push({ type, payload });
		} },
		requestObservation: async () => ({ observation: adaptObservation(wire()), eventSequence: ++sequence }),
	});
	runtime.updateObservation(record(), adaptObservation(wire()), { eventSequence: ++sequence });
	await runtime.execute(call(normalizeMinecraftToolCall('runProgram', { reflexes: [SHIELD] })), record());
	const handle = await runtime.execute(call({ kind: 'start_action', actionType: 'wait', arguments: { durationMs: 100 } }, 3, 'call-2'), record());
	const rules = [{ id: 'blaze-shield', kind: 'stance', state: 'firing', fired: 1, expiresInS: 599 }];
	runtime.updateObservation(record(), adaptObservation({ ...wire(), reflexes: { revision: 1, firing: { id: 'blaze-shield', ms: 400 }, rules, events: [] } }), { eventSequence: ++sequence });
	sent.length = 0;
	const pending = runtime.execute(call({ kind: 'replace_action', actionId: handle.actionId, goalRevision: 3, actionType: 'look_at', arguments: { x: 2, y: 64, z: 3 } }, 3, 'call-3'), record()).catch((error) => error);
	for (let i = 0; i < 50 && !sent.some((entry) => entry.type === 'action_cancel'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
	runtime.onActionResult(record(), { actionId: handle.actionId, state: 'CANCELLED', reasonCode: 'ACTION_CANCELLED' });
	for (let i = 0; i < 50 && !sent.some((entry) => entry.type === 'action_command'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
	const successor = sent.find((entry) => entry.type === 'action_command');
	assert.ok(successor !== undefined, `the replacement starts: ${sent.map((entry) => entry.type)}`);
	runtime.onActionResult(record(), { actionId: successor.payload.actionId, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' });
	const outcome = await pending;
	assert.ok(!(outcome instanceof Error), `the replace does not fail: ${outcome?.message}`);
	assert.equal(outcome.replacedAction?.state, 'CANCELLED');
	assert.ok(traced.some((row) => row.event === 'reflexes_send_failed' && row.path === 'replace_action'), 'the failed yield is traced');
	await runtime.dispose('agent-a', 'goal_revised');
});

// Before, the yield went out first and its own await let a cancel of the same action in: the replace then failed
// CANCELLATION_IN_PROGRESS after it had ended the firing. Now the yield starts past the cancel's own check.
test('replace_action yields only once past every refusal: a cancel racing the yield is the call refused, not the replace', async () => {
	const sent = [];
	let sequence = 1, handle = null, runtime = null, raced = null;
	runtime = new NativeToolRuntime({
		reflexBook: new ReflexBook({ defaults: [] }),
		bridge: { send: async (type, agentId, payload) => {
			sent.push({ type, payload });
			// A cancel of the same action arrives while the yield is in flight.
			if (type === 'reflex_update' && payload.yield === true && raced === null) {
				await new Promise((resolve) => setTimeout(resolve, 5));
				raced = runtime.execute(call({ kind: 'cancel_action', actionId: handle.actionId, goalRevision: 3 }, 3, 'call-4'), record()).catch((error) => error);
			}
			if (type === 'action_cancel') setTimeout(() => runtime.onActionResult(record(), { actionId: payload.actionId, state: 'CANCELLED', reasonCode: 'ACTION_CANCELLED' }), 5);
		} },
		requestObservation: async () => ({ observation: adaptObservation(wire()), eventSequence: ++sequence }),
	});
	runtime.updateObservation(record(), adaptObservation(wire()), { eventSequence: ++sequence });
	await runtime.execute(call(normalizeMinecraftToolCall('runProgram', { reflexes: [SHIELD] })), record());
	handle = await runtime.execute(call({ kind: 'start_action', actionType: 'wait', arguments: { durationMs: 100 } }, 3, 'call-2'), record());
	const rules = [{ id: 'blaze-shield', kind: 'stance', state: 'firing', fired: 1, expiresInS: 599 }];
	runtime.updateObservation(record(), adaptObservation({ ...wire(), reflexes: { revision: 1, firing: { id: 'blaze-shield', ms: 400 }, rules, events: [] } }), { eventSequence: ++sequence });
	sent.length = 0;
	const replace = call({ kind: 'replace_action', actionId: handle.actionId, goalRevision: 3, actionType: 'look_at', arguments: { x: 2, y: 64, z: 3 } }, 3, 'call-3');
	const pending = runtime.execute(replace, record()).catch((error) => error);
	for (let i = 0; i < 60 && !sent.some((entry) => entry.type === 'action_command') && !(await Promise.race([pending, Promise.resolve(null)]) instanceof Error); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
	const successor = sent.find((entry) => entry.type === 'action_command');
	if (successor !== undefined) runtime.onActionResult(record(), { actionId: successor.payload.actionId, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' });
	const outcome = await pending;
	const racedOutcome = await raced;
	const types = sent.map((entry) => entry.type === 'reflex_update' ? `reflex_update:${entry.payload.yield}` : entry.type);
	await runtime.dispose('agent-a', 'goal_revised');
	assert.ok(!(outcome instanceof Error), `the replace went on, not refused after its yield: ${outcome?.code} after ${types}`);
	assert.equal(racedOutcome?.code, 'CANCELLATION_IN_PROGRESS', 'the racing cancel is the call refused');
	assert.deepEqual(types, ['reflex_update:true', 'action_cancel', 'action_command'], 'the yield goes ahead of the cancel, then the replacement');
});

test('the book remembers the cells its water reflex poured, per dimension, and forgets one the observation shows scooped', () => {
	const book = new ReflexBook({ now: () => 0 });
	const end = { ready: true, world: { dimension: 'minecraft:the_end' }, player: { health: 20 }, inventory: { items: [] }, blocks: [] };
	book.observeContext('a', end);
	book.apply('a', normalizeReflexEntries([SWAP]));
	const pour = (seq, cell, outcome = 'done') => ({ revision: 1, rules: [], events: [{ seq, id: 'default-ender-water', outcome, ms: 50, detail: `placed minecraft:water_bucket at feet ${cell}; the source stays until scooped` }] });
	book.observe('a', pour(1, '2,62,13'));
	book.observe('a', pour(2, '9,62,13', 'failed'));
	book.observe('a', pour(3, '-4,62,0'));
	assert.deepEqual(book.pours('a', end), [{ x: -4, y: 62, z: 0 }, { x: 2, y: 62, z: 13 }]);
	assert.deepEqual(book.pours('a', { ...end, world: { dimension: 'minecraft:overworld' } }), [], 'another dimension names none');
	// A row at the cell that is no water source (a block, or only flow) forgets that pour; an unlisted cell keeps it.
	assert.deepEqual(book.pours('a', { ...end, blocks: [{ blockId: 'minecraft:obsidian', x: -4, y: 62, z: 0 }] }), [{ x: 2, y: 62, z: 13 }]);
	assert.deepEqual(book.pours('a', { ...end, blocks: [{ blockId: 'minecraft:water', x: 2, y: 62, z: 13, fluid: { type: 'minecraft:flowing_water' } }] }), []);
	// A scoop leaves air, which has no row: one more water bucket near a remembered pour forgets the nearest one.
	book.observe('a', pour(4, '2,62,13'));
	book.observe('a', pour(5, '40,62,13'));
	const at = (x, buckets) => ({ ...end, position: { x, y: 62, z: 13.5 }, inventory: { items: buckets ? [{ itemId: 'minecraft:water_bucket', count: buckets }] : [{ itemId: 'minecraft:bucket', count: 1 }] } });
	book.observeContext('a', at(4.5, 0));
	book.observeContext('a', at(4.5, 1));
	assert.deepEqual(book.pours('a', at(4.5, 1)), [{ x: 40, y: 62, z: 13 }], 'the scooped pour beside the bot is forgotten; the far one stays');
	book.observeContext('a', at(4.5, 0));
	book.observeContext('a', at(4.5, 1));
	assert.deepEqual(book.pours('a', at(4.5, 1)), [{ x: 40, y: 62, z: 13 }], 'a refill with no pour in reach forgets none');
	book.observe('a', pour(6, '3,62,13'));
	book.observeContext('a', { ...at(4.5, 1), inventory: undefined });
	book.observeContext('a', at(4.5, 1));
	assert.deepEqual(book.pours('a', at(4.5, 1)), [{ x: 3, y: 62, z: 13 }, { x: 40, y: 62, z: 13 }], 'a sample without the inventory is no scoop');
	book.clear('a');
});
