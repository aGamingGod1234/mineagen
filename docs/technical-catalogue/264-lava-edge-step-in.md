# #264 Step in off a lava edge before a melee mob's hit

- **Problem:** In the Nether the bot died in lava after a hoglin or magma cube hit, not from the hit itself. It lowered its shield to fight while standing on the brink, and a landed hit threw it up to 4 blocks, straight into the lava.
- **Solution:** The reflex works out how far this particular mob can throw the body, and walks inland behind the raised shield until it's out of that range. Only then does it fight.
- **Result:** Practice-room hoglin deaths fell from 42 of 59 to 19 of 56 (measured, 3 batches of walled lava-shore rooms with the body at 8 health). In real Nether games, deaths were level: 7 vs 7 over 10 starts a side (measured, 35 min each).
