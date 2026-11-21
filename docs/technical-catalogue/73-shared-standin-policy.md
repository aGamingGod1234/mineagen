# #73 Answer the common forks in practice rooms the way the model is told to (one shared stand-in)

- **Problem:** practice rooms have no AI, so a script plays the AI's part. It only asked again, and rooms failed at forks a real model would answer: a mob in the way, a search blocked by water or rock, a worn pickaxe, hunger.
- **Solution:** one shared, deterministic stand-in that answers those forks the way the in-game model is told to, records every choice in the room's result, and can be switched off so old and new play side by side on the same machine.
- **Result:** rooms that failed at an answerable fork went from 133 to 97 of 610 runs (measured: 61 rooms x 10 repeats, old and new paired on one machine, p = 0.0007). The pass rate went from 44% to 45%, no measurable change. Runs with a death went from 42 to 53, not significant (p = 0.25). The fortress search rooms ended at a blocked search 36 of 40 times before and 17 of 40 after.
