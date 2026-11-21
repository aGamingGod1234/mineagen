# PR #46: Stop the coordinator falling behind, carry the manual across rotations, and explain rejections

- **Problem:** The bot's coordinator fell minutes behind the game, and the server crashed. Writing down each game message for later study was quietly using half the coordinator's time. For each of about 1,250 words in a message, it re-read the whole system environment looking for passwords.
  **Solution:** Read the environment once per message instead of once per word.
  **Result:** 294 ms to 13 ms per message, measured by replaying the crashed game's real messages on one machine. The event loop's share drops from about 48% to 2%.
- **Problem:** When the bot dropped its older conversation to save space, it reread the manual pages it had just read. 22 of 26 rereads came right after one of these drops.
  **Solution:** Carry a one-line summary of each page's fields across the drop, within 2 KB.
  **Result:** Replayed over 16 games, 20 of those 22 rereads would find their page carried, at about 1 KB per drop. Simulated, not yet measured live.
