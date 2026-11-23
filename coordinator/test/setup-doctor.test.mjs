import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFixes, doctorContext, exportLine, runChecks } from '../../scripts/doctor.mjs';
import { recordingsRoot } from '../scripts/private-inputs.mjs';

const doctor = fileURLToPath(new URL('../../scripts/doctor.mjs', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const RECORDING = 'coordinator/test/fixtures/decision-eval/case.json';

/** A checkout with one libs JAR, one dependency and one archive-backed recording, plus a main checkout that has them. */
function fixture() {
	const base = mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
	const checkout = path.join(base, 'checkout'), main = path.join(base, 'main');
	for (const root of [checkout, main]) {
		write(path.join(root, 'gradle.properties'), `minecraft_version=26.3\nmc_compat=26.3\nfabric_api_version=0.1+26.3\ncarpet_version=26.3+v1\nlibs_checksums=checksums.sha256\nlithium_version=0.1+mc26.3\nlithium_url=https://example.invalid/lithium.jar\nlithium_sha256=${sha('lithium')}\n`);
		write(path.join(root, 'libs/checksums.sha256'), `${sha('carpet')}  fabric-carpet-26.3+v1.jar\n`);
		write(path.join(root, 'coordinator/package.json'), JSON.stringify({ dependencies: { acorn: '8.18.0' } }));
		write(path.join(root, 'coordinator/test/private-inputs.json'), JSON.stringify({ tests: [
			{ file: 'test/a.test.mjs', test: '*', inputs: [RECORDING] },
			{ file: 'test/b.test.mjs', test: '*', source: 'checkout', inputs: ['reports/only-in-private-checkout.json'] },
		] }));
	}
	write(path.join(main, 'libs/fabric-carpet-26.3+v1.jar'), 'carpet');
	write(path.join(main, 'coordinator/node_modules/acorn/package.json'), JSON.stringify({ version: '8.18.0' }));
	return { base, checkout, main, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const calls = [];
const stubRun = (command, args) => {
	calls.push([command, ...args].join(' '));
	if (command === 'git' && args[1] === '--get') return { status: 0, stdout: 'scripts/hooks\n' };
	return { status: 0, stdout: '', stderr: '' };
};
// Linux unless a test says otherwise, so the Windows CI job checks the same branches.
const context = (root, overrides = {}) => doctorContext({ root, platform: 'linux', env: { ARENA_SLOT_LOCKS: path.join(root, 'no-locks') }, run: stubRun, availableMb: () => 8000, defaultTemplate: path.join(root, 'no-template'), ...overrides });
const result = (ctx, name) => runChecks(ctx).find(entry => entry.name === name);

function template(dir, { fabricApi = '0.1+26.3', lithium = true } = {}) {
	for (const name of ['server.jar', 'fabric-server-launch.jar', 'eula.txt', `mods/fabric-api-${fabricApi}.jar`, 'mods/fabric-carpet-26.3+v1.jar', 'libraries/x.jar']) write(path.join(dir, name), 'x');
	if (lithium) write(path.join(dir, 'mods/lithium-fabric-0.1+mc26.3.jar'), 'lithium');
	write(path.join(dir, 'server.properties'), 'online-mode=false\nserver-ip=127.0.0.1\n');
	return dir;
}

test('libs and node_modules fail in a fresh worktree, and --fix copies both from the main checkout', async () => {
	const { checkout, main, cleanup } = fixture();
	try {
		const ctx = context(checkout);
		assert.match(result(ctx, 'libs').detail, /fabric-carpet-26\.3\+v1\.jar missing/);
		assert.equal(result(ctx, 'libs').status, 'FAIL');
		assert.match(result(ctx, 'node_modules').detail, /node_modules is missing/);
		write(path.join(checkout, 'libs/fabric-carpet-26.3+v1.jar'), 'tampered');
		assert.match(result(ctx, 'libs').detail, /checksum mismatch/);
		calls.length = 0;
		const steps = await applyFixes(ctx, { from: main });
		assert.ok(steps.some(step => /copied libs\/fabric-carpet/.test(step)), steps.join('\n'));
		assert.ok(steps.some(step => /copied coordinator\/node_modules/.test(step)), steps.join('\n'));
		assert.ok(!calls.some(call => /fetch-libs|npm ci/.test(call)), 'nothing is downloaded when the main checkout has it');
		assert.equal(result(ctx, 'libs').status, 'ok');
		assert.equal(result(ctx, 'node_modules').status, 'ok');
		assert.ok(!lstatSync(path.join(checkout, 'coordinator/node_modules')).isSymbolicLink());
	} finally { cleanup(); }
});

test('a symlinked node_modules fails, and --fix replaces the link with a copy without touching its target', { skip: process.platform === 'win32' && 'directory symlinks need extra rights on Windows' }, async () => {
	const { checkout, main, cleanup } = fixture();
	try {
		symlinkSync(path.join(main, 'coordinator/node_modules'), path.join(checkout, 'coordinator/node_modules'));
		const ctx = context(checkout);
		assert.match(result(ctx, 'node_modules').detail, /is a symlink/);
		await applyFixes(ctx, { from: main });
		assert.ok(!lstatSync(path.join(checkout, 'coordinator/node_modules')).isSymbolicLink());
		assert.equal(JSON.parse(readFileSync(path.join(main, 'coordinator/node_modules/acorn/package.json'), 'utf8')).version, '8.18.0');
		assert.equal(result(ctx, 'node_modules').status, 'ok');
	} finally { cleanup(); }
});

test('the server template check names the prepare command, a stale template, and a prepared one to export', async () => {
	const { base, checkout, cleanup } = fixture();
	try {
		const none = result(context(checkout), 'server template');
		assert.equal(none.status, 'FAIL');
		assert.match(none.fix, /node scripts\/prepare-server-template\.mjs --accept-minecraft-eula/);
		const good = template(path.join(base, 'good'));
		assert.equal(result(context(checkout, { env: { ARENA_HEADLESS_SERVER_TEMPLATE: good } }), 'server template').status, 'ok');
		const stale = template(path.join(base, 'stale'), { fabricApi: '0.0+26.2' });
		assert.match(result(context(checkout, { env: { ARENA_HEADLESS_SERVER_TEMPLATE: stale } }), 'server template').detail, /mods\/ lacks fabric-api-0\.1\+26\.3\.jar/);
		const unset = result(context(checkout, { defaultTemplate: good }), 'server template');
		assert.equal(unset.status, 'FAIL');
		assert.deepEqual(unset.env, { ARENA_HEADLESS_SERVER_TEMPLATE: good });
		const steps = await applyFixes(context(checkout), { from: null });
		assert.ok(steps.some(step => /pass --accept-minecraft-eula/.test(step)), 'the EULA is never accepted implicitly');
	} finally { cleanup(); }
});

test('a template without the pinned Lithium JAR warns, and --fix adds the checked download to it', async () => {
	const { base, checkout, cleanup } = fixture();
	try {
		const older = template(path.join(base, 'older'), { lithium: false });
		write(path.join(older, 'mods/lithium-fabric-0.0+mc26.3.jar'), 'old lithium');
		const ctx = context(checkout, { env: { ARENA_HEADLESS_SERVER_TEMPLATE: older }, defaultTemplate: older });
		const check = result(ctx, 'server template');
		assert.equal(check.status, 'warn');
		assert.match(check.detail, /lacks mods\/lithium-fabric-0\.1\+mc26\.3\.jar/);
		write(path.join(base, 'downloads/lithium-fabric-0.1+mc26.3.jar'), 'lithium');
		const steps = await applyFixes(ctx, { from: null });
		assert.ok(steps.some(step => /Added Lithium 0\.1\+mc26\.3/.test(step)), steps.join('\n'));
		assert.equal(readFileSync(path.join(older, 'mods/lithium-fabric-0.1+mc26.3.jar'), 'utf8'), 'lithium');
		assert.equal(existsSync(path.join(older, 'mods/lithium-fabric-0.0+mc26.3.jar')), false, 'the older Lithium version is replaced');
		assert.equal(result(ctx, 'server template').status, 'ok');
		write(path.join(base, 'downloads/lithium-fabric-0.1+mc26.3.jar'), 'tampered');
		rmSync(path.join(older, 'mods/lithium-fabric-0.1+mc26.3.jar'));
		await assert.rejects(applyFixes(ctx, { from: null }), /SHA-256 mismatch/);
	} finally { cleanup(); }
});

test('ARENA_PRIVATE_INPUTS at the archive root finds the one recording set marked by rundata-manifest.json', () => {
	const { base, checkout, cleanup } = fixture();
	try {
		const archive = path.join(base, 'archive');
		write(path.join(archive, 'docs/gameplay-friction/README.md'), 'x');
		write(path.join(archive, 'snapshot/rundata-manifest.json'), '{}');
		write(path.join(archive, 'snapshot', RECORDING), '{}');
		write(path.join(archive, 'old-worktree', RECORDING), '{}');
		assert.equal(recordingsRoot(archive), path.join(archive, 'snapshot'));
		const found = result(context(checkout, { env: { ARENA_PRIVATE_INPUTS: archive } }), 'private inputs');
		assert.equal(found.status, 'ok', found.detail);
		assert.match(found.detail, /all 1 recordings present \(recordings in snapshot\/\)/);
		// The direct layout wins, as CI and existing archives use it.
		const direct = path.join(base, 'direct');
		write(path.join(direct, RECORDING), '{}');
		write(path.join(direct, 'snapshot/rundata-manifest.json'), '{}');
		write(path.join(direct, 'snapshot', RECORDING), '{}');
		assert.equal(recordingsRoot(direct), direct);
		write(path.join(archive, 'second/rundata-manifest.json'), '{}');
		write(path.join(archive, 'second', RECORDING), '{}');
		assert.throws(() => recordingsRoot(archive), /2 recording sets with rundata-manifest\.json: second, snapshot/);
		assert.equal(result(context(checkout, { env: { ARENA_PRIVATE_INPUTS: archive } }), 'private inputs').status, 'FAIL');
		const unset = result(context(checkout), 'private inputs');
		assert.equal(unset.status, 'warn');
		assert.match(unset.detail, /skips 1 archive-backed selections/);
	} finally { cleanup(); }
});

test('a recording missing from the archive fails the private inputs check by name', () => {
	const { base, checkout, cleanup } = fixture();
	try {
		const archive = path.join(base, 'archive');
		write(path.join(archive, 'coordinator/test/fixtures/README.md'), 'x');
		const missing = result(context(checkout, { env: { ARENA_PRIVATE_INPUTS: archive } }), 'private inputs');
		assert.equal(missing.status, 'FAIL');
		assert.match(missing.detail, /1 of 1 recordings missing/);
		assert.ok(missing.detail.includes(RECORDING));
	} finally { cleanup(); }
});

test('Java 25 must be on JAVA_HOME; the fix exports the Java 25 found on PATH', () => {
	const { base, checkout, cleanup } = fixture();
	try {
		const jdk = path.join(base, 'jdk');
		write(path.join(jdk, 'bin/java'), 'x');
		const javaRun = version => (command, args) => {
			if (args.includes('-version')) return { status: 0, stdout: '', stderr: `Property settings:\n    java.home = ${jdk}\n\nopenjdk version "${version}" 2026-10-20` };
			return stubRun(command, args);
		};
		assert.match(result(context(checkout, { run: javaRun('21.0.4') }), 'java').detail, /no Java 25/);
		const unset = result(context(checkout, { run: javaRun('25.0.5') }), 'java');
		assert.equal(unset.status, 'FAIL');
		assert.match(unset.detail, /JAVA_HOME is unset/);
		assert.match(unset.fix, /^export JAVA_HOME=/);
		const home = unset.env.JAVA_HOME;
		assert.equal(result(context(checkout, { run: javaRun('25.0.5'), env: { JAVA_HOME: home } }), 'java').status, 'ok');
	} finally { cleanup(); }
});

test('a launcher shim for java on PATH resolves to the JDK the JVM reports, not the shim folder', () => {
	const { base, checkout, cleanup } = fixture();
	try {
		const shim = path.join(base, 'shims/bin/java'), jdk = path.join(base, 'jdk-25');
		write(shim, '#!/bin/sh\nexec /elsewhere/java "$@"\n');
		write(path.join(jdk, 'bin/java'), 'x');
		const run = (command, args) => {
			if (args.includes('-version')) return { status: 0, stdout: '', stderr: `    java.home = ${jdk}\nopenjdk version "25.0.5" 2026-10-20` };
			if (command === 'which') return { status: 0, stdout: `${shim}\n` };
			return stubRun(command, args);
		};
		const found = result(context(checkout, { run }), 'java');
		assert.equal(found.env.JAVA_HOME, jdk);
		assert.ok(existsSync(path.join(found.env.JAVA_HOME, 'bin/java')), 'the exported home has bin/java');
		// Without a reported home, the shim's own folder (which has bin/java) is not guessed.
		const guessed = result(context(checkout, { run: (command, args) => args.includes('-version') ? { status: 0, stdout: '', stderr: 'openjdk version "25.0.5"' } : run(command, args) }), 'java');
		assert.equal(guessed.env, undefined);
	} finally { cleanup(); }
});

test('--fix moves a checksum-invalid JAR aside before the download fallback, which keeps any file in place', async () => {
	const { base, checkout, cleanup } = fixture();
	try {
		const jar = path.join(checkout, 'libs/fabric-carpet-26.3+v1.jar');
		write(jar, 'tampered');
		const presentAtFetch = [];
		const run = (command, args) => {
			if (command === 'bash' && /fetch-libs\.sh$/.test(args[0])) presentAtFetch.push(existsSync(jar));
			return stubRun(command, args);
		};
		const steps = await applyFixes(context(checkout, { run }), { from: path.join(base, 'empty-main') });
		assert.ok(presentAtFetch.length > 0, 'the download fallback ran');
		assert.deepEqual([...new Set(presentAtFetch)], [false], 'the invalid JAR was out of the way when fetch-libs.sh ran');
		assert.equal(readFileSync(`${jar}.invalid`, 'utf8'), 'tampered');
		assert.ok(steps.some(step => /moved libs\/fabric-carpet-26\.3\+v1\.jar \(checksum mismatch\)/.test(step)), steps.join('\n'));
	} finally { cleanup(); }
});

test('--env lines keep $, backticks and quotes literal when eval reads them', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, () => {
	const value = "/cache-$DOCTOR_PROBE/`echo hi`/it's \"here\"";
	const shell = spawnSync('sh', ['-c', `${exportLine('DOCTOR_VALUE', value)}; printf %s "$DOCTOR_VALUE"`], { encoding: 'utf8', env: { ...process.env, DOCTOR_PROBE: 'expanded' } });
	assert.equal(shell.status, 0, shell.stderr);
	assert.equal(shell.stdout, value);
});

test('slot locks say Windows is unsupported, and memory warns below the live-server floor', () => {
	const { checkout, cleanup } = fixture();
	try {
		const windows = result(context(checkout, { platform: 'win32' }), 'slot locks');
		assert.equal(windows.status, 'skip');
		assert.match(windows.detail, /unsupported on Windows/);
		assert.equal(result(context(checkout), 'slot locks').status, 'warn');
		assert.equal(result(context(checkout, { availableMb: () => 4000 }), 'memory').status, 'warn');
		assert.equal(result(context(checkout, { availableMb: () => 7000 }), 'memory').status, 'ok');
		assert.equal(result(context(checkout, { nodeVersion: '20.11.0' }), 'node').status, 'FAIL');
	} finally { cleanup(); }
});

test('doctor --help needs nothing and an unknown argument exits 2', () => {
	const help = spawnSync(process.execPath, [doctor, '--help'], { encoding: 'utf8' });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--fix \[--from DIR\] \[--accept-minecraft-eula\]/);
	assert.equal(spawnSync(process.execPath, [doctor, '--bogus'], { encoding: 'utf8' }).status, 2);
});
