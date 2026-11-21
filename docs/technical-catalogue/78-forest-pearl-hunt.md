# #78 Fight endermen seen out of reach, and keep hunting through a warped forest

- **Problem:** in real games the bot saw endermen on shelves and across lava and never fought one (25 of 29 games without a pearl): its hunt only counted endermen within 24 blocks, and an angry one across lava never came over.
- **Solution:** as a player does: stare at it from where you stand (out to vanilla's 64-block range) so it teleports to you, and if an angry one is stuck across lava, step back past 16 blocks so it teleports across.
- **Result:** measured in new practice rooms (10 repeats per spot, 3x speed): endermen on a shelf or across lava killed in 24 of 30 runs, against 4 of 30 before; open-ground rooms unchanged.
- **Problem:** inside warped forests the hunt camped in one shelter; taught to walk, it walked into lava basins and back into wither skeletons.
- **Solution:** walk the forest like a player: skip endermen on ledges, stop beside lava, never retry a way that hurt you.
- **Result:** measured (4 forest save points x 10, default reflexes): hunts ending with a pearl 13/40 before, 22/40 after (45/160 over main's runs, Fisher p = 0.002); pearls 13 before, 28 after; deaths up from 4 to 9 of 40.
