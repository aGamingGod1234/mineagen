# PR #55: Tell the bot the true cost of caves, wake it for needed ore, and stop rejecting harmless slips


## Waking the bot when it walks past what it needs

- **Problem:** while the bot dug or walked, it was not woken when the ore it needed or a cave came into view, so it dug on past them.
- **Solution:** a running dig or walk now wakes it once for the needed ore or a roomy cave close by.
- **Result:** the first version would have woken 134 of 698 recorded steps, a median 2 s in, because caves flicker into view while the body turns. A 5 s grace, a 16-block cave reach and a 2-minute cooldown brought that to 35 steps (about 6 per game), a median 25 s in. Measured by replaying 6 recorded games.

## Telling the truth about caves did not change the first move

- **Problem:** the cost line said caves were 47 times slower than digging for lava. That figure came from our own bot, which rarely went into caves.
- **Solution:** caves are priced in the same minutes as digging, and every listed cave or ore comes with a ready next step.
- **Result:** on 64 recorded moments asked 4 times per build, good choices were 70.8% before and 68.7% after, which is no change. This is the second time a wake-text change alone has not moved the model's first move; what it does with that move needs a live round. Measured on recorded moments, not live games.

