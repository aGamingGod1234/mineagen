# Working on Mineagen

This file is for agents working on the codebase. The in-game agent's own instructions live in `coordinator/config/minecraft-agent/AGENTS.md`.

## Private details stay off the repository

This repository is public. Every push is public at once, and deleting a line later does not take it back.

Never put any of these in a file, a commit message, a branch name, or a pull request title, description or comment:

- home-folder paths;
- account or user names;
- hostnames, machine names and IP addresses;
- email addresses;
- usage or billing figures from your accounts, such as remaining limits or bills (benchmark results, such as tokens per task, are fine);
- game recordings and run records;
- keys, tokens and other credentials.

Refer to a file by its path in the repository, such as `coordinator/src/dynamic-main.mjs`. Refer to a machine by what it does, such as "the test machine" or "a Windows PC", never by its name.

Personal tests, runs and recordings live outside the checkout, in the folder named by `ARENA_PRIVATE_INPUTS`. Never add them to the repository.

Commit with your GitHub no-reply address, the `users.noreply.github.com` one shown in your GitHub email settings: `git config user.email <that address>`.

Turn on the commit hooks once per clone:

```bash
git config core.hooksPath scripts/hooks
```

`scripts/hooks/pre-commit` scans what you stage and `scripts/hooks/commit-msg` scans the message. Both run the publication gate, `scripts/check-public-tree.mjs`. CI runs the same gate on the whole tree and on the pull request title, description, branch name and every commit message; any finding fails `Coordinator (Linux)`.

When the gate flags a line:

- A private detail: remove it. For a commit message, reword it with `git commit --amend` before you push. If it was already pushed, removing it does not unpublish it: tell the owner.
- A false positive in a file: add an exemption to `scripts/public-tree-exemptions.json` with the file, the rule, the SHA-256 of the line's text (without its line ending) and a reason. The exemption matches only that exact line.
- A false positive in a commit message or pull request text: reword it. Text has no exemptions.
- A `REVIEW` finding fails like a `FAIL`. Reword the line, or exempt it in a file when the word is ordinary software terminology.

## Where things live

- Mod: `src/main/java/dev/agaminggod/mineagen/`; client UI: `src/client/java/dev/agaminggod/mineagen/`.
- Coordinator: `coordinator/src/dynamic-main.mjs` starts the Node runtime.
- Bridge: `src/main/java/dev/agaminggod/mineagen/server/bridge/MultiplexedServerBridge.java` and `coordinator/src/protocol-v2.mjs`.
- In-game agent instructions: `coordinator/config/minecraft-agent/AGENTS.md` and its `.codex/skills/minecraft-control/` directory.
- Tests: `src/test/java/`, target-specific `src/compat/`, and `coordinator/test/`.
- Scripts: `scripts/`; gameplay edit loop: `scripts/quality/README.md#edit-loop`.

## Debugging gameplay

After the final edit, await checks and read their exit status before committing or marking a PR ready. Stop command sequences on the first failed check.

- Start with the [Edit loop](scripts/quality/README.md#edit-loop); use its selected incident, not the full matrix, while editing.
- Obtain counts from the scorer's unique terminal receipts and execution evidence. Raw text search locates evidence only.
- A missing/corrupt sidecar or damage counter is unknown evidence, not a safe pass.
- Use the production coordinator acceptance path for interruption behavior; body-only fixtures diagnose mechanics.
- Run the broader product gate when the candidate is ready; preserve its seed, caller and artifact identities.
- End every gameplay brief with a friction entry in the private archive, using the [friction format](docs/gameplay-friction/README.md) (see Gameplay friction log below).

## Technical catalogue in every pull request

We are building a catalogue of the hard technical problems in this project and how they were solved, for a YouTube deep-dive into how it works. Every pull request description includes benchmarks and numbers for its changes where they exist. When a pull request solves a genuinely hard problem, add a `## Technical catalogue` section with one entry per problem:

- **Problem:** what went wrong, in plain words a viewer would follow.
- **Solution:** what we built, in one or two sentences.
- **Result:** before and after numbers (tokens, cost, time, latency, success rate, damage, and so on). Say whether each number was measured or estimated, and roughly how.

Keep entries short and video-ready, without code-level detail. Skip routine fixes and anything without a real result to report.

Also write the entries to a new file, `docs/technical-catalogue/<pr>-<slug>.md` (`<pr>` is the pull request number, `<slug>` a few words of its title), under a `#` heading naming the pull request. Use one file per pull request and never edit another pull request's file, so two branches never conflict there.

## Minecraft 26.x targets

The mod builds for 26.1.x, 26.2 and 26.3 from one tree (`-Pmc=<target>`; the default is 26.3; see DEVELOPMENT.md). A Minecraft API that differs between drops goes through the per-target shims in `src/compat/<target>/` (`McCompat`, `McClientCompat`, `McBlocks`, `McEntityTypes`, `TestCompat` and the test bases). Add the same method to every target, never call the moved API directly from shared code. A mixin whose target differs goes in each target's compat mixin config. Before pushing a change that touches Minecraft APIs or mixins, compile all three targets and run `verifyMixinTargets` for each.

## Gameplay friction log

Store per-run evidence at `$ARENA_PRIVATE_INPUTS/docs/verification/<pr>-<slug>/` and friction entries at `$ARENA_PRIVATE_INPUTS/docs/gameplay-friction/<pr>-<slug>.md`, one file per pull request, using the format in `docs/gameplay-friction/README.md`. Set `ARENA_PRIVATE_INPUTS` to the private archive root before gameplay work. Report the results with their numbers in the pull request, but never link or quote archive paths there. Keep run records and recordings in that archive. Keep reusable authored fixtures in the repository. Never edit another pull request's archive entry.
