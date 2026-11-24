# #243 Keep the bucket in the End: scoop the enderman water back when the dragon comes near

- **Problem:** Standing in water stops an angry enderman, but the bot walked away from that water whenever the dragon flew close. The bucket was empty for the next enderman, and the bot went back for the water under the dragon.
- **Solution:** When the dragon comes near and no enderman is on the bot, it scoops the water back before it moves, as a player keeps the bucket. With an enderman still near, it leaves the water as cover.
- **Result:** Dragon kills in the full fight rose from 6 to 18 of 120, with deaths flat (65 vs 62). Measured on cloud practice rooms, three same-batch rounds of 40 a side.
