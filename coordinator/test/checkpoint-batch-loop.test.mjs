import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeCodexSignIn } from '../../scripts/quality/lib/boat-pool.mjs';

// Drives scripts/quality/checkpoint-batch.mjs end to end against a fake boat CLI (BOAT_BIN): each "machine" is a folder
// used as HOME, ssh runs the command there, scp copies files, delete marks the machine gone. The fake game writes a
// report and a run folder holding the game's own copy of the sign-in, the way the coordinator's workspace does.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repo, 'scripts/quality/checkpoint-batch.mjs');

const FAKE_BOAT = `#!/bin/bash
F=$FAKE_BOAT_ROOT; [ "$1" = --no-update ] && shift; cmd=$1; shift
# An OUTAGE file makes boat unreachable from this side; a VANISH file in a machine's home makes boat forget the machine.
[ -f "$F/OUTAGE" ] && { echo "connection refused" >&2; exit 1; }
[ -f "$F/$1/VANISH" ] && { echo "sandbox not found: $1" >&2; exit 1; }
map() { case $1 in bx_*:*) echo "$F/\${1%%:*}/\${1#*:}";; *) echo "$1";; esac; }
seed() { mkdir -p "$1/rooms/jdk/bin" "$1/.local/bin"; : > "$1/rooms/jdk/bin/java"; chmod +x "$1/rooms/jdk/bin/java"; printf '#!/bin/bash\\necho codex-cli 0.1.0\\n' > "$1/.local/bin/codex"; chmod +x "$1/.local/bin/codex"; }
case $cmd in
  ssh) id=$1; shift; [ "$1" = -- ] && shift; [ -f "$F/$id.deleted" ] && { echo gone >&2; exit 255; }
    # A STALLSSH file makes every ssh hang for minutes in a child that holds the pipes, as a stalled ssh under boat does.
    [ -f "$F/STALLSSH" ] && { sleep 300.5; exit 1; }
    # A STALL_AT_SIGNOFF file makes every sign-in removal hang the same way (logged in stalled.log).
    if [ -f "$F/STALL_AT_SIGNOFF" ] && printf '%s' "$*" | sed -n 's/.*echo \\([A-Za-z0-9+\/=]*\\) | base64 -d.*/\\1/p' | base64 -d 2>/dev/null | grep -q 'rm -f ~/.codex/auth.json'; then
      echo "$id" >> "$F/stalled.log"; sleep 300.5; exit 1; fi
    # An OUTAGE_AT_SIGNOFF file starts a 3 s boat outage at the first sign-in removal (an outage as the batch ends).
    if [ -f "$F/OUTAGE_AT_SIGNOFF" ] && printf '%s' "$*" | sed -n 's/.*echo \\([A-Za-z0-9+\/=]*\\) | base64 -d.*/\\1/p' | base64 -d 2>/dev/null | grep -q 'rm -f ~/.codex/auth.json'; then
      rm -f "$F/OUTAGE_AT_SIGNOFF"; touch "$F/OUTAGE"; (sleep 3; rm -f "$F/OUTAGE") > /dev/null 2>&1 < /dev/null & echo "connection refused" >&2; exit 1; fi
    o=$(cd "$F/$id" && HOME="$F/$id" bash -c "$*"); rc=$?
    # A DROPSTART file loses the answer to the first game launch there (the game itself starts), as when ssh drops.
    if [ -f "$F/$id/DROPSTART" ] && printf '%s\n' "$o" | grep -qx started; then rm -f "$F/$id/DROPSTART"; exit 255; fi
    printf '%s\n' "$o"; exit $rc;;
  scp) s=$(map "$1"); d=$(map "$2"); mkdir -p "$(dirname "$d")"
    # A NOAUTH file in a prepared machine's home makes every sign-in upload for a game fail while ssh still works.
    case $2 in *:.codex/auth.json) h=$F/\${2%%:*}; [ -f "$h/NOAUTH" ] && [ -f "$h/ck/game.sh" ] && { echo "scp failed" >&2; exit 1; };; esac
    # A BLOCKSCP file makes every upload of an arm package hang for minutes, as a slow transfer does.
    case $2 in *:ck/arms/*.tar.gz) [ -f "$F/BLOCKSCP" ] && { echo "blocked $2" >> "$F/blocked.log"; sleep 300; };; esac
    case $2 in *:ck/game.sh) cp "$F/fake-game.sh" "$d";; *) cp "$s" "$d";; esac;;
  info) [ -f "$F/$1.deleted" ] && echo '{"sandbox":{"state":"deleted"}}' || printf '{"sandbox":{"state":"running","name":"%s"}}\\n' "$(cat "$F/$1.name" 2>/dev/null)";;
  delete) touch "$F/$1.deleted"; echo "$1" >> "$F/deleted.log"; echo '{}';;
  new) echo "new $*" >> "$F/new.log"; [ -f "$F/NEWFAIL" ] && { rm -f "$F/NEWFAIL"; echo "no capacity" >&2; exit 1; }; n=$(ls "$F" | grep -c '^bx_new'); id=bx_new$n; seed "$F/$id"; printf '{"event":"ready","id":"%s"}\\n' "$id";;
  extend) echo "extend $*" >> "$F/extend.log"; echo '{}';;
  list) echo '{"sandboxes":[]}';;
  *) echo "fake boat: $cmd not handled" >&2; exit 2;;
esac
`;
// game.sh ID ARM SP MINUTES SALT MODEL EFFORT; the run folder sits under ~/ck like a real one. A REFRESH file in the fake root makes the game's own sign-in copy change.
const FAKE_GAME = `#!/bin/bash
id=$1; dir=$HOME/ck/games/$id; raw=$HOME/ck/arms/runs/$id; mkdir -p "$raw/.codex-home" "$raw/server" "$dir/report"; echo world > "$raw/server/level.dat"
# A NODONE file makes each game's first launch end without a done file, as when the launch ssh dropped first.
# A LEFTOVER file also leaves a detached process of that launch running (the launcher's server and coordinator).
[ -f "$FAKE_BOAT_ROOT/NODONE" ] && [ ! -f "$FAKE_BOAT_ROOT/nodone-$id" ] && { touch "$FAKE_BOAT_ROOT/nodone-$id"; if [ -f "$FAKE_BOAT_ROOT/LEFTOVER" ]; then setsid bash -c "sleep 300; : $HOME/ck/arms/leftover-$id" > /dev/null 2>&1 < /dev/null & fi; exit 0; }
# A BROKEN file in a machine's home makes every launch there end without a done file (a full disk, a wiped ~/ck).
[ -f "$HOME/BROKEN" ] && exit 0
# A SLOW file keeps each game on that machine running across a few passes; a HANG file keeps it running for minutes.
[ -f "$HOME/SLOW" ] && sleep 1
[ -f "$HOME/VANISH_ON_START" ] && { touch "$HOME/VANISH"; sleep 30; }
[ -f "$HOME/HANG" ] && sleep 300
cp "$HOME/.codex/auth.json" "$raw/.codex-home/auth.json"; [ -f "$FAKE_BOAT_ROOT/REFRESH" ] && echo refreshed >> "$raw/.codex-home/auth.json"
echo '{"event":"native_token_usage"}' > "$raw/coordinator.jsonl"
echo "Running q: $raw" > "$dir/run.log"; echo '{}' > "$dir/ledger.json"
echo '{"measurementStatus":"INCOMPLETE","timeline":{"startedAt":1795290758148,"playedMs":60000,"stopReason":"WALL_CLOCK_BUDGET","milestones":[{"id":"fortress","reached":true,"elapsedMs":120000}],"deaths":[{"cause":"lava"}]}}' > "$dir/report/long-run.json"
echo "exit 0 $(date -Is)" > "$dir/done"
`;

function setup({ refresh = false, plan: overrides = {} } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), 'ckpt-loop-'));
	const bin = path.join(root, 'bin'); mkdirSync(bin);
	writeFileSync(path.join(bin, 'boat'), FAKE_BOAT); chmodSync(path.join(bin, 'boat'), 0o755);
	writeFileSync(path.join(bin, 'codex'), '#!/bin/bash\necho codex-cli 0.1.0\n'); chmodSync(path.join(bin, 'codex'), 0o755);
	writeFileSync(path.join(bin, 'eatmydata'), '#!/bin/bash\nexec "$@"\n'); chmodSync(path.join(bin, 'eatmydata'), 0o755);
	writeFileSync(path.join(root, 'fake-game.sh'), FAKE_GAME);
	if (refresh) writeFileSync(path.join(root, 'REFRESH'), '');
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) {
		const home = path.join(root, id);
		mkdirSync(path.join(home, 'rooms/jdk/bin'), { recursive: true }); writeFileSync(path.join(home, 'rooms/jdk/bin/java'), ''); chmodSync(path.join(home, 'rooms/jdk/bin/java'), 0o755);
		mkdirSync(path.join(home, '.local/bin'), { recursive: true }); writeFileSync(path.join(home, '.local/bin/codex'), '#!/bin/bash\necho codex-cli 0.1.0\n'); chmodSync(path.join(home, '.local/bin/codex'), 0o755);
	}
	// A tiny arm checkout (the batch packs git archive REF plus coordinator/node_modules).
	const arm = path.join(root, 'arm'); mkdirSync(path.join(arm, 'coordinator/node_modules'), { recursive: true });
	writeFileSync(path.join(arm, 'README'), 'arm\n'); writeFileSync(path.join(arm, 'coordinator/node_modules/x.js'), '');
	execFileSync('git', ['init', '-q', arm]); execFileSync('git', ['-C', arm, 'add', 'README']);
	execFileSync('git', ['-C', arm, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'arm']);
	writeFileSync(path.join(root, 'mod.jar'), 'jar'); writeFileSync(path.join(root, 'sp.json'), '{}');
	mkdirSync(path.join(root, 'signin')); writeFileSync(path.join(root, 'signin/auth.json'), '{"tokens":"fake"}');
	const plan = { minutes: 1, deadline: new Date(Date.now() + 3 * 3_600_000).toISOString(), codexHome: path.join(root, 'signin'),
		vms: ['bx_aaaaaaaa', 'bx_bbbbbbbb'], drain: 'delete', copyConcurrency: 2,
		arms: { main: { root: arm, ref: 'HEAD', jar: path.join(root, 'mod.jar') }, other: { root: arm, ref: 'HEAD', jar: path.join(root, 'mod.jar'), env: { A_SWITCH: 'on', B_SWITCH: '2' } } },
		savepoints: { nether: { file: path.join(root, 'sp.json'), repeats: 2, targets: ['fortress'] } } };
	writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ ...plan, ...overrides }));
	return root;
}
const run = (root, env = {}) => execFileSync('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
	env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', ...env },
	encoding: 'utf8', timeout: 120_000 });
// The fake boat CLI and fake games are bash scripts; the batch itself runs only from Linux or macOS hosts.
const posixOnly = { skip: process.platform === 'win32' ? 'the fake boat CLI is a bash script' : false };
const leftSignIns = root => execFileSync('bash', ['-c', `find ${root}/bx_* \\( -name auth.json -o -name .codex-home \\) | wc -l`], { encoding: 'utf8' }).trim();

test('checkpoint batch copies every game home, writes each env switch on its own line, and deletes drained machines', posixOnly, () => {
	const root = setup();
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.score.known && g.score.targets.fortress === 2 && g.score.deaths === 1));
		for (const g of state.games) {
			const listing = execFileSync('tar', ['-tzf', path.join(root, 'out/games', g.id, 'game.tgz')], { encoding: 'utf8' });
			assert.match(listing, /raw\/coordinator\.jsonl/); assert.doesNotMatch(listing, /auth\.json|\.codex-home|level\.dat/);
		}
		assert.equal(readFileSync(path.join(root, 'bx_aaaaaaaa/ck/arms/other/env'), 'utf8'), 'A_SWITCH=on\nB_SWITCH=2\n');
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch stops starting games when the game\'s own sign-in copy was refreshed', posixOnly, () => {
	const root = setup({ refresh: true });
	try {
		run(root);
		const log = readFileSync(path.join(root, 'out/batch.log'), 'utf8');
		assert.match(log, /SIGN-IN CHANGED on bx_[a-z]+ \(the game's own copy\)/);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'not started', 'not started']);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch gives created machines a boat deadline and deletes them at the end', posixOnly, () => {
	const root = setup({ plan: { vms: [], create: 2, drain: undefined } });
	try {
		run(root);
		const news = readFileSync(path.join(root, 'new.log'), 'utf8').trim().split('\n');
		assert.equal(news.length, 2);
		for (const line of news) { assert.match(line, /--ttl 7200\b/); assert.doesNotMatch(line, /--no-auto-stop/); }
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_new0', 'bx_new1']);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch puts a game back in the queue when its launch never ran, without dropping the machine', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'NODONE'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.attempts === 2));
		assert.ok(state.machines.every(m => !m.lost));
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /wrote no done file/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch refuses to play on a warm-pool machine', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'bx_bbbbbbbb.name'), 'rbpool-abc-default-rooms-0123abcd-ff');
	try {
		assert.throws(() => run(root), /warm-pool machine/);
		assert.equal(existsSync(path.join(root, 'out/state.json')), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch drops a machine whose launches end without a done file twice in a row, and plays on the rest', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'bx_bbbbbbbb/BROKEN'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.machine === 'bx_aaaaaaaa'), 'every game finished on the healthy machine');
		assert.equal(state.machines.find(m => m.id === 'bx_bbbbbbbb').lost, true);
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /dropping bx_bbbbbbbb: 2 launches in a row/);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch does not hand a game back to the machine it just died on while another machine can take it', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'bx_bbbbbbbb/BROKEN'), ''); writeFileSync(path.join(root, 'bx_aaaaaaaa/SLOW'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.machine === 'bx_aaaaaaaa' && g.attempts <= 2));
		assert.equal(state.machines.find(m => m.id === 'bx_bbbbbbbb').lost, true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch drops machines whose game launches keep failing while ssh still answers, instead of idling to the deadline', posixOnly, () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'NOAUTH'), '');
	try {
		run(root, { CHECKPOINT_LOST_AFTER_MS: '1500' });
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['not started', 'not started', 'not started', 'not started']);
		assert.ok(state.machines.every(m => m.lost && m.deleted));
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /dropping bx_aaaaaaaa: its launches keep failing/);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch keeps a machine whose launch answer was lost while its game still ran', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'bx_aaaaaaaa/DROPSTART'), '');
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'SLOW'), '');
	try {
		run(root, { CHECKPOINT_LOST_AFTER_MS: '300' });
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.machines.every(m => !m.lost));
		assert.ok(state.games.filter(g => g.machine === 'bx_aaaaaaaa').length >= 2, 'the machine took a game after the lost answer');
		assert.ok(!existsSync(path.join(root, 'bx_aaaaaaaa/DROPSTART')), 'the lost answer happened');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch never packs a game whose raw journals failed to copy, and keeps its world on the machine', posixOnly, () => {
	// Listed machines are kept to the end here, so the healthy one is still there to replay the game the broken one lost.
	const root = setup({ plan: { drain: undefined } });
	// A tar that fails to unpack the raw journals on bx_bbbbbbbb only, as on a full disk.
	const realTar = execFileSync('bash', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
	writeFileSync(path.join(root, 'bin/tar'), `#!/bin/bash\nif [ "$*" = "-C raw -xf -" ] && [ -f "$HOME/BADSTAGE" ]; then cat > /dev/null; exit 2; fi\nexec ${realTar} "$@"\n`);
	chmodSync(path.join(root, 'bin/tar'), 0o755);
	writeFileSync(path.join(root, 'bx_bbbbbbbb/BADSTAGE'), '');
	try {
		run(root, { CHECKPOINT_LOST_AFTER_MS: '1500' });
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.machine === 'bx_aaaaaaaa'), 'every scored game was packed on the healthy machine');
		assert.ok(state.games.some(g => g.attempts === 2), 'the game lost with the broken machine was played again');
		assert.equal(state.machines.find(m => m.id === 'bx_bbbbbbbb').lost, true);
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /could not pack .* \(copying its raw journals failed\)/);
		const worlds = dir => readdirSync(path.join(root, dir, 'ck/arms/runs')).filter(id => existsSync(path.join(root, dir, 'ck/arms/runs', id, 'server/level.dat')));
		assert.ok(worlds('bx_bbbbbbbb').length >= 1, 'the failed game keeps its world');
		assert.deepEqual(worlds('bx_aaaaaaaa'), []);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch replaces a machine it could not make with a spare', posixOnly, () => {
	const root = setup({ plan: { vms: [], create: 1, spares: 1, drain: undefined } });
	writeFileSync(path.join(root, 'NEWFAIL'), '');
	try {
		run(root);
		assert.equal(readFileSync(path.join(root, 'new.log'), 'utf8').trim().split('\n').length, 2);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n'), ['bx_new0']);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch ends its running games and cleans up at once on SIGTERM', posixOnly, async () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'HANG'), '');
	try {
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '';
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no game started: ${out}`)), 60_000);
			child.stdout.on('data', chunk => { out += chunk; if ((out.match(/started nether/g) ?? []).length >= 2) { clearTimeout(timer); resolve(); } });
		});
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		await exited;
		assert.ok(Date.now() - signalledAt < 60_000, 'the cleanup ran well inside systemd\'s 90 s stop timeout');
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state).sort(), ['not finished', 'not finished', 'not started', 'not started']);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
		assert.equal(leftSignIns(root), '0');
		// pgrep exits 1 when nothing matches.
		assert.throws(() => execFileSync('pgrep', ['-f', `${root}/bx_.*/ck/game.sh`], { encoding: 'utf8' }), 'no game process is left');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch drops a machine boat no longer knows and replays its game on another', posixOnly, () => {
	const root = setup({ plan: { drain: undefined } });
	writeFileSync(path.join(root, 'bx_aaaaaaaa/VANISH_ON_START'), ''); writeFileSync(path.join(root, 'bx_bbbbbbbb/SLOW'), '');
	try {
		run(root, { CHECKPOINT_LOST_AFTER_MS: '60000' });
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.machine === 'bx_bbbbbbbb'));
		assert.equal(state.machines.find(m => m.id === 'bx_aaaaaaaa').lost, true);
	} finally { try { execFileSync('pkill', ['-f', `${root}/bx_`]); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch drops no machine while boat itself is unreachable for a while', posixOnly, async () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'SLOW'), '');
	try {
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_LOST_AFTER_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '', outage = false;
		child.stdout.on('data', chunk => {
			out += chunk;
			// Boat goes away right after the first game is home (one machine idle, one mid-game) for 3 s: past LOST_AFTER_MS, inside the outage grace.
			if (!outage && /finished nether/.test(out)) { outage = true; writeFileSync(path.join(root, 'OUTAGE'), ''); setTimeout(() => rmSync(path.join(root, 'OUTAGE'), { force: true }), 3_000); }
		});
		assert.equal(await exited, 0);
		assert.ok(outage, 'the outage happened');
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.machines.every(m => !m.lost));
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch ends the leftover processes of a launch that died before reusing its machine', posixOnly, () => {
	const root = setup();
	writeFileSync(path.join(root, 'NODONE'), ''); writeFileSync(path.join(root, 'LEFTOVER'), '');
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.equal(readdirSync(root).filter(f => f.startsWith('nodone-')).length, 4, 'every game\'s first launch died');
		// pgrep exits 1 when nothing matches.
		assert.throws(() => execFileSync('pgrep', ['-f', `${root}/bx_.*/ck/arms/leftover-`], { encoding: 'utf8' }), 'no leftover of a dead launch is still running');
	} finally { try { execFileSync('pkill', ['-f', `${root}/bx_`]); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch drops no machine during an outage longer than the drop wait, and plays every game once boat is back', posixOnly, async () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'SLOW'), '');
	try {
		// LOST_AFTER_MS 200 makes the drop wait during an outage 1.2 s; boat stays away for 4 s.
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_LOST_AFTER_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '', outage = false;
		child.stdout.on('data', chunk => {
			out += chunk;
			if (!outage && /finished nether/.test(out)) { outage = true; writeFileSync(path.join(root, 'OUTAGE'), ''); setTimeout(() => rmSync(path.join(root, 'OUTAGE'), { force: true }), 4_000); }
		});
		assert.equal(await exited, 0);
		assert.ok(outage, 'the outage happened');
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.machines.every(m => !m.lost));
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch keeps trying to take the sign-ins off when boat is out as the batch ends', posixOnly, () => {
	// Listed machines are kept, so only the cleanup can take their sign-ins off.
	const root = setup({ plan: { drain: undefined } });
	writeFileSync(path.join(root, 'OUTAGE_AT_SIGNOFF'), '');
	try {
		run(root);
		assert.ok(!existsSync(path.join(root, 'OUTAGE_AT_SIGNOFF')), 'the outage happened');
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /could not remove the sign-in from bx_/);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.ok(state.machines.every(m => m.signInRemoved));
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch cancels a long upload on SIGTERM and cleans up at once', posixOnly, async () => {
	const root = setup();
	writeFileSync(path.join(root, 'BLOCKSCP'), '');
	try {
		const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
			env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = new Promise(resolve => child.on('exit', resolve));
		// Wait until both machines are stuck uploading their arm package.
		for (let i = 0; i < 300 && (existsSync(path.join(root, 'blocked.log')) ? readFileSync(path.join(root, 'blocked.log'), 'utf8').trim().split('\n').length : 0) < 2; i++) await new Promise(r => setTimeout(r, 100));
		assert.equal(readFileSync(path.join(root, 'blocked.log'), 'utf8').trim().split('\n').length, 2, 'both uploads hung');
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		await exited;
		assert.ok(Date.now() - signalledAt < 30_000, `the cleanup did not wait for the hung uploads (${Date.now() - signalledAt} ms)`);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
		assert.equal(leftSignIns(root), '0');
		assert.equal(readFileSync(path.join(root, 'blocked.log'), 'utf8').trim().split('\n').length, 2, 'no further upload started after the signal');
	} finally { try { execFileSync('pkill', ['-f', `${root}/bin/boat`]); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch keeps the first cleanup pass inside the signal\'s budget when ssh stalls after SIGTERM', posixOnly, async () => {
	const root = setup();
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) writeFileSync(path.join(root, id, 'HANG'), '');
	const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
		env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_SIGNAL_BUDGET_MS: '12000' }, stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		const exited = new Promise(resolve => child.on('exit', resolve));
		let out = '';
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no game started: ${out}`)), 60_000);
			child.stdout.on('data', chunk => { out += chunk; if ((out.match(/started nether/g) ?? []).length >= 2) { clearTimeout(timer); resolve(); } });
		});
		// Both games are running, so the first cleanup pass starts by ending their sessions, and that ssh stalls.
		writeFileSync(path.join(root, 'STALLSSH'), '');
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		await exited;
		const took = Date.now() - signalledAt;
		assert.ok(took < 25_000, `the cleanup stayed inside the 12 s signal budget (${took} ms)`);
		const log = readFileSync(path.join(root, 'out/batch.log'), 'utf8');
		assert.match(log, /could not end the game sessions on bx_aaaaaaaa/);
		assert.match(log, /could not end the game sessions on bx_bbbbbbbb/);
		// The stalled steps left the deletion its share of the budget: both machines are gone, sign-ins with them.
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
	} finally {
		child.kill('SIGKILL');
		for (const pattern of [`${root}/bin/boat`, '^sleep 300[.]5$', `${root}/bx_`]) { try { execFileSync('pkill', ['-f', pattern]); } catch {} }
		rmSync(root, { recursive: true, force: true });
	}
});

test('checkpoint batch cuts a stalled retirement on SIGTERM and still deletes the machines inside the budget', posixOnly, async () => {
	const root = setup();
	writeFileSync(path.join(root, 'STALL_AT_SIGNOFF'), '');
	const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
		env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_SIGNAL_BUDGET_MS: '12000' }, stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		const exited = new Promise(resolve => child.on('exit', resolve));
		// Every game ends quickly, so a machine with no further game is retired, and its sign-in removal stalls.
		for (let i = 0; i < 600 && !existsSync(path.join(root, 'stalled.log')); i++) await new Promise(r => setTimeout(r, 100));
		assert.ok(existsSync(path.join(root, 'stalled.log')), 'a retirement stalled');
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		await exited;
		const took = Date.now() - signalledAt;
		assert.ok(took < 25_000, `the stalled retirement did not hold back the cleanup (${took} ms)`);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
	} finally {
		child.kill('SIGKILL');
		for (const pattern of [`${root}/bin/boat`, '^sleep 300[.]5$', `${root}/bx_`]) { try { execFileSync('pkill', ['-f', pattern]); } catch {} }
		rmSync(root, { recursive: true, force: true });
	}
});

test('checkpoint batch cuts a stalled drop of a lost machine on SIGTERM and still deletes the machines inside the budget', posixOnly, async () => {
	const root = setup();
	// bx_bbbbbbbb's launches end without a done file, so it is dropped mid-batch; its sign-in removal there stalls.
	// bx_aaaaaaaa's game runs for minutes, so no retirement (or the end of the batch) gets there first.
	writeFileSync(path.join(root, 'bx_bbbbbbbb/BROKEN'), ''); writeFileSync(path.join(root, 'bx_aaaaaaaa/HANG'), '');
	writeFileSync(path.join(root, 'STALL_AT_SIGNOFF'), '');
	const child = spawn('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
		env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', CHECKPOINT_SIGNAL_BUDGET_MS: '12000' }, stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		let code = null;
		const exited = new Promise(resolve => child.on('exit', c => { code = c; resolve(); }));
		const stalled = () => existsSync(path.join(root, 'stalled.log')) && readFileSync(path.join(root, 'stalled.log'), 'utf8').includes('bx_bbbbbbbb');
		for (let i = 0; i < 600 && !stalled(); i++) await new Promise(r => setTimeout(r, 100));
		assert.ok(stalled(), 'the drop of bx_bbbbbbbb stalled at its sign-in removal');
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /dropping bx_bbbbbbbb: 2 launches in a row/);
		const signalledAt = Date.now();
		child.kill('SIGTERM');
		// Without the signal on the drop's calls, the runner waits out the stalled ssh (up to two minutes) before cleaning up.
		await Promise.race([exited, new Promise(r => setTimeout(r, 40_000))]);
		const took = Date.now() - signalledAt;
		assert.notEqual(code, null, 'the runner exited after SIGTERM');
		assert.ok(took < 25_000, `the stalled drop did not hold back the cleanup (${took} ms)`);
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
	} finally {
		child.kill('SIGKILL');
		for (const pattern of [`${root}/bin/boat`, '^sleep 300[.]5$', `${root}/bx_`]) { try { execFileSync('pkill', ['-f', pattern]); } catch {} }
		rmSync(root, { recursive: true, force: true });
	}
});

test('checkpoint batch treats an empty meter reading as unreadable and plays every game', posixOnly, () => {
	const root = setup({ plan: { meter: { command: 'true', floorPercent: 10 } } });
	try {
		run(root);
		assert.match(readFileSync(path.join(root, 'out/batch.log'), 'utf8'), /meter unreadable: no output/);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('removing a sign-in tolerates missing files and folders but rejects a removal that fails', posixOnly, async t => {
	const root = setup();
	const home = path.join(root, 'bx_aaaaaaaa');
	const saved = { BOAT_BIN: process.env.BOAT_BIN, FAKE_BOAT_ROOT: process.env.FAKE_BOAT_ROOT };
	Object.assign(process.env, { BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root });
	const put = file => { mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); writeFileSync(path.join(home, file), '{}'); };
	try {
		// Nothing there yet: no ~/.codex/auth.json and no ~/ck.
		await removeCodexSignIn('bx_aaaaaaaa');
		for (const file of ['.codex/auth.json', 'ck/arms/runs/g1/.codex-home/auth.json', 'ck/games/g1/auth.json']) put(file);
		await removeCodexSignIn('bx_aaaaaaaa');
		assert.equal(leftSignIns(root), '0');
		if (process.getuid?.() === 0) { t.diagnostic('root ignores folder permissions: failure cases skipped'); return; }
		for (const [file, locked] of [['.codex/auth.json', '.codex'], ['ck/games/g2/auth.json', 'ck/games/g2']]) {
			put(file);
			chmodSync(path.join(home, locked), 0o555);
			try {
				await assert.rejects(removeCodexSignIn('bx_aaaaaaaa'), /command failed on bx_aaaaaaaa/, `a failed removal under ${locked} rejects`);
				assert.ok(existsSync(path.join(home, file)), `${file} is still there`);
			} finally { chmodSync(path.join(home, locked), 0o755); }
			await removeCodexSignIn('bx_aaaaaaaa');
			assert.ok(!existsSync(path.join(home, file)), `${file} goes once the folder is writable again`);
		}
	} finally {
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	}
});
