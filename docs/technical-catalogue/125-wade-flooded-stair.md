# #125 Climb out of a flooded stair by wading up its steps instead of floating at the bottom

- **Problem:** When the bot's stair down broke into underground water, it floated at the bottom of a flooded stair for minutes. Its escape only looked for dry ground nearby, and on a stair flooded all the way up the dry ground was out of range.
- **Solution:** Escape now wades up flooded steps the way a player does. It climbs onto the next step whose floor it can reach from the water, one at a time, until dry ground is in reach.
- **Result:** In a staged 15-step flooded stair the bot got out 0 of 10 times before and 10 of 10 after, in a median 46 s (measured, 10 repeats a side on boat machines). Ordinary water rooms were unchanged.
