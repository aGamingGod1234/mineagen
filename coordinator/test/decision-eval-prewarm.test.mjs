import assert from 'node:assert/strict';
import test from 'node:test';

import { runSample } from '../src/decision-eval/runner.mjs';

const testCase = { id: 'prewarm-case', family: 'runner', causeClass: 'runner', split: 'train', state: { observation: {} } };
const rendered = { input: 'wake', inputSha256: 'a', inputBytes: 4, encodedSha256: 'b', encodedBytes: 4, trigger: 'test' };

function fakeAdapter(prewarm) {
	const order = [];
	let clock = 0;
	const adapter = {
		provider: 'claude', model: 'claude-test', effort: 'low', ...(prewarm === undefined ? {} : { prewarm }),
		async open() {
			order.push('open');
			clock += 10;
			return {
				agent: {
					async prewarm(options) { order.push(`prewarm:${options.goalRevision}`); clock += 500; },
					async act() { order.push('act'); clock += 1_000; return {}; },
					async interrupt() {},
				},
				async close() {},
			};
		},
		sentInput: () => null,
	};
	return { adapter, order, now: () => clock };
}

// Claude Code's process start and tool listing belong in bootMs, not in the model's own time.
test('a prewarming adapter is prewarmed once, after open and before the model turn, and counted as boot', async () => {
	const { adapter, order, now } = fakeAdapter(true);
	const result = await runSample(adapter, { testCase, rendered, sample: 0, sampleId: 'prewarm-1', now });
	assert.deepEqual(order.map(step => step.replace(/:.*/, '')), ['open', 'prewarm', 'act']);
	assert.match(order[1], /^prewarm:\d+$/);
	assert.equal(result.latency.bootMs, 510);
	assert.equal(result.latency.totalMs, 1_510);
});

test('an adapter without prewarm: true is never prewarmed', async () => {
	for (const prewarm of [undefined, false]) {
		const { adapter, order, now } = fakeAdapter(prewarm);
		const result = await runSample(adapter, { testCase, rendered, sample: 0, sampleId: 'prewarm-2', now });
		assert.deepEqual(order, ['open', 'act']);
		assert.equal(result.latency.bootMs, 10);
	}
});
