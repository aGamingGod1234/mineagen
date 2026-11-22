# #157 Keep running from a fusing creeper when the model sends a command

- **Problem:** when a creeper started to hiss, the bot's reflex sprinted away, but if the AI player sent any command during that second and a half, the reflex let go and the bot stopped inside the blast.
- **Solution:** a fusing creeper is now one of the hazards the reflexes never hand over mid-escape (like lava or suffocation): the AI's command waits until the run has carried the bot out of blast range, then starts.
- **Result (measured, practice room on a test machine: creeper 2 blocks away, an AI command 0.3 s into the run, 10 runs per side):** runs with no blast damage went from 1/10 to 10/10; average damage per run from 12.9 HP to 0 HP (the bot got far enough that the fuse went out). A walled-in creeper room, with no command, was unchanged (blasts 6/23 vs 7/23).
