# PR 306: Stronghold: skip unreachable portal-room spots, walk longer between eye throws

- **Problem:** Following eyes of ender, the bot threw one every 60 blocks on the same bearing, so a long trip used up most of its twelve eyes before it reached the stronghold, and over the sea most thrown eyes were lost.
  **Solution:** Walk up to 300 blocks between throws while the eye keeps its bearing, or toward the crossing point the throws give, and never throw while standing on water.
  **Result:** Measured in one game per arm on two twelve-eye starts: legs between throws grew to 240 and 298 blocks against about 64 on `main`, it reached the stronghold in 2 of 2 games against 1 of 2, held 10 and 9 eyes on arrival against 8 and 6, and died 0 times against 3. Decision tests: 4 legs cover 960 blocks against 312. n=1 per start, low trust.
