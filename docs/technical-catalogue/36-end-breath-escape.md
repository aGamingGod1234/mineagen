# PR #36: Arm a breath escape automatically on entering the End and hold it against the model's commands

## Dragon breath in the End

- **Problem:** dragon breath killed 5 of 6 staged End deaths. Three bodies had no breath rule; in the other two, the model's own commands walked the agent back into the cloud.
- **Solution:** entering the End now arms a breath escape automatically, and the body holds it against the model: a command waits, standing still between runs, until the escape ends outside the cloud.
- **Result (measured, provider-free breath room, real dragon fireball on the body):** the final code survived every room where the breath reached it, with 0 void falls (38 of 38 across three runs with the fixture's own verdicts; 6 HP lost in one room, 0 in the rest); old code survived 10 of 11 with 18-30 HP lost in every room. A model-installed rule on old code also survived 13 of 13, so the measured gain in this room is protection without a model call; while the hold was built, single smoke runs went from 6-12 HP of command-driven re-entry to none.

