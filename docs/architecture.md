# Architecture: how the agent plays

Mineagen connects an ordinary model to a real Minecraft player body. The model chooses work; the coordinator supplies tools, memory and route suggestions; Java controllers and reflexes operate the body while the world continues ticking.

The Ender Dragon kill from a fresh spawn is the end-to-end test. It has not been achieved in a fresh game yet. A prepared-save result does not establish a fresh-game win. Historical run records and recordings live outside this tree under `ARENA_PRIVATE_INPUTS`; the current implementation is mapped below, followed by the dated run results.

## System

```mermaid
flowchart LR
  P["Provider CLI"] <--> C["Coordinator: dynamic-main.mjs<br/>AgentPlanner and turn scheduler"]
  W["Instructions and minecraft-control skill"] --> P
  M["Facts, conversation and task memory"] --> C
  R["Route suggestion: routeLine"] --> C
  C <--> T["Native tool runtime<br/>compound helpers and ArenaScript programs"]
  T <-->|"TCP JSON lines, loopback, HMAC"| B["MultiplexedServerBridge"]
  B --> E["ServerActionExecutor and controllers"]
  X["ReflexEngine"] -->|"can pause actions"| E
  E --> BODY["ServerPlayer body"]
  BODY --> O["ServerObservationCollector"]
  O --> B
  B -->|"observations and action receipts"| C
```

Paths below are relative to the repository root. Java paths beginning with `server/` are relative to `src/main/java/dev/agaminggod/mineagen/`.

| Part | Source and responsibility |
|---|---|
| Runtime and scheduling | `coordinator/src/dynamic-main.mjs`, `agent-planner.mjs` and `planning-scheduler.mjs` create and schedule provider work. |
| Provider transport | `coordinator/src/codex-app-server.mjs` launches `codex app-server --stdio`; `claude-service.mjs` builds the `claude --print` stream-json command; `claude-tool-server.mjs` serves its native tools over loopback MCP HTTP. `provider-registry.mjs` lists the shipped adapters. |
| Instructions | `coordinator/src/minecraft-agent-workspace.mjs` prepares the templates under `coordinator/config/minecraft-agent/`, including `AGENTS.md` and `.codex/skills/minecraft-control/`. These are the in-game model's instructions. |
| Tool admission | `coordinator/src/native-minecraft-tools.mjs` defines `MINECRAFT_DYNAMIC_TOOLS` and `STEP_VERBS`. `native-tool-runtime.mjs` handles calls and dispatches body work. |
| Compound operations | `coordinator/src/obtain-runner.mjs` exports `runObtain`; `obtain-plan.mjs` plans resource work. `find-search.mjs` exports `searchFor`, which can invoke `followEyes` in `find-eyes.mjs` or `findPortalRoom` in `find-portal-room.mjs`. |
| Bridge | `server/bridge/MultiplexedServerBridge.java` and `coordinator/src/protocol-v2.mjs` implement the authenticated JSON-line connection. The server's default listener is `127.0.0.1:25570`. |
| Body | `server/CodexAgentManager.java` manages agents. `server/runtime/ServerActionExecutor.java` dispatches actions to controllers under `server/runtime/controller/`. The wire enum is `src/main/java/dev/agaminggod/mineagen/protocol/ActionType.java`. |
| Perception | `server/perception/ServerObservationCollector.java` collects player state, inventory and world observations. Its entity/block caps are 64 and 128; these are collection limits, not promises that every sample contains that many rows. |
| Reflexes | `coordinator/src/reflexes.mjs` defines the default rules and their wire representation. `server/runtime/reflex/ReflexEngine.java` executes them. |
| Danger notifications | `coordinator/src/danger-steer-coalescer.mjs` coalesces repeated danger steers, with a default interval of 2,000 ms. Materially new danger can be delivered immediately. |
| Memory | `coordinator/src/fact-ledger.mjs` retains bounded facts; `conversation-memory.mjs` retains chat; `context-carry-over.mjs` carries tool digests into a replacement session. `task-memory-store.mjs` persists task evidence scoped by world, dimension and agent. This is memory infrastructure, not proof of learning across games. |

In the coordinator rows, subsequent bare filenames share the `coordinator/src/` prefix. In the Java rows, `server/` is the package directory below the Java root above.

## A body action through the server

```mermaid
sequenceDiagram
  participant L as Selected model
  participant C as Coordinator tool runtime
  participant B as Server bridge
  participant R as Reflex engine
  participant E as Action executor
  participant W as Player body
  L->>C: Native tool call
  C->>B: action_command, action ID and goal revision
  loop Server ticks while work runs
    B->>R: Tick reflexes before action execution
    R-->>B: Agents paused by firing rules
    B->>E: Tick actions, respecting holds and pauses
    E->>W: Body inputs and interactions
  end
  E-->>B: Action progress or terminal result
  B-->>C: Receipt and observations
  C-->>L: Tool result or later event
```

`MultiplexedServerBridge.executeAcceptedInput` flushes staged acceptances, ticks reflexes, then ticks the executor. If the acceptance journal is not durable, the affected agents are held. `ServerActionExecutor.tick` skips reflex-paused actions and accounts for their paused time. Observations and results are published through the bridge; a tool's admission alone does not prove its physical effect.

The model can start body work through native actions or model-authored programs. The coordinator's `arena-script/` modules validate and interpret programs; the Java executor remains the physical action boundary. A compound call such as `obtain` can issue several body actions. The route suggestion itself issues none.

## Route suggestions and game progression

`routeLine` in `coordinator/src/skill-fits.mjs` reads current inventory, dimension and known plan facts. Its Overworld route suggests food, tools, a furnace, iron equipment and portal preparation. It handles carried obsidian separately from bucket casting. In the Nether it suggests rods, pearls and returning through the portal. After returning, it suggests eyes, a stronghold, the portal room and filling frames; in the End it suggests crystals and the dragon.

These are suggestions that the model may take or ignore. The actual helpers and controllers can stop for danger, missing resources, blocked routes or exhausted budgets. Their existence does not certify that the sequence succeeds in one fresh game.

For the model-facing tool contract, read [the control reference](../coordinator/config/minecraft-agent/.codex/skills/minecraft-control/references/control-reference.md). For the edit and acceptance path, read [the quality guide](../scripts/quality/README.md#edit-loop). Historical measured results retained for video material are in `docs/technical-catalogue.md` and `docs/technical-catalogue/` in the working repository.

## Where a run from spawn stands (results up to 15 Nov 2026)

The following results, observations, blockers and lane assignments are the 15 Nov snapshot. They describe those games and investigations, not a new measurement of today's build. Source filenames remain current; unconfirmed source line numbers have been removed.

### How to read the status tags

Each step in the three segment diagrams carries the best result so far and where it came from.

| Tag | Meaning |
|---|---|
| **fresh** | Reached in games played from spawn (rounds 4, 5 and 6, 14 to 15 Nov) |
| **real save** | Reached in a test that started from a save point taken out of a fresh game |
| **staged** | Reached only from a hand-prepared start with injected gear. Never counts as progress |
| **never** | Not reached by any game or test |

Colours: green = works from spawn, yellow = partly, red = the current walls, grey = seen only from staged starts.


### 1. One decision turn

```mermaid
sequenceDiagram
  autonumber
  participant W as Body in the world
  participant S as Mod, server tick
  participant K as Coordinator
  participant L as Model, gpt-6.1-sol low

  W->>S: world state
  S->>K: observation at end of tick
  K->>K: wake filter decides whether this wakes the model
  K->>L: wake input: now header, route suggestion, facts, last result
  L->>K: tool call, for example do_step obtain iron_pickaxe
  K->>S: action_command with action id and goal revision
  loop every server tick
    S->>S: reflexes tick first
    S->>W: executor ticks the action, unless a reflex paused it
  end
  S->>K: action_result with facts
  K->>L: tool result
  L->>K: next tool call, or the turn ends

  Note over S,K: Danger such as damage, lava or a close threat sends an urgent sample
  K-->>L: turn/steer, first at once, later ones folded every 2 s
  L-->>K: replaceAction: cancel the old command, then send the new one
```

Rules that hold the loop together:

- **One turn, one physical action.** Each agent has at most one model turn and one world action in flight.
- **Stale work is rejected.** Every command carries the goal revision and an action id; both sides refuse an old revision (`dynamic-main.mjs`, `protocol-v2.mjs`).
- **Danger steers, it does not act.** The coordinator tells the model about danger; the model chooses (`danger-steer-coalescer.mjs`, `danger-glance.mjs`).
- **Reflexes do act.** They are the only part of the body that moves without the model asking.

#### What happens inside one server tick

```mermaid
flowchart TD
  T0["Start of tick"] --> A["Accept new action commands<br/>and cancels from the bridge"]
  A --> R["Reflexes tick first<br/>ReflexEngine"]
  R --> Q{"Does a reflex rule<br/>fire for this agent?"}
  Q -- "yes" --> PA["The agent's action is paused:<br/>not ticked, timeout clock stopped"]
  PA --> RA["The reflex moves the body:<br/>retreat, take cover, eat, leave lava"]
  Q -- "no" --> AT["Executor ticks the model's action"]
  RA --> E["End of tick: results and observations go out"]
  AT --> E
```

Source: `MultiplexedServerBridge.java` (`executeAcceptedInput`), `ServerActionExecutor.java`.

The 14 default reflexes (`reflexes.mjs`, also listed in `coordinator/config/minecraft-agent/AGENTS.md`): `default-lava`, `default-lava-flow`, `default-fire`, `default-air`, `default-edge`, `default-creeper`, `default-suffocate`, `default-fireball`, `default-arrow`, `default-retreat`, `default-eat`, `default-defend`, `default-blaze-cover`, `default-cover`. The model can switch each one off by name.

**Known fault in this loop (found 15 Nov, fix assigned to the portal lane).** `default-defend` fires only while no action is running. When the model replaces a command, the old one is cancelled first, so for a moment the body is idle. The reflex takes the body in that gap and the model's new command arrives already paused. `replaceAction` skips the reflex hand-off that a normal command gets (`native-tool-runtime.mjs`). In two STAGED test games (rod gate batch B, B4 and B3) the model asked to flee or build a shelter, the command never ran, and the body died 2.7 and 3.7 seconds later.

### 2. Overworld segment

The route rows are in `skill-fits.mjs`. The first row that is not done is the suggested step.

```mermaid
flowchart TD
  S(["Spawn"]) --> F["food: meat from the nearest animal"]
  F --> W["wood: wooden pickaxe"]
  W --> FS["food_stock: 8 cooked meat before going underground"]
  FS --> ST["stone: stone pickaxe"]
  ST --> FU["furnace"]
  FU --> IP["iron_pickaxe<br/>fresh 8 of 8"]
  IP --> SH["shield in the off hand<br/>fresh 8 of 8"]
  SH --> KIT["iron_kit: 2 buckets, flint and steel<br/>fresh 7 of 8, 11 iron in total"]
  KIT --> WB["water bucket"]
  WB --> LAVA["find block lava<br/>fresh 7 of 8"]
  LAVA --> PB["build nether_portal<br/>casts the frame with buckets, lights it"]
  PB -- "build refused" --> DC["cast_obsidian frame<br/>model casts the frame itself"]
  PB --> LIT["Portal lit<br/>fresh 6 of 8"]
  DC --> LIT
  LIT --> ENT(["Enter the Nether<br/>fresh 6 of 8"])

  classDef ok fill:#1f7a3a,color:#ffffff,stroke:#14532d
  classDef part fill:#a16207,color:#ffffff,stroke:#713f12
  class F,W,FS,ST,FU,IP,SH,KIT,WB ok
  class LAVA,PB,DC,LIT,ENT part
```

Numbers are round 5 (8 games, 14 Nov). Buckets were 8 of 8 but flint and steel 7 of 8, so the full kit is 7 of 8. Round 6 replayed six of those seeds and got 4 of 6 into the Nether, against 6 of 6 in round 5 on the same seeds. The portals also came much later. The cause is not established.

| Step | Hand | Where |
|---|---|---|
| Tools, furnace, buckets, shield, food | `obtain`, which plans gather, craft and smelt | `obtain-runner.mjs`, `obtain-plan.mjs` |
| Find lava | `find block minecraft:lava` | `find-search.mjs` |
| Build and light the portal | `build nether_portal` | `ServerBuildController.java` |
| Cast the frame directly | `cast_obsidian` with `frame:true` | `ServerCastObsidianController.java` |
| Enter a portal | No hand. `travel_to` detects standing in a portal | `ServerTravelController.java` |

Open in this segment: first Nether entry came at minute 35 to 173 in rounds 4 to 6, with time lost mostly to food trips, worn tools, flooded tunnels and deaths that reset the kit. Portal casting still fails in some real saves, when lava is out of reach or there is no dry spot to work from.

### 3. Nether segment

Every fresh game that reached the Nether ended here. In the Nether the route line has only three states (`skill-fits.mjs`): get blaze rods, then get pearls, then go home.

```mermaid
flowchart TD
  IN(["Enter the Nether<br/>fresh 6 of 8"]) --> FF["1. Find a fortress<br/>find structure fortress<br/>fresh 1 of 8, real save 1"]
  FF --> SP["Reach the blaze spawner"]
  SP --> BR["2. Get 7 blaze rods<br/>fight_until blaze_rod<br/>fresh 0; rod gate 0 of 5 real save,<br/>0 of 5 staged, alive with 4 or more"]
  BR --> WF["3. Find a warped forest<br/>find biome, no dedicated hand<br/>real save: one search, 418 blocks walked"]
  WF --> EP["4. Get 12 to 14 ender pearls<br/>fight_until enderman<br/>fresh best 1, staged best 4"]
  EP --> RT["5. Return to the portal<br/>travel_to, no dedicated hand<br/>never with loot"]
  RT --> OUT(["Back in the Overworld"])

  WS["Wither skeletons kill the body<br/>before the blaze fight<br/>6 of 8 first deaths in the test"] -.-> SP
  WS -.-> BR
  DROP["Kills, no rods held<br/>5 bow kills, 0 rods seen or held"] -.-> BR
  WAND["Wandering: 3 blocks walked per block gained<br/>61 of 75 turn-backs inside material hunts"] -.-> FF
  BAST["Bastion and piglin barter<br/>barter_until, off the route:<br/>about 190 gold ingots for 12 pearls"] -.-> EP
  DEAD["Any death: respawn in the Overworld with nothing<br/>round 5 returns took 13 to 57 minutes"] -.-> IN

  classDef wall fill:#b91c1c,color:#ffffff,stroke:#7f1d1d
  classDef part fill:#a16207,color:#ffffff,stroke:#713f12
  classDef cause fill:#374151,color:#ffffff,stroke:#111827,stroke-dasharray: 4 3
  class FF,BR,WF,EP,RT wall
  class IN,SP,OUT part
  class WS,DROP,WAND,BAST,DEAD cause
```

#### The five blockers

| # | Blocker | Hand that exists | Best evidence | Named cause | Owner |
|---|---|---|---|---|---|
| 1 | Find a fortress | `find structure fortress`, with a fortress-floor walk for spawners (`find-search.mjs`); `nether-regions.mjs` gives search facts | Fresh: 1 of 8 (round 5), 1 of 6 (round 6). Real save: found and entered once | The body wanders. 61 of 75 large turn-backs happened inside hunts for tools, chests, food or gold. `obtain` plans Overworld mobs while in the Nether (16 of 25 goals checked). A refused route is walked again and again | Portal lane after blocker 2; water-and-lava lane owns the Nether `obtain` fault |
| 2 | Get blaze rods | `fight_until` with built-in drop collection (`ServerFightUntilController.java`), `build_shelter`, `flee_from`, the `default-blaze-cover` reflex | Fresh: 0. Best in single tests: 4 held, then lost on death. Rod gate on base `9d10cedb`: 0 of 5 alive with 4+ rods on a real fortress save without armour, 0 of 5 on a STAGED fortress-with-gear save (lower deck, Y 65). 13 deaths; 6 of the 8 games that died were first killed by a wither skeleton; blazes were involved in 3 deaths | Wither skeletons kill first. A flee or shelter command sent while a reflex holds the body never runs (proven in 2 STAGED games, B3 and B4). Likely, not proven: rods from ranged kills are not collected. B1 and B5 made 5 bow kills and held 0 rods; no rod was seen | Portal lane (fix A, command hand-off), water-and-lava lane (fix B, ranged-kill fact and rod logging) |
| 3 | Find a warped forest or bastion | Generic `find biome` and `find structure`; `need-sources.mjs` names the sources | One real-save test made 31 legs toward a warped forest, walked 418 blocks for 101 net, and earned 1 pearl. Barter: three tests (two real save, one staged), 0 trades | No dedicated search hand. Bastions stay off the route by decision. Barter needs about 190 gold ingots for 12 pearls (`need-sources.mjs`, about 15.6 per pearl) | Survive lane, with blocker 4 |
| 4 | Get the pearls | Enderman hunt inside `fight_until` (`EndermanHuntLeads.java`); `barter_until` (`ServerBarterController.java`) | Fresh: 1 pearl, in two games (round 4 G7, round 6 G7). Tests: best 4 pearls held, from a staged forest start; one staged test got 3 enderman kills and 1 pearl | The hunt reports "no target seen" in real terrain. Fights work once a target is found | Survive lane, with blocker 3 |
| 5 | Return to the portal | None. The route says "return home through the portal" with no coordinates while in the Nether (`skill-fits.mjs`); the model uses `travel_to` | No game has carried rods or pearls back. Only returns after death are measured: 13 to 57 minutes in round 5, 10 to 58 in round 4 | Not yet read. The Overworld side of the route names the known portal's coordinates (`skill-fits.mjs`); the Nether side does not | Survive lane, after 3 and 4 (a read first) |

Two more walls sit across the whole segment and are not steps:

- **Death recovery.** In round 5, five games spent 265 minutes back in the Overworld after eight Nether deaths. There is no dedicated return hand; `respawn-recovery.mjs` gives facts only.
- **Armour.** Bodies mostly arrive with no armour: no armour at 10 of 12 Nether entries in round 5. A route step for a chestplate was merged and reverted on 15 Nov. In its one fresh test game the route row never showed; the model asked for a chestplate three times anyway and each obtain stopped (twice for danger, once with no source and a worn tool).

### 4. After the Nether: stronghold, the End, the dragon

No fresh game has reached this segment. Everything below comes from staged starts.

```mermaid
flowchart TD
  BACK(["Back in the Overworld with rods and pearls<br/>never"]) --> CE["Craft 12 eyes of ender<br/>craft, never fresh"]
  CE --> FS["find structure stronghold<br/>throws eyes, follows them, digs down<br/>staged"]
  FS --> PR["find block end_portal_frame<br/>walks passages to the portal room<br/>staged: reached in some scouts,<br/>missed in more, count unverified"]
  PR --> SE["Set the eyes in the frames<br/>interact_block, no dedicated hand<br/>staged: 11 of 12 frames from 12 eyes<br/>world started with 2 filled"]
  SE --> EN["Enter the End<br/>staged starts only, count unverified"]
  EN --> CR["Break the end crystals<br/>fight_target, use_ranged"]
  CR --> DR(["Kill the dragon<br/>staged 1, from an End save"])

  ECON["Eye economy: thrown eyes break about 1 in 5,<br/>12 eyes left the frame one short"] -.-> SE

  classDef staged fill:#4b5563,color:#ffffff,stroke:#1f2937
  classDef never fill:#b91c1c,color:#ffffff,stroke:#7f1d1d
  classDef cause fill:#374151,color:#ffffff,stroke:#111827,stroke-dasharray: 4 3
  class FS,PR,SE,EN,CR,DR staged
  class BACK,CE never
  class ECON cause
```

| Step | Hand | Where |
|---|---|---|
| Follow thrown eyes | `followEyes`, started by `find structure stronghold` | `find-eyes.mjs`, `EyeFlightObservation.java` |
| Reach the portal room | `findPortalRoom`, started by `find block end_portal_frame` | `find-portal-room.mjs` |
| Fill the frames, enter the End | No hand; `interact_block` and `travel_to` | |
| Dragon | No hand. Facts about perching and crystals, then `fight_target` and `use_ranged` | `dragon-fight-facts.mjs`, `ServerFightController.java` |

### 5. The whole run on one line

```mermaid
flowchart LR
  A["Kit<br/>fresh 7 of 8"] --> B["Portal lit<br/>fresh 6 of 8"]
  B --> C["In the Nether<br/>fresh 6 of 8"]
  C --> D["Fortress<br/>fresh 1 of 8"]
  D --> E["7 blaze rods<br/>never"]
  E --> F["12 pearls<br/>never"]
  F --> G["Home with loot<br/>never"]
  G --> H["Stronghold room<br/>staged, count unverified"]
  H --> I["End entered<br/>staged, count unverified"]
  I --> J["Dragon dead<br/>staged 1, from an End save"]

  classDef ok fill:#1f7a3a,color:#ffffff,stroke:#14532d
  classDef part fill:#a16207,color:#ffffff,stroke:#713f12
  classDef wall fill:#b91c1c,color:#ffffff,stroke:#7f1d1d
  classDef staged fill:#4b5563,color:#ffffff,stroke:#1f2937
  class A ok
  class B,C part
  class D,E,F,G wall
  class H,I,J staged
```

A full run needs every box in the same game. The green and yellow boxes work from spawn. The red boxes have never worked. The grey boxes have worked only from prepared starts, so "the End is solved" is not yet shown from a real run.

### Where the numbers come from

- Fresh games: rounds 4, 5 and 6 (8, 8 and 6 games, up to 180 minutes each, 14 to 15 Nov). Spend caps ended many games early.
- Rod gate: batch A played a real fortress save five times, batch B a STAGED fortress-with-gear save five times, on base `9d10cedb`, 15 Nov.
- Staged results: the staged scouts of 13 to 14 Nov, including the staged chain that made the first dragon kill (`retained-first-dragon-kill`). No fresh game has killed the dragon.
- Reads without the model: the Nether wandering audit, the `obtain` dimension check and the command-replacement read, all 15 Nov.

The recordings and run records now live in the private archive read through `ARENA_PRIVATE_INPUTS`, with repository-relative paths preserved.
