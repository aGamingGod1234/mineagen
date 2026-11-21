# #60 Play practice rooms with the real model beside the script stand-in (AI rooms)

- **Problem:** practice rooms test the bot's body with a script standing in for its brain. The only real-model tests were hours-long games, so a bad decision took a night to show.
- **Solution:** AI rooms replay the same practice rooms with the real model through the production coordinator, side by side with the script on one cloud machine, and score both the same way.
- **Result:** measured on 21 Nov over 9 distinct rooms (10 room setups, 5 repeats each).
  - 50 model rooms plus 50 script rooms took 35 minutes of wall time on 10 machines.
  - Overhead outside play was a median 38 s per room.
  - The model passed 44 of 49 valid rooms, the script 30 of 50.
  - 956 model calls, a median of 16 per room.
