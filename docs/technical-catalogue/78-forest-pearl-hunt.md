# #78 Fight endermen seen out of reach in the Nether; forest-walking pearl hunt behind a switch

- **Problem:** in real games the bot saw endermen on shelves and across lava and never fought one (25 of 29 games without a pearl): its hunt only counted endermen within 24 blocks, and an angry one across lava never came over.
- **Solution:** as a player does: stare at it from where you stand (out to vanilla's 64-block range) so it teleports to you, and if an angry one is stuck across lava, step back past 16 blocks so it teleports across.
- **Result:** measured in new practice rooms (10 repeats per spot, 3x speed, against main): endermen on a shelf or across lava killed in 22 of 30 runs against 5 of 30 (shelf alone 10/10 against 0/10); open ground unchanged; no deaths. Forest pearl hunts unchanged against main (13/40 with a pearl against 10/40, deaths 5 against 4).
