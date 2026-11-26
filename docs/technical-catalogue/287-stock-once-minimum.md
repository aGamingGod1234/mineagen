# PR #287: Stock food and wood once on the surface, to a minimum, before going down or through the portal

**The bot walked into the Nether with a few steaks, then spent hours coming back for food**

- **Problem:** the route asked for 8 cooked meat and called food "optional" at a lit portal. Games went into the Nether with little or no food (14 of 20 checked entries) and came back up to hunt (3 of 5 saves), and one game spent its last 154 minutes on food.
- **Solution:** a food minimum worked out from measured damage rates (256 points, about 17 steaks, before the portal). It counts every food and takes every animal in view.
- **Result:** route advice alone was walked past: 0 of 2 bots went in at the minimum (measured, AI practice room).

**Advice the model walked past became a step the body runs**

- **Problem:** with the stock step on screen, the model still walked into the portal with 8 steaks, the way an earlier kit check was walked past 16 of 17 times.
- **Solution:** a walk into a lit portal while the minimum is unmet now runs the stock obtain itself, at most twice per life and 6 minutes each, and it lets go when no animal is left in reach. Three bugs stood between that and working: the turn's time limit was still sized for the walk, so every hunt was cancelled about 20 s in; the "look for animals" form of the step was not recognised; and a hunt that came back short did not let the bot go.
- **Result:** food carried into the Nether in a 25-minute practice room with 8 cows and 4 pigs (measured, on vs off on the same build, cloud machines): on 253, 253, 273 and 273 points against off 79, 126, 126 and 150. Every on bot took the whole herd (the 8 cows gave 16 beef), and 2 of 4 reached the full minimum against 0 of 4. The cost was going in a median 11.5 minutes later; no bot died before going in.
