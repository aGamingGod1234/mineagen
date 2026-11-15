import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
test('public runner omits only declared private selections and fails an undeclared regression', async () => {
 const dir = await mkdtemp(path.join(root, '.public-scope-test-'));
 try {
  await mkdir(path.join(dir, 'scripts'));
  await mkdir(path.join(dir, 'test'));
  await copyFile(path.join(root, 'coordinator/scripts/run-public-suite.mjs'), path.join(dir, 'scripts/run-public-suite.mjs'));
  await writeFile(path.join(dir, 'test/private-inputs.json'), JSON.stringify({ tests: [
   { file: 'test/missing.test.mjs', test: '*', inputs: ['private-recording.json'] },
   { file: 'test/mixed.test.mjs', test: 'private sample 1', inputs: ['private-recording.json'] },
  ] }));
  await writeFile(path.join(dir, 'test/missing.test.mjs'), "throw Error('module needs private recording');");
  // The title is deliberately generated: source text validation must not reject valid runtime names.
  await writeFile(path.join(dir, 'test/mixed.test.mjs'), "import test from 'node:test'; for (const n of [1]) test(`private sample ${n}`, () => { throw Error('private recording missing'); }); test('independent', () => {});");
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, [path.join(dir, 'scripts/run-public-suite.mjs')], { encoding: 'utf8', env });
  const passed = run();
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /2 tests need private fixtures and were not run/);
  assert.match(passed.stdout, /# pass 1/);
  assert.doesNotMatch(passed.stdout, /# Subtest: private sample 1/); // Node name filters omit rather than count skipped cases.
  const full = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(full.status, 1, 'default full discovery must still execute private-dependent tests');
  assert.match(full.stdout + full.stderr, /private recording/);
  await writeFile(path.join(dir, 'test/regression.test.mjs'), "import test from 'node:test'; test('new regression', () => { throw Error('must fail'); });");
  assert.equal(run().status, 1, 'an unlisted failure must stay red');
  const pkg = JSON.parse(await readFile(path.join(root, 'coordinator/package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test --test-concurrency=4 --test-timeout=900000', 'private default remains full suite');
 } finally { await rm(dir, { recursive: true, force: true }); }
});
