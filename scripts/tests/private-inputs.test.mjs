import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const helper = new URL('../../coordinator/scripts/private-inputs.mjs', import.meta.url).href;

test('archive paths preserve URL characters and missing configured inputs fail without a fallback', async () => {
 const archive = await mkdtemp(path.join(os.tmpdir(), 'arena archive % # '));
 const relative = 'coordinator/test/fixtures/decision-eval/';
 try {
  await mkdir(path.join(archive, relative), { recursive: true });
  await writeFile(path.join(archive, relative, 'case.json'), '{"sample":1}');
  const source = `import { privateInput, privateInputUrl } from ${JSON.stringify(helper)}; import { readFileSync, readdirSync } from 'node:fs'; console.log(readFileSync(privateInput('${relative}case.json'), 'utf8')); console.log(readdirSync(privateInputUrl('${relative}')).join(',')); privateInput('${relative}missing.json');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, ARENA_PRIVATE_INPUTS: archive } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\{"sample":1\}\ncase.json/);
  assert.match(result.stderr, /Private input missing: coordinator\/test\/fixtures\/decision-eval\/missing.json/);
  assert.match(result.stderr, /ARENA_PRIVATE_INPUTS/);
 } finally { await rm(archive, { recursive: true, force: true }); }
});

test('CI accepts explicit case paths without requiring the default recording archive', () => {
 const cli = new URL('../decision-eval/ci-check.mjs', import.meta.url);
 const env = { ...process.env }; delete env.ARENA_PRIVATE_INPUTS;
 for (const cases of [['--cases', '/unused-case.json'], ['--cases=/unused-case.json']]) {
  const result = spawnSync(process.execPath, [fileURLToPath(cli), '--base', 'missing-ref-private-input-test', '--head', 'HEAD', ...cases], { encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /SKIP/);
  assert.match(result.stderr, /is not in this clone/);
 }
});
