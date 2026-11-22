// Plays every provider-free practice room REPEATS times on boat machines and scores it per room, stage and skill,
// then compares the result with a saved baseline.
//   node scripts/quality/benchmark.mjs --jar JAR --out FRESH_DIR [--rooms FILE ...] [--repeats 10] [--slots 5]
//     [--only ROOM,ROOM] [--baseline FILE] [--save-baseline FILE] [--targets ROOM,...] [room-batch flags: --code REF --machines ID,...
//     --vms N --snapshot NAME --type TYPE --room-timeout MIN --name PREFIX]
//   node scripts/quality/benchmark.mjs --score OUT [--rooms FILE ...] [--baseline FILE] [--save-baseline FILE] [--targets ROOM,...]
// --rooms (repeatable, default scripts/quality/benchmark-rooms.json) lists rooms as
//   [{ room, fixture, stage, skill, skill2, line, estMinutes, tickRate }], `line` being a room-batch command with $OUT
//   and $JAR (see scripts/quality/README.md "Room batches on boat"); a file kept outside the repository can add rooms
//   whose inputs are private. Each room plays as ceil(REPEATS / SLOTS) room-batch rooms ROOM.c1.., each with SLOTS arms
//   r1..rK on the same jar side by side on one machine, longest rooms first.
// Output: OUT/batch (room-batch's folder), OUT/plan.json, OUT/score.json (the baseline format), OUT/scoreboard.md and,
// with --baseline, OUT/comparison.txt, also printed. The comparison judges each room by its Holm-adjusted Fisher p, then
// pools the rooms: --targets names the rooms the change is meant to improve (one exact test, are they better), and every
// other room is a guard (one exact test, are they worse).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRuns, compareScores, formatComparison, formatScoreboard, groupScores, planBenchmark, scoreRooms } from './lib/benchmark-score.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'Usage: benchmark.mjs --jar JAR --out FRESH_DIR [--rooms FILE ...] [--repeats 10] [--slots 5] [--only ROOM,...] [--baseline FILE] [--save-baseline FILE] [--targets ROOM,...] [--code REF] [--machines ID,...] [--vms N] [--snapshot NAME] [--type TYPE] [--room-timeout MIN] [--name PREFIX] [--dry-run]\n       benchmark.mjs --score OUT [--rooms FILE ...] [--baseline FILE] [--save-baseline FILE] [--targets ROOM,...]';
const PASS_THROUGH = ['code', 'machines', 'vms', 'snapshot', 'type', 'roomTimeout', 'name', 'idleTtl'];

const flags = { rooms: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const flag = argv[i];
	if (flag === '--help') flags.help = true;
	else if (flag === '--dry-run') flags.dryRun = true;
	else if (flag === '--rooms') flags.rooms.push(argv[++i]);
	else if (flag.startsWith('--')) flags[flag.slice(2).replace(/-(\w)/g, (_, ch) => ch.toUpperCase())] = argv[++i];
	else { console.error(`unexpected argument ${flag}\n${USAGE}`); process.exit(2); }
}
if (flags.help) { console.log(USAGE); process.exit(0); }
const fail = message => { console.error(`${message}\n${USAGE}`); process.exit(2); };
// Rescoring without --rooms uses the definitions the run saved in plan.json, so a later edit of the default list (or a
// custom file left off) never changes a past run's verdicts.
const explicitRooms = flags.rooms.length > 0;
if (!flags.rooms.length) flags.rooms.push(path.join(root, 'scripts/quality/benchmark-rooms.json'));

let rooms = [];
for (const file of flags.rooms) {
	const list = JSON.parse(await readFile(file, 'utf8'));
	rooms.push(...(Array.isArray(list) ? list : list.rooms));
}
if (flags.only) {
	const only = new Set(flags.only.split(',').filter(Boolean));
	const unknown = [...only].filter(room => !rooms.some(item => item.room === room));
	if (unknown.length) fail(`--only names unknown rooms: ${unknown.join(', ')}`);
	rooms = rooms.filter(room => only.has(room.room));
}
const meta = Object.fromEntries(rooms.map(room => [room.room, room]));

async function score(out, plan, identity, roomMeta = meta) {
	// Read before anything is saved: --save-baseline may name the same file as --baseline.
	const baseline = flags.baseline ? JSON.parse(await readFile(flags.baseline, 'utf8')) : null;
	const runs = await collectRuns(path.join(out, 'batch'), plan, roomMeta);
	const scored = scoreRooms(runs, roomMeta);
	const result = { ...identity, repeats: plan.repeats, slots: plan.slots, rooms: scored, groups: groupScores(scored) };
	await writeFile(path.join(out, 'score.json'), JSON.stringify(result, null, 2) + '\n');
	const board = formatScoreboard(result);
	await writeFile(path.join(out, 'scoreboard.md'), board + '\n');
	console.log(board);
	if (flags.saveBaseline) { await writeFile(flags.saveBaseline, JSON.stringify(result, null, 2) + '\n'); console.log(`baseline saved to ${flags.saveBaseline}`); }
	if (baseline) {
		const text = `Against the baseline of ${String(baseline.code ?? '?').slice(0, 8)} (${baseline.repeats} repeats):\n${formatComparison(compareScores(baseline, result), { targets: (flags.targets ?? '').split(',').filter(Boolean) })}`;
		await writeFile(path.join(out, 'comparison.txt'), text + '\n');
		console.log(`\n${text}`);
	}
	return result;
}

if (flags.score) {
	const out = path.resolve(flags.score);
	const plan = JSON.parse(await readFile(path.join(out, 'plan.json'), 'utf8'));
	const batch = JSON.parse(await readFile(path.join(out, 'batch', 'batch.json'), 'utf8').catch(() => '{}'));
	const saved = !explicitRooms && Array.isArray(plan.roomDefinitions) ? Object.fromEntries(plan.roomDefinitions.map(room => [room.room, room])) : meta;
	await score(out, plan, { code: batch.code ?? plan.code ?? null, jarSha256: batch.arms?.[0]?.sha256 ?? plan.jarSha256 ?? null, began: batch.began ?? null, wallSeconds: batch.wallSeconds ?? null }, saved);
	process.exit(0);
}

if (!flags.jar || !flags.out) fail('--jar and --out are required');
if (!existsSync(flags.jar)) fail(`no jar at ${flags.jar}`);
const plan = planBenchmark(rooms, { repeats: Number(flags.repeats ?? 10), slots: Number(flags.slots ?? 5) });
const out = path.resolve(flags.out);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) fail(`${out} is not empty: use a fresh output folder`);
const jarSha256 = createHash('sha256').update(readFileSync(flags.jar)).digest('hex');
await writeFile(path.join(out, 'commands.txt'), plan.commands);
await writeFile(path.join(out, 'plan.json'), JSON.stringify({ ...plan, commands: undefined, jarSha256, rooms: rooms.map(room => room.room), roomDefinitions: rooms }, null, 2) + '\n');
console.log(`${rooms.length} rooms x ${plan.repeats} repeats = ${plan.instances.length} batch rooms x ${plan.slots} side by side`);

const batchArgs = [path.join(root, 'scripts/quality/room-batch.mjs'), '--commands', path.join(out, 'commands.txt'), '--out', path.join(out, 'batch'), '--pool', 'boat',
	...plan.arms.flatMap(arm => ['--arm', `${arm}=${path.resolve(flags.jar)}`])];
for (const key of PASS_THROUGH) if (flags[key] !== undefined) batchArgs.push(`--${key.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`, flags[key]);
if (flags.dryRun) batchArgs.push('--dry-run');
const exit = await new Promise(resolve => {
	const child = spawn(process.execPath, batchArgs, { stdio: 'inherit' });
	for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => child.kill(name));
	child.on('close', code => resolve(code));
});
if (flags.dryRun) process.exit(exit ?? 1);
const batch = JSON.parse(await readFile(path.join(out, 'batch', 'batch.json'), 'utf8').catch(() => '{}'));
await score(out, plan, { code: batch.code ?? null, jarSha256, began: batch.began ?? null, wallSeconds: batch.wallSeconds ?? null });
// room-batch's own exit says whether every machine was handled; a room that failed is in the scoreboard, not the exit code.
process.exitCode = exit === 0 || exit === 1 ? 0 : exit ?? 1;
