# #189 Swim back to where it last breathed

- **Problem:** under water with no air in sight, the bot rose blind. After swimming along a flooded tunnel into a sealed pocket, it pressed its head into the roof, gave up, and then kept heading for a bank it could not reach until its time ran out. It never got out.
  **Solution:** the bot now remembers where it last breathed and the way it swam since. When it sees no air, it swims back along that way if its breath covers it, sinking as well as rising, and keeps level through a tunnel instead of floating into the rock over its mouth.
  **Result:** sealed-pocket practice room 0/10 to 10/10 (measured, 10 a side on cloud machines, Fisher p 0.00001), out in one try in about 15 s (an earlier version needed two tries and about 29 s). 9 water rooms 90/90 on both sides.
