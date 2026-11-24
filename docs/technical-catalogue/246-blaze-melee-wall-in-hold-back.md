# #246 Hold the blaze spawner wall-in back while a blaze can hit the bot in melee

- **Problem:** When the bot was losing a blaze fight it walled itself in on the spot, even with a blaze right in its face. It stopped fighting to place blocks around a blaze that kept hitting it, and died in the half-built box.
- **Solution:** The bot doesn't start building while a blaze can hit it in melee; it keeps swinging and walls in once that blaze is gone.
- **Result:** Spawner rooms passed 41/75 → 54/75 and runs with a death 18/75 → 10/75 (measured, same-batch A/B, p = 0.021). Pooled with a 10-a-room check batch: 61/105 → 76/105 (58% → 72%).
