# Goal: beat Minecraft from scratch

## The goal

One AI agent starts with an empty inventory in a newly generated random world and kills the Ender Dragon in Survival on its own, in a reasonable time. For now, a reasonable time means inside the 3-hour window that full-game rounds use.

Every change should move this goal forward, or keep it from going backward. When you pick between two pieces of work, pick the one that gets a fresh-world agent further along the route below.

## How progress is measured

A full game is a fresh world with an empty inventory, run with GPT-6.1 Sol at low reasoning through the Codex provider. Each round plays the same 8 numbered seeds for up to 180 minutes, so rounds can be compared. Fixed seeds stand in for random worlds until the route holds on all of them.

The route, in order:

1. Iron pickaxe
2. Shield
3. Buckets
4. Flint and steel
5. Water bucket
6. Lava seen
7. Portal lit
8. In the Nether
9. Fortress found
10. Blaze rods
11. Ender pearls
12. Eyes of ender
13. Stronghold found
14. End entered
15. Dragon dead

Staged starts begin a game partway along the route, for example already in the End or holding twelve eyes. They test late steps without paying for a full game. A staged pass does not count as beating the game.

Counts come from each game's milestone timeline and death records. A missing record counts as unknown, not as a pass.

## Status of full rounds (last round 2026-11-19)

No full round has run since 19 Nov. Shorter games and save-point games played since then are in [Evidence since 19 Nov](#evidence-since-19-nov); they do not add rows to this table.

Full games from a fresh world:

| Round | Date | Games | In the Nether | Median minutes to the Nether (games that got there) | Fortress found | Ender pearls | Blaze rods | Deaths per game |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 2 | 2026-11-13 | 8 | 3 | 122 | 1 | 0 | 0 | 3.0 |
| 4 | 2026-11-14 | 8 | 3 | 74 | 1 | 1 | 0 | 2.6 |
| 5 | 2026-11-14 | 8 | 6 | 54 | 1 | 0 | 0 | 2.5 |
| 6 | 2026-11-15 | 6 | 4 | 122 | 1 | 1 | 0 | 2.2 |
| CP2r, instincts off | 2026-11-19 | 8 | 2 | 60 | 0 | 0 | 0 | 1.4 |
| CP2r, instincts on | 2026-11-19 | 8 | 3 | 56 | 1 | 1 | 0 | 1.4 |

Round 3 changed the test tooling and played no games. Round 6 dropped the two seeds that had not reached the Nether in rounds 4 or 5. Every game in rounds 4 to 6 got the iron pickaxe and the shield. The median time to the iron pickaxe was 8 minutes in round 5. Single-seed experiments after round 6 and games started from a Nether save point are not in this table.

The two CP2r rows (checkpoint 2, rerun) are one round in two arms on the same 8 seeds, with GPT-6.2 Sol at low reasoning and 90-minute games, so they are not comparable to the 180-minute rounds above. The arms differ only in the opt-in instincts (`MINEAGEN_INSTINCTS=instincts`). No gap between them passes the noise rule in [How testing works](#how-testing-works): the biggest, 2 against 3 games in the Nether, has p = 1.0. The instincts arm killed more hostile mobs (29 against 17) and made about 14% more model calls. Every game got the iron pickaxe.

Where things stand:

- **Furthest from scratch:** a Nether fortress and ender pearls. No fresh-world game has yet got blaze rods, eyes of ender, the stronghold, the End or the dragon.
- **Late game, staged:** the agent has killed the dragon from a start already in the End twice: on 2026-10-26 in 44 minutes, on older code, and on 2026-11-14 in 7 minutes. On 2026-11-14 it also entered the End once, in 11 minutes, from a start holding twelve eyes.
- **Biggest walls:** reaching the Nether reliably (one seed has never got there in three rounds), then finding a fortress and getting blaze rods once there.
- **Deaths:** about 2.6 per game. The 30 games in rounds 2 to 6 had 78 deaths: skeleton arrows (29), zombies (13), lava (10, all after the agent had reached the Nether), Drowned mobs (5), creepers (4), spiders (4), fire (3), endermen (3), wither skeletons (2), drowning (2), one piglin, one hoglin and one fall onto a stalagmite. None is unknown: a recount on 2026-11-21 read each death's server receipt. The first count had 14 as other or unknown, 8 of them named causes outside its list and 6 deaths the round record saw only as a death counter step.

## Evidence since 19 Nov

Written 23 Nov 2026 (SGT). None of this is a status-table row: none of these games was a 180-minute round from scratch on the 8 round seeds. Counts only.

### From scratch, cut short (22 Nov 2026)

16 games from a fresh world on main as of 22 Nov, with GPT-6.2 Sol at low reasoning and the instincts on. Each was planned for 90 minutes, and all 16 were stopped after 24 to 27 minutes when the model allowance ran out. The stop is censoring, not a wall: it says nothing about how far a game would have got. In 3 games the model made no call in the last 5 to 7 minutes before the stop.

| Milestone | Games that got it (of 16) | Median minutes (games that got it) |
|---|---:|---:|
| Wood | 15 | 0.5 |
| Stone pickaxe | 15 | 2.3 |
| Furnace | 15 | 4.1 |
| Iron ingot | 14 | 12.2 |
| Iron pickaxe | 14 | 13.6 |
| Bucket | 13 | 15.7 |
| Flint and steel | 11 | 20.2 |
| Cooked food | 8 | 18.3 |
| Obsidian, diamond, iron armour, the Nether and beyond | 0 | |

The one game with no wood died twice and never held a log. There were 14 deaths in the 16 games, in 8 of them: skeleton arrows 7, zombies 5, drowning 1, fire 1.

### Save-point starts: checkpoint round 2 (22 Nov 2026)

156 games from save points on four versions, 39 each: main as of 21 Nov, and main with one of three changes (a longer conversation memory, a tool that lets the model pick its response at key moments, and truer cave costs). Each version played 18 starts in the Nether, 12 beside a portal frame and 9 holding eyes of ender, with GPT-6.2 Sol at low reasoning. Games were planned at 90 minutes; 95 played the full 90 and 61 were cut at 37 to 86 minutes.

- **Nether and portal starts, pooled (30 per version):** main found a fortress in 20 of 30 and got blaze rods in 5 of 30. The other versions found a fortress in 18 to 20 of 30 and got rods in 0, 7 and 9 of 30. No version differs from main by the noise rule; the closest, 0 of 30 rods, has p = 0.052.
- **Eyes starts:** main reached the stronghold in 4 of 9 games and the End in 3 of 9. No game on any version killed the dragon: 0 of 36.
- **Deaths:** 255 in the 156 games. Lava caused 73, the most of any cause; then arrows 39, falls 28, fire 26, piglins 25 and wither 25.

### Practice rooms from merges since 19 Nov

The biggest measured gains, each against main before the change. These are rooms, not games.

- **Following eyes of ender (#88):** reached the stronghold from 250 blocks 6/20 -> 17/20 and from a lake start 0/20 -> 16/20; eyes lost per throw 0.83 -> 0.29; ran out of eyes 8 times -> 0.
- **Casting a portal (#74):** 53 -> 75 passes over 18 rooms of 10 runs; one far start 0/10 -> 8/10. Lava-room runs with a death rose 13/100 -> 20/99, which the noise rule calls no change (p = 0.19); watch it.
- **Iron armour (#122):** makes and wears an iron chestplate and boots after the iron kit, 0/26 -> 19/25.
- **Holding a blaze spawner (#89):** alive with a blaze killed and a rod picked up 10/40 -> 24/40; deaths 26 -> 16.
- **Fighting blazes (#93):** walls in on the spot to heal; alive with a kill and a rod 7/40 -> 18/40; deaths 33 -> 14.
- **The first night (#117):** stays off the surface and open ground at night without full iron; alive after mining at dusk 10/16 -> 18/18; deaths on the iron-kit route over the first night 24 -> 5.
- **A mob blocking the climb out of a cave (#111):** stands its ground, then climbs; deaths 14/30 -> 4/30.
- **Fight or flee (#77):** pillars up from a creeper 1/10 -> 10/10, backs off a spawner 0/10 -> 10/10, walks to cover behind its shield 0/15 -> 15/15.
- **A mob round a blind corner (#124):** zombie killed 0/18 -> 12/12; damage taken 90 -> 36 HP.
- **The first tools (#108):** stone pickaxe from an oak-tree start 0/10 -> 10/10.
- **Ore (#105, #119):** mines ore under its own feet 0/10 -> 10/10; goes back to iron it has already seen, which in a recorded cave case took it 0/5 -> 5/5, in 43 s instead of 115 s.
- **Water (#83, #125):** ducks out from under a ceiling into open water and rises instead of drowning 0/10 -> 10/10; wades up a 15-step flooded stair 0/10 -> 10/10.

### Not yet measured

- No full round from scratch has run on current main. The save-point round ran on main from before every change listed above, and the 16 short games ran before #74, #89, #93, #111, #117, #119, #122, #124 and #125, so the games do not show those changes.
- No game since 19 Nov has played long enough from scratch to test obsidian, the Nether or beyond.
- The next full round waits for the model allowance to reset.

## How testing works

Changes are tested in four tiers, from fastest to slowest:

1. **Decision tests**: automated checks that one decision comes out right, such as which block to step on or when to raise the shield. They run on every change.
2. **Practice rooms**: a few minutes of real play in a small staged situation, such as lava beside the path or an enderman out of reach, with no model calls. A change plays the same rooms with and without it, and the counts are compared. Every gameplay change runs them.
3. **Checkpoint runs**: games with the model from a save point partway along the route, run overnight. They test what rooms cannot, such as what the model decides.
4. **Full games from scratch**: the status table above, the scoreboard for the goal.

A room or a game can come out differently with no code change, so each result is a count over repeats, and one noise rule says when a gap is real: a difference counts only when Fisher's exact test, two-sided, gives p < 0.05 over valid runs (INVALID, lost and unknown runs never count), with 10 runs per side for practice rooms. At 10 a side, 0 of 10 against 5 of 10 clears it and 5 of 10 against 8 of 10 does not. A games round plays 8 seeds a side, so it takes a gap of about 5 seeds (0 of 8 against 5 of 8 is p = 0.03; 0 of 8 against 4 of 8 is p = 0.08). A room that did not play properly is invalid and is played again, and a game with a missing record is unknown; neither counts as a pass. The commands for each tier are in [Which test to run](../scripts/quality/README.md#which-test-to-run).

## Practice rooms on 2026-11-21

Four gameplay changes merged today, each measured in practice rooms against the code before it. These are rooms, not full games, so they do not count toward the status table.

| Change | Room | Before | After |
|---|---|---|---|
| Lava safety (#35) | lava at the bot's own level | died in lava 9 of 9 | 0 of 9 |
| End breath escape (#36) | dragon breath in the End | lost 18 to 30 HP in each of 23 rooms, 2 deaths | 0 HP lost, 0 deaths in 28 of 28 |
| Unreachable enderman (#39; its switch is on by default since 21 Nov) | an enderman the bot cannot reach | killed it 0 of 5 | 5 of 5 with the switch on |
| Shield on a drawn bow (#30) | a skeleton shooting from 4 to 10 blocks | shield stopped 67% of the arrow damage | 81% (24 cases each) |

The first three gaps pass the noise rule (died in lava 9 of 9 against 0 of 9, lost health to breath 23 of 23 against 0 of 28, killed the enderman 0 of 5 against 5 of 5; all p < 0.01). The shield result is a share of arrow damage, not a pass count, so the rule does not apply to it directly: the gain held in 18 of 24 paired cases but is about 3 points either way, and it showed no gain at 10 blocks.

## Keeping this page current

Run records and recordings stay in the private archive named by `ARENA_PRIVATE_INPUTS`, never in this repository. After a full-game round, add a row to the status table with counts only: no seeds, paths, machine names or costs. Change the goal itself only when the project owner does.
