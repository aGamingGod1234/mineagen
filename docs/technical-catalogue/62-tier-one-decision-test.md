# #62 Score any commit's decisions per category in one command (tier-1 decision test)

## Telling quickly whether a change makes the bot decide like a player

- **Problem:** we could not tell quickly whether a change makes the bot decide more like a player. Only overnight games showed it, and an offline check had found the bot knows the player move far more often (about 96%) than it makes it in game (about 59%).
- **Solution:** one command rebuilds 129 recorded game moments with any build's code, asks the in-game model, has a second model grade each answer against a rubric that names the player move, and scores five categories against a stored baseline.
- **Result:** about 10 minutes and 768 answers per version (measured). Main scores 67%, and repeat runs land within 2 points overall (measured, 2 runs). It caught that a reworded wake meant to stop the bot carrying on made it worse, 67% to 55% (measured, 6 answers per moment).

## Rebuilding what the bot remembered at a recorded moment

- **Problem:** a recorded moment replayed with only its last few observations lost the caves the bot had seen earlier, and a cut-down goal record meant the replay never woke the bot at all.
- **Solution:** capture keeps the earlier observations that first saw each cave, ore vein and lava block, and keeps the full goal record when a later turn carries only part of it.
- **Result:** moments that wake the replayed bot went from 2 of 60 to 60 of 60, and cave lists matching what the bot was shown from 3 of 15 to 12 of 15 (measured on the 19 Nov round).
