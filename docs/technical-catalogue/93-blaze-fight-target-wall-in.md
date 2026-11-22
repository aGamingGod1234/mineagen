# PR #93: Fight a blaze at a fortress spawner with fight_target and wall in on the spot to heal

## A one-blaze fight that always ended in fire

- **Problem:** Asked to fight one blaze at a spawner, the bot traded hits in the open until fire and fireballs killed it: 27 deaths in 30 practice runs.
- **Solution:** When hurt, the bot bricks itself in on the spot (walls, roof, a doorway toward the spawner), eats until healed, opens up and fights on. It remembers a spawner it saw even after its own cover hides it.
- **Result:** Measured in practice rooms, 10 runs per arm on the final head: alive at the end in 12 of 30 runs instead of 3 of 30 (27 deaths down to 18). With a blaze killed and a rod kept as well, 8 of 30 instead of 3 of 30, too few runs to call.
