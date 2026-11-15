# Working on Arena Agents

This file is for agents working on the codebase. The in-game agent's own instructions live in `coordinator/config/minecraft-agent/AGENTS.md`.

## Debugging gameplay

After the final edit, await checks and read their exit status before committing or marking a PR ready. Stop command sequences on the first failed check.

- Start with the [Edit loop](scripts/quality/README.md#edit-loop); use its selected incident, not the full matrix, while editing.
- Obtain counts from the scorer's unique terminal receipts and execution evidence. Raw text search locates evidence only.
- A missing/corrupt sidecar or damage counter is unknown evidence, not a safe pass.
- Use the production coordinator acceptance path for interruption behavior; body-only fixtures diagnose mechanics.
- Run the broader product gate when the candidate is ready; preserve its seed, caller and artifact identities.
- End every gameplay brief with a friction entry in your PR's own file under [docs/gameplay-friction/](docs/gameplay-friction/README.md) (see Gameplay friction log below).
- The orchestrating thread reads and ranks those entries at lane end; no manual collection is needed.

## Technical catalogue in every pull request

We are building a catalogue of the hard technical problems in this project and how they were solved, for a YouTube deep-dive into how it works. Every pull request description includes benchmarks and numbers for its changes where they exist. When a pull request solves a genuinely hard problem, add a `## Technical catalogue` section with one entry per problem:

- **Problem:** what went wrong, in plain words a viewer would follow.
- **Solution:** what we built, in one or two sentences.
- **Result:** before and after numbers (tokens, cost, time, latency, success rate, damage, and so on). Say whether each number was measured or estimated, and roughly how.

Keep entries short and video-ready, without code-level detail. Skip routine fixes and anything without a real result to report.

Also write the entries to a new file, `docs/technical-catalogue/<pr>-<slug>.md` (`<pr>` is the pull request number, `<slug>` a few words of its title), under a `#` heading naming the pull request. Use one file per pull request and never edit another pull request's file, so two branches never conflict there. `docs/technical-catalogue.md` keeps the entries written before this rule; do not add to it.

## Minecraft 26.x targets

The mod builds for 26.1.x, 26.2 and 26.3 from one tree (`-Pmc=<target>`; the default is 26.3; see the README). A Minecraft API that differs between drops goes through the per-target shims in `src/compat/<target>/` (`McCompat`, `McClientCompat`, `McBlocks`, `McEntityTypes`, `TestCompat` and the test bases). Add the same method to every target, never call the moved API directly from shared code. A mixin whose target differs goes in each target's compat mixin config. Before pushing a change that touches Minecraft APIs or mixins, compile all three targets and run `verifyMixinTargets` for each.

## Gameplay friction log

A gameplay brief ends with a friction entry in a new file, `docs/gameplay-friction/<pr>-<slug>.md`, one file per pull request, in the three-line format in `docs/gameplay-friction/README.md`. Never edit another pull request's file.

## Harness scripts

Harness edits go through a PR, then a deploy: see `ops/arena-beat-game/AGENTS.md`.
