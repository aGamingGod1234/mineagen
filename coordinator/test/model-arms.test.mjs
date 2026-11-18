import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
// The env override would change the default these tests pin.
const env = { ...process.env, ARENA_CODEX_MODEL: '', ARENA_CLAUDE_MODEL: '' };

test('analyze-reflex reads the turns of the model it is given, and keeps gpt-6.1-sol as its default', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'reflex-model-'));
	try {
		const run = path.join(dir, 'run');
		await mkdir(run);
		const wake = { kind: 'observation', at: 2, text: `wake\n${JSON.stringify({ now: { guard: 'none installed' } })}` };
		const turn = { model: 'gpt-6.2-sol', timestamp: 1, outcome: 'completed', capture: { calls: [{ index: 0, inputs: [wake], toolCalls: [{ at: 3, name: 'runProgram', arguments: { source: 'x' } }] }] } };
		await writeFile(path.join(run, 'provider-turns.private.jsonl'), `${JSON.stringify(turn)}\n`);
		await writeFile(path.join(run, 'coordinator-private.jsonl'), '');
		const summary = async (...extra) => {
			const out = path.join(dir, `out-${extra.length}`);
			execFileSync(process.execPath, [script('scripts/quality/analyze-reflex.mjs'), run, out, ...extra], { stdio: 'pipe', env });
			return JSON.parse(await readFile(path.join(out, 'summary.json'), 'utf8'));
		};
		const sol62 = await summary('--model', 'gpt-6.2-sol');
		assert.equal(sol62.model, 'gpt-6.2-sol');
		assert.deepEqual(sol62.wakeGuards, { total: 1, absent: 1 });
		assert.equal(sol62.authorship.sourceCalls, 1);
		const fallback = await summary();
		assert.equal(fallback.model, 'gpt-6.1-sol');
		assert.deepEqual(fallback.wakeGuards, { total: 0, absent: 0 }, 'the default still reads only gpt-6.1-sol turns');
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('portal-kit lane scoring takes --model and still defaults to gpt-6.1-sol', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'kit-model-'));
	try {
		const cases = path.join(dir, 'cases.json'), runFile = path.join(dir, 'run.json');
		await writeFile(cases, JSON.stringify({ cases: [{ id: 'gate5-test-ask', state: { observation: { inventory: { items: [] } } }, source: { recordedCall: { arguments: { target: { count: 1 } } } } }] }));
		const row = (sample) => ({ caseId: 'gate5-test-ask', sample, error: null, calls: [{ name: 'do_step', args: { verb: 'obtain', target: { item: 'bucket', count: 2 } } }] });
		await writeFile(runFile, JSON.stringify({ config: { provider: 'codex', model: 'gpt-6.2-sol', effort: 'low', sampleCounts: { 'gate5-test-ask': 3 }, sampleOffset: 0 }, results: [row(0), row(1), row(2)] }));
		const score = (...extra) => execFileSync(process.execPath, [script('scripts/decision-eval/score-portal-kit.mjs'), '--cases', cases, ...extra, runFile], { stdio: 'pipe', env }).toString();
		assert.match(score('--model', 'gpt-6.2-sol'), /3\/3/);
		assert.throws(() => score(), /requires Codex gpt-6\.1-sol low/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the default model comes from one module, and one setting moves a whole session to another arm', async () => {
	const { defaultModel, DEFAULT_MODELS } = await import('../src/default-models.mjs');
	assert.deepEqual(DEFAULT_MODELS, { codex: 'gpt-6.1-sol', claude: 'claude-opus-5-5' });
	assert.equal(defaultModel('codex', {}), 'gpt-6.1-sol');
	assert.equal(defaultModel('codex', { ARENA_CODEX_MODEL: 'gpt-6.2-sol' }), 'gpt-6.2-sol');
	assert.equal(defaultModel('claude', { ARENA_CODEX_MODEL: 'gpt-6.2-sol' }), 'claude-opus-5-5');
	assert.throws(() => defaultModel('codex', { ARENA_CODEX_MODEL: 'gpt 6.2; rm' }), /must be a model id/);
	assert.throws(() => defaultModel('other', {}), /No default model/);
});

const sol = { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'low', serviceTier: 'default' };
// Two play calls at $0.50 each: $1.00 spent, and the largest call adds $0.50 of headroom.
const callRows = [1, 2].map((id) => ({ event: 'native_model_call', modelCallId: `c${id}`, goalRevision: 1, inputTokens: 200_000, outputTokens: 10_000 }));
async function capObserver(definition) {
	const { Observer } = await import('../../scripts/quality/run-scenarios.mjs');
	const observer = new Observer('.', { protocolAudit: '', providerTurns: '' }, { playMetering: 'observer', runReserveUsd: 10, ...definition }, sol, { stopRetryMs: 0 });
	observer.trace = { rows: callRows }; observer.provider = { rows: [] }; observer.startedAt = Date.now() - 60_000;
	return observer;
}

test('the observer spend cap still stops play by default at spend plus the largest call, and only logs in log mode', async () => {
	const under = await capObserver({ spendCapUsd: 1.6 });
	await under.enforceSpendCap();
	assert.equal(under.stopRequest ?? null, null, '$1.50 with headroom stays under a $1.60 cap');
	const stopping = await capObserver({ spendCapUsd: 1.4 });
	await stopping.enforceSpendCap();
	assert.equal(stopping.stopRequest.reason, 'SPEND_CAP');
	assert.equal(stopping.stopRequest.capUsd, 1.4);
	assert.ok(Math.abs(stopping.spendCapCrossed.spentUsd - 1) < 1e-9);
	const logging = await capObserver({ spendCapUsd: 1.4, spendCapMode: 'log' });
	await logging.enforceSpendCap();
	assert.equal(logging.stopRequest ?? null, null, 'log mode never asks the game to stop');
	const crossed = logging.spendCapCrossed;
	assert.equal(crossed.capUsd, 1.4); assert.ok(Math.abs(crossed.spentUsd - 1) < 1e-9); assert.ok(Math.abs(crossed.perCallUsd - 0.5) < 1e-9);
	assert.ok(crossed.atMs >= 60_000);
	logging.nextSpendCheck = 0; logging.trace = { rows: [...callRows, { ...callRows[0], modelCallId: 'c3' }] };
	await logging.enforceSpendCap();
	assert.equal(logging.spendCapCrossed, crossed, 'the first crossing is kept');
	assert.equal(logging.stopRequest ?? null, null);
});

test('a stop reason maps to window, cap, stall, goal or other, and an unrecorded one stays unknown', async () => {
	const { stopKind } = await import('../src/benchmark/long-run.mjs');
	assert.equal(stopKind('WALL_CLOCK_BUDGET'), 'window');
	assert.equal(stopKind('SPEND_CAP'), 'cap');
	assert.equal(stopKind('ENDED_EARLY:SPEND_CAP'), 'cap');
	assert.equal(stopKind('OPERATOR_STALL_45MIN'), 'stall');
	assert.equal(stopKind('Stalled: no new stage in 45 minutes'), 'stall');
	assert.equal(stopKind('DRAGON_KILLED'), 'goal');
	assert.equal(stopKind('ENDED_EARLY:RUNNER_ERROR'), 'other');
	for (const reason of [null, undefined, '', 'UNKNOWN_TERMINATION', 'ENDED_EARLY:UNKNOWN_TERMINATION']) assert.equal(stopKind(reason), null);
});

test('run-long takes --spend-cap-mode log for Codex only and records the cap mode, the crossing and the stop rule', async () => {
	const { mkdtemp: temp, rm: remove } = await import('node:fs/promises');
	const { parseLongArgs, runLong, stopOf } = await import('../../scripts/quality/run-long.mjs');
	const dir = await temp(path.join(os.tmpdir(), 'cap-mode-'));
	try {
		const base = ['--budget-minutes', '10', '--max-total-cost-usd', '4', '--port-base', '26900', '--jar', 'x.jar'];
		assert.equal(parseLongArgs([...base, '--out', dir]).spendCapMode, 'stop', 'the cap binds unless asked otherwise');
		assert.throws(() => parseLongArgs([...base, '--out', dir, '--spend-cap-mode', 'log']), /Codex play only/);
		assert.throws(() => parseLongArgs([...base, '--out', dir, '--provider', 'codex', '--codex-observer-cap', 'yes', '--spend-cap-mode', 'maybe']), /stop or log/);
		const options = parseLongArgs([...base, '--out', path.join(dir, 'out'), '--ledger', path.join(dir, 'ledger.json'), '--provider', 'codex', '--model', 'gpt-6.2-sol', '--codex-observer-cap', 'yes', '--spend-cap-mode', 'log']);
		let seen;
		const crossed = { at: 1, atMs: 300_000, capUsd: 3.6, spentUsd: 3.2, perCallUsd: 0.5 };
		const report = await runLong(options, { execute: async (o) => { seen = o; return { jar: null, runs: [{ termination: 'PASSED', measurementStatus: 'MEASURED', observerErrors: [], metrics: { modelCalls: 1, costEstimateUsd: 3.9 }, unmeteredProviderCalls: 0, spendCap: { mode: 'log', capUsd: 3.6, crossed } }] }; } });
		assert.equal(seen.definitions[0].spendCapMode, 'log');
		assert.equal(seen.definitions[0].spendCapUsd, 3.6);
		assert.equal(seen.model, 'gpt-6.2-sol');
		assert.deepEqual(report.spendCap, { mode: 'log', stopAtUsd: 3.6, crossed });
		assert.deepEqual(report.stop, { kind: 'other', reason: report.timeline.stopReason });
		assert.deepEqual(stopOf({ operatorStop: { reason: 'OPERATOR_STALL_45MIN' }, timeline: { stopReason: 'ENDED_EARLY:INTERRUPTED_SIGTERM' } }), { kind: 'stall', reason: 'OPERATOR_STALL_45MIN' });
		assert.deepEqual(stopOf({ timeline: { stopReason: 'SPEND_CAP' } }), { kind: 'cap', reason: 'SPEND_CAP' });
	} finally { await remove(dir, { recursive: true, force: true }); }
});

test('the mod summons the same default model the scripts use, and gpt-6.2-sol is a known Sol model', async () => {
	const { readFile: read } = await import('node:fs/promises');
	const { DEFAULT_CODEX_MODEL } = await import('../src/default-models.mjs');
	const source = (relative) => read(new URL(`../../${relative}`, import.meta.url), 'utf8');
	const java = await source('src/main/java/dev/agaminggod/mineagen/server/AgentCommands.java');
	assert.equal(/private static final String DEFAULT_MODEL = "([^"]+)";/.exec(java)?.[1], DEFAULT_CODEX_MODEL);
	assert.match(await source('src/main/java/dev/agaminggod/mineagen/agent/AgentModelNames.java'), /entry\("codex", "gpt-6\.2-sol", "GPT-6\.2 Sol", "Sol"\)/);
	const manifest = JSON.parse(await source('src/main/resources/assets/mineagen/identity/agent_visual_manifest.json'));
	const families = manifest.providers.find((provider) => provider.key === 'codex').families;
	assert.ok(families.find((family) => family.key === 'sol').models.includes('gpt-6.2-sol'));
});
