# #76 Play every practice room at 3x game speed where the A/B shows the same game

- **Problem:** Practice rooms run three times faster when the server ticks at 60 TPS. But every room's own stopwatch read the computer's clock, so a fast room played a different, longer game.
- **Solution:** Every room now reads a game clock taken from the world's tick counter. A gate keeps each room at normal speed until an A/B shows it plays the same game fast.
- **Result:** Measured on cloud machines, 10 runs at each speed per room, 96 rooms from 43 fixtures. 35 fixtures play the same game at 3x, and 10 were caught playing differently and kept at 1x (7 on 10 runs a side, 3 on a pilot plus 2-3 re-runs). One example: a Nether travel course died in 4 of 10 runs at 3x and 0 of 10 at 1x. Room time fell to 0.51 of its 1x time overall (2154 to 1103 machine-minutes) and to about 0.4 for the longest rooms.
