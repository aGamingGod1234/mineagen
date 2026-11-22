# #171 Keep the coordinator connected when one observation carries a bad or over-long fact

- **Problem:** one malformed field in one observation, for example an over-long note, disconnected the AI from the game, and a bot that died afterwards stayed dead.
- **Solution:** the coordinator drops just that snapshot and keeps the connection, reconnecting only if 8 snapshots in a row are unusable. A contract test ties every free-text field to the mod's clipping, so the mod clips first.
- **Result:** corrupt-snapshot cases that close the connection went from 13 of 13 to 0 of 13 (measured in unit tests). The in-game case from #120 was 2 of 2 bots on one server cut off 13 minutes in.
