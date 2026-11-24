# #219 Hold an enderman pour and scoop it back, and step clear of a dragon lifting off its perch

- **Problem:** In the dragon fight, the bot poured its only water bucket against an angry enderman and walked away from the water, so the next enderman, and the next caged crystal (whose climb down needs water), found an empty bucket.
- **Solution:** The reflex now stands in its own water while an angry enderman is near and scoops it back once it is safe, as a player does.
- **Result:** Caged crystals broken in the dragon room: 2 of 30 before, 23 of 30 after (measured on the final code, 15 runs a side in one batch, p = 2e-8). Deaths: 10 of 15 before, 8 of 15 after. The first dragon kill in this room: 1 of 15, from 0. An earlier batch gave 7 of 30 against 16 of 30 (p = 0.016).
