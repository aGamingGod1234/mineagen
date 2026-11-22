# #103 Stop climbing out at the surface, walk the last step to a seen spot, and arrive at the right height

- **Problem:** a bot told to "reach daylight" dug up, came out on the grass and kept building a staircase into the sky, because its dig only knew the target height, not where the ground ends.
- **Solution:** before each step the dig checks whether anything is left to dig and whether there is open sky above; if the next step would just be a block placed in the air, it stops and walks on. Ground rising ahead (a pit wall) keeps it climbing.
- **Result:** blocks wasted building into the air on a climb-out: 9 to 0 (open ground), 5 to 0 (under trees), 9 to 1 (beside a hill). Measured over 10 practice-room runs each, against main.

- **Problem:** walking to an ore it had been shown in a cave, the bot dug a tunnel through the rock beside the open cave. One step stalled, it then refused a ledge that would have finished the trip because the ledge was "only" 1.8 blocks closer, and it tunnelled straight on past the ore.
- **Solution:** a seen spot inside the trip's arrival distance always counts as progress, and a building run stops as soon as its next block would be farther from the target.
- **Result:** rock dug on the playtest spot fell from 80 to 32 blocks over 15 runs each, and no run went past the ore (main overshot by up to 8 blocks). Measured in practice rooms on the playtest world's seed.
