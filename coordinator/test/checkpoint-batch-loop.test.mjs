import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Drives scripts/quality/checkpoint-batch.mjs end to end against a fake boat CLI (BOAT_BIN): each "machine" is a folder
// used as HOME, ssh runs the command there, scp copies files, delete marks the machine gone. The fake game writes a
// report and a run folder holding the game's own copy of the sign-in, the way the coordinator's workspace does.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repo, 'scripts/quality/checkpoint-batch.mjs');

const FAKE_BOAT = `#!/bin/bash
F=$FAKE_BOAT_ROOT; [ "$1" = --no-update ] && shift; cmd=$1; shift
map() { case $1 in bx_*:*) echo "$F/\${1%%:*}/\${1#*:}";; *) echo "$1";; esac; }
case $cmd in
  ssh) id=$1; shift; [ "$1" = -- ] && shift; [ -f "$F/$id.deleted" ] && { echo gone >&2; exit 255; }; cd "$F/$id" && HOME="$F/$id" bash -c "$*";;
  scp) s=$(map "$1"); d=$(map "$2"); mkdir -p "$(dirname "$d")"; case $2 in *:ck/game.sh) cp "$F/fake-game.sh" "$d";; *) cp "$s" "$d";; esac;;
  info) [ -f "$F/$1.deleted" ] && echo '{"sandbox":{"state":"deleted"}}' || echo '{"sandbox":{"state":"running"}}';;
  delete) touch "$F/$1.deleted"; echo "$1" >> "$F/deleted.log"; echo '{}';;
  *) echo "fake boat: $cmd not handled" >&2; exit 2;;
esac
`;
// game.sh ID ARM SP MINUTES SALT MODEL EFFORT; the run folder sits under ~/ck like a real one. A REFRESH file in the fake root makes the game's own sign-in copy change.
const FAKE_GAME = `#!/bin/bash
id=$1; dir=$HOME/ck/games/$id; raw=$HOME/ck/arms/runs/$id; mkdir -p "$raw/.codex-home" "$dir/report"
cp "$HOME/.codex/auth.json" "$raw/.codex-home/auth.json"; [ -f "$FAKE_BOAT_ROOT/REFRESH" ] && echo refreshed >> "$raw/.codex-home/auth.json"
echo '{"event":"native_token_usage"}' > "$raw/coordinator.jsonl"
echo "Running q: $raw" > "$dir/run.log"; echo '{}' > "$dir/ledger.json"
echo '{"measurementStatus":"INCOMPLETE","timeline":{"startedAt":1795290758148,"playedMs":60000,"stopReason":"WALL_CLOCK_BUDGET","milestones":[{"id":"fortress","reached":true,"elapsedMs":120000}],"deaths":[{"cause":"lava"}]}}' > "$dir/report/long-run.json"
echo "exit 0 $(date -Is)" > "$dir/done"
`;

function setup({ refresh = false } = {}) {
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
	writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
	return root;
}
const run = root => execFileSync('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
	env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200' },
	encoding: 'utf8', timeout: 120_000 });
const leftSignIns = root => execFileSync('bash', ['-c', `find ${root}/bx_* \\( -name auth.json -o -name .codex-home \\) | wc -l`], { encoding: 'utf8' }).trim();

test('checkpoint batch copies every game home, writes each env switch on its own line, and deletes drained machines', () => {
	const root = setup();
	try {
		run(root);
		const state = JSON.parse(readFileSync(path.join(root, 'out/state.json'), 'utf8'));
		assert.deepEqual(state.games.map(g => g.state), ['done', 'done', 'done', 'done']);
		assert.ok(state.games.every(g => g.score.known && g.score.targets.fortress === 2 && g.score.deaths === 1));
		for (const g of state.games) {
			const listing = execFileSync('tar', ['-tzf', path.join(root, 'out/games', g.id, 'game.tgz')], { encoding: 'utf8' });
			assert.match(listing, /raw\/coordinator\.jsonl/); assert.doesNotMatch(listing, /auth\.json|\.codex-home/);
		}
		assert.equal(readFileSync(path.join(root, 'bx_aaaaaaaa/ck/arms/other/env'), 'utf8'), 'A_SWITCH=on\nB_SWITCH=2\n');
		assert.deepEqual(readFileSync(path.join(root, 'deleted.log'), 'utf8').trim().split('\n').sort(), ['bx_aaaaaaaa', 'bx_bbbbbbbb']);
		assert.equal(leftSignIns(root), '0');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint batch stops starting games when the game\'s own sign-in copy was refreshed', () => {
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
