# #255 Record the agent for replays when the server template carries ServerReplay

- **Problem:** the replay recorder ignored the bot, because the bot is a simulated player.
- **Solution:** the launcher asks the recorder for the bot by name the moment it joins, and gives the server time to save the replay at the end.
- **Result:** measured over 30 minutes on the same seed, tick time was 2.68 ms without recording and 2.64 ms with it. The replay was about 86 MiB per hour while the bot kept exploring new ground, and the gap between the bot joining and recording starting fell from 20 s to 2 s.
