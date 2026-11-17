# Mineagen

Mineagen lets an AI model play Minecraft Java through a real player body, using Codex or Claude Code as its brain.

## How it works

Each agent is a player on the server. It has collision, gravity, health, hunger and an inventory, and it plays in Survival, Creative or Adventure. The world runs at normal speed and nothing is slowed down for the agent.

The brain is an ordinary model that you already use through the Codex CLI or Claude Code. A local coordinator gives the model Minecraft tools: travel, mine, build, craft, smelt, fight, find things, obtain items and run short programs written in ArenaScript. The mod carries out those actions in the game.

Models take seconds to answer, so a fast layer runs in the game in the meantime. Reflexes react to danger such as lava, fire, drowning, ledges, creepers and arrows without waiting for the model. Scripts the model writes keep the body working between model calls.

## What you need

- Minecraft Java Edition 26.1, 26.1.1, 26.1.2, 26.2 or 26.3.
- Fabric Loader 0.20.1 or newer, Fabric API and Fabric Carpet.
- Java 25 and Node.js 22 or newer. The Windows package includes Node.js.
- The Codex CLI or Claude Code, installed and signed in on the machine that runs the world. Mineagen uses that login.
- Operator permission in the world. In single player, turn on cheats.
- Optional, for voice: the Mineagen Voice add-on, Simple Voice Chat and an OpenAI API key.

## Quick start (Windows package)

Download the files from the [Releases page](https://github.com/aGamingGod1234/mineagen/releases). On Windows, take `mineagen-modpack-<version>.zip`. For a manual setup, take the mod JAR for your Minecraft version, such as `mineagen-<version>+mc26.3.jar`, and `mineagen-voice-<version>+mc26.3.jar` if you want voice. `SHA256SUMS.txt` lists the JAR checksums, and `mineagen-modpack-<version>.zip.sha256` the package checksum.

1. Install Minecraft 26.3 and start it once. Install Java 25 and Fabric Loader for 26.3. Close the launcher.
2. Sign in to a model CLI: run `codex login` or `claude auth login`.
3. Extract `mineagen-modpack-<version>.zip` into a new folder and follow its `README.md`. The installer is `.\scripts\install-distribution.ps1`. It creates a separate `.minecraft-mineagen` game folder and a launcher profile.
4. Start Minecraft with that profile and open a world.
5. Press `G` to open the control center and choose **Create an agent**, or type `/mineagen summon`.
6. Give it a task: `/mineagen start <agent> Build a safe shelter before night`.

To build the package yourself, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Commands

`<agent>` is the agent's name or short id. Press Tab to complete it. Most commands need operator permission.

### Create and manage agents

| Command | What it does |
|---|---|
| `/mineagen summon` | Create a Codex agent with the default model. |
| `/mineagen summon <model> <thinking> [name]` | Create a Codex agent with a chosen model and thinking level. |
| `/mineagen summon claude <model> <thinking> [name]` | Create a Claude Code agent. |
| `/mineagen summon-configured <provider> <model> <thinking> <speed> <game_mode> <name>` | Create an agent with every setting given. |
| `/mineagen list` | List your agents and what each one is doing. |
| `/mineagen status [agent]` | Show the state, current task and queue. |
| `/mineagen respawn <agent>` | Respawn a dead agent. |
| `/mineagen remove <agent>` | Delete an agent and its saved state. |

### Give tasks

| Command | What it does |
|---|---|
| `/mineagen start <agent> <task>` | Start a task now. A new agent waits until you do this. |
| `/mineagen queue <agent> <task>` | Add a task to run after the current one. |
| `/mineagen steer <agent> <instruction>` | Change the current task while it runs. |
| `/mineagen stop <agent>` | Pause the agent. |
| `/mineagen resume <agent>` | Continue after a pause. |
| `/mineagen goal complete <agent>` | Confirm a task that waits for your sign-off. |

### Talk and watch

| Command | What it does |
|---|---|
| `/mineagen dm <agent> <message>` | Message an agent privately. Vanilla `/msg`, `/tell` and `/w` to an agent reach it too. |
| `/mineagen auto <agent>` | Turn the agent's progress messages in chat on or off. |
| `/mineagen audit <agent>` | Show the outside interventions recorded during the current task. |
| `/mineagen spectate <agent>` | See through the agent's eyes. `/mineagen spectate exit` returns you. |
| `/mineagen takeover <agent>` | Control the agent's body yourself. `/mineagen takeover exit` hands it back. |

### Voice

| Command | What it does |
|---|---|
| `/mineagen voice-consent on`, `off` or `status` | Allow the agents to hear your microphone, or stop it. |
| `/mineagen voice profiles` | List the available voices. |
| `/mineagen voice profile <agent> <voice> [tone] [speed] [radius]` | Save an agent's voice. |
| `/mineagen voice say <agent> <text>` | Make an agent say a line in its voice. |

## Features

- **Control center.** Press `G` to create agents, pick provider, model, thinking level, speed and game mode, give tasks, pause, resume, respawn or remove them. It also shows which model CLIs it found on the machine and whether they are signed in.
- **Codex and Claude Code.** Each agent can use a different provider and model. Codex models come from your installed CLI; Claude models come from the coordinator's configured list.
- **Spectate and takeover.** `/mineagen spectate` shows the agent's own first-person view with its hand, hotbar, health and open screens. `/mineagen takeover` pauses the model and gives you its body. When you leave, the model gets a short report of what you did.
- **Live windows.** From the control center you can open a plan window with the agent's task map and a model terminal with its output and tool calls.
- **Voice.** With Mineagen Voice and Simple Voice Chat, agents speak their replies out loud near their body and can hear players who turn on consent. Speech uses OpenAI text-to-speech and transcription with your own OpenAI API key.
- **Skins.** Codex agents wear an OpenAI skin and Claude agents a Claude skin, so you can tell them apart.
- **Several Minecraft versions.** One source tree builds for 26.1.x, 26.2 and 26.3.

## Status and limits

- Mineagen is early (version 0.2.0) and changes often.
- Worlds and installs made with builds named Arena Agents are not carried over. Agents saved in those worlds are not loaded. Install the package from a fresh folder.
- Camera blocks and the Tripod Camera have been removed. Worlds that contain them lose them when they load.
- No agent has beaten the Ender Dragon from a fresh spawn yet. That is the end-to-end test the project works toward. [The goal page](docs/goal-progress.md) has the latest results, and [the architecture notes](docs/architecture.md) show where runs get stuck.
- Learning from past games is a goal. Agents keep facts, chat and task memory, but it has not been shown to make them better from one game to the next.
- Agents run on your own Codex or Claude account, so their model calls use that account's usage.
- Only Windows has a packaged installer. Other systems need a manual setup.
- Agents use your CLI login by default. You can instead save an API key per provider in the control center. A saved key works only in a world you host yourself, and it never leaves your machine. On Windows it is encrypted to your Windows account; elsewhere it is a file only your account can read.
- Spectate and takeover need the Mineagen client mod.

## More

- [DEVELOPMENT.md](DEVELOPMENT.md): building, Minecraft targets, tests, the Windows package and detailed behaviour.
- [docs/architecture.md](docs/architecture.md): how the agent system and body loop work.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to build, test and open a pull request.
- Source: https://github.com/aGamingGod1234/mineagen

## Licence

Mineagen is released under the [MIT License](LICENSE). Third-party material keeps its own terms. Roboto is Apache-2.0 ([NOTICE-FONTS.md](NOTICE-FONTS.md)). Minecraft is a trademark of Mojang. Claude, Codex and their logos belong to their owners, and the MIT License grants no rights to those names or marks. Mods fetched by `scripts/fetch-libs.sh`, including Simple Voice Chat, are not part of this repository and carry their own licences.
