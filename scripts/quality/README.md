# Live scenario quality harness

## Which test to run

Test a change in four tiers, fastest first. [How testing works](../../docs/goal-progress.md#how-testing-works) says what each tier is for. Set up the checkout with `node scripts/doctor.mjs` first ([AGENTS.md](../../AGENTS.md#set-up-a-checkout)).

| Tier | Use it for | Command on main |
|---|---|---|
| 1. Decision tests | every change: checks that one decision comes out right, from the unit tests to recorded moments | `cd coordinator && npm test` runs the unit tests. `npm run eval:decisions -- --baseline main --quick` (from `coordinator/`) replays recorded moments through the real model and a judge on the other provider, with no Minecraft server; it needs `ARENA_PRIVATE_INPUTS`, and without it prints SKIP and gives no verdict ([decision evals](../decision-eval/README.md)). For one recorded incident: `node scripts/quality/check.mjs --incident ID` ([Edit loop](#edit-loop)). `npm run eval:tier1` (from `coordinator/`) gives one score per category against a stored baseline. |
| 2. Practice rooms | every gameplay change: minutes of staged play, a script in the model's place, the change and main side by side | `room-batch.mjs` on boat machines or the Windows PCs ([below](#a-practice-room-batch)). Rooms played by the real model: `room-batch.mjs --player model` ([AI rooms](#ai-rooms-the-real-model-in-a-practice-room)). Every room 10 times, compared with a saved baseline: `benchmark.mjs` ([practice-room benchmark](#practice-room-benchmark)). |
| 3. Checkpoint games | several fixes together, and anything that depends on what the model decides; overnight | `run-long.mjs --checkpoint SAVE_POINT.json` plays one real-model game from a save point. Batches of them on boat machines (`checkpoint-batch.mjs`) are coming in PR #57. |
| 4. Full games | the scoreboard, not a test of one change | A round of fresh worlds on the fixed seeds, added to the goal page's status table. [Long runs](#long-runs-beat-the-game-on-a-random-seed) plays one fresh-world game. |

### A practice-room batch

1. Build one jar per arm, such as your branch and main.
2. Write a commands file ([Room batches](#room-batches-on-boat-and-windows-pcs) gives the format). A room name may appear only once, so give each repeat its own line and name: `@lava-gate-1-1`, `@lava-gate-1-2`, and so on. Put `FIXTURE_TICK_RATE=60` right after the room name (`@lava-gate-1-1 FIXTURE_TICK_RATE=60 BUILD_ONLY=... node ...`) to play it at 3x where [Speed](#speed-which-rooms-play-at-3x) allows.
3. Check the plan with `--dry-run`, then run it: `node scripts/quality/room-batch.mjs --commands ROOMS.txt --arm new=NEW.jar --arm old=OLD.jar --pool boat --vms N --out FRESH_DIR`. `--snapshot` (or `ROOM_BATCH_SNAPSHOT`) names the room image. `--pool windows` with `ROOM_BATCH_WINDOWS` plays on the Windows PCs instead.
4. Read `OUT/summary.txt`: per arm, pass, fail, invalid and lost rooms, deaths and damage, then one line per room.

Boat machines:

- Starts and idle time both cost: every create, fork or resume counts against boat's start limits (ssh, exec and `boat extend` do not), and an idle machine bills in full. A batch leases running machines from the warm pool, creates only the shortfall, and gives them back when it ends.
- Keep the pool at a warm set of about 20 machines and delete idle extras beyond it. `node scripts/quality/boat-pool.mjs status` lists it; `drain` deletes every idle pool machine (or those of one image and size), so check `status` before you run it. `keepalive --every 60` keeps the warm set from reaching its auto-stop; stopping a machine erases it.
- Delete any extra machine you created by name, outside the pool, when your work is done. `--ephemeral` makes throwaway machines that the batch deletes itself.
- A new machine gets its first room only after boat reports it `hydrated`; the batch waits for that itself.

### Speed: which rooms play at 3x

`FIXTURE_TICK_RATE=60` plays a room at three times the game speed in the same game time. A fixture plays faster only if it opts in; the rest stay at 20 TPS and warn ([Faster provider-free fixtures](#faster-provider-free-fixtures-test-only) has the rules and measurements).

| Fixture | At `FIXTURE_TICK_RATE=60` |
|---|---|
| `test-build-live.mjs` | Measured: 31 of 60 passes at 60 against 32 of 60 at 20, same deaths. Keep `cast-obi-3`, `lava-gate-2`, `lava-gate-4`, `lava-gate-5` and `lava-gate-8` at 20 until more repeats settle them. |
| `test-cornered-live.mjs`, `test-dig-live.mjs` | Opt in; check a room at both rates before relying on it. |
| `test-rest-live.mjs` | 20 only: at 80 some nights took damage that no run at 20 did. |
| Every other fixture, and every model run | 20 only. Provider timeouts are wall time. |

A fixture that relies on the runtime's 60 s repeated-failure window, or on the age of its start sample, body ends or dug stairs, is not yet rate-safe: those still read wall time.

### Reading the result

- Rooms vary from run to run with no code change (mob spawns, timing), so one run per room proves little. Play 10 repeats of each room per arm and report pass rates: "died in lava 3 of 10 before, 0 of 10 after".
- Count only valid rooms. An INVALID or LOST room is a rerun (`room-batch.mjs --valid N` reruns it for you: below), never a pass, and a missing damage or death counter is unknown, never 0 ([Edit loop](#edit-loop) has the verdict rules).
- A bad start is the room's fault, not the bot's. `scripts/quality/lib/start-check.mjs` checks one: a room declares its spec (`footing` with no leaves or fluid in the feet or head cell and the body on the ground (vanilla `OnGround`), `mobs` of a type within a range and, with the room's own `sight()`, in view, `health`, `inventory`, `time`), `readStart` reads it with commands anchored at the body (`execute at AGENT ...`, never a mob nearest the server origin), and `markStart(row, checkStart(spec, start), start)` sets `notExercised` on a bad start, so the row reads INVALID. Anything the spec asks about that cannot be read fails the start.
- Rule of thumb, from chance alone (rooms have no measured noise floor yet): with 10 repeats a side and a pass rate near half, a gap of one or two passes is noise. An all-or-nothing gap (0 of 10 against 10 of 10) is safe to trust; anything between needs more repeats before you call it a change.
- A script plays the model's part in a room, so a pass shows the body can do it, not that the model will choose to. Decisions belong to tiers 1 and 3.

## Edit loop

Run `node scripts/quality/check.mjs --incident ID` for the offline decision stake; its headline block matches the sticky PR comment and `gameplay-stake` status in the existing Linux Node job. Add `--base REF` to select a base explicitly. See [the stake corpus](../../coordinator/test/fixtures/stake/README.md) for supported coverage and expectation updates.

Investigate one recorded failure before rerunning a matrix. Use the selected case through its existing fixture and machine slot; `BUILD_ONLY=NAME` and `FIND_ONLY=NAME` select cases. The full matrix is the product gate after the candidate is ready.

- Score retained gameplay with `node scripts/quality/stage-score.mjs RUN_DIR --out SCORE.json`. `deathCauses` counts deaths by cause and `deathRecords` lists each with its evidence (`scripts/quality/lib/death-causes.mjs`): the server's damage type and attacker, else the vanilla death message; a death seen only as a death counter step is `unknown`. `actionCounts` counts terminal receipts once per agent/revision/action ID; observation copies of `lastResult` do not add actions. `execution` separates proven starts/completions from explicit cancellation before start and unknown starts.
- Build/find/find-spot fixtures write their existing rows plus `result-summary.json`. Strict mode is the default: exit 1 means unmet acceptance, exit 2 means invalid/incomplete evidence; `--descriptive` retains exploratory exit behavior. `--help` works without Java, a template or a live slot.
- Read `result-summary.json` before recounting rows. `rooms` gives each room one verdict (PASS, FAIL, INVALID or SKIPPED) and its `reason`; `passed`, `failed` and `invalid` count them; `line` says it in one sentence (`13 pass, 0 fail, 1 invalid of 14 planned; valid rooms PASS; status INVALID | breath#7 INVALID: not exercised: ...`). `armVerdict` judges only the valid rooms, so one invalid room no longer hides 13 passing ones; rerun the invalid rooms. Exit 1 wins over exit 2: a measured miss stands whatever else was invalid. A room is INVALID for an `error`, missing evidence (`integrity`), `notExercised`, a reflex under test that never fired, or no `pass` at all.
- A new live fixture reports through `finishRun` in `lib/fixture-run.mjs`, prints `FIXTURE_OUTCOME_HELP` on `--help` and exits 2 without a slot; `coordinator/test/quality-fixture-exit.test.mjs` checks it. Do not copy a fixture on that test's `NOT_YET_ON_FINISH_RUN` list.
- A room that tests a reflex records `row.reflexHold = reflexHold(observation.reflexes, { id, sinceSeq })` from `lib/room-evidence.mjs`. A rule that never fired leaves the room INVALID. A rule that failed, or yielded or was preempted (to a model command, say) before `holdMs` (default: never), turns a pass into FAIL.
- Read deaths with `deathCounter` (`lib/damage-counter.mjs`): `qo_death` after the quality setup, or `{ objective: 'deaths', unsetIsZero: true }` for the objective `boot()` adds. A trailing-number parse reads `Probe has 1 [deaths]` as NaN, and `|| 0` made every death 0. Commands refused `STALE_REVISION` are counted as `refused`, not as calls. Observations arrive only when asked for, so a minimum health taken between calls misses a death inside one long call: use `startHealthWatch` (or `healthFloor`), which samples on its own clock and reads 0 for any death in the window.
- `test-find-live.mjs` judges a spot by its `expectCode` on the last call, else the last find's sighting, else (no find call, such as a lava room) no damage. Every spot also needs no death. A spot with no find call prints PASS or FAIL, never NOT FOUND. A spot that did not play is INVALID, never a pass on standing still: no call ran, a call never reached the body (the harness threw, or the server refused it `STALE_REVISION`), or observations were lost; a find that never reached the body is no "not found" either. `repeat` re-asks a find unless FIND_BLOCKED; another tool is re-asked only on a reason code listed in the spot's `repeatOn`.
- `boot()` proposes the survival the goal text asks for (`Survive for N seconds`), or `goalTicks` when that is longer, so a short `goalTicks` no longer stops `goal_control` from arriving. It also follows every newer goal revision the server sends, such as a low-health hand-back that moves the revision with no `goal_control`. `run-incident.mjs` turns this off (`followRevision: false`) because the production coordinator owns its bridge.
- `damageTaken` uses vanilla `damage_taken` in HP. `netHealthChange` is separate; a healed hit still counts. Missing/decreasing counters invalidate a no-damage claim. A missing optional report is absent; a broken report sidecar is invalid.
- Use `node scripts/quality/run-incident.mjs --incident lava-gate-seed-2 --out FRESH_DIR --jar MAIN_JAR` under the live slot for acceptance through the production coordinator. It asserts seed-kit start state, logs decisions by actor, counts unique terminal receipts, verifies source lava and damage, and confirms server exit before cleanup. `--help` needs no server. No model is called.
- Build/find/find-spot remain body mechanics tools until a product lane migrates its chain. Their results cannot certify coordinator behavior. The removed `steer:true` emulation now exits 2 with the production-runner pointer; it never silently falls back. Repeated-stop headings in the build diagnostic are fixed (`retry.heading`, default east).
- Finish the lane with three lines in `$ARENA_PRIVATE_INPUTS/docs/gameplay-friction/<pr>-<slug>.md`, using the [friction format](../../docs/gameplay-friction/README.md). Store per-run evidence under `$ARENA_PRIVATE_INPUTS/docs/verification/<pr>-<slug>/`.

## Gate report and product funnel

Every PR's sticky stake comment shows the product funnel: seeds that reached the iron pickaxe, bucket, flint and steel, lava seen, portal lit and the Nether, with median minutes, deaths and cost. It comes from the newest `docs/gates/gate-N.json` on the PR base, or from one the PR adds. No game runs for it. A tree with no gate file gets a comment without product numbers; gate files record usage, so a public copy of this repository ships none.

- Build a gate file from saved run folders: `node scripts/quality/gate-report.mjs --gate N --title T --out docs/gates/gate-N.json --cohort NAME LABEL DIR... [--cohort NAME LABEL DIR...]`. A long-run folder (`sub/long/<tag>-codex`) gives its commit (from the runner log beside it), seed, model, deaths and cost. A scripted obtain folder (`sub/farm/<round>/<seed>-r<n>`) measures only its item. A standard round folder (its `manifest.json` lists the games) or one of its `game-N` folders gives each game from `timeline.json`, `spend.json` and `raw/manifest.json`; it measures every milestone through ender pearls, and the first bucket comes from `raw/quality-samples.jsonl`. Lava seen is the first lava shown to the model; portal lit is the first `PORTAL_LIT` result, or the Nether entry when no result was logged. A seed that never reached a milestone stays in its median as censored at the minutes its game played (a Kaplan-Meier median), so a game that stopped early never ranks behind a longer one that reached the milestone; `censoredEarly` counts the seeds that stopped over a minute short of the window. When the median cannot be told from the games (half or more never reached it while still playing), it is unknown (–). A game started from a save point (`startKind` other than `fresh`) inherits its first stages and items, so it measures no milestone and the gate's notes name it. Each run and cohort counts `deathCauses` by cause; a round game reads a cause its timeline lacks from the game's death receipts in `raw/` at any goal revision, since the revision moves during a game. Runs with `raw/quality-samples.jsonl` also report Nether minutes, deaths after the first entry, and for each Nether death the respawn distance from the Overworld side of the entry portal and the minutes until back in the Nether (or until the game ended).
- Each game carries its model (`modelId`), `effort` and stop rule (`stopKind`: `window`, `cap`, `stall`, `goal` or `other`, from `long-run.json`'s `stop`, the operator stop, or a round game's `controller.json` `reason`; `null` when none was recorded). `censoredEarlyBy` splits `censoredEarly` into `cap`, `stall`, `other` and `unrecorded`, and the command prints a per-game table with a model column. Two cohorts whose games ran different models or efforts, or a cohort that mixes them or leaves one unrecorded, are refused; pass `--allow-model-mismatch` when the comparison is meant to compare models, such as two model arms on the same seeds and commit. The report then names the comparison as cross-model in its notes.
- Two cohorts on the same seeds are a pair (before and after); the comment adds a before → after column, using each seed's first run on both sides. A gate one commit ran pairs with the previous gate file when both ran the same seeds with the same model and window (gate 3 → gate 4 is #179 on 8 seeds). The report names every seed without a pair, and the comment says "no pair" when there is none.
- The same seed run more than once on one commit is a repeat. In the three #178 rounds (`repeats-178.json`, kept beside the gate files), round 1 ran each seed twice on one commit and 3 of 8 seeds flipped pass/fail on the iron pickaxe.
- **Rule of thumb: a difference under 2 seeds is "no change".** The repeats above show one seed's result can flip with no code change.
- The comment also runs `search-danger-replay.mjs` and `portal-route-replay.mjs` over the gate 3 logs on the coordinator host with the base tree's modules, then the head's, and prints base → head. With no logs it says "no corpus"; a base that lacks a replay's module reads "not comparable". `ARENA_GATE_LOGS` points at another `sub/long` folder.

Use generated reports for metrics. Search raw logs to locate events, then follow their action IDs; repeated reason-code text in observations is not an event count. Keep cancelled/unobserved runs in the report without counting them as played failures.

The harness runs fixed-seed Minecraft scenarios against a real headless Fabric server, the live coordinator and a real model provider, then extracts token, cost, survival and progress metrics from the retained traces. Its paired mode compares two pinned builds (arm A and arm B) in counterbalanced order and produces one verdict.

## Requirements

Run from the repository root with:

- Node 22 or newer
- Java 25
- a built mod JAR (`./gradlew build`; `.\gradlew.bat build` on Windows)
- a prepared Fabric server template: `node scripts/prepare-server-template.mjs --accept-minecraft-eula` on any OS (`scripts/prepare-headless-server-template.ps1` on Windows), then `export ARENA_HEADLESS_SERVER_TEMPLATE=<the folder it prints>`. `node scripts/doctor.mjs` checks all of these.
- a signed-in Claude or Codex CLI

## Paths and environment

| Setting | Argument | Environment variable | Default |
|---|---|---|---|
| JDK | `--java PATH` | `ARENA_HEADLESS_JAVA`, then `JAVA_HOME` (uses `bin/java`) | `runtime/toolchains/temurin-25/jdk-25.0.3+9/bin/java` in this checkout |
| Server template | `--server-template PATH` | `ARENA_HEADLESS_SERVER_TEMPLATE` | `runtime/server-template` in this checkout |
| Harness identity | `--harness-commit HASH` | `ARENA_QUALITY_HARNESS_COMMIT` | none |
| Output | `--out DIR` | none | `runtime/quality-results/quality-<time>` |

Arguments win over environment variables. `--port-base N` assigns bridge, RCON and Minecraft to `N`, `N+1` and `N+2`, and fails if one is occupied. Without it, the existing launcher allocates free ports. On a synced checkout without `.git`, pass `--source-commit HASH`; expected artifact fingerprints still attest the actual files, but Git cleanliness and HEAD cannot be verified there.

## Faster fixture servers

Every `boot()` from `watch-replay.mjs` (the shared start of most provider-free fixtures) builds its server folder from links into one prepared server per template: the template plus the libraries and version jar that vanilla's bundler would otherwise unpack on every start. A case folder holds ~14 MB of its own files instead of ~150 MB, and the template itself is never written. `ARENA_FIXTURE_COPY_TEMPLATE=1` copies the template as before.

`scripts/quality/fixture-servers.mjs` adds opt-in cuts that `test-build-live.mjs`, `test-find-live.mjs`, `test-gather-live.mjs` and `test-dig-live.mjs` use:

- **Warm next server.** `warmBoots(cases, planOf)` boots the next case's server while the current case plays and holds it with `tick freeze` until its case takes it, so its clock, weather and mobs start where a fresh boot's would. Every case still gets its own JVM, world copy and port triple inside the slot. A server booted ahead holds a free `slot.sh` live slot (flock on `live-N.lock` in `ARENA_SLOT_LOCKS`, default `~/Desktop/Projects/arena-beat-game/locks`) until its case takes it, so the shared slot budget counts its memory and CPU. With every live slot busy, or less than `ARENA_FIXTURE_AHEAD_MIN_MB` available (default 4096), the case boots on demand. `ARENA_FIXTURE_AHEAD=0` always boots on demand, and `ARENA_FIXTURE_AHEAD=2` keeps two booting for batches of cases shorter than a boot (build: 25.6 → 20.9 s per case in one run; about 0.9 GB per waiting server). On a machine without slot locks it boots ahead only when `ARENA_FIXTURE_AHEAD` is set. Each run prints `[fixture] case N/M server booted ahead, waited X s`, the playing server's tick time (`tick query`) while the next one boots and at each case's end, and the worst of both at the end.
- **Throwaway worlds.** A case reads its results from the live server, and play never reaches disk (autosave runs every 5 minutes), so `warmBoots` kills each server instead of a 2-12 s world save and deletes its `server` folder; `server.log` stays. `ARENA_FIXTURE_KEEP=1` (or `BUILD_KEEP=1` for `test-build-live.mjs`) keeps every case's world, saved at stop, to open afterwards.
- **Seed world cache.** `boot(dir, { seed, worldCache: true })` saves a seed's world the moment its first server is up, before any fixture command, and later boots copy that save instead of searching for a spawn and generating it. The key covers the server jar, mod jars, the arena jar and every world property (seed, level type, monsters), so a new build generates afresh. `ARENA_FIXTURE_WORLD_CACHE=0` turns it off.

`test-cornered-live.mjs` plays every case on one server, so it uses only the seed world cache. Its first summon after boot is often refused at once with `MODEL_CATALOG_UNAVAILABLE` (the mod applies boot's model catalog at the start of a later tick); it now asks again after 250 ms instead of waiting 30 s for a registration that cannot come.

Prepared servers and cached worlds live under `ARENA_FIXTURE_CACHE` (default `~/.cache/mineagen/fixtures`: ~135 MB per template, a few MB per seed). To move another fixture script over, replace its `for (...) { const s = await boot(dir, options); ... }` loop with:

```js
import { warmBoots } from './fixture-servers.mjs';
for await (const { item: spot, dir, server: s, error } of warmBoots(spots, (spot, index) => ({ dir: path.join(out, `spot-${index}`), options: { jar, template, port, seed: String(spot.seed), worldCache: true } }))) {
	if (!s) { /* this case's server failed to boot twice: record invalid evidence (error) and go on */ continue; }
	try { /* the case, unchanged */ } finally { await s.stop(); }
}
```

Measured on the shared coordinator host (Nov 8, same 12 cases interleaved, 5 runs before and 3-4 after, every outcome identical): gather 54.5 → 37.9 s per case, dig 65.5 → 43.4 s, build 35.1 → 25.6 s.

## Faster provider-free fixtures (test only)

The body counts its time limits in game ticks (`GameClock`: 50 ms of game time per server tick), so a provider-free fixture can run the server faster with `/tick rate N` and still play the same game: a 20 s timeout is 400 ticks at any rate. A fixture opts in by passing `tickRate: fixtureTickRate()` to `boot()` in `watch-replay.mjs`, which then reads `FIXTURE_TICK_RATE=N`. A fixture that does not opt in boots at 20 TPS and prints a warning when the variable is set, because its own waits would be wall time and cover several times the game time at a raised rate. Fixtures that opt in wait with `s.gameSleep(ms)` and time windows with `s.gameTimer()`, which read the world clock, so their own waits stay the same length in game time (at 20 both are the plain wall-clock waits they replaced). A fixture sets up at 20 (`s.normalRate()`) and raises the rate only while the body acts (`s.fastRate()`): the harness's own steps take wall time, and at a raised rate more game time passes between them (a body damaged to 8 health regenerated before the next read). Change the rate with `s.setRate(n)`, never a raw `/tick rate` command: `s.rate` tracks what the server runs at, so `s.normalRate()` always brings it back to 20. A setup wait in which the harness sends and reads nothing (spawn protection running out, a body settling) can use `s.idleSleep(ms)`: it passes at the fixture rate and returns to the rate the server ran at, so it is the same game time in a quarter of the wall time at 80. Cornered and dig use it for their setup waits. Both write cumulative vanilla `damageTaken` alongside health and deaths, so healing cannot hide damage in speed comparisons. A missing or decreasing counter is invalid evidence (exit 2). `test-cornered-live.mjs` and `test-dig-live.mjs` opt in. Each run row records `tick`: the rate asked for (`askedTps`) and the rate the world clock reached while the body acted (`reachedTps`, game ticks per wall second from `s.gameTimer().rates()`), so a comparison shows what each side really played at; a fixture that never raised the rate reads 20 both times. `test-build-live.mjs` opts in. Its play loop and the tool runtime it drives both time play in game time: the fixture's deadlines and waits run on `s.clock`, which is plain wall time at 20 TPS and the world's game tick at a raised rate. The runtime takes `clock: gameClockFromObservations({ tickRate })` from `coordinator/src/game-clock.mjs`, which covers find deadlines and sighting checks, gather, obtain, wait and program deadlines; the coordinator passes no clock and stays on wall time. Its damage sampler starts a sample every 500 ms of game time. Rows record `seconds` (game), `wallSeconds` and `rates`. On boat, 19 wall-portal rooms x 3 repeats (cast-obi-3 twice, so 60 runs a side) at 20 and at 60 TPS side by side, same jar, passed 32/60 and 31/60 with 5 deaths on each side; in 17 of the 20 room comparisons the pass counts were within 1 of 3 and the median game seconds within 14%, and play took 280 min of wall time at 20 against 107 min at 60. Five rooms missed the bar set before the runs (pass counts, harm where 20 TPS had none, and median game seconds and walked distance within 25%): cast-obi-3 (5/6 at 20 against 3/6 at 60, one of them a fall read before the sampler kept game-tick spacing), lava-gate-2 (one zombie death at 60 in 3 runs, none at 20), lava-gate-5 (dangerous at both rates, but its runs at 60 ended sooner), lava-gate-4 and lava-gate-8 (both rates died once or more; walked distance or game seconds differed by more than 25%). The 10-run A/B under "Which fixtures run at 60 TPS" below cleared lava-gate-2 and lava-gate-4; the other three still run at 20. The runtime also stamps the samples behind its 60 s repeated-failure window, its start-sample age and its body ends with the game clock (`clock.at(sample)` in `game-clock.mjs`), so those facts count game time too; the program executor's cancel acknowledgement is a bridge round trip and keeps wall-time timers. `test-rest-live.mjs` waits in game time but stays at 20 TPS and warns when `FIXTURE_TICK_RATE` is set: at 80, 2 of 6 walled-in nights took 3-4 damage and 1 of 6 bed nights could not place its bed, which no run at 20 did, and the cause is not known. Its own `TICK_RATE` (default 60) still speeds up a walled-in night once the body is sealed in.

```bash
FIXTURE_TICK_RATE=60 CASES=corridor REPEATS=3 /path/to/recordings/arena-beat-game/slot.sh live node scripts/quality/test-cornered-live.mjs runtime/cornered-fast
```

Server start and world generation do not speed up; time in play does. `measure-tick-rate.mjs` measures what a machine holds with 1 to 4 bodies kept busy (`summary.json` per body count: `highestHeld` is the highest rate held with every lower rate held too, `notHeld` the misses, `leastBusy` the smallest share of body time spent working in any sample). One sample per rate is noisy on a shared machine, so pick a rate below `highestHeld` across several runs. `test-lag-clock-live.mjs` checks the reverse: a lagging server (`LAG=rate:10` or a real `LAG=crowd:N` pig pit) must not cut a `travel_to` or `dig_to` short. In model play the coordinator moves a program's wall-clock deadline out by the wall time the server fell behind the game clock (at most three program timeouts), so the body's own timeout still comes first. Model runs keep 20 TPS: provider timeouts are wall time.

## Room batches on boat and Windows PCs

`room-batch.mjs` plays a batch of practice rooms x arms on boat machines instead of waiting for a local live slot. It splits the batch by room, never by arm: each machine pulls the next room from one shared queue and plays all of its arms side by side (`SLOT_PORT_BASE` 28000, 28100, ...), so machine and load differences never become the A/B delta. A commands file has one line per room; the line runs once per arm with `$JAR` for that arm's jar and `$OUT` for a fresh output folder, and `@ROOM:ARM ...` gives one arm its own line:

```text
@carve-hidden-lava BUILD_ONLY=carve-hidden-lava node scripts/quality/test-build-live.mjs scripts/quality/carve-hidden-fluid-spots.json $OUT $JAR --descriptive
```

```bash
node scripts/quality/room-batch.mjs --commands ROOMS.txt --arm new=NEW.jar --arm old=OLD.jar --pool boat --vms 5 --out FRESH_DIR --snapshot IMAGE
```

- **Code.** The machines run `--code REF` (default `HEAD`) as `git archive` of the paths fixtures use (`BUNDLE_PATHS` in `lib/boat-pool.mjs`: `scripts/`, `coordinator/src`, `coordinator/config`, `coordinator/test/fixtures`, `docs/`, ...) plus this checkout's `coordinator/node_modules`; the Java sources and the coordinator's tests stay home. `coordinator/test/room-batch.test.mjs` walks every live fixture's imports and fails when one leaves that list. A local file a line names by absolute path, such as a private spots file, is copied to every machine and the line points at the copy.
- **Overhead.** Each `boat ssh` or `boat scp` costs about 2.7 s before a byte moves; `boat exec` answers in about 0.4 s but takes no input. So code, helper, jars and inputs travel as one zstd bundle (its long window packs the second arm's jar almost free: about 7.5 MB for two arms) in one ssh that also unpacks and checks the machine; a room starts with one exec that writes its job and launches the helper; and one ssh at a time waits up to 60 s for the room's `done.json` and, once it is there, brings the room's folder back in the same call. Measured with two 5.6 MB jars: prepare 29 s before, 4.2 to 6.4 s after (one run took 14.8 s); start 6.5 s before, 0.4 s; a room's end seen 0.1 to 0.3 s after `done.json`, or up to about 3 s when it lands while the next wait is connecting, against about 10 s on average (20 s polls) before; fetch 7 s before, nothing extra after. `batch.log` gives each machine's prepare time split into bundle transfer, checks and ssh. Without zstd on this machine the bundle falls back to gzip: 12.7 MB, prepare 11 s. A machine that vanishes mid-wait breaks the ssh, and `boat info` no longer finds it, so it counts as lost.
- **Output.** `OUT/rooms/ROOM/ARM/` holds each room's fixture folder unchanged (never flattened: `spot-N` names repeat across rooms), with `ARM.log` and `done.json` (exit, seconds, `Can't keep up` lines, lowest available memory). `OUT/ARM/result.json` and `result-summary.json` come from `finishRun` over every room's rows (each arm's `NAME.json` beside its `NAME-summary.json`: `result` first, else the one such pair, as `acceptance.json` in drawn-bow or `runs.json` in end-breath; several others read INVALID) with `planned` counting every room, so a missing room reads as `notStarted` and the arm as INVALID. `OUT/summary.txt` gives per arm pass, fail, invalid, notStarted, lost rooms, deaths, damage (unknown, never 0, when a row has no counter) and room time, then one line per room. `OUT/batch.json` records the code, jar hashes, image, outcomes and each machine's boat usage.
- **Valid runs.** `--valid N` replays bad starts. Rooms `ROOM.c1`, `ROOM.c2`... (or `-r1`, `-r2`...) are one repeat group; while any arm of a group has fewer than N valid runs (PASS or FAIL rows, as the merge counts them), another copy `ROOM.cK` plays every arm side by side, so the arms stay paired, up to 2N planned runs an arm. Copies still queued or playing count toward N, so a group asks only for its shortfall. `summary.txt` ends with the number of top-ups and the groups still short at the cap; `batch.json` has `topUps` per group. Judge such a group on its valid runs: the arm's status still reads INVALID while any copy was invalid.
- **Warm pool.** Boat counts every create, fork and resume as a start against per-minute, per-hour and per-day sandbox start limits; `boat extend`, ssh, scp and exec are not starts. So machines are kept running and reused. A batch first leases free running machines of the same image and size from this computer's pool (named `rbpool-POOLID-TYPE-IMAGE-...`; lease files under `ROOM_BATCH_POOL_DIR`, default `~/.cache/mineagen/boat-pool`) with no start, and creates only the shortfall. Creates are paced over every batch on the computer (`ROOM_BATCH_STARTS_PER_MINUTE`, default 20), retried when the minute window is full, and refused when the hour or day window has 5 or fewer starts left. A lease holds the batch's pid and a heartbeat, so the lease of a batch that crashed or hung is broken by the next one, and two batches never get the same machine. Before a machine goes to a batch, and when it comes back, every process the last batch left under `~/batch` or on the image's Java is killed, room ports are checked free, and `~/batch` and the fixture worlds cache are wiped; the image and prepared servers stay. No batch deletes or stops a machine. One that fails that check (its marker names another image, Java or the template is missing, a process will not die) is set aside: it keeps running, no batch leases it, and `status` lists it until `prune` deletes it. Every other machine goes back to the pool running, with its auto-stop set to `--idle-ttl` minutes (`ROOM_BATCH_IDLE_TTL_MIN`, default 60); a machine with auto-stop turned off keeps it. A Windows batch (`--pool windows`) is unchanged. A machine of an image saved again under the same name is never reused. `--machines ID,...` (or `ROOM_BATCH_MACHINES`) uses exactly those running machines instead: leased, cleaned and given back the same way, never created or deleted. `--ephemeral` (or `--no-reuse`) makes throwaway machines and deletes them. Rooms start on each machine as soon as it is ready, not once the slowest one is.
- **Pool commands.** `node scripts/quality/boat-pool.mjs status` lists the pool's machines (busy and which batch, or idle; image; time to auto-stop). `warm N --snapshot IMAGE [--type TYPE]` starts only the shortfall up to N machines and leaves them idle. `keepalive [--warm N] [--grace MIN] [--keep PREFIX,...] [--every MIN]` keeps a warm pool without paying for idle machines nobody needs (an idle machine bills in full): it pushes the auto-stop of busy pool machines, of the N idle ones given back most recently and of running machines whose name starts with a `--keep` prefix (a benchmark's own `bench-` machines) to at least the idle TTL, never earlier, and deletes idle pool machines beyond the warm N once idle `--grace` minutes (default 10), longest idle first, after taking their lease and checking nothing runs there. Anything else reaches its auto-stop. `drain` deletes idle machines (busy ones are left to their batch), and `prune` deletes machines that are not running, are of an image that was rebuilt or deleted, or were set aside, and clears stale leases. Only these commands and `keepalive --warm` delete a machine. A new machine made from the image gets its first room only once boat reports it `hydrated` (its files fully downloaded, 12 to 25 s): 7 of 8 first rooms started earlier came back INVALID, against 10 of 10 after.
- **Lost machines.** A machine with no room left to take leaves the batch at once. A machine that stops answering (5 minutes, or boat no longer lists it running) leaves it too, and fails its cleaning check unless it answers again; its room goes back to the front of the queue once, for another machine, and a replacement machine comes up. A room lost twice is reported `LOST`. A room's arms are killed after `--room-timeout` minutes (default 40).
- **Disk syncs.** Each room runs under `eatmydata`, which turns `fsync` into a no-op. A boat disk takes about 39 ms per `fsync`, and a server's first `save-all flush` on a freshly generated world syncs every chunk: it took 51 s there, past the fixtures' 30 s RCON timeout, so every room on a new jar came back INVALID with `RCON command timed out`. With it the same room boots in about 14 s and passes. No room's writes need to survive a crash: the next batch wipes them. `prepare` refuses a machine without `eatmydata`.
- **Stopping.** Ctrl-C (or SIGTERM) kills every room and gives the machines back to the pool (deletes them with `--ephemeral`); unfinished rooms read `LOST (batch stopped)` and the command exits 130.
- **Cost.** Every machine is `--no-env` (rooms make no model calls). Boat stops a machine at a fixed deadline, not when idle, and a stop erases it (`--no-snapshots`), so the runner pushes the deadline back while rooms remain, and a machine back in the pool gets the idle TTL; the deadline stops a machine whose runner died and an idle pool nobody uses. A deadline is only ever moved later. `--type` (or `ROOM_BATCH_TYPE`, default `default`: 4 vCPU, 8 GB) picks the size.
- **Windows PCs.** `--pool windows` plays the same batch on Windows PCs over ssh instead of boat machines. `ROOM_BATCH_WINDOWS=<sshHost>:<slots>:<slotBase>,...` names each PC, how many rooms it plays at once and its slot base; `--vms` defaults to every slot. Room slot `i` of a PC gives its arms one 100-port range each from `28000 + (slotBase + i * arms) * 100`. Hyper-V reserves TCP ranges at boot, so the batch reads `netsh int ipv4 show excludedportrange protocol=tcp` on each PC and refuses one whose ports overlap them; raise that PC's slot base. A PC that must be free from a set time takes a cutoff after its slot base, read on the clock of the machine running the batch: `<sshHost>:<slots>:<slotBase>@01:30` closes it the next time that clock shows 01:30, and `@01:30-09:00` also keeps it closed until 09:00, so a batch started inside that window plays nothing there. From the cutoff no room starts on that PC, and a room still playing there is stopped as soon as the poll at the cutoff answers (seconds; up to 2 minutes when ssh hangs), its process tree killed, and put back in the queue for another PC without spending one of its two tries. Each PC must already hold Temurin 25 at `C:/aa-runs/jdk25`, the server template at `C:/aa-runs/templates/26.3`, Node 22 or newer and OpenSSH; nothing is installed. The code, jars and inputs go to `C:/aa-runs/batches/BATCH/` once per PC, and each room starts through WMI so it outlives the ssh session, with no `eatmydata` (it is Linux only; the first Windows rooms passed in about the boat time without it). The room's parent keeps the PC awake while it plays. When the batch ends, also on an error or Ctrl-C, every room's process tree is killed and the batch folder deleted; no PC is ever slept or shut down. A 16-thread, 32 GB PC played 10 to 12 games at once without lag in an earlier measurement, so about 5 two-arm rooms.
- **Image.** `node scripts/quality/room-image.mjs --template TEMPLATE_DIR --snapshot IMAGE --warm-jar JAR` builds the saved image the batch forks from: Temurin 25.0.5 (hash-checked) and the server template under the machine's `rooms/` folder, `eatmydata` and `zstd`, plus the prepared server from one warm-up room. It saves the image only when that room passes; the same `--snapshot` name replaces the old image. Rerun it when the template or Java changes. `--snapshot` (or `ROOM_BATCH_SNAPSHOT`) names it for the batch.

### Which fixtures run at 60 TPS

Provider-free live fixtures play on the game clock with setup at 20 TPS and play deadlines, windows, samplers and stand-in waits on `s.clock`. The exceptions are `test-barter-odds-live.mjs` (vanilla odds, with its own clock speed), `test-lag-clock-live.mjs` (a lag test), `test-rest-live.mjs` (its own `TICK_RATE` speeds up a sealed night), and `test-escape-live.mjs` and `test-iron-kit-live.mjs` (wall-clock play). A fixture that starts its own server, RCON client and bridge gets the same helpers from `handRolledTickRate(command, bridge, agent)` in `lib/fixture-play.mjs`, whose `rate.play()` raises the rate for one case and returns what it ran at.

A game-clock fixture takes `FIXTURE_TICK_RATE` (`tickRate: fixtureTickRate()`) only after an A/B showed it plays the same game at 60. Other game-clock fixtures pass `unshownTickRate('what differed')` and stay at 20 with a warning. `FIXTURE_TICK_RATE_UNSHOWN=1` runs those fixtures fast for the next A/B. `coordinator/test/quality-fixture-tick-rate.test.mjs` checks these rules.

The A/B (boat, same jar, 20 and 60 TPS side by side on one machine, 10 runs a side of 96 rooms from 43 fixtures; bar: passes within 3 of 10, no harm at 60 where 20 had none, median game seconds and walked distance within 25%) gave:

- **Shown at 60 (35):** bed, bed-spawn, bow-crystal, build (except the rooms below), caged-crystal, controller-contracts, cornered, crowd, defend, dig, drawn-bow, end-breath, enderman, end-survive, end-void, find, find-spot, fire, gather, gold-route, knockback-edge, nether-fight, nether-gather, portal-walkin, ranged-blaze, reflex-failspots, route-recovery, savepoints, shelter, shelter-forest, shelter-ranged, shelter-terrain, travel-resume, warped-pearl, water. Rest's own `TICK_RATE` 60 against 20 matched too (3 rooms, 0 deaths either way). Two rows miss one line of the bar for reasons that are not the speed: dig's 10 s shaft-nobucket-lava-cave room averaged 46 TPS over its short window (same results, 10/10 both), and end-breath's rim-command-into-cloud did not form its cloud in reach in 3 runs at 20 and 1 at 60.
- **Missed the bar, at 20:** default-reflex (in 4 of its 8 cases the body lived at 20 and died at 60: its watch counts polls), dragon (no pass check; the perched fight ended in another dragon phase), travel (its y55-fortress course died in 4 of 10 runs at 60, 0 at 20; the other six courses matched), cornered-creeper (1 death in 10 at 60, none at 20), count-stance (bow-crouch passed 0 of 10 at 60: it counts samples), bucket-aim (6 of 10 against 10 of 10), unreachable-enderman (its switch-off arm was hurt once in 10 at 60, never at 20), barter (piglin returns land elsewhere while harness round trips pass more ticks), lavawork (a lava-pop count carried over from earlier scenarios), netherbody (knockback reads land later in the fall). barter, lavawork and netherbody were judged on the pilot plus 2-3 re-runs, the rest on 10 runs a side.
- **Not shown yet, at 20:** cast-barter, dig-options, kill-drops, place-face, portal-frame, reflex-combat, reflex-core and shelter-repair already fail at 20 (the same checks fail at 60); respawn-recovery is flaky at 20; routines and blaze-spawner had pilot runs only; flee-forest, progress and obtain need private inputs the A/B did not have.
- **Build rooms:** lava-gate-2 and lava-gate-4 now pass the bar over 10 runs. cast-obi-3 (8 of 10 against 5 of 10 passes, 1 death at 60 only), lava-gate-5 and lava-gate-8 (median game seconds +50% and +33%) still miss it: run those at 20.
- **Wall time:** the 959 paired rooms took 2154 machine-minutes at 20 and 1103 at 60 (0.51, boot and setup included); long rooms such as travel, rest, gold-route and warped-pearl take 0.36-0.41.

### AI rooms: the real model in a practice room

An AI room is a practice room played by the real model (GPT-6.2 Sol, low reasoning, through Codex) and the production coordinator instead of a script, so one short run tests the brain and the body together. It sits between practice rooms (minutes, no model) and checkpoint games (hours).

```bash
node scripts/quality/room-batch.mjs --player model --jar JAR --codex-auth AUTH.json [--ai-rooms ROOMS.json] [--rooms ai-cast-1,ai-skeleton] [--repeats 5] [--no-script] --pool boat --vms N --snapshot IMAGE --out FRESH_DIR
node scripts/quality/ai-room-report.mjs FRESH_DIR
```

- **Rooms.** `ROOMS.json` (default `scripts/quality/ai-rooms.json`) is a scenario file in the format of `reflex-rooms.json`: seed, `goal` (what a player would be told), `durationBudgetMs` (the time cap, counted from the goal start), `setup` (the practice room's start state: position, kit, terrain commands, time, mobs) and `successCheck` (`ladder-evaluator.mjs` grammar; `position_within_xz DIM (X, Z) radius R` ignores height, for a walk over or round a hill). `aiRoom.standIn` is the practice-room line for the same room, `aiRoom.pass.noDamage` asks for 0 damage as the practice room does, and `aiRoom.verdictGap` says where the two verdicts differ.
- **Arms.** Each repeat of a room plays arm `ai` (`run-ai-room.mjs`) beside arm `script` (the stand-in) on one machine, both on `JAR`. The stand-in runs through `ai-room-standin.mjs`, which leaves the fixture alone and, when the fixture writes only its own report (`test-drawn-bow-live.mjs`, or a `test-travel-live.mjs` output from before it wrote `result.json` itself), adds the `result.json` rows the batch merges, so `summary.txt` and the report count the same pass, deaths and damage. `--no-script` plays the model alone.
- **Play.** `run-ai-room.mjs ROOMS.json ROOM_ID OUT JAR` runs the room through `run-ladder.mjs`: a fresh fixed-seed server, the coordinator with the Codex provider, the goal, 1 Hz samples and early stop when the check holds. Both arms play at 20 ticks per second, since provider timeouts are wall time; a raised `FIXTURE_TICK_RATE` is refused.
- **Verdict.** PASS when the check held, with 0 deaths, and 0 damage when the room asks for it. INVALID, never a pass or a fail, when the model made no gameplay call (goal translation alone does not count), any sample lacks the death or damage counter, the run's evidence could not be copied, or the run lost evidence. A room the evaluator stops early often ends while the last call's token row is still open; that run stays valid with `tokensReconciled: false` (token counts approximate).
- **Sign-in.** `--codex-auth` (or `ROOM_BATCH_CODEX_AUTH`) travels to each machine as a batch input. Give several (`--codex-auth A.json,B.json`, or the flag twice) to spread the model calls across accounts: the AI rooms take them in turn, room by room. The room copies it into a private `CODEX_HOME` beside that input (inside `~/batch`, which the warm pool wipes on every lease and return, so a room killed with -9 leaves no copy on a reusable machine) and deletes it after. When Codex rewrote the sign-in during a room, the room exits 4 and room-batch stops the whole batch (exit 4): the refresh can sign out every other copy. The room's copied artifacts leave out the world, the coordinator's Codex workspace (it holds a copy) and the RCON password. A machine without the `codex` CLI gets the pinned one under `~/.local`.
- **Time.** On top of the play, an AI room spends a median 38 s (28 to 165 s over 51 rooms) booting the server and turning the goal text into a goal. Once, the coordinator's first translation call timed out at 120 s and its retry answered at once.
- **Report.** `ai-room-report.mjs OUT [OUT...]` prints per room and arm: passes over valid runs (invalid ones apart, including rooms `batch.json` planned that were lost or never started), deaths, damage taken in HP, median minutes (the model's play time; the script arm's own play time where its fixture reports one, else its whole run) and the model's median calls. Several batch folders of the same rooms pool their repeats.

## Practice-room benchmark

`benchmark.mjs` plays every provider-free practice room 10 times on boat machines through `room-batch.mjs`, scores each room, and compares the result with a saved baseline, so a change can be judged against the whole set and not one room:

```bash
node scripts/quality/benchmark.mjs --jar NEW.jar --code REF --slots 2 --machines ID,ID,... --baseline BASELINE.json --out FRESH_DIR
```

- **Rooms.** `benchmark-rooms.json` lists every room the repository can play without a model: one case or spot per room where the fixture can pick one, with its game stage (early, iron-kit, portal-lava, nether-fortress, nether-rods, nether-pearls, end), its skill (combat, movement, building, survival), the room-batch line and the tick rate (60 for build rooms, 20 for the five build rooms that missed the 60 TPS bar and for every other fixture). A second `--rooms FILE` kept outside the repository adds rooms whose spot files are private; room-batch copies a file a line names by absolute path to every machine. `--only ROOM,...` narrows the set. `lib/with-jar.mjs` lets a fixture that reads the jar from the build folder (bed, bucket aim, kill drops, portal frame, routines) take `$JAR`, and fills in `'$SLOT_PORT_BASE'` for netherbody.
- **Repeats.** Each room plays `--repeats` times (default 10) as `--slots` rooms side by side on one machine (arms `r1..rK`, same jar) x `ceil(repeats / slots)` copies (`ROOM.c1`, ...), longest rooms first. Use `--slots 2` on `large` machines: on one 8 vCPU machine, 1 and 3 rooms side by side gave the same results, while at 5 the long lava-gate room took damage in 4 of 5 runs against 0 of 4 at 1 and 3 (calibration, 21 Nov).
- **Score.** A run is a row of the fixture's finishRun pair (`result.json`, or another `NAME.json` with its `NAME-summary.json`, found as room-batch finds them) judged by `roomVerdict`; a missing, corrupt or INVALID summary, or fewer rows than it planned, makes those runs INVALID, never a pass. A fixture outside `finishRun` is one run judged by its exit code, with deaths and damage taken from its own JSON files where it writes them (`died`, `deaths`, `survived`, `damageTaken`, `healthLost`, and `damage` beside a death field; unknown, never 0, where it does not). A fixture with no pass bar of its own (`bar: "none"`) passes when the body survived and is INVALID when it records no death count; a room's `passWhen: { field, min }` adds its own bar (pearls held at the end). `plan.json` keeps the room definitions, so a later `--score` judges a batch the way it was planned. Per room: pass rate over valid runs, deaths, damage, median game seconds and the top failure reasons (the last failed call's code, or the reason with numbers folded). Totals per stage and per skill. `OUT/score.json` is the baseline format, `OUT/scoreboard.md` the table.
- **Compare.** With `--baseline FILE`, each room's pass count is set against the baseline's with a two-sided Fisher exact test, and that p is Holm-adjusted over every room compared (`p=` and `Holm` in `comparison.txt`): `better` or `worse` when the adjusted p is under 0.05, else `within noise`. Without it, chance changes add up over many rooms: at 10 runs a side an unchanged room reads changed about 1.3% of the time (Fisher is conservative there), so a 100-room benchmark shows about one. The adjustment costs power on a short list: 0/10 against 5/10 (p .03 alone) is within noise among 18 rooms, which is what the pooled test below is for. At 10 runs a side only large changes clear it (0/10 against 5/10 does alone, 5/10 against 8/10 does not). `--score OUT` scores a finished folder again; `--save-baseline FILE` writes the result as a new baseline.
- **Pooled test.** `--targets ROOM,...` names the rooms the change is meant to improve. The comparison then ends with two exact tests, each room its own stratum: `target rooms` (is the change better there, `p(better)`) and `guard rooms`, every other room (is it worse there, `p(worse)`). A target left out of its pool (unknown, not run on a side, or no valid runs) is listed. A small gain in many rooms adds up here: 30 rooms each at 5/10 -> 6/10 show no single change but pool to p(better) 0.01. Without `--targets` one `all rooms` line answers both ways. The same functions (`compareScores`, `compareGroups` in `lib/benchmark-score.mjs`) score a two-arm room-batch A/B offline: `collectRuns(DIR)`, then `scoreRooms` over each arm's runs.

## Writing a new live fixture

`coordinator/test/quality-fixture-exit.test.mjs` and the tool contracts enforce most of this; the rest is game behaviour that cost earlier fixtures a run.

- Report through `finishRun` from `scripts/quality/lib/fixture-run.mjs` and exit with its code. `--help` prints the outcome line (`exit 1 = unmet acceptance, exit 2 = invalid evidence`) and exits 0 with no Java, template or slot; a run without a slot exits 2. Start from a fixture that already uses `finishRun`; the fixtures on the test's `NOT_YET_ON_FINISH_RUN` list fail this test when copied.
- Pull every observation: call `s.observe()` before reading health, inventory or position. `s.observation` is only the last one pulled and goes stale while a long call runs.
- Give a summoned skeleton its bow in the summon NBT, `{equipment:{mainhand:{id:"minecraft:bow",count:1}}}`; the drawn-bow fixture's first summons arrived unarmed and punched.
- `pick_up_item` takes the drop's entity id (`stableId` or `uuid` from an observation) as `targetSelector`. Names such as `nearest_item` are rejected.
- The model's tool schema sits at its byte budget, 1 byte under on main: three tests pin `MINECRAFT_DYNAMIC_TOOLS` (`coordinator/src/native-minecraft-tools.mjs`) at 39,476 bytes (search `coordinator/test` for `39_476`), and `coordinator/test/token-budget.test.mjs` pins `toolSchemaBytes` at 38,900. A new tool field needs a budget raise in those tests, with its reason in the pull request.
- A Node witness in `coordinator/test/contracts/claims.json` names a test by its exact title, found by plain text search in the test file, so write the title so it reads the same in source: no escaped quotes or apostrophes, no template interpolation.

## Bed parity fixture

`test-bed-live.mjs` checks crafting from 3 wool + 3 planks, two-block placement, vanilla night skipping, the saved bed spawn, and daytime/nearby-monster rejection messages through production bridge actions. It uses an isolated flat-world fixture and no model calls; it does not measure model choices. Build the candidate first, then run with `JAVA_HOME` and `ARENA_HEADLESS_SERVER_TEMPLATE` set:

```bash
/path/to/recordings/arena-beat-game/slot.sh live node scripts/quality/test-bed-live.mjs runtime/bed-live
```

Use a fresh output directory. `manifest.json` identifies the JAR; `actions.json`, `sleep-evidence.json`, `daytime.json`, `monster.json` and `server.log` retain the evidence. Ports come from `SLOT_PORT_BASE`.

## Barter fixture

`test-barter-live.mjs` checks piglin bartering through production actions: with a golden helmet worn, a gold ingot handed over with `interact_entity` and one dropped ahead with `drop_item` are each taken by a calm adult piglin and answered with a return that `pick_up_item` collects; a `drop_item` stack keeps the player as its thrower, as a vanilla Q drop does. No model calls. `BARTER_JAR=PATH` runs the same fixture on another build.

```bash
/path/to/recordings/arena-beat-game/slot.sh live node scripts/quality/test-barter-live.mjs runtime/barter-live
```

### Barter and pearl odds

Loot rolls do not come from the piglin or the mob: piglin barters draw from the world's `minecraft:gameplay/piglin_bartering` random sequence and enderman drops from `minecraft:entities/enderman`, each seeded by the world seed and the table id alone. One save point therefore repeats the same barters and drops in every game (on 2026-10-23 three games from `9-nether-entry-sol-bed-gold10` all got the same 6 pearls from 10 gold). A save point's `setup.randomSalt` (a 32-bit integer) runs vanilla `random reset * <salt>` before the fixture commands, which reseeds every loot sequence; `run-long.mjs --checkpoint` picks a fresh salt per game and prints it (`loot salt N`), `--random-salt N` repeats one, `--random-salt none` keeps the world default. Structure chest contents are fixed when the chest generates and do not change with the salt; mob AI and spawns already differ per game.

`test-barter-odds-live.mjs` measures real barters with 8 adult piglins taking dropped ingots, reseeding the barter sequence per trial: 10, 30 and 60 ingot trials (`BARTER_TRIALS=10x40,30x15,60x10`), game seconds per ingot with one and with eight piglins, and two controls that must repeat exactly (the unsalted world default twice, one salt twice). Vanilla only; no agent body or model. `test-enderman-live.mjs` covers the enderman side: looking past a calm one versus at its head, fights with `fight_target` on open ground and from inside a 1-wide, 2-high tunnel (`ENDER_FIGHTS`), and the salted drop rate (`ENDER_KILLS`).

```bash
/path/to/recordings/arena-beat-game/slot.sh live node scripts/quality/test-barter-odds-live.mjs /tmp/barter-odds
REFLEX_ONLY=look-past,look-at-head,fight-open,fight-tunnel,drop-odds /path/to/recordings/arena-beat-game/slot.sh live node scripts/quality/test-enderman-live.mjs /tmp/enderman
```

### Barter practice room

`test-barter-room-live.mjs ROOM SALT OUT_DIR JAR` plays the barter job as a practice room: a sealed, lit netherrack hall (41 x 41) in the seed's nether wastes, summoned calm adult piglins, one loot salt (`random reset * SALT`) and a 10-game-minute window (`BARTER_TICKS`, default 12000) read from the world clock. Rooms: `held` (192 gold ingots and a golden helmet carried over a worn iron one; 5 piglins 28 blocks off), `blocks` (20 gold blocks and 6 ingots, golden boots worn, as bastion loot; 5 piglins 20 blocks off and a loose hoglin) and `mine` (a Nether start's gold: golden helmet worn, nothing to trade; 39 Nether gold ores in the wall beside the start, a crafting table and pickaxe carried; 4 piglins 28 blocks off), and `guard` (the `mine` kit with no group and one calm piglin caged 12 east and 12 south of the ore face: 17 blocks straight-line but inside the 16-per-axis box vanilla angers when gold breaks; 3 game minutes; it passes when that piglin is never angered). A stand-in plays only calls a model has: `barter_until` re-called after every hand-back, with the recovery a model makes on each reason code (equip carried gold armour, craft carried gold into ingots and a helmet at the carried table, walk to and mine seen ore and pick up its nuggets, walk toward a seen piglin, fight a hostile that comes close, eat), waiting `THINK_MS` (default 5000, a model turn) before each decision. Give both arms of a repeat the same salt: barters then follow the ingots traded. A row records pearls, ingots traded (gold gone, in ingot units), deaths, damage, calls and reason codes, and both per 10 game minutes. A sampler reads the piglins' brain memories once a second (operator reads, never shown to the body): each adult piglin that starts examining an item is one barter, and the `guard` piglin's anger and presence are sampled the same way. A room passes alive with barters seen (40 in `held` and `blocks`, 1 in `mine`); `guard` passes when its piglin is never angered, and reads INVALID unless the body got a mine result and either the guard refused or gold was mined. Unreadable counters or samples make a room INVALID. Pearls are recorded, not judged (none from 40 ingots 42% of the time). It stays at 20 TPS: its model turns are wall time.

```bash
/path/to/recordings/arena-beat-game/slot.sh live node scripts/quality/test-barter-room-live.mjs blocks 7001 /tmp/barter-blocks build/libs/mineagen-VERSION.jar
```

## Forest flee fixture

`test-flee-forest-live.mjs` sends the production `flee_from` from six forest spots of a saved run world, a zombie 4 blocks away on each side (24 flees), and reports net ground speed, sprint share and outcome per flee in `flees.json` and `summary.json`. Set `FLEE_WORLD` to a saved world directory (copied, never modified); the d2b-iron-c world is the default fixture. Each flee starts with an empty seen-terrain memory, as after a respawn (`FLEE_FRESH=0` keeps it); `FLEE_ONLY=5,6` and `FLEE_REPEAT=N` select and repeat flees. No model calls.

```bash
FLEE_WORLD=/path/to/saved/world /path/to/recordings/arena-beat-game/slot.sh live node scripts/quality/test-flee-forest-live.mjs runtime/flee-forest
```

## Single-arm runs

### Route ladder

`ladder.json` defines 23 short route links and alternative branches from empty inventory to the dragon. `run-ladder.mjs` accepts the single-arm options below, defaults to all ladder IDs and one repetition, and adds `--scenarios L-A1,L-A3`, `--scenario-file FILE`, and `--parallel N` (1..8). Parallel runs require `--port-base`: worker 0 owns base/base+1/base+2, worker 1 owns base+10/base+11/base+12, and so on. Every attempt uses the existing launcher, a separate template copy, fresh fixed-seed world, unique artifacts and provider workspace. Port conflicts fail the attempt; unrelated servers stay running. Allow at least 2 GiB heap plus coordinator/model overhead per worker. Paired A/B runs retain the original sequential runner.

```powershell
node scripts/quality/run-ladder.mjs --scenarios L-A1,L-A3 --provider codex --model gpt-6.1-sol --service-tier default --parallel 2 --port-base 28100 --jar BUILD.jar --server-template TEMPLATE --java JDK/bin/java.exe --out runtime/ladder-subset
node scripts/quality/run-ladder.mjs --provider claude --model claude-opus-5-5 --parallel 2 --port-base 28300 --jar BUILD.jar --server-template TEMPLATE --java JDK/bin/java.exe --out runtime/ladder-claude
node scripts/quality/run-ladder.mjs --report runtime/ladder-subset/results.json runtime/ladder-claude/results.json
```

### Linux live ladder

Build with `JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64 ./gradlew build`, then run `npm ci` in `coordinator/`. The single-arm quality runner selects the Node POSIX launcher on Linux and keeps the existing PowerShell launcher on Windows. The POSIX launcher supports fresh natural worlds with one repetition per matrix scenario (the ladder expands `--runs` into independent attempts); it uses the same scenario runner, spawn validation, observer, evaluator and capture closeout. Paired acceptance runs still require the Windows launcher.

Use a clean prepared template at `runtime/server-template`: `fabric-server-launch.jar`, `server.jar`, its `libraries/`, `mods/fabric-api-*.jar`, `mods/fabric-carpet-*.jar`, `eula.txt` and `server.properties`. A template prepared on Windows is reusable on Linux; copy it without saved worlds, symlinks, logs or its old `mineagen-*.jar`. Check its `template-manifest.json` against this checkout's `gradle.properties`. The launcher installs the `--jar` candidate into each isolated copy and binds the offline game and bridge to loopback.

The commands in this guide start with `slot.sh live`. `slot.sh` is a wrapper kept outside this repository on the shared coordinator host: it takes a machine-wide lock and exports `SLOT_PORT_BASE` (28000 plus 100 per slot), the only slot variable the fixtures read. Without it, drop the `slot.sh live` prefix, set `SLOT_PORT_BASE` yourself to the first of three free ports, and run one server at a time. On the shared coordinator host, **every server must hold its own machine-wide slot**. Use one ladder lane per wrapped process; run separate wrapped processes for concurrency. The slot's port variable must expand inside the wrapper:

```bash
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
/path/to/recordings/arena-beat-game/slot.sh live bash -c '
  exec node scripts/quality/run-ladder.mjs \
    --scenarios L-A2 --runs 1 --parallel 1 \
    --provider codex --model gpt-6.1-sol --effort low --service-tier default \
    --port-base "$SLOT_PORT_BASE" --jar build/libs/mineagen-0.3.0-test.1.jar \
    --server-template runtime/server-template --out runtime/ladder-L-A2
'
```

For unattended use on Linux, launch that wrapper in a detached session with stdout/stderr redirected to a file. The Node launcher owns separate process groups for its server, coordinator (including provider children), and runner; closeout drains captures, stops the server and terminates only those owned groups. `--out` and the retained `runtime/headless-runs/` directories provide on-disk progress and evidence.

`results.json` preserves full extracted metrics and failed launches. `ladder-report.md` and `ladder-report.json` give each scenario/provider/model/repetition's pass/fail, goal minutes, deaths, body-busy percentage and tool failures. Beside pass/fail, Progress (evaluator version 3) shows how far the run got on each clause of the check inside the budget: best and final item count net of the starting kit (for example `blaze_rod best 3/7, end 1`; the end reads `unknown` when the final sample's inventory was unreadable), ticks survived, closest distance to a target position, or whether an advancement was reached. Progress is information only and never turns a FAIL into a PASS; results saved before version 3 show `n/a` until `--rescore` recomputes them from their samples. PASS requires authoritative server completion. Measurement status remains separate; unavailable values remain unknown. Failed attempts have no time-to-goal, with observed duration retained in JSON. Body-busy reuses the existing goal-window action interval union, excluding chat. A verified subtask does not certify the method used or an unassisted full run. Read each scenario's notes for supplied resources, random drop risks, alternate branches and predicate limits. Source/fixture identities and raw evidence remain in per-attempt reports beneath the output directory.

Run setup validation with no model calls on its own disposable server:

```powershell
powershell -File scripts/quality/validate-ladder.ps1 -Java JDK/bin/java.exe -ServerTemplate TEMPLATE -Jar BUILD.jar -Out runtime/ladder-fixtures -PortBase 28200
```

The setup-only check verifies locate receipts, dimension, inventory, each armour slot, natural/structure footing after two physics ticks, declared mobs, and the End's natural dragon and ten crystals. It records commands and NBT in `fixture-validation.json`. It reuses one disposable world, so it checks setup, not fresh-world goal completion. `validate-ladder-fixtures.mjs` can also connect to an already owned disposable RCON server with `--rcon-port`, `--password-file`, `--out` and optional `--scenarios`. Do not point it at a shared trial. Setup fields `airBlock` (air variant), `standingOn` (block/tag), `loadChunks` (up to eight dimension/position pairs) and `settleTicks` (1..100) support structure interiors, cross-dimension construction and natural boss initialization. Extra chunk tickets are removed even if setup fails.

For unattended measured runs, `launch-scenarios.ps1 -Runner run-ladder.mjs` supports the same arguments-file and on-disk status/log contract as other quality runners.

```powershell
node scripts/quality/run-scenarios.mjs --scenarios S1,S5 --provider claude --model claude-opus-5-5 --effort low --runs 2 --jar build/libs/mineagen-0.3.0-test.1.jar --out runtime/quality-baseline
node scripts/quality/compare-scenarios.mjs runtime/quality-baseline/results.json runtime/quality-after/results.json
```

Use `--provider codex --model gpt-6.1-sol` for descriptive GPT measurements. The paired acceptance gate is Claude only: Codex currently lacks native per-call rows and cannot establish per-call savings. Defaults are `--runs 8 --scenarios S1,S1-deltas,S5`, with each scenario's own `durationBudgetMs` (240,000 ms for S1 through S6, 1,800,000 ms for S7). An explicit `--budget-ms` or `--play-window-ms` applies to every selected scenario and prints a warning for each scenario whose data budget it replaces. Argument parsing refuses more than 40 scenario/repetition pairs, the exact sign-flip ceiling.

The runner copies the template, starts one owned headless server at a time with `-Xmx2G`, runs the existing coordinator and provider matrix, and keeps that launcher's process-identity cleanup. It never stops unrelated processes or Gradle daemons.

## Scenario data

`scenarios.json` defines seed, dimension, position, surface placement, inventory, worn armour, effects, time, mobs, setup commands, goal, and budget. Commands use `{agent}` for the generated player name. Edit data to add scenarios, without adding scenario branches to the runner. Setup occurs before the real goal starts. Creative mode is used only during fixture construction, followed by survival before measurement. S1, S1-deltas, S3 and S6 freeze world ticks through goal preparation, then the observer unfreezes on the authoritative goal start; preparation and release timestamps are retained. This prevents fixture threats killing an idle player before measurement. No fixture facts or evaluator milestones are added to the model's goal.

| ID | Starting situation | Goal |
|---|---|---|
| S1 | Natural Nether wastes ground at (68.5, 42, 64.5), worn diamond armour, diamond sword/pickaxe, 16 steak | Beat the game |
| S1-deltas | Natural basalt deltas ground at (0.5, 81, 0.5), same gear and food | Beat the game |
| S2 | Dark carved cave at Y=-40, empty inventory | Beat the game |
| S3 | Overworld night, wooden tools, two zombies, skeleton and creeper | Survive the night and get iron gear |
| S4 | Overworld beside a lit portal, iron gear, 10 pearls, 16 bread | Beat the game |
| S5 | Surface logs, persistent stationary husk on a ledge 18 blocks above | Gather 10 logs |
| S5b | Versioned S5 variant: husk at the pad-facing edge of one support block, 8 blocks above; initial view faces it | Gather 10 logs |
| S6 | One-block ledge above a 30-block drop, approaching zombie at night | Survive and reach safe ground |
| S7 v2 | Fresh normal survival, seed `-6693307816407771325`, surface at X134.5/Z488.5, morning, empty inventory | Beat the game by defeating the Ender Dragon |

S1 through S6 generate a fresh normal world from seed `20261009`. Small authored fixtures provide repeatable starts within natural terrain. S1 reproduces a recorded live session's dimension, biome, gear and food. Two persistent piglins are placed on verified natural ground near authored offsets, at least five horizontal blocks from the player, and their entity positions are recorded before the goal starts. This guarantees the intended threat without depending on natural spawn timing. Placement searches the surrounding natural terrain and fails instead of editing it. S1-deltas keeps the original X/Z as a separate hazard start. Both validate biome and footing without terrain edits. Their explicit Y coordinates use `surface:false` because the Nether heightmap selects the roof. Surface fixtures clear a small starting patch so summons are not buried inside terrain. S5 uses a daylight-proof husk so its elevated hostile remains present for the whole budget. World generation repeats; provider choices, tick scheduling and natural mob spawning remain variable.

S7 is an opt-in versioned long-goal scenario with no terrain edits, planted resources or supplied equipment. Its default play window is 30 minutes after authoritative `goal_control start`, with a separate five-minute preparation budget. Death does not end its measurement; the coordinator's normal respawn behavior continues. Setup `respawnAtStart` sets the world spawn at the placed start, so the player starts, respawns (with vanilla spawn-radius scatter) and finds its compass target at one point, as a fresh vanilla player does. Version 1 respawned at the seed's original world spawn, about 232 blocks away. Completion, errors and the play deadline still end the run. Other scenarios keep their existing definitions and clocks unless `--play-window-ms` is supplied. A 60-minute run uses `--play-window-ms 3600000`:

```powershell
node scripts/quality/run-scenarios.mjs --scenarios S7 --provider codex --model gpt-6.1-sol --effort low --service-tier default --runs 1 --play-window-ms 1800000 --out runtime/quality-s7
```

`--seed INTEGER --spawn X,Y,Z` overrides the seed and start coordinates of scenarios whose data sets `runPolicy.overridableStart` (currently S7); other scenarios refuse them. Surface placement resolves Y from the world heightmap; it can land on a canopy. These settings are recorded in the run definition and paired retry configuration. `--service-tier` is recorded in the requested profile and remains subject to provider attestation. Provider defaults are Codex `default` (standard tier; `priority` and `fast` use the 2x-usage Fast tier and must be passed explicitly) and Claude `priority` (normal speed). Paired runs retain the minimum of three repetitions and all capture/accounting checks.

### Long runs: beat the game on a random seed

`run-long.mjs` is the north-star confirmation run. It plays one fresh normal survival world on a random seed (or `--seed`). The player starts at the generated world spawn with an empty inventory, and the only goal is `Beat the game`. The game clock is frozen until the model's first decision, and the player stays in survival throughout setup. Death continues play by vanilla respawn. The run ends at the first of: the server-verified dragon kill attributed to this agent, the `--budget-minutes` window (at most 240), or its spend cap. The kill credit proves who killed the dragon, not that the run was unassisted. This runner's own setup freezes the tick, places the player, clears effects, sets the time and game mode, and unfreezes at goal start. The server's intervention audit (`mineagen audit <agent>`) cannot tell these mutations from help without attributing commands again, so a long run always reports `assisted`. Certified autonomy comes from the headless natural capability runner (`headless-capabilities.mjs`). It creates a fresh world, applies only pre-agent world rules and a temporary spawn ticket, and then starts one goal.

Strict mode is the default for a Claude player. It compiles the exact dragon completion predicate locally, disables auxiliary translation, voice and live judging, and permits only gateway-routed Claude calls. Other goals that need model translation are rejected before launch. The coordinator must use this runner's enforcement build; older or mismatched enforcement files are refused.

Every supported text Messages request reserves its maximum token charge before forwarding. Strict accounting uses the published Opus 5.5 or Sonnet 5.5 list prices from 2026-10-13, including the dearer one-hour cache-write rate. Unsupported models, non-text input, server tools, price modifiers and other API routes are refused. Interrupted responses retain their output allowance. Comparison metrics elsewhere retain their historical proxy rates; the ledger's gate charge is authoritative for this cap.

The run reserves everything the shared ledger leaves, or `--run-reserve-usd` if smaller. `--ledger` persists spend and outstanding reservations across invocations; `--prior-spend-usd` seeds a new ledger once. Abandoned locks fail closed. Adding `--codex-observer-cap yes` opts into estimates that can overspend, including auxiliary calls, and is not strict mode.

Observer-metered Codex play stops when its spend plus its largest call so far reaches the cap (the reserve minus the smaller of $0.50 and 10%), so a model with bigger calls stops earlier under the same cap. Two ways keep a model comparison fair. Size the cap per arm with `--run-reserve-usd`, since each arm is its own invocation. Or pass `--spend-cap-mode log`: the observer records the first crossing (`spendCap.crossed` in `long-run.json` and `quality-run.json`) and play runs to its window, so spend can pass the reservation. The default, `stop`, binds as before, and Claude's gateway always binds. A model with no entry in `coordinator/src/call-cost.mjs` is refused before launch, because its calls would count as free. `long-run.json` names the rule that ended the game in `stop`: `kind` is `window`, `cap`, `stall` (an operator stop for no progress), `goal` or `other`, and `reason` is the raw stop reason.

```powershell
node scripts/quality/run-long.mjs --arms arms.json --arm B --provider claude --model claude-opus-5-5 --effort low --service-tier priority --budget-minutes 180 --max-total-cost-usd 85 --ledger LEDGER.json --port-base 26900 --java JDK/bin/java.exe --server-template TEMPLATE --out runtime/long-run-1
```

For a multi-hour run, start it through the detached launcher so it survives an SSH disconnect. ARGS.json is the same argument list as a JSON array of strings. Status and logs go to `JOB/status.json` and `JOB/worker.log`:

```powershell
powershell -File scripts/quality/launch-scenarios.ps1 -ProjectRoot PROJECT -ArgumentsFile ARGS.json -Runner run-long.mjs -JobDirectory NEW_JOB_DIR
```

`long-run.json` and `long-run.md` hold the seed, the stop reason and the milestone timeline. The chain is wood, planks, crafting table, wooden pickaxe, cobblestone, stone pickaxe, furnace, cooked food, iron ingot, iron pickaxe, iron armour, bucket, diamond, obsidian, flint and steel, Nether, fortress, blaze rod, ender pearl, blaze powder, eye of ender, stronghold, End and dragon. Each milestone records its first time from sampled inventory and dimension, bridge observations or advancements. It also records the model calls, tokens and cost of the segment that led to it and the cumulative totals. Deaths list their time, cause and cumulative cost. Milestone cost estimates come from trace comparison rates; the top-level run/ledger charge uses the strict gateway accounting. Dragon success in strict mode requires server completion of the locally compiled attributed-kill predicate; an advancement or client claim alone is insufficient. Raw artifacts stay in `run/` as for other scenarios.

Long captures journal `quality-protocol.jsonl`, `quality-samples.jsonl`, `quality-usage.jsonl` and `quality-provider-usage.jsonl` during play, before report extraction. JSONL is read and written record by record. Long-run memory retains inventory, lifecycle and usage evidence; detailed scenario quality metrics are not extracted for LONG. Protocol rotation is tracked by file identity, draining the old descriptor before reading its replacement. Runner and observer RCON commands share a per-run lock because Minecraft shares its response buffer across RCON connections. A failed lock is reported as `RCON_LOCK_TIMEOUT`; an incomplete reply records `RCON_INCOMPLETE`, the command, response size and completeness flags. Launcher diagnostics survive into the final report. SIGINT/SIGTERM stop the owned launcher and write the observed partial timeline; after an uncatchable kill, regenerate from the journals.

Rebuild a report without starting a server or settling a ledger:

```bash
node scripts/quality/run-long.mjs --report /path/to/raw/headless-run/scenario --out /path/to/rebuilt-report
```

The raw directory contains `manifest.json`, `report.json` and captures. `long-run-context.json` preserves the window/profile for new runs. Legacy runs can use retained `protocol.jsonl.N` files and complete observations recorded in provider inputs. Missing prefixes and malformed records remain visible as evidence limits; “not observed” does not mean never obtained, and recovered first-seen times can be late. A regeneration with incomplete evidence writes both reports and exits 1. Use a fresh output directory to preserve an original failed report. Omitted `--ledger` defaults to `OUT/spend-ledger.json`; use a unique explicit ledger for independent games. Codex dollar amounts are token-price estimates, not ChatGPT plan invoices.

S5 retains its original definition for comparisons. Its wide elevated slab hides the husk from the pad. S5b is an opt-in fixture (`--scenarios S5b`) for new benchmarks: it clears the whole sight corridor, uses one support block with the husk near its front edge, and starts the camera facing it. It retains the same goal, logs, empty inventory and seed. The target begins beyond melee reach with no stairs or bridge from the pad. It is frozen during preparation and uses a distinct target tag. Default benchmark selection remains S1,S1-deltas,S5; compare S5b only against matching S5b runs.

## Outputs and interpretation

The output folder contains `results.json`, one `S*-r*.json` per attempt, and a short tool timeline per attempt. Raw artifacts live under this checkout's ignored `runtime/headless-runs/`, including server logs, provider turns, coordinator traces, notebook receipts, fixture setup evidence, sampled entity NBT/stat counters, and timestamped protocol rows. Launcher stdout/stderr are under `runtime/quality/<run>/`. Failed infrastructure and unavailable providers remain in results with their classification; budget exhaustion is expected for unfinished long goals and does not invalidate measured play.

JSON summary reports remain bounded to 262,144 UTF-8 bytes. Large call, timeline, sample and other detail collections live in content-addressed `report-artifacts/*.json` files beside each summary. Their `reportArtifact` references contain a relative path, byte count, SHA-256 and array count when applicable. When a summary still exceeds the bound, scalars (numbers, booleans, null and strings up to 256 UTF-8 bytes, such as ids, statuses and terminations) never move while any non-scalar detail is inline: non-structural arrays, longer strings and records without scalars move largest first, but only when the reference is smaller. Only if the scalars alone still exceed the bound do records holding scalars move, first nested ones, then an entry's direct records, then whole collections; each such reference carries `scalarFallback: true`. Reports are UTF-8 end to end, including the PowerShell launcher's read and rewrite. The observer records an unreadable or tampered runner report as an observer error instead of treating it as absent. Keep that directory when copying a report. `readArtifactReport(file)` in `coordinator/src/benchmark/report-artifacts.mjs` restores the original report and verifies every reference; missing or changed artifacts fail the read. Comparison, re-extraction, paired retries and launcher packaging use this reader. Direct JSON consumers must resolve references before treating a referenced field as an array. Scalar totals and legacy metric calculations remain unchanged; in-memory extractor results retain complete details.

`metrics.progressV1` adds PAIR1's progression measures without changing legacy values: first stone pickaxe, iron ingot, iron pickaxe, bucket and successful furnace transaction; confirmed smelted/looted/unknown provenance for the first iron ingot; placed tables/furnaces; stations left by more than eight blocks without a return within four or reclamation before cutoff; literal and broader path-failure-to-movement-control proxies; and sampled travel between successive camps more than sixteen blocks apart. Samples and raw inventory observations supply first-resource times across deaths. Camp travel excludes dimension and death/respawn jumps. Missing observations preserve unknown times or distances. Station and control counts are trace proxies with evidence and definitions, not claims about intent or permanent abandonment.

Goal completion comes from authoritative server `goal_control` operation `complete` or a verified `goal_completion_result`. Coordinator `goal_completed` messages request verification and can be rejected, so they do not end measurement or count as success.

The comparison prints JSON with per-scenario/profile means, deltas, percentages, token categories, and full per-run detail. Each numeric metric also reports n, median, minimum, maximum and range. It includes every attempt and calculates numeric means only from measured runs, preserving missing values as null. Completion comes from authoritative goal completion, with a separate completion rate and completed-goal cost/time. Per-minute rates use measured play time. Missing identities flag a comparison as unverifiable; unequal budgets, scenario definitions or extraction identities reject it. Coordinator and JAR hash changes are shown as arm differences because those are the intended comparison variables.

Metrics join physical action IDs across coordinator traces, protocol commands/results, and notebook receipts. Play and goal-spec/planning tokens use the same comparison price proxy from `coordinator/src/call-cost.mjs`; this is an empirical comparison proxy, not a claim about current API prices. Provider-reported overhead USD remains separate as `overheadReportedCostUsd`. Missing token categories or unknown rates preserve unknown totals as null; measured play categories remain available. Native turn summaries are not counted twice. Wall time includes goal-spec/planning and play, excluding fixture construction; play time is also reported separately.

First-response capture is enabled only for these fixture runs. It records the first Claude text/tool content of a native turn, or the first Codex agent message, in the existing private provider-turn artifact. It does not record thinking content. The first plan snapshot and later first `say` are separate. Dimension and gear matches are lexical hints for manual review, not a semantic quality judge. Tool-only responses and missing plans remain visible in coverage.

The shared first-response capture hooks originate in commit `b725a2a9`, in `coordinator/src/dynamic-main.mjs` and `coordinator/src/claude-service.mjs`; Codex uses its existing `agent_message` source. Port those hooks rather than the whole harness commit. Preflight checks the selected provider. Both paired arms require verified capture; descriptive single runs record `qualityCapture.verified=false` and a reason when hooks are missing, so their first-response evidence may remain unavailable. Enable identical instrumentation in both arm coordinators before committing and repinning their hashes. Historical responses that were never recorded remain unavailable. Existing `say` text is kept separately and is not substituted for an initial response.

The observer captures plans on polling, independently of RCON sampling and player death. `quality-initial-plan.json` preserves the earliest available original goal-spec plan or plan snapshot as bounded text with its source (32 KiB maximum). A goal-spec plan is advisory preparation, not a gameplay model response. Versioned first-response evidence is UTF-8 bounded to 8 KiB and marks late captures as unverified initial responses. Live private response records retain the existing 8,192-character limit.

Server-side samples, roughly once per second, measure positions, health, fall distance, inventory/equipment, vanilla `damage_taken` and `deathCount`, and advancement milestones. Damage uses the vanilla statistic in tenths of health points. Individual health drops record their source as unknown unless the data explicitly supplies one. The last-attacker relation is retained as evidence and can be stale. Death causes come from authoritative goal-control events. Falls count sampled fall-distance crossings above three blocks; brief falls may be missed.

Path length excludes dimension transitions and death-to-respawn jumps. Net displacement is null when start/end dimensions differ. Stuck time counts stationary sampled intervals entirely inside movement actions. Unreachable attacks use a sampled target height delta above three blocks or an explicit no-path result. Missing target samples are reported as missing coverage. Low-health eating requires a finite health value <=8 and joins an eating action, including `use_item` after selection of food; it distinguishes a started attempt from a successful action and retains recovery without eating. Milestones include inventory thresholds, worn iron armour, dimension visits, fortress/bastion discovery and dragon death. Progress already supplied at setup is recorded as reached at the first sample. Inventory milestones also use server bridge observations, preserving terminal progress when goal completion removes the player before the next RCON sample. Malformed JSONL and scoreboard gaps are counted; observer errors mark a run incomplete.

Re-extraction shares the live goal window, audits raw JSONL, and records an extractor fingerprint including pricing dependencies without changing the original live coordinator hash. Rerun extraction against retained artifacts without another provider run:

```powershell
node scripts/quality/reextract-scenarios.mjs runtime/quality-baseline/results.json
```

For paired reports, replace `PAIRED_REPORT` with the input report path and `OUTPUT_DIRECTORY` with an absolute directory outside the repository. This reads the original reports, raw protocol, samples, private provider rows and notebook receipts, then writes only the new output directory. It also re-extracts first attempts and retry history while retaining their attempt identities:

```powershell
node scripts/quality/reextract-scenarios.mjs PAIRED_REPORT --out OUTPUT_DIRECTORY
node scripts/quality/compare-scenarios.mjs OUTPUT_DIRECTORY/results.json
```

Legacy top-level metrics and acceptance gates keep their definitions. Corrected metrics live under `metrics.qualityV2`, and comparisons expose `qualityV2` separately. `quality-v2-summary.json` reports descriptive totals per arm across all attempts with retained evidence; comparison means use only measured attempts. Every run retains evidence arrays and coverage gaps.

Death-counter increments and respawns are reconciled one to one. When a counter proves a death but its exact time is absent, a health rise inside that interval cannot prove healing: the first such recovery becomes a conservative death upper bound, with timing provenance retained. Multiple inferred deaths advance through separate observed recovery windows. Inferred death causes remain unknown.

| Versioned field | Definition |
| --- | --- |
| `failedFightRequestsByCode` | Failed, timed-out or non-stop-cancelled fight/attack requests by result code, without requiring a target sample. |
| `attacksOnUnreachableTargets` | Failed, timed-out or non-stop-cancelled fight/attack requests with explicit path/visibility/approach failure codes, including `APPROACH_BLOCKED`, `TARGET_NOT_VISIBLE`, `NO_SEEN_ROUTE`, or sampled target height above 3 blocks. Unsampled targets remain separately counted as unknown coverage. |
| `lowHealthOutcomes` | HP <=8 opens an episode. HP >8 closes recovery with observed food use (`recoveredByHealing`) or without it (`recoveredWithoutEating`). Death, a death-counter increase or respawn closes `died`; unfinished episodes are `censored`. Observed food use does not prove the cause of health recovery. |
| `repeatedIdenticalFailingRequests` | Excess failed requests with the same tool, full canonical arguments and failure code, within 0.4m in 3D and no intervening movement, death or successful equal request. Position evidence must be at most 2s old. Camera turns do not change the position. |
| `stationarySprintSeconds` | Sum raw-observation streaks of active sprint movement input, lasting at least 3s, within 0.4m horizontally of the initial position, with no observation gap above 2s, dimension change or death. Missing raw positions produce null. |
| `foodUsedBelow6HpBeforeDeath` | Per death, yes/no/null for a food-use request or raw held-food use while HP is strictly below 6, scoped to that life. Selecting food with `use:false` does not count. Successful requests are recorded separately from attempted use; consumption is not inferred. |
| `hazardDeathsByType` | Authoritative cause text grouped as lava, fire, fall, mob, other or unknown. Stale attacker evidence does not establish a mob death. Counter/respawn-inferred deaths retain unknown causes. |

Terminal RCON closure is reconciled against authoritative completion or stop observed after a sampling race. Re-extraction can reclassify legacy untimed `RCON client is closed` errors only when server completion is verified and no malformed JSONL was dropped. Original errors remain in `observerErrors`, and `terminalObserverErrors` records the classification and its evidence. Other read failures remain incomplete.

## Paired benchmark

`--jar` selects the Java build and `--coordinator-root` selects a separate checkout's live coordinator and configuration. The evaluator runner, scenario setup, observer and extraction remain in this harness checkout. Reports fingerprint coordinator sources, model instructions, configuration, package.json, package-lock.json and JAR before and after the run. A changed source or JAR invalidates measurement. The separate instrumentation hash also covers RCON, provider recording, launchers and sourced PowerShell helpers.

Prepare two checkouts, one per arm, each with its own built JAR and installed coordinator dependencies. Both arm coordinators must carry the trace-schema patches; Claude also requires per-call accounting (`d0f2ac08` and `24654d05` on this branch); preflight refuses an arm without them. Plain main lacks interrupted-call rows and partial-message evidence and will be incomplete on death runs. Describe the arms in a JSON file outside tracked sources, for example `runtime/quality/arms.json`:

```json
{
  "A": {
    "commit": "A_CHECKOUT_COMMIT",
    "coordinatorRoot": "../arm-a",
    "jar": "../arm-a/build/libs/mineagen-0.3.0-test.1.jar",
    "expectedJarSha256": "A_JAR_SHA256",
    "expectedCoordinatorSha256": "A_COORDINATOR_SHA256"
  },
  "B": {
    "commit": "B_CHECKOUT_COMMIT",
    "coordinatorRoot": "../arm-b",
    "jar": "../arm-b/build/libs/mineagen-0.3.0-test.1.jar",
    "expectedJarSha256": "B_JAR_SHA256",
    "expectedCoordinatorSha256": "B_COORDINATOR_SHA256"
  }
}
```

Paired runs reject mismatched JAR or coordinator SHA-256 values before launching. Checkouts carrying `.git` also require a clean tree and HEAD matching the supplied commit prefix. Identical arms (the same JAR, coordinator and flags) are refused unless `--allow-identical-arms` asks for an A/A run, which in turn refuses arms that differ. An arm may also carry `jvmArgs` (single-token server JVM flags, passed to the launcher as `ARENA_HEADLESS_SERVER_JVM_ARGS`) and `env` (environment variables for the launcher and coordinator), so two arms can share one build and differ only by flags; the flags are pinned with the hashes. Then run:

```powershell
node scripts/quality/run-scenarios.mjs --arms runtime/quality/arms.json --scenarios S1,S1-deltas,S5 --provider claude --model claude-opus-5-5 --effort low --runs 8 --budget-ms 240000 --harness-commit HARNESS_COMMIT --out runtime/quality-paired
node scripts/quality/compare-scenarios.mjs runtime/quality-paired/results.json > runtime/quality-paired/comparison.json
```

With these defaults the benchmark is S1, S1-deltas and S5, eight pairs each: 24 pairs, 48 fresh-world runs. Odd-numbered repetitions run A/B; even-numbered repetitions run B/A, so each arm runs first 12 times. One server runs at a time. A and B reports and the combined schedule are saved before launch and after every attempt, so an interruption leaves explicit partial evidence. At least three repetitions are required; infrastructure failures make the verdict inconclusive. New benchmarks require a fresh output directory.

There is a fixed 60-second gap after the previous run finishes and before every next arm, including the initial run and retries. Reports record requested and actual gap timing. Provider cache lifetime is unknown, so this gap does not prove equal warmth. First-play-call cache reads and writes record actual warmth; the comparison reports warmth for each pair and counts mismatches without gating or retrying on warmth.

Retry only ineligible or missing pairs with the same arguments and output directory plus `--retry-failed`. Both arms of each selected pair rerun in their original A/B or B/A order. Active reports retain original execution order and arm position, and add retry flags and actual execution order. Superseded runs remain in `history`; `sequence` retains every attempt and each artifact folder uses `attempt-N`. Each arm report also retains `firstAttemptRuns`, so comparisons report first-attempt ineligible runs by termination and measurement status. Any excess B failures count as a conservative quality regression, including after successful retries. Missing original-attempt evidence makes the verdict inconclusive. The retry refuses changes to profile, scenarios, repetitions, budget, harness identity, instrumentation or pinned builds.

### Verdict

Every run stores `modelCallDetails` (preparation and play, input, cache write, output, cache read, duration and proxy USD), category means per call, total tokens/min, calls, cost, death events with causes, verified completion, unreachable attacks and time to first observed progress. Progress means a relevant resource gain above fixture inventory, a new dimension, or an advancement. Starting gear and starting dimension do not count. Null means no progress observed; it does not mean instant progress.

The comparison has one explicit pooled `verdict`. Primary metrics are steady-state charged tokens per play call and per minute, excluding preparation and the first play call. The minute window starts at the end of the first play call. Preparation cost, first-call cache warmth, full-window token rates and cost proxies remain separate secondary results. Calls are checked per category against coordinator thread totals; a discrepancy above 2%, missing accounting evidence or rejected Claude partial messages makes measurement incomplete. Only gameplay calls are checked against the gameplay model profile.

The cost gates use per-pair log(B/A) ratios with 95% Student t intervals, pooling all scenarios with equal weight per pair. The per-call interval upper bound must be below zero, the tokens/min upper bound must be at most +5%, and a one-sided sign-flip permutation check must agree. Per-scenario intervals are descriptive. Healthy termination, attestation and rate-limit checks determine eligibility. Missing, incomplete or nonadjacent pairs yield `INCONCLUSIVE`. Quality guards cover completion, deaths, calls/min and progress; a passing cost gate with a regression yields `COST_PASS_QUALITY_REGRESSION`. The calls/min guard counts a stall only when a noncompleted B run has more than 20% fewer calls and also more than 20% fewer actions/min or loses observed progress, because fewer model calls alone can reflect useful programs or watchers. Quality guards use one-sided exact paired sign tests at p < .05, except the conservative first-attempt excess-B failure guard. No-progress runs are censored at the measured window length, and death causes are summarized per arm. A single smoke run cannot establish the gates. A call still in flight at the stop may be billed while absent from the steady-state numerator; its time remains in the denominator for both arms.

### Unattended launch

`launch-scenarios.ps1` starts the runner as a hidden process that survives the launching SSH session. Save the runner arguments as a JSON array, including an explicit `--java` path because the worker does not inherit the session's environment:

```json
["--arms", "runtime/quality/arms.json", "--scenarios", "S1,S1-deltas,S5", "--provider", "claude", "--model", "claude-opus-5-5", "--effort", "low", "--runs", "8", "--budget-ms", "240000", "--out", "runtime/quality-paired", "--java", "PATH_TO_JDK_25/bin/java.exe", "--harness-commit", "HARNESS_COMMIT"]
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/quality/launch-scenarios.ps1 -ProjectRoot $PWD -ArgumentsFile $PWD/runtime/quality/paired-arguments.json -JobDirectory $PWD/runtime/quality-paired-job
```

Pass absolute paths, as above, because the launcher resolves them outside the PowerShell location. `worker.log` combines stdout/stderr, `status.json` records the final exit code, and `pid.txt` records the worker's PID. New jobs require new directories. The argument file is copied into the job folder before launch. No scheduled tasks or services are installed. Benchmark checkpoints remain under the `--out` directory, and a fresh job directory may point to an existing benchmark output for `--retry-failed`.

## Reflex room gate

The reflex rooms (`scripts/quality/reflex-rooms.json`) are a fast regression check between route checkpoints. `validate-reflex-rooms.mjs` checks their setup only; this section is the one procedure that gates a step on them. The paired room gate is Claude only.

### Danger rows

With `-Dmineagen.watch=true` (the headless matrix and `test-progress-live.mjs` pass it, and so does every practice room that boots its server through `watch-replay.mjs` `boot()` unless `FIXTURE_WATCH=0`; the other room scripts that launch their own server do not yet) the Watcher also writes `arena-watch/<agentId>-danger.jsonl`, created empty when it starts watching the agent, so a watched run with no danger rows reads as a clean capture rather than missing evidence. With the watch off nothing is written and observations are unchanged. Every row has `type`, `schema` (currently 2; schema 2 added the damage-row state fields below, and readers accept 1 and 2), `agentId`, `atMs` (epoch ms) and `gameTime`. Onset and clear rows also carry `rules` (`onset-1`); a change to an onset, close or response rule bumps it, because it moves the gate's denominator. Rows of another schema are counted apart, never mixed in.

In a practice room, `boot()` copies the danger files to `DIR/arena-watch/` when the server stops, so they outlive the world, and `finishRun` folds the `damage` rows that fall between each result row's `startedAt` and `finishedAt` into `row.hits`: `hits`, `taken`, `blocked`, `lethal`, `lethalAmount`, `agents` and the same per attacker in `byAttacker` (the attacking entity type, else the damage type such as `minecraft:lava`). A row's `hitsFrom` (epoch ms) starts the window where play began instead of `startedAt`. The fixture's own `/damage` with no attacker (`minecraft:generic`: how rooms set health, or hurt the body on cue) is damage the room dealt, counted apart in `commandDamage`. A danger file that cannot be read, or a cut line or damage row of another schema in one, leaves `hits` unknown, with `hitsUnknown`. A row with `agentId` counts only that body; a row without one, under a folder where several bodies were watched (parallel lanes on one server), gets no `hits` and says why in `hitsUnknown`, unless it sets `hitsAllBodies: true` (one row that stands for every lane, as the iron-kit room's per-seed row). A room with no danger file gets no `hits` (unknown, not zero). The fold is `scripts/quality/lib/danger-rows.mjs`.

| Row | What it records |
|---|---|
| `damage` | One per hit, including fully shield-blocked hits and the lethal hit (written from the death event, which `AFTER_DAMAGE` never reports). `amount` is the damage dealt, `taken` Fabric's damage after the shield but before armour (null on the lethal hit); the HP a hit cost is `healthDrop` plus `absorbed`. Health and absorption before (from `ALLOW_DAMAGE` in the same server tick) and after; `absorbed` is the absorption HP the hit used and `healthDrop` the health it took. A hit with no same-tick before value has `paired: false` and null drops. Schema 2 adds what the body was doing and how it stood: `action`, `actionId` and `actionIssuer` (the action running when the hit landed; null when none ran), `firingRule` (the reflex firing running, or null), `shieldHand` (`main`, `off` or null) and `blocking` (a shield raised), both read at `ALLOW_DAMAGE` before the hit and null on an unpaired hit, `facingErrorDeg` (horizontal angle from the body's yaw to the hit's direct source, the arrow rather than the archer; a raised shield stops a hit under 90), `attackerDistance` (blocks to the attacker) and `light` (block light at the feet cell). Null is unknown, never "no shield". `scripts/quality/gate-report.mjs` sums each game's hits, blocked hits and HP lost (the measured drop; unknown for an unpaired hit) by shield state and by running action, and leaves a game whose danger capture is corrupt unknown. |
| `onset` | A danger begins: `targeted` (a mob's target is the agent, any distance the scan covers), `aimed` (a shot on course) or `hit` (damage from a source with no open onset). It keeps the scan `kind`, the running `action`, and the first `response` within 200 ticks with `latencyTicks`: `instinct:<rule>` (a firing whose rule covers the danger; one already running is latency 0), `command:model`, `command:program`, `command:unknown` (an older coordinator sent no issuer) or `none`. Only the first command of each step stem under a program counts, so keepGoing legs and later sequence steps of an earlier command are continuations. `truncated` marks an onset that death or a stop resolved before its window ran out. |
| `clear` | The last open onset closed (40 ticks without activity, a death or a stop). `startGameTime` to `endGameTime` is one span of threat time. |
| `firing` | A real reflex firing ended: rule, outcome, detail, server ticks and game time of its start and end. Written every tick, not only during episodes. |
| `reflex_event` | A scheduler event that is not a firing: `held_back`, `disabled`, `expired` (an idle rule) and so on. |

The issuer of each command comes from `provenance.issuer` (`model`, `skill_leg`, `program`, `standing_order`, `guard`), which the coordinator sets explicitly and sends only to a server that echoed `actionIssuer` in `hello_ack`; it is never inferred from the `native-` programId prefix. The coordinator's `native_tool_command_sent` trace row carries the same `issuer` with `eventSequence` and `programId`. `scripts/quality/watch-files.mjs` returns these rows as `danger`.

### Report

```powershell
node scripts/quality/reflex-round-report.mjs --run RUN_DIR [--run RUN_DIR ...] [--out report.json]
node scripts/quality/reflex-round-report.mjs --paired PAIRED_OUT/results.json --margin margin.json [--out report.json]
```

Each run is scored over its room's own window from goal start (`goalStartedAtMs` on the run record, or the protocol journal's goal start for older runs): 300 s, 360 s for `R-FLOOD`, 180 s for `R-TOOLBREAK`. The gate metrics are total damage (the sum of `healthDrop`), deaths (at least the lethal rows; see below) and room success (the evaluator's end-of-window check; `--scenario-file` sets `evaluatorEarlyStop: false` so it is evaluated; a run longer than its room window, such as one under `--play-window-ms`, succeeds only when the evaluator's `passAt` falls inside the window, within the 2 s clock slack, and with no pass time its success is unknown). Damage is reconciled with the vanilla `damage_taken` counter in the run's samples over the whole run up to the final sample, at 0.05 HP per hit and a 2 s clock slack at the final sample; with a lethal hit the counter may only read higher. A mismatch is `invalid`, and a missing counter, a counter sample that is not a non-negative whole number, a Watcher file with a malformed line or counter samples that do not reach both ends of the window are `unknown`; neither is ever a pass or a zero. Onsets, threat time, response paths, latency p50/p95, firings and damage per threat-minute are diagnostics only, because the plan's own fixes shorten threat time. A run with no onset is `no_opportunity`.

Deaths are the larger of the death counter's rise and the goal_control `dead` events inside the window. The counter's rise runs between a sample within 5 s of the window start and one within 5 s of its end, each taken inside the window where one is near. When the only sample near the end is after it, the `dead` events between the end and that sample come off its rise, and a rise left over that the `dead` events inside the window do not account for leaves deaths unknown. The sampler pauses while the player is dead, so a body that died and had not respawned by the end needs no closing sample: its `dead` event covers the end. A counter that goes down or is not a whole number leaves deaths unknown. With no death counter, deaths are the lethal rows, and only when damage reconciles.

Paired runs give per-pair deltas (B minus A) for damage, deaths and success. A pair counts for a metric only when both runs have it; otherwise it is incomplete. Deltas are summed by room and judged against a margin set in advance: margin = z x per-pair SD x sqrt(complete pairs), with z = 2 unless the margin file says otherwise. Beyond the margin a room is `WORSE` or `BETTER`; inside it `INCONCLUSIVE`; a room without a margin is `NO_MARGIN`. Any `WORSE` fails the step. Otherwise the overall result is `INCOMPLETE` while any pair lacks a metric, whatever the complete pairs say; the per-metric verdicts stay as diagnostics. Retries replace a pair's runs, and the rooms score only the replacements, so the judgement also carries the paired runner's first-attempt guard (`firstAttemptFailures`, from each arm's `firstAttemptRuns`, or `history` and `sequence` in older checkpoints): excess B failures among the first attempts fail the step even after successful retries, and missing first-attempt evidence leaves it `INCOMPLETE`, never `PASS`.

### A/A run and noise floor

Run one JAR and one coordinator in both arms, with the watch on in both (the launchers always pass it), before judging any step:

```powershell
node scripts/quality/run-scenarios.mjs --arms runtime/quality/arms-aa.json --allow-identical-arms --scenario-file scripts/quality/reflex-rooms.json --scenarios R-SKELETON,R-BLAZE,R-CREEPER,R-GHAST --runs 8 --provider claude --out runtime/quality-aa
node scripts/quality/reflex-round-report.mjs --paired runtime/quality-aa/results.json --out runtime/quality-aa/reflex-report.json
```

That is 32 counterbalanced pairs, under the cap of 40. The report's `noiseFloor` block (per room and metric, the SD of per-pair deltas and the pair count) is the margin file for later steps: save it and pass it with `--margin`. Record the floor in `docs/goal-progress.md` once measured. Deaths and room success change in whole events, so their margin is at least 1: a room with no deaths in any A/A pair (per-pair SD 0) still reads one extra death as `INCONCLUSIVE` and two as `WORSE`. Damage keeps a margin of at least 1 HP the same way, so a room with no damage in any A/A pair does not read one half-heart hit as `WORSE`.

## Tests

```powershell
cd coordinator
node --test test/quality-*.test.mjs
node --test test/claude-service.test.mjs test/claude-trace.test.mjs test/call-cost.test.mjs
npm test
```

The 135 KB fixture contains selected unmodified records from a real Nether session trace, with a neutral agent ID, and every notebook action delta. It verifies exact call/token/action counts and preserves missing position/health history as null. Synthetic extraction tests cover movement, stuck intervals, damage, falls, low-health eating, unreachable targets, failure codes, plan statuses, matrix setup and comparisons. Setup tests use a mocked RCON transport; S1/S5 verification uses the real Fabric/coordinator/provider entry point. S2/S3/S4/S6 need live verification before claiming comparable quality results.

`coordinator/src/benchmark/live-speed-benchmark.mjs` comes from `claude/opt-bench` at `db73c505`. Launcher/template isolation and append observation follow that branch's runner. The existing headless world/spawn, RCON, matrix and cave-navigation harnesses provide the real server path; no simulated model policy is introduced.

## Generality suite

`run-generality.mjs` in explicit observer mode runs versioned train fixtures with bounded concurrency (1–4), paired or single-arm runs, objective trace markers, and two independent judgments. Judges default to Sol for Claude play and Opus for Codex play, at medium effort, with opposite evidence order. Numeric scores require action timestamps; unexercised recovery and runs without actions stay unscored. Each failed paid judgment retains metering and gets one retry per pass. The total launch budget includes preparation, play, successful judgments and failed attempts; truly unknown spend stops further launches.

```powershell
node scripts/quality/run-generality.mjs --arms arms.json --arm B --scenarios T02,T12,T14 --runs 1 --concurrency 3 --port-base 26900 --out runtime/generality --max-total-cost-usd 5 --codex-observer-cap yes
```

Use `--provider codex --model gpt-6.1-sol` for Codex play. The original stacks may lack native per-call accounting; an `INCOMPLETE` token reconciliation must remain visible even when the objective and thread-total spend are available. Full fixtures retain their 5–10 minute windows. `--smoke-window-ms 60000` explicitly shortens a train-only pipeline check to 30–120 seconds and retains the declared window in its job data; it does not establish a performance baseline.

The Observer activates first-decision hazards using the outer protocol row's `observedAtMs`, then releases world ticks. Setup holds the player safely, disables command feedback before mode changes, removes nearby phantom give drops, and does not alter natural regeneration. Captured setup feedback, fixture text or modified gamerules fail measurement. Survival goals use the fresh end state at the played window's end: alive, no deaths, and the fixture's hazard-clear conditions. Shelter uses a bounded flood-fill with ordinary solid walls/roof, excluding leaves and fluids, and RCON commands that fit the server receive buffer.

Held-out definitions and traces belong in the evaluator-only research folder, never shared notes or public archives. Held-out runs require an explicit private fixture file and `--expect-fixture-sha256`; a different hash fails before launch. On the shared test host, stage private definitions and evidence temporarily, copy them back to the evaluator-only folder, then delete every staged private definition, trace, world and report after each evaluator run. Preserve train-only evidence separately. The setup validator is an unpaid setup check and does not prove the real Observer or provider pipeline.

## Supervised strict cap-and-stop smoke

After live execution is authorized, use the committed driver instead of the plain long-run command. From the project root:

```powershell
node scripts/quality/strict-smoke.mjs --provider claude --model claude-opus-5-5 --effort low --budget-minutes 1 --max-total-cost-usd 3 --ledger runtime/strict-smoke-ledger.json --port-base 26900 --java "C:/Users/player/Desktop/Projects/agents arena/runtime/toolchains/temurin-25/jdk-25.0.3+9/bin/java.exe" --server-template "C:/Users/player/Desktop/Projects/agents arena/runtime/server-template" --out runtime/strict-smoke
```

Output and ledger paths must be fresh. The Windows-only driver uses the real launcher and Anthropic transport. It records every upstream attempt in `gateway-outbound.jsonl` without credentials or prompt bodies and records the local gateway address in `gateway.json`. After server goal-start and a metered gameplay call, it sends the million-character boundary probe, requires local refusal, closes the gate through the production Observer, and requires a following ordinary request to be refused. It injects failures only into the observer's stop command, leaving gameplay and other RCON operations intact, so the production watchdog must escalate.

Immediately before termination, a smoke-only witness suspends members validated against the owned job, retaining the same process handles. It repeats the census until every member is frozen, closes its query-only job handle, and lets the ordinary retained launcher handle perform termination. The witness confirms every captured process has exited. It cannot terminate processes and resumes surviving members on failure. A sentinel started outside the job must survive; the driver then stops that sentinel through its retained handle.

`strict-smoke.json` reports PASS, FAIL, or INCOMPLETE, with each acceptance check and its evidence. Missing goal/gameplay/refusal sequence never passes. Exit codes are 0, 1, and 2 respectively. Admission reserves the one-hour cache-write ceiling; exact settlement and reconciliation distinguish five-minute and one-hour usage. Unknown duration cannot pass reconciliation. A pass confirms this supervised integration only, not multi-hour progression or a dragon win. Live model execution remains prohibited while NO CLAUDE applies.

Round 8 requires a provider-side census before PASS. The gateway journal and coordinator rows cannot prove absence of opaque direct calls. Without an independent provider export, collection reports INCOMPLETE. No provider account export integration or OS egress confinement is assumed. Do not manufacture an audit by copying the gateway journal.

After collection, obtain a complete provider-reported census covering the owned workload's entire interval in `smoke-scope.json`. Use an isolated account/window, or provider-side workload attribution that covers every helper. Include all billing evidence available. Import it as a JSON document with this shape (values below are illustrative, not usable evidence):

```json
{
  "schemaVersion": 1,
  "source": "provider",
  "complete": true,
  "scope": { "runId": "copy-from-smoke-scope", "startedAt": 1, "endedAt": 2 },
  "generatedAt": 3,
  "calls": [{
    "responseId": "provider-message-id",
    "model": "claude-opus-5-5",
    "usage": { "input_tokens": 10, "output_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
    "billedUsd": 0.00204
  }],
  "billingTotalUsd": 0.00204
}
```

`scope` must match the captured run exactly; `generatedAt` must follow the completed interval. Each call needs the provider response identity and raw usage. Cache creation needs both `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` when writes are nonzero. `billedUsd` and `billingTotalUsd` are optional only when that billing evidence is unavailable. Extra calls, mismatched usage/charges, incomplete coverage or a damaged export cannot pass. If the provider cannot supply this coverage, the smoke remains INCOMPLETE and cannot authorize the multi-hour run.

Verify without starting another workload:

```powershell
node scripts/quality/strict-smoke.mjs --verify runtime/strict-smoke/strict-smoke.json --provider-audit runtime/provider-smoke-audit.json
```

This writes `strict-smoke-verified.json` and checks the captured accounting files still match their hashes. A collector running independently can also supply `--provider-audit FILE` to the collection command; the driver reads it only after its workload stops. Server goal identity, native response identity, observation order, both probes inside the one-minute window, raw log integrity, Observer errors, source stability and underlying measured status must all be consistent.
