# #120 Stop an over-long reflex note from dropping the coordinator's connection and stranding the game

- **Problem:** Partway through a game, both bots on a server lost their coordinator at once and never got it back; one that then died stayed dead for the rest of the game. The server's log only said "Connection lost".
- **Solution:** A new per-lane record of the bridge's own events named the cause: a reflex's note was longer than the 240 characters the protocol allows, so the coordinator refused the whole observation and dropped the connection. The mod now clips the note, and the coordinator trims such a note instead of refusing the observation.
- **Result:** The cause showed up in 1 of 13 servers in one round and the same symptom in 2 of 13 in another (measured, iron-kit practice rooms); no room has run with the clip yet.
