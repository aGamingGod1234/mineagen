# #221 Make CI faster and stop the required check failing on Maven Central rate limits

## A test program that waited a minute for nothing

- **Problem:** The Java core check printed its last result and then sat idle for exactly 60 seconds before it exited, in every CI job that ran it. A thread dump showed Minecraft's own file-worker thread pool keeping the program alive: an idle worker waits a minute for new work before it ends.
- **Solution:** When the checks finish, the test program now shuts Minecraft's worker pools down, the same way a real server does when it stops.
- **Result:** The check took 1 min 36 s before and 37 s after on a local run (measured). In CI the gap between the last result and the next task fell from 60 s to under 1 s in all three Minecraft builds (measured from job logs).

## The required check failed on a download, not a bug

- **Problem:** Every CI run (an estimated 500 a day, counted from the run list on two busy days) downloaded the same build tools and libraries from Maven Central again. Maven Central rate-limits the shared addresses GitHub's runners use, answered "429 Too Many Requests", and the required check went red on main with no code fault.
- **Solution:** Each build job restores its own saved download cache, which only main writes. Gradle now retries a rate-limited download for up to about a minute instead of 3 seconds.
- **Result:** Pull requests read main's cache instead of downloading everything again (the effect on 429s is estimated; this PR's own runs were cold because pull requests never write the cache).

## One long queue split into parallel lanes

- **Problem:** The required check ran a 3.6-minute test suite and then a 3-minute Java check, one after the other.
- **Solution:** The suite now runs in two halves beside the Java check. A small final job keeps the required check's name and passes only when all of them pass.
- **Result:** The required check went from about 6.6 min (median of recent runs) to 2 min 43 s on this PR (measured, with a cold cache). The Windows suite went from 7.3 min to 4.3 min.
