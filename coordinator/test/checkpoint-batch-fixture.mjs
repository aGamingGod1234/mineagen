import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Drives scripts/quality/checkpoint-batch.mjs end to end against a fake boat CLI (BOAT_BIN): each "machine" is a folder
// used as HOME, ssh runs the command there, scp copies files, delete marks the machine gone. The fake game writes a
// report and a run folder holding the game's own copy of the sign-in, the way the coordinator's workspace does.
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const script = path.join(repo, 'scripts/quality/checkpoint-batch.mjs');

export const FAKE_BOAT = `#!/bin/bash
F=$FAKE_BOAT_ROOT; [ "$1" = --no-update ] && shift; cmd=$1; shift
# An OUTAGE file makes boat unreachable from this side; a VANISH file in a machine's home makes boat forget the machine.
# With an OUTAGE_ENDS_AT_UPLOAD file, the outage ends as it refuses a sign-in upload: boat is back while that launch fails.
if [ -f "$F/OUTAGE" ]; then
  [ "$cmd" = scp ] && [ -f "$F/OUTAGE_ENDS_AT_UPLOAD" ] && case $2 in *:.codex/auth.json) rm -f "$F/OUTAGE" "$F/OUTAGE_ENDS_AT_UPLOAD";; esac
  echo "connection refused" >&2; exit 1; fi
[ -f "$F/$1/VANISH" ] && { echo "sandbox not found: $1" >&2; exit 1; }
map() { case $1 in bx_*:*) echo "$F/\${1%%:*}/\${1#*:}";; *) echo "$1";; esac; }
seed() { mkdir -p "$1/rooms/jdk/bin" "$1/rooms/template-26.3/mods" "$1/.local/bin"; : > "$1/rooms/jdk/bin/java"; chmod +x "$1/rooms/jdk/bin/java"; printf '#!/bin/bash\\necho codex-cli 0.1.0\\n' > "$1/.local/bin/codex"; chmod +x "$1/.local/bin/codex"; }
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
    # The fake machines share this host's process table, and test files run side by side: the batch's game.sh lookups
    # (pgrep -f 'ck/game.sh ...') are narrowed to this machine's home, so they see only its games, as on a real machine.
    c=$*; b=$(printf '%s' "$c" | sed -n 's/.*echo \\([A-Za-z0-9+\/=]*\\) | base64 -d.*/\\1/p')
    if [ -n "$b" ]; then
      b2=$(printf '%s' "$b" | base64 -d | sed "s#\\[c\\]k/game\\.sh #$F/$id/[c]k/game.sh #g; s#pgrep -f 'ck/game\\.sh #pgrep -f '$F/$id/ck/game.sh #g" | base64 | tr -d '\\n')
      c=\${c/"$b"/"$b2"}; fi
    o=$(cd "$F/$id" && HOME="$F/$id" bash -c "$c"); rc=$?
    # A DROPSTART file loses the answer to the first game launch there (the game itself starts), as when ssh drops.
    if [ -f "$F/$id/DROPSTART" ] && printf '%s\n' "$o" | grep -qx started; then rm -f "$F/$id/DROPSTART"; exit 255; fi
    printf '%s\n' "$o"; exit $rc;;
  scp) s=$(map "$1"); d=$(map "$2"); mkdir -p "$(dirname "$d")"
    # A NOAUTH file in a prepared machine's home makes every sign-in upload for a game fail while ssh still works.
    case $2 in *:.codex/auth.json) h=$F/\${2%%:*}; [ -f "$h/NOAUTH" ] && [ -f "$h/ck/game.sh" ] && { echo "scp failed" >&2; exit 1; };; esac
    # A BLOCKSCP file makes every upload of an arm package hang for minutes, as a slow transfer does.
    case $2 in *:ck/arms/*.tar.gz) [ -f "$F/BLOCKSCP" ] && { echo "blocked $2" >> "$F/blocked.log"; sleep 300; };; esac
    # A NOSALVAGE file makes every copy home of a game's salvaged replays and world fail.
    case $1 in *.salvage.tgz) [ -f "$F/NOSALVAGE" ] && { echo "scp failed" >&2; exit 1; };; esac
    # A STALLFETCH file makes the normal copy home of a finished game hang, after the machine packed it, until a signal cuts it.
    case $1 in *.salvage.tgz) ;; *:ck/games/*.tgz) [ -f "$F/STALLFETCH" ] && { touch "$F/fetch-stalled"; sleep 299; };; esac
    # A STALLSALVAGE file makes that copy hang, as a slow transfer does, until a signal cuts it.
    case $1 in *.salvage.tgz) [ -f "$F/STALLSALVAGE" ] && { touch "$F/salvage-stalled"; sleep 299; };; esac
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
export const FAKE_GAME = `#!/bin/bash
id=$1; dir=$HOME/ck/games/$id; raw=$HOME/ck/arms/runs/$id; mkdir -p "$raw/.codex-home" "$raw/server" "$dir/report"; echo world > "$raw/server/level.dat"
# A RECORD file gives the game a replay and a world the way a recording server leaves them, and names the run folder at once.
[ -f "$FAKE_BOAT_ROOT/RECORD" ] && { mkdir -p "$raw/server/recordings/players/agent" "$raw/server/headless-w"; echo replay > "$raw/server/recordings/players/agent/r.zip"; echo world > "$raw/server/headless-w/level.dat"; echo secret > "$raw/server/server.properties"; echo "Running q: $raw" > "$dir/run.log"; }
# A NODONE file makes each game's first launch end without a done file, as when the launch ssh dropped first.
# A LEFTOVER file also leaves a detached process of that launch running (the launcher's server and coordinator).
[ -f "$FAKE_BOAT_ROOT/NODONE" ] && [ ! -f "$FAKE_BOAT_ROOT/nodone-$id" ] && { touch "$FAKE_BOAT_ROOT/nodone-$id"; if [ -f "$FAKE_BOAT_ROOT/LEFTOVER" ]; then setsid bash -c "sleep 300; : $HOME/ck/arms/leftover-$id" > /dev/null 2>&1 < /dev/null & fi; exit 0; }
# A BROKEN file in a machine's home makes every launch there end without a done file (a full disk, a wiped ~/ck).
[ -f "$HOME/BROKEN" ] && exit 0
# A SLOW file keeps each game on that machine running across a few passes; a HANG file keeps it running for minutes.
[ -f "$HOME/SLOW" ] && sleep 1
# The batch sees the machine gone within a pass; the game on it lives on a few seconds longer. On the fake's one host,
# pgrep in the batch's check sees that game.sh too, so a longer sleep only holds back the replay's check.
[ -f "$HOME/VANISH_ON_START" ] && { touch "$HOME/VANISH"; sleep 3; }
[ -f "$HOME/HANG" ] && sleep 300
cp "$HOME/.codex/auth.json" "$raw/.codex-home/auth.json"; [ -f "$FAKE_BOAT_ROOT/REFRESH" ] && echo refreshed >> "$raw/.codex-home/auth.json"
# A SOURCE_REFRESH file makes the first game that sees it refresh the sign-in at its source (Codex on the batch's computer).
[ -f "$FAKE_BOAT_ROOT/SOURCE_REFRESH" ] && rm "$FAKE_BOAT_ROOT/SOURCE_REFRESH" 2>/dev/null && echo refreshed >> "$FAKE_BOAT_ROOT/signin/auth.json"
echo '{"event":"native_token_usage"}' > "$raw/coordinator.jsonl"
echo "Running q: $raw" > "$dir/run.log"; echo '{}' > "$dir/ledger.json"
# An EARLY file makes the game earn a blaze rod at once and then play on for a minute as a process named like run-long,
# writing its report when that ends (as run-long does on a SIGTERM), with the operator stop it found.
if [ -f "$FAKE_BOAT_ROOT/EARLY" ]; then
  t=$(date +%s%3N)
  printf '%s\\n' "{\\"envelope\\":{\\"type\\":\\"goal_control\\",\\"agentId\\":\\"a\\",\\"payload\\":{\\"operation\\":\\"start\\",\\"updatedAtEpochMs\\":$t}}}" "{\\"envelope\\":{\\"type\\":\\"advancement_granted\\",\\"agentId\\":\\"a\\",\\"payload\\":{\\"advancementId\\":\\"minecraft:nether/obtain_blaze_rod\\"}},\\"observedAtMs\\":$t}" > "$raw/quality-protocol.jsonl"
  bash -c ": scripts/quality/run-long.mjs --out $dir/report; sleep 60; true"
  stop=$(node -e 'try{console.log(JSON.stringify(require(process.argv[1])))}catch{console.log("null")}' "$dir/report/operator-stop.json")
  echo "{\\"measurementStatus\\":\\"INCOMPLETE\\",\\"operatorStop\\":$stop,\\"timeline\\":{\\"startedAt\\":1795290758148,\\"playedMs\\":60000,\\"stopReason\\":\\"ENDED_EARLY:INTERRUPTED_SIGTERM\\",\\"milestones\\":[{\\"id\\":\\"fortress\\",\\"reached\\":true,\\"elapsedMs\\":120000}],\\"deaths\\":[]}}" > "$dir/report/long-run.json"
  echo "exit 0 $(date -Is)" > "$dir/done"; exit 0
fi
echo '{"measurementStatus":"INCOMPLETE","timeline":{"startedAt":1795290758148,"playedMs":60000,"stopReason":"WALL_CLOCK_BUDGET","milestones":[{"id":"fortress","reached":true,"elapsedMs":120000}],"deaths":[{"cause":"lava"}]}}' > "$dir/report/long-run.json"
echo "exit 0 $(date -Is)" > "$dir/done"
`;

export function setup({ refresh = false, record = false, plan: overrides = {} } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), 'ckpt-loop-'));
	const bin = path.join(root, 'bin'); mkdirSync(bin);
	writeFileSync(path.join(bin, 'boat'), FAKE_BOAT); chmodSync(path.join(bin, 'boat'), 0o755);
	writeFileSync(path.join(bin, 'codex'), '#!/bin/bash\necho codex-cli 0.1.0\n'); chmodSync(path.join(bin, 'codex'), 0o755);
	writeFileSync(path.join(bin, 'eatmydata'), '#!/bin/bash\nexec "$@"\n'); chmodSync(path.join(bin, 'eatmydata'), 0o755);
	writeFileSync(path.join(root, 'fake-game.sh'), FAKE_GAME);
	if (refresh) writeFileSync(path.join(root, 'REFRESH'), '');
	for (const id of ['bx_aaaaaaaa', 'bx_bbbbbbbb']) {
		const home = path.join(root, id);
		mkdirSync(path.join(home, 'rooms/template-26.3/mods'), { recursive: true });
		mkdirSync(path.join(home, 'rooms/jdk/bin'), { recursive: true }); writeFileSync(path.join(home, 'rooms/jdk/bin/java'), ''); chmodSync(path.join(home, 'rooms/jdk/bin/java'), 0o755);
		mkdirSync(path.join(home, '.local/bin'), { recursive: true }); writeFileSync(path.join(home, '.local/bin/codex'), '#!/bin/bash\necho codex-cli 0.1.0\n'); chmodSync(path.join(home, '.local/bin/codex'), 0o755);
	}
	// A tiny arm checkout (the batch packs git archive REF plus coordinator/node_modules).
	const arm = path.join(root, 'arm'); mkdirSync(path.join(arm, 'coordinator/node_modules'), { recursive: true });
	writeFileSync(path.join(arm, 'README'), 'arm\n'); writeFileSync(path.join(arm, 'coordinator/node_modules/x.js'), '');
	// A recording arm carries a launcher that records the agent; the batch checks for it.
	if (record) { mkdirSync(path.join(arm, 'scripts')); writeFileSync(path.join(arm, 'scripts/run-headless-provider-matrix.mjs'), "export const REPLAY_STOP_COMMAND = 'replay stop players @a';\n"); }
	execFileSync('git', ['init', '-q', arm]); execFileSync('git', ['-C', arm, 'add', 'README', ...(record ? ['scripts'] : [])]);
	execFileSync('git', ['-C', arm, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'arm']);
	writeFileSync(path.join(root, 'mod.jar'), 'jar'); writeFileSync(path.join(root, 'sp.json'), '{}');
	writeFileSync(path.join(root, 'lithium-fabric-0.1+mc26.3.jar'), 'lithium');
	mkdirSync(path.join(root, 'signin')); writeFileSync(path.join(root, 'signin/auth.json'), '{"tokens":"fake"}');
	const plan = { minutes: 1, deadline: new Date(Date.now() + 3 * 3_600_000).toISOString(), codexHome: path.join(root, 'signin'),
		vms: ['bx_aaaaaaaa', 'bx_bbbbbbbb'], drain: 'delete', copyConcurrency: 2, lithium: path.join(root, 'lithium-fabric-0.1+mc26.3.jar'),
		arms: { main: { root: arm, ref: 'HEAD', jar: path.join(root, 'mod.jar') }, other: { root: arm, ref: 'HEAD', jar: path.join(root, 'mod.jar'), env: { A_SWITCH: 'on', B_SWITCH: '2' } } },
		savepoints: { nether: { file: path.join(root, 'sp.json'), repeats: 2, targets: ['fortress'] } } };
	const kit = path.join(root, 'kit'); mkdirSync(kit);
	for (const name of ['ServerReplay-1.0+26.3.jar', 'fabric-language-kotlin-1.0.jar', 'server-replay-config.json']) writeFileSync(path.join(kit, name), name);
	writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ ...plan, ...(record ? { recording: kit } : {}), ...overrides }));
	return root;
}
export const run = (root, env = {}) => execFileSync('node', [script, '--plan', path.join(root, 'plan.json'), '--out', path.join(root, 'out')], {
	env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, BOAT_BIN: path.join(root, 'bin/boat'), FAKE_BOAT_ROOT: root, CHECKPOINT_POLL_MS: '200', ...env },
	encoding: 'utf8', timeout: 120_000 });
// The fake boat CLI and fake games are bash scripts; the batch itself runs only from Linux or macOS hosts.
export const posixOnly = { skip: process.platform === 'win32' ? 'the fake boat CLI is a bash script' : false };
export const leftSignIns = root => execFileSync('bash', ['-c', `find ${root}/bx_* \\( -name auth.json -o -name .codex-home \\) | wc -l`], { encoding: 'utf8' }).trim();
