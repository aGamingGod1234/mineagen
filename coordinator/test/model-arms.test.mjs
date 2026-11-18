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
