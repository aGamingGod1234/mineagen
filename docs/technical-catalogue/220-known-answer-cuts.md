# #220 Reuse perception answers already known within a tick

- **Problem:** Every tick, each bot sorted the same 1,200 nearby blocks into the same order, and re-asked questions whose answers it already had a moment earlier.
- **Solution:** Sort the box once at startup and place each tick's blocks by their fixed rank; remember the last chunk section and block name instead of looking them up again.
- **Result:** Block ordering 2.75% → 0.38% of the server's time at 32 bots, Mineagen's time per tick 37.4 → 33.3 ms at 32 bots and 17.2 → 13.7 ms at 16 (measured with Java Flight Recorder, 4 runs a side on large test machines). Bots play the same: 89 of 90 practice rooms passed on both sides.
