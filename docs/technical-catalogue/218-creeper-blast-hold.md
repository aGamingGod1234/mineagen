# #218 Let a lit creeper blow from just past its blast, keep the dodge off the platform rim, and stay walled in under a shooter

- **Problem:** a bot ran from a lit creeper, but a creeper's fuse only burns while its target stays within 7 blocks. The bot ran 8, so the fuse went out, the creeper followed, lit again, and the trip stopped again: up to 62 stops in one run.
- **Solution:** run just far enough. The bot stops 6.15-7 blocks away, outside the 6-block blast and inside the 7-block fuse range, and lets the creeper blow itself up.
- **Result:** on the iron-from-spawn practice room, measured from room logs over 20 runs a side against main, creepers killed by their own blast went from 16 to 35, and fuses that ran out (a creeper that would come back) went from 95 to 1. Creeper stops on the trip went from 40 to 9 in the next 10 runs a side.
