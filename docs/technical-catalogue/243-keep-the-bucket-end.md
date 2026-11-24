# #243 Keep the bucket in the End: scoop the enderman water back when the dragon comes near

- **Problem:** Standing in water stops an angry enderman, but the bot walked away from that water whenever the dragon flew close. The bucket was empty for the next enderman, and the bot went back for the water under the dragon.
- **Solution:** When the dragon comes near, the bot scoops the water back before it moves, as a player keeps the bucket.
- **Result:** Water left behind fell from 347 of 408 pours to 21 of 529. Runs that cleared every crystal rose from 27 to 36 of 110. Deaths were unchanged (34 vs 33 of 110). Measured on cloud practice rooms, 4 same-batch rounds.
