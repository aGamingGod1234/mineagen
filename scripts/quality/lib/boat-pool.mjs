// Boat (boat.dev) machines for room-batch.mjs and room-image.mjs, through the boat CLI (BOAT_BIN, default "boat").
// Every machine is created with --no-env (rooms make no model calls and need no stored secrets). Boat stops a machine
// at a fixed deadline counted from its creation (--ttl), not when it is idle, so keepAlive() pushes that deadline back
// while rooms remain; the deadline is the cost backstop if the batch runner itself dies.
// Each room runs under eatmydata, which turns fsync into a no-op. A boat disk takes about 39 ms per fsync (dsync writes
// at ~106 kB/s, measured 21 Nov), and a server's first `save-all flush` on a freshly generated world syncs every chunk:
// it took 51 s there against the fixtures' 30 s RCON timeout, so every room on a new jar came back INVALID. The
// machines are thrown away, so nothing needs the writes to survive a crash.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function boat(args, { timeoutMs = 10 * 60_000, input = null } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.env.BOAT_BIN ?? 'boat', ['--no-update', ...args], { stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
		let stdout = '', stderr = '';
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		if (input !== null) child.stdin.end(input);
		child.on('error', error => { clearTimeout(timer); reject(error); });
		child.on('close', code => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(Object.assign(new Error(`boat ${args[0]} exited ${code}: ${(stderr || stdout).trim().split('\n').slice(-2).join(' ').slice(0, 400)}`), { stdout }));
		});
	});
}

const jsonLines = text => text.split('\n').map(line => line.trim()).filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

/** A shell command on the machine; resolves to its stdout, rejects when it fails (boat ssh hides the exit code). */
export async function remote(id, script, options) {
	// boat ssh re-quotes a command that spans lines, so the script travels as one base64 word.
	const encoded = Buffer.from(`(\n${script}\n)\necho __rc=$?\n`).toString('base64');
	const text = await boat(['ssh', id, '--', `echo ${encoded} | base64 -d | bash`], options);
	const match = /__rc=(\d+)\s*$/.exec(text);
	if (!match) throw new Error(`no answer from ${id}`);
	if (match[1] !== '0') throw new Error(`command failed on ${id} (${match[1]}): ${text.slice(0, -match[0].length).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
	return text.slice(0, match.index);
}
export const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`;

/**
 * Starts the room helper in the background and returns at once. Only the helper may go in the background: in
 * `a && b && node ... > log &` the whole list is the background job, and its subshell keeps the ssh output open until
 * the room ends, so boat ssh waited out the room and timed out on rooms longer than 10 minutes.
 */
export const launchScript = ({ outDir, code, helper, jobFile, log, node = 'node' }) =>
	`rm -rf ${quote(outDir)} && cd ${quote(code)} || exit 1\nsetsid nohup ${node} ${quote(helper)} ${quote(jobFile)} > ${quote(log)} 2>&1 < /dev/null &\necho started`;

export async function createMachine({ from = null, type = 'default', ttlSeconds = 7200, name, snapshots = false }) {
	const args = ['new', '--no-env', '--type', type, '--ttl', String(ttlSeconds), '--name', name, '--json'];
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

export async function machineState(id) {
	const info = JSON.parse(await boat(['info', id, '--json'], { timeoutMs: 60_000 }));
	return info.sandbox?.state ?? null;
}
const LIVE = new Set(['provisioned', 'cloning', 'ready', 'idle', 'running']);
export const destroyMachine = id => boat(['delete', id, '--yes', '--json'], { timeoutMs: 120_000 });
export const machineUsage = async id => JSON.parse(await boat(['usage', id, '--json'], { timeoutMs: 60_000 }));
export const extendMachine = (id, ttlSeconds) => boat(['extend', id, '--ttl', String(ttlSeconds), '--json'], { timeoutMs: 60_000 });
export const upload = (id, local, remotePath) => boat(['scp', local, `${id}:${remotePath}`], { timeoutMs: 15 * 60_000 });
export const download = (id, remotePath, local) => boat(['scp', `${id}:${remotePath}`, local], { timeoutMs: 15 * 60_000 });

/**
 * The pool room-batch-run.mjs drives. bundle: { codeTar, helper, jars: {arm: localPath}, inputs: [{ local, name }] }.
 * The machine comes from the saved image (room-image.mjs): IMAGE/jdk, IMAGE/template-26.3, IMAGE/image.json under its home.
 */
export function boatPool({ snapshot, type = 'default', ttlSeconds = 7200, namePrefix, bundle, imageDir = 'rooms', log = console.log }) {
	let count = 0;
	return {
		async create() { return createMachine({ from: snapshot, type, ttlSeconds, name: `${namePrefix}-${++count}` }); },
		async prepare(vm) {
			const home = (await remote(vm.id, 'printf %s "$HOME"')).trim();
			const batch = path.posix.join(home, 'batch');
			await remote(vm.id, `rm -rf ${quote(batch)} && mkdir -p ${quote(batch)}/jars ${quote(batch)}/inputs ${quote(batch)}/jobs ${quote(batch)}/out ${quote(batch)}/code && test -x ${quote(path.posix.join(home, imageDir, 'jdk/bin/java'))} && test -f ${quote(path.posix.join(home, imageDir, 'template-26.3/server.jar'))} && { command -v eatmydata >/dev/null || { echo 'eatmydata is missing: rebuild the image with room-image.mjs' >&2; exit 1; }; }`);
			await upload(vm.id, bundle.codeTar, `${batch}/code.tgz`);
			await upload(vm.id, bundle.helper, `${batch}/room-batch-remote.mjs`);
			const jars = {};
			for (const [arm, local] of Object.entries(bundle.jars)) { jars[arm] = `${batch}/jars/${arm}.jar`; await upload(vm.id, local, jars[arm]); }
			const inputs = {};
			for (const input of bundle.inputs) { inputs[input.local] = `${batch}/inputs/${input.name}`; await upload(vm.id, input.local, inputs[input.local]); }
			await remote(vm.id, `tar -xzf ${quote(batch)}/code.tgz -C ${quote(batch)}/code && rm ${quote(batch)}/code.tgz && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'`);
			return { home, wrapper: ['eatmydata'], code: `${batch}/code`, out: `${batch}/out`, jobs: `${batch}/jobs`, helper: `${batch}/room-batch-remote.mjs`, jars, inputs,
				javaHome: path.posix.join(home, imageDir, 'jdk'), template: path.posix.join(home, imageDir, 'template-26.3') };
		},
		async start(vm, job) {
			const local = path.join(os.tmpdir(), `room-batch-${process.pid}-${vm.id}-${job.room}.json`);
			await writeFile(local, JSON.stringify(job, null, 2));
			const jobs = path.posix.dirname(job.outDir).replace(/\/out$/, '/jobs');
			const file = `${jobs}/${job.room}.json`;
			await upload(vm.id, local, file);
			await remote(vm.id, launchScript({ outDir: job.outDir, code: job.code, helper: path.posix.join(path.posix.dirname(jobs), 'room-batch-remote.mjs'), jobFile: file, log: `${jobs}/${job.room}.log` }));
			vm.outDir = path.posix.dirname(job.outDir);
		},
		async poll(vm, room) {
			const text = await remote(vm.id, `test -f ${quote(`${vm.outDir}/${room}/done.json`)} && echo DONE || echo RUNNING`, { timeoutMs: 120_000 });
			return /DONE/.test(text) ? 'done' : 'running';
		},
		async alive(vm) { return LIVE.has(await machineState(vm.id)); },
		async fetch(vm, room, roomsDir) {
			const archive = `${vm.outDir}/${room}.tgz`;
			// secret.txt is a throwaway per-run RCON secret; worlds are already deleted unless kept.
			await remote(vm.id, `cd ${quote(vm.outDir)} && tar --exclude=secret.txt -czf ${quote(archive)} ${quote(room)}`);
			// Unpack into a staging folder and move the room into place only once done.json reads, so a failed copy never
			// leaves rows the merge could count, and a retry never inherits an earlier attempt's files.
			await mkdir(roomsDir, { recursive: true });
			const staging = await mkdtemp(path.join(roomsDir, `.staging-${room}-`));
			try {
				const local = path.join(staging, `${room}.tgz`);
				await download(vm.id, archive, local);
				await new Promise((resolve, reject) => {
					const tar = spawn('tar', ['-xzf', local, '-C', staging], { stdio: 'inherit' });
					tar.on('error', reject);
					tar.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
				});
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
