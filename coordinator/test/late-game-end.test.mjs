import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_REFLEXES, DIMENSION_REFLEXES, MAX_REFLEXES, MAX_REFLEX_RULES, ReflexBook, normalizeReflexEntries } from '../src/reflexes.mjs';
import { currentDangers, dangerCoverage } from '../src/danger-contexts.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { FakePlanner, eventually, factToWireObservation, start } from './fixtures/dynamic-main-fixture.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';

// The late-game contract, part C: End defaults armed by the dimension (wall-breakers late-game-contract.md).
const END = 'minecraft:the_end', OVERWORLD = 'minecraft:overworld', NETHER = 'minecraft:the_nether';
const live = (dimension) => ({ world: { dimension }, player: { health: 20 } });
const ids = (book) => book.list('a').map((row) => `${row.id}${row.default ? '*' : ''}`);
const END_IDS = ['default-breath', 'default-end-throw', 'default-gaze', 'default-ender-water', 'default-perch-strike', 'default-fountain-post'];

test('End defaults follow the dimension: armed on entering the End, gone on leaving', () => {
	const book = new ReflexBook();
	book.observeContext('a', live(OVERWORLD));
	assert.ok(END_IDS.every((id) => !ids(book).includes(`${id}*`)), 'not in the Overworld');
	const before = book.payload('a').revision;
	assert.equal(book.observeContext('a', live(END)), true, 'entering the End changes the set');
	assert.ok(book.payload('a').revision > before);
	assert.deepEqual(ids(book).slice(-6), ['default-breath*', 'default-end-throw*', 'default-gaze*', 'default-ender-water*', 'default-perch-strike*', 'default-fountain-post*']);
	assert.equal(book.observeContext('a', live(END)), false, 'nothing more while it stays');
	assert.equal(book.observeContext('a', live(OVERWORLD)), true, 'leaving changes the set');
	assert.ok(END_IDS.every((id) => !ids(book).some((row) => row.startsWith(id))), 'gone after leaving');
	assert.equal(ids(book).length, DEFAULT_REFLEXES.length);
	// Entering the Nether arms none of them.
	book.observeContext('a', live(NETHER));
	assert.ok(END_IDS.every((id) => !ids(book).some((row) => row.startsWith(id))));
});

test('a first sample already in the End (a staged start, a reconnect) arms them, and a respawn in the End again', () => {
	const book = new ReflexBook();
	book.observeContext('a', live(END));
	assert.ok(END_IDS.every((id) => ids(book).includes(`${id}*`)));
	book.observeContext('a', { player: { dead: true }, status: 'PLAYER_DEAD' });
	book.apply('a', normalizeReflexEntries([{ id: 'default-breath', remove: true }]));
	book.observeContext('a', live(END));
	assert.ok(ids(book).includes('default-breath*'), 'a respawn re-arms a switched-off End default');
});

test('the model can switch default-breath off by id; it stays off in the End until a dimension change or respawn', () => {
	const book = new ReflexBook();
	book.observeContext('a', live(END));
	book.apply('a', normalizeReflexEntries([{ id: 'default-breath', remove: true }]));
	assert.equal(book.observeContext('a', live(END)), false);
	assert.ok(!ids(book).some((row) => row.startsWith('default-breath')));
	book.observeContext('a', live(OVERWORLD));
	book.observeContext('a', live(END));
	assert.ok(ids(book).includes('default-breath*'));
});

test('a model rule replacing default-breath by id is the model\'s and survives leaving the End', () => {
	const book = new ReflexBook();
	book.observeContext('a', live(END));
	book.apply('a', normalizeReflexEntries([{ id: 'default-breath', priority: 9, when: { type: 'cloud_near', within: 2 }, do: { type: 'sprint_away', blocks: 12 } }]));
	assert.equal(book.payload('a').rules.find((rule) => rule.id === 'default-breath').coordinatorDefault, undefined, 'not a coordinator default, so not a floor');
	book.observeContext('a', live(OVERWORLD));
	assert.ok(ids(book).includes('default-breath'), 'the model\'s own rule is not removed with the dimension');
});

test('cap fits in the End: defaults, End defaults and a full set of the model\'s rules pass the wire', () => {
	const book = new ReflexBook();
	book.observeContext('a', live(END));
	book.apply('a', normalizeReflexEntries(Array.from({ length: MAX_REFLEXES }, (_, index) => ({ id: `own-${index}`, when: { type: 'on_fire' }, do: { type: 'leave_fire' } }))));
	const payload = book.payload('a');
	assert.equal(payload.rules.length, MAX_REFLEX_RULES);
	assert.equal(validateProtocolV2Payload('reflex_update', payload).rules.length, MAX_REFLEX_RULES);
});

test('the End defaults are canonical rules (what the model\'s normalizer would produce) and match the mod fixture', async () => {
	for (const { maxMs, cooldownMs, ttlMs, ...rule } of DIMENSION_REFLEXES[END]) {
		const [canonical] = normalizeReflexEntries([{ ...rule, ttlS: ttlMs / 1_000, ...(maxMs ? { maxS: maxMs / 1_000 } : {}), ...(cooldownMs ? { cooldownS: cooldownMs / 1_000 } : {}) }]);
		assert.deepEqual(canonical, { ...rule, ...(maxMs ? { maxMs } : {}), ...(cooldownMs ? { cooldownMs } : {}), ttlMs });
	}
	const fixture = JSON.parse(await readFile(new URL('../../src/test/resources/end-reflex-rules.json', import.meta.url), 'utf8'));
	const book = new ReflexBook();
	book.observeContext('a', live(END));
	assert.deepEqual(fixture, book.payload('a').rules.filter((rule) => END_IDS.includes(rule.id)), 'regenerate src/test/resources/end-reflex-rules.json from ReflexBook.payload');
});

test('the End context names breath and throws as covered by the End defaults', () => {
	const book = new ReflexBook();
	book.observeContext('a', live(END));
	// The mod echoes the set (rules are pending until it does).
	const { revision, rules } = book.payload('a');
	book.observe('a', { revision, rules: rules.map((rule) => ({ id: rule.id, kind: rule.kind, state: 'armed', fired: 0, expiresInS: 3_600 })), events: [] });
	const coverage = dangerCoverage(currentDangers({ ...live(END), entities: [] }), book.rules('a'));
	assert.equal(coverage['dragon breath (ender_dragon)'], 'rule default-breath');
	assert.equal(coverage['dragon throws off edges (ender_dragon)'], 'rule default-end-throw');
});

test('a book with its own default list gets no End rules unless given them', () => {
	const book = new ReflexBook({ defaults: DEFAULT_REFLEXES.slice(0, 2) });
	book.observeContext('a', live(END));
	assert.deepEqual(ids(book), ['default-lava*', 'default-lava-flow*']);
});

test('the production coordinator arms the End defaults when a live sample arrives from the End', async () => {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry);
	const run = await start({ registry, planner, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Kill the ender dragon.' } });
		const observation = factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20 } }, 1, 1, false, 1);
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { ...observation, world: { ...observation.world, dimension: END } } });
		await eventually(() => run.bridge.sent.some((m) => m.type === 'reflex_update' && m.payload.rules.some((rule) => rule.id === 'default-breath')));
		const update = run.bridge.sent.filter((m) => m.type === 'reflex_update').at(-1).payload;
		assert.equal(update.rules.find((rule) => rule.id === 'default-breath').coordinatorDefault, true);
	} finally { await run.coordinator.stop?.(); }
});
