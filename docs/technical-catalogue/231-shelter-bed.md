# #231 Lay the night-shelter bed where the bot can actually sleep in it

## A bed the game would not let the bot sleep in

- **Problem:** The bot crafted a bed, put it down, clicked it, and the game refused to let it sleep. It did this on 3 of 60 nights, and on 2 more it found no flat spot on a slope at all. Its own idea of a good bed spot didn't match the game's rules: it demanded solid ground under both halves, which vanilla doesn't, and it never checked the space over the bed, which vanilla does.
- **Solution:** We read the game's own sleep check (reach of 3 blocks across and 2 up from either half; no suffocating block over either half) and made the bed-spot test match it exactly. A refused click now tries the next face of the bed. On a slope with no spot in reach, the bot digs a two-block notch and plans the bed again.
- **Result:** Measured over 40 nights a side in the same batch (two forest seeds, 20 each): main slept 39 of 40, this change 40 of 40. Main's miss was the slope case, and the fix slept in that same room. An earlier batch on the first half of the change also tied 39 of 40 at 39 of 40, where main lost a night to a lake start (fixed in #225) and the fix lost one to a slope gully (the notch added after it).
