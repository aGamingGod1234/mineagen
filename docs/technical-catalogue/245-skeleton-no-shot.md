# #245 Walk on past a skeleton below the ledge that has no shot at the bot

- **Problem:** A skeleton stuck on a cave floor below the bot froze every walk, 148 stops in a row in one run, though the ledge edge blocked its shot.
- **Solution:** Before stopping for a skeleton holding a bow, the bot checks the skeleton's own eye line to it, the line its bow needs, and walks on while that line is blocked, unless the skeleton had a line on it, targeted it or hit it in the last 10 seconds.
- **Result:** Measured in practice rooms on cloud machines, two same-batch runs pooled: with a bow skeleton under a glass floor edge, main stopped 20 of 20 times and the fix walked past 20 of 20 with no damage. With the edge open, the fix stopped 20 of 20 (main 17 of 20) and took about the same damage, 39 against 41. The hard-world iron run was 27/40 against 28/40, not separated.
