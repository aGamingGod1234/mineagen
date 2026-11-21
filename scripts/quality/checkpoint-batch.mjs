// Plays real-model games from save points on boat machines, one game per machine, and scores each from its long-run.json.
//   node scripts/quality/checkpoint-batch.mjs --plan PLAN.json --out FRESH_DIR [--dry-run]
//   node scripts/quality/checkpoint-batch.mjs --score OUT_DIR        (rescore the games already copied back)
//   touch OUT_DIR/STOP                                               (start no new game; running games finish)
// PLAN.json (paths absolute; keep it outside the checkout, since it names the sign-in folder):
//   { "minutes": 90, "deadline": "2026-11-22T01:00:00+08:00", "model": "gpt-6.2-sol", "effort": "low",
//     "codexHome": "/folder/holding/auth.json", "snapshot": "mineagen-rooms-263", "type": "default",
//     "vms": ["bx_..."], "create": 4, "spares": 2, "name": "ckpt-night",
//     "arms": { "main": { "root": "/checkout", "ref": "COMMIT", "jar": "/main.jar", "env": {} }, "int": { ... } },
//     "savepoints": { "nether": { "file": "/sp/9-nether-entry-123456789-v2.json", "repeats": 4, "targets": ["fortress", "blaze_rod"] } } }
// Each arm is `git archive REF` of its root plus that root's coordinator/node_modules, and its jar. Every repeat of a
// save point draws one loot salt that all arms share (lib/checkpoint-batch-core.mjs). A game runs scripts/quality/run-long.mjs
// --checkpoint under eatmydata (boat disks sync slowly; see lib/boat-pool.mjs) with the Codex provider, the observer cap in
// log mode and the arm's env. Machines are created with --no-auto-stop and are never stopped or deleted here: boat starts
// are the scarce resource, so they stay up for reuse. The sign-in is copied to each machine, checked against its source
// hash after every game (a changed hash means Codex refreshed it there, which can sign out the source machine, so no new
// game starts), kept out of every copy-back, and removed from every machine when the batch ends.
// Output: OUT/games/ID/{run.log,report/long-run.json,raw/...}, OUT/state.json, OUT/summary.json, OUT/summary.txt, OUT/batch.log.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMachine, download, machineState, quote, remote, upload } from './lib/boat-pool.mjs';
import { canStart, expandPlan, loseGame, nextGame, scoreGame, summarize, summaryText } from './lib/checkpoint-batch-core.mjs';

const USAGE = 'Usage: checkpoint-batch.mjs --plan PLAN.json --out FRESH_DIR [--dry-run] | --score OUT_DIR';
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help') || (!flag('score') && (!flag('plan') || !flag('out')))) { console.log(USAGE); process.exit(args.includes('--help') ? 0 : 2); }

const POLL_MS = 60_000, LOST_AFTER_MS = 5 * 60_000, LIVE = new Set(['provisioned', 'cloning', 'ready', 'idle', 'running']);
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

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
const authFile = path.join(plan.codexHome, 'auth.json');
if (!existsSync(authFile)) throw new Error(`no Codex sign-in at ${authFile}`);
for (const [name, point] of Object.entries(plan.savepoints)) if (!existsSync(point.file)) throw new Error(`save point ${name}: no file ${point.file}`);
for (const [name, arm] of Object.entries(plan.arms)) {
	if (!existsSync(arm.jar)) throw new Error(`arm ${name}: no jar ${arm.jar}`);
	if (!existsSync(path.join(arm.root, 'coordinator/node_modules'))) throw new Error(`arm ${name}: ${arm.root} has no coordinator/node_modules`);
	execFileSync('git', ['-C', arm.root, 'cat-file', '-e', `${arm.ref}^{commit}`]);
}
if (args.includes('--dry-run')) {
	for (const g of games) console.log(`${g.id} salt ${g.salt}`);
	console.log(`${games.length} games, ${plan.minutes} min each, last start ${new Date(Date.parse(plan.deadline) - (plan.minutes + 10) * 60_000).toISOString()}`);
	process.exit(0);
}
if (existsSync(out) && (await readdir(out)).length) throw new Error(`${out} is not empty: use a fresh folder`);
await mkdir(path.join(out, 'games'), { recursive: true });
await mkdir(path.join(out, 'pkg'), { recursive: true });
const log = async line => { const text = `${new Date().toISOString()} ${line}`; console.log(text); await appendFile(path.join(out, 'batch.log'), `${text}\n`).catch(() => {}); };
const authSha = sha(authFile);
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

const state = { plan: { ...plan, codexHome: '(private)' }, startedAt: new Date().toISOString(), codexVersion, arms: pkgs, games, machines: [] };
const save = async () => { await writeFile(path.join(out, 'state.json.tmp'), JSON.stringify(state, null, 2)); await rename(path.join(out, 'state.json.tmp'), path.join(out, 'state.json')); };
let created = 0, spares = plan.spares ?? 0, stopped = false, signInChanged = false;
process.on('SIGINT', () => { stopped = true; }); process.on('SIGTERM', () => { stopped = true; });

async function prepare(vm) {
	await remote(vm.id, `set -e; mkdir -p ~/ck/arms ~/ck/sp ~/ck/games ~/.codex; chmod 700 ~/.codex; command -v eatmydata >/dev/null; test -x ~/rooms/jdk/bin/java
[ "$(~/.local/bin/codex --version 2>/dev/null | awk '{print $NF}')" = ${quote(codexVersion)} ] || npm i -g --prefix ~/.local @openai/codex@${quote(codexVersion)} >/dev/null 2>&1; ~/.local/bin/codex --version >/dev/null`, { timeoutMs: 15 * 60_000 });
	await upload(vm.id, authFile, '.codex/auth.json');
	await remote(vm.id, 'chmod 600 ~/.codex/auth.json');
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
	const vm = await createMachine({ from: plan.snapshot ?? 'mineagen-rooms-263', type: plan.type ?? 'default', ttlSeconds: 86_400, name: `${plan.name ?? 'ckpt'}-${++created}`, snapshots: false, noAutoStop: true });
	await log(`created machine ${vm.id} (${kind})`);
	return { id: vm.id, created: true };
}

async function start(vm, game) {
	game.state = 'running'; game.attempts++; game.machine = vm.id; game.startedAt = new Date().toISOString(); vm.game = game.id; vm.lastSeen = Date.now();
	await remote(vm.id, `rm -rf ~/ck/games/${game.id}; mkdir -p ~/ck/games/${game.id}\nsetsid nohup ~/ck/game.sh ${game.id} ${game.arm} "$HOME/ck/sp/${game.savepoint}.json" ${plan.minutes} ${game.salt} ${quote(plan.model ?? 'gpt-6.2-sol')} ${quote(plan.effort ?? 'low')} > /dev/null 2>&1 < /dev/null &\necho started`);
	await log(`started ${game.id} on ${vm.id} (salt ${game.salt}, attempt ${game.attempts})`);
}

async function fetch(vm, game) {
	// The raw run folder is copied without the world, the per-run Codex home (it holds a copy of the sign-in) or RCON secrets.
	const text = await remote(vm.id, `cd ~/ck/games/${game.id}; raw=$(sed -n 's/^Running [^:]*: //p' run.log | tail -1)
if [ -n "$raw" ] && [ -d "$raw" ]; then rm -rf raw; mkdir raw; tar -C "$raw" --exclude=server --exclude=.codex-home --exclude=auth.json --exclude=rcon-password.txt --exclude=secret.txt -cf - . | tar -C raw -xf -; rm -rf "$raw/server"; fi
tar --exclude=auth.json --exclude=.codex-home -czf ../${game.id}.tgz . && echo ok; sha256sum ~/.codex/auth.json | cut -c1-64`, { timeoutMs: 15 * 60_000 });
	const remoteSha = text.trim().split('\n').pop();
	if (remoteSha !== authSha) { signInChanged = true; await log(`SIGN-IN CHANGED on ${vm.id}: Codex refreshed it there; no new game starts`); }
	const dest = path.join(out, 'games', game.id);
	await rm(dest, { recursive: true, force: true }); await mkdir(dest, { recursive: true });
	await download(vm.id, `ck/games/${game.id}.tgz`, path.join(dest, 'copy.tgz'));
	execFileSync('tar', ['-xzf', path.join(dest, 'copy.tgz'), '-C', dest]);
	await rm(path.join(dest, 'copy.tgz'));
	execFileSync('find', [dest, '-name', 'auth.json', '-delete']);
	game.done = (await readFile(path.join(dest, 'done'), 'utf8').catch(() => 'missing')).trim();
	game.score = await scoreFrom(out, game, plan);
	game.state = 'done'; game.endedAt = new Date().toISOString();
	await log(`finished ${game.id}: ${game.done}; ${JSON.stringify(game.score.targets)} deaths ${game.score.deaths ?? 'unknown'}`);
}

async function scoreFrom(dir, game, p) {
	const file = path.join(dir, 'games', game.id, 'report', 'long-run.json');
	const report = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
	return scoreGame(report, p.savepoints[game.savepoint].targets);
}

async function writeSummary(dir, s) {
	const rows = summarize(s.games, s.plan);
	await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ rows, games: s.games.map(g => ({ id: g.id, state: g.state, salt: g.salt, machine: g.machine, attempts: g.attempts, done: g.done, score: g.score })) }, null, 2));
	await writeFile(path.join(dir, 'summary.txt'), `${summaryText(rows)}\n`);
}

// Machines: the listed ones, then new ones.
const machines = state.machines;
for (const id of plan.vms ?? []) machines.push({ id, created: false });
for (let i = 0; i < (plan.create ?? 0); i++) machines.push(await addMachine('pool'));
await save();
await log(`batch: ${games.length} games, ${plan.minutes} min, ${machines.length} machines, deadline ${plan.deadline}`);

while (true) {
	for (const vm of machines.filter(m => !m.lost)) {
		try {
			if (!vm.prepared) { await prepare(vm); await log(`prepared ${vm.id}`); }
			vm.lastSeen = Date.now();
			if (vm.game) {
				const game = games.find(g => g.id === vm.game);
				const status = await remote(vm.id, `test -f ~/ck/games/${game.id}/done && echo DONE || echo RUNNING`, { timeoutMs: 120_000 });
				if (!/DONE/.test(status) && Date.now() - Date.parse(game.startedAt) > (plan.minutes + 30) * 60_000) {
					// A game past its window plus half an hour is hung: end its session (run-long writes its partial timeline on SIGTERM).
					await remote(vm.id, `sid=$(ps -o sid= -p "$(pgrep -f 'ck/game.sh ${game.id} ' | head -1)" 2>/dev/null | tr -d ' '); [ -n "$sid" ] && pkill -TERM -s "$sid"; sleep 20; echo "exit timeout $(date -Is)" > ~/ck/games/${game.id}/done`);
					await log(`timed out ${game.id} on ${vm.id}`);
				}
				if (/DONE/.test(status)) { await fetch(vm, game); vm.game = null; }
			}
			if (!vm.game && !stopped && !signInChanged && !existsSync(path.join(out, 'STOP')) && canStart(Date.now(), plan)) {
				const game = nextGame(games);
				if (game) await start(vm, game);
			}
		} catch (error) {
			await log(`machine ${vm.id}: ${error.message.split('\n')[0].slice(0, 300)}`);
			const gone = await machineState(vm.id).then(s => !LIVE.has(s)).catch(() => false);
			if (gone || Date.now() - (vm.lastSeen ?? Date.now()) > LOST_AFTER_MS) {
				vm.lost = true;
				if (vm.game) { const g = loseGame(games, vm.game, `machine ${vm.id} stopped answering`); await log(`lost ${vm.id}; ${g.id} is ${g.state}`); vm.game = null; }
				if (spares > 0 && canStart(Date.now(), plan)) { spares--; machines.push(await addMachine('replacement').catch(async e => { await log(`replacement failed: ${e.message}`); return { id: 'none', lost: true }; })); }
			}
		}
	}
	await save(); await writeSummary(out, state);
	const running = machines.some(m => m.game && !m.lost);
	const startable = !stopped && !signInChanged && !existsSync(path.join(out, 'STOP')) && canStart(Date.now(), plan) && nextGame(games);
	if (!running && !startable) break;
	await new Promise(resolve => setTimeout(resolve, POLL_MS));
}
for (const g of games.filter(g => g.state === 'queued')) g.state = 'not started';
for (const vm of machines.filter(m => !m.lost && m.prepared)) {
	await remote(vm.id, 'rm -f ~/.codex/auth.json; find ~/ck -name auth.json -delete; find ~/ck -type d -name .codex-home -prune -exec rm -rf {} +').then(() => log(`removed the sign-in from ${vm.id}`)).catch(e => log(`could not remove the sign-in from ${vm.id}: ${e.message}`));
}
state.endedAt = new Date().toISOString();
await save(); await writeSummary(out, state);
await log(`batch ended; machines left running: ${machines.filter(m => !m.lost).map(m => m.id).join(' ')}`);
console.log(await readFile(path.join(out, 'summary.txt'), 'utf8'));
