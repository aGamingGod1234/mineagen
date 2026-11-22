# #135 Fail a helper's unit test when it sends a move the game refuses

- **Problem:** the bot's helpers (find, obtain, kit habit, loot, eyes) were unit-tested against pretend bodies that obeyed any order. So an order the real game rejects, such as "stop within half a block" when the minimum is one block, passed every test and failed only in a live game, where nothing logged it. That happened twice in one day.
- **Solution:** one shared pretend body checks each order against the same rulebook the game uses before obeying it. A lint test makes every helper test use it.
- **Result (measured, unit tests):** with a bad order planted in find and in obtain, the old tests caught nothing (0 failing) and the new ones caught both (6 failing tests). The sweep found 19 bad orders hidden in test fixtures and none in the bot's own code.
