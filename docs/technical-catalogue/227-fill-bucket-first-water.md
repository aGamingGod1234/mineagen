# #227 Fill the bucket at the first water in reach on the way to far water

## Filling a bucket at the first water in reach

- **Problem:** the bot saw water 80 blocks away and walked to that exact block. When it was the far side of a lake, the bot reached the near shore and then built a bridge across the lake toward the far block, never scooping the water right under it, until time ran out.
- **Solution:** the walk to water goes in 10-second legs, and after each one the bot checks for any water within arm's reach and fills there, as a player fills a bucket at the first water they reach.
- **Result:** in the deep water practice rooms (start 54 blocks down, find water in 180 s) the bot found water 24/40 times before and 31/40 after in one same-batch A/B, 51/80 vs 65/80 over two rounds. The lake room went from 5/10 to 9/10 in both rounds. Measured in practice rooms.
