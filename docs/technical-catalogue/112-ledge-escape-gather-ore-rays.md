# #112 Duck out from under a submerged ledge instead of drowning, let gather walk to a remembered village block, and keep ore's sight lines


- **Problem:** Under water with its head against a ledge, the bot kept swimming straight up into the ceiling until it drowned, though open water was one block to the side.
- **Solution:** The bot's emergency swim now uses the same "duck out sideways, look up" move its normal travel already had, and find runs that escape before giving up on a breath stop.
- **Result:** Getting out from under a ledge with about 4 s of air: 1/10 runs before, 10/10 after, with 0 HP lost (measured, practice room, 10 runs each).

