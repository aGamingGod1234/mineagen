import test from 'node:test';
import assert from 'node:assert/strict';
import { MomentCapture } from '../src/decision-eval/capture.mjs';
import { applyWording, checkWording } from '../src/decision-eval/wording.mjs';

const AGENT = 'a1';
const observation = (at, extra = {}) => ({ goalRevision: 1, observedAtEpochMs: at, ready: true, status: 'ACTING', position: { x: 0, y: 64, z: at / 1000 },
	player: { health: 20, foodLevel: 20, air: 300, maxAir: 300, skyOpen: true }, inventory: { items: [] }, entities: [], blocks: [],
	world: { dimension: 'minecraft:overworld', dayTime: 3000 }, ...extra });
const row = (type, payload, agentId = AGENT) => ({ direction: 'server_to_coordinator', envelope: { protocolVersion: 2, agentId, type, messageId: `m-${payload.observedAtEpochMs ?? 0}`, payload }, observedAtMs: payload.observedAtEpochMs ?? 0 });
const start = (goalSpec) => row('goal_control', { operation: 'start', goalRevision: 1, goal: 'Beat the game', goalSpec });

test('pinned capture takes one moment per pin, on the first observation of that agent at or after it, and nothing else', () => {
	const capture = new MomentCapture({ trace: 't', pinned: [{ atMs: 2500, label: 'ore|d1', agentId: AGENT }, { atMs: 2500, label: 'other|d2', agentId: 'b2' }] });
	capture.ingest(start({ originalRequest: 'Beat the game', fingerprint: 'f' }), 1);
	for (const at of [1000, 2000, 3000, 4000]) capture.ingest(row('observation', observation(at, { player: { health: at === 3000 ? 5 : 20, foodLevel: 20, air: 300, maxAir: 300 } })), at);
	assert.deepEqual(capture.moments.map((m) => [m.trigger, m.detail.label, m.source.atMs, m.detail.lagMs]), [['pinned', 'ore|d1', 3000, 500]],
		'the low-health edge at 3000 does not fire in pinned mode, and the other agent\'s pin never fires here');
});

test('sighting observations bring the earlier observation that first saw a cave into the replay', () => {
	const capture = new MomentCapture({ trace: 't', pinned: [{ atMs: 9000, label: 'ore|d1' }], options: { sightingObservations: 4 } });
	capture.ingest(start({ originalRequest: 'Beat the game', fingerprint: 'f' }), 1);
	const cave = { sighted: { caves: [{ x: 10, y: 40, z: 5, air: 60 }] } };
	for (const at of [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]) capture.ingest(row('observation', observation(at, at === 2000 || at === 3000 ? cave : {})), at);
	const [moment] = capture.moments;
	assert.deepEqual(moment.state.previousObservations.map((o) => o.observedAtEpochMs), [2000, 7000, 8000], 'first sighting (not the repeat), then the last two');
});

test('a turn-input goal spec with only the predicate keeps the recorded fingerprint', () => {
	const turn = { timestamp: 1500, agentId: AGENT, executionSettings: { controlProtocol: 'native_tools' }, input: `Update\n${JSON.stringify({ data: { goalSpec: { predicate: { type: 'x' } } } })}` };
	const capture = new MomentCapture({ trace: 't', turns: [turn], pinned: [{ atMs: 2000, label: 'p' }] });
	capture.ingest(start({ originalRequest: 'Beat the game', fingerprint: 'f', predicate: { type: 'old' } }), 1);
	capture.ingest(row('observation', observation(1000)), 2);
	capture.ingest(row('observation', observation(2000)), 3);
	assert.deepEqual(capture.moments[0].state.agent.goalSpec, { originalRequest: 'Beat the game', fingerprint: 'f', predicate: { type: 'x' } });
});

test('wake wording variants reword only the instruction and step lines, and choose appends one line', () => {
	const wake = `Action failed: travel_to NO_ROUTE. Keep the existing goal; choose its next unmet step from these fresh facts. Make progress now; no status lookup or unchanged retry.\n${JSON.stringify({ doing: 'Doing: Iron; last: x', now: { route: 'usual next step: obtain shield' }, observation: { health: 20 } })}`;
	assert.equal(applyWording(wake, 'production'), wake);
	const fresh = applyWording(wake, 'fresh');
	const [line, json] = [fresh.slice(0, fresh.indexOf('\n{')), JSON.parse(fresh.slice(fresh.indexOf('\n{') + 1))];
	assert.match(line, /^Fresh look: what would a skilled Minecraft player do right now\?/);
	assert.doesNotMatch(line, /Keep the existing goal|Make progress now/);
	assert.match(line, /What just happened: Action failed: travel_to NO_ROUTE\./);
	assert.deepEqual(json, { doing: 'Current step (one option, you may switch): Iron; last: x', now: { route: 'one usual next step: obtain shield' }, observation: { health: 20 } });
	const question = JSON.parse(applyWording(wake, 'fresh-question').split('\n')[1]);
	assert.equal(question.doing, 'Doing: Iron; last: x', 'fresh-question leaves the step lines alone');
	assert.ok(applyWording(wake, 'choose').startsWith(`${wake}\n\nBefore any tool call, say in one line what a skilled Minecraft player would do right now`));
	assert.throws(() => checkWording('loud'), /unknown wake wording/);
});
