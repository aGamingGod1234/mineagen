import assert from 'node:assert/strict';
import test from 'node:test';
import { killTraceFields } from '../src/kill-trace.mjs';

test('a kill the body saw is traced with its block position, an unseen one without (issue #2, 1b)', () => {
	const record = { agentId: 'agent-a', goalRevision: 3 };
	assert.deepEqual(killTraceFields(record, { goalRevision: 3, entityType: 'minecraft:zombie', at: { x: 1, y: 64, z: -2 } }),
		{ agentId: 'agent-a', goalRevision: 3, entityType: 'minecraft:zombie', positioned: true, position: { x: 1, y: 64, z: -2 } });
	assert.deepEqual(killTraceFields(record, { goalRevision: 3, entityType: 'minecraft:skeleton' }),
		{ agentId: 'agent-a', goalRevision: 3, entityType: 'minecraft:skeleton', positioned: false });
	assert.equal('at' in killTraceFields(record, { goalRevision: 3, entityType: 'minecraft:zombie', at: { x: 0, y: 0, z: 0 } }), false,
		'the row never carries at, which the trace writer keeps as its timestamp');
});
