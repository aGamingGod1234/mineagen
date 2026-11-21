# PR #56: Keep the bot's conversation twice as long and carry its reason for the current step

- **Problem:** the bot's conversation was wiped every 3.4 minutes of play (a median of 17 model calls), and after a wipe it no longer saw why it was doing its current step in 146 of 309 recorded wipes.
- **Solution:** wipe at 128k tokens instead of 64k (a cost setting, far below the model's 500k window), and carry the bot's own one-line reason for each recent step across the wipe.
- **Result:** wipes per game drop from 22.7 to 9.1, at an estimated +18.7% model tokens and about +0.4 s per decision (replayed on 17 recorded games). The reason now survives every recorded wipe that had one (277 of 277), for 116 bytes per wipe (measured on the code). The effect on play is still to be measured in checkpoint games.
