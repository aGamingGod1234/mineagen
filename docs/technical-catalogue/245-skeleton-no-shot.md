# #245 Walk on past a skeleton below the ledge that has no shot at the bot

- **Problem:** A skeleton stuck on a cave floor below the bot froze every walk, 148 stops in a row in one run, though the ledge edge blocked its shot.
- **Solution:** Before stopping for a skeleton holding a bow, the bot checks the skeleton's own eye line to it, the line its bow needs, and walks on while that line is blocked, unless the skeleton has had a line on it or targeted it in the last 10 seconds.
- **Result:** Measured in practice rooms on cloud machines, same batch: with a bow skeleton under a glass floor edge, main stopped 10 of 10 times and the fix walked past 10 of 10 with no damage. With the edge open, the fix stopped 10 of 10 (main 7 of 10) and took 18 damage against main's 30. The hard-world iron run was 14/20 against 13/20, not separated.
