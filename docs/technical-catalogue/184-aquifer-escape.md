# #184 Climb out of a flooded aquifer hole again

- **Problem:** a practice room the bot used to pass every time (digging down into an aquifer, its hole floods, it climbs out) failed every run on main. Two later changes each broke it. A portal change made the search swim and lay its own block before calling the escape job, which drifted the bot off the spot it could climb out from. A flooded-stair change then waded the bot onto a step in open water that led nowhere.
  **Solution:** a bisect on cloud machines, each commit played with its own code and mod, named the first change. Its fix then exposed the second. The search now calls the escape job first, and the escape wades only onto a step that leads to the bank or the next step.
  **Result:** bisect (measured, 5 rooms per commit): 5/5 on the commit before the portal change, 0/5 on it. Escape room 0/10 on main to 9/10 (measured, 10 a side, Fisher p 0.0001), with 14 nearby water, lava and find rooms 98/140 both sides, none worse.
