import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../..', import.meta.url));
const withJar = path.join(root, 'scripts/quality/lib/with-jar.mjs');
const modJar = new URL('../../scripts/quality/mod-jar.mjs', import.meta.url).href;

test('with-jar hands each run its own jar through MOD_JAR instead of a shared copy', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'with-jar-'));
	const [a, b] = [path.join(dir, 'a.jar'), path.join(dir, 'b.jar')];
	await writeFile(a, 'jar a');
	await writeFile(b, 'jar b');
	const script = path.join(dir, 'print.mjs');
	await writeFile(script, `import { MOD_JAR } from '${modJar}';\nimport path from 'node:path';\nconsole.log(path.join(process.cwd(), MOD_JAR));\n`);
	const run = jar => spawnSync(process.execPath, [withJar, jar, script], { cwd: root, encoding: 'utf8', env: { ...process.env, ARENA_MOD_JAR: '' } });
	// Two arms started together on one machine each read their own jar (the old copy into build/libs let the last win).
	const seen = [];
	for (const jar of [a, b]) {
		const result = run(jar);
		assert.equal(result.status, 0, result.stderr);
		const loaded = result.stdout.trim();
		assert.equal(await readFile(loaded, 'utf8'), await readFile(jar, 'utf8'));
		assert.ok(!path.relative(root, loaded).startsWith('..'), `the run's jar is inside the checkout: ${loaded}`);
		seen.push(loaded);
	}
	assert.notEqual(seen[0], seen[1], 'two jars never share one path');
	for (const loaded of seen) await rm(path.dirname(loaded), { recursive: true, force: true });
	const none = run('-');
	assert.equal(path.relative(root, none.stdout.trim()).replace(/\\/g, '/'), (await import(modJar)).MOD_JAR.replace(/\\/g, '/'));
	assert.equal(run(path.join(dir, 'missing.jar')).status, 2);
});
