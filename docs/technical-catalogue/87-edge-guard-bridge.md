# Keep the edge guard from walking the bot off a bridge (#87)

## The edge guard walked the bot off the bridge it was guarding

**Problem**

The guard that keeps a standing bot from sliding off ledges remembers where the bot last stood and walks it back there. After the bot was moved, the guard walked it back to an old spot at the very end of a one-wide bridge and stepped off. It allowed the step because a 22-block drop costs about 19 of 20 health, which it counted as survivable.

**Solution**

The guard forgets its spot when the body jumps more than 2 blocks in one tick (a teleport), and its own walk back stops at any drop that does fall damage.

**Result**

knockback-edge went from 0/10 to 10/10, measured over 10 paired runs per arm on boat. Ten edge-related rooms stayed at 5/5.
