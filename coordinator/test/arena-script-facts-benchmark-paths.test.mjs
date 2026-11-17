import { privateInput } from '../scripts/private-inputs.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const coordinator = fileURLToPath(new URL('../', import.meta.url));
const benchmark = 'src/benchmark/arena-script-facts-benchmark.mjs';
const privateInputs = process.env.ARENA_PRIVATE_INPUTS;

test('facts benchmark CLI resolves modules and fixtures in a checkout with URL-encoded characters', { skip: !privateInputs && 'Set ARENA_PRIVATE_INPUTS to run the recorded-observation benchmark' }, () => {
	// Keep the real package's node_modules in the ancestor lookup path.
	const directory = mkdtempSync(path.join(coordinator, '.arena facts % # '));
	try {
		cpSync(path.join(coordinator, 'src'), path.join(directory, 'src'), { recursive: true });
		const fixtures = path.join(directory, 'coordinator/test/fixtures/decision-eval');
		mkdirSync(fixtures, { recursive: true });
		cpSync(privateInput('coordinator/test/fixtures/decision-eval/extra/night-bed.json'), path.join(fixtures, 'replay.json'));
		const reports = [];
		for (const args of [[], [directory, '1']]) {
			const result = spawnSync(process.execPath, [...process.execArgv, path.join(directory, benchmark), ...args], {
				cwd: os.tmpdir(), encoding: 'utf8', timeout: 60_000,
				env: { ...process.env, ARENA_PRIVATE_INPUTS: directory },
			});
			assert.equal(result.status, 0, result.error?.message ?? result.stderr);
			const report = JSON.parse(result.stdout);
			assert.equal(report.root, directory);
			assert.ok(report.samples > 0);
			assert.equal(report.factBuilds, report.samples * 2);
			assert.equal(report.scriptRuns, report.factBuilds * 5);
			assert.match(report.digest, /^[a-f0-9]{16}$/);
			reports.push(report);
		}
		assert.equal(reports[0].digest, reports[1].digest);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('facts benchmark path initialization converts a Windows file URL before resolving directories', () => {
	// Execute the actual initialization with Windows path semantics on any host.
	const source = readFileSync(path.join(coordinator, benchmark), 'utf8');
	const initialization = source.slice(0, source.indexOf('const imp ='))
		.replace(/^import .*;\r?\n/gm, '')
		.replaceAll('import.meta.url', JSON.stringify('file:///C:/arena%20agents%20%23%25/coordinator/src/benchmark/arena-script-facts-benchmark.mjs'));
	const initialize = new Function('path', 'fileURLToPath', 'process', `${initialization}\nreturn { root, fixtures };`);
	const convert = (url) => fileURLToPath(url, { windows: true });
	const environment = { ARENA_PRIVATE_INPUTS: 'E:\\private inputs #% ' };
	const expectedFixtures = path.win32.join(environment.ARENA_PRIVATE_INPUTS, 'coordinator/test/fixtures/decision-eval');
	assert.deepEqual(initialize(path.win32, convert, { argv: [], env: environment }), {
		root: 'C:\\arena agents #%\\coordinator', fixtures: expectedFixtures,
	});
	assert.deepEqual(initialize(path.win32, convert, { argv: ['node', 'benchmark', 'D:\\comparison checkout'], env: environment }), {
		root: 'D:\\comparison checkout', fixtures: expectedFixtures,
	});
});


test('facts benchmark CLI requires ARENA_PRIVATE_INPUTS before reading any recordings', () => {
	const env = { ...process.env };
	delete env.ARENA_PRIVATE_INPUTS;
	const result = spawnSync(process.execPath, [path.join(coordinator, benchmark)], { env, encoding: 'utf8', timeout: 10_000 });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Error: Set ARENA_PRIVATE_INPUTS to the private inputs root containing coordinator\/test\/fixtures\/decision-eval/);
	assert.doesNotMatch(result.stderr, /ENOENT|ERR_MODULE_NOT_FOUND/);
	assert.equal(result.stdout, '');
});
