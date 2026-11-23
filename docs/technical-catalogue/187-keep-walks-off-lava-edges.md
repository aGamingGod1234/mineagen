# #187: Keep walks a step in from edges over lava, the void or a long drop

- **Problem:** the bot's walking routes ran along the very edge of bridges and ledges above the Nether's lava sea whenever that line was shortest, one knock or slip away from death. The planner priced lava touching a square, never an open edge beside it with lava far below.
- **Solution:** a route square beside an open drop that ends in lava or fire, falls 10 or more blocks, or is seen open 3 or more blocks to a bottom the bot has not seen now costs about one and a half blocks of extra walking. It stays a cost, so a bridge that is the only way still plans.
- **Result:** on a 3-wide deck 5 blocks above lava, the walk spent 30% of its mid-deck positions on the lip lane against 100% before, at the same 3-second walk time (measured, 10 runs a side in practice rooms). Pass rates in the guard rooms and Nether travel courses were unchanged (measured).
