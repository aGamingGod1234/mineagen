# #222 Dragon room: count every arrow and every hit taken

- **Problem:** The dragon practice room's record cut every action message at 160 characters, so it never said whether a bow shot struck. Nobody could tell why the dragon fight was lost: bad aim, too few arrows, or too much damage taken.
- **Solution:** The room record now keeps whole action messages and the last 400 actions, and each big hit the bot takes records its hunger and how far it stood from the portal.
- **Result:** Measured in practice rooms:
  - How often an arrow strikes the flying dragon falls with distance (1,306 shots in 82 games): 64% aimed under 20 blocks away, 37% at 20-30, 19% at 30-50 and 8% past 50.
  - In 62 games, the dragon did 74% of the damage the bot took, endermen 16% and falls 10%.
  - Endermen land the killing blow in 16 of 36 deaths, usually once the dragon has brought the bot low.
- **What did not work:** Each of these was run against main's play in the same batch:
  - Healing before low health: 4 kills in 20 for both sides.
  - Aiming at the head: about 2.6 damage an arrow against 2.2 (estimated from the dragon's health before and after), but only half as many arrows struck.
  - Saving arrows for close shots (none past 26 blocks): 1 kill in 20 against 0 in 20, and 36% of arrows struck against 26%, but half as many arrows landed and the dragon ended no lower.
