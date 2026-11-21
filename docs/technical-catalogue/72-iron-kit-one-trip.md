# PR #72: Plan the iron kit as one trip down: wood first, then all its iron

- **Problem:** the bot fetched its iron kit one item at a time (pickaxe, shield, buckets, flint and steel), each with its own search, and kept climbing back to the surface for a log or food it had not brought down.
- **Solution:** the route plans the whole kit at once with obtain's own planner, carries the wood it needs down first, then gets all of the kit's iron in one trip. The food rules no longer send it up while it still carries food.
- **Result:** in 16 practice games per side from a fresh spawn with nothing, blocks mined fell from 7,335 to 5,247 and climbs back to the surface from 3 to 1. Median minutes to the full kit, for the games that got it, fell from 37.7 to 19.4. Kits got: 8 vs 9 (no change). Measured from the rooms' own records; climbs and deaths are small counts.
