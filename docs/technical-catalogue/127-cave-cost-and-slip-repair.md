# #127 Price a seen cave against digging for lava and stop rejecting harmless tool-call slips

### The bot lost one call in eleven to typos

- **Problem:** about one call in eleven came back rejected for small slips, such as a `background` flag on a step that runs in the background anyway, a reason one word too long, or `lava` written without `minecraft:`. Each rejection cost a whole model turn.
- **Solution:** the argument checker repairs slips whose meaning is unambiguous and reports what it changed. Anything that changes where the body goes or what it uses is still rejected.
- **Result:** replaying the 926 recorded calls from 8 games, rejections fell from 83 (9.0%) to 21 (2.3%). Measured by exact replay, with no model calls.

### Caves were priced 47 times dearer than digging for lava

- **Problem:** the bot was told a cave search for lava costs about 1780 minutes and digging down about 40, a figure measured on our own bot, which rarely went into caves.
- **Solution:** the self-measured figure is gone; a seen cave is priced as a walk in plus the descent from its floor, in the same minutes as digging, with a ready next step.
- **Result:** the 47-to-1 ranking is gone from the cost line, the planner prompt and the strategy guide. The effect on play (blocks dug per lava found) needs a live round after the model allowance resets.
