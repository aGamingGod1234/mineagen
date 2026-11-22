# #64 Benchmark every practice room 10 times and compare a change against the baseline

- **Problem:** after each fix we tested a handful of rooms, so we never saw what the change did to the other 300, or where the bot was weakest overall.
- **Solution:** one command plays all 315 practice rooms 10 times each, two at a time on 39 rented 8-core machines, and scores every room against the last run. A difference only counts when it beats chance (Fisher test).
- **Result:** a full game-wide scoreboard of 3,310 runs in 81 minutes (measured). Played one room at a time on one local slot, the same work is about 90 hours (measured: the summed time of every room process). It found the portal-and-lava stage at 58% against 89% for the early game.
