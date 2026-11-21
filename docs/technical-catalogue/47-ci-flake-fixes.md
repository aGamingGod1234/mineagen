# PR #47: Fix the remaining CI flakes

## A process wrapper that would not let go of a dead process

- **Problem:** the wrapper that owns the coordinator's processes sometimes refused to exit after killing everything. For a split second, it saw a process as "still running" after the process was gone.
- **Solution:** a killed process lingers as a zombie until its parent collects it. When the collection landed between two checks, the second check saw nothing, and "nothing" was treated as "still running". The wrapper now asks once more, and a group that still answers is still treated as alive.
- **Result:** measured over repeated runs on a loaded machine: 5 of 208 runs failed before the fix and 0 of 160 after. With a deliberately slow parent, 47 of 120 failed before and 0 of 120 after.

## Tests that timed out on slow disks

- **Problem:** two test files failed every run on cloud machines with slow disks, though each takes about 4 s on a normal one.
- **Solution:** their tests write hundreds to thousands of records, and each write waits for the disk to confirm. Those tests check list limits and paging, not durability, so they now use memory-backed storage.
- **Result:** measured on 2 slow-disk cloud machines, where one confirmed write took about 60 ms against 0.2 ms on a healthy one: the files took 106 to 245 s before (limit 120 s) and 2 to 28 s after. Full-suite runs there went from 10 of 10 failing to all passing.
