# #230 Turn to face a one-wide step before jumping into it

## Jumping into a one-wide step

- **Problem:** climbing out of a deep cave, the bot sometimes walked into a one-block step for about 8 seconds without jumping. Its jump into a narrow gap waits until it faces the gap, but near the end of a walk it kept its old view, so the jump never came.
- **Solution:** at a one-wide step it now turns to face the gap, and jumps as soon as it lines up.
- **Result:** RESULT
