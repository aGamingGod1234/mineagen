import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { FakePlanner, factToWireObservation, eventually, start, DEATH } from './fixtures/dynamic-main-fixture.mjs';

// Production coordinator, lifecycle admission, tool runtime and memory with a faked provider: a death in one game
// reaches the respawn wake as a lesson, and the next game's first wake in the same situation. No Minecraft or model.
const ZOMBIE = { uuid: '00000000-0000-4000-8000-0000000000aa', type: 'minecraft:zombie', name: 'Zombie', distance: 5, position: { x: 4.5, y: 64, z: 0.5 }, hostile: true };

function wire(worldId, at, sequence, { health = 6, zombie = true } = {}) {
	const observation = factToWireObservation({ player: { x: 0.5, y: 64, z: 0.5, health }, inventory: { items: [] },
		world: { worldId, dimension: 'minecraft:overworld', gameTime: 100 + sequence, dayTime: 100, raining: false, thundering: false } }, 1, sequence, false, at);
	observation.inventory.food = { items: 0, nutrition: 0 };
	if (zombie) observation.entities = [...observation.entities, ZOMBIE];
	return observation;
}

async function game(directory, worldId, seed, play) {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), events = [];
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		const dead = request.input.includes('player_death');
		const call = dead ? { name: 'act', arguments: { actionType: 'respawn', arguments: {} } } : { name: 'act', arguments: { actionType: 'wait', arguments: { durationMs: 60000 } } };
		try { await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: `t-${planner.requests.length}`, callId: `c-${planner.requests.length}`, tool: normalizeMinecraftToolCall(call.name, call.arguments) }); } catch { /* the turn ends either way */ }
		return { status: 'completed', toolCalls: 1 };
	};
	const env = { ...process.env, MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'fixture', MINEAGEN_WORLD_SEED_HASH: seed };
	const run = await start({ registry, planner, env, memoryDirectory: null, traceWriter: { write: (event, fields) => { events.push({ event, ...fields }); } },
		config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	try { await play(run, planner); } finally { await run.coordinator.stop?.(); }
	return { events, planner };
}

test('a death in one game reaches its respawn wake and the next game\'s wake as a lesson, through the production coordinator', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'experience-coordinator-'));
	try {
		const t0 = Date.now();
		const first = await game(directory, 'game-one', 'seed-one', async (run, planner) => {
			run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat the game.', updatedAtEpochMs: t0 } });
			run.bridge.emit('observation', { agentId: 'agent-a', payload: wire('game-one', t0, 1) });
			await eventually(() => run.bridge.sent.some((m) => m.type === 'action_command' && m.payload.actionType === 'wait'));
			const death = { ...DEATH, cause: 'Probe was slain by Zombie', gameMode: 'survival', diedAtEpochMs: t0 + 15_000 };
			run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'dead', goalRevision: 1, updatedAtEpochMs: t0 + 15_000, death } });
			await eventually(() => planner.requests.some((r) => r.input.includes('player_death')));
		});
		const deadTurn = first.planner.requests.find((r) => r.input.includes('player_death'));
		assert.match(deadTurn.input, /killed you after you stayed at low health/);
		assert.match(deadTurn.input, /from your past play: 1 this game/);
		assert.ok(first.events.some((e) => e.event === 'experience_state' && e.mode === 'lessons' && e.games === 0));
		const reviewed = first.events.find((e) => e.event === 'experience_death_reviewed');
		assert.equal(reviewed.cause, 'zombie');
		assert.ok(reviewed.lessons.includes('melee-at-low-health:mob=zombie'));
		const [profile] = await readdir(directory);
		assert.equal((await readdir(join(directory, profile))).length, 1);

		const second = await game(directory, 'game-two', 'seed-two', async (run, planner) => {
			run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat the game.', updatedAtEpochMs: t0 + 100_000 } });
			run.bridge.emit('observation', { agentId: 'agent-a', payload: wire('game-two', t0 + 100_000, 1) });
			await eventually(() => planner.requests.length > 0);
		});
		const wake = second.planner.requests[0].input;
		assert.match(wake, /killed you after you stayed at low health/);
		assert.match(wake, /from your past play: 1 time in 1 earlier game/);
		assert.doesNotMatch(wake, /game-one|Probe/);
		assert.ok(second.events.some((e) => e.event === 'experience_lessons_shown' && e.carried >= 1));
	} finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('a flee sent through the native tools is running when a skeleton kills the agent, and the review sees it', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'experience-coordinator-'));
	const SKELETON = { uuid: '00000000-0000-4000-8000-0000000000bb', type: 'minecraft:skeleton', name: 'Skeleton', distance: 9, position: { x: 9.5, y: 64, z: 0.5 }, hostile: true };
	try {
		const t0 = Date.now(), registry = new AgentRegistry(), planner = new FakePlanner(registry), events = [];
		planner.requestNativeTurn = async (request) => {
			planner.requests.push(request);
			const dead = request.input.includes('player_death');
			const call = dead ? { name: 'act', arguments: { actionType: 'respawn', arguments: {} } }
				: { name: 'act', arguments: { actionType: 'flee_from', arguments: { targetId: SKELETON.uuid, distance: 16, timeoutMs: 10000 } } };
			try { await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: `t-${planner.requests.length}`, callId: `c-${planner.requests.length}`, tool: normalizeMinecraftToolCall(call.name, call.arguments) }); } catch { /* the turn ends either way */ }
			return { status: 'completed', toolCalls: 1 };
		};
		const env = { ...process.env, MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'fixture', MINEAGEN_WORLD_SEED_HASH: 'seed-one' };
		const run = await start({ registry, planner, env, memoryDirectory: null, traceWriter: { write: (event, fields) => { events.push({ event, ...fields }); } },
			config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
		try {
			run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat the game.', updatedAtEpochMs: t0 } });
			const observation = wire('game-one', t0, 1, { health: 14, zombie: false });
			observation.entities = [...observation.entities, SKELETON];
			run.bridge.emit('observation', { agentId: 'agent-a', payload: observation });
			await eventually(() => run.bridge.sent.some((m) => m.type === 'action_command' && m.payload.actionType === 'flee_from'));
			// The skeleton kills the agent before the flee reports a result.
			const death = { ...DEATH, cause: 'Probe was shot by Skeleton', gameMode: 'survival', diedAtEpochMs: Date.now() + 1 };
			run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'dead', goalRevision: 1, updatedAtEpochMs: death.diedAtEpochMs, death } });
			await eventually(() => events.some((e) => e.event === 'experience_death_reviewed'));
		} finally { await run.coordinator.stop?.(); }
		const reviewed = events.find((e) => e.event === 'experience_death_reviewed');
		assert.ok(reviewed.running.includes('flee_from'), JSON.stringify(reviewed));
		assert.ok(reviewed.lessons.includes('ranged-fled-in-open:mob=skeleton'), JSON.stringify(reviewed));
	} finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
