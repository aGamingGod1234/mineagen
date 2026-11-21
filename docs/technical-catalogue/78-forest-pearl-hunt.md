# #78 Keep hunting endermen through a warped forest, away from ledges, lava and hostiles

- **Problem:** a bot hunting endermen camped in one shelter and handed back whenever none came within 30 s, so a warped forest full of endermen gave it a pearl in 3 of 10 hunts at best. Taught to walk the forest, it then walked into lava basins and back into wither skeletons.
- **Solution:** the hunt walks the forest the way a player does: on after a short quiet spell, skipping endermen on ledges or across lava, stopping beside lava, and never retrying a way that hurt it.
- **Result:** measured in practice rooms (10 repeats each of 4 forest save points, default reflexes armed, 3x game speed): hunts ending with a pearl 6/40 before, 23/40 after; pearls 6 before, 32 after; deaths level (5 before, 6 after).
