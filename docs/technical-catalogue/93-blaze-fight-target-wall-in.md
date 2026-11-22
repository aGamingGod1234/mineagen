# PR #93: Fight a blaze at a fortress spawner with fight_target and wall in on the spot to heal

## A one-blaze fight that always ended in fire

- **Problem:** Asked to fight one blaze at a spawner, the bot traded hits in the open until fire and fireballs killed it: 28 deaths in 30 practice runs on main.
- **Solution:** It bricks itself in on the spot (walls, roof, a doorway toward the spawner) while it still has the health to survive building the wall, judged from how fast it is being hit and how long it will keep burning, then eats, heals, opens up and fights on. It remembers a spawner it saw even after its own cover hides it.
- **Result:** Measured in practice rooms, 10 runs per arm against main with #89: alive in 18 of 30 blaze-spawner runs instead of 2 of 30, with a kill and a rod kept in 10 of 30 instead of 2 of 30 (p 0.021). With the real fortress room, 18 of 40 instead of 7 of 40 (p 0.015).
