# #265 Stop long games from slowly running their machine out of memory

- **Problem:** a long game's runner kept every snapshot of the bot's inventory, with every item's full description, in memory for the whole game. It grew about 155 MB an hour and killed a 4 GB machine after 4.7 hours.
- **Solution:** keep only each item's name and count, the only part the end-of-game report uses.
- **Result:** memory held at the end of a 280-minute game went from 725 MB to 131 MB (measured by replaying that game's capture), with an identical report. A 15-hour game now needs about 0.4 GB for this instead of about 2.3 GB (estimated from the hourly rate).
