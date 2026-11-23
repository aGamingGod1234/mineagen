# #215 Skip repeated perception work on the server, with the same answers

- **Problem:** Each bot re-did the same perception work every tick. The worst case was a lava check that read about 4,000 blocks per bot per tick, almost all in rock with no lava anywhere near.
- **Solution:** Ask each 16x16x16 block of the world once whether it can hold lava at all, skip it if not, and use hash maps that do not pile chunk keys into a few buckets.
- **Result:** Lava check 1.4-2.0% → 0.7% of the server's time, sight rays 4.3% → 3.0% at 32 bots (measured with Java Flight Recorder, 6 runs a side on large test machines). Bots play the same: 90 of 90 practice rooms passed on both sides.
