# PR #152: Wake the bot's planner after 3 minutes of a search going nowhere, not when the search times out

- **Problem:** a search that goes nowhere hides from the bot's planner. While a long step ran, the coordinator folded the search's own "not getting anywhere" notes into the end-of-step report, so the planner only heard of a failing 13.7-minute wood search when it ended.
- **Solution:** a stall clock in the wake filter. After 3 minutes of stall notes with no item gained, the planner gets one wake and can change plan while the search keeps running.
- **Result:** in a replay of the recorded game, the first check-in comes at minute 4.7 instead of 14.6 (measured by trace replay). Across 16 recorded games the clock adds about 0.6 planner wakes per game (10 in total, measured the same way, an upper bound). The effect on time to wood is not yet measured in live games.
