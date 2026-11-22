# Fight a mob that blocks the climb out of a hole (#111)

## Shot in a hole by a skeleton it never hit back

**Problem**

In a playtest the bot landed at 7 health in a hole with a skeleton beside it. The escape step saw the skeleton as something in the way of its climb and kept retrying the climb, while the fighting reflex stood aside for the command. The bot was shot without hitting back.

**Solution**

A mob that blocks the climb is now fought where the bot stands, with the same stand a cornered flee uses, and then the climb goes on.

**Result**

In the playtest's moment rebuilt as a room, deaths fell from 14 of 30 to 4 of 30 over two rounds (Fisher p = 0.010; measured, paired runs per arm at two model speeds).
