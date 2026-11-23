# #185 Turn the instincts arm on by default so practice rooms play the way model games do

## Practice rooms measured a different bot from the one in model games

- **Problem:** The bot's instincts (automatic stance, fighting through beatable mobs on a walk, healing and weapon habits) were on in model games but off in every practice room, so a room's pass rate did not predict what a game would do.
- **Solution:** Instincts became the default on both the mod and the coordinator, and the coordinator's reflex rule book that the room scripts build now follows the same switch. Before the flip, every practice room was played 10 times with instincts on and 10 with them off, on the same jar at the same time.
- **Result:** Measured across all 300 practice rooms, 10 runs per side on cloud machines: runs passed 87.0% off against 87.4% on (2,786 of 3,203 against 2,811 of 3,218), deaths 75 against 63, damage 7,623 against 7,568 HP. The pooled test finds no loss (p(worse) 0.82). One room changed significantly: a walk past a zombie went from stopping (10 of 10) to fighting through and arriving (0 of 10 by that room's old check, 0 damage), which is the instincts design.
