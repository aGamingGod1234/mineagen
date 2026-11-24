# #230 Turn to face a one-wide step before jumping into it

## Jumping into a one-wide step

- **Problem:** climbing out of a deep cave, the bot sometimes walked into a one-block step for about 8 seconds without jumping. Its jump into a narrow gap waits until it faces the gap, but near the end of a walk it kept its old view, so the jump never came.
- **Solution:** at a one-wide step it now turns to face the gap, and jumps as soon as it lines up.
- **Result:** in room 3 the bot reached the surface 16 s sooner in every run that got there, and found water 9/10 times instead of 1/10. Across six deep water rooms it found water 51/60 vs 38/60, with 0 deaths vs 5. Measured in one same-batch A/B in practice rooms, 10 runs a side.
