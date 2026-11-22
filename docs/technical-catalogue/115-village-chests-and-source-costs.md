# #115 Let the bot loot village chests and weigh every source it has seen by the walk or dig to it

- **Problem:** the bot had no idea a chest could hold what it needed, and it priced every ore it had seen as equally cheap, wherever it was: a village chest beside it lost to an iron ore 60 blocks down.
  **Solution:** every source (block, ore, chest, house) is priced in the same units of body time: the walk or dig to it over what it is expected to give, from the game's own loot tables and village building files.
  **Result:** village start with a loot chest in view: passes 8/20 to 17/20, chests opened 0 to 19 of 20 (measured, practice rooms, p=0.008). 16 iron rooms not worse (189/320 vs 204/320, p=0.26).
- **Problem:** village chests stand inside closed houses no sight line reaches, and checking every house cost about 100 s.
  **Solution:** read which village buildings hold chests from the game's building files (a weaponsmith's in 4 of 5 variants, a temple's in none), price each house by the job block by its door, visit the best first and stop when none pays for its look.
  **Result:** measured 13 s per house look over 109 looks; the stone-pickaxe village start is still slower (median 376 s vs 208 s) where the nearby houses are ordinary ones without a visible chest.
