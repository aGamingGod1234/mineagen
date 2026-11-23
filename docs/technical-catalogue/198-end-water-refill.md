# #198 Refill the End water bucket from its source, not the flow beside it

- **Problem:** In the End the bot pours its water bucket at its feet when an enderman comes for it. To pick the water back up it has to click the one source block; an empty bucket looks straight through the flowing water around it. The bot aimed at the nearest water it saw, which is almost always that flow, so the bucket hit the stone underneath and stayed empty.
- **Solution:** An empty bucket aimed at flowing water now follows the flow back to the block it comes from and aims there, the way a player looks for the source. The dragon fact names a water source when one is in view.
- **Result:** In a practice room that pours at the feet, steps 2 to 3 blocks off and refills from the fact's hint, the bucket came back full in 0 of 48 runs before and 60 of 60 after (measured on boat machines, counted by the mod jar each run loaded). Twelve End and bucket rooms: 112 of 114 passes before, 113 of 114 after.
