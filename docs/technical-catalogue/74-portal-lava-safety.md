# #74 Cast portals without spoiling the pool, choose and reach cast sites like main, and climb out of flooded holes

- **Problem:** the bot's own cast water ran down a sloping cave floor and turned the lava pool it was casting from into obsidian, so it ran out of lava halfway through the portal frame.
  **Solution:** pour lava first, then water against it, and take the water back the very next tick, before water ever starts to spread.
  **Result:** `cast-obi-2` went from 0 of 10 to 6 to 10 of 10 across rounds (measured, practice rooms, 10 runs each side).
- **Problem:** mid-cast, the bot kept walking back along the way it came in, which its own cast had blocked, and gave up with lava still in sight.
  **Solution:** when the remembered way cannot take a step, let travel plan the walk, and retry a narrow shore once from a fresh spot.
  **Result:** `away-pair-7` went from 6 of 10 to 10 of 10 (measured, practice rooms, 10 runs each side).
- **Problem:** digging straight down to lava, the bot broke the block it stood on and fell into caves it could not see (one room: a 28-block drop into a mob cave).
  **Solution:** cut beside the footing and look at the next floor from a supported block, but only while the pickaxes can pay for the extra digging and still keep enough for the search at depth.
  **Result:** with the check alone, runs with a death in `lava-gate-8` went from 7 to 0 of 10; paying for it all the way down wore out both pickaxes in all 10 `lava-gate-3` runs (7 of 10 passes on main to 0), and with the budget `lava-gate-3` is back to 6 of 10 (measured, practice rooms, 10 runs each side).
