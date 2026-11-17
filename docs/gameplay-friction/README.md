# Gameplay friction

Every gameplay brief ends with a friction entry. Set `ARENA_PRIVATE_INPUTS` to the private archive root and write `$ARENA_PRIVATE_INPUTS/docs/gameplay-friction/<pr>-<slug>.md`, one file per pull request. Never edit another pull request's entry. Store per-run evidence under `$ARENA_PRIVATE_INPUTS/docs/verification/<pr>-<slug>/`. This directory keeps only the format instructions.

An entry is a heading with lane, date, commit and result link, then these three lines:

```text
Longest: phase, minutes, VM starts and tokens; link evidence.
Untrusted: result/count that needed checking; link the artifact.
Guessed: missing/misleading instruction, example or state; name the path.
```
