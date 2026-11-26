# #291 End: forget crystals the bot sees destroyed, and wait closer to the fountain

## Ghost crystals

- **Problem:** the bot only knew a crystal was gone when its own arrow's result said "broke". When a shot was cancelled while the arrow flew, or a blast took out a neighbour, the crystal stayed "standing" in its memory for the rest of the fight. It kept climbing pillars after crystals that were not there.
- **Solution:** the mod watches the island's crystals the way a player does. A crystal it saw blow up, or whose empty spot is in plain view, is reported as gone, and the bot's memory drops it.
- **Result:** before, 8 of 16 End games that broke all ten crystals kept 1-3 ghost crystals for 5-29 minutes (measured from model prompts after the last real break). After, in 3 End games on this branch, no ghost crystal outlived the model turn already in flight when the crystal broke (under 6 s). In paired 45-minute End games, main killed the dragon 0 of 3 times with 7 deaths; this branch 2 of 3 with 1 death (measured).

## Waiting distance

- **Problem:** the bot was told to wait 10-15 blocks from the fountain between perches. From there it rarely reached the dragon's head before the dragon took off again.
- **Solution:** the advice now says to wait 7-10 blocks out, off any breath cloud.
- **Result:** before, landings with the bot 6-10 blocks out were hit 30 of 41 times, and those 10-20 blocks out 3 of 81 times (measured over 16 End games). After: not measured on its own; the paired kill counts above include both changes.
