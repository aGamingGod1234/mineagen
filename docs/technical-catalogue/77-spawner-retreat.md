# Keep the bot running until a spawner pack falls behind

## The pack catches the bot after a retreat

**Problem**

The bot ran until it was far from where the attack started. The closest zombie could still catch it, and a second retreat could send it back toward the same spawner.

**Solution**

The bot remembers the spawner across reflex firings, looks for an exit over ground it has already walked, and checks the distance to live pursuers before stopping. It keeps running when a pursuer is close enough to interrupt cover or eating.

**Result**

In ten Portal runs with the same seed, deaths went from eight to four and Nether entries from one to three. Measured with the earlier combined baseline on Linux and this candidate on Windows. In paired cave rooms on Windows, damage fell from 42 to 27 HP with zero deaths in either arm.

## The bot turns its back on arrows while escaping

**Problem**

Turning to walk to cover exposed the bot to arrows while a shield was equipped.

**Solution**

When the bot knows a path to cover, it walks that path with the shield facing the shooter while still exposed.

**Result**

In ten valid trials per arm on Windows, damage fell from 38 to 1 HP and passes went from eight to ten.

## The shield froze the walk to cover

**Problem**

With an archer ahead and the only cover behind, the shield kept the bot's view on the archer. The walk waited to turn toward its path before pressing forward, so the bot stood still in the open behind its shield.

**Solution**

The walk now steers by the path, and the shield converts those keys into its own view, so the bot backs into cover while still facing the archer.

**Result**

Measured in a practice room with the escape step alone, ten runs per arm and then five more: the bot reached cover 0 of 15 times before and 15 of 15 after, with no damage in either arm.

## A second lit creeper just out of sense range

**Problem**

The default creeper sense hands over a lit creeper only within 5 blocks. When the first creeper died, the retreat ended at once even with a second fuse burning 5.5 blocks away.

**Solution**

When the tracked creeper dies or goes quiet, the retreat takes over any other lit creeper within 7 blocks, the range at which vanilla keeps a fuse burning.

**Result**

Measured in a practice room over 15 runs per arm: the bot ended 5 blocks from the second fuse in every run before (0 of 15 passes) and about 13.5 blocks away after (15 of 15).
