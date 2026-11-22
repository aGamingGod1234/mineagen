# #83 Duck out from under a ceiling to find the way up instead of stopping to drown

- **Problem:** Caught under a ceiling in a flooded cave with a few seconds of air, the bot could not see the way up from inside its own column and stopped to wait, drowning every time.
- **Solution:** When the head is capped and no way up is known, it swims one cell into the open water beside it and looks up, so the shaft comes into sight and the normal rise takes over.
- **Result:** The detour room went from 0/10 to 10/10 (measured, 10 boat runs a side). The rise after the peek leaves about 1.5 s of air to spare (measured, 8 runs from the shaft bottom).
