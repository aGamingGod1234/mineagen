# #238 Portal cast and chain: way round to the pool and build walk memory

- **Problem:** to tell a real change from luck, the project compares two versions side by side in the same batch, and one version kept showing about 9 more deaths.
- **Solution:** an A/A round, the same build in both slots, read alongside the batch runner's slot handling.
- **Result:** identical code differed by 8 gates of 237 and 1 death; between batches main ranged 31 to 42 deaths. Measured on 480 practice rooms. Changes under about 10 gates or 10 deaths on 24 gates x10 need a second batch.
