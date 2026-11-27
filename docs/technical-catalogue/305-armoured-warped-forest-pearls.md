# #305 Hunt ender pearls in a warped forest only when wearing armour

- **Problem:** The bot needs about 15 ender pearls, and warped forests are full of endermen, but when it stood in one it still headed off to find a fortress. Telling it to hunt there first worked, but it went in with a stone sword and no armour, and the endermen killed it.
- **Solution:** The bot's "usual next step" now says to hunt endermen in the forest it is standing in, but only when it is healthy, fed, armed, and wearing iron or better armour (a chestplate or two pieces). Otherwise the advice stays "find a fortress".
- **Result:** With the hunt advice but no armour check, deaths went from 2 to 12 over 8 matched game pairs (measured, 28-minute real-model games). With the armour check and an iron chestplate on: pearls held at the end 5 vs 1, deaths 1 vs 3 over 4 pairs (measured, 25-minute games). Without armour, the advice never fired in 2 of 2 games. Small samples: direction, not a proven rate.
