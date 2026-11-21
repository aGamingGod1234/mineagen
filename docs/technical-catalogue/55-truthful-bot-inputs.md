# PR #55: Tell the bot the true cost of caves, wake it for needed ore, and stop rejecting harmless slips


## The bot lost one call in eleven to typos

- **Problem:** about one call in eleven came back rejected for small slips, such as a `background` flag on a step that runs in the background anyway, a reason one word too long, or `lava` written without `minecraft:`. Each rejection cost a whole model turn.
- **Solution:** the argument checker now repairs slips whose meaning is unambiguous, and reports what it changed. Anything that changes where the body goes or what it uses is still rejected.
- **Result:** replaying the 926 recorded calls from 8 games, rejections fell from 83 (9.0%) to 21 (2.3%). Measured by exact replay, with no model calls.

## Waking the bot when it walks past what it needs

- **Problem:** while the bot dug or walked, it was not woken when the ore it needed or a cave came into view, so it dug on past them.
- **Solution:** a running dig or walk now wakes it once for the needed ore or a roomy cave close by.
- **Result:** the first version would have woken 134 of 698 recorded steps, a median 2 s in, because caves flicker into view while the body turns. A 5 s grace, a 16-block cave reach and a 2-minute cooldown brought that to 35 steps (about 6 per game), a median 25 s in. Measured by replaying 6 recorded games.

## Telling the truth about caves did not change the first move

- **Problem:** the cost line said caves were 47 times slower than digging for lava. That figure came from our own bot, which rarely went into caves.
- **Solution:** caves are priced in the same minutes as digging, and every listed cave or ore comes with a ready next step.
- **Result:** on 64 recorded moments asked 4 times per build, good choices were 70.8% before and 68.7% after, which is no change. This is the second time a wake-text change alone has not moved the model's first move; what it does with that move needs a live round. Measured on recorded moments, not live games.

