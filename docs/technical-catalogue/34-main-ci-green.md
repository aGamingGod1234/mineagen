# PR #34: Fix the failures that keep main's CI red on Linux and Windows

## Shutdown that said "stopped" too early

- **Problem:** the coordinator said it had stopped while a background cleanup was still writing to disk.
- **Solution:** shutdown now waits for every cleanup already started, not just the ones it can still find.
- **Result:** late disk writes after stop went from 4 to 0 in a slowed-disk test (measured); this removes the cause of a Linux CI flake.

## Voice requests reset by an idle-connection race

- **Problem:** voice requests could fail with "connection reset" when sent about 5 s after the previous one, because the server dropped idle connections before the game's HTTP client did.
- **Solution:** the voice server now keeps idle connections longer (65 s, configured) than the client (30 s, measured), so the client always closes first.
- **Result:** an idle connection the server dropped at about 6 s now stays open (measured with a probe). The reset was seen once on Windows CI and did not reproduce on Linux.
