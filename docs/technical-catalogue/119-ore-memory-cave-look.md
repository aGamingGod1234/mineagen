# PR #119: Go back to iron the bot has already seen, look into caves its dig passes, and walk back up its own route

**The bot strip-mined for iron it had already walked past**

- **Problem:** the bot forgot ore once it was out of view and never looked into the caves its stairs cut through, so it dug long tunnels for iron it had already passed.
- **Solution:** it remembers every ore it has seen and prices the walk back against a fresh search with the planner's own numbers. Its dig turns once to look into each cave it breaks into, and takes iron in a clear line of sight.
- **Result:** on the playtest's own cave case it took the iron 5 of 5 times in about 43 s against 0 of 5 on main (about 115 s). Having seen iron and lost sight of it, it went back and mined it 10 of 10 times with no new search (measured, 5 and 10 runs on cloud machines).
