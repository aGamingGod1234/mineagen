# Isolated runtime layout

Everything generated beneath `runtime/` is local evidence or executable state and is ignored by Git except this file.

This layout belongs to a source checkout. The Windows release ZIP uses its own
`install-distribution.ps1` flow and does not ship the preparation scripts below.

## Directories

- `server-template/`: reproducible runnable Fabric server generated from the tracked `server-template/` skeleton by `scripts/prepare-headless-server-template.ps1`; binaries, EULA state, and generated libraries stay ignored.
- `headless-runs/`: isolated per-run server copies, bounded reports, and optionally retained private diagnostics from the real-provider matrix.
- `server/`: legacy interactive Fabric server state, prepared with authenticated `online-mode=true` and a loopback listener at `127.0.0.1:25565`.
- `server-offline-smoke/`: optional, clearly labeled offline smoke server; never authenticated evidence.
- `downloads/`: cached SHA-256-verified Fabric installer and Fabric API downloads used by the materializer.
- `evidence/`: world-copy, build, log, screenshot, and live-test summaries with credentials excluded.
- `bridge-secret.txt`: generated local bridge secret shared by the summonable-NPC server and dynamic coordinator; ignored by Git.
- `toolchains/temurin-25/jdk-25.0.3+9`: project-local Java runtime.

The legacy preparation script creates isolated client directories at `%APPDATA%\.minecraft-agent-55` and `%APPDATA%\.minecraft-agent-56`. Those names identify a development layout, not the currently selected agent model. `scripts/install-launcher-profiles.ps1` installs the corresponding profiles.

## Prepare the copied world

`prepare-runtime.ps1` accepts only `%APPDATA%\.minecraft\saves\New World (76)` as its source world. It requires the project-local Java 25 runtime and an existing Fabric API JAR, and copies the world into `runtime/server`. Versions come from `gradle.properties`, with optional target overrides. Preparation rejects a runtime prepared for a different target.

Preparation and the default `start-test-server.ps1` command require `online-mode=true`. Joining players need an authenticated Minecraft account. Existing offline state is rejected without conversion; authenticated and offline player UUIDs differ. Preparation does not migrate player data.

Offline smoke uses the separately prepared `runtime/server-offline-smoke` directory with `online-mode=false` and a loopback listener, launched using `start-test-server.ps1 -OfflineSmoke`. That switch does not prepare the directory. Its results are not authenticated-player evidence.

## Summonable NPC mode

The summonable NPC architecture runs inside the server rather than consuming a licensed account per agent. Use either isolated Fabric client installation to join the server, then start:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-test-server.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-dynamic-coordinator.ps1
```

Both scripts use `runtime\bridge-secret.txt`. `start-test-server.ps1` starts only the prepared Fabric server. `start-dynamic-coordinator.ps1` starts the manual development coordinator and requires the Codex CLI to be authenticated. The packaged launcher profile uses the bundled coordinator supervisor and must not run this second coordinator. Keep the secret file local and never attach it to evidence.

The Fabric mod must be present on both the server and joining client to provide the agent controls and client rendering. All summoned NPCs share one authenticated server bridge. Each provider uses a stable per-agent directory under `runtime/agent-workspaces`. Codex keeps separate threads, and Claude keeps one Claude Code process per NPC in the shared Minecraft agent workspace. Removed providers are rejected rather than started. Provider credentials remain in their normal CLI locations.

## Evidence classes

Keep these categories distinct in `runtime/evidence/live-test-summary.json`:

1. Automated Java/Node/fake-bridge verification.
2. Sequential single-client authenticated testing for each model profile.
3. Offline two-client smoke, if used.
4. Simultaneous authenticated two-player testing, which requires two licensed accounts and distinct UUIDs.

If only one account is available, record `BLOCKED_SECOND_LICENSED_ACCOUNT` for category 4 without weakening online mode.
