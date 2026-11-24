# #244 Open a different side when the bot walls in right beside a blaze spawner

- **Problem:** The bot walls itself into a small cell to survive a blaze crowd, then mines a doorway to fight back. Next to the spawner, the doorway it picked was the spawner itself, which can't be broken, so it sat sealed in for the rest of the run, in about a third of spawner runs.
- **Solution:** Beside the spawner, the doorway goes to a side where the bot has seen solid ground and room to step out, and a doorway that turns out to be the spawner is switched and remembered.
- **Result:** Runs sealed in beside the spawner 23/75 → 0/75; spawner rooms passed 82/135 → 97/135 over two batches (measured, same-batch A/B, p = 0.036); guard rooms 54/55 → 55/55.
