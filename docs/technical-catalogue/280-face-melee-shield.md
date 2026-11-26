# #280 Face one melee mob behind the shield instead of backing away

- **Problem:** with no armour, three hits from a wither skeleton are enough to kill the bot, so its safety rule always backed away, dropped the shield and took hits in the back. Wither skeletons were the top killer between the fortress and the blaze spawner (12 of 32 deaths before reaching a spawner, 18 deaths in 33 meetings).
- **Solution:** against a single melee mob, the bot now stands and blocks with its shield the way a player does, and still backs out of crowds.
- **Result:** in the practice room, damage from a lone wither skeleton fell from 26 to 0 over 12 rounds per side (measured). Full-game numbers are pending.
