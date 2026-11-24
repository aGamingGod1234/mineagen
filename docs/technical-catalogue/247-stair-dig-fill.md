# #247 Stair digging: fill the hole under the next step

- **Problem:** The bot placing a block to bridge a hole in its staircase failed about 1 time in 4 tries: it either couldn't see the face it was clicking, or it was standing in the spot the block had to go.
- **Solution:** It now leans until its eye actually sees the face, skips the lean when the face is on top, and steps out of the spot before placing.
- **Result:** Measured in cloud practice rooms, same-batch rounds of 30 a side: failed fills 27 → 0, 28 → 2 and 16 → 0. Deaths unchanged over 120 rooms a side (40 vs 43), and the crystal room's pass rate flat (26 vs 23).
