import assert from 'node:assert/strict';
import test from 'node:test';
import { extractQualityMetrics } from '../src/benchmark/quality-metrics.mjs';
import { estimateTokenCostUsd, TOKEN_PRICES_PER_MILLION } from '../src/call-cost.mjs';
import { SPEED_TOKEN_PRICES_PER_MILLION, deriveRunMetrics } from '../src/benchmark/live-speed-benchmark.mjs';
const profile = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };
const extract = extra => extractQualityMetrics({ scenario: { setup: { dimension: 'minecraft:overworld' } }, profile, ...extra });
test('shared proxy table matches benchmark and coordinator weights', () => {
	assert.equal(SPEED_TOKEN_PRICES_PER_MILLION, TOKEN_PRICES_PER_MILLION);
	const tokens = { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 };
	const expected = estimateTokenCostUsd(tokens, profile);
	const speed = deriveRunMetrics({ profile, traceRows: [{ event: 'native_model_call', agentId: 'a', goalRevision: 1, totalMs: 1, inputTokens: 60, cachedInputTokens: 20, cacheWriteInputTokens: 30, outputTokens: 40 }] });
	assert.ok(Math.abs(speed.costEstimateUsd - expected) < 1e-6);
	assert.equal(estimateTokenCostUsd(tokens, { ...profile, model: 'unknown' }), null);
});

test('Codex preparation Luna is priced and priority aliases fast',()=>{
 const tokens={input:1000000,cacheRead:1000000,cacheWrite:1000000,output:1000000};
 const profile={provider:'codex',model:'gpt-6-luna',serviceTier:'standard'};
 assert.equal(estimateTokenCostUsd(tokens,profile),.735);
 assert.equal(estimateTokenCostUsd(tokens,{...profile,serviceTier:'priority'}),1.47);
 assert.equal(estimateTokenCostUsd(tokens,{...profile,serviceTier:'fast'}),1.47);
});

test('gpt-6.2-sol is priced like gpt-6.1-sol in both tables, and an unpriced model fails closed', async () => {
	const { TOKEN_PRICES_PER_MILLION: evalPrices, requireTokenPrice: requireEvalPrice } = await import('../src/decision-eval/pricing.mjs');
	const { requireTokenPrice } = await import('../src/call-cost.mjs');
	const tokens = { input: 1000, cacheRead: 2000, cacheWrite: 0, output: 300 };
	for (const serviceTier of ['default', 'fast']) {
		const sol = { provider: 'codex', model: 'gpt-6.2-sol', serviceTier };
		assert.ok(estimateTokenCostUsd(tokens, sol) > 0);
		assert.equal(estimateTokenCostUsd(tokens, sol), estimateTokenCostUsd(tokens, { ...sol, model: 'gpt-6.1-sol' }));
	}
	assert.deepEqual(evalPrices['codex:gpt-6.2-sol'], evalPrices['codex:gpt-6.1-sol']);
	assert.doesNotThrow(() => requireTokenPrice({ provider: 'codex', model: 'gpt-6.2-sol' }));
	assert.doesNotThrow(() => requireEvalPrice({ provider: 'codex', model: 'gpt-6.2-sol' }));
	assert.throws(() => requireTokenPrice({ provider: 'codex', model: 'gpt-9-unpriced' }), /No token price for codex:gpt-9-unpriced/);
	assert.throws(() => requireEvalPrice({ provider: 'codex', model: 'gpt-9-unpriced' }), /No token price for codex:gpt-9-unpriced/);
});

test('a capped long run refuses an unpriced model before it reserves or launches anything', async () => {
	const { mkdtemp, rm, readFile: read } = await import('node:fs/promises');
	const os = await import('node:os'); const path = await import('node:path');
	const { parseLongArgs, runLong } = await import('../../scripts/quality/run-long.mjs');
	const dir = await mkdtemp(path.join(os.tmpdir(), 'unpriced-'));
	try {
		const ledger = path.join(dir, 'ledger.json');
		const options = parseLongArgs(['--budget-minutes', '10', '--max-total-cost-usd', '4', '--ledger', ledger, '--port-base', '26900', '--out', path.join(dir, 'out'), '--provider', 'codex', '--model', 'gpt-9-unpriced', '--codex-observer-cap', 'yes', '--jar', 'x.jar']);
		let launches = 0;
		await assert.rejects(runLong(options, { execute: async () => { launches++; } }), /No token price for codex:gpt-9-unpriced/);
		assert.equal(launches, 0);
		await assert.rejects(read(ledger), /ENOENT/, 'nothing was reserved');
	} finally { await rm(dir, { recursive: true, force: true }); }
});
