# #255 Record every showcase game and bring its replays and world home

- **Problem:** the replay recorder ignored the bot (it is a simulated player), and the cloud machines that play the games were deleted with the replays still on them.
- **Solution:** the launcher asks the recorder for the bot by name the moment it joins, and waits for the saved replay before the server stops. The batch copies replays and the world off every machine before it lets the machine go, whichever way the game ended.
- **Result:** measured, with the same seed and task, the average tick time was 3.63 ms without recording and 3.81 ms with it, against a 50 ms budget; the medians were 3.40 and 3.35. The cost is one 5 s pause when recording starts. Replays come to about 70 MiB per hour of real play. Each of the three stop paths tested saved the full replay before the server stopped.
