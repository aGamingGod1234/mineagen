# PR #57: Play real AI games from save points on boat machines and score them per arm

## Real AI games in parallel on cloud machines

- **Problem:** The only way to judge a change in how the AI thinks is to play real AI games from save points, such as "full kit at the Nether entry", and each one takes 90 minutes. Two versions of eight games took a whole night on three local machines.
- **Solution:** A batch runner plays a plan of save points × versions on cloud machines, one game per machine. All versions in a repeat share the same world and loot rolls, and every game is scored from its report.
- **Result:** Measured from the runner's logs: night 1 played 67 games in about 6 hours on 22 machines, and round 2 played 88 games on 44 machines at once. Before, 16 games took a whole night.

## Copying a whole wave home at once

- **Problem:** A wave of games ends at the same time, and each game's logs are about 100 MB. Copying them home one after another slowed to 7-10 minutes a game, so the next wave started an hour late.
- **Solution:** Finished games are now copied home several at a time and sha-checked. A failed local copy, for example on a full disk, is retried next pass from the machine instead of dropping the game.
- **Result:** Night 1, one at a time: 7-10 minutes per game after wave 2 (measured from the batch log). Round 2, with the same parallel design as a helper next to the runner: 44 games were home 13 minutes after they ended (measured). A full disk at 5:25am failed 20 copies and lost 0 games.
