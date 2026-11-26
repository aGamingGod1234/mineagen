# #277 End: catch a fall off a pillar with the water bucket by default

- **Problem:** a dragon hit throws the bot off the 20-block pillar it builds to reach a crystal, and the fall kills it. The body could already catch a fall with a water bucket, but only once the model wrote that rule itself mid-fight. In 15 End games it did so in 2, late.
- **Solution:** the End arms the water catch by default, the way a player keeps a bucket ready, and a falling-catch rule wins a tie against a same-priority dodge.
- **Result:** in a practice room that throws the bot off a cage-height column, 60 of 60 throws caught against 0 of 60, and deaths 0 against 30 (measured, 10 runs a side, half the throws with the breath dodge running). In 8 End-start game pairs with the real model, climbs that ended in a fall death went from 6 of 21 to 2 of 26 (measured, p ≈ 0.12), with End deaths equal at 12 against 12.
