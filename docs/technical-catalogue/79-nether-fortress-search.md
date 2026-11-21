# #79 Search for a Nether fortress on foot along open ground, digging only when walled in

- **Problem:** Searching the Nether for a fortress, the bot tunnelled straight on through netherrack. It wore out its pickaxes, then gave up and left the model to steer by hand. In the real checkpoint games, 18 of 43 games without blaze rods never reached a fortress, and their last minutes went on tunnelling and replacing worn picks.
- **Solution:** A search loop that keeps one heading, walks to seen ground (ridges, lava shores, the far side of caverns) and turns along an open side before it digs. After two blind tunnel legs it walks back to open ground and turns instead of digging on.
- **Result (measured, 160 paired practice rooms per arm, 8 Nether maps, 15 game-minutes each):**
  - Rooms that used up all three pickaxes: 59 → 7.
  - Pickaxe uses: −34%.
  - "Blocked" hand-backs: 3,073 → 505.
  - Fortresses found: 32 → 25.
  - Rooms with a death: 21 → 35, since walking ridges and lava shores is more exposed than tunnelling. It is a partial win, not a finished one.
