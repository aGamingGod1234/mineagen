# Flee back up the way the bot came in (#99)

## The bot fought a spawner pack instead of climbing its own stairs

**Problem**

Fleeing picked a direction away from the mobs, not a route. A narrow staircase back up never read as a way out, so at the foot of its own stairs the bot stood and fought the spawner pack.

**Solution**

When no direction leads away, the flee plans a route over the ground the bot has just walked, its own stairs included, avoiding cells where mobs stand, and walks it before standing its ground.

**Result**

On Portal's spawner room, runs with a death fell from 9 of 10 to 3 of 10, and total damage from 261 to 156 HP (measured, 10 paired runs per arm).
