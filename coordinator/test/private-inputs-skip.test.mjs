// A test that needs private recordings skips, not fails, when run directly with `node --test <file>` and no archive:
// npm test (scripts/run-public-suite.mjs) and the privateTest/privateModule helpers decide by the same manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { manifestEntries, unavailableInputs } from '../scripts/private-inputs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = pathToFileURL(path.join(root, 'scripts/private-inputs.mjs')).href;

test('every manifest selection goes through privateTest or privateModule in its file', async () => {
	const unwired = [];
	for (const entry of manifestEntries()) {
		const text = await readFile(path.join(root, entry.file), 'utf8');
		if (entry.test === '*') {
			if (!/^await privateModule\(import\.meta\.url(?:, \{[^}]*\})?\);$/m.test(text)) unwired.push(`${entry.file}: add await privateModule(import.meta.url) after its imports`);
		} else {
			const literal = [`privateTest('${entry.test}'`, `privateTest("${entry.test}"`, `privateTest(\`${entry.test}\``].some((call) => text.includes(call));
			// A title built from a template (context-cost-replay's per-recording tests) is checked when it registers.
			if (!literal && !/privateTest\(`[^`]*\$\{/.test(text)) unwired.push(`${entry.file}: ${entry.test}`);
		}
	}
	assert.deepEqual(unwired, []);
});

test('every privateModule or literal privateTest call has a manifest selection', async () => {
	const entries = manifestEntries();
	const strays = [];
	for (const file of new Set(entries.map((entry) => entry.file).concat(await testFilesUsingHelpers()))) {
		const text = await readFile(path.join(root, file), 'utf8');
		if (/^await privateModule\(import\.meta\.url(?:, \{[^}]*\})?\);$/m.test(text) && !entries.some((entry) => entry.file === file && entry.test === '*')) strays.push(`${file}: privateModule`);
		for (const [, , title] of text.matchAll(/privateTest\((['"])(.*?)\1/g)) {
			if (!entries.some((entry) => entry.file === file && entry.test === title)) strays.push(`${file}: ${title}`);
		}
	}
	assert.deepEqual(strays, []);
});

async function testFilesUsingHelpers() {
	const { readdir } = await import('node:fs/promises');
	const names = (await readdir(path.join(root, 'test'))).filter((name) => name.endsWith('.test.mjs'));
	const using = [];
	for (const name of names) if (/\bprivate(?:Test|Module)\(/.test(await readFile(path.join(root, 'test', name), 'utf8'))) using.push(`test/${name}`);
	return using.filter((file) => file !== 'test/private-inputs-skip.test.mjs');
}

test('a selection skips without the archive, and only the source checkout entries skip with it', () => {
	const archive = { file: 'test/x.test.mjs', test: '*', inputs: ['coordinator/test/fixtures/no-such-recording.json'] };
	const checkout = { ...archive, source: 'checkout' };
	const present = { ...archive, inputs: ['coordinator/package.json'] };
	assert.deepEqual(unavailableInputs(archive, ''), archive.inputs, 'an empty ARENA_PRIVATE_INPUTS (CI) counts as no archive');
	// null, not undefined: undefined would fall back to this run's own ARENA_PRIVATE_INPUTS.
	assert.deepEqual(unavailableInputs(archive, null), archive.inputs);
	assert.deepEqual(unavailableInputs(archive, '/some/archive'), [], 'with the archive set, a missing recording fails instead of skipping');
	assert.deepEqual(unavailableInputs(checkout, '/some/archive'), checkout.inputs, 'the archive never supplies a checkout-only input');
	assert.deepEqual(unavailableInputs(present, ''), []);
});

// The held-await skip is plain Node behaviour, so run it as Node runs a test file: its own process under node --test.
test('a module selection run directly with no archive reports one skip and exits 0, and a real failure still fails', async (t) => {
	// Outside the test folder, so a probe left by an interrupted run is never picked up by npm test.
	const dir = await mkdtemp(path.join(tmpdir(), 'private-skip-probe-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const entry = "{ file: 'probe', test: '*', inputs: ['coordinator/test/fixtures/no-such-recording.json'] }";
	const probe = async (name, body) => {
		const file = path.join(dir, name);
		await writeFile(file, `import test from 'node:test';\nimport { privateModule } from '${helper}';\n${body}\nawait privateModule(import.meta.url, { entry: ${entry} });\nthrow new Error('the module kept loading past a missing input');\n`);
		// NODE_TEST_CONTEXT would make the child report to this runner instead of printing its own results.
		const { NODE_TEST_CONTEXT: _context, ...rest } = process.env;
		const env = { ...rest, ARENA_PRIVATE_INPUTS: '' };
		return spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', env, cwd: root });
	};
	const skipped = await probe('skip.test.mjs', '');
	assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
	assert.match(skipped.stdout, /# skipped 1/);
	assert.match(skipped.stdout, /# fail 0/);
	assert.match(skipped.stdout, /private input unavailable/);
	const failing = await probe('fail.test.mjs', "test('an earlier real failure', () => { throw new Error('real'); });");
	assert.notEqual(failing.status, 0, 'a failure is never turned into a pass');
	assert.match(failing.stdout, /# fail 1/);
});

test('a module given its own input override runs on it instead of skipping', async () => {
	const { privateModule } = await import('../scripts/private-inputs.mjs');
	await privateModule(pathToFileURL(path.join(root, 'test/not-this-process.test.mjs')).href,
		{ entry: { file: 'test/not-this-process.test.mjs', test: '*', inputs: ['coordinator/test/fixtures/no-such-recording.json'] }, suppliedBy: '/another/corpus' });
});

test('a module selection loaded outside its own process throws instead of holding the run', async () => {
	const { privateModule } = await import('../scripts/private-inputs.mjs');
	const previous = process.env.ARENA_PRIVATE_INPUTS;
	process.env.ARENA_PRIVATE_INPUTS = '';
	try {
		assert.throws(() => privateModule(pathToFileURL(path.join(root, 'test/not-this-process.test.mjs')).href,
			{ entry: { file: 'test/not-this-process.test.mjs', test: '*', inputs: ['coordinator/test/fixtures/no-such-recording.json'] } }), /private input unavailable/);
	} finally {
		if (previous === undefined) delete process.env.ARENA_PRIVATE_INPUTS; else process.env.ARENA_PRIVATE_INPUTS = previous;
	}
});
