# #258 Swim back to where it last breathed when no air is in sight underwater

- **Problem:** Underwater with no air in sight, the bot swam straight up into the ceiling and drowned, even though the air it had just breathed was a few blocks back down the tunnel.
- **Solution:** It remembers the path its head took since its last breath and swims back along it, the way a player turns around.
- **Result:** Drowned in 10 of 10 flooded-tunnel runs before, 0 of 10 after (measured, 10 practice-room runs a side, twice: on this computer and on cloud machines). Drowning was 5 of 30 Overworld deaths in 8 fresh games (measured, from death messages).
