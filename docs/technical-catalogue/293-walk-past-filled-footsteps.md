# #293 Walk past footsteps the bot has since filled in when going back along its route

- **Problem:** When the bot walked back along its own route, it got stuck aiming at footsteps it had since buried itself, for example the floor of an old tunnel under stair steps it had built. It stood on top and waited a full minute. That pattern covers 32 of 37 one-minute retrace stalls in 8 games (about 39 minutes).
- **Solution:** Once it sees a remembered footstep is now solid, it skips it and heads for the next one.
- **Result:** In a practice room with a filled-in turn it reached its drop point 0 of 4 times before and 8 of 8 after, in about 12 s (measured, local). The stall count comes from game logs (measured).
