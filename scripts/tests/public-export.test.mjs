import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const gate = path.join(root, 'scripts/check-public-tree.mjs');
test('publication gate reports file and line for private evidence and rejects oversize files', async () => {
 const dir = await mkdtemp(path.join(root, '.public-gate-test-'));
 try {
  const cases = [
   '/home/' + 'agaming' + 'god/private',
   'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'User/private',
   'mini' + 'pc', 'desktop' + '-lan', 'SAN' + 'PEDRO', 'lucas' + 'toh',
   '100.' + '64.1.2', '192.' + '168.1.2', 'node.tail123' + '.ts.net',
   'private' + '@' + 'personal.org', 'postplan' + '.dev/p/test', 'claude' + '.ai/artifact/secret',
   '{"cost' + 'Usd":0.012}', '{"input' + 'Tokens":123}',
   'Mini' + ' PC', 'Lap' + 'top', 'Desk' + 'top', 'Luc' + 'as',
  ];
  for (const value of cases) {
   await writeFile(path.join(dir, 'probe.txt'), 'first line\n' + value);
   const result = spawnSync(process.execPath, [gate, dir], { encoding: 'utf8' });
   assert.equal(result.status, 1, value);
   assert.match(result.stdout, /probe.txt:2: (?:FAIL|REVIEW)/);
  }
  await writeFile(path.join(dir, 'probe.txt'), 'placeholder@example.invalid\n');
  assert.match(execFileSync(process.execPath, [gate, dir], { encoding: 'utf8' }), /0 failures, 0 review/);
  await mkdir(path.join(dir, 'libs'));
  await writeFile(path.join(dir, 'libs/a.jar'), '');
  assert.equal(spawnSync(process.execPath, [gate, dir]).status, 1);
  await rm(path.join(dir, 'libs/a.jar'));
  await writeFile(path.join(dir, 'probe.txt'), Buffer.alloc(2_000_001));
  assert.equal(spawnSync(process.execPath, [gate, dir]).status, 1);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
