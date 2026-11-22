# PR #90: Barter gold for ender pearls as one job

## Gold that piglins guard

- **Problem:** Breaking gold near piglins turns them on you even in gold armour, and vanilla counts a box 16 blocks out on each axis, not a 16-block circle. The bot mined gold with piglins around and was killed.
- **Solution:** The bot treats nearby gold as guarded. It won't break it while any piglin is inside that box, seen or heard, and stops mid-swing if one walks in.
- **Result:** In a practice room with a calm piglin 17 blocks away but inside the box, main angered it in 10 of 10 games and this branch in 0 of 10. Measured, 10 repeats each.

## A barter call that stopped for more gold

- **Problem:** The bot's barter call only threw ingots and needed gold armour already on, so it kept handing back to the AI to craft gold blocks into ingots or put on a helmet.
- **Solution:** The barter call now does the whole job: it puts on carried gold armour, crafts gold blocks and nuggets into ingots as it goes, and leaves junk returns on the ground.
- **Result:** With bastion gold (20 gold blocks), "out of gold" hand-backs fell from 66 to 27 per 10 games and barter calls from 8.4 to 4.9 per game, with 10% more gold traded (174 against 158 ingots per 10 game minutes). Measured, 10 repeats each, same loot seeds on both builds.

## Honest barter time

- **Problem:** The AI was told bartering takes 6 seconds per ingot divided by every piglin in view, about 50 ingots a minute with five piglins.
- **Solution:** The estimate now uses the measured speed.
- **Result:** Measured 19 ingots a minute with 5 piglins (3,329 ingots over 20 practice-room runs), about 2.6 times slower than the old promise.
