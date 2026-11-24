# Fill a water bucket from a pool below a cliff edge by digging down beside the drop (#235)

- **Problem:** The bot stood on a cliff with an empty bucket and a pool 5 blocks below, and gave up saying there was no water. Its block sample only reaches 3 blocks up and down, so the pool did not exist for it.
- **Solution:** It now reads the edge drops the game already reports (how far down, and what is at the bottom), and when one ends in water it digs a short staircase down beside the drop and fills from there.
- **Result:** Water bucket filled in room kit-gate-6: 4 of 10 runs before, 10 of 10 after (measured, same-batch A/B on practice rooms). Overall lava reached on the 16 kit and lava gates: 75/160 before, 77/160 after (measured, flat).
