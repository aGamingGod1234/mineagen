# Developing Mineagen

This file covers building, testing and packaging Mineagen, and the detailed behaviour behind the commands in the [README](README.md). Agents working on the code also read [AGENTS.md](AGENTS.md).

## What the project is made of

Mineagen is a Fabric + Carpet mod pack and a local coordinator for Minecraft Java 26.x: 26.1, 26.1.1, 26.1.2, 26.2 and 26.3. 26.3 is the default build and the Windows release. It adds offline fake players controlled through local provider CLIs. Codex and Claude use their existing local CLI logins (Codex CLI and Claude Code). The coordinator supports Codex and Claude.

By default the mod stores no provider API keys. An operator can save one key per provider from the control center. This works only for the host of a single-player or opened-to-LAN world, over the in-memory connection. The client never sends the key anywhere else. The server refuses a key from any other sender before it validates the key or changes the key file. A dedicated server uses the CLI login or the environment variables on its own machine. The mod writes the key to `runtime/provider-keys/<provider>.key` under the installed runtime folder with owner-only permissions. On Windows the file holds one line, `mineagen-provider-key:1:dpapi:<base64>`, the key encrypted to the current Windows user with DPAPI. If encryption fails, or on Linux and macOS, the file holds the bare key. An older bare-key file still loads and is encrypted the next time a key is saved. The mod passes the key to the coordinator as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. An explicit server environment variable of that name overrides the saved key.

Each agent is a real `ServerPlayer` with vanilla collision, gravity, health, hunger, inventory, and Survival/Creative/Adventure capabilities. It also has its own provider, model, thinking setting, planner session, provider-scoped working directory, goal queue, lifecycle, readable model name, and provider-themed client skin.

The coordinator uses the selected provider's control path for every summonable NPC: Codex and Claude both drive the body through the same native Minecraft tools, workspace, AGENTS.md, and minecraft-control skill. The coordinator prepares the in-game instructions and minecraft-control skill in its Minecraft agent workspace. Codex uses app-server threads; Claude receives the same instructions with native Minecraft tools over a local MCP endpoint. The former fixed two-client planner is retired and is not a runtime fallback.

[The architecture](docs/architecture.md) maps the agent system and body loop to their source files, then shows the Overworld, Nether and End run segments and the Nether blockers as of an earlier snapshot. For the latest full-game results and how progress is measured, read [the goal page](docs/goal-progress.md).

## Build and automated verification

In every new clone or worktree, run `node scripts/doctor.mjs` first. It prints one line per setup check (Node, Java 25, `libs/*.jar`, `coordinator/node_modules`, hooks, the server template, `ARENA_PRIVATE_INPUTS`) with the command that fixes each failure; `--fix` copies the JARs and `node_modules` from the main worktree and turns on the hooks. [AGENTS.md](AGENTS.md#set-up-a-checkout) has the details.

Saved run records and decision-eval recordings live in a private archive. Set `ARENA_PRIVATE_INPUTS` to its root to run the complete coordinator suite; paths within it match the repository layout. Without it, `npm test` names and omits only tests with unavailable private inputs. See [private recording setup](scripts/decision-eval/README.md#private-recordings).

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-automated-verification.ps1
```

This source-checkout command expects the project-local Java 25 toolchain under `runtime/toolchains/temurin-25`. It runs the Java/Fabric verification suite and coordinator tests. CI also checks Linux process-group cleanup. The Windows jobs, which check the distribution transaction and a bounded Fabric boot using the exact ZIP mod set, run only when the repository variable `WINDOWS_CI` is `on`. These checks do not call a model provider.

For fast local iteration when the source and dependencies are unchanged, run the incremental route:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-incremental-verification.ps1
```

It keeps Gradle outputs and the build cache. It supplements, and does not replace, the clean no-cache command above or the release/CI checks.

## Before you commit

Turn on the commit hooks once per clone:

```bash
git config core.hooksPath scripts/hooks
```

They scan what you stage, your commit message and emails, and on push the branch names and new commits, for private details with `scripts/check-public-tree.mjs`, the same scan CI runs, and stop the commit or push on a finding. [AGENTS.md](AGENTS.md#private-details-stay-off-the-repository) lists what counts and what to do about a finding.

## Building for another Minecraft 26.x version

One source tree builds a separate mod JAR for each 26.x drop. The default is 26.3. Pass `-Pmc=<target>` to build for another:

| Target | Runs on | Built against | Mod JAR |
|---|---|---|---|
| `26.1` | 26.1, 26.1.1, 26.1.2 | 26.1.2, Fabric API 0.155.3, Carpet 26.1+v260402 | `mineagen-<version>+mc26.1.jar` |
| `26.2` | 26.2 | 26.2, Fabric API 0.161.0, Carpet 26.2+v260616 | `mineagen-<version>+mc26.2.jar` |
| `26.3` (default) | 26.3 | 26.3, Fabric API 0.165.0, Carpet 26.3+v260915 | `mineagen-<version>.jar` |

```bash
./scripts/fetch-libs.sh 26.2
./gradlew -Pmc=26.2 check build verifyMixinTargets
```

`gradle/mc/<target>.properties` overrides `gradle.properties` for every project. Minecraft API differences go through per-target shims under `src/compat/<target>/` (`McCompat`, `McClientCompat`, `McBlocks`, `McEntityTypes`, and the test bases), along with the mixins that only one drop needs. The 26.1 and 26.2 targets keep their dependency lockfiles under `gradle/locks/<target>/`; the default 26.3 target uses the `gradle.lockfile` in each project. `verifyMixinTargets` (Python 3) checks every mixin's target class, method, `@At`, `@Accessor` and `@Invoker` against that drop's real classes. `verifyPovMixins` then applies them under Fabric. CI runs the full check for all three targets and uploads each target's mod JARs. The Windows release defaults to 26.3; source runtime preparation accepts `-Target` and guards against mixing prepared targets.

## Prepare the source-checkout runtime

These scripts are for the repository's legacy two-client test layout. They are not in the release ZIP. `prepare-runtime.ps1` requires the project-local JDK, an existing Fabric API JAR in the normal Minecraft directory, and the exact source world `%APPDATA%\.minecraft\saves\New World (76)`. It copies that world into `runtime/server`; it never starts the source world. Close Minecraft and the official launcher, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepare-runtime.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\install-launcher-profiles.ps1
```

Preparation verifies the copied world before it reuses it. It creates `runtime/server` with `online-mode=true` on `127.0.0.1:25565`, matching the default server launcher. Joining players need an authenticated Minecraft account. Existing offline settings are rejected without conversion; see [runtime/README.md](runtime/README.md) for this development-only layout and migration boundary.

## The Windows release ZIP

Build `mineagen-modpack-<version>.zip` with `.\gradlew.bat packageWindowsDistribution`; the Reliability workflow also publishes it when its Windows jobs are enabled. Extract the complete ZIP and follow its `README.md`, which is packaged from `docs/distribution/README.md`. The shipped command is `.\scripts\install-distribution.ps1`; source-only preparation and launcher-profile scripts are deliberately absent. The installer creates `%APPDATA%\.minecraft-mineagen`, installs the exact Mineagen, Mineagen Voice, Fabric API, Fabric Carpet, and Simple Voice Chat JARs, removes older package-owned JARs, and installs the matching coordinator and Node.js runtime. It preserves unrelated mods and restores the previous package files if an update fails.

### Provider CLI checks

Install and sign in to the provider CLI on the coordinator machine: Codex CLI or Claude Code. The coordinator probes provider availability when agents register. The manual development launcher below separately requires `codex login status` to succeed.

## Releasing

`.github/workflows/release.yml` publishes a GitHub Release in the public repository, `aGamingGod1234/mineagen`. It does nothing in any other repository.

1. Bump `mod_version` in `gradle.properties` and merge the change.
2. Export the tree with `node scripts/export-public.mjs <empty folder>`, check it with `node scripts/check-public-tree.mjs <that folder>`, and publish it to the public repository through a pull request.
3. On the public repository, run the Release workflow by hand on `main` with the tag name, for example `v0.2.1`. This dry run builds every file, writes the checksums and keeps the files as run artifacts for 3 days. It creates no release.
4. Push the tag `v<version>` on the public `main` commit. Tags cannot be moved or deleted, so check the commit first.

The workflow fails unless the tag is `v` followed by `mod_version`. It checks and builds the mod for 26.1, 26.2 and 26.3, then publishes the release with generated notes and these files:

- `mineagen-<version>+mc<target>.jar` for each target. A local 26.3 build is named `mineagen-<version>.jar`; the release adds `+mc26.3`.
- `mineagen-voice-<version>+mc<target>.jar`, the voice add-on for each target.
- `SHA256SUMS.txt`, the checksums of those JARs.

The Windows package is best effort. A separate job builds and verifies `mineagen-modpack-<version>.zip` for 26.3 and attaches it with `mineagen-modpack-<version>.zip.sha256` after the release exists. If that job fails, the release keeps only the JARs. Rerunning the failed jobs builds the same tagged commit again and replaces the files of the existing release, so it only helps with a passing problem such as a network error. A fix in the code needs a new version and tag.

## Run summonable NPC mode from source

For the source-checkout runtime, start the Fabric server and coordinator in separate terminals:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-test-server.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-dynamic-coordinator.ps1
```

`start-test-server.ps1` starts only the prepared server. `start-dynamic-coordinator.ps1` is a manual development entrypoint and requires an authenticated Codex CLI before it starts. The installed Windows release uses the mod's bundled coordinator supervisor instead, so do not start a second coordinator for that profile. Join the configured local server with the Mineagen Fabric profile and use the operator commands listed in the [README](README.md#commands).

## Visual release validation

The release gate (`scripts/verify-distribution-fabric-boot.ps1`) starts a temporary offline Fabric server with the exact five JARs from the Windows ZIP: Mineagen, Mineagen Voice, Fabric API, Fabric Carpet, and Simple Voice Chat. It waits for Minecraft's `Done` marker, runs `mineagen status`, checks for mixin and crash failures, sends `stop`, and requires a clean exit. Live launcher gameplay and provider-latency acceptance remain separate manual checks.

## Body control

The selected model calls native Minecraft tools. The coordinator implements compound operations such as `obtain` and `find`; Java controllers execute movement, combat, crafting and other body actions. Reflexes run before the action executor and can hold the body for immediate responses. The route line suggests a next step without starting it.

ArenaScript provides a validated interpreter for model-authored programs. Its action surface and limits are defined by the coordinator protocol. Read [the control reference](coordinator/config/minecraft-agent/.codex/skills/minecraft-control/references/control-reference.md) for the model-facing contract.

## Detailed behaviour reference

### Summoning and tasks

`/mineagen summon` and the legacy two-argument form use the configured Codex default. The control center asks the Codex CLI for its current model catalog and uses a bounded built-in catalog when discovery is unavailable; Claude models come from the coordinator's configured list. Availability still depends on the installed CLI, its login, and that provider's model access. Player-facing speed choices are `Normal` and `Fast mode`; provider wire values stay internal. `summon-configured` takes the speed as `default`, `priority` or `fast` and the game mode as `survival`, `creative` or `adventure`; its name argument is required and `""` keeps the generated name. A newly summoned NPC remains idle until `/mineagen start`; `stop` freezes its active work, `queue` preserves later goals, and `steer` interrupts the current plan at a higher revision.

### Spectate and takeover

`/mineagen spectate <agent>` switches your view to the agent's first-person camera, one-to-one with what a player in its body would see: its hands, skin, held tools and how it swings, eats, blocks or draws them, plus its hotbar, hearts, food, armor, air, XP, effects, game mode, open container screens and death screen. The only addition is a small label in the top-left corner that names the way out (`F9: leave agent view` by default) and, while spectating, the key held for free look; the pause menu also gets a Leave agent view button. A lost signal or a hit on your own body shows briefly on the action bar. `<agent>` is the tab-completed selector (the agent's username or short id, no spaces), not the display name shown in chat. `/mineagen spectate <agent>` starts the view; `/mineagen spectate <agent> stop` ends that agent's view and `/mineagen spectate exit` ends whichever view is active. Your own body stays where it is, so your surroundings stop rendering while you watch.

`/mineagen takeover <agent>` uses the same grammar and routes your movement, mouse look, jump, sneak, sprint, attack, use, hotbar and inventory clicks to the agent's body while its model is paused; the model resumes from whatever state you leave the agent in and receives a short report of what you did. A takeover ends when you run `/mineagen takeover exit` or `/mineagen takeover <agent> stop`, when your own body loses two hearts, dies, changes dimension or disconnects, or when the agent is removed or enters another dimension (run the command again once you are in the same dimension). Both commands need operator permission and the client mod.

### Voice

Operators can save settings for an ordinary agent's voice commands, speak a line using those settings, or speak a line with one-off settings that are not saved (`say_with`). Voice requires the optional Mineagen Voice add-on and Simple Voice Chat. Automatic selection uses the voice worker's assigned agent profile; named voice IDs and saved settings remain compatible.

```text
/mineagen voice profiles
/mineagen voice profile Claude voice.adrian.v1 dramatic 1.05 64
/mineagen voice say Claude You should not have come here.
/mineagen voice say_with Claude voice.selene.v1 warm 1.0 48 Hello there.
```

Tones are `neutral`, `warm`, `excited`, `serious`, `dramatic`, `whisper`, `robotic` and `angry`. Speed runs from 0.5 to 2.0 and radius from 1 to 128 blocks.

The shipped coordinator configuration selects OpenAI speech: `gpt-4o-mini-tts` reads the selected agent's exact reply, and `gpt-transcribe` turns consented microphone audio into text for that same agent. Speech models do not decide gameplay or generate replies. Add `OPENAI_API_KEY` in Windows **Environment Variables for your account**, then restart the launcher and Minecraft. The key is read on the host, never embedded in the JAR, and is withheld from gameplay provider processes so Codex keeps its existing sign-in. In `mineagen-runtime/runtime/dynamic-agents.json`, set `voice.provider` to `openai`; `openaiTtsModel`, `openaiSttModel`, and `openaiApiKeyEnvironmentVariable` select the speech models and key variable. A line that OpenAI speech has not finished within 13 seconds is sent as text instead; `interactiveTtsTimeoutMs` changes that cutoff in milliseconds. Existing external configuration is preserved during mod updates, so older installs need this provider setting once; a configuration without `voice.provider` uses `legacy`. Saved voice profile IDs map consistently to OpenAI's built-in voices. Use `legacy` explicitly to retain the previous Fish, Deepgram, or local speech routing.

Spatial voice is optional to use. The Windows release ZIP includes the Mineagen Voice add-on and Simple Voice Chat. In a separate main-mod installation without them, `/mineagen voice-consent` reports `VOICE_UNAVAILABLE` and leaves consent unchanged. With the add-on and its compatible Simple Voice Chat dependency active, the command changes the player's transcription consent state. Text control and ArenaScript do not require voice.

### Skins

Only `brand_openai` and `brand_claude` skins ship; see [the artwork reference](docs/agent-logo-skins.md). Brand agent textures are authored at 512x512 while retaining the vanilla 64x64 UV layout. That gives each visible 8x8 head face a 64px logo raster, while ordinary player and mob textures remain at their native resolutions. These are mod assets, not files for the vanilla skin-upload screen.

### Control center

Press the configured Open control center key (`G` by default) in a world to open the control center. Agent creation, one-at-a-time configuration, individual tasks, lifecycle controls, and settings use the `Agents` workspace. Direct messages use `/mineagen dm <agent> <message>`, and Minecraft's native `/msg`, `/tell`, and `/w` reach agents too; the mod routes messages addressed to online agents into their private conversation memory and mirrors them to operators. The control center renders its own flat controls, text fields, confirmation surface, selection rows, no-shadow labels, and mod-local Roboto typography instead of exposing Minecraft's default button grid or pixel type. Full-row selection, explicit `SELECTED` labels, keyboard focus outlines, scroll-safe 320x240 layouts, and plain status copy keep the current target unmistakable.
