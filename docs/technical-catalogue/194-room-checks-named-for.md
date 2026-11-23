# #194: Make 19 practice rooms check what they are named for

## Practice rooms that passed without the thing they test
- **Problem:** Many practice rooms were judged only on "the bot is still alive". A rest room passed when the bot gave up and stood in the open at night with no bed. The caged End crystal room could not fail at all. Two fight rooms kept passing after a new dodge stopped the bot from walling in, so the creeper and the command they exist to test never arrived.
- **Solution:** Each room now requires its own mechanic: the bed sets the spawn, the night is waited out, the fire goes out, the fluid is plugged, the count asked for is held. A run where the mechanic never started counts as no evidence, not a pass. Rooms that only repeated another room or passed when the bot got hurt were dropped.
- **Result (measured, stored runs rescored through the scorer, 10 runs a side):**
  - Rest with wool: 10/10 -> 7/10 and 6/10.
  - Rest with cobblestone: 10/10 -> 8/10 and 9/10.
  - Caged crystal: 10/10 -> 8/10.
  - On current main (Boat, 10 runs): the two fight rooms reached their creeper or command in only 2 and 3 of 10 runs, while scoring 10/10.
  - A pillar room went 2/10 -> 10/10 once every machine built the same world column.
