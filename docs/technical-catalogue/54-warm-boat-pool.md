# #54 Keep boat batch machines running and reuse them instead of starting new ones

### Warm machine pool

- **Problem:** Every batch of practice rooms started fresh cloud machines and deleted them when it finished. The cloud provider limits how many machines can be started per minute, hour and day, so parallel test threads ran out of starts while most of the paid compute sat unused. A batch also held every room until its slowest machine was ready.
- **Solution:** A warm pool. Batches lease machines that are already running, clean them between batches (kill leftover game servers, wipe the old batch's files, keep the image), and give them back running; no batch ever deletes one. Lock files with heartbeats keep two batches off one machine. New machines are started only for a shortfall, paced under the limits, and each machine starts its rooms the moment it is ready.
- **Result:** Measured on six back-to-back one-room batches on one machine: 1 machine start in all, against 6 before (one per batch per machine), and 0 machines deleted. An 18-machine batch reused 10 running machines with no start and started 8. A warm machine went from lease to a playing room in about 7 s. Estimated: a pool of N machines serves any number of batches for N starts while it is kept warm.

### First room on a new machine

- **Problem:** The first room on a brand-new cloud machine failed most of the time with confusing connection errors, while every later room on the same machine passed.
- **Solution:** The provider makes a new machine usable before its disk image has fully downloaded, so the first game server ran on a disk still filling up. New machines now wait until the provider reports the image complete (12 to 25 s) before their first room.
- **Result:** Measured from batch logs and the provider's download-complete times. First rooms started before the image was complete: 7 of 8 INVALID. Rooms started after it: 10 of 10 passed. With the wait, all 8 new machines' first rooms passed in an 18-machine batch (36 of 36 rooms passed).
