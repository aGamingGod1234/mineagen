// Boat (boat.dev) machines for room-batch.mjs and room-image.mjs, through the boat CLI (BOAT_BIN, default "boat").
// Every machine is created with --no-env (rooms make no model calls and need no stored secrets). Boat stops a machine
// at a fixed deadline counted from its creation (--ttl), not when it is idle, so keepAlive() pushes that deadline back
// while rooms remain; the deadline is the cost backstop if the batch runner itself dies.
// Each room runs under eatmydata, which turns fsync into a no-op. A boat disk takes about 39 ms per fsync (dsync writes
// at ~106 kB/s, measured 21 Nov), and a server's first `save-all flush` on a freshly generated world syncs every chunk:
// it took 51 s there against the fixtures' 30 s RCON timeout, so every room on a new jar came back INVALID. The
// machines are thrown away, so nothing needs the writes to survive a crash.
// Time outside the rooms (measured 21 Nov): every `boat ssh` or `boat scp` costs about 2.7 s before any byte moves and
// carries about 2.8 MB/s, while `boat exec` (over the boat API, real exit codes) answers in about 0.4 s but takes no
// input. So a machine gets everything in one ssh with the bundle on its input (prepare), a room starts with one exec,
// and one ssh both waits for the room's end and brings its folder back (poll).
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export function boat(args, { timeoutMs = 10 * 60_000, input = null, binary = false, anyExit = false, signal = null } = {}) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new Error('stopped')); return; }
		const child = spawn(process.env.BOAT_BIN ?? 'boat', ['--no-update', ...args], { stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
		const chunks = [];
		let stderr = '';
		child.stdout.on('data', chunk => { chunks.push(chunk); });
		child.stderr.on('data', chunk => { stderr += chunk; });
		const kill = () => child.kill('SIGKILL');
		const timer = setTimeout(kill, timeoutMs);
		signal?.addEventListener('abort', kill, { once: true });
		if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
		child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', kill); reject(error); });
		child.on('close', code => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', kill);
			const stdout = binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString();
			if (code === 0 || anyExit) resolve(stdout);
			else reject(Object.assign(new Error(`boat ${args[0]} exited ${code}: ${(stderr || String(stdout)).trim().split('\n').slice(-2).join(' ').slice(0, 400)}`), { stdout }));
		});
	});
}

const jsonLines = text => text.split('\n').map(line => line.trim()).filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

// boat ssh re-quotes a command that spans lines, so the script travels as one base64 word. It runs from a file, not
// from a pipe into bash, so the ssh input stays free for data (the bundle in prepare).
const sshCommand = script => `f=$(mktemp) && echo ${Buffer.from(script).toString('base64')} | base64 -d > "$f" && bash "$f"; rc=$?; rm -f "$f"; exit $rc`;

/** A shell command on the machine over ssh; resolves to its stdout, rejects when it fails (boat ssh hides the exit code). */
export async function remote(id, script, options) {
	const text = await boat(['ssh', id, '--', sshCommand(`(\n${script}\n)\necho __rc=$?\n`)], options);
	const match = /__rc=(\d+)\s*$/.exec(text);
	if (!match) throw new Error(`no answer from ${id}`);
	if (match[1] !== '0') throw new Error(`command failed on ${id} (${match[1]}): ${text.slice(0, -match[0].length).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
	return text.slice(0, match.index);
}
/** Like remote(), but stdout comes back as raw bytes (a tar stream); rejects when the script exits non-zero. */
export const remoteBytes = (id, script, options) => boat(['ssh', id, '--', sshCommand(script)], { ...options, binary: true });
/** A short shell command over `boat exec`: about 0.4 s against 2.7 s for ssh, with the real exit code. No input. */
export async function execRemote(id, script, { timeoutSeconds = 60, signal = null } = {}) {
	const text = await boat(['exec', id, '--json', '--timeout', String(timeoutSeconds), '--', 'bash', '-c', script], { timeoutMs: (timeoutSeconds + 60) * 1000, anyExit: true, signal });
	let result;
	try { result = JSON.parse(text.trim()); } catch { throw new Error(`no answer from ${id}: ${text.trim().slice(0, 300)}`); }
	if (!result.success) throw new Error(`command failed on ${id} (${result.timedOut ? 'timed out' : result.exitCode ?? result.error ?? '?'}): ${`${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
	return result.stdout ?? '';
}
export const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`;

/**
 * Writes the job file (when job is given) and starts the room helper in the background, returning at once. Only the
 * helper may go in the background: in `a && b && node ... > log &` the whole list is the background job, and its
 * subshell keeps the ssh output open until the room ends, so boat ssh waited out the room and timed out on rooms
 * longer than 10 minutes.
 */
export const launchScript = ({ outDir, code, helper, jobFile, log, node = 'node', job = null }) =>
	`${job ? `mkdir -p ${quote(path.posix.dirname(jobFile))} && echo ${Buffer.from(JSON.stringify(job)).toString('base64')} | base64 -d > ${quote(jobFile)} && ` : ''}rm -rf ${quote(outDir)} && cd ${quote(code)} || exit 1\nsetsid nohup ${node} ${quote(helper)} ${quote(jobFile)} > ${quote(log)} 2>&1 < /dev/null &\necho started`;

/**
 * Waits up to `seconds` for ROOM/done.json under outDir; once it is there, writes ROOM as a tar.gz on stdout, else
 * RUNNING. Empty output is no answer, never a room still playing, so a machine that is gone counts toward being lost.
 */
export const waitAndPackScript = ({ outDir, room, seconds }) =>
	`f=${quote(`${outDir}/${room}/done.json`)}; end=$((SECONDS + ${seconds}))\nwhile [ ! -f "$f" ] && [ $SECONDS -lt $end ]; do sleep 0.2; done\n[ -f "$f" ] || { echo ${RUNNING}; exit 0; }\n${packScript({ outDir, room })}`;
const RUNNING = 'RUNNING';
const GZIP = Buffer.from([0x1f, 0x8b]);
/** What a waitAndPackScript run printed: 'running', the room's tar.gz, or a throw when the machine gave no answer. */
export function readWait(id, data) {
	if (data.subarray(0, RUNNING.length).toString() === RUNNING) return 'running';
	if (data.length > 2 && data.subarray(0, 2).equals(GZIP)) return data;
	throw new Error(`no answer from ${id}${data.length ? `: ${data.subarray(0, 200).toString().trim()}` : ''}`);
}
// secret.txt is a throwaway per-run RCON secret; worlds are already deleted unless kept.
const packScript = ({ outDir, room }) => `cd ${quote(outDir)} && tar --exclude=secret.txt -cz ${quote(room)}`;

// What a batch machine needs of the code: what scripts/quality/test-*-live.mjs and watch-replay.mjs import (scripts/,
// coordinator/src, coordinator/config and acorn from coordinator/node_modules) and the files they read while they run
// (coordinator/test/fixtures, docs/gates, gradle.properties, server-template). The Java sources and the coordinator's
// own tests stay home: they were 25 of the archive's 34 MB. coordinator/test/room-batch.test.mjs walks the imports.
export const BUNDLE_PATHS = ['scripts', 'coordinator/src', 'coordinator/config', 'coordinator/scripts', 'coordinator/package.json', 'coordinator/package-lock.json',
	'coordinator/test/fixtures', 'docs', 'gradle.properties', 'server-template'];
const EXTRA = '.room-batch';

export function hasZstd() { try { execFileSync('zstd', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }

/**
 * One compressed tar holding everything a machine gets: the code at REF (BUNDLE_PATHS plus this checkout's
 * coordinator/node_modules) at its root, and under .room-batch/ the room helper, jars/ARM.jar and inputs/NAME.
 * zstd's 128 MB window sees that the arms' jars are nearly the same file: two 5.5 MB jars pack to 5.4 MB, against
 * 10.5 MB with gzip, whose window is 32 kB. gzip is the fallback when this machine has no zstd.
 */
export async function buildBundle({ root, ref = 'HEAD', jars, inputs = [], helper, work, zstd = hasZstd() }) {
	const tarFile = path.join(work, 'bundle.tar');
	const present = BUNDLE_PATHS.filter(entry => execFileSync('git', ['-C', root, 'ls-tree', '--name-only', ref, '--', entry], { encoding: 'utf8' }).trim());
	execFileSync('git', ['-C', root, 'archive', '--format=tar', '-o', tarFile, ref, ...present]);
	execFileSync('tar', ['-C', root, '-rf', tarFile, 'coordinator/node_modules']);
	const extra = path.join(work, 'stage', EXTRA);
	await mkdir(path.join(extra, 'jars'), { recursive: true });
	await mkdir(path.join(extra, 'inputs'), { recursive: true });
	await copyFile(helper, path.join(extra, 'room-batch-remote.mjs'));
	for (const [arm, local] of Object.entries(jars)) await copyFile(local, path.join(extra, 'jars', `${arm}.jar`));
	for (const input of inputs) await copyFile(input.local, path.join(extra, 'inputs', input.name));
	execFileSync('tar', ['-C', path.join(work, 'stage'), '-rf', tarFile, EXTRA]);
	if (zstd) execFileSync('zstd', ['-q', '-10', '--long=27', '-T0', '--rm', tarFile]);
	else execFileSync('gzip', ['-6', tarFile]);
	return { file: `${tarFile}.${zstd ? 'zst' : 'gz'}`, unpack: zstd ? 'zstd -dc --long=27' : 'gzip -dc', jars: Object.keys(jars), inputs };
}

/** Unpacks the bundle arriving on stdin into ~/batch and checks the image; prints STEPS=receive+unpack,checks seconds and HOME=... last. */
export const prepareScript = ({ unpack, imageDir = 'rooms' }) => `exec 2>&1
set -e -o pipefail
t0=$(date +%s.%N)
B="$HOME/batch"; I="$HOME/"${quote(imageDir)}
command -v ${unpack.split(' ')[0]} >/dev/null || { echo '${unpack.split(' ')[0]} is missing: rebuild the image with room-image.mjs'; exit 1; }
rm -rf "$B" && mkdir -p "$B/code" "$B/jobs" "$B/out"
${unpack} | tar -x -C "$B/code"
mv "$B/code/${EXTRA}/"* "$B/" && rmdir "$B/code/${EXTRA}"
t1=$(date +%s.%N)
test -x "$I/jdk/bin/java" || { echo "no Java at $I/jdk: rebuild the image with room-image.mjs"; exit 1; }
test -f "$I/template-26.3/server.jar" || { echo "no server template at $I/template-26.3: rebuild the image with room-image.mjs"; exit 1; }
command -v eatmydata >/dev/null || { echo 'eatmydata is missing: rebuild the image with room-image.mjs'; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo 'Node 22 or newer is missing'; exit 1; }
t2=$(date +%s.%N)
awk -v a="$t0" -v b="$t1" -v c="$t2" 'BEGIN { printf "STEPS=%.1f,%.1f\\n", b - a, c - b }'
printf 'HOME=%s\\n' "$HOME"`;

export async function createMachine({ from = null, type = 'default', ttlSeconds = 7200, name, snapshots = false, noAutoStop = false }) {
	// boat takes --no-auto-stop only without a --ttl.
	const args = ['new', '--no-env', '--type', type, ...(noAutoStop ? ['--no-auto-stop'] : ['--ttl', String(ttlSeconds)]), '--name', name, '--json'];
	if (from) args.push('--from', from);
	if (!snapshots) args.push('--no-snapshots');
	let text;
	try { text = await boat(args, { timeoutMs: 10 * 60_000 }); }
	catch (error) {
		// A create that fails after boat printed the sandbox id still made a machine: delete it.
		const orphan = jsonLines(error.stdout ?? '').find(event => event.id)?.id;
		if (orphan) await boat(['delete', orphan, '--yes']).catch(() => {});
		throw error;
	}
	const events = jsonLines(text);
	const ready = events.find(event => event.event === 'ready');
	const id = ready?.id ?? events.find(event => event.id)?.id;
	if (!id) throw new Error(`boat new gave no sandbox id: ${text.slice(0, 300)}`);
	if (!ready) { await boat(['delete', id, '--yes']).catch(() => {}); throw new Error(`sandbox ${id} never reported ready`); }
	return { id, ttlSeconds };
}

/**
 * Waits until boat says every file of a machine made from a saved image has arrived (`hydrated`). Before that, boat
 * still downloads the image in the background and the first room plays on a disk filling up under it: on 21 Nov, 7 of
 * 8 first rooms started before hydration came back INVALID (bridge revision races, handshake timeouts) and 10 of 10
 * started after it passed. Hydration took 12 to 25 s. Resolves to the seconds waited; a machine that never says so
 * within maxMs is used anyway.
 */
export async function waitHydrated(id, { maxMs = 5 * 60_000, everyMs = 2000, log = () => {} } = {}) {
	const began = Date.now();
	while (Date.now() - began < maxMs) {
		const info = JSON.parse(await boat(['info', id, '--json'], { timeoutMs: 60_000 }).catch(() => '{}')).sandbox ?? null;
		if (info && info.hydrated !== false) return Math.round((Date.now() - began) / 1000);
		await new Promise(done => setTimeout(done, everyMs));
	}
	log(`machine ${id} still not hydrated after ${Math.round(maxMs / 1000)} s: using it anyway`);
	return Math.round((Date.now() - began) / 1000);
}

export async function machineState(id) {
	const info = JSON.parse(await boat(['info', id, '--json'], { timeoutMs: 60_000 }));
	return info.sandbox?.state ?? null;
}
const LIVE = new Set(['provisioned', 'cloning', 'ready', 'idle', 'running']);
export const destroyMachine = id => boat(['delete', id, '--yes', '--json'], { timeoutMs: 120_000 });
export const machineUsage = async id => JSON.parse(await boat(['usage', id, '--json'], { timeoutMs: 60_000 }));
/**
 * Puts the Codex CLI and a Codex sign-in on a machine for real-model games: codex VERSION under ~/.local (installed only
 * when missing or different) and AUTH_FILE as ~/.codex/auth.json, owner-only. Callers put ~/.local/bin on PATH, keep
 * auth.json and every per-run .codex-home out of copy-backs, and call removeCodexSignIn when done. Resolves to the
 * sign-in's sha256 on the machine; compare it after each game, because a changed hash means Codex refreshed the
 * sign-in there, which can sign out every other copy.
 */
export async function installCodex(id, { authFile, version }) {
	if (!/^[0-9][0-9A-Za-z.+-]*$/.test(version)) throw new Error(`bad codex version ${version}`);
	await remote(id, `set -e; mkdir -p ~/.codex; chmod 700 ~/.codex
[ "$(~/.local/bin/codex --version 2>/dev/null | awk '{print $NF}')" = ${quote(version)} ] || npm i -g --prefix ~/.local @openai/codex@${quote(version)} >/dev/null 2>&1; ~/.local/bin/codex --version >/dev/null`, { timeoutMs: 15 * 60_000 });
	await upload(id, authFile, '.codex/auth.json');
	return (await remote(id, 'chmod 600 ~/.codex/auth.json; sha256sum ~/.codex/auth.json | cut -c1-64')).trim();
}
export const codexSignInHash = async id => (await remote(id, 'sha256sum ~/.codex/auth.json | cut -c1-64')).trim();
export const removeCodexSignIn = (id, dirs = ['~/ck']) => remote(id, `rm -f ~/.codex/auth.json; for d in ${dirs.join(' ')}; do [ -d "$d" ] && find "$d" \\( -name auth.json -o -type d -name .codex-home -prune \\) -exec rm -rf {} +; done; true`);
export const extendMachine = (id, ttlSeconds) => boat(['extend', id, '--ttl', String(ttlSeconds), '--json'], { timeoutMs: 60_000 });
export const upload = (id, local, remotePath) => boat(['scp', local, `${id}:${remotePath}`], { timeoutMs: 15 * 60_000 });
export const download = (id, remotePath, local) => boat(['scp', `${id}:${remotePath}`, local], { timeoutMs: 15 * 60_000 });

function untar(data, dir) {
	return new Promise((resolve, reject) => {
		const tar = spawn('tar', ['-xz', '-C', dir], { stdio: ['pipe', 'inherit', 'inherit'] });
		tar.on('error', reject);
		tar.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
		tar.stdin.on('error', () => {});
		tar.stdin.end(data);
	});
}

/**
 * The pool room-batch-run.mjs drives. bundle: buildBundle()'s { file, unpack, jars: [arm], inputs: [{ local, name }] }.
 * The machine comes from the saved image (room-image.mjs): IMAGE/jdk, IMAGE/template-26.3, IMAGE/image.json under its home.
 * poll() is a long poll: one ssh that waits up to waitSeconds for the room's done.json and, once it is there, brings the
 * room's folder back in the same call, so a room's end is seen within about a second and fetch() needs no call of its own.
 */
export function boatPool({ snapshot, type = 'default', ttlSeconds = 7200, namePrefix, bundle, imageDir = 'rooms', waitSeconds = 60, log = console.log }) {
	let count = 0, payload = null;
	return {
		async create() {
			const vm = await createMachine({ from: snapshot, type, ttlSeconds, name: `${namePrefix}-${++count}` });
			const waited = await waitHydrated(vm.id, { log });
			if (waited) log(`machine ${vm.id} waited ${waited} s for its image to finish downloading`);
			return vm;
		},
		async prepare(vm) {
			payload ??= await readFile(bundle.file);
			const began = Date.now();
			const text = await remote(vm.id, prepareScript({ unpack: bundle.unpack, imageDir }), { input: payload, timeoutMs: 15 * 60_000 });
			const home = /^HOME=(.+)$/m.exec(text)?.[1];
			if (!home) throw new Error(`prepare on ${vm.id} gave no home: ${text.trim().slice(-300)}`);
			const batch = path.posix.join(home, 'batch');
			const [unpacked, checked] = (/^STEPS=(.+)$/m.exec(text)?.[1] ?? '?,?').split(',');
			log(`machine ${vm.id} prepared in ${((Date.now() - began) / 1000).toFixed(1)}s (bundle received and unpacked ${unpacked}s, image checked ${checked}s, the rest is ssh)`);
			return { home, wrapper: ['eatmydata'], code: `${batch}/code`, out: `${batch}/out`, jobs: `${batch}/jobs`, helper: `${batch}/room-batch-remote.mjs`,
				jars: Object.fromEntries(bundle.jars.map(arm => [arm, `${batch}/jars/${arm}.jar`])), inputs: Object.fromEntries(bundle.inputs.map(input => [input.local, `${batch}/inputs/${input.name}`])),
				javaHome: path.posix.join(home, imageDir, 'jdk'), template: path.posix.join(home, imageDir, 'template-26.3') };
		},
		async start(vm, job) {
			const jobs = path.posix.dirname(job.outDir).replace(/\/out$/, '/jobs');
			await execRemote(vm.id, launchScript({ outDir: job.outDir, code: job.code, helper: path.posix.join(path.posix.dirname(jobs), 'room-batch-remote.mjs'), jobFile: `${jobs}/${job.room}.json`, log: `${jobs}/${job.room}.log`, job }));
			vm.outDir = path.posix.dirname(job.outDir);
			vm.fetched = null;
		},
		async poll(vm, room, { signal = null } = {}) {
			const data = readWait(vm.id, await remoteBytes(vm.id, waitAndPackScript({ outDir: vm.outDir, room, seconds: waitSeconds }), { timeoutMs: (waitSeconds + 90) * 1000, signal }));
			if (data === 'running') return 'running';
			vm.fetched = { room, data };
			return 'done';
		},
		async alive(vm) { return LIVE.has(await machineState(vm.id)); },
		async fetch(vm, room, roomsDir) {
			await mkdir(roomsDir, { recursive: true });
			const stashed = vm.fetched?.room === room ? vm.fetched.data : null;
			vm.fetched = null;
			// Unpack into a staging folder and move the room into place only once done.json reads, so a failed copy never
			// leaves rows the merge could count, and a retry never inherits an earlier attempt's files.
			const staging = await mkdtemp(path.join(roomsDir, `.staging-${room}-`));
			try {
				// The folder normally came back with the poll that saw the end; a cut stream is fetched again on its own.
				try { if (!stashed) throw new Error('nothing stashed'); await untar(stashed, staging); }
				catch {
					await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
					await untar(await remoteBytes(vm.id, packScript({ outDir: vm.outDir, room }), { timeoutMs: 15 * 60_000 }), staging);
				}
				const done = JSON.parse(await readFile(path.join(staging, room, 'done.json'), 'utf8'));
				if (done.room !== room || typeof done.arms !== 'object') throw new Error(`done.json of ${room} does not describe it`);
				await rm(path.join(roomsDir, room), { recursive: true, force: true });
				await rename(path.join(staging, room), path.join(roomsDir, room));
				return done;
			} finally { await rm(staging, { recursive: true, force: true }); }
		},
		async keepAlive(vm) { await extendMachine(vm.id, ttlSeconds); log(`machine ${vm.id} deadline pushed back ${Math.round(ttlSeconds / 60)} min`); },
		usage: vm => machineUsage(vm.id),
		destroy: vm => destroyMachine(vm.id),
	};
}
