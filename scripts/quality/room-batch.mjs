// Plays a batch of practice rooms x arms on cloud machines, split by room so both arms of a room play side by side on
// one machine, and merges each arm's rows with finishRun.
//   node scripts/quality/room-batch.mjs --commands ROOMS.txt --arm new=NEW.jar --arm old=OLD.jar --pool boat --vms N --out FRESH_DIR
//     [--code REF] [--snapshot NAME] [--type TYPE] [--room-timeout MIN] [--name PREFIX] [--dry-run]
// ROOMS.txt, one line per room (see parseCommands in lib/room-batch-core.mjs):
//   @carve-hidden-lava BUILD_ONLY=carve-hidden-lava node scripts/quality/test-build-live.mjs scripts/quality/carve-hidden-fluid-spots.json $OUT $JAR --descriptive
// The code is the commit REF (default HEAD) as git archive of the paths fixtures use (BUNDLE_PATHS in lib/boat-pool.mjs)
// plus this checkout's coordinator/node_modules. A local file named by absolute path in a line (a private spots file)
// is copied to every machine and the line points at the copy. Code, helper, jars and inputs travel as one bundle.
// --snapshot (or ROOM_BATCH_SNAPSHOT) names the saved image room-image.mjs makes; --type (or ROOM_BATCH_TYPE, default
// "default") the machine size. Output: OUT/rooms/ROOM/{ARM/,ARM.log,done.json}, OUT/ARM/result.json and
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

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: room-batch.mjs --commands ROOMS.txt --arm NAME=JAR [--arm NAME=JAR] --pool boat --vms N --out FRESH_DIR [--code REF] [--snapshot NAME] [--type TYPE] [--room-timeout MIN] [--name PREFIX] [--dry-run]';

function parseFlags(argv) {
	const flags = { arms: [] };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === '--help') flags.help = true;
		else if (flag === '--dry-run') flags.dryRun = true;
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
if ((flags.pool ?? 'boat') !== 'boat') fail('only --pool boat exists');
for (const arm of flags.arms) {
	if (!/^[A-Za-z0-9_-]+$/.test(arm.name) || !arm.jar) fail(`--arm wants NAME=JAR, got ${arm.name}=${arm.jar}`);
	if (!existsSync(arm.jar)) fail(`no jar at ${arm.jar}`);
}
if (new Set(flags.arms.map(arm => arm.name)).size !== flags.arms.length) fail('arm names repeat');
const vms = Number(flags.vms ?? 1);
if (!Number.isInteger(vms) || vms < 1 || vms > 50) fail('--vms wants 1 to 50');
const snapshot = flags.snapshot ?? process.env.ROOM_BATCH_SNAPSHOT;
const type = flags.type ?? process.env.ROOM_BATCH_TYPE ?? 'default';
const roomTimeoutMs = Number(flags.roomTimeout ?? 40) * 60_000;
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
const batch = { name: flags.name ?? `room-batch-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, code, snapshot, type, vms, roomTimeoutMs,
	arms: flags.arms.map(arm => ({ name: arm.name, jar: path.basename(arm.jar), sha256: sha256(arm.jar) })), rooms: rooms.map(room => room.room), inputs: inputs.map(input => input.name) };
console.log(`${batch.name}: ${rooms.length} rooms x ${flags.arms.length} arms, ${vms} ${type} machines from ${snapshot ?? '(no snapshot)'}, code ${code.slice(0, 8)}`);
if (flags.dryRun) { for (const room of rooms) for (const line of room.lines) console.log(`  ${room.room} [${line.arm}] ${Object.entries(line.env).map(([k, v]) => `${k}=${v}`).join(' ')} node ${line.args.join(' ')}`); process.exit(0); }
if (!snapshot) fail('--snapshot or ROOM_BATCH_SNAPSHOT names the saved image (make it with room-image.mjs)');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) fail(`${out} is not empty: use a fresh output folder`);
await writeFile(path.join(out, 'commands.txt'), await readFile(flags.commands, 'utf8'));

const work = await mkdtemp(path.join(os.tmpdir(), 'room-batch-'));
const bundle = await buildBundle({ root, ref: code, jars: Object.fromEntries(flags.arms.map(arm => [arm.name, path.resolve(arm.jar)])), inputs,
	helper: path.join(root, 'scripts/quality/lib/room-batch-remote.mjs'), work });
console.log(`bundle ${(statSync(bundle.file).size / 2 ** 20).toFixed(1)} MB (${bundle.unpack.split(' ')[0]})`);

const controller = new AbortController();
let stopping = false;
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => {
	if (stopping) return;
	stopping = true;
	console.log(`${name}: stopping, deleting every machine of this batch`);
	controller.abort();
});

const logFile = path.join(out, 'batch.log');
// A failed log write (a full disk) must never end the process before the machines are deleted.
const log = async message => { const line = `${new Date().toISOString()} ${message}`; console.log(line); await writeFile(logFile, line + '\n', { flag: 'a' }).catch(() => {}); };
const pool = boatPool({ snapshot, type, ttlSeconds: 7200, namePrefix: batch.name, bundle, log });
const began = new Date().toISOString();
try {
	const result = await runBatch({ batch, rooms, arms: flags.arms, pool, vms, out, roomTimeoutMs, log, rewrite, signal: controller.signal });
	await writeFile(path.join(out, 'batch.json'), JSON.stringify({ ...batch, began, ended: new Date().toISOString(), wallSeconds: result.wallSeconds, outcomes: result.outcomes, machines: result.machines }, null, 2) + '\n');
	await writeFile(path.join(out, 'summary.txt'), result.text + '\n');
	console.log(result.text);
	const leftover = result.machines.filter(vm => !vm.destroyed);
	if (controller.signal.aborted) process.exitCode = 130;
	if (leftover.length) { console.error(`NOT DELETED: ${leftover.map(vm => vm.id).join(', ')} (delete them with boat delete ID --yes)`); process.exitCode = 3; }
} finally { await rm(work, { recursive: true, force: true }); }
