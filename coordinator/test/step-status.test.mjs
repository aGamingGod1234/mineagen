import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtocolV2Envelope } from '../src/protocol-v2.mjs';
import { STEP_STATUS_MIN_INTERVAL_MS, StepStatusPublisher, stepStatusLine } from '../src/step-status.mjs';

test('stepStatusLine drops the Doing prefix and the last-result part and keeps the route', () => {
	assert.equal(stepStatusLine('Doing: mine iron: need 3 raw iron; via strip mine; last: mine SUCCEEDED'), 'mine iron: need 3 raw iron; via strip mine');
	assert.equal(stepStatusLine('Doing: craft table'), 'craft table');
	assert.equal(stepStatusLine(null), '');
	assert.equal(stepStatusLine(''), '');
});

test('stepStatusLine shortens a long objective so the heading still shows, within 80 characters', () => {
	const why = 'need enough cobblestone and iron to finish the furnace and pickaxe before nightfall arrives here';
	const line = stepStatusLine(`Doing: mine iron: ${why}; heading @12,40,-7; last: travel PATH_BLOCKED`);
	assert.ok(line.length <= 80, line);
	assert.ok(line.endsWith('…; heading @12,40,-7'), line);
	assert.ok(line.startsWith('mine iron: need'), line);
	// A tail that leaves no room for the objective is dropped, never the objective.
	const longVia = 'x'.repeat(70);
	assert.equal(stepStatusLine(`Doing: mine iron: ${why}; via ${longVia}`), `mine iron: ${why}`.slice(0, 80).trimEnd());
});

test('every line the publisher sends passes the outbound planning_state check', () => {
	for (const doing of ['Doing: a\u0000b§c; via d e', `Doing: ${'😀'.repeat(60)}`, `Doing: ${'word '.repeat(40)}; heading north to y12`]) {
		const stepStatus = stepStatusLine(doing);
		assert.equal(createProtocolV2Envelope({ serverInstanceId: 'server-instance', agentId: 'agent-a', type: 'planning_state', messageId: 'step', payload: { goalRevision: 1, state: 'PLANNING', stepStatus } }).payload.stepStatus, stepStatus);
	}
});

function publisher(lines) {
	const sent = [];
	let now = 0;
	const record = { agentId: 'a1', goalRevision: 3, state: 'ACTING', currentGoal: 'beat' };
	const status = new StepStatusPublisher({ send: (epoch, agentId, payload) => { sent.push({ epoch, agentId, ...payload }); return Promise.resolve(); }, line: () => lines.shift() ?? lines.last, now: () => now });
	return { sent, record, status, advance: (ms) => { now += ms; } };
}

test('nothing is sent before the coordinator armed the epoch and revision', () => {
	const { sent, record, status } = publisher(['Doing: mine iron']);
	assert.equal(status.update(record, 1), false);
	assert.deepEqual(sent, []);
});

test('the publisher sends once on arm, drops repeats, rate-limits changes and resends after a new epoch', () => {
	const lines = ['Doing: mine iron', 'Doing: mine iron', 'Doing: smelt iron', 'Doing: smelt iron', 'Doing: smelt iron'];
	const { sent, record, status, advance } = publisher(lines);
	status.arm(record, 1);
	assert.deepEqual(sent, [{ epoch: 1, agentId: 'a1', goalRevision: 3, state: 'ACTING', stepStatus: 'mine iron' }]);
	assert.equal(status.update(record, 1), false, 'same text is not resent');
	advance(STEP_STATUS_MIN_INTERVAL_MS - 1);
	assert.equal(status.update(record, 1), false, 'a change inside the rate window waits');
	advance(1);
	assert.equal(status.update(record, 1), true);
	assert.equal(sent.at(-1).stepStatus, 'smelt iron');
	assert.equal(status.update(record, 2), false, 'an epoch that was not armed sends nothing');
	status.arm(record, 2);
	assert.equal(sent.at(-1).epoch, 2, 'the same text is sent again for a new epoch');
	assert.equal(sent.length, 3);
});

test('a cleared line is sent as empty text, and a send failure never throws', () => {
	const sent = [];
	let line = 'Doing: mine iron';
	const record = { agentId: 'a1', goalRevision: 1, state: 'PLANNING' };
	const status = new StepStatusPublisher({ send: (epoch, agentId, payload) => { sent.push(payload); return Promise.reject(Object.assign(new Error('full'), { code: 'AGENT_BACKPRESSURE' })); }, line: () => line, now: () => sent.length * 5_000 });
	status.arm(record, 1);
	line = null;
	assert.equal(status.update(record, 1), true);
	assert.equal(sent.at(-1).stepStatus, '');
	const throwing = new StepStatusPublisher({ send: () => { throw new Error('closed'); }, line: () => 'Doing: x' });
	assert.doesNotThrow(() => throwing.arm(record, 1));
});
