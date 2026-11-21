# #39 Stop a pearl hunt from getting stuck on an enderman it cannot reach

- **Problem:** an angry enderman the bot could see but not reach, such as one on a pillar, pinned the whole pearl hunt. The bot kept walking at it and failing, hundreds of times per call, and never moved on.
- **Solution:** a mob the bot's route search cannot reach is passed over until it or the bot moves 3 blocks, so the hunt turns to an enderman it can reach (behind a switch, off by default).
- **Result:** measured in a test room with no model calls, 3 trials per arm: failed approaches went from about 512 per call to 1 or 2, and the reachable enderman was killed in 3 of 3 trials at about 20 s, against 0 of 3 before.
