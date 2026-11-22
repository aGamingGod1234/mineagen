# PR #106: Keep the bot's step through a single-player pause instead of dropping its link

- **Problem:** opening the pause menu for more than about 15 seconds made the bot "disconnect" and lose what it was doing, because the game's paused main loop was also the one answering the coordinator's "are you still there?" checks.
- **Solution:** a paused or stalled game is answered from the network thread, with how long ago the game last ticked and whether it is paused. A real pause freezes the coordinator's deadlines; a hung game still drops as before.
- **Result:** playtest before: a 13 s pause cancelled the bot's running step and forced a 39 s reconnect. After: a pause of any length keeps the link and the step in the automated tests (measured); a live client check is still to do.
