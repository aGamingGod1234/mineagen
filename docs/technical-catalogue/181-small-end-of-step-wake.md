# PR #181: Keep a long search's end-of-step wake small: missed updates no longer each carry a copy of the world

- **Problem:** after a long search, the bot's planner got one wake of up to 1.2 MB. Every update it had missed during the search came with its own full copy of the world.
- **Solution:** missed updates now keep only what happened (health, threats, failures, results). The world is sent once, as it is now.
- **Result:** a rebuilt 86-update case goes from 311 KB to 27 KB (74 KB to 7.2 KB encoded), about 90% smaller, measured offline through the production builder. Ordinary wakes are byte-identical (684 replayed). The live end-of-search wake was 1,045,854 B and 334,452 input tokens before; the live after is not yet measured.
