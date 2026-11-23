# #204 Climb on to the open sky when a stair out of flooded water ends under cover

- **Problem:** after climbing out of a flooded hole, the bot stopped its stair at the height of a spot it remembered being under open sky. That spot was 15 blocks away on lower ground, so the stair ended in a covered 1-block cut, and every walk out of it stalled until the iron search ran out of time.
- **Solution:** a stair that reaches that height still under cover keeps climbing until it comes out in the open; nothing else changes.
- **Result:** iron-from-spawn seed 6006 went from 0/10 to 9/10 (measured, same-batch A/B, 10 runs a side). The new climb ran in none of the 80 other iron-room runs, and seed 20261107 stayed 10/10 on both arms.
