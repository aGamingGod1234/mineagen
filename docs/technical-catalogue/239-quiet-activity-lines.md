# #239 Keep agent activity lines as context instead of forcing every bot to take a full look

- **Problem:** every bot heard every other bot's "working on it" lines, and each line forced a full observation of the world for that listener. At 32 bots that was about half of all observation work, and the cost grew with the square of the bot count.
- **Solution:** activity lines are now kept as background context in each bot's event log and no longer trigger an urgent look.
- **Result:** observations sent at 32 bots 75/s -> 44/s, and observation work 18.1% -> 15.1% of server time (measured from profiles on 8 cloud machines, 8 runs per side); forced observations from perception changes 1,189 -> 82 per 2,000 collects (measured in local 32-bot traces); practice rooms 90/90 on both sides (measured).
