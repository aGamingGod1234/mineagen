# #195 Cast a portal beside lava the bot hears but cannot see, and keep track of lava it pours out of sight

## The bot picked a portal site its own digging would refuse

- **Problem:** The bot found a lava pool from a tunnel, then dug out a spot beside it for the portal. Lava it could hear but not see sat right behind that rock. Its digging refuses to break a block with lava heard behind it, so the first break was refused, the next site sat beside the same hidden lava, and the build gave up every time.
- **Solution:** The site chooser now applies the digging's own rule: a site is skipped when any block it would break has lava heard just behind it.
- **Result:** On its own this moved the failure one step later: the bot carved a good site and started casting (measured, practice room `lava-gate-7`, 2 runs). Together with the next entry, see below.

## The bot forgot lava it had just poured

- **Problem:** One corner of the portal frame cannot be seen from where the bot stands to pour. The lava landed, but the bot's memory of that cell still said "air", so it thought the pour missed, fetched more lava and poured again into its own lava, until it ran out of empty buckets.
- **Solution:** The bot now remembers lava it poured into a frame cell until it sees the cell again, takes the lava back, or the water lands on it and turns it to obsidian.
- **Result:** `lava-gate-7` (find lava, cast and light a portal, enter the Nether): 0 of 10 lit on main, 10 of 10 with both fixes, measured twice on cloud machines with main side by side (two batches of 10 runs each way). A per-tick trace of one run found the second fault.
