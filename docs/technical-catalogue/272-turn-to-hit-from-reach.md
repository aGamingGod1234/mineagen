# Turn at once to a mob hitting from sword reach, in every fight (#272)

- **Problem:** fighting one mob while a second hit it from behind, the bot ignored the one hurting it until a half-second scoring check with a 1.5 s wait, and only if the model had asked for that check.
- **Solution:** the fight reacts to damage itself: a hit from a mob inside sword reach turns the fight to that mob on the same tick, unless the current target is in reach and still hitting. Creepers, players and mobs out of reach never pull the fight.
- **Result:** measured in practice rooms, 54 two-attacker fights a side, same build both sides: damage from the mob behind 7.28 to 4.78 per fight, deaths 4 to 0; skeleton ahead with a zombie behind, deaths 3 of 9 to 0 of 9.
