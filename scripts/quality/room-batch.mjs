// Plays a batch of practice rooms x arms on cloud machines or Windows PCs, split by room so both arms of a room play side
// by side on one machine, and merges each arm's rows with finishRun.
//   node scripts/quality/room-batch.mjs --commands ROOMS.txt --arm new=NEW.jar --arm old=OLD.jar --pool boat|windows --vms N --out FRESH_DIR
//     [--code REF] [--snapshot NAME] [--type TYPE] [--room-timeout MIN] [--name PREFIX] [--dry-run]
// ROOMS.txt, one line per room (see parseCommands in lib/room-batch-core.mjs):
//   @carve-hidden-lava BUILD_ONLY=carve-hidden-lava node scripts/quality/test-build-live.mjs scripts/quality/carve-hidden-fluid-spots.json $OUT $JAR --descriptive
// The code is the commit REF (default HEAD) as git archive of the paths fixtures use (BUNDLE_PATHS in lib/boat-pool.mjs)
// plus this checkout's coordinator/node_modules. A local file named by absolute path in a line (a private spots file)
// is copied to every machine and the line points at the copy. Code, helper, jars and inputs travel as one bundle.
// --snapshot (or ROOM_BATCH_SNAPSHOT) names the saved image room-image.mjs makes; --type (or ROOM_BATCH_TYPE, default
// "default") the machine size. Boat machines come from this computer's warm pool (lib/boat-warm.mjs; see the pool with
// scripts/quality/boat-pool.mjs status): free running machines of the same image and size are leased with no boat start,
// only a shortfall is created (paced under the sandbox start rate limits), and every healthy machine goes back to the
// pool running when the batch is done with it, for --idle-ttl minutes (ROOM_BATCH_IDLE_TTL_MIN, default 1440: a day).
// --machines ID,ID,... (or ROOM_BATCH_MACHINES) uses exactly those running machines instead, made from the image: each is
// leased so no other batch takes it at once, cleaned the same way, and given back running; none is created or deleted.
// --ephemeral (or --no-reuse) makes throwaway machines and deletes them, as before. --pool windows plays on the PCs
// ROOM_BATCH_WINDOWS names (<sshHost>:<slots>:<slotBase>[@HH:MM[-HH:MM]],...; see lib/windows-pool.mjs), one room per
// slot; @HH:MM[-HH:MM] is a PC's cutoff (and reopen time) on this machine's clock; --vms defaults to every slot.
// Output: OUT/rooms/ROOM/{ARM/,ARM.log,done.json}, OUT/ARM/result.json and
// result-summary.json from finishRun, OUT/batch.json (identity, outcomes, machine usage) and OUT/summary.txt.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommands } from './lib/room-batch-core.mjs';
import { runBatch } from './lib/room-batch-run.mjs';
import { boatPool, buildBundle } from './lib/boat-pool.mjs';
import { warmBoatPool } from './lib/boat-warm.mjs';
import { parseWindowsHosts, windowsPool } from './lib/windows-pool.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: room-batch.mjs --commands ROOMS.txt --arm NAME=JAR [--arm NAME=JAR] --pool boat|windows --vms N --out FRESH_DIR [--code REF] [--snapshot NAME] [--type TYPE] [--room-timeout MIN] [--name PREFIX] [--idle-ttl MIN] [--machines ID,...] [--ephemeral] [--dry-run]';

function parseFlags(argv) {
	const flags = { arms: [] };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === '--help') flags.help = true;
		else if (flag === '--dry-run') flags.dryRun = true;
		else if (flag === '--ephemeral' || flag === '--no-reuse') flags.ephemeral = true;
		else if (flag === '--arm') { const [name, ...jar] = String(argv[++i] ?? '').split('='); flags.arms.push({ name, jar: jar.join('=') }); }
		else if (flag.startsWith('--')) flags[flag.slice(2).replace(/-(\w)/g, (_, ch) => ch.toUpperCase())] = argv[++i];
		else throw new Error(`unexpected argument ${flag}`);
	}
	return flags;
}

const flags = parseFlags(process.argv.slice(2));
if (flags.help) { console.log(USAGE); process.exit(0); }
const fail = message => { console.error(`${message}\n${USAGE}`); process.exit(2); };
if (!flags.commands || !flags.out || !flags.arms.length) fail('--commands, --out and at least one --arm are required');
const poolName = flags.pool ?? 'boat';
if (!['boat', 'windows'].includes(poolName)) fail('--pool is boat or windows');
let windowsHosts = null;
if (poolName === 'windows') { try { windowsHosts = parseWindowsHosts(process.env.ROOM_BATCH_WINDOWS); } catch (error) { fail(error.message); } }
const slotCount = windowsHosts ? windowsHosts.reduce((total, item) => total + item.slots, 0) : 50;
for (const arm of flags.arms) {
	if (!/^[A-Za-z0-9_-]+$/.test(arm.name) || !arm.jar) fail(`--arm wants NAME=JAR, got ${arm.name}=${arm.jar}`);
	if (!existsSync(arm.jar)) fail(`no jar at ${arm.jar}`);
}
// Compared ignoring case: Windows folders do, so arms A and a would share one jar and one output folder.
if (new Set(flags.arms.map(arm => arm.name.toLowerCase())).size !== flags.arms.length) fail('arm names repeat (ignoring case)');
const machines = String(flags.machines ?? process.env.ROOM_BATCH_MACHINES ?? '').split(',').map(item => item.trim()).filter(Boolean);
if (machines.some(item => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item))) fail('--machines wants sandbox ids separated by commas');
if (machines.length && (flags.ephemeral || windowsHosts)) fail('--machines goes with neither --ephemeral nor --pool windows');
const vmCap = windowsHosts ? slotCount : 200;
const vms = Number(flags.vms ?? (windowsHosts ? slotCount : machines.length || 1));
if (!Number.isInteger(vms) || vms < 1 || vms > vmCap) fail(`--vms wants 1 to ${vmCap}`);
if (machines.length && vms > machines.length) fail(`--vms ${vms} is more than the ${machines.length} machines named with --machines`);
const warmPool = !windowsHosts && !flags.ephemeral;
const snapshot = flags.snapshot ?? process.env.ROOM_BATCH_SNAPSHOT;
const type = flags.type ?? process.env.ROOM_BATCH_TYPE ?? 'default';
const roomTimeoutMs = Number(flags.roomTimeout ?? 40) * 60_000;
const idleTtlMinutes = Number(flags.idleTtl ?? process.env.ROOM_BATCH_IDLE_TTL_MIN ?? 1440);
if (!Number.isFinite(idleTtlMinutes) || idleTtlMinutes < 5 || idleTtlMinutes > 30 * 24 * 60) fail('--idle-ttl wants 5 to 43200 minutes');
const startsPerMinute = Number(process.env.ROOM_BATCH_STARTS_PER_MINUTE ?? 20);
const rooms = parseCommands(await readFile(flags.commands, 'utf8'), flags.arms.map(arm => arm.name));
const out = path.resolve(flags.out);

// Local files a line names by absolute path travel with the batch; repository paths resolve inside the code root.
const inputs = [];
for (const room of rooms) for (const line of room.lines) for (const value of [...line.args, ...Object.values(line.env)]) {
	if (path.isAbsolute(value) && existsSync(value) && statSync(value).isFile() && !inputs.some(input => input.local === value)) inputs.push({ local: value, name: `${inputs.length + 1}-${path.basename(value)}` });
}
const rewrite = (value, layout) => layout.inputs[value] ?? value;

const code = execFileSync('git', ['-C', root, 'rev-parse', flags.code ?? 'HEAD'], { encoding: 'utf8' }).trim();
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const batch = { name: flags.name ?? `room-batch-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, pool: poolName, code, snapshot: windowsHosts ? null : snapshot, type: windowsHosts ? null : type, vms, roomTimeoutMs, warmPool,
	arms: flags.arms.map(arm => ({ name: arm.name, jar: path.basename(arm.jar), sha256: sha256(arm.jar) })), rooms: rooms.map(room => room.room), inputs: inputs.map(input => input.name) };
const where = windowsHosts ? `${vms} room slots on ${windowsHosts.length} Windows PCs` : `${vms} ${type} machines from ${snapshot ?? '(no snapshot)'}`;
console.log(`${batch.name}: ${rooms.length} rooms x ${flags.arms.length} arms, ${where}, code ${code.slice(0, 8)}`);
for (const pc of windowsHosts ?? []) if (pc.cutoffAt != null) console.log(pc.cutoffAt <= Date.now() ? `${pc.host}: inside its closed window ${pc.cutoff}, so it plays no room in this batch` : `${pc.host}: no room starts after ${new Date(pc.cutoffAt).toString().slice(0, 21)} (cutoff ${pc.cutoff}, in ${Math.round((pc.cutoffAt - Date.now()) / 60_000)} min); a room still playing there then is stopped and re-queued on another PC`);
if (flags.dryRun) { for (const room of rooms) for (const line of room.lines) console.log(`  ${room.room} [${line.arm}] ${Object.entries(line.env).map(([k, v]) => `${k}=${v}`).join(' ')} node ${line.args.join(' ')}`); process.exit(0); }
if (!windowsHosts && !snapshot && !machines.length) fail('--snapshot or ROOM_BATCH_SNAPSHOT names the saved image (make it with room-image.mjs)');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) fail(`${out} is not empty: use a fresh output folder`);
await writeFile(path.join(out, 'commands.txt'), await readFile(flags.commands, 'utf8'));

const work = await mkdtemp(path.join(os.tmpdir(), 'room-batch-'));
const jars = Object.fromEntries(flags.arms.map(arm => [arm.name, path.resolve(arm.jar)]));
const helper = path.join(root, 'scripts/quality/lib/room-batch-remote.mjs');
let bundle;
if (windowsHosts) {
	// A Windows PC unpacks with its own tar, which has no zstd: the code goes up as a gzip tar, the helper, jars and inputs
	// as their own files (windows-pool.mjs).
	const codeTar = path.join(work, 'code.tar');
	execFileSync('git', ['-C', root, 'archive', '--format=tar', '-o', codeTar, code]);
	execFileSync('tar', ['-C', root, '-rf', codeTar, 'coordinator/node_modules']);
	execFileSync('gzip', ['-1', codeTar]);
	bundle = { codeTar: `${codeTar}.gz`, helper, jars, inputs };
	console.log(`code ${(statSync(bundle.codeTar).size / 2 ** 20).toFixed(1)} MB (gzip)`);
} else {
	bundle = await buildBundle({ root, ref: code, jars, inputs, helper, work });
	console.log(`bundle ${(statSync(bundle.file).size / 2 ** 20).toFixed(1)} MB (${bundle.unpack.split(' ')[0]})`);
}

const controller = new AbortController();
let stopping = false;
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => {
	if (stopping) return;
	stopping = true;
	console.log(`${name}: stopping, ${windowsHosts ? 'killing every room of this batch' : warmPool ? 'killing every room and giving the machines back to the warm pool' : 'deleting every machine of this batch'}`);
	controller.abort();
});

const logFile = path.join(out, 'batch.log');
// A failed log write (a full disk) must never end the process before the machines are deleted.
const log = async message => { const line = `${new Date().toISOString()} ${message}`; console.log(line); await writeFile(logFile, line + '\n', { flag: 'a' }).catch(() => {}); };
const pool = windowsHosts ? windowsPool({ hosts: windowsHosts, batchName: batch.name, bundle, log })
	: warmPool ? warmBoatPool({ snapshot, type, ttlSeconds: 7200, idleTtlSeconds: Math.round(idleTtlMinutes * 60), startsPerMinute, machines: machines.length ? machines : null, batch: batch.name, bundle, log })
	: boatPool({ snapshot, type, ttlSeconds: 7200, namePrefix: batch.name, bundle, log });
const began = new Date().toISOString();
try {
	// The boat poll waits for the room's end itself; a Windows poll answers at once, so it gets a pause between asks.
	const result = await runBatch({ batch, rooms, arms: flags.arms, pool, vms, out, roomTimeoutMs, log, rewrite, signal: controller.signal, ...(windowsHosts ? { pollMs: 10_000 } : {}) });
	await writeFile(path.join(out, 'batch.json'), JSON.stringify({ ...batch, began, ended: new Date().toISOString(), wallSeconds: result.wallSeconds, outcomes: result.outcomes, machines: result.machines }, null, 2) + '\n');
	await writeFile(path.join(out, 'summary.txt'), result.text + '\n');
	console.log(result.text);
	const leftover = result.machines.filter(vm => !vm.destroyed && !vm.returned);
	const reused = result.machines.filter(vm => vm.reused).length;
	if (warmPool) console.log(`machines: ${reused} reused from the warm pool, ${result.machines.length - reused} started; ${result.machines.filter(vm => vm.returned).length} back in the pool, ${result.machines.filter(vm => vm.destroyed).length} deleted`);
	if (controller.signal.aborted) process.exitCode = 130;
	if (leftover.length) { console.error(`NOT DELETED: ${leftover.map(vm => vm.id).join(', ')} (${windowsHosts ? `kill its room and delete C:/aa-runs/batches/${batch.name} on that PC` : 'delete them with boat delete ID --yes'})`); process.exitCode = 3; }
} finally { await rm(work, { recursive: true, force: true }); }
