# #50 Play build practice rooms at 3x game speed and cut room batch overhead

- **Problem:** a practice room could not run faster than real time without changing the game it tests, because the test harness and the agent's tool runtime counted their timeouts in wall-clock seconds while the bot's body counts game ticks.
  - **Solution:** one game clock read from the world's tick count, used by the harness for its deadlines and handed to the tool runtime for searches, gathering and waits. It is plain wall time at normal speed.
  - **Result:** build rooms play at 3x (53-67 TPS reached). The same 60 runs a side passed 32 at normal speed and 31 at 3x, with 5 deaths on each side. Play took 280 min against 107. A 664 s search lasted 664 game seconds at both speeds. Measured on boat, same jar, both speeds side by side.
- **Problem:** at 3x speed the damage sampler saw falls as deeper than they were, because its reads cost game ticks and stretched the gap between samples.
  - **Solution:** samples start on a fixed game-tick schedule.
  - **Result:** the worst fall in one room had read 2.8-2.9 blocks at normal speed and up to 3.0 at 3x, against a fail line of 3.0. Measured. The fix has run in one A/B round.
- **Problem:** each cloud machine call costs about 2.7 s before any data moves, and a batch made about ten calls per room.
  - **Solution:** one bundle upload per machine, one exec to start a room, and one call that waits for the end and brings results back.
  - **Result:** about 50 s down to 9 s of overhead per room. Measured on boat machines.

