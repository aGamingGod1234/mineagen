# PR 306: Stronghold: skip unreachable portal-room spots, walk longer between eye throws

- **Problem:** Inside a stronghold, the bot kept trying the same unreachable spots and spent 87 minutes without reaching the portal room.
  **Solution:** The search remembers spots it failed to reach and moves on to new ones.
  **Result:** In the failing game, 3 to 5 repeat attempts per dead spot before. Live A/B pending.
- **Problem:** Following eyes of ender across the sea, the bot threw them every 60 blocks and lost 7 of 8 to shattering or the water.
  **Solution:** Walk up to 300 blocks between throws while the bearing holds, and never throw over water.
  **Result:** Decision tests: 4 legs cover 960 blocks with the switch on against 312 off, so about a third as many eyes thrown over the same distance (estimated from the leg lengths). Live A/B pending.
