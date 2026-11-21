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

## Status on 2026-11-19

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

The two CP2r rows (checkpoint 2, rerun) are one round in two arms on the same 8 seeds, with GPT-6.2 Sol at low reasoning and 90-minute games, so they are not comparable to the 180-minute rounds above. The arms differ only in the opt-in instincts (`MINEAGEN_INSTINCTS=instincts`). Every gap between them is under 2 seeds, which counts as no change. The instincts arm killed more hostile mobs (29 against 17) and made about 14% more model calls. Every game got the iron pickaxe.

Where things stand:

- **Furthest from scratch:** a Nether fortress and ender pearls. No fresh-world game has yet got blaze rods, eyes of ender, the stronghold, the End or the dragon.
- **Late game, staged:** the agent has killed the dragon from a start already in the End twice: on 2026-10-26 in 44 minutes, on older code, and on 2026-11-14 in 7 minutes. On 2026-11-14 it also entered the End once, in 11 minutes, from a start holding twelve eyes.
- **Biggest walls:** reaching the Nether reliably (one seed has never got there in three rounds), then finding a fortress and getting blaze rods once there.
- **Deaths:** about 2.6 per game. The 30 games in rounds 2 to 6 had 78 deaths: skeleton arrows (29), zombies (13), lava (10, all after the agent had reached the Nether), Drowned mobs (5), creepers (4), spiders (4), fire (3), endermen (3), wither skeletons (2), drowning (2), one piglin, one hoglin and one fall onto a stalagmite. None is unknown: a recount on 2026-11-21 read each death's server receipt. The first count had 14 as other or unknown, 8 of them named causes outside its list and 6 deaths the round record saw only as a death counter step.

## How testing works

Changes are tested in four tiers, from fastest to slowest:

1. **Decision tests**: automated checks that one decision comes out right, such as which block to step on or when to raise the shield. They run on every change.
2. **Practice rooms**: a few minutes of real play in a small staged situation, such as lava beside the path or an enderman out of reach, with no model calls. A change plays the same rooms with and without it, and the counts are compared. Every gameplay change runs them.
3. **Checkpoint runs**: games with the model from a save point partway along the route, run overnight. They test what rooms cannot, such as what the model decides.
4. **Full games from scratch**: the status table above, the scoreboard for the goal.

## Practice rooms on 2026-11-21

Four gameplay changes merged today, each measured in practice rooms against the code before it. These are rooms, not full games, so they do not count toward the status table.

| Change | Room | Before | After |
|---|---|---|---|
| Lava safety (#35) | lava at the bot's own level | died in lava 9 of 9 | 0 of 9 |
| End breath escape (#36) | dragon breath in the End | lost 18 to 30 HP in each of 23 rooms, 2 deaths | 0 HP lost, 0 deaths in 28 of 28 |
| Unreachable enderman (#39, a switch that is off by default) | an enderman the bot cannot reach | killed it 0 of 5 | 5 of 5 with the switch on |
| Shield on a drawn bow (#30) | a skeleton shooting from 4 to 10 blocks | shield stopped 67% of the arrow damage | 81% (24 cases each) |

The first three gaps are all-or-nothing and safe to trust. The shield gain held in 18 of 24 paired cases but is about 3 points either way, and it showed no gain at 10 blocks.

## Keeping this page current

Run records and recordings stay in the private archive named by `ARENA_PRIVATE_INPUTS`, never in this repository. After a full-game round, add a row to the status table with counts only: no seeds, paths, machine names or costs. Change the goal itself only when the project owner does.
