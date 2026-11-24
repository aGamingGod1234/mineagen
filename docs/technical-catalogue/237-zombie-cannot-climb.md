# #237 Walk and dig on past a zombie that cannot climb up to the bot

- **Problem:** A zombie stuck on a cave floor below the bot froze every walk and dig, more than 100 stops in a row, until the iron run timed out.
- **Solution:** Before stopping, the bot asks the zombie's own pathfinder whether it can reach the bot, and walks on when it cannot, like a player ignoring a mob stuck in a pit.
- **Result:** Measured in a practice room with a trapped zombie in sight: main stopped 15 of 15 times, the fix walked past 15 of 15 with no damage. A zombie with a way up still stops it 10 of 10. On the hard world, the iron run was 11/20 on main and 12/20 with the fix. The difference is not significant, and the 75-stop loop is gone.
