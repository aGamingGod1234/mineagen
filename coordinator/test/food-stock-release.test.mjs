import test from 'node:test';
import assert from 'node:assert/strict';
import { routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakeBridge, FakePlanner, start, immutableGoalSpec, factToWireObservation, eventually } from './fixtures/dynamic-main-fixture.mjs';

// The cooked-meat stock heads the route before the first descent, but gives way to the stone, iron and kit steps once a
// food hand-back found no source this life, or half the stock is held with nothing to cook and no animal in view.

const item = (id, count = 1) => ({ itemId: `minecraft:${id}`, count });
const TOOLS = [item('stone_pickaxe'), item('furnace')];
const COW = { type: 'minecraft:cow', distance: 8, alive: true };
const sample = (items = TOOLS, { entities = [], foodLevel = 20, health = 20, at = 1000, world = 'w1', dimension = 'minecraft:overworld', dead = false } = {}) => ({
	ready: true, observedAtEpochMs: at, world: { worldId: world, dimension }, position: { x: 0, y: 64, z: 0 },
	player: { x: 0, y: 64, z: 0, health, foodLevel, ...(dead ? { dead: true } : {}) }, inventory: { items }, entities });
const route = (o, { known = emptyKnown(), foodHandedBack = false } = {}) => routeLine({ observation: o, known, foodHandedBack, evaluate: evaluatePlanCheck });
const spec = immutableGoalSpec('beat the game', { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true });
const record = () => ({ agentId: 'food-stock', currentGoal: 'beat the game', currentGoalSpec: spec, goalRevision: 1 });
const OBTAIN = { kind: 'obtain', arguments: { item: 'minecraft:cooked_porkchop', count: 8 } };
const NO_SOURCE = { state: 'FAILED', reasonCode: 'NO_SOURCE', item: 'cooked_porkchop', held: 0, asked: 8 };

test('the food stock heads the route at game start, after the wooden pickaxe', () => {
	assert.match(route(sample([item('wooden_pickaxe')])), /cooked meat 0\/8/);
	assert.match(route(sample()), /cooked meat 0\/8/);
	assert.match(route(sample(TOOLS, { entities: [COW] })), /obtain cooked_beef count 8/);
});

test('four cooked meat with no animal in view and nothing to cook releases the stock', () => {
	assert.match(route(sample([...TOOLS, item('cooked_beef', 4)])), /^usual next step: obtain iron_pickaxe/);
	assert.match(route(sample([item('wooden_pickaxe'), item('cooked_mutton', 2), item('cooked_chicken', 2)])), /^usual next step: obtain stone_pickaxe/);
	// Below half, with an animal still in view, raw meat to cook, or low health or hunger, the stock keeps the head.
	assert.match(route(sample([...TOOLS, item('cooked_beef', 3)])), /cooked meat 3\/8/);
	assert.match(route(sample([...TOOLS, item('cooked_beef', 4)], { entities: [COW] })), /obtain cooked_beef count 8/);
	assert.match(route(sample([...TOOLS, item('cooked_beef', 4), item('porkchop', 2)])), /obtain cooked_porkchop count 2/);
	assert.match(route(sample([...TOOLS, item('cooked_beef', 4)], { foodLevel: 14 })), /cooked meat 4\/8/);
	assert.match(route(sample([...TOOLS, item('cooked_beef', 4)], { health: 12 })), /cooked meat 4\/8/);
});

test('a food hand-back releases the stock at any hunger or health, with the restock suffix when low', () => {
	assert.match(route(sample(), { foodHandedBack: true }), /^usual next step: obtain iron_pickaxe \(/);
	assert.match(route(sample([item('wooden_pickaxe')], { entities: [COW] }), { foodHandedBack: true }), /^usual next step: obtain stone_pickaxe/);
	// With no food held hunger only falls, so a release gated on hunger above 14 would pin the stock again for the life.
	const restock = /^usual next step: obtain iron_pickaxe; low hunger\/health, food 0 held: obtain cooked_beef on the way/;
	assert.match(route(sample(TOOLS, { foodLevel: 12 }), { foodHandedBack: true }), restock);
	assert.match(route(sample(TOOLS, { health: 10 }), { foodHandedBack: true }), restock);
	assert.match(route(sample(TOOLS, { foodLevel: 6, entities: [COW] }), { foodHandedBack: true }), restock);
});

test('the stock stays done in the Nether and after a visit, even with an animal in view', () => {
	const visited = emptyKnown(); visited.visitedDimensions.push('minecraft:the_nether');
	for (const o of [sample(TOOLS, { entities: [COW] }), sample(TOOLS, { entities: [COW], dimension: 'minecraft:the_nether' })])
		assert.doesNotMatch(route(o, { known: visited }), /cooked meat|cooked_beef count 8/);
	assert.match(route(sample(TOOLS, { entities: [COW] }), { known: visited }), /obtain iron_pickaxe/);
});

test('only a sourceless food obtain or animal find counts as a hand-back', async () => {
	const released = async (tool, result) => {
		const views = new LiveTaskViews(), r = record();
		await views.observe(r, sample());
		const noted = views.noteFoodHandback(r, tool, result);
		assert.equal(/obtain iron_pickaxe/.test(views.continuity(r).route), noted);
		return noted;
	};
	assert.equal(await released(OBTAIN, NO_SOURCE), true);
	assert.equal(await released(OBTAIN, { state: 'FAILED', reasonCode: 'OBTAIN_STUCK', item: 'cooked_porkchop' }), true);
	assert.equal(await released(OBTAIN, { state: 'TIMED_OUT', reasonCode: 'OBTAIN_TIMEOUT' }), true);
	assert.equal(await released({ kind: 'obtain', arguments: { item: 'Cooked Beef', count: 8 } }, { state: 'TIMED_OUT', reasonCode: 'OBTAIN_TIMEOUT' }), true);
	assert.equal(await released({ kind: 'find', arguments: { mob: 'minecraft:cow' } }, { state: 'FAILED', reasonCode: 'FIND_NOT_FOUND' }), true);
	assert.equal(await released({ kind: 'find', arguments: { mob: 'minecraft:sheep' } }, { state: 'TIMED_OUT', reasonCode: 'FIND_BUDGET' }), true);
	for (const [tool, result] of [
		[OBTAIN, { state: 'INTERRUPTED', reasonCode: 'DANGER', item: 'cooked_porkchop' }],
		[OBTAIN, { state: 'INTERRUPTED', reasonCode: 'LOW_HEALTH', item: 'cooked_porkchop' }],
		[OBTAIN, { state: 'CANCELLED', reasonCode: 'CANCELLED', item: 'cooked_porkchop' }],
		[OBTAIN, { state: 'FAILED', reasonCode: 'OBSERVATION_UNAVAILABLE' }],
		[OBTAIN, { state: 'SUCCEEDED', reasonCode: 'OBTAINED', item: 'cooked_porkchop' }],
		[{ kind: 'obtain', arguments: { item: 'iron_ingot' } }, { state: 'FAILED', reasonCode: 'NO_SOURCE', item: 'iron_ingot' }],
		[{ kind: 'find', arguments: { mob: 'minecraft:zombie' } }, { state: 'FAILED', reasonCode: 'FIND_NOT_FOUND' }],
		[{ kind: 'find', arguments: { mob: 'minecraft:cow' } }, { state: 'FAILED', reasonCode: 'FIND_DANGER' }],
	]) assert.equal(await released(tool, result), false, JSON.stringify([tool, result]));
});

test('a hand-back lasts one life in one world, is not restored on restart and skips older samples', async () => {
	for (const boundary of ['death', 'world', 'goal', 'restart']) {
		let views = new LiveTaskViews(); const r = record();
		await views.observe(r, sample());
		views.noteFoodHandback(r, OBTAIN, NO_SOURCE);
		if (boundary === 'death') { await views.observe(r, sample([], { at: 2000, dead: true })); await views.observe(r, sample(TOOLS, { at: 3000 })); }
		if (boundary === 'world') await views.observe(r, sample(TOOLS, { at: 2000, world: 'w2' }));
		if (boundary === 'goal') { r.currentGoalSpec = immutableGoalSpec('beat the game', spec.predicate, 2); await views.observe(r, sample(TOOLS, { at: 2000 })); }
		if (boundary === 'restart') { views = new LiveTaskViews(); await views.observe(r, sample(TOOLS, { at: 2000 })); }
		assert.match(views.continuity(r).route, /cooked meat 0\/8/, boundary);
	}
	const views = new LiveTaskViews(), r = record(), old = sample(TOOLS, { at: 1000 });
	await views.observe(r, old); await views.observe(r, sample(TOOLS, { at: 2000 }));
	views.noteFoodHandback(r, OBTAIN, NO_SOURCE);
	assert.match(views.continuity(r, { observation: old }).route, /cooked meat 0\/8/);
	assert.match(views.continuity(r).route, /obtain iron_pickaxe/);
	await views.observe(r, sample(TOOLS, { at: 3000 }));
	assert.match(views.continuity(r).route, /obtain iron_pickaxe/, 'later samples in the same life keep the release');
});

test('the production coordinator records a failed food obtain before the next wake', { timeout: 15000 }, async t => {
	const bridge = new FakeBridge(), registry = new AgentRegistry(), planner = new FakePlanner(registry);
	let result, error, turns = 0, views = null;
	const execute = NativeToolRuntime.prototype.execute;
	// The body result is mocked; the coordinator's own lifecycle and task views are the real ones.
	t.mock.method(NativeToolRuntime.prototype, 'execute', async function (request, ...rest) {
		return request.tool.kind === 'obtain' ? NO_SOURCE : execute.call(this, request, ...rest);
	});
	const note = LiveTaskViews.prototype.noteFoodHandback;
	t.mock.method(LiveTaskViews.prototype, 'noteFoodHandback', function (...args) { views = this; return note.apply(this, args); });
	planner.requestNativeTurn = async request => {
		planner.requests.push(request);
		if (++turns > 1) return { status: 'completed', toolCalls: 0 };
		try { result = await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'food', callId: 'food', tool: OBTAIN }); } catch (e) { error = e; }
		return { status: 'completed', toolCalls: 1 };
	};
	const run = await start({ bridge, registry, planner, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' } } } });
	try {
		bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'beat the game', goalSpec: spec } });
		bridge.emit('observation', { agentId: 'agent-a', payload: factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20, foodLevel: 20 }, world: { worldId: 'w1', dimension: 'minecraft:overworld', gameTime: 1, dayTime: 1, raining: false, thundering: false },
			inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }, { itemId: 'minecraft:furnace', count: 1, slot: 1 }] } }, 1, 1, false, 1000) });
		await eventually(() => result !== undefined || error !== undefined);
		assert.ifError(error);
		assert.equal(result.reasonCode, 'NO_SOURCE');
		assert.ok(views, 'the coordinator passed the result to its task views');
		assert.match(views.continuity(registry.get('agent-a')).route, /^usual next step: obtain iron_pickaxe/);
	} finally { await run.coordinator.stop(); }
});
