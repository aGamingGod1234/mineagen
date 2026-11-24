# #236 Plan routes without re-reading every consulted block on every waiting tick

- **Problem:** with 16 bots starting their trips, route searches that span several ticks re-read every block they had looked at on every tick they waited, often 8,000 blocks each, taking up to 14% of server time.
- **Solution:** a waiting search now only checks a change log of what the bot learned, and re-reads its blocks once, when it finishes.
- **Result:** terrain re-check time 5.0 s -> 0.13 s in a traced 8-bot run (measured); its share of server time 1.3-11% -> under 0.25% on 6 cloud machines (measured from profiles); finished route plans 97 -> 174 in the same trace (measured).
