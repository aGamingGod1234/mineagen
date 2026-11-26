# #292 Rest first after a night respawn, rest on mud and sand, and shield a cornered creeper

- **Problem:** A bot that died at night came back with nothing and walked straight back into the mobs that had killed it, ignoring the advice to rest first.
- **Solution:** The first errand after a night respawn now digs in and waits for morning first; the model's command then runs at dawn.
- **Result:** Before, measured on 8 fresh games: 5 of 42 deaths followed a night respawn that went straight back out. After: the habit never fired in the checkpoint A/B, because no game died at night (6 save points, 18 minutes each). Its proof is decision tests so far.

- **Problem:** Cornered in a 1-wide tunnel by a lit creeper, the bot did nothing and took the full blast.
- **Solution:** With nowhere to run it raises its shield toward the creeper, or hits it to knock it back.
- **Result:** Measured in the dead-end room: with a shield, deaths 3 of 3 to 0 of 3 and blast damage 19.3 to 0 (3 runs each).

- **Problem:** Dug into a swamp, the bot could never close its hole for the night: mud sits 2 pixels short of a full block.
- **Solution:** The shelter treats mud as a wall, roof and floor, and counts a body standing on mud as inside its hole.
- **Result:** Measured in the mud rest room: rested 0 of 3 before, 3 of 3 after, 0 damage.
