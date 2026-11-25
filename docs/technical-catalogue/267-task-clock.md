# #267 Tell the bot to change approach after 20 minutes stuck on one task across deaths

- **Problem:** The bot could spend hours on one failing task, such as finding a lava pool for the portal, because every death and every plan rewrite reset its sense of how long it had been stuck. In one measured game it reached the deep lava layers at 6 different spots across 5 lives and never lit a portal.
- **Solution:** A task clock that follows the task itself, not the plan step or the life, and counts only minutes with no real progress. After 20 minutes, or two deaths on the task, it tells the bot where it already tried and names a way that can still work.
- **Result:** Replayed over 8 measured full games (model-free), the clock fires 23 times, and the bot stayed on those tasks another 1,037 minutes in all. That is a ceiling on the time the switch could save, not time saved. The live check (main against this branch from the same save points) is still to come.

# #267 Offer the bed by the portal on every return

- **Problem:** A bed by the Nether portal makes every later death respawn next to the portal, but the option was never shown in 8 measured games. The bed advice hid itself whenever a lit portal was in view, which is exactly when the option was meant to appear.
- **Solution:** The bed is offered at the portal and on every return after a Nether visit until a respawn by the portal is set. With no bed or wool at hand, the bot looks for sheep for at most 3 minutes.
- **Result:** Option shown 0 times in 8 games before the change (measured from the game records). In tests it now appears at every portal return.
