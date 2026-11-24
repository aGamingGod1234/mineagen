# #250 Swing at the blaze touching the bot, and keep fighting when cornered at low health

- **Problem:** A blaze stood touching the bot and burned through its health while the bot waited for a different blaze, one that stood behind a wall and could not be hit.
- **Solution:** "Close enough to hit" now means close enough and with a clear line to the hitbox. The bot turns to the blaze it can actually hit, and keeps swinging when it is cornered rather than freezing.
- **Result:** In the decision test the touching blaze went from no swing in 1 s to a swing within 1 s (measured, fixture). In spawner rooms deaths went from 29 to 19 of 150 over two batches (measured, same-batch A/B; p 0.078, not clear), with rooms passed level at 106 against 107 of 150.
