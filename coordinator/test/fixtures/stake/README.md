# Gameplay decision stake

Run `node scripts/quality/check.mjs` from the repository root for the corpus, or `--incident zombie-hold` for a selected episode. The command prints the same summary as `npm run test:stake` and the Coordinator (Linux) CI job, which runs on drafts too.

This is a change detector with hard coordinator invariants. It uses the actual coordinator, native tool admission and steering, with a scripted planner and in-memory bridge. No provider CLI, Minecraft server or world simulation runs. It shares `HarnessBridge`, `ReplayPlanner`, virtual time and trace collection with the existing decision renderer.

## Evidence and reconstruction

`manifest.json` pins each episode's SHA-256 and records the source protocol row hash, run, file and line. Episodes remain under 200 KB. The first-hour feasibility check tried the gate3-5 lava window (recorded find dispatch `exec-411b7eb5-399a-43c4-a0f5-61cf778dbf3e`): a sampled replay reached an unavailable inspection before an active find. The full historical active state and inspection/action sequence were not restored. That full-window fidelity claim remains an explicit coverage gap.

Following the approved fallback, the four runnable episodes reconstruct admission from actual gate3-1 zombie/skeleton facts and gate3-3 creeper facts. Player/inventory/threat rows are recorded; fresh goal/tool admission and observation metadata are reconstructed. The recent-hit→lava and delayed-result schedules are explicit synthetic variants of those facts, following the existing search-steer tests. Every episode lists its omissions and injected context. Passing them does not certify the original trajectory, lava discovery or physical survival.

## Reading and accepting changes

The summary prints holds/notifications/wakes, tool interruption requests, steers, hand-backs, danger calls, decision diffs and coverage. Interruption requests are not claims that a physical action stopped: danger may intentionally return its running handle.

`expected.json` records the current coordinator's decision trace fields (event, trigger, verdict, reason, action and tool kind, state), each bridge command's event, goal revision and action type, and tool hand-backs. Raw control floats, IDs, timestamps and provenance are left out, so a harmless refactor of aim math is not a decision diff. To accept an intentional change, update only that entry and add one PR line naming the episode, old→new decision and product reason. Reviewers see the expected and actual sequences. A changed expectation cannot disable the hard assertions that creepers/lava steer and a stale result cannot dispatch into a newer goal. Unsupported or incomplete input remains red; a full-window coverage gap is not included in the eligible-case pass count.

## Grow from product failures

Every triaged gameplay failure adds its replayable window and expected behavior in the same PR as its fix. Otherwise add its ID, missing state and reason under `manifest.json`'s `unreplayable` list and link the lane's friction entry in `docs/gameplay-friction/<pr>-<slug>.md`. Four cases is the seed corpus, not its ceiling. Keep source provenance when equivalent windows are deduplicated. Report runtime above one minute rather than silently removing failures.

The default local command and `coordinator/test/decision-stake.test.mjs` use one formatter. When `GITHUB_STEP_SUMMARY` is present, it is appended automatically; otherwise it is printed to stdout. No separate CI job or VM is added.

## PR visibility

The Coordinator (Linux) job, on the coordinator host runner for drafts and ready PRs alike, publishes one marker comment and a `gameplay-stake` commit status. It evaluates the checked-out tree, which is GitHub's merge of the PR into its base, and publishes to the PR head SHA from the event. The comparison base is that merge's first parent. The step cannot stop the tests after it (`continue-on-error`); the `gameplay-stake` status carries its result, and a crash posts an `error` status. Superseded heads cannot update the current comment. The status links to the Actions summary.

Two results are reported separately. **Head passes or fails** sets the status: invariants and expectations on the evaluated tree. **Base comparable** only adds the base → head deltas. A base that cannot be checked out or replayed reads "not comparable" and is neutral: a passing head stays green and a failing head stays red.

`node scripts/quality/check.mjs` prints this same block locally, discovering the PR base where possible. `--base REF` selects one explicitly without PR discovery. Both runtimes use the candidate corpus/harness, but each uses its own production coordinator, danger rule and ledger. This compares decisions rather than just comparing an expected file to itself. Candidate elapsed time is the headline; base checkout/evaluation is additional local/CI work, not a Minecraft run.

The product block is the gate funnel from `docs/gates/gate-N.json` (built by `scripts/quality/gate-report.mjs`): a gate report the PR adds or changes, otherwise the newest on its base, with the commit its runs played. Nothing else supplies product numbers; with no gate report the block says so. Below it, both log replays over the gate 3 logs print base → head, and the comment ends with the time of the whole check. See [the quality README](../../../../scripts/quality/README.md#gate-report-and-product-funnel).
