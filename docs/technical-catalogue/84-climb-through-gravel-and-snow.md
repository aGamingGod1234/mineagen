# #84 Climb out through falling gravel and snowy steps

- **Problem:** Climbing out of a cave, the bot quit the moment gravel fell into its stair, and again when a snow layer sat where its last step had to go.
- **Solution:** It steps back, lets the gravel land and digs through it, and knocks snow off a step before placing a block there, as a player does.
- **Result:** The gravel-and-snow climb went from 0/10 to 10/10 (measured, 10 boat runs a side).
