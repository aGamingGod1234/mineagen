// Plays real-model games from save points on boat machines, one game per machine, and scores each from its long-run.json.
//   node scripts/quality/checkpoint-batch.mjs --plan PLAN.json --out FRESH_DIR [--dry-run]
//   node scripts/quality/checkpoint-batch.mjs --score OUT_DIR        (rescore the games already copied back)
//   touch OUT_DIR/STOP                                               (start no new game; running games finish)
// PLAN.json (paths absolute; keep it outside the checkout, since it names the sign-in folder):
//   { "minutes": 90, "deadline": "2026-11-22T01:00:00+08:00", "model": "gpt-6.2-sol", "effort": "low",
//     "codexHomes": ["/folder/holding/auth.json", "/another/sign-in"] (or one "codexHome"), "snapshot": "mineagen-rooms-263", "type": "default",
//     "vms": ["bx_..."], "create": 4, "spares": 2, "name": "ckpt-night",
//     "arms": { "main": { "root": "/checkout", "ref": "COMMIT", "jar": "/main.jar", "env": {} }, "int": { ... } },
//     "meter": { "command": "prints the percent of the Codex allowance left", "floorPercent": 10 },
//     "copyConcurrency": 8 (games copied home at once), "drain": "delete" (delete every machine, listed ones too, once it has no further game),
//     "savepoints": { "nether": { "file": "/sp/9-nether-entry-123456789-v2.json", "repeats": 4, "targets": ["fortress", "blaze_rod"], "arms": ["main", "int"] } } }  (arms optional: default all)
// Each arm is `git archive REF` of its root plus that root's coordinator/node_modules, and its jar. Every repeat of a
// save point draws one loot salt that all arms share (lib/checkpoint-batch-core.mjs). A game runs scripts/quality/run-long.mjs
// --checkpoint under eatmydata (boat disks sync slowly; see lib/boat-pool.mjs) with the Codex provider, the observer cap in
// log mode and the arm's env. Listed machines (vms) are kept for reuse, since boat starts are scarce; machines the batch
// created (create, spares) are deleted when it ends, and with drain "delete" every machine is deleted as soon as it has no
// further game, because an idle machine bills in full. A created machine has a boat deadline (--ttl) that each pass
// pushes back while the batch runs, so a runner that dies (SIGKILL, a reboot) leaves no machine billing for long.
// Listed machines must not be warm-pool members (rbpool-*): the pool and its guard lease, wipe and delete those by name. Finished games are copied home in parallel and checked by sha. The sign-in is copied to each machine, checked against its source
// hash after every game (a changed hash means Codex refreshed it there, which can sign out the source machine, so no new
// game starts), kept out of every copy-back, and removed from every machine when the batch ends.
// Output: OUT/games/ID/{run.log,done,report/long-run.json,game.tgz (everything, raw journals under raw/)}, OUT/state.json, OUT/summary.json, OUT/summary.txt, OUT/batch.log.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { boat, createMachine, destroyMachine, download, extendMachine, installCodex, machineState, quote, remote, removeCodexSignIn, upload, waitHydrated } from './lib/boat-pool.mjs';
import { readArtifactReport } from '../../coordinator/src/benchmark/report-artifacts.mjs';
import { canStart, codexHomes, expandPlan, loseGame, nextGame, scoreGame, summarize, summaryText } from './lib/checkpoint-batch-core.mjs';

const USAGE = 'Usage: checkpoint-batch.mjs --plan PLAN.json --out FRESH_DIR [--dry-run] | --score OUT_DIR';
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help') || (!flag('score') && (!flag('plan') || !flag('out')))) { console.log(USAGE); process.exit(args.includes('--help') ? 0 : 2); }

// CHECKPOINT_POLL_MS shortens the pass for the fake-boat test (coordinator/test/checkpoint-batch-loop.test.mjs).
const POLL_MS = Number(process.env.CHECKPOINT_POLL_MS ?? 60_000), LOST_AFTER_MS = 5 * 60_000, LIVE = new Set(['provisioned', 'cloning', 'ready', 'idle', 'running']);
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
// Local copy failures of one game (a full disk) are retried each pass; past this many the game scores unknown and the
// machine is let go, so the batch can always end.
const MAX_LOCAL_COPY_FAILURES = 30;
// Every pass, at most this often, a created machine's boat deadline is set again to TTL from now.
const EXTEND_EVERY_MS = 10 * 60_000;

if (flag('score')) {
	const out = path.resolve(flag('score'));
	const state = JSON.parse(await readFile(path.join(out, 'state.json'), 'utf8'));
	for (const game of state.games) game.score = await scoreFrom(out, game, state.plan);
	await writeSummary(out, state);
	console.log(await readFile(path.join(out, 'summary.txt'), 'utf8'));
	process.exit(0);
}

const plan = JSON.parse(await readFile(path.resolve(flag('plan')), 'utf8'));
const out = path.resolve(flag('out'));
const games = expandPlan(plan);
// Each game gets its sign-in copied to its machine just before it starts (game.account picks it; see expandPlan).
const authFiles = codexHomes(plan).map(home => path.join(home, 'auth.json'));
for (const file of authFiles) if (!existsSync(file)) throw new Error(`no Codex sign-in at ${file}`);
const authFile = authFiles[0];
for (const [name, point] of Object.entries(plan.savepoints)) if (!existsSync(point.file)) throw new Error(`save point ${name}: no file ${point.file}`);
for (const [name, arm] of Object.entries(plan.arms)) {
	if (!existsSync(arm.jar)) throw new Error(`arm ${name}: no jar ${arm.jar}`);
	if (!existsSync(path.join(arm.root, 'coordinator/node_modules'))) throw new Error(`arm ${name}: ${arm.root} has no coordinator/node_modules`);
	execFileSync('git', ['-C', arm.root, 'cat-file', '-e', `${arm.ref}^{commit}`]);
}
if (/^rbpool/.test(plan.name ?? '')) throw new Error('plan.name must not start with rbpool: the warm-pool guard deletes unleased rbpool machines');
if (args.includes('--dry-run')) {
	for (const g of games) console.log(`${g.id} salt ${g.salt} sign-in ${g.account + 1}`);
	console.log(`${games.length} games, ${plan.minutes} min each, last start ${new Date(Date.parse(plan.deadline) - (plan.minutes + 10) * 60_000).toISOString()}`);
	process.exit(0);
}
for (const id of plan.vms ?? []) {
	const name = JSON.parse(await boat(['info', id, '--json'], { timeoutMs: 60_000 })).sandbox?.name ?? '';
	if (/^rbpool-/.test(name)) throw new Error(`${id} is a warm-pool machine (${name}): the pool can wipe or delete it mid-game, so list machines outside the pool`);
}
if (existsSync(out) && (await readdir(out)).length) throw new Error(`${out} is not empty: use a fresh folder`);
await mkdir(path.join(out, 'games'), { recursive: true });
await mkdir(path.join(out, 'pkg'), { recursive: true });
const log = async line => { const text = `${new Date().toISOString()} ${line}`; console.log(text); await appendFile(path.join(out, 'batch.log'), `${text}\n`).catch(() => {}); };
const authShas = authFiles.map(sha), authSha = authShas[0];
const codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim().split(/\s+/).pop();

// Package each arm once.
const pkgs = {};
for (const [name, arm] of Object.entries(plan.arms)) {
	const tarFile = path.join(out, 'pkg', `${name}.tar`);
	execFileSync('git', ['-C', arm.root, 'archive', '--format=tar', `--prefix=${name}/`, '-o', tarFile, arm.ref]);
	execFileSync('tar', ['-C', arm.root, '-rf', tarFile, `--transform=s,^coordinator,${name}/coordinator,`, 'coordinator/node_modules']);
	execFileSync('gzip', ['-f', tarFile]);
	pkgs[name] = { tar: `${tarFile}.gz`, jarSha256: sha(arm.jar), commit: execFileSync('git', ['-C', arm.root, 'rev-parse', arm.ref], { encoding: 'utf8' }).trim() };
}
const gameScript = path.join(out, 'pkg', 'game.sh');
await writeFile(gameScript, `#!/bin/bash
# game.sh ID ARM SAVEPOINT_FILE MINUTES SALT MODEL EFFORT: one game on this machine; writes ~/ck/games/ID/done when it ends.
id=$1 arm=$2 sp=$3 mins=$4 salt=$5 model=$6 effort=$7
dir=$HOME/ck/games/$id; mkdir -p "$dir"
unset OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY CODEX_HOME
while IFS='=' read -r key value; do [ -n "$key" ] && export "$key=$value"; done < "$HOME/ck/arms/$arm/env"
export PATH=$HOME/.local/bin:$PATH JAVA_HOME=$HOME/rooms/jdk ARENA_HEADLESS_SERVER_TEMPLATE=$HOME/rooms/template-26.3
cd "$HOME/ck/arms/$arm/$arm" || exit 1
eatmydata node scripts/quality/run-long.mjs --provider codex --model "$model" --effort "$effort" --service-tier default \\
  --codex-observer-cap yes --spend-cap-mode log --checkpoint "$sp" --random-salt "$salt" --budget-minutes "$mins" --max-total-cost-usd 100 \\
  --ledger "$dir/ledger.json" --port-base 26900 --jar "$HOME/ck/arms/$arm/mod.jar" --coordinator-root "$HOME/ck/arms/$arm/$arm" \\
  --java "$HOME/rooms/jdk/bin/java" --server-template "$HOME/rooms/template-26.3" --out "$dir/report" > "$dir/run.log" 2>&1 < /dev/null
echo "exit $? $(date -Is)" > "$dir/done"
`);

// The meter command prints the percent of the sign-in's allowance left. Below the floor no new game starts; a reading
// that fails or is not a number is logged and does not stop the batch, since the batch cannot read the meter itself.
let meterAt = 0, meterLow = false;
async function meterOk() {
	if (!plan.meter || Date.now() - meterAt < 5 * 60_000) return !meterLow;
	meterAt = Date.now();
	try {
		const left = Number(execFileSync('bash', ['-c', plan.meter.command], { encoding: 'utf8', timeout: 60_000 }).trim().split(/\s+/).pop());
		if (!Number.isFinite(left)) throw new Error('not a number');
		if (left < plan.meter.floorPercent && !meterLow) await log(`meter ${left}% left, below the ${plan.meter.floorPercent}% floor: no new game starts`);
		meterLow = left < plan.meter.floorPercent;
		state.meter = { left, at: new Date().toISOString() };
	} catch (error) { await log(`meter unreadable: ${error.message.split('\n')[0].slice(0, 200)}`); }
	return !meterLow;
}

const state = { plan: { ...plan, codexHome: '(private)', codexHomes: authFiles.map((_, i) => `(private sign-in ${i + 1})`) }, startedAt: new Date().toISOString(), codexVersion, arms: pkgs, games, machines: [] };
const save = async () => { await writeFile(path.join(out, 'state.json.tmp'), JSON.stringify(state, null, 2)); await rename(path.join(out, 'state.json.tmp'), path.join(out, 'state.json')); };
let created = 0, spares = plan.spares ?? 0, stopped = false, aborted = false, signInChanged = false;
// The first signal starts no new game and lets running ones finish; a second ends the running games and goes straight
// to the cleanup (sign-ins off, created machines deleted). A hang-up counts as a signal too.
const onSignal = () => { if (stopped) aborted = true; stopped = true; };
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
// A created machine's boat deadline: the whole game window plus an hour for setup and copy-back, at least 2 hours.
const TTL_SECONDS = Math.max(2 * 3600, (plan.minutes + 60) * 60);
async function destroyWithRetry(id, tries = 3) {
	for (let i = 1; ; i++) {
		try { return await destroyMachine(id); }
		catch (error) { if (i >= tries) throw error; await log(`delete of ${id} failed (try ${i} of ${tries}): ${error.message.split('\n')[0].slice(0, 200)}`); await new Promise(r => setTimeout(r, 5_000)); }
	}
}
// Ends every game session on a machine (game.sh and the run it started), first politely, then by force.
const stopGamesScript = `sids=$(for p in $(pgrep -f 'ck/game.sh '); do ps -o sid= -p "$p"; done | tr -d ' ' | sort -u)
for s in $sids; do pkill -TERM -s "$s"; done; for i in $(seq 1 30); do [ -z "$(pgrep -f 'ck/game.sh ')" ] && break; sleep 2; done
for s in $sids; do pkill -KILL -s "$s"; done; true`;

// OUT/MAX_RUNNING holds a number: no new game starts while that many are running (lowers concurrency without a restart).
function underCap() {
	let cap;
	try { cap = Number(readFileSync(path.join(out, 'MAX_RUNNING'), 'utf8').trim()); } catch { return true; }
	return !Number.isFinite(cap) || games.filter(g => g.state === 'running').length < cap;
}

async function prepare(vm) {
	await remote(vm.id, 'set -e; mkdir -p ~/ck/arms ~/ck/sp ~/ck/games; command -v eatmydata >/dev/null; test -x ~/rooms/jdk/bin/java');
	const hash = await installCodex(vm.id, { authFile, version: codexVersion });
	if (hash !== authSha) throw new Error(`sign-in copy on ${vm.id} does not match its source`);
	for (const [name, pkg] of Object.entries(pkgs)) {
		await upload(vm.id, pkg.tar, `ck/arms/${name}.tar.gz`);
		await upload(vm.id, plan.arms[name].jar, `ck/arms/${name}.jar`);
		const env = Object.entries(plan.arms[name].env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
		await remote(vm.id, `set -e; cd ~/ck/arms; rm -rf ${name}; mkdir -p ${name}; tar -xzf ${name}.tar.gz -C ${name}; mv ${name}.jar ${name}/mod.jar; rm ${name}.tar.gz; printf '%s\\n' ${quote(env)} > ${name}/env`);
	}
	for (const [name, point] of Object.entries(plan.savepoints)) await upload(vm.id, point.file, `ck/sp/${name}.json`);
	await upload(vm.id, gameScript, 'ck/game.sh');
	await remote(vm.id, 'chmod +x ~/ck/game.sh');
	vm.prepared = true;
}

async function addMachine(kind) {
	// The deadline (TTL_SECONDS, pushed back each pass) is the cost backstop if this runner dies; boat stops the machine
	// then, and a machine made without snapshots is erased when it stops.
	const vm = await createMachine({ from: plan.snapshot ?? 'mineagen-rooms-263', type: plan.type ?? 'default', ttlSeconds: TTL_SECONDS, name: `${plan.name ?? 'ckpt'}-${++created}`, snapshots: false });
	// A machine made from a saved image keeps downloading it in the background until boat reports it hydrated.
	const began = Date.now();
	// A machine whose image never finishes is deleted here: the caller never learns its id.
	await waitHydrated(vm.id, { log: line => log(line) }).catch(async error => { await destroyMachine(vm.id).catch(() => {}); throw error; });
	await log(`created machine ${vm.id} (${kind}), image ready after ${Math.round((Date.now() - began) / 1000)} s`);
	return { id: vm.id, created: true, extendedAt: Date.now() };
}

async function start(vm, game) {
	await upload(vm.id, authFiles[game.account], '.codex/auth.json');
	const copied = (await remote(vm.id, 'chmod 600 ~/.codex/auth.json; sha256sum ~/.codex/auth.json | cut -c1-64')).trim();
	if (copied !== authShas[game.account]) throw new Error(`sign-in ${game.account + 1} did not copy intact to ${vm.id}`);
	game.state = 'running'; game.attempts++; game.machine = vm.id; game.startedAt = new Date().toISOString(); vm.game = game.id; vm.signInRemoved = false;
	await remote(vm.id, `rm -rf ~/ck/games/${game.id}; mkdir -p ~/ck/games/${game.id}\nsetsid nohup ~/ck/game.sh ${game.id} ${game.arm} "$HOME/ck/sp/${game.savepoint}.json" ${plan.minutes} ${game.salt} ${quote(plan.model ?? 'gpt-6.2-sol')} ${quote(plan.effort ?? 'low')} > /dev/null 2>&1 < /dev/null &\necho started`);
	await log(`started ${game.id} on ${vm.id} (salt ${game.salt}, sign-in ${game.account + 1}, attempt ${game.attempts})`);
}

async function fetch(vm, game) {
	// The raw run folder is copied without the world, the per-run Codex home (it holds a copy of the sign-in) or RCON secrets.
	const text = await remote(vm.id, `cd ~/ck/games/${game.id}; raw=$(sed -n 's/^Running [^:]*: //p' run.log | tail -1)
if [ -n "$raw" ] && [ -d "$raw" ]; then rm -rf raw; mkdir raw; tar -C "$raw" --exclude=server --exclude=.codex-home --exclude=auth.json --exclude=rcon-password.txt --exclude=secret.txt -cf - . | tar -C raw -xf -; rm -rf "$raw/server"; fi
[ -n "$raw" ] && find "$raw" -path '*.codex-home/auth.json' -exec sha256sum {} + 2>/dev/null | cut -c1-64 | sed 's/^/run=/'
tar --exclude=auth.json --exclude=.codex-home -czf ../${game.id}.tgz . && echo ok; echo tgz=$(sha256sum ../${game.id}.tgz | cut -c1-64); sha256sum ~/.codex/auth.json | cut -c1-64`, { timeoutMs: 15 * 60_000 });
	const lines = text.trim().split('\n'), remoteSha = lines.pop();
	// No "ok" means tar failed on the machine (its disk full, say): a machine-side failure, not a local one, so it counts
	// against the machine instead of being copied again forever.
	if (!lines.includes('ok')) throw new Error(`could not pack ${game.id} on ${vm.id}`);
	// The game's coordinator works on its own copy of the sign-in (.codex-home under the run folder), so a refresh during
	// the game shows there, not in ~/.codex: both must still match the source.
	const runShas = lines.filter(l => l.startsWith('run=')).map(l => l.slice(4));
	const changed = [remoteSha, ...runShas].some(hash => hash !== authShas[game.account]);
	if (changed) { signInChanged = true; await log(`SIGN-IN CHANGED on ${vm.id}${runShas.some(h => h !== authShas[game.account]) ? ' (the game\'s own copy)' : ''}: Codex refreshed it there; no new game starts`); }
	const tgzSha = lines.find(l => l.startsWith('tgz='))?.slice(4);
	const dest = path.join(out, 'games', game.id);
	// The raw journals stay packed in game.tgz (about 1 GB unpacked per 90-minute game); only the report and logs unpack.
	// Every step on this computer (the folder, the copy, its check and unpacking) that fails, for example on a full disk,
	// is marked local: the machine is not dropped, and the next pass copies the game again from the machine.
	const local = error => Object.assign(error, { local: true });
	try {
	await rm(dest, { recursive: true, force: true }); await mkdir(dest, { recursive: true });
	await download(vm.id, `ck/games/${game.id}.tgz`, path.join(dest, 'game.tgz')).catch(error => { throw local(error); });
	if (tgzSha && sha(path.join(dest, 'game.tgz')) !== tgzSha) throw local(new Error(`copy of ${game.id} does not match the machine's (sha), copied again next pass`));
	// A member the archive lacks (a game that died before its report) scores unknown; failing to list or unpack the
	// archive here (a full disk) is a local error, so the game is copied again next pass instead of counting as unplayed.
	let members;
	try { members = new Set(execFileSync('tar', ['-tzf', path.join(dest, 'game.tgz')], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n')); }
	catch (error) { throw local(new Error(`could not read the copy of ${game.id}: ${error.message.split('\n')[0]}`)); }
	const wanted = ['./done', './run.log', './ledger.json', './report/'].filter(m => members.has(m));
	if (wanted.length < 4) await log(`${game.id}: copy is missing some of done, run.log, ledger.json, report`);
	try { if (wanted.length) execFileSync('tar', ['-xzf', path.join(dest, 'game.tgz'), '-C', dest, ...wanted.map(m => m.replace(/\/$/, ''))], { stdio: 'ignore' }); }
	catch (error) { throw local(new Error(`could not unpack the copy of ${game.id}: ${error.message.split('\n')[0]}`)); }
	execFileSync('find', [dest, '-name', 'auth.json', '-delete']);
	} catch (error) { throw error.local ? error : local(error); }
	game.done = (await readFile(path.join(dest, 'done'), 'utf8').catch(() => 'missing')).trim();
	game.score = await scoreFrom(out, game, plan);
	game.state = 'done'; game.endedAt = new Date().toISOString();
	await log(`finished ${game.id}: ${game.done}; ${JSON.stringify(game.score.targets)} deaths ${game.score.deaths ?? 'unknown'}`);
}

async function scoreFrom(dir, game, p) {
	const file = path.join(dir, 'games', game.id, 'report', 'long-run.json');
	// Large report fields live in report-artifacts/ beside it; the reader restores them and checks their hashes.
	const report = await readArtifactReport(file).catch(() => null);
	return scoreGame(report, p.savepoints[game.savepoint].targets);
}

async function writeSummary(dir, s) {
	const rows = summarize(s.games, s.plan);
	await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ rows, games: s.games.map(g => ({ id: g.id, state: g.state, salt: g.salt, signIn: g.account + 1, machine: g.machine, attempts: g.attempts, done: g.done, score: g.score })) }, null, 2));
	await writeFile(path.join(dir, 'summary.txt'), `${summaryText(rows)}\n`);
}

const machines = state.machines;

const noMoreGames = () => stopped || signInChanged || existsSync(path.join(out, 'STOP')) || !canStart(Date.now(), plan) || !nextGame(games);
// plan.drain "delete": every machine is deleted once it has no further game and its sign-in is off (idle machines bill
// in full). Otherwise only the machines this batch created are deleted, at the end; listed (reused) ones are kept.
const deletes = vm => plan.drain === 'delete' || vm.created;
async function retire(vm) {
	if (!vm.signInRemoved) { await removeCodexSignIn(vm.id); vm.signInRemoved = true; await log(`removed the sign-in from ${vm.id} (no further game for it)`); }
	if (plan.drain === 'delete' && !vm.deleted) { await destroyMachine(vm.id); vm.deleted = true; await log(`deleted ${vm.id} (no further game for it)`); }
}

// One machine's turn in a pass: prepare, check its game, copy a finished one home and retire the machine when no game
// is left for it. Errors count against the machine only when it stops answering: a machine is dropped after it failed
// for LOST_AFTER_MS in a row (or boat no longer lists it), never because of a local copy failure.
async function tend(vm, step) {
	try { await step(); vm.failingSince = null; }
	catch (error) {
		await log(`machine ${vm.id}: ${error.message.split('\n')[0].slice(0, 300)}`);
		if (error.local) {
			const game = vm.game && games.find(g => g.id === vm.game);
			if (game && (game.localCopyFailures = (game.localCopyFailures ?? 0) + 1) >= MAX_LOCAL_COPY_FAILURES) {
				game.state = 'done'; game.done = 'local copy failed'; game.endedAt = new Date().toISOString();
				game.score = scoreGame(null, plan.savepoints[game.savepoint].targets);
				await log(`gave up copying ${game.id} after ${game.localCopyFailures} local failures: it scores unknown`);
				vm.game = null;
			}
			return;
		}
		vm.failingSince ??= Date.now();
		const gone = await machineState(vm.id).then(s => !LIVE.has(s)).catch(() => false);
		if (gone || Date.now() - vm.failingSince > LOST_AFTER_MS) {
			vm.lost = true;
			if (vm.game) { const g = loseGame(games, vm.game, `machine ${vm.id} stopped answering`); await log(`lost ${vm.id}; ${g.id} is ${g.state}`); vm.game = null; }
			// A lost machine this batch would delete anyway is deleted now (a stopped one too: its snapshot bills), not left
			// billing until the batch ends. A listed one is kept, and the cleanup still tries to take its sign-in off.
			if (deletes(vm)) {
				await removeCodexSignIn(vm.id).catch(() => {});
				await destroyWithRetry(vm.id).then(() => { vm.deleted = true; return log(`deleted lost machine ${vm.id}`); }, e => log(`could not delete lost machine ${vm.id}: ${e.message}`));
			}
			if (spares > 0 && !noMoreGames()) { spares--; const extra = await addMachine('replacement').catch(async e => { await log(`replacement failed: ${e.message}`); return { id: 'none', lost: true }; }); machines.push(extra); await save().catch(() => {}); }
		}
	}
}
async function check(vm) {
	// A failed push is logged and tried again next pass; it does not count against the machine.
	if (vm.created && Date.now() - (vm.extendedAt ?? 0) > EXTEND_EVERY_MS) {
		await extendMachine(vm.id, TTL_SECONDS).then(() => { vm.extendedAt = Date.now(); }, e => log(`could not push back the deadline of ${vm.id}: ${e.message.split('\n')[0].slice(0, 200)}`));
	}
	if (!vm.prepared) { await prepare(vm); await log(`prepared ${vm.id}`); }
	// An idle machine that failed last time must answer before it counts as healthy again.
	if (!vm.game) { if (vm.failingSince) await remote(vm.id, 'true', { timeoutMs: 60_000 }); return; }
	const game = games.find(g => g.id === vm.game);
	const status = await remote(vm.id, `if test -f ~/ck/games/${game.id}/done; then echo DONE; elif pgrep -f 'ck/game.sh ${game.id} ' >/dev/null; then echo RUNNING; else echo GONE; fi`, { timeoutMs: 120_000 });
	if (/GONE/.test(status)) {
		// No done file and no game process: the launch never ran (its ssh dropped first) or the session was killed. The
		// machine is fine; the game goes back to the queue once (loseGame), instead of idling until the hang timeout.
		const g = loseGame(games, game.id, `game process on ${vm.id} ended without a done file`);
		await log(`${g.id} is not running on ${vm.id} and wrote no done file; it is ${g.state}`);
		vm.game = null;
		return;
	}
	if (!/DONE/.test(status) && Date.now() - Date.parse(game.startedAt) > (plan.minutes + 30) * 60_000) {
		// A game past its window plus half an hour is hung: end its session. run-long writes its partial timeline and report
		// on SIGTERM, which can take minutes, so wait for the session to end (up to 5 min) before killing what is left.
		await remote(vm.id, `sid=$(ps -o sid= -p "$(pgrep -f 'ck/game.sh ${game.id} ' | head -1)" 2>/dev/null | tr -d ' ')
if [ -n "$sid" ]; then pkill -TERM -s "$sid"; for i in $(seq 1 60); do pgrep -s "$sid" >/dev/null || break; sleep 5; done; pkill -KILL -s "$sid"; sleep 2; fi
mkdir -p ~/ck/games/${game.id}; echo "exit timeout $(date -Is)" > ~/ck/games/${game.id}/done`, { timeoutMs: 10 * 60_000 });
		await log(`timed out ${game.id} on ${vm.id}`);
		await fetch(vm, game); vm.game = null;
		return;
	}
	if (/DONE/.test(status)) { await fetch(vm, game); vm.game = null; }
}
// Copies home run in parallel (each is one scp of about 100 MB): a wave that ends together comes back in minutes, not
// one game after another.
async function eachLimited(items, limit, fn) {
	const queue = [...items];
	await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
}
const copyLimit = plan.copyConcurrency ?? 8;

// Whatever stops the loop (a local write failing on a full disk, a bug), the cleanup below still runs: no machine keeps
// its sign-in, and created machines are deleted.
let crash = null;
try {
	// Machines: the listed ones, then new ones. A machine that cannot be made is logged and the batch plays on the rest;
	// the state is saved after each, so every machine made so far is on record, and the cleanup below always runs.
	for (const id of plan.vms ?? []) machines.push({ id, created: false });
	for (let i = 0; i < (plan.create ?? 0) && !stopped && !existsSync(path.join(out, 'STOP')); i++) {
		machines.push(await addMachine('pool').catch(async e => { await log(`machine creation failed: ${e.message.split('\n')[0].slice(0, 300)}`); return { id: 'none', lost: true }; }));
		await save().catch(error => log(`could not write the state: ${error.message}`));
	}
	await log(`batch: ${games.length} games, ${plan.minutes} min, ${machines.length} machines, deadline ${plan.deadline}`);
	// Prepare every machine at once (about a minute each), so the first wave starts together; one that fails is retried in the loop.
	await Promise.all(machines.filter(vm => vm.id !== 'none').map(vm => prepare(vm).then(() => { vm.failingSince = null; return log(`prepared ${vm.id}`); }, error => log(`machine ${vm.id}: ${error.message.split('\n')[0].slice(0, 300)}`))));
	while (!aborted) {
	await eachLimited(machines.filter(m => !m.lost && !m.deleted), copyLimit, vm => tend(vm, () => check(vm)));
	// Starts stay one at a time, so two machines never take the same game.
	for (const vm of machines.filter(m => !m.lost && !m.deleted && m.prepared && !m.game)) {
		if (noMoreGames()) { await tend(vm, () => retire(vm)); continue; }
		if (underCap() && await meterOk()) await tend(vm, async () => { const game = nextGame(games); if (game) await start(vm, game); });
	}
	// A failed local write (a full disk) is retried next pass; the state in memory is complete.
	await save().then(() => writeSummary(out, state)).catch(error => log(`could not write the state: ${error.message}`));
	const running = machines.some(m => m.game && !m.lost);
	const startable = !stopped && !signInChanged && !meterLow && !existsSync(path.join(out, 'STOP')) && canStart(Date.now(), plan) && nextGame(games);
	if (!running && !startable) break;
	await new Promise(resolve => setTimeout(resolve, POLL_MS));
	}
} catch (error) { crash = error; await log(`batch stopped by an error: ${error.stack ?? error.message}`); }
if (aborted) await log('second signal: ending running games and cleaning up');
for (const g of games.filter(g => g.state === 'queued')) g.state = 'not started';
// Every machine of the batch, lost and half-prepared ones included (one that comes back must not keep it); a failure is logged.
for (const vm of machines.filter(m => m.id !== 'none' && !m.deleted)) {
	// A game still running here (an error or a second signal ended the loop; a lost machine that came back) is ended
	// first, so no session keeps playing on a machine whose sign-in is about to go, or one that is kept for reuse.
	if (vm.game || vm.lost) await remote(vm.id, stopGamesScript, { timeoutMs: 180_000 }).then(() => log(`ended the game sessions on ${vm.id}`)).catch(e => log(`could not end the game sessions on ${vm.id}: ${e.message.split('\n')[0]}`));
	await removeCodexSignIn(vm.id).then(() => log(`removed the sign-in from ${vm.id}`)).catch(e => log(`could not remove the sign-in from ${vm.id}: ${e.message}`));
	// Batch-created extras (and every machine under drain "delete") are deleted, never left idle; a failure is retried, then logged.
	if (deletes(vm)) await destroyWithRetry(vm.id).then(() => { vm.deleted = true; return log(`deleted ${vm.id}`); }).catch(e => log(`could not delete ${vm.id}: ${e.message}`));
}
for (const g of games.filter(g => g.state === 'running')) g.state = 'not finished';
state.endedAt = new Date().toISOString();
await save().then(() => writeSummary(out, state)).catch(error => log(`could not write the final state: ${error.message}`));
await log(`batch ended; machines not deleted: ${machines.filter(m => m.id !== 'none' && !m.deleted).map(m => `${m.id}${m.lost ? ' (lost)' : ''}${m.created ? '' : ' (listed, kept)'}`).join(' ') || 'none'}`);
console.log(await readFile(path.join(out, 'summary.txt'), 'utf8').catch(() => ''));
if (crash) process.exitCode = 1;
