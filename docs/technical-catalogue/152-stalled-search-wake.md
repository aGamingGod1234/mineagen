# PR #152: Stop a search going nowhere after 3 minutes so the bot's planner can rethink

- **Problem:** a search that goes nowhere hides from the bot's planner. The search runs inside the planner's own request, and its "not getting anywhere" notes were saved for the end-of-search report, so a failing 13.7-minute wood search reached the planner only when it ended.
- **Solution:** a stall clock on game time. After 3 minutes of a search making no progress (no item gained, nothing found to walk to), the search hands back with its own stop code, so the planner can rethink at once.
- **Result:** in a trace replay of the recorded game, the planner gets the failed search at minute 4.7 instead of 14.6 (measured). Across 16 recorded games it fires in 2 games and stops 3 searches. One of the 3 would have found wood 2.8 minutes later (measured by the same replay; an upper bound, because the traces lack inventory). The effect on time to wood in live games is not yet measured.
