# #107 Make far sight cheap next to a lava sea in a Nether fortress

- **Problem:** Next to a Nether fortress, the bot's far sight sorted a whole lava sea, up to 110,000 blocks, by distance on every look, just to check the nearest dozen. Perception stalled game ticks for up to 56 ms during blaze fights.
- **Solution:** Each block's distance is worked out once and the nearest blocks come off a heap in exactly the old order, so a look only pays for the blocks it checks. The sea's grouping is reused while it hasn't changed.
- **Result:** Far-sight pass 22.5 ms to 5.1 ms at the median and 55.7 ms to 15.2 ms at p99. Perception's p99 cost per tick dropped from 43.4 ms to 13.6 ms (measured, 4 fortress practice rooms per side, every look logged).
