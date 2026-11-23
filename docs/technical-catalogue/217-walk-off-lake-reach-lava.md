# #217 Walk off the lake before digging for lava, and reach lava behind rock when casting a portal

## Digging down beside the lake it just used

- **Problem:** to build a Nether portal the bot fills a water bucket at a lake, then digs straight down from that shore to look for lava. The rock under a lake shore holds the lake's own underground water, so the first dig floods and the search runs out of time. In the kit-gate practice rooms, 55 of 79 first digs met water, and only 3 of those 55 runs lit a portal.
- **Solution:** before its first dig down, a lava search that starts under open sky with water in sight walks away from the water. It looks again after each walk, never walks back toward the water, and gets those directions back once it is digging.
- **Result:** first digs that flooded fell from 79 to 51 of 240 gate runs, and kit gates found lava in 40 of 80 runs instead of 27. Measured over 10 runs per room on each side (one-sided Fisher p 0.003 and 0.03). Lava searches that failed fell from 109 to 91 of 240 in the later three-way round.

## Lava a few blocks away, behind rock

- **Problem:** while casting, the bot knew a lava source a few blocks away and a little below, but every way to it ran through rock. It walked back and forth toward spots it could not reach, then gave up with lava in view. kit-gate-5 failed this way in 6 of 6 casts.
- **Solution:** the fetch now mines the single block hiding a source in reach. When none is in reach, it digs a two-high passage toward known lava up to 10 blocks across. Each break goes through the dig's own lava rules, and when lava is heard at its level the passage goes one block higher, so lava cannot flow in. It never opens or steps into a cell next to known water or lava.
- **Result:** kit-gate-5 lit 0 of 10 runs on main and 5 of 10 with the change. Kit gates overall lit 19 of 80 instead of 12, and all 24 gate rooms lit 61 of 240 instead of 49. Measured in the same batch, 10 runs per room. The pooled gain across gate and guard rooms is significant (p 0.024); the gate rooms alone are not yet (p 0.12).
