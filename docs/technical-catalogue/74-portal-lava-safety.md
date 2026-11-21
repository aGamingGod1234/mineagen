# #74 Get to lava by stairs, climb out of flooded holes, and cast portals without spoiling the pool

- **Problem:** the bot's own cast water ran down a sloping cave floor and turned the lava pool it was casting from into obsidian, so it ran out of lava halfway through the portal frame (one practice room failed 12 of 12).
  **Solution:** pour lava first, then water against it, and take the water back the very next tick, before water ever starts to spread.
  **Result:** that room went from 0 of 10 to 10 of 10 (measured, boat practice rooms, 10 runs each side).
- **Problem:** digging straight down to lava trapped the bot in flooded caves for the rest of the room and dropped it into mob caves.
  **Solution:** dig stairs like a player, with a climb-out for any flooded hole the bot ends up in.
  **Result:** portals lit 26 against 10 of 80 runs, deaths 9 against 21 (measured, same jar and kit both sides); across all 19 portal rooms, 122 against 106 passes and 10 against 13 deaths.
