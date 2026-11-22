# #149 Tell the bot how a player plays the route on every call, and move program rules to an on-demand topic

### Teaching the bot to play like a player, for fewer bytes

- **Problem:** every call loaded 22.8 KB of instructions. A third of the skill file taught a scripting feature used in 3 of 176 games. The player's route method was only in a guide the bot opens on demand.
- **Solution:** the scripting rules move to an on-demand topic, and a short "how a player plays the route" section joins the always-loaded role file.
- **Result:** always-loaded instructions 22,798 to 19,254 bytes (measured). A replay of recorded token counts from 17 games gives about 0.8% fewer input tokens per call, and 2.5% together with the tool-list cut in #145 (simulated). Any change in play is not measured yet.
