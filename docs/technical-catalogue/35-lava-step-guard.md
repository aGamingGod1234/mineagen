# PR #35: Stop the agent walking or jumping into lava at its own level

## Lava at its own level


- **Problem:** The agent walked straight into lava at its own level, a flow across the floor or a pool level with its path. Lava kills in about 2 s, and 6 of 10 lava deaths in the audit had no mob nearby.
- **Solution:** A guard on every movement key plays vanilla's ground physics forward (one more tick of the keys, then coasting to a stop) and stops the keys when that path would touch lava. It does the same for a jump's landing. Walks then plug the lava with a block, when allowed, or go round it, and routes avoid cells lava is about to fill.
- **Result:** measured in one live test room, run 3 times per arm, where only the mod differs.

| | Deaths | Damage per run |
|---|---|---|
| Before | 3 / 3 | 27 |
| After | 0 / 3 | 0 |

