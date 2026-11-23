# #201 Roof the wall-in against a skeleton so it cannot shoot down into the cell

- **Problem:** Walled in against a skeleton, the bot built four walls but no roof. A skeleton that stepped onto a 1-block rise shot straight down into the cell. The roof was decided once, from where the skeleton stood when building began. Even when the bot decided to build it, it could not: from inside a 2-high hole no surface touches the roof cell.
- **Solution:** The wall-in always roofs against a living shooter. When nothing touches the roof cell, the bot jumps to place a block on the wall top, then roofs against it.
- **Result:** Survival in the shallow-water skeleton room went from 16/30 to 28/30 (measured, same batch, p = 0.0009). Runs fully closed and roofed: 0 of 30 on main, 25 of 30 with the fix, and none of those 25 died. Ten guard rooms were unchanged (50/50 both arms).
