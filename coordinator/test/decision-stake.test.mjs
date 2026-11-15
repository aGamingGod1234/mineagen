import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStake, printStake, STAKE_ROOT } from '../src/decision-eval/decision-stake.mjs';

test('recorded-fact stake exercises real coordinator holds, critical danger and stale results', async () => {
	const report = await runStake();
	await printStake(report, { summaryFile: null });
	assert.equal(report.results.length, 4);
	for (const row of report.results) {
		assert.equal(row.error, undefined, row.error);
		assert.equal(row.invariant, true, row.id);
		assert.equal(row.matches, true, `${row.id}: decision expectation changed; update the entry and explain why in the PR`);
	}
	assert.ok(report.results.find(row => row.id === 'hit-then-lava').metrics.handBacks > 0);
	assert.ok(report.wallMs < 60_000, `stake took ${report.wallMs} ms`);
});

test('an expectation change remains a visible mismatch and cannot alter the hard invariant result', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stake-expectation-'));
	try {
		await cp(STAKE_ROOT, dir, { recursive: true });
		const file = path.join(dir, 'expected.json'), expected = JSON.parse(await readFile(file));
		expected['creeper-steer'].decisions = [];
		await writeFile(file, JSON.stringify(expected));
		const report = await runStake({ root: dir, incident: 'creeper-steer' });
		assert.equal(report.pass, false);
		assert.equal(report.results[0].matches, false);
		assert.equal(report.results[0].invariant, true);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('tampered or incomplete episode evidence never passes', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stake-incomplete-'));
	try {
		await cp(STAKE_ROOT, dir, { recursive: true });
		await writeFile(path.join(dir, 'creeper-steer/episode.json'), '{}');
		const report = await runStake({ root: dir, incident: 'creeper-steer' });
		assert.equal(report.pass, false);
		assert.match(report.results[0].error, /INCOMPLETE/);
		assert.equal(report.results[0].invariant, false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the same stake summary is written to the existing CI step summary', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stake-summary-'));
	try {
		const file = path.join(dir, 'summary.md');
		const report = await runStake({ incident: 'zombie-hold' });
		const printed = await printStake(report, { summaryFile: file });
		assert.equal(await readFile(file, 'utf8'), printed);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

// A mutation whose pattern no longer matches would leave the source as it was and pass for the wrong reason.
async function patchSource(file, from, to) {
	const source = await readFile(file, 'utf8'), patched = source.replace(from, to);
	assert.notEqual(patched, source, `mutation did not change ${path.basename(file)}: its pattern no longer matches`);
	await writeFile(file, patched);
}

// Execute mutations in an isolated source copy: no shared imports or working-tree edits.
async function mutatedEpisode(mutate, incident) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stake-mutation-'));
	try {
		const base = new URL('../', import.meta.url);
		await cp(new URL('src/', base), path.join(dir, 'src'), { recursive: true });
		await cp(new URL('config/', base), path.join(dir, 'config'), { recursive: true });
		await cp(new URL('node_modules/', base), path.join(dir, 'node_modules'), { recursive: true });
		await cp(STAKE_ROOT, path.join(dir, 'test/fixtures/stake'), { recursive: true });
		await mutate(dir);
		const script = `import {runStake} from ${JSON.stringify(pathToFileURL(path.join(dir, 'src/decision-eval/decision-stake.mjs')).href)}; console.log(JSON.stringify((await runStake({incident:${JSON.stringify(incident)}})).results[0]));`;
		const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout);
	} finally { await rm(dir, { recursive: true, force: true }); }
}

test('a mutation whose pattern no longer matches fails instead of passing unchanged', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stake-patch-'));
	try {
		const file = path.join(dir, 'source.mjs');
		await writeFile(file, 'export const x = 1;\n');
		await assert.rejects(patchSource(file, 'no such text', 'y'), /did not change source\.mjs/);
		await patchSource(file, 'x = 1', 'x = 2');
		assert.equal(await readFile(file, 'utf8'), 'export const x = 2;\n');
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('lava cannot be masked by a low-health fork, and accepting every fought-mob hit goes red', async () => {
	const [row] = (await runStake({ incident: 'hit-then-lava' })).results;
	assert.deepEqual(row.diagnostics, { lavaHealth: 17, fightJudgement: 'fight', lavaHolds: 0 });
	const mutant = await mutatedEpisode(dir => patchSource(path.join(dir, 'src/search-danger.mjs'),
		/function hitBy\(player, judged\) \{[\s\S]*$/, "function hitBy(player, judged) { return judged.handle === 'fight'; }\n"), 'hit-then-lava');
	assert.equal(mutant.diagnostics.fightJudgement, 'fight');
	assert.equal(mutant.diagnostics.lavaHolds, 1);
	assert.equal(mutant.invariant, false);
});

test('late receipts cannot enter revision-two inputs, wakes or its fact ledger', async () => {
	const [row] = (await runStake({ incident: 'late-result' })).results;
	assert.equal(row.invariant, true);
	assert.deepEqual(row.diagnostics, { revisionTwoTurns: 1, staleLedgerReceipts: 0, receiptInputs: 0, receiptWakes: 0, contaminatedInputs: 0 });
	for (const bypassRegistry of [false, true]) {
		const mutant = await mutatedEpisode(async dir => {
			const file = path.join(dir, 'src/dynamic-main.mjs');
			await patchSource(file, 'current === null || message.payload.goalRevision !== current.goalRevision', 'current === null || false');
			if (bypassRegistry) await patchSource(file, 'const record = this.#registry.assertCurrentRevision(message.agentId, message.payload.goalRevision);\n\t\t\t\t\tthis.#ledger', 'const record = this.#registry.get(message.agentId);\n\t\t\t\t\tthis.#ledger');
		}, 'late-result');
		assert.equal(mutant.invariant, false, JSON.stringify(mutant));
		if (bypassRegistry) assert.equal(mutant.diagnostics.staleLedgerReceipts, 1);
		else assert.match(mutant.error, /Goal revision 1 does not match current revision 2/);
	}
});
