# #242 Bridge a level tunnel across a cave on placed blocks instead of stopping at the edge

- **Problem:** A tunnel toward iron that broke into a cave stopped at the edge, again and again, beside the same ore.
- **Solution:** The bot now bridges across the cave on placed blocks, crouching to the edge until it can see the face to place on, and still stops when the ore it wants is down in the cave.
- **Result:** Measured in practice rooms: cave-crossing rooms 0/26 on main, 26/26 with the fix. On the hard world, the iron run was 27/40 with the fix against 23/40 on main, which is not yet significant.
