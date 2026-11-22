# #74 Cast portals without spoiling the pool, choose and reach cast sites like main, and climb out of flooded holes

- **Problem:** the bot's own cast water ran down a sloping cave floor and turned the lava pool it was casting from into obsidian, so it ran out of lava halfway through the portal frame.
  **Solution:** pour lava first, then water against it, and take the water back the very next tick, before water ever starts to spread.
  **Result:** `cast-obi-2` went from 0 of 10 to 6 to 10 of 10 across rounds (measured, practice rooms, 10 runs each side).
- **Problem:** mid-cast, the bot kept walking back along the way it came in, which its own cast had blocked, and gave up with lava still in sight.
  **Solution:** when the remembered way cannot take a step, let travel plan the walk, and retry a narrow shore once from a fresh spot.
  **Result:** `away-pair-7` went from 6 of 10 to 10 of 10 (measured, practice rooms, 10 runs each side).
- **Problem:** digging stairs to lava, instead of a 1-wide shaft, avoids flooded holes, but on a two-pickaxe kit it wears both pickaxes out and walks into spawner rooms.
  **Solution:** stairs are kept behind a switch, with a pickaxe budget that hands over to the shaft and a flee-and-climb-back from mob caves; the shaft stays the default.
  **Result:** with stairs on, `lava-gate-8` went from 0 to 7 of 10, but `lava-gate-3` went from 8 to 0 of 10 and `lava-gate-6` deaths went from 0 to 5-7 of 10 (measured, practice rooms), so the default stays the shaft.
