# #289 Walk out of shallow water at beaches instead of bobbing at the edge

- **Problem:** At a beach the bot bobbed at the edge of knee-deep water and never stepped out. Holding jump in water floats you, so its feet never touched the sand, and its walking steps only count once its feet are down.
- **Solution:** In one-deep water it lets go of jump and walks on the bottom like a player wading. It jumps only at a step up or when it is pressed against the bank.
- **Result:** On beach spots recorded from a real game it arrived 0 of 6 times before and 5 of 6 after (measured, local practice room). That pattern accounted for 40 of 47 water stops, about 39 minutes over 8 fresh games (measured from game logs).
