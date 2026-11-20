import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

// The production factory reads MINEAGEN_INSTINCT_BOOK and the model's wake carries the rules that hold as now.instinct.
const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const BOOK = [
	{ id: 'health-low-retreat', tags: ['health:low'], when: 'Health is 8 or less.', do: 'Back off, block in and eat.', priority: 3 },
	{ id: 'lava-edges', tags: ['place:near_lava'], when: 'Lava is beside you.', do: 'Keep a block between you and it.', priority: 3 },
	{ id: 'ore-cave-first', tags: ['need:iron', 'place:surface'], when: 'You need iron and a cave mouth is in view.', do: 'Go into the cave and scan its walls.', priority: 2 },
];

async function firstWake(env, { health, blocks = [] }) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const rows = [];
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' });
	planner.requestNativeTurn = async (request) => { planner.requests.push(request); return { toolCalls: 0 }; };
	const run = await start({ registry, planner, config: CONFIG, ...(env === null ? {} : { env: { ...process.env, ...env } }), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } } });
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Get iron.' } });
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, attention: true, observedAtEpochMs: 1, changedFacts: ['blocks'],
			observation: { world: { worldId: 'instinct-test', dimension: 'minecraft:overworld', gameTime: 1000, dayTime: 1000, raining: false, thundering: false }, player: { x: 0, y: 70, z: 0, health, foodLevel: 20 }, items: [], entities: [], blocks,
				inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', slot: 'mainhand', count: 1 }], tagCounts: {} } } } });
		await eventually(() => planner.requests.length >= 1).catch((error) => { throw new Error(JSON.stringify(run.bridge.sent.filter(m => m.type === 'agent_error').map(m => m.payload.message)) + ' ' + error.message); });
		return { now: JSON.parse(planner.requests[0].input.split('\n')[1]).now ?? {}, shown: rows.filter(row => row.event === 'instinct_shown') };
	} finally { await run.coordinator.stop(); }
}

test('with a book, the wake carries the rules that hold now as now.instinct, most urgent first', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'instinct-wake-'));
	const file = path.join(dir, 'book.json');
	writeFileSync(file, JSON.stringify(BOOK));
	const hurt = await firstWake({ MINEAGEN_INSTINCT_BOOK: file }, { health: 6 });
	assert.deepEqual(hurt.now.instinct.map(line => line.slice(0, line.indexOf(':'))), ['health-low-retreat', 'ore-cave-first']);
	assert.deepEqual(hurt.shown.at(-1).rules, ['health-low-retreat', 'ore-cave-first']);
	const healthy = await firstWake({ MINEAGEN_INSTINCT_BOOK: file }, { health: 20 });
	assert.deepEqual(healthy.now.instinct, ['ore-cave-first: You need iron and a cave mouth is in view -> Go into the cave and scan its walls.']);
});

test('without a book the wake is unchanged', async () => {
	const { now, shown } = await firstWake({ MINEAGEN_INSTINCT_BOOK: '' }, { health: 6 });
	assert.equal(now.instinct, undefined);
	assert.deepEqual(shown, []);
});

test('far lava brings no lava rule and lava beside the body does (block rows through the coordinator)', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'instinct-wake-'));
	const file = path.join(dir, 'book.json');
	writeFileSync(file, JSON.stringify(BOOK));
	const ids = wake => wake.now.instinct.map(line => line.slice(0, line.indexOf(':'))).sort();
	assert.deepEqual(ids(await firstWake({ MINEAGEN_INSTINCT_BOOK: file }, { health: 20, blocks: [{ blockId: 'minecraft:lava', x: 20, y: 70, z: 0 }] })), ['ore-cave-first']);
	assert.deepEqual(ids(await firstWake({ MINEAGEN_INSTINCT_BOOK: file }, { health: 20, blocks: [{ blockId: 'minecraft:lava', x: 2, y: 70, z: 0 }] })), ['lava-edges', 'ore-cave-first']);
});
