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
- **Deaths:** about 2.6 per game. The 30 games in the table had 78 deaths: skeleton arrows (28), zombies (12), lava (9, all after the agent had reached the Nether), Drowned mobs (5), creepers (4), spiders (4), drowning (2) and other or unknown causes (14).

## Keeping this page current

Run records and recordings stay in the private archive named by `ARENA_PRIVATE_INPUTS`, never in this repository. After a full-game round, add a row to the status table with counts only: no seeds, paths, machine names or costs. Change the goal itself only when the project owner does.
