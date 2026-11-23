// Windows PCs for room-batch.mjs, over ssh and scp (OpenSSH on the PC, PowerShell for every remote command). One pool
// worker is one room slot of one PC: ROOM_BATCH_WINDOWS=<sshHost>:<slots>:<slotBase>,... gives each PC its slot count
// (rooms at once) and its slot base. A room plays every arm side by side, so room slot i of a PC uses one 100-port
// range per arm from 28000 + (slotBase + i * arms) * 100; a slot base moves a PC's ports clear of the TCP ranges
// Hyper-V reserves at boot, which prepare() checks against `netsh int ipv4 show excludedportrange`. A PC that must be free
// from a set time takes a cutoff after its slot base, on the clock of the machine running the batch: `@01:30` closes it
// the next time the clock shows 01:30, and `@01:30-09:00` also keeps it closed until 09:00, so a batch started at 02:00
// leaves it out. From the cutoff no room starts there, and a room still playing there is stopped and re-queued.
// The PC already holds Java 25 and the server template under ROOT (C:/aa-runs: jdk25, templates/26.3). Each PC gets the
// code, jars and inputs once per batch under ROOT/batches/BATCH, and each worker its own w<slot>/ folder for jobs and
// output. A room starts through WMI (Win32_Process.Create), so it outlives the ssh session; its PowerShell parent asks
// Windows to stay awake while the room plays. destroy() kills that room's process tree and deletes the worker's
// folder, and the PC's last worker deletes the batch folder. Nothing is installed, and no PC is ever slept or shut down.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PACK_EXCLUDES, stageRoom } from './room-batch-core.mjs';

/** The first moment after `now` at which the local clock reads hours:minutes. */
export function nextClockTime(hours, minutes, now = Date.now()) {
	const at = new Date(now);
	at.setHours(hours, minutes, 0, 0);
	if (at.getTime() <= now) at.setDate(at.getDate() + 1);
	return at.getTime();
}

/**
 * When a PC with cutoff `close` (and optional reopen time `open`, both [hours, minutes]) closes, seen from `now`: `now`
 * itself while it is inside the closed window, else the next time the clock shows `close`.
 */
export function cutoffTime(close, open = null, now = Date.now()) {
	const next = nextClockTime(close[0], close[1], now);
	if (!open) return next;
	// The window that closed last: its close one calendar day before the next one, its reopening the first time after that
	// close the clock shows `open`. Both are read off the local calendar, never a fixed number of hours, so a
	// daylight-saving change inside the window moves neither.
	const last = new Date(next); last.setDate(last.getDate() - 1);
	return now < nextClockTime(open[0], open[1], last.getTime()) ? now : next;
}

const clockTime = (host, text) => {
	const [hours, minutes] = text.split(':').map(Number);
	if (hours > 23 || minutes > 59) throw new Error(`${host}: ${text} is not a time of day`);
	return [hours, minutes];
};

/** ROOM_BATCH_WINDOWS text -> [{ host, slots, slotBase, cutoff?: 'HH:MM' or 'HH:MM-HH:MM', cutoffAt?: epoch ms }]. */
export function parseWindowsHosts(text, now = Date.now()) {
	const hosts = String(text ?? '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
		const match = /^([A-Za-z0-9._@-]+):(\d+)(?::(\d+))?(?:@(\d{1,2}:\d{2})(?:-(\d{1,2}:\d{2}))?)?$/.exec(item);
		if (!match) throw new Error(`a Windows PC is <sshHost>:<slots>:<slotBase>[@HH:MM[-HH:MM]], got ${item}`);
		const [, host, slots, slotBase = '0', close, open] = match;
		if (Number(slots) < 1 || Number(slots) > 16) throw new Error(`${host}: slots wants 1 to 16`);
		const pc = { host, slots: Number(slots), slotBase: Number(slotBase) };
		if (close === undefined) return pc;
		const closeAt = clockTime(host, close), openAt = open === undefined ? null : clockTime(host, open);
		if (openAt && openAt[0] === closeAt[0] && openAt[1] === closeAt[1]) throw new Error(`${host}: a cutoff window ${close}-${open} closes and opens at once`);
		const hhmm = ([hours, minutes]) => `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
		return { ...pc, cutoff: openAt ? `${hhmm(closeAt)}-${hhmm(openAt)}` : hhmm(closeAt), cutoffAt: cutoffTime(closeAt, openAt, now) };
	});
	if (!hosts.length) throw new Error('ROOM_BATCH_WINDOWS names no PC (<sshHost>:<slots>:<slotBase>[@HH:MM[-HH:MM]],...)');
	if (new Set(hosts.map(item => item.host)).size !== hosts.length) throw new Error('a PC appears twice in ROOM_BATCH_WINDOWS');
	return hosts;
}

/** The first port of room slot `slot` on a PC; the room's arms use one 100-port range each from there. */
export const slotPortBase = (slotBase, slot, arms) => 28000 + (slotBase + slot * arms) * 100;

/** Whether a PC is past its cutoff at `now`. */
export const pastCutoff = (pc, now = Date.now()) => pc.cutoffAt != null && now >= pc.cutoffAt;

/** The next free (host, slot) on a PC not past its cutoff, taking slot 0 of every PC before slot 1 of any, so rooms spread over the PCs. */
export function nextSlot(hosts, busy, now = Date.now()) {
	const most = Math.max(...hosts.map(item => item.slots));
	for (let slot = 0; slot < most; slot++) for (const item of hosts) if (slot < item.slots && !pastCutoff(item, now) && !busy.has(`${item.host}:${slot}`)) return { host: item.host, slot };
	return null;
}

/** Excluded TCP ranges from `netsh int ipv4 show excludedportrange protocol=tcp` that overlap from..to. */
export function portClashes(netshText, from, to) {
	return String(netshText).split(/\r?\n/).map(line => /^\s*(\d+)\s+(\d+)\b/.exec(line)).filter(Boolean)
		.map(match => [Number(match[1]), Number(match[2])]).filter(([start, end]) => start <= to && end >= from);
}

/** A forward-slash path as Windows writes it (C:/aa-runs/x -> C:\aa-runs\x), for a command line cmd or WMI reads. */
export const windowsPath = text => String(text).replace(/\//g, '\\');

/**
 * Validates a batch folder name and builds a unique per-run batch directory strictly beneath `<root>/batches`.
 * Rejects `.`, `..`, trailing dots, path separators, or anything that resolves outside the batches root.
 */
export function windowsBatchDir(root, batchName, runId = `${process.pid}-${randomBytes(4).toString('hex')}`) {
	const name = String(batchName ?? '');
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.endsWith('.') || name.includes('..')) {
		throw new Error(`batch name must start with a letter or digit, contain only letters, digits, ., _ or -, and not end with . or contain ..: ${batchName}`);
	}
	if (!/^[A-Za-z0-9_-]+$/.test(String(runId ?? ''))) throw new Error(`invalid Windows batch run id: ${runId}`);
	const batchesRoot = path.win32.resolve(windowsPath(`${root}/batches`));
	const folder = `${name}-${runId}`;
	const resolved = path.win32.resolve(batchesRoot, folder);
	const rel = path.win32.relative(batchesRoot, resolved);
	if (!rel || rel === '.' || rel.startsWith('..') || path.win32.isAbsolute(rel) || rel.includes('\\') || rel.includes('/')) {
		throw new Error(`batch directory escaped batches root: ${batchName}`);
	}
	return `${root}/batches/${folder}`;
}
const psQuote = text => `'${String(text).replace(/'/g, "''")}'`;
const encode = script => Buffer.from(script, 'utf16le').toString('base64');

function run(command, args, { timeoutMs = 10 * 60_000, label = args.at(-1) } = {}) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 2 ** 20, windowsHide: true }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${command} ${label} failed (${error.code ?? error.signal}): ${String(stderr || stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`));
			else resolve(String(stdout).replace(/\r/g, ''));
		});
	});
}
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30'];

/** A PowerShell script on the PC; resolves to its output, rejects when it throws or exits non-zero. */
export function powershell(host, script, options) {
	// The default ssh shell differs between PCs (cmd or PowerShell); an encoded command reads the same under both.
	const body = `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'\ntry {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }\nexit 0`;
	return run('ssh', [...SSH, host, `powershell -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ${encode(body)}`], { label: host, ...options });
}
const upload = (host, local, remotePath) => run('scp', ['-q', ...SSH, local, `${host}:${remotePath}`], { timeoutMs: 15 * 60_000 });
const download = (host, remotePath, local) => run('scp', ['-q', ...SSH, `${host}:${remotePath}`, local], { timeoutMs: 15 * 60_000 });

/**
 * The pool room-batch-run.mjs drives. hosts from parseWindowsHosts; bundle: { codeTar, helper, jars: {arm: localPath},
 * inputs: [{ local, name }] }; batchName names the batch folder on each PC.
 */
export function windowsPool({ hosts, batchName, bundle, root = 'C:/aa-runs', log = console.log, runPs = powershell, runUpload = upload, runDownload = download, now = Date.now }) {
	const arms = Object.keys(bundle.jars).length;
	// Windows folders ignore case: arms A and a would upload to one jar and write one output folder.
	if (new Set(Object.keys(bundle.jars).map(arm => arm.toLowerCase())).size !== arms) throw new Error('arm names must differ in more than case on Windows');
	const batchDir = windowsBatchDir(root, batchName);
	const batchesRoot = `${root}/batches`;
	const busy = new Set(), machines = new Map(hosts.map(item => [item.host, { ...item, ready: null, cleaning: null, workers: 0, claimedBatchDir: false }]));
	let count = 0;

	/**
	 * Deletes this batch's folder on the PC (retried: Windows refuses to delete files a process held a moment ago). One
	 * delete runs at a time per PC; a caller arriving while one runs shares it.
	 */
	function cleanBatchDir(pc) {
		if (!pc.cleaning) {
			const task = runPs(pc.host, `$baseFull = [System.IO.Path]::GetFullPath(${psQuote(windowsPath(batchesRoot))}).TrimEnd('\\') + '\\'
$batchFull = [System.IO.Path]::GetFullPath(${psQuote(windowsPath(batchDir))})
if (-not $batchFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) { throw "refusing to delete outside batches root: $batchFull" }
foreach ($i in 1..10) { if (-not (Test-Path -LiteralPath ${psQuote(batchDir)})) { break }; Remove-Item -Recurse -Force -LiteralPath ${psQuote(batchDir)} -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
if (Test-Path -LiteralPath ${psQuote(batchDir)}) { throw 'could not delete ${batchDir}' }`, { timeoutMs: 180_000 })
				.then(() => { pc.claimedBatchDir = false; })
				.finally(() => { if (pc.cleaning === task) pc.cleaning = null; });
			pc.cleaning = task;
		}
		return pc.cleaning;
	}

	async function prepareHost(pc, signal) {
		const stopped = () => { if (signal?.aborted) throw new Error('batch stopped'); };
		while (pc.cleaning) await pc.cleaning.catch(() => {});
		// A folder this pool claimed before (a prepare that failed after claiming it, or a cleanup that failed) is its own
		// stale copy: delete it, or the check below refuses the batch as already there.
		if (pc.claimedBatchDir) await cleanBatchDir(pc);
		const first = slotPortBase(pc.slotBase, 0, arms), last = slotPortBase(pc.slotBase, pc.slots - 1, arms) + arms * 100 - 1;
		// Owned from before the claim is sent: if the ssh drops after the PC made the folder, or a later line of the script
		// throws, the folder and its port range exist all the same. Its name carries this run's random id, so whatever is at
		// that path is this run's to delete (the delete is a no-op when nothing was made).
		pc.claimedBatchDir = true;
		const facts = JSON.parse((await runPs(pc.host, `
if (-not (Test-Path -LiteralPath ${psQuote(`${root}/jdk25/bin/java.exe`)})) { throw 'no Java at ${root}/jdk25' }
if (-not (Test-Path -LiteralPath ${psQuote(`${root}/templates/26.3/server.jar`)})) { throw 'no server template at ${root}/templates/26.3' }
New-Item -ItemType Directory -Force -Path ${psQuote(batchesRoot)} | Out-Null
$baseFull = [System.IO.Path]::GetFullPath(${psQuote(windowsPath(batchesRoot))}).TrimEnd('\\') + '\\'
$batchFull = [System.IO.Path]::GetFullPath(${psQuote(windowsPath(batchDir))})
if (-not $batchFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) { throw "batch directory escapes batches root: $batchFull" }
if (Test-Path -LiteralPath ${psQuote(batchDir)}) { throw "batch directory already exists: ${batchDir}" }
New-Item -ItemType Directory -Path ${psQuote(batchDir)} -ErrorAction Stop | Out-Null
@{ first = ${first}; last = ${last} } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path ${psQuote(batchDir)} 'ports.json')
$overlap = @(Get-ChildItem -LiteralPath ${psQuote(batchesRoot)} -Directory | Where-Object { $_.Name -ne ${psQuote(path.posix.basename(batchDir))} } | Where-Object {
	$f = Join-Path $_.FullName 'ports.json'
	if (-not (Test-Path -LiteralPath $f)) { $true } else { $r = Get-Content -Raw -LiteralPath $f | ConvertFrom-Json; $r.first -le ${last} -and $r.last -ge ${first} }
} | ForEach-Object { $_.Name })
foreach ($d in 'jars', 'inputs', 'code') { New-Item -ItemType Directory -Force -Path (Join-Path ${psQuote(batchDir)} $d) | Out-Null }
foreach ($d in 'cache', 'tmp') { New-Item -ItemType Directory -Force -Path (Join-Path ${psQuote(root)} $d) | Out-Null }
@{ overlap = $overlap; node = (Get-Command node.exe).Source; excluded = ((netsh int ipv4 show excludedportrange protocol=tcp) -join "\`n") } | ConvertTo-Json -Compress`)).trim().split('\n').at(-1));
		// Another batch process on this PC (its own pool, its own slot set) holds an overlapping port range: claim first,
		// then check, so two batches starting together both see each other and neither plays on shared ports. A folder
		// without ports.json counts as overlapping (an older runner, or one still writing it).
		const overlap = [facts.overlap ?? []].flat().filter(Boolean);
		if (overlap.length) throw new Error(`${pc.host}: ports ${first}-${last} may be in use by another batch (${overlap.join(', ')} under ${batchesRoot}); wait for it, or delete a folder a crashed batch left`);
		stopped();
		const clashes = portClashes(facts.excluded, first, last);
		if (clashes.length) throw new Error(`${pc.host}: ports ${first}-${last} overlap the reserved ranges ${clashes.map(range => range.join('-')).join(', ')}; raise its slot base`);
		await runUpload(pc.host, bundle.codeTar, `${batchDir}/code.tgz`);
		stopped();
		await runUpload(pc.host, bundle.helper, `${batchDir}/room-batch-remote.mjs`);
		const jars = {};
		for (const [arm, local] of Object.entries(bundle.jars)) { stopped(); jars[arm] = `${batchDir}/jars/${arm}.jar`; await runUpload(pc.host, local, jars[arm]); }
		const inputs = {};
		for (const input of bundle.inputs) { stopped(); inputs[input.local] = `${batchDir}/inputs/${input.name}`; await runUpload(pc.host, input.local, inputs[input.local]); }
		stopped();
		await runPs(pc.host, `
Set-Location -LiteralPath ${psQuote(`${batchDir}/code`)}
tar -xzf ../code.tgz; if ($LASTEXITCODE -ne 0) { throw "tar exited $LASTEXITCODE" }
Remove-Item -LiteralPath ../code.tgz
$major = [int]((& ${psQuote(facts.node)} -p 'process.versions.node') -split '\\.')[0]; if ($major -lt 22) { throw "node $major is older than 22" }`);
		log(`${pc.host}: code, ${arms} jars and ${bundle.inputs.length} inputs in place; ports ${first}-${last} clear`);
		return { node: facts.node, jars, inputs };
	}

	async function prepareWorker(vm, signal) {
		const pc = machines.get(vm.host);
		pc.ready ??= prepareHost(pc, signal).catch(error => { pc.ready = null; throw error; });
		const shared = await pc.ready;
		if (signal?.aborted) throw new Error('batch stopped');
		const dir = `${batchDir}/w${vm.slot}`;
		await runPs(vm.host, `
if (Test-Path -LiteralPath ${psQuote(dir)}) { Remove-Item -Recurse -Force -LiteralPath ${psQuote(dir)} }
foreach ($d in 'jobs', 'out') { New-Item -ItemType Directory -Force -Path (Join-Path ${psQuote(dir)} $d) | Out-Null }`);
		vm.dir = dir;
		vm.layout = { wrapper: [], node: shared.node, code: `${batchDir}/code`, out: `${dir}/out`, jobs: `${dir}/jobs`, helper: `${batchDir}/room-batch-remote.mjs`,
			jars: shared.jars, inputs: shared.inputs, javaHome: `${root}/jdk25`, template: `${root}/templates/26.3`, portBase: slotPortBase(pc.slotBase, vm.slot, arms),
			env: { ARENA_FIXTURE_CACHE: `${root}/cache`, TEMP: windowsPath(`${root}/tmp`), TMP: windowsPath(`${root}/tmp`) } };
		return vm.layout;
	}

	async function startRoom(vm, job, closed) {
		if (closed()) throw new Error('past its cutoff');
		const { layout } = vm;
		const local = path.join(os.tmpdir(), `room-batch-${process.pid}-${vm.id}-${job.room}.json`);
		await writeFile(local, JSON.stringify(job, null, 2));
		const file = `${layout.jobs}/${job.room}.json`;
		try { await runUpload(vm.host, local, file); } finally { await rm(local, { force: true }); }
		// The upload can outlast the cutoff: past it, the room never launches.
		if (closed()) throw new Error('past its cutoff');
		// The room's parent holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED while it plays, so an idle PC does not sleep.
		const launch = `Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[W.P]::SetThreadExecutionState([uint32]2147483649) | Out-Null
$p = Start-Process -FilePath ${psQuote(layout.node)} -ArgumentList '"${windowsPath(layout.helper)}"', '"${windowsPath(file)}"' -WorkingDirectory ${psQuote(windowsPath(layout.code))} -NoNewWindow -PassThru -Wait -RedirectStandardOutput ${psQuote(`${layout.jobs}/${job.room}.log`)} -RedirectStandardError ${psQuote(`${layout.jobs}/${job.room}.err`)}
exit $p.ExitCode`;
		// The launch goes up as a .ps1 beside the job and runs with -File. Encoded inline it was encoded twice (once for
		// WMI, once for ssh), about 7 times its length: a long room name passed cmd.exe's 8191-character line limit
		// ("The command line is too long", build-material-planks-pillar-1001).
		const launchLocal = path.join(os.tmpdir(), `room-batch-${process.pid}-${vm.id}-${job.room}.ps1`);
		await writeFile(launchLocal, `\ufeff${launch}`, 'utf8');
		const launchFile = `${layout.jobs}/${job.room}.ps1`;
		try { await runUpload(vm.host, launchLocal, launchFile); } finally { await rm(launchLocal, { force: true }); }
		if (closed()) throw new Error('past its cutoff');
		const text = await runPs(vm.host, `
if (Test-Path -LiteralPath ${psQuote(job.outDir)}) { Remove-Item -Recurse -Force -LiteralPath ${psQuote(job.outDir)} }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${windowsPath(launchFile)}"'; CurrentDirectory = ${psQuote(windowsPath(layout.code))} }
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($r.ProcessId)"
"pid=$($r.ProcessId) born=$(if ($p) { $p.CreationDate.ToFileTimeUtc() } else { 0 })"`);
		vm.pid = Number(/pid=(\d+)/.exec(text)?.[1]);
		vm.born = /born=(\d+)/.exec(text)?.[1] ?? '0';
		vm.outDir = layout.out;
	}

	return {
		async create() {
			const free = nextSlot(hosts, busy, now());
			if (!free) throw new Error(hosts.every(item => pastCutoff(item, now())) ? 'every Windows PC is past its cutoff' : 'every Windows slot is taken (or its PC is past its cutoff)');
			busy.add(`${free.host}:${free.slot}`);
			machines.get(free.host).workers++;
			// A fresh id per create, so a re-queued room never lands on a slot id it already failed on.
			return { id: `${free.host}-s${free.slot}-${++count}`, host: free.host, slot: free.slot };
		},
		prepare(vm, { signal } = {}) {
			// destroy() waits for this to settle: the runner stops waiting on Ctrl-C, and a prepare still running after the
			// cleanup would upload and make folders nobody deletes.
			vm.preparing = prepareWorker(vm, signal);
			return vm.preparing;
		},
		start(vm, job, { closed = () => false } = {}) {
			// destroy() waits for this: a cutoff that retires the slot mid-start must not race a launch that comes after it.
			vm.starting = startRoom(vm, job, closed);
			return vm.starting;
		},
		async poll(vm, room) {
			const text = await runPs(vm.host, `if (Test-Path -LiteralPath ${psQuote(`${vm.outDir}/${room}/done.json`)}) { 'DONE' } else { 'RUNNING' }`, { timeoutMs: 120_000 });
			return /DONE/.test(text) ? 'done' : 'running';
		},
		// Let SSH errors propagate so the runner keeps its silence grace period instead of treating a hiccup as a dead PC.
		async alive(vm) { return /ok/.test(await runPs(vm.host, `'ok'`, { timeoutMs: 60_000 })) ? true : null; },
		async fetch(vm, room, roomsDir) {
			await runPs(vm.host, `Set-Location -LiteralPath ${psQuote(vm.outDir)}; tar ${PACK_EXCLUDES.map(item => `--exclude=${psQuote(item)}`).join(' ')} -czf ${psQuote(`${room}.tgz`)} ${psQuote(room)}; if ($LASTEXITCODE -ne 0) { throw "tar exited $LASTEXITCODE" }`);
			return stageRoom({ roomsDir, room, download: local => runDownload(vm.host, `${vm.outDir}/${room}.tgz`, local) });
		},
		async keepAlive() {},
		// runBatch starts no room on this worker from then on, and stops and re-queues the one it plays.
		closesAt: vm => machines.get(vm.host).cutoffAt ?? null,
		usage: vm => ({ host: vm.host, slot: vm.slot, portBase: vm.layout?.portBase ?? null }),
		async destroy(vm) {
			const pc = machines.get(vm.host);
			if (vm.preparing) await vm.preparing.catch(() => {});
			if (vm.starting) await vm.starting.catch(() => {});
			const dir = vm.dir ?? `${batchDir}/w${vm.slot}`;
			// Kill the room's tree first, then anything still running from this worker's folder (trailing separator avoids w1 matching w10),
			// then delete the folder (retried: Windows refuses to delete files a process held a moment ago). Windows reuses a pid
			// once its process exits, so the tree is killed only while that pid still has the room parent's start time.
			if (!vm.dirCleaned) {
				await runPs(vm.host, `
${vm.pid ? `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${vm.pid}"
if ($p -and $p.CreationDate.ToFileTimeUtc() -eq ${vm.born}) { try { & taskkill /T /F /PID ${vm.pid} 2>&1 | Out-Null } catch {} }` : ''}
$mark = @(${psQuote(`${dir}/`)}, ${psQuote(`${windowsPath(dir)}\\`)})
Get-CimInstance Win32_Process | Where-Object { $c = $_.CommandLine; $c -and ($mark | Where-Object { $c.Contains($_) }) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($i in 1..10) { if (-not (Test-Path -LiteralPath ${psQuote(dir)})) { break }; Remove-Item -Recurse -Force -LiteralPath ${psQuote(dir)} -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
if (Test-Path -LiteralPath ${psQuote(dir)}) { throw 'could not delete ${dir}' }`, { timeoutMs: 180_000 });
				vm.dirCleaned = true;
			}
			if (!vm.slotReleased) {
				vm.slotReleased = true;
				busy.delete(`${vm.host}:${vm.slot}`);
				pc.workers--;
			}
			if (pc.workers === 0) {
				pc.ready = null;
				if (pc.claimedBatchDir) await cleanBatchDir(pc);
			}
		},
	};
}
