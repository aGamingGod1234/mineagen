# #143 Raise the shield at a loaded crossbow aimed at the bot

- **Problem:** the bot raised its shield early when a skeleton drew its bow, but a piglin's crossbow gave no such warning: the shield only reacted once the arrow was flying, and a crossbow arrow flies about twice as fast. Piglins hit the bot through its shield in almost every fight.
- **Solution:** a crossbow mob loads, then holds the loaded crossbow aimed for at least a second before it fires; the bot now reads that loaded, aimed crossbow (from a mob that is targeting it and close enough to shoot) as the warning, exactly as it reads a drawn bow.
- **Result (measured, practice rooms, piglin with a crossbow at 4, 7 and 10 blocks, 30 s fights, idle bot with a shield):** fights where the shield stopped at least 80% of the damage went from 0/45 to 44/45; damage taken went from 1,093 HP to 9 HP over those 45 fights (two rounds on a test machine). Skeleton fights unchanged (24/24 vs 22/24, then 15/15 vs 15/15).
