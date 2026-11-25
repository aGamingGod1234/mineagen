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
//   A save point { "fresh": true } in place of "file" plays a new random world with an empty inventory (no save point,
//   no salt). "minutes" goes up to 355 (6 hours with setup, the headless launcher's limit). "keepWorld": true packs each game's final world save as
//   world-NAME.tgz inside game.tgz instead of dropping it. "recording": "/folder" records every game for replays: the
//   folder holds ServerReplay-*.jar, fabric-language-kotlin-*.jar and server-replay-config.json, which go into each
//   machine's template; game.tgz then also holds recordings.tar, and the world is kept as with keepWorld.
//   A game that ends without its normal copy (its process vanished, its machine is dropped, the batch ends under it)
//   has its recordings and world copied to OUT/salvage/ before the machine can be deleted, when either is kept. A
//   machine whose copy failed is kept (retried up to 3 times), and the last line of batch.log names it.
// Each arm is `git archive REF` of its root plus that root's coordinator/node_modules, and its jar. Every repeat of a
// save point draws one loot salt that all arms share (lib/checkpoint-batch-core.mjs). A game runs scripts/quality/run-long.mjs
// --checkpoint under eatmydata (boat disks sync slowly; see lib/boat-pool.mjs) with the Codex provider, the observer cap in
// log mode and the arm's env. Listed machines (vms) are kept for reuse, since boat starts are scarce; machines the batch
// created (create, spares) are deleted when it ends, and with drain "delete" every machine is deleted as soon as it has no
// further game, because an idle machine bills in full. A created machine has a boat deadline (--ttl) that each pass
// pushes back while the batch runs, so a runner that dies (SIGKILL, a reboot) leaves no machine billing for long.
// Listed machines must not be warm-pool members (rbpool-*): the pool and its guard lease, wipe and delete those by name. Finished games are copied home in parallel and checked by sha. The sign-in is copied to each machine as its source is at
// that launch, kept out of every copy-back, and removed from every machine when the batch ends. A copy refreshes where it
// runs when its access token runs out (10 days after the last refresh), and every copy then refreshes on its own: on
// 25 Nov six copies of one sign-in (here and on five game machines) refreshed on their own from the same token as it
// ran out, and every new access token kept working, so a refresh is logged and the batch plays on. A copy that is
// signed out shows as failing model turns in its games, not as a stopped batch. A refresh here makes later games take the new copy.
// Every game's server gets Lithium (a server performance mod that keeps vanilla behaviour; the target's pinned JAR,
// downloaded and checked here): the machine's template when its mods/ already holds that exact JAR, else a copy of it
// with that JAR in place of any other Lithium version (named by a fingerprint of the template, so a changed template gets
// a new copy). "lithium": false in the plan plays on the template as it is (with whatever it holds), and
// "lithium": "/path/lithium-fabric-VERSION.jar" uses that JAR instead.
// "stopWhen" (plan-wide, or per save point, which replaces it) ends a game early once its question is answered and hands
// its machine to the next queued game: { "advancement": "nether/obtain_blaze_rod" }, { "items": { "minecraft:ender_pearl": 12 } }
// or { "stallMinutes": 30 } (no new advancement, item kind or dimension for that long); see lib/stop-when.mjs. Without it
// every game plays its whole window. A target not reached by an answered game scores as unobserved, not as a miss.
// Output: OUT/games/ID/{run.log,done,report/long-run.json,game.tgz (everything, raw journals under raw/)}, OUT/state.json, OUT/summary.json, OUT/summary.txt, OUT/batch.log.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boat, createMachine, destroyMachine, download, extendMachine, installCodex, machineState, quote, remote, removeCodexSignIn, upload, waitHydrated } from './lib/boat-pool.mjs';
import { readArtifactReport } from '../../coordinator/src/benchmark/report-artifacts.mjs';
import { lithiumJar, targetProperties } from '../prepare-server-template.mjs';
import { canStart, codexHomes, expandPlan, loseGame, nextGame, scoreGame, summarize, summaryText } from './lib/checkpoint-batch-core.mjs';

const USAGE = 'Usage: checkpoint-batch.mjs --plan PLAN.json --out FRESH_DIR [--dry-run] | --score OUT_DIR';
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help') || (!flag('score') && (!flag('plan') || !flag('out')))) { console.log(USAGE); process.exit(args.includes('--help') ? 0 : 2); }

// CHECKPOINT_POLL_MS and CHECKPOINT_LOST_AFTER_MS shorten the pass and the drop wait for the fake-boat
// tests (coordinator/test/checkpoint-batch-*.test.mjs).
const POLL_MS = Number(process.env.CHECKPOINT_POLL_MS ?? 60_000), SIGNAL_BUDGET_MS = Number(process.env.CHECKPOINT_SIGNAL_BUDGET_MS ?? 60_000), LOST_AFTER_MS = Number(process.env.CHECKPOINT_LOST_AFTER_MS ?? 5 * 60_000), LIVE = new Set(['provisioned', 'cloning', 'ready', 'idle', 'running']);
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
// Local copy failures of one game (a full disk) are retried each pass; past this many the game scores unknown and the
// machine is let go, so the batch can always end.
const MAX_LOCAL_COPY_FAILURES = 30;
// While boat answers a listing but not about one failing machine, that machine is dropped only after this much longer
// wait, so a slow boat drops nothing, yet one machine boat never answers about cannot hold the batch open forever.
const OUTAGE_GRACE_MS = 6 * LOST_AFTER_MS;
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
for (const [name, point] of Object.entries(plan.savepoints)) if (!point.fresh && !existsSync(point.file)) throw new Error(`save point ${name}: no file ${point.file}`);
for (const [name, arm] of Object.entries(plan.arms)) {
	if (!existsSync(arm.jar)) throw new Error(`arm ${name}: no jar ${arm.jar}`);
	if (!existsSync(path.join(arm.root, 'coordinator/node_modules'))) throw new Error(`arm ${name}: ${arm.root} has no coordinator/node_modules`);
	execFileSync('git', ['-C', arm.root, 'cat-file', '-e', `${arm.ref}^{commit}`]);
}
// Recording needs the kit and an arm whose launcher records the agent (a Carpet fake player that ServerReplay's automatic
// recording skips); without it every game would play unrecorded.
const recordingKit = plan.recording ? (() => {
	const files = existsSync(plan.recording) ? readdirSync(plan.recording) : [];
	const kit = [/^ServerReplay-.*\.jar$/, /^fabric-language-kotlin-.*\.jar$/, /^server-replay-config\.json$/].map(pattern => files.find(name => pattern.test(name)));
	if (kit.some(name => !name)) throw new Error(`plan.recording ${plan.recording} must hold ServerReplay-*.jar, fabric-language-kotlin-*.jar and server-replay-config.json`);
	for (const [name, arm] of Object.entries(plan.arms)) {
		let launcher = '';
		try { launcher = execFileSync('git', ['-C', arm.root, 'show', `${arm.ref}:scripts/run-headless-provider-matrix.mjs`], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
		if (!launcher.includes('REPLAY_STOP_COMMAND')) throw new Error(`arm ${name}: its launcher at ${arm.ref} does not record the agent; use a ref with replay recording`);
	}
	return kit.map(name => path.join(plan.recording, name));
})() : null;
const keepsWorlds = plan.keepWorld === true || Boolean(recordingKit);
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
// launchedAuth: the sign-in hash each running game was launched with, kept out of state.json.
const authShas = authFiles.map(sha), launchedAuth = new Map();
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
// The template every game plays on: the machine's own, or a copy of it with Lithium (prepare() writes its path to
// ~/ck/server-template).
const lithium = plan.lithium === false ? null : typeof plan.lithium === 'string' ? plan.lithium : await lithiumJar(targetProperties(fileURLToPath(new URL('../..', import.meta.url))));
const freshFile = path.join(out, 'pkg', 'fresh.json');
await writeFile(freshFile, 'FRESH\n');
const gameScript = path.join(out, 'pkg', 'game.sh');
await writeFile(gameScript, `#!/bin/bash
# game.sh ID ARM SAVEPOINT_FILE MINUTES SALT MODEL EFFORT: one game on this machine; writes ~/ck/games/ID/done when it ends.
id=$1 arm=$2 sp=$3 mins=$4 salt=$5 model=$6 effort=$7
dir=$HOME/ck/games/$id; mkdir -p "$dir"; echo $$ > "$dir/sid"
unset OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY CODEX_HOME
while IFS='=' read -r key value; do [ -n "$key" ] && export "$key=$value"; done < "$HOME/ck/arms/$arm/env"
template=$(cat "$HOME/ck/server-template" 2>/dev/null || echo "$HOME/rooms/template-26.3")
export PATH=$HOME/.local/bin:$PATH JAVA_HOME=$HOME/rooms/jdk ARENA_HEADLESS_SERVER_TEMPLATE="$template"
cd "$HOME/ck/arms/$arm/$arm" || exit 1
# A fresh save point's file holds only FRESH: a new world with an empty inventory, no save point. The repeat's salt is
# its world seed, so every arm of a repeat plays the same world.
start=(--checkpoint "$sp" --random-salt "$salt"); grep -qx FRESH "$sp" && start=(--seed "$salt")
eatmydata node scripts/quality/run-long.mjs --provider codex --model "$model" --effort "$effort" --service-tier default \\
  --codex-observer-cap yes --spend-cap-mode log "\${start[@]}" --budget-minutes "$mins" --max-total-cost-usd 100 \\
  --ledger "$dir/ledger.json" --port-base 26900 --jar "$HOME/ck/arms/$arm/mod.jar" --coordinator-root "$HOME/ck/arms/$arm/$arm" \\
  --java "$HOME/rooms/jdk/bin/java" --server-template "$template" --out "$dir/report" > "$dir/run.log" 2>&1 < /dev/null
echo "exit $? $(date -Is)" > "$dir/done"
`);

// The meter command prints the percent of the sign-in's allowance left. Below the floor no new game starts; a reading
// that fails or is not a number is logged and does not stop the batch, since the batch cannot read the meter itself.
let meterAt = 0, meterLow = false;
async function meterOk() {
	if (!plan.meter || Date.now() - meterAt < 5 * 60_000) return !meterLow;
	meterAt = Date.now();
	try {
		// Number('') is 0, so an empty reading would pass as 0% left and stop every start: it is unreadable instead.
		const reading = execFileSync('bash', ['-c', plan.meter.command], { encoding: 'utf8', timeout: 60_000 }).trim().split(/\s+/).pop();
		if (!reading) throw new Error('no output');
		const left = Number(reading);
		if (!Number.isFinite(left)) throw new Error('not a number');
		if (left < plan.meter.floorPercent && !meterLow) await log(`meter ${left}% left, below the ${plan.meter.floorPercent}% floor: no new game starts`);
		meterLow = left < plan.meter.floorPercent;
		state.meter = { left, at: new Date().toISOString() };
	} catch (error) { await log(`meter unreadable: ${error.message.split('\n')[0].slice(0, 200)}`); }
	return !meterLow;
}

const state = { plan: { ...plan, codexHome: '(private)', codexHomes: authFiles.map((_, i) => `(private sign-in ${i + 1})`) }, startedAt: new Date().toISOString(), codexVersion, arms: pkgs, games, machines: [] };
const save = async () => { await writeFile(path.join(out, 'state.json.tmp'), JSON.stringify(state, null, 2)); await rename(path.join(out, 'state.json.tmp'), path.join(out, 'state.json')); };
let created = 0, spares = plan.spares ?? 0, stopped = false, aborted = false, abortedAt = 0, interrupts = 0, wake = () => {};
// Every boat call of the loop (preparing, launching, checking, copying home) carries this signal, so an abort kills a
// transfer in flight (up to 15 minutes) instead of waiting for it, and the cleanup starts at once. The cleanup's own
// calls and machine creation do not carry it: a killed `boat new` could leave a machine whose id is never learned.
const stopAll = new AbortController();
const live = { signal: stopAll.signal };
// A wait that an abort ends early, so no retry delay holds a SIGTERM back from the cleanup.
const pause = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); stopAll.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
const abort = () => { stopped = true; if (!aborted) { aborted = true; abortedAt = Date.now(); stopAll.abort(); } wake(); };
// The first Ctrl-C starts no new game and lets running ones finish; a second ends the running games and goes straight
// to the cleanup (sign-ins off, created machines deleted).
process.on('SIGINT', () => { stopped = true; if (++interrupts > 1) abort(); });
// SIGTERM (systemctl stop, a shutdown) ends the running games and cleans up at once, because its sender kills the
// runner soon after (systemd after 90 s by default). touch OUT/STOP is the gentle stop.
process.on('SIGTERM', abort);
// A hang-up (one terminal close can send two) only stops new starts: running games finish and are copied home, and it
// does not count toward a second Ctrl-C. The terminal is gone, so writes to it fail; those are ignored and batch.log
// still gets every line.
process.on('SIGHUP', () => { stopped = true; });
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
// A created machine's boat deadline: the whole game window plus an hour for setup and copy-back, at least 2 hours.
const TTL_SECONDS = Math.max(2 * 3600, (plan.minutes + 60) * 60);
// Used by the loop only (dropMachine), so it carries the abort signal: after a SIGTERM it stops at once and the cleanup,
// which deletes every machine not yet deleted, takes over.
async function destroyWithRetry(id, tries = 3) {
	for (let i = 1; ; i++) {
		try { return await destroyMachine(id, live); }
		catch (error) { if (i >= tries || aborted) throw error; await log(`delete of ${id} failed (try ${i} of ${tries}): ${error.message.split('\n')[0].slice(0, 200)}`); await pause(5_000); }
	}
}
// The headless launcher starts the server, the coordinator and the game runner in sessions of their own, so ending a
// game's session can leave them running (and holding the game's ports). Their command lines all hold ~/ck/arms/, and a
// machine plays one game at a time, so whatever is left there is ended too.
const leftovers = `pkill -TERM -f "$HOME/ck/arms/"; for i in $(seq 1 15); do pgrep -f "$HOME/ck/arms/" >/dev/null || break; sleep 1; done; pkill -KILL -f "$HOME/ck/arms/"; true`;
// Ends every game session on a machine (game.sh and the run it started), first politely, then by force. The pattern's
// [c] keeps it from matching another pgrep's own command line (another check on the same machine).
const stopGamesScript = `sids=$(for p in $(pgrep -f '[c]k/game.sh '); do ps -o sid= -p "$p"; done | tr -d ' ' | sort -u)
for s in $sids; do pkill -TERM -s "$s"; done; for i in $(seq 1 30); do [ -z "$(pgrep -f '[c]k/game.sh ')" ] && break; sleep 2; done
for s in $sids; do pkill -KILL -s "$s"; done
${leftovers}`;

// OUT/MAX_RUNNING holds a number: no new game starts while that many are running (lowers concurrency without a restart).
function underCap() {
	let cap;
	try { cap = Number(readFileSync(path.join(out, 'MAX_RUNNING'), 'utf8').trim()); } catch { return true; }
	return !Number.isFinite(cap) || games.filter(g => g.state === 'running').length < cap;
}

async function prepare(vm) {
	await remote(vm.id, 'set -e; mkdir -p ~/ck/arms ~/ck/sp ~/ck/games; command -v eatmydata >/dev/null; test -x ~/rooms/jdk/bin/java', live);
	vm.signInRemoved = false;
	const want = sha(authFile), hash = await installCodex(vm.id, { authFile, version: codexVersion, ...live });
	if (hash !== want) throw new Error(`sign-in copy on ${vm.id} does not match its source`);
	for (const [name, pkg] of Object.entries(pkgs)) {
		await upload(vm.id, pkg.tar, `ck/arms/${name}.tar.gz`, live);
		await upload(vm.id, plan.arms[name].jar, `ck/arms/${name}.jar`, live);
		const env = Object.entries(plan.arms[name].env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
		await remote(vm.id, `set -e; cd ~/ck/arms; rm -rf ${name}; mkdir -p ${name}; tar -xzf ${name}.tar.gz -C ${name}; mv ${name}.jar ${name}/mod.jar; rm ${name}.tar.gz; printf '%s\\n' ${quote(env)} > ${name}/env`, live);
	}
	if (lithium) {
		const name = path.basename(lithium);
		await upload(vm.id, lithium, `ck/${name}`, live);
		// A copy with no other Lithium version in mods/ (two would stop the server), built beside it and moved into place.
		await remote(vm.id, `set -e; t=~/rooms/template-26.3; j=~/ck/${quote(name)}
if cmp -s "$t/mods/"${quote(name)} "$j"; then echo "$t" > ~/ck/server-template; exit 0; fi
fp=$( (cd "$t" && find . -type f -printf '%p %s %T@\\n' | sort; sha256sum < "$j") | sha256sum | cut -c1-12); c="$t+lithium-$fp"
if [ ! -f "$c/.mineagen-server-mods" ]; then rm -rf "$c.tmp"; cp -r "$t" "$c.tmp"; rm -f "$c.tmp"/mods/lithium-*.jar; mkdir -p "$c.tmp/mods"; cp "$j" "$c.tmp/mods/"; echo ${quote(name)} > "$c.tmp/.mineagen-server-mods"; rm -rf "$c"; mv "$c.tmp" "$c"; fi
echo "$c" > ~/ck/server-template`, live);
	} else await remote(vm.id, 'echo ~/rooms/template-26.3 > ~/ck/server-template', live);
	if (recordingKit) {
		// A copy of the chosen template with the recorder added, built beside it and moved into place.
		await remote(vm.id, 'rm -rf ~/ck/rec; mkdir -p ~/ck/rec', live);
		for (const file of recordingKit) await upload(vm.id, file, `ck/rec/${path.basename(file)}`, live);
		await remote(vm.id, `set -e; t=$(cat ~/ck/server-template); c="$t+rec"; rm -rf "$c.tmp"; cp -r "$t" "$c.tmp"; rm -f "$c.tmp"/mods/ServerReplay-*.jar "$c.tmp"/mods/fabric-language-kotlin-*.jar
cp ~/ck/rec/*.jar "$c.tmp/mods/"; mkdir -p "$c.tmp/config/server-replay"; cp ~/ck/rec/server-replay-config.json "$c.tmp/config/server-replay/config.json"
rm -rf "$c"; mv "$c.tmp" "$c"; echo "$c" > ~/ck/server-template`, live);
	}
	for (const [name, point] of Object.entries(plan.savepoints)) await upload(vm.id, point.fresh ? freshFile : point.file, `ck/sp/${name}.json`, live);
	await upload(vm.id, gameScript, 'ck/game.sh', live);
	if (games.some(g => g.stopWhen)) await upload(vm.id, fileURLToPath(new URL('./lib/stop-when.mjs', import.meta.url)), 'ck/stop-when.mjs', live);
	await remote(vm.id, 'chmod +x ~/ck/game.sh', live);
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

// A launch that fails before its game is handed to the machine (the sign-in upload or its check) is tracked apart from
// failingSince, which the idle probe in check() clears while ssh still works: a machine whose launches keep failing for
// LOST_AFTER_MS is dropped right after the latest failure. Once the game is handed over, check() follows it instead.
async function start(vm, game) {
	// The same game starting again here would wipe ~/ck/games/ID, whose run.log is the only pointer to an uncopied replay
	// and world: the copy is tried first, and if it still fails that folder is moved aside and the machine is kept.
	if ((vm.uncopied ?? []).includes(game.id)) {
		if (copiesLeft(vm)) await retryCopies(vm, { timeoutMs: 20 * 60_000, ...live });
		if ((vm.uncopied ?? []).includes(game.id)) {
			const dir = `${game.id}.held-${Date.now()}`;
			await remote(vm.id, `mv ~/ck/games/${game.id} ~/ck/games/${dir}`, live);
			vm.uncopied = vm.uncopied.filter(id => id !== game.id); vm.heldDirs = [...(vm.heldDirs ?? []), dir];
			await log(`kept the uncopied run folder of ${game.id} on ${vm.id} as ~/ck/games/${dir}; the machine is kept`);
		}
	}
	try { await launch(vm, game); }
	catch (error) {
		if (aborted || vm.game === game.id) throw error;
		vm.launchFailingSince ??= Date.now();
		// boatSays carries the abort signal; an answer the abort cut says nothing about the machine.
		const says = await boatSays(vm.id);
		if (aborted || !dropDue(vm, says, 'launchFailingSince')) throw error;
		await log(`dropping ${vm.id}: its launches keep failing (${error.message.split('\n')[0].slice(0, 200)})`);
		await dropMachine(vm);
	}
}
// What boat says about a machine that failed: true live, false gone (not live, or not found), null no answer about this
// machine while boat still answers a listing, undefined no answer at all (an outage on this side: the network, boat).
const NOT_FOUND = /\b(?:sandbox|machine)\b[^\n]*\bnot found\b|\b404\b/i;
const boatSays = id => machineState(id, live).then(s => LIVE.has(s), e => NOT_FOUND.test(e.message) ? false
	: boat(['list', '--json'], { timeoutMs: 60_000, ...live }).then(() => null, () => undefined));
// A failing machine is dropped at once when boat says it is gone, after LOST_AFTER_MS of failures while boat says it is
// live, and after OUTAGE_GRACE_MS while boat answers about others but not this one. During an outage nothing is dropped
// (a drop then would also leave the sign-in on the machine) until the deadline has passed, when no game can start and
// every game should have ended. Time in an outage or without an answer does not count toward LOST_AFTER_MS: once boat
// answers again, every running failure clock starts over, not only vm[since]: a failed launch and the pass around it
// both call this, and the first answer clears the outage for both.
function dropDue(vm, live, since) {
	const restartClocks = () => { for (const clock of ['failingSince', 'launchFailingSince']) if (clock === since || vm[clock] != null) vm[clock] = Date.now(); };
	if (live === undefined) { vm.inOutage = true; return Date.now() > Date.parse(plan.deadline); }
	if (vm.inOutage) { vm.inOutage = false; vm.unansweredSince = null; restartClocks(); }
	if (live === null) { vm.unansweredSince ??= Date.now(); return Date.now() - vm.unansweredSince > OUTAGE_GRACE_MS; }
	if (vm.unansweredSince) { vm.unansweredSince = null; restartClocks(); }
	return live === false || Date.now() - vm[since] > LOST_AFTER_MS;
}
async function launch(vm, game) {
	// Codex on this computer refreshed the sign-in at its source: this game and later ones take the new copy.
	const source = sha(authFiles[game.account]);
	if (source !== authShas[game.account]) { authShas[game.account] = source; await log(`SIGN-IN REFRESHED at its source (sign-in ${game.account + 1}): later games take the new copy`); }
	// Marked before the upload: a launch that fails after the sign-in landed must still have it taken off.
	vm.signInRemoved = false;
	await upload(vm.id, authFiles[game.account], '.codex/auth.json', live);
	const copied = (await remote(vm.id, 'chmod 600 ~/.codex/auth.json; sha256sum ~/.codex/auth.json | cut -c1-64', live)).trim();
	if (copied !== source) throw new Error(`sign-in ${game.account + 1} did not copy intact to ${vm.id}`);
	launchedAuth.set(game.id, source);
	vm.launchFailingSince = null;
	game.state = 'running'; game.attempts++; game.machine = vm.id; game.startedAt = new Date().toISOString(); vm.game = game.id;
	game.timingOut = false; game.localCopyFailures = 0;
	await remote(vm.id, `rm -rf ~/ck/games/${game.id}; mkdir -p ~/ck/games/${game.id}\nsetsid nohup ~/ck/game.sh ${game.id} ${game.arm} "$HOME/ck/sp/${game.savepoint}.json" ${plan.minutes} ${game.salt} ${quote(plan.model ?? 'gpt-6.2-sol')} ${quote(plan.effort ?? 'low')} > /dev/null 2>&1 < /dev/null &\necho started`, live);
	await log(`started ${game.id} on ${vm.id} (salt ${game.salt}, sign-in ${game.account + 1}, attempt ${game.attempts})`);
}

async function fetch(vm, game) {
	// The raw run folder is copied without the world, the per-run Codex home (it holds a copy of the sign-in) or RCON secrets.
	// A copy that fails (the machine's disk full) is removed and the game is not packed, and the world stays: deleting it
	// could free enough space for an archive with partial journals to pass its check.
	const text = await remote(vm.id, `cd ~/ck/games/${game.id}; raw=$(sed -n 's/^Running [^:]*: //p' run.log | tail -1); staged=yes
if [ -n "$raw" ] && [ -d "$raw" ]; then rm -rf raw; mkdir raw
  if (set -o pipefail; tar -C "$raw" --exclude=server --exclude=.codex-home --exclude=auth.json --exclude=rcon-password.txt --exclude=secret.txt -cf - . | tar -C raw -xf -); then ${keepsWorlds ? 'worlds=yes; for w in $(find "$raw/server" -maxdepth 2 -name level.dat -printf \'%h\\n\'); do tar -C "$(dirname "$w")" -czf "world-$(basename "$w").tgz" "$(basename "$w")" || worlds=no; done; ' : 'worlds=yes; '}if [ -d "$raw/server/recordings" ]; then tar -C "$raw/server" -cf recordings.tar recordings || worlds=no; fi; if [ $worlds = yes ]; then rm -rf "$raw/server"; else staged=no; echo world-failed; fi; else staged=no; rm -rf raw; echo stage-failed; fi; fi
[ -n "$raw" ] && find "$raw" -path '*.codex-home/auth.json' -exec sha256sum {} + 2>/dev/null | cut -c1-64 | sed 's/^/run=/'
[ $staged = yes ] && tar --exclude=auth.json --exclude=.codex-home -czf ../${game.id}.tgz . && echo ok; echo tgz=$(sha256sum ../${game.id}.tgz | cut -c1-64); sha256sum ~/.codex/auth.json | cut -c1-64`, { timeoutMs: 15 * 60_000, ...live });
	const lines = text.trim().split('\n'), remoteSha = lines.pop();
	// The game's coordinator works on its own copy of the sign-in (.codex-home under the run folder), so a refresh during
	// the game shows there, not in ~/.codex: both are compared with the copy the game was launched with.
	const runShas = lines.filter(l => l.startsWith('run=')).map(l => l.slice(4));
	// The copy was the source as it was at launch; a refresh there stays there and is removed at the end.
	const launched = launchedAuth.get(game.id) ?? authShas[game.account];
	const changed = [remoteSha, ...runShas].some(hash => hash !== launched);
	if (changed) await log(`SIGN-IN REFRESHED on ${vm.id}${runShas.some(h => h !== launched) ? ' (the game\'s own copy)' : ''}: Codex refreshed it there; the batch plays on`);
	// No "ok" means tar failed on the machine (its disk full, say): a machine-side failure, not a local one, so it counts
	// against the machine instead of being copied again forever. The sign-in hashes above were already compared.
	if (!lines.includes('ok')) throw new Error(`could not pack ${game.id} on ${vm.id}${lines.includes('stage-failed') ? ' (copying its raw journals failed)' : lines.includes('world-failed') ? ' (packing its world or recordings failed; they stay on the machine)' : ''}`);
	const tgzSha = lines.find(l => l.startsWith('tgz='))?.slice(4);
	const dest = path.join(out, 'games', game.id);
	// The raw journals stay packed in game.tgz (about 1 GB unpacked per 90-minute game); only the report and logs unpack.
	// Every step on this computer (the folder, the copy, its check and unpacking) that fails, for example on a full disk,
	// is marked local: the machine is not dropped, and the next pass copies the game again from the machine.
	const local = error => Object.assign(error, { local: true });
	try {
	await rm(dest, { recursive: true, force: true }); await mkdir(dest, { recursive: true });
	await download(vm.id, `ck/games/${game.id}.tgz`, path.join(dest, 'game.tgz'), live).catch(error => { throw local(error); });
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

// Copies the recordings and world of a game that will not get its normal copy to OUT/salvage/ (a later attempt of the
// same game replaces OUT/games/ID). The server folder holds secrets, so only those two are packed. False when there was
// nothing to copy (no kept world or recording, the launch never ran).
async function salvage(vm, game, opts = live) {
	if (!keepsWorlds) return false;
	const name = `${game.id}-${Date.now()}`;
	// A normal copy cut off after it packed the game has already moved the world and recordings out of the server folder
	// into world-*.tgz and recordings.tar next to run.log, so those are taken when the server folder is gone.
	const text = await remote(vm.id, `cd ~/ck/games/${game.id} 2>/dev/null || exit 0; g=$PWD; raw=$(sed -n 's/^Running [^:]*: //p' run.log 2>/dev/null | tail -1); set --
if [ -n "$raw" ] && [ -d "$raw/server" ]; then cd "$raw/server"; set -- $(ls -d recordings 2>/dev/null) $(find . -mindepth 2 -maxdepth 2 -name level.dat -printf '%h\n'); fi
if [ $# -eq 0 ]; then cd "$g"; set -- $(ls -d recordings.tar world-*.tgz 2>/dev/null); fi
[ $# -gt 0 ] || exit 0; tar -czf ~/ck/games/${name}.salvage.tgz "$@" && echo packed`, opts);
	if (!/packed/.test(text)) return false;
	await mkdir(path.join(out, 'salvage'), { recursive: true });
	await download(vm.id, `ck/games/${name}.salvage.tgz`, path.join(out, 'salvage', `${name}.tgz`), opts);
	await remote(vm.id, `rm -f ~/ck/games/${name}.salvage.tgz`, opts).catch(() => {});
	await log(`copied the recordings and world of ${game.id} from ${vm.id} to salvage/${name}.tgz`);
	return true;
}
// A game whose salvage failed stays on its machine's uncopied list, and a machine with any uncopied game (or a game kept
// for a copy by hand, heldGame) is never deleted. Retirement and the final cleanup retry the copy, up to
// MAX_COPY_FAILURES failed tries per machine; a copy cut by a signal does not count as a try.
const MAX_COPY_FAILURES = 3;
const holds = vm => keepsWorlds && (Boolean(vm.heldGame) || (vm.uncopied?.length ?? 0) > 0 || (vm.heldDirs?.length ?? 0) > 0);
const copiesLeft = vm => keepsWorlds && (vm.uncopied?.length ?? 0) > 0 && (vm.copyFailures ?? 0) < MAX_COPY_FAILURES;
async function copyOrHold(vm, game, opts) {
	if (!keepsWorlds) return true;
	try { await salvage(vm, game, opts); vm.uncopied = (vm.uncopied ?? []).filter(id => id !== game.id); return true; }
	catch (error) {
		if (!(vm.uncopied ?? []).includes(game.id)) vm.uncopied = [...(vm.uncopied ?? []), game.id];
		if (!opts.signal?.aborted) vm.copyFailures = (vm.copyFailures ?? 0) + 1;
		await log(`could not copy the recordings and world of ${game.id} from ${vm.id}, so the machine is kept: ${error.message.split('\n')[0]}`);
		return false;
	}
}
async function retryCopies(vm, opts) {
	for (const id of [...(vm.uncopied ?? [])]) {
		if (!copiesLeft(vm) || (aborted && opts.signal)) return;
		await copyOrHold(vm, games.find(g => g.id === id), opts);
	}
}

async function scoreFrom(dir, game, p) {
	const file = path.join(dir, 'games', game.id, 'report', 'long-run.json');
	// Large report fields live in report-artifacts/ beside it; the reader restores them and checks their hashes.
	const report = await readArtifactReport(file).catch(() => null);
	// A fresh world inherits nothing, so a target earned in its first 30 s counts.
	return scoreGame(report, p.savepoints[game.savepoint].targets, p.savepoints[game.savepoint].fresh ? { inheritedMs: -1 } : undefined);
}

async function writeSummary(dir, s) {
	const rows = summarize(s.games, s.plan);
	await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ rows, games: s.games.map(g => ({ id: g.id, state: g.state, salt: g.salt, signIn: g.account + 1, machine: g.machine, attempts: g.attempts, done: g.done, score: g.score })) }, null, 2));
	await writeFile(path.join(dir, 'summary.txt'), `${summaryText(rows)}\n`);
}

const machines = state.machines;

const noMoreGames = () => stopped || existsSync(path.join(out, 'STOP')) || !canStart(Date.now(), plan) || !nextGame(games);
// plan.drain "delete": every machine is deleted once it has no further game and its sign-in is off (idle machines bill
// in full). Otherwise only the machines this batch created are deleted, at the end; listed (reused) ones are kept.
const deletes = vm => plan.drain === 'delete' || vm.created;
// Its calls carry the abort signal, so a stalled one cannot hold a SIGTERM back from the cleanup, which redoes both steps.
async function retire(vm) {
	if (!vm.signInRemoved) { await removeCodexSignIn(vm.id, undefined, live); vm.signInRemoved = true; await log(`removed the sign-in from ${vm.id} (no further game for it)`); }
	if (copiesLeft(vm)) await retryCopies(vm, { timeoutMs: 20 * 60_000, ...live });
	if (plan.drain === 'delete' && !vm.deleted && !holds(vm)) { await destroyMachine(vm.id, live); vm.deleted = true; await log(`deleted ${vm.id} (no further game for it)`); }
}

// One machine's turn in a pass: prepare, check its game, copy a finished one home and retire the machine when no game
// is left for it. Errors count against the machine only when it stops answering: a machine is dropped after it failed
// for LOST_AFTER_MS in a row (or boat no longer lists it), never because of a local copy failure.
async function tend(vm, step) {
	try {
		await step();
		// Boat answered again, so a launch failure clock that ran through the outage starts over too (as in dropDue).
		if ((vm.inOutage || vm.unansweredSince) && vm.launchFailingSince != null) vm.launchFailingSince = Date.now();
		vm.failingSince = null; vm.unansweredSince = null; vm.inOutage = false;
	}
	catch (error) {
		// A call the abort killed says nothing about the machine; the cleanup comes next.
		if (aborted) return;
		await log(`machine ${vm.id}: ${error.message.split('\n')[0].slice(0, 300)}`);
		if (error.local) {
			const game = vm.game && games.find(g => g.id === vm.game);
			if (game && (game.localCopyFailures = (game.localCopyFailures ?? 0) + 1) >= MAX_LOCAL_COPY_FAILURES) {
				game.state = 'done'; game.done = 'local copy failed'; game.endedAt = new Date().toISOString();
				game.score = scoreGame(null, plan.savepoints[game.savepoint].targets);
				await log(`gave up copying ${game.id} after ${game.localCopyFailures} local failures: it scores unknown`);
				// Its replays and world are still only on the machine, so the machine is kept for a copy by hand.
				if (keepsWorlds) vm.heldGame = game.id;
				vm.game = null;
			}
			return;
		}
		vm.failingSince ??= Date.now();
		// boat not answering at all is most likely an outage on this side (the network, boat itself), not this machine's
		// fault, so it waits OUTAGE_GRACE_MS (see dropDue): one outage must not drop every machine and end the batch mid-game.
		const says = await boatSays(vm.id);
		if (!aborted && dropDue(vm, says, 'failingSince')) await dropMachine(vm);
	}
}
// A machine that stopped answering, or whose launches keep dying: its game goes back to the queue once, a machine this
// batch would delete is deleted now, and a spare replaces it while games can still start.
async function dropMachine(vm) {
	vm.lost = true;
	const lostGame = vm.game && games.find(g => g.id === vm.game);
	if (lostGame && deletes(vm)) await copyOrHold(vm, lostGame, { timeoutMs: 10 * 60_000, ...live });
	if (vm.game) { const g = loseGame(games, vm.game, `machine ${vm.id} stopped answering`); await log(`lost ${vm.id}; ${g.id} is ${g.state}`); vm.game = null; }
	// A lost machine this batch would delete anyway is deleted now (a stopped one too: its snapshot bills), not left
	// billing until the batch ends. A listed one is kept, and the cleanup still tries to take its sign-in off.
	if (deletes(vm) && holds(vm)) await log(`kept lost machine ${vm.id}: it still holds the recordings and world of ${[vm.heldGame, ...(vm.uncopied ?? []), ...(vm.heldDirs ?? [])].filter(Boolean).join(', ')}; the cleanup tries the copy again`);
	else if (deletes(vm)) {
		// Both steps carry the abort signal like every other loop call: a stalled one must not hold a SIGTERM back from the
		// cleanup, whose first pass takes the sign-in off again and deletes the machine if this did not.
		await removeCodexSignIn(vm.id, undefined, live).catch(() => {});
		await destroyWithRetry(vm.id).then(() => { vm.deleted = true; return log(`deleted lost machine ${vm.id}`); }, e => log(`could not delete lost machine ${vm.id}: ${e.message}`));
	}
	if (spares > 0 && !noMoreGames()) { spares--; const extra = await addMachine('replacement').catch(async e => { await log(`replacement failed: ${e.message}`); return { id: 'none', lost: true }; }); machines.push(extra); await save().catch(() => {}); }
}
// Sets a machine's boat deadline to TTL from now. A listed machine is only ever moved later, and one with no auto-stop
// keeps none (extend --ttl would put a deadline on it), as boat-warm.mjs does for pool machines.
async function holdDeadline(vm) {
	if (!vm.created) {
		const info = JSON.parse(await boat(['info', vm.id, '--json'], { timeoutMs: 60_000, ...live })).sandbox ?? {};
		if (info.archiveAfter == null || Date.parse(info.archiveAfter) - Date.now() >= TTL_SECONDS * 1000 - 60_000) return;
	}
	await extendMachine(vm.id, TTL_SECONDS, live);
}
async function check(vm) {
	// A failed push is logged and tried again next pass; it does not count against the machine.
	if (Date.now() - (vm.extendedAt ?? 0) > EXTEND_EVERY_MS) {
		await holdDeadline(vm).then(() => { vm.extendedAt = Date.now(); }, e => log(`could not push back the deadline of ${vm.id}: ${e.message.split('\n')[0].slice(0, 200)}`));
	}
	if (!vm.prepared) { await prepare(vm); await log(`prepared ${vm.id}`); }
	// An idle machine that failed last time must answer before it counts as healthy again.
	if (!vm.game) { if (vm.failingSince) await remote(vm.id, 'true', { timeoutMs: 60_000, ...live }); return; }
	const game = games.find(g => g.id === vm.game);
	// pgrep first, the done file second: game.sh writes done as it exits, so the other order can miss both.
	const status = await remote(vm.id, `if pgrep -f 'ck/game.sh ${game.id} ' >/dev/null; then echo RUNNING; elif test -f ~/ck/games/${game.id}/done; then echo DONE; else echo GONE; fi`, { timeoutMs: 120_000, ...live });
	if (/GONE/.test(status) && game.timingOut) {
		// The hang timeout's kill ended game.sh but its own call dropped before it wrote done. run-long may still be
		// writing its report in the same session (game.sh's pid, which setsid made the session id): wait for that session
		// to end (up to 5 min), kill what is left, then finish the game the same way, so the report is copied home whole
		// and no next game starts beside the old one.
		await remote(vm.id, `d=~/ck/games/${game.id}; sid=$(cat "$d/sid" 2>/dev/null)
if [ -n "$sid" ]; then for i in $(seq 1 60); do pgrep -s "$sid" >/dev/null || break; sleep 5; done; pkill -KILL -s "$sid"; sleep 2; fi
${leftovers}
mkdir -p "$d"; echo "exit timeout $(date -Is)" > "$d/done"`, { timeoutMs: 10 * 60_000, ...live });
		await fetch(vm, game); vm.game = null; vm.goneInRow = 0;
		return;
	}
	if (/GONE/.test(status)) {
		// No done file and no game process: the launch never ran (its ssh dropped first) or the session was killed. The
		// game goes back to the queue once (loseGame), instead of idling until the hang timeout. Two in a row on one
		// machine (a full disk, a wiped ~/ck) drop the machine, so it cannot lose game after game. The launcher's server and
		// coordinator run in sessions of their own and can outlive game.sh, holding the game's ports: they are ended first,
		// and if that fails the machine keeps the game and the next pass tries again.
		await remote(vm.id, `sid=$(cat ~/ck/games/${game.id}/sid 2>/dev/null); [ -n "$sid" ] && pkill -KILL -s "$sid"\n${leftovers}`, { timeoutMs: 120_000, ...live });
		await copyOrHold(vm, game, { timeoutMs: 20 * 60_000, ...live });
		const g = loseGame(games, game.id, `game process on ${vm.id} ended without a done file`);
		await log(`${g.id} is not running on ${vm.id} and wrote no done file; it is ${g.state}`);
		// The game does not go back to this machine while another can take it (see the start loop).
		g.avoid = vm.id;
		vm.game = null;
		vm.goneInRow = (vm.goneInRow ?? 0) + 1;
		if (vm.goneInRow >= 2) { await log(`dropping ${vm.id}: ${vm.goneInRow} launches in a row ended without a done file`); await dropMachine(vm); }
		return;
	}
	if (!/DONE/.test(status) && Date.now() - Date.parse(game.startedAt) > (plan.minutes + 30) * 60_000) {
		// A game past its window plus half an hour is hung: end its session. run-long writes its partial timeline and report
		// on SIGTERM, which can take minutes, so wait for the session to end (up to 5 min) before killing what is left.
		game.timingOut = true;
		await remote(vm.id, `sid=$(ps -o sid= -p "$(pgrep -f 'ck/game.sh ${game.id} ' | head -1)" 2>/dev/null | tr -d ' ')
if [ -n "$sid" ]; then pkill -TERM -s "$sid"; for i in $(seq 1 60); do pgrep -s "$sid" >/dev/null || break; sleep 5; done; pkill -KILL -s "$sid"; sleep 2; fi
${leftovers}
mkdir -p ~/ck/games/${game.id}; echo "exit timeout $(date -Is)" > ~/ck/games/${game.id}/done`, { timeoutMs: 10 * 60_000, ...live });
		await log(`timed out ${game.id} on ${vm.id}`);
		await fetch(vm, game); vm.game = null; vm.goneInRow = 0;
		return;
	}
	// A running game proves the machine launches games: only launches that die in a row count against it.
	vm.goneInRow = 0;
	if (/RUNNING/.test(status) && game.stopWhen && !game.stoppedEarly) await stopIfAnswered(vm, game);
	if (/DONE/.test(status)) { await fetch(vm, game); vm.game = null; vm.goneInRow = 0; }
}
// stopWhen: lib/stop-when.mjs reads the game's protocol journal on its machine. Once the question is answered (or the bot
// is stuck), it records the reason as the game's operator stop and run-long gets a SIGTERM, the hang timeout's path:
// it saves the recording, writes its report and exits, game.sh writes done, and the next pass copies the game home and
// gives the machine the next queued game. A check that fails is logged and the game plays on.
async function stopIfAnswered(vm, game) {
	const spec = Buffer.from(JSON.stringify(game.stopWhen)).toString('base64');
	let answer;
	try { answer = (await remote(vm.id, `node ~/ck/stop-when.mjs ~/ck/games/${game.id} ${spec}`, { timeoutMs: 120_000, ...live })).trim().split('\n').pop(); }
	catch (error) { await log(`stopWhen check of ${game.id} on ${vm.id} failed: ${error.message.split('\n')[0].slice(0, 200)}; it plays on`); return; }
	if (!answer.startsWith('STOP ')) return;
	game.stoppedEarly = answer.slice(5);
	await remote(vm.id, `pkill -TERM -f "scripts/quality/run-long.mjs .*/ck/games/${game.id}/report" || true`, { timeoutMs: 60_000, ...live });
	await log(`stopping ${game.id} on ${vm.id} early, ${Math.round((Date.now() - Date.parse(game.startedAt)) / 60_000)} min in: ${game.stoppedEarly}`);
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
		const failed = async e => { await log(`machine creation failed: ${e.message.split('\n')[0].slice(0, 300)}`); return { id: 'none', lost: true }; };
		let vm = await addMachine('pool').catch(failed);
		// A machine that could not be made is replaced by a spare while spares are left.
		while (vm.lost && spares > 0 && !stopped) { spares--; vm = await addMachine('replacement').catch(failed); }
		machines.push(vm);
		await save().catch(error => log(`could not write the state: ${error.message}`));
	}
	await log(`batch: ${games.length} games, ${plan.minutes} min, ${machines.length} machines, deadline ${plan.deadline}`);
	// Prepare every machine at once (about a minute each), so the first wave starts together; one that fails is retried in the loop.
	await Promise.all(machines.filter(vm => vm.id !== 'none').map(vm => prepare(vm).then(() => { vm.failingSince = null; return log(`prepared ${vm.id}`); }, error => log(`machine ${vm.id}: ${error.message.split('\n')[0].slice(0, 300)}`))));
	while (!aborted) {
	await eachLimited(machines.filter(m => !m.lost && !m.deleted), copyLimit, vm => aborted ? null : tend(vm, () => check(vm)));
	// Starts stay one at a time, so two machines never take the same game.
	for (const vm of machines.filter(m => !m.lost && !m.deleted && m.prepared && !m.game)) {
		if (aborted) break;
		if (noMoreGames()) { await tend(vm, () => retire(vm)); continue; }
		// A game that went GONE on a machine waits for another one, unless no other live machine is left.
		const others = machines.some(m => m !== vm && !m.lost && !m.deleted);
		if (underCap() && await meterOk()) await tend(vm, async () => { const game = nextGame(others ? games.filter(g => g.avoid !== vm.id) : games); if (game) await start(vm, game); });
	}
	// A failed local write (a full disk) is retried next pass; the state in memory is complete.
	await save().then(() => writeSummary(out, state)).catch(error => log(`could not write the state: ${error.message}`));
	const running = machines.some(m => m.game && !m.lost);
	// With no live machine left, a queued game can never start (spares are made only to replace a machine as it is lost
	// or fails to be made): the batch ends instead of waiting for the deadline.
	const usable = machines.some(m => !m.lost && !m.deleted);
	const startable = usable && !stopped && !meterLow && !existsSync(path.join(out, 'STOP')) && canStart(Date.now(), plan) && nextGame(games);
	if (aborted || (!running && !startable)) break;
	await new Promise(resolve => { wake = resolve; setTimeout(resolve, POLL_MS); });
	}
} catch (error) { crash = error; await log(`batch stopped by an error: ${error.stack ?? error.message}`); }
if (aborted) await log('second signal: ending running games and cleaning up');
for (const g of games.filter(g => g.state === 'queued')) g.state = 'not started';
// Every machine of the batch, lost and half-prepared ones included (one that comes back must not keep it), all at once so
// a stop by SIGTERM finishes before its sender kills the runner. A step that fails (boat out as the batch ends) is tried
// again until the machine is clean or boat says it is gone: for up to TTL_SECONDS (a created machine is stopped and
// erased by then), or for CHECKPOINT_SIGNAL_BUDGET_MS (60 s) after a signal, whose sender kills the runner soon after.
const cleanupFrom = Date.now();
await Promise.all(machines.filter(m => m.id !== 'none' && !m.deleted).map(async vm => {
	const bound = () => aborted ? Math.max(abortedAt, cleanupFrom) + SIGNAL_BUDGET_MS : cleanupFrom + TTL_SECONDS * 1000;
	for (let pass = 1; ; pass++) {
		// A game still running here (an error or a second signal ended the loop; a lost machine that came back) is ended
		// first, so no session keeps playing on a machine whose sign-in is about to go, or one that is kept for reuse.
		const endSessions = (vm.game || vm.lost) && !vm.sessionsEnded;
		// The first pass takes the sign-in off whatever the flag says; later passes only retry a failed removal.
		const removeSignIn = pass === 1 || !vm.signInRemoved;
		// Before a signal each call carries it, so a SIGTERM cuts the call in flight. After one, every call (the first
		// pass's too) gets a share of the time left before the bound, worked out as it starts: the time left over the
		// steps still to run, so a stalled step cannot use up the time the sign-in removal and the deletion need.
		// A game ended here gets no normal copy: its recordings and world are copied first, and a machine whose copy failed
		// is kept (its boat deadline still ends it) so they can be copied by hand.
		const cleanupGame = vm.game && !vm.lost && games.find(g => g.id === vm.game);
		if (cleanupGame && keepsWorlds && !vm.cleanupQueued) { vm.cleanupQueued = true; if (!(vm.uncopied ?? []).includes(cleanupGame.id)) vm.uncopied = [...(vm.uncopied ?? []), cleanupGame.id]; }
		const salvageDue = copiesLeft(vm);
		let steps = [endSessions, salvageDue, removeSignIn, deletes(vm)].filter(Boolean).length;
		const opts = (capMs = Infinity) => {
			const share = aborted ? { timeoutMs: Math.max(1_000, Math.min(capMs, Math.floor((bound() - Date.now()) / Math.max(1, steps)))) } : { ...live, ...(capMs < Infinity ? { timeoutMs: capMs } : {}) };
			steps--;
			return share;
		};
		if (endSessions) await remote(vm.id, stopGamesScript, opts(180_000)).then(() => { vm.sessionsEnded = true; return log(`ended the game sessions on ${vm.id}`); }, e => log(`could not end the game sessions on ${vm.id}: ${e.message.split('\n')[0]}`));
		if (salvageDue && (vm.sessionsEnded || !endSessions)) await retryCopies(vm, opts(20 * 60_000));
		else if (salvageDue) steps--;
		const holdForCopy = holds(vm);
		if (removeSignIn) await removeCodexSignIn(vm.id, undefined, opts()).then(() => { vm.signInRemoved = true; return log(`removed the sign-in from ${vm.id}`); }, e => { vm.signInRemoved = false; return log(`could not remove the sign-in from ${vm.id}: ${e.message}`); });
		// Batch-created extras (and every machine under drain "delete") are deleted, never left idle.
		if (deletes(vm) && !holdForCopy) await destroyMachine(vm.id, opts()).then(() => { vm.deleted = true; return log(`deleted ${vm.id}`); }, e => log(`could not delete ${vm.id}: ${e.message}`));
		else if (deletes(vm)) steps--;
		if (vm.deleted || (vm.signInRemoved && !deletes(vm) && !holdForCopy && (vm.sessionsEnded || !(vm.game || vm.lost)))) return;
		// A held machine is left once its sign-in is off and no copy is left to retry here.
		if (holdForCopy && vm.signInRemoved && !copiesLeft(vm)) return;
		if (Date.now() >= bound() - (aborted ? 5_000 : 0)) return;
		// A machine boat no longer knows took its sign-in with it; a stopped one keeps its disk, so it is named at the end.
		const gone = await machineState(vm.id, aborted ? { timeoutMs: Math.max(1_000, bound() - Date.now()) } : live).then(s => LIVE.has(s) ? null : s ?? 'unknown', e => NOT_FOUND.test(e.message) ? 'not found' : null);
		if (gone) { vm.gone = gone; await log(`${vm.id} is ${gone} on boat: nothing more to clean there`); return; }
		if (Date.now() >= bound() - (aborted ? 5_000 : 0)) return;
		await pause(aborted ? 5_000 : Math.min(POLL_MS, 30_000));
	}
}));
for (const g of games.filter(g => g.state === 'running')) g.state = 'not finished';
state.endedAt = new Date().toISOString();
await save().then(() => writeSummary(out, state)).catch(error => log(`could not write the final state: ${error.message}`));
await log(`batch ended; machines not deleted: ${machines.filter(m => m.id !== 'none' && !m.deleted).map(m => `${m.id}${m.lost ? ' (lost)' : ''}${m.created ? '' : ' (listed, kept)'}${holds(m) ? ` (kept: copy the recordings and world from the run folder named in run.log of ${[m.heldGame, ...(m.uncopied ?? []), ...(m.heldDirs ?? [])].filter(Boolean).map(d => `~/ck/games/${d}`).join(', ')}, then delete it)` : ''}`).join(' ') || 'none'}`);
// state.json keeps signInRemoved for every machine; one still holding a sign-in is named here and fails the run.
const signedIn = machines.filter(m => m.id !== 'none' && !m.deleted && !m.signInRemoved && !['not found', 'deleted'].includes(m.gone));
if (signedIn.length) { await log(`SIGN-IN MAY STILL BE ON: ${signedIn.map(m => `${m.id}${m.gone ? ` (${m.gone} on boat)` : ''}`).join(' ')}; take it off by hand (rm ~/.codex/auth.json and ~/ck)`); process.exitCode = 1; }
console.log(await readFile(path.join(out, 'summary.txt'), 'utf8').catch(() => ''));
if (crash) process.exitCode = 1;
