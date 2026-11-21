# #48 Play practice rooms in batches on boat machines

- **Problem:** on cloud test machines, every practice room failed before it began. The game's first save of a new world took 51 seconds, and the test gives up after 30.
  - **Solution:** the cloud disk takes 39 ms to confirm each write to storage, and Minecraft confirms every chunk. Those machines are thrown away, so the rooms now skip the confirmations.
  - **Result:** the first save went from 51 s to under 1 s. Rooms went from 2/2 invalid to 2/2 pass on the same machine (measured). World boot was 14 s on the cloud machine against 77 s on the shared local machine (measured, one room).
- **Problem:** a batch of practice rooms waited hours for memory on one shared machine.
  - **Solution:** a runner rents one cloud machine per room, plays both versions of the room side by side on it, and merges the results.
  - **Result:** 10 rooms x 2 versions took 14 min wall on 10 machines, against about 50 min per version in one local slot plus 1 to 8 hours of waiting (measured; the local figure comes from the earlier run of the same rooms).

