#!/usr/bin/env node
// Setup check for a checkout or worktree: can it run the tests and the live practice rooms? One line per check, with
// the command that fixes it. Linux first; macOS is untested; on Windows the slot-lock check says it is unsupported.
//
//   node scripts/doctor.mjs                     check; exit 1 when a check fails (warnings do not fail)
//   node scripts/doctor.mjs --fix [--from DIR] [--accept-minecraft-eula]
//                                               safe local steps, then check again: copy libs/*.jar and
//                                               coordinator/node_modules from DIR (default: the main worktree), or
//                                               fetch them; set core.hooksPath; with --accept-minecraft-eula, prepare
//                                               the server template (scripts/prepare-server-template.mjs)
//   eval "$(node scripts/doctor.mjs --env)"     export JAVA_HOME and ARENA_HEADLESS_SERVER_TEMPLATE when they are
//                                               unset or wrong and a working value was found
import { cpSync, copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultTemplatePath, prepareTemplate, targetProperties, templateProblems } from './prepare-server-template.mjs';
import { liveSlotPool } from './quality/fixture-servers.mjs';
import { recordingsRoot } from '../coordinator/scripts/private-inputs.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const ok = (detail, extra = {}) => ({ status: 'ok', detail, ...extra });
const warn = (detail, fix, extra = {}) => ({ status: 'warn', detail, fix, ...extra });
const fail = (detail, fix, extra = {}) => ({ status: 'FAIL', detail, fix, ...extra });
const skip = detail => ({ status: 'skip', detail });

export function doctorContext(overrides = {}) {
	return {
		root: ROOT, env: process.env, platform: process.platform, nodeVersion: process.versions.node,
		run: (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options }),
		availableMb: () => {
			try { return Math.floor(Number(/^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024); }
			catch { return Math.floor(os.freemem() / 2 ** 20); }
		},
		...overrides,
	};
}

/** Version and java.home of one java executable, as the JVM itself reports them. */
function javaInfo(ctx, java) {
	const result = ctx.run(java, ['-XshowSettings:properties', '-version']);
	if (result.error) return { version: null };
	const output = `${result.stderr}${result.stdout}`;
	return { version: Number(/version "(\d+)/.exec(output)?.[1]) || 0, home: /^\s*java\.home = (.+?)\s*$/m.exec(output)?.[1] };
}

/** JAVA_HOME of the first Java 25 found: JAVA_HOME itself, then java on PATH. */
export function java25Home(ctx) {
	const exe = ctx.platform === 'win32' ? 'java.exe' : 'java';
	const isHome = home => Boolean(home) && existsSync(path.join(home, 'bin', exe));
	if (ctx.env.JAVA_HOME && javaInfo(ctx, path.join(ctx.env.JAVA_HOME, 'bin', exe)).version === 25) return ctx.env.JAVA_HOME;
	// Use the home the JVM reports: the folder above `java` on PATH is wrong when that is a launcher shim, not the JDK.
	const onPath = javaInfo(ctx, exe);
	return onPath.version === 25 && isHome(onPath.home) ? onPath.home : null;
}

/** One `export NAME='value'` line that `eval` in bash or sh reads back as exactly that value. */
export function exportLine(name, value) {
	return `export ${name}='${String(value).replaceAll("'", `'\\''`)}'`;
}

/** Every libs/ JAR a checksum file names, for all three Minecraft targets, with its state. */
export function libsState(root) {
	const libs = path.join(root, 'libs');
	return readdirSync(libs).filter(name => /^checksums.*\.sha256$/.test(name)).sort().flatMap(sums =>
		readFileSync(path.join(libs, sums), 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
			const [hash, raw] = line.trim().split(/\s+/), name = raw.replace(/^\*/, ''), file = path.join(libs, name);
			return { name, hash, file, state: !existsSync(file) ? 'missing' : sha256(file) === hash ? 'ok' : 'checksum mismatch' };
		}));
}

/** The coordinator's dependencies as installed: problems, or an empty list. */
export function nodeModulesProblems(root) {
	const dir = path.join(root, 'coordinator/node_modules');
	let info;
	try { info = lstatSync(dir); } catch { return ['coordinator/node_modules is missing']; }
	if (info.isSymbolicLink()) return ['coordinator/node_modules is a symlink; it must be a copied folder'];
	const { dependencies = {} } = JSON.parse(readFileSync(path.join(root, 'coordinator/package.json'), 'utf8'));
	return Object.entries(dependencies).flatMap(([name, wanted]) => {
		const manifest = path.join(dir, name, 'package.json');
		if (!existsSync(manifest)) return [`${name} is not installed`];
		const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
		return version === wanted ? [] : [`${name} ${version} installed, package.json pins ${wanted}`];
	});
}

/** Archive-backed recordings the test manifest needs, checked under the resolved recordings folder. */
export function privateInputsState(root, archive) {
	const manifest = JSON.parse(readFileSync(path.join(root, 'coordinator/test/private-inputs.json'), 'utf8'));
	const archived = manifest.tests.filter(entry => entry.source !== 'checkout');
	const inputs = [...new Set(archived.flatMap(entry => entry.inputs))];
	if (!archive) return { selections: archived.length, inputs };
	const recordings = recordingsRoot(archive);
	return { selections: archived.length, inputs, recordings, missing: inputs.filter(input => !existsSync(path.join(recordings, input))) };
}

export const checks = [
	['node', ctx => {
		const major = Number(ctx.nodeVersion.split('.')[0]);
		return major >= 22 ? ok(`Node ${ctx.nodeVersion}`) : fail(`Node ${ctx.nodeVersion}; coordinator/package.json needs 22 or newer`, 'install Node 22 or newer');
	}],
	['java', ctx => {
		const exe = ctx.platform === 'win32' ? 'java.exe' : 'java';
		const home = java25Home(ctx);
		if (!home) return fail('no Java 25 on JAVA_HOME or PATH (Gradle, the template and live fixtures need it)', 'install a Java 25 JDK (Temurin 25) and set JAVA_HOME to it');
		if (ctx.env.JAVA_HOME !== home) {
			const why = ctx.env.JAVA_HOME ? `JAVA_HOME=${ctx.env.JAVA_HOME} is not Java 25` : 'JAVA_HOME is unset; live fixtures refuse to start without it';
			return fail(why, `export JAVA_HOME=${home}`, { env: { JAVA_HOME: home } });
		}
		return ok(`Java 25 at ${path.join(home, 'bin', exe)}`);
	}],
	['libs', ctx => {
		const bad = libsState(ctx.root).filter(jar => jar.state !== 'ok');
		if (!bad.length) return ok('every libs/ JAR for 26.1, 26.2 and 26.3 matches its checksum');
		return fail(`${bad.map(jar => `${jar.name} ${jar.state}`).join(', ')} (untracked; Gradle needs them)`,
			'node scripts/doctor.mjs --fix (copies from the main checkout), or ./scripts/fetch-libs.sh [26.1|26.2]');
	}],
	['node_modules', ctx => {
		const problems = nodeModulesProblems(ctx.root);
		return problems.length ? fail(problems.join('; '), 'node scripts/doctor.mjs --fix (copies, never links), or cd coordinator && npm ci') : ok('coordinator/node_modules is a real folder with every pinned dependency');
	}],
	['git hooks', ctx => {
		const value = ctx.run('git', ['config', '--get', 'core.hooksPath'], { cwd: ctx.root }).stdout?.trim();
		return value === 'scripts/hooks' ? ok('core.hooksPath runs the publication gate on every commit') : fail(`core.hooksPath is ${value || 'unset'}`, 'git config core.hooksPath scripts/hooks');
	}],
	['server template', ctx => {
		const properties = targetProperties(ctx.root), fallback = ctx.defaultTemplate ?? defaultTemplatePath(properties.minecraft_version);
		const prepare = `node scripts/prepare-server-template.mjs --accept-minecraft-eula, then export ARENA_HEADLESS_SERVER_TEMPLATE=${fallback}`;
		const set = ctx.env.ARENA_HEADLESS_SERVER_TEMPLATE;
		const fallbackReady = templateProblems(fallback, properties).length === 0;
		const use = fallbackReady ? `export ARENA_HEADLESS_SERVER_TEMPLATE=${fallback}` : prepare;
		if (set) {
			const problems = templateProblems(set, properties);
			if (!problems.length) return ok(`ARENA_HEADLESS_SERVER_TEMPLATE is a ${properties.minecraft_version} template`);
			return fail(`ARENA_HEADLESS_SERVER_TEMPLATE=${set}: ${problems.join('; ')}`, use, fallbackReady ? { env: { ARENA_HEADLESS_SERVER_TEMPLATE: fallback } } : {});
		}
		if (fallbackReady) return fail(`ARENA_HEADLESS_SERVER_TEMPLATE is unset; a prepared template is at ${fallback}`, use, { env: { ARENA_HEADLESS_SERVER_TEMPLATE: fallback } });
		return fail('ARENA_HEADLESS_SERVER_TEMPLATE is unset and no template is prepared (live fixtures need one)', prepare);
	}],
	['private inputs', ctx => {
		const archive = ctx.env.ARENA_PRIVATE_INPUTS;
		let state;
		try { state = privateInputsState(ctx.root, archive); } catch (error) { return fail(error.message, 'set ARENA_PRIVATE_INPUTS to the archive folder that holds coordinator/test/fixtures'); }
		if (!archive) return warn(`ARENA_PRIVATE_INPUTS is unset: npm test skips ${state.selections} archive-backed selections by name`, 'export ARENA_PRIVATE_INPUTS=<private archive root> if you have the archive');
		if (!existsSync(archive)) return fail(`ARENA_PRIVATE_INPUTS=${archive} does not exist`, 'point it at the private archive root');
		if (state.missing.length) return fail(`${state.missing.length} of ${state.inputs.length} recordings missing under ${state.recordings}: ${state.missing.slice(0, 3).join(', ')}`, 'point ARENA_PRIVATE_INPUTS at the archive root that holds coordinator/test/fixtures (or one subfolder with rundata-manifest.json)');
		const where = path.resolve(state.recordings) === path.resolve(archive) ? '' : ` (recordings in ${path.relative(archive, state.recordings)}/)`;
		if (!existsSync(path.join(archive, 'docs/gameplay-friction'))) return warn(`all ${state.inputs.length} recordings present${where}, but ${archive} has no docs/gameplay-friction for friction entries`, 'check that ARENA_PRIVATE_INPUTS is the archive root, not a recordings subfolder');
		return ok(`all ${state.inputs.length} recordings present${where}; friction entries go to docs/gameplay-friction`);
	}],
	['slot locks', ctx => {
		if (ctx.platform === 'win32') return skip('unsupported on Windows: slot.sh and flock are Linux tools; run one live fixture at a time');
		const pool = liveSlotPool(ctx.env);
		if (!pool) return warn('no live slot locks (ARENA_SLOT_LOCKS): live fixtures run without the shared machine lock', 'on the shared test machine, set ARENA_SLOT_LOCKS to its locks folder; elsewhere run one live fixture at a time');
		const slotSh = path.join(path.dirname(pool.dir), 'slot.sh');
		if (ctx.run('flock', ['--version']).error) return fail('flock is not installed; slot.sh and the warm-server pool need it', 'install util-linux (flock)');
		let free = 0;
		for (let slot = 0; slot < pool.count; slot++) if (ctx.run('flock', ['-n', path.join(pool.dir, `live-${slot}.lock`), 'true']).status === 0) free++;
		const launcher = existsSync(slotSh) ? `run live fixtures as ${slotSh} live node scripts/quality/<fixture> OUT` : `no slot.sh beside ${pool.dir}`;
		return (existsSync(slotSh) ? ok : warn)(`${free} of ${pool.count} live slots free; ${launcher}`, existsSync(slotSh) ? undefined : 'ask the machine owner where slot.sh lives');
	}],
	['memory', ctx => {
		const mb = ctx.availableMb();
		if (mb >= 6000) return ok(`${mb} MB available: enough for a live server (about 3 GB each) beside Gradle or npm test`);
		if (mb >= 3000) return warn(`${mb} MB available: enough for one Gradle build or a full npm test, short of 6000 MB for a live server`, 'wait for memory before starting a live server');
		return warn(`${mb} MB available: under 3000 MB, Gradle and a full npm test may be killed`, 'wait for memory before Gradle, npm test or a live server');
	}],
];

export function runChecks(ctx = doctorContext()) {
	return checks.map(([name, check]) => {
		try { return { name, ...check(ctx) }; } catch (error) { return { name, ...fail(`check crashed: ${error.message}`, 'report this doctor bug') }; }
	});
}

export function formatResult({ status, name, detail, fix }) {
	return `${status.padEnd(4)}  ${name.padEnd(15)} ${detail}${fix && status !== 'ok' ? `\n${' '.repeat(22)}fix: ${fix}` : ''}`;
}

/** The main worktree (the first one git lists), when it is not this checkout. */
export function mainCheckout(ctx) {
	const listed = ctx.run('git', ['worktree', 'list', '--porcelain'], { cwd: ctx.root }).stdout ?? '';
	const first = /^worktree (.+)$/m.exec(listed)?.[1];
	return first && path.resolve(first) !== path.resolve(ctx.root) ? first : null;
}

/** Copies, never links. Returns one line per step taken. */
export async function applyFixes(ctx, { from = mainCheckout(ctx), acceptEula = false } = {}) {
	const steps = [];
	const badJars = libsState(ctx.root).filter(jar => jar.state !== 'ok');
	for (const jar of badJars) {
		const source = from && path.join(from, 'libs', jar.name);
		if (source && existsSync(source) && sha256(source) === jar.hash) { copyFileSync(source, jar.file); steps.push(`copied libs/${jar.name} from ${from}`); }
	}
	const stillBad = libsState(ctx.root).filter(jar => jar.state !== 'ok');
	if (stillBad.length && ctx.platform !== 'win32') {
		// fetch-libs.sh keeps any file already in place, so move a checksum-invalid one aside or it is never replaced.
		for (const jar of stillBad.filter(jar => jar.state === 'checksum mismatch')) {
			renameSync(jar.file, `${jar.file}.invalid`);
			steps.push(`moved libs/${jar.name} (checksum mismatch) to libs/${jar.name}.invalid`);
		}
		for (const target of ['', '26.1', '26.2']) {
			const result = ctx.run('bash', [path.join(ctx.root, 'scripts/fetch-libs.sh'), ...(target ? [target] : [])], { cwd: ctx.root });
			steps.push(`ran ./scripts/fetch-libs.sh ${target || '(default target)'}: exit ${result.status}`);
		}
	}
	if (nodeModulesProblems(ctx.root).length) {
		const target = path.join(ctx.root, 'coordinator/node_modules'), source = from && path.join(from, 'coordinator/node_modules');
		let info = null;
		try { info = lstatSync(target); } catch {}
		if (info?.isSymbolicLink()) { unlinkSync(target); steps.push('removed the coordinator/node_modules symlink (the linked folder is untouched)'); }
		if (source && existsSync(source) && !lstatSync(source).isSymbolicLink() && !nodeModulesProblems(from).length) {
			cpSync(source, target, { recursive: true, force: true, verbatimSymlinks: true });
			steps.push(`copied coordinator/node_modules from ${from}`);
		} else {
			const result = ctx.run(ctx.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: path.join(ctx.root, 'coordinator') });
			steps.push(`ran npm ci in coordinator: exit ${result.status}`);
		}
	}
	if (ctx.run('git', ['config', '--get', 'core.hooksPath'], { cwd: ctx.root }).stdout?.trim() !== 'scripts/hooks') {
		ctx.run('git', ['config', 'core.hooksPath', 'scripts/hooks'], { cwd: ctx.root });
		steps.push('set core.hooksPath to scripts/hooks');
	}
	const properties = targetProperties(ctx.root), fallback = ctx.defaultTemplate ?? defaultTemplatePath(properties.minecraft_version);
	const set = ctx.env.ARENA_HEADLESS_SERVER_TEMPLATE;
	if (!(set && !templateProblems(set, properties).length) && templateProblems(fallback, properties).length) {
		if (acceptEula) { await prepareTemplate({ root: ctx.root, out: fallback, log: line => steps.push(line.split('\n')[0]) }); }
		else steps.push('server template not prepared: pass --accept-minecraft-eula to accept the Minecraft EULA and prepare it');
	}
	return steps;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const args = process.argv.slice(2), flags = new Set();
	let from;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--from' && args[i + 1]) from = path.resolve(args[++i]);
		else if (['--fix', '--env', '--accept-minecraft-eula', '--help'].includes(args[i])) flags.add(args[i]);
		else { console.error(`Unknown argument ${args[i]}; see --help`); process.exit(2); }
	}
	if (flags.has('--help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map(line => line.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
	const ctx = doctorContext();
	if (flags.has('--env')) {
		for (const result of runChecks(ctx)) for (const [name, value] of Object.entries(result.env ?? {})) console.log(exportLine(name, value));
		process.exit(0);
	}
	if (flags.has('--fix')) {
		try { for (const step of await applyFixes(ctx, { ...(from ? { from } : {}), acceptEula: flags.has('--accept-minecraft-eula') })) console.log(`fix   ${step}`); }
		catch (error) { console.error(`fix failed: ${error.message}`); }
	}
	const results = runChecks(ctx);
	for (const result of results) console.log(formatResult(result));
	const failed = results.filter(result => result.status === 'FAIL').length;
	if (results.some(result => result.env)) console.log('\nSet the variables above in this shell: eval "$(node scripts/doctor.mjs --env)"');
	console.log(failed ? `\n${failed} check(s) failed.` : '\nReady: tests and live fixtures can run.');
	process.exitCode = failed ? 1 : 0;
}
