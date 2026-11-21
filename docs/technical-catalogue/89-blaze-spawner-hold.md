# PR #89: Hold a blaze spawner: fight in the open, wall in to heal in a roofed cell, and keep the rods

## A shelter that kept the bot alive but lost the rods

- **Problem:** At a blaze spawner the bot either fought in the open and burned to death, or hid in a shelter and lost all the rods. Its shield broke after about 40 blocked fireballs, and then "healing behind the shield" meant standing in a doorway with an empty hand.
- **Solution:** Fight in the open like a player while healthy. When hurt, walk back into a small roofed cell, brick up the doorway, eat, and open it again when healed. Remember where the spawner and cell are.
- **Result:** Measured in practice rooms, 10 runs per arm per round, two rounds: at a real fortress spawner the bot survived 17 of 19 runs instead of 6 of 19 and kept 99 rods instead of 36. In the spawner rooms, 24 of 59 runs reached 7 rods instead of 14 of 60.
