# PR #105: Mine an ore under the bot's feet by stepping aside instead of writing it off as unreachable

**The bot walked away from iron it was standing on**

- **Problem:** the vein miner refuses to break the block under the bot's feet, a safety rule, and the bot read that refusal as "this ore is unreachable" and remembered it for the rest of the game. It tunnelled away from iron it was standing on and later walked past the same ore.
- **Solution:** it steps one block aside onto ground it can see and mines the ore from there; a refusal tied to where it stands no longer writes the ore off.
- **Result:** on a practice room built from the playtest spot, the ore was mined 0 of 10 times before and 10 of 10 after (measured, 10 runs per side on cloud machines). On 48 iron-obtain runs there was no regression: 30 passes before, 32 after; deaths 5 to 3.
