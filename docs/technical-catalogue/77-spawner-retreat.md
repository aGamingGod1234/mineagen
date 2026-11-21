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
