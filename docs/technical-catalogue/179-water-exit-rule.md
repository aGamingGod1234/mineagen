# #179 Climb out of water by one measured rule

- **Problem:** The bot had three different guesses for how high a swimmer can climb out of water, and none had been measured. It picked ledges and placed steps by those guesses. Under a low flooded ceiling, with dry land one column over, it walked to the bank again and again and never got out.
- **Solution:** A body-only sweep measured vanilla's real limit: a swimmer holding forward and jump gets onto a ledge at most 0.875 blocks above the top of its water. Floating and wading gave the same edge. Escape and travel now share that one rule. The bot also pushes onto a bank across one open water column, the way a player swims over and climbs out.
- **Result:**
  - Low-ceiling flood room: out of the water in 10 of 10 runs, against 0 of 10 before, in about 22 s (measured, 10 room runs a side).
  - Six other water and hole escape rooms: 60/60 before and after, 0 deaths, 0 damage (measured).
  - The sweep: ledges up to 0.875 over the water climbed in every run, 0.9375 never (measured, 41 heights from 2 starts, 2 runs each; a third start, standing on the bottom, climbed every ledge up to the water's top).
