# #203 Dig up through the block over the head when climbing back up from deep underground

- **Problem:** Climbing back up from deep underground, the bot stopped dead under its own route, refusing to dig one block: 67 such stops in 40 runs of four deep rooms.
- **Solution:** Travel now mines the block over its head when it is its own route's step and nothing seen could pour or fall in, then pillars on.
- **Result:** Reached the surface in 19 of 20 runs against 0 of 20 (measured, two deep rooms, 10 runs a side); water found in time 7 of 40 against 1 of 40 (measured, four deep rooms).
