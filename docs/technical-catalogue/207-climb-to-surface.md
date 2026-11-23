# Climb the last steps of its own stair to the ground before looking for surface water (#207)

- **Problem:** Coming back up from deep underground to fetch water, the bot stopped at the last stair step still open to the sky, 3-4 blocks down its own one-wide stair cut. Its first walk to look for water could only follow the cut back down, so it lost time climbing again and often ran out of its 180 s.
- **Solution:** The bot remembers the highest open-sky spot it stood on near the last one, which is the top of its stair. Once it is under the sky but still below that spot, it walks the last steps up before it looks around.
- **Result:** In the deep water room with this problem, water found in time went from 1 of 10 runs to 8 of 10, and the walk back down the stair went from 10 of 10 runs to 1 of 10 (measured, same-time batches, 10 runs a side). Across four deep water rooms: 16 of 40 against 8 of 40.
