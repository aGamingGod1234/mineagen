# #58 Name every death's cause: record what killed the bot and count deaths by cause

- **Problem:** one death in six in the full-game scoreboard had no cause, so the biggest killers could not be ranked. Some were named causes the summary did not list; the rest were deaths the round scorer dropped because the goal's revision number moves during a game.
- **Solution:** the server now records the damage type, the killer, hunger, armour and the bot's last 10 s at every death, and the scorers name a cause from that evidence and read every death receipt whatever the revision.
- **Result:** unknown deaths 14 of 78 before, 0 of 78 after in rounds 2 to 6; in the two later rounds, 14 of 51 before and 0 of 51 after. Measured by rescoring the saved round records with the new scorer.
