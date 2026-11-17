# Portal kit decision replay

`coordinator/test/fixtures/decision-eval/extra/portal-kit-continuity.json`, kept in the private archive under `ARENA_PRIVATE_INPUTS`, freezes 123 distinct recorded moments: 29 bucket requests, the next three `do_step` choices in each game (87), six low-health controls, and one hunger control. Gate 5 supplies 14 requests: 11 recorded one-bucket choices and three two-bucket controls. Gate 3/4 supply the other 15 requests. No observation is edited.

The request is the last bucket request before the first bucket appears in the recorded inventory, rather than an earlier failed attempt. Subsequent points are the next three recorded steps after that first inventory sample. Each source names the decision, recorded call, raw protocol line and canonical observation hash. Plans come from `quality-initial-plan.json` and preceding authored replacements; dropped steps are removed according to the recorded coordinator events. The immutable compiled goal comes from the recorded `goal_control start`.

These are fresh reconstructed decisions, not full conversation replays. Prior conversation, task memory and earlier tool-result inputs are omitted. The observation can still describe a body action that was finishing when the recorded call arrived. Production re-renders the supported state and route; it does not execute the returned actions. This cannot measure kit completion, time saved, physical survival, or Nether entry. The runner disables default reflexes for historical replay; this also differs from the gate 5 games. The preserved danger facts still reach the model.

Run from the root of each build, with the same frozen corpus file on both sides:

```sh
node scripts/decision-eval/run.mjs --cases "$ARENA_PRIVATE_INPUTS/coordinator/test/fixtures/decision-eval/extra/portal-kit-continuity.json" --provider codex --model gpt-6.1-sol --effort low --samples 3 --concurrency 12 --out runtime/portal-kit.json
node scripts/decision-eval/score-portal-kit.mjs --out runtime/portal-kit-scores.json runtime/portal-kit.json
```

The provider uses the production Codex app-server adapter and the existing ChatGPT login. No API key, judge, probe replies or Minecraft server are required. Run main before changing instructions in that checkout: the adapter prepares the Minecraft workspace as it creates samples.

Scoring is deliberately strict: the first accepted call must ask `obtain bucket` for enough total empty buckets to complete two containers, or (after the first bucket) `obtain flint_and_steel`. A read, a rejected call, an error and a survival detour earn no kit credit. Survival controls separately count food, rest, movement or combat decisions and require a human review of the actual safety and coordinates. Points already holding two bucket forms and flint and steel are reported separately as `already-ready`; that label only excludes them from the bucket/light metric and does not assert a usable pickaxe or portal readiness. `first-after` includes only the first subsequent step with an incomplete kit. The scorer refuses duplicate, missing or unplanned samples, fewer than three repeats, a different model profile, and probe replies. Each case's three samples and majority result remain visible. This is a targeted lane metric, not the broad decision-eval regression verdict.
