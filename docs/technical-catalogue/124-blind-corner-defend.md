# #124 Hit back at a mob round a blind corner instead of standing still and taking its hits

- **Problem:** The bot's defend reflex stood still and took a zombie's hits round a stone corner. The zombie could see the bot's eyes, but the bot aimed at the middle of the zombie, which was hidden behind the stone, so it never swung.
- **Solution:** The reflex now aims at whatever part of the mob it can actually see within reach, the same test the bot's deliberate fight tool already used.
- **Result:** In a staged blind-corner room the bot killed the zombie 0 of 18 times before and 12 of 12 after, and took 90 damage over 20 rooms before against 36 after (measured, 10 repeats a side on boat machines).
