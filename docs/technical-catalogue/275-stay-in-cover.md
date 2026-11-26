# Stay in cover until the danger has passed instead of walking straight back out (#275)

- **Problem:** The bot's reflexes pulled it into cover, and the AI's next "walk there" order, written before the danger, walked it straight back out into blaze fire and lava.
- **Solution:** A safety reflex now keeps the body until the danger has been quiet for 3 seconds. The walk waits and then resumes, with a 20-second cap so it never traps the bot.
- **Result:** Over 6 fortress games a side (measured, real model, same loot), deaths went from 6 to 4 and games with a blaze rod from 0 to 1. This is a small sample.
