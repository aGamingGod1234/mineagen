# #307 Mine the chestplate's iron on the iron trip, before leaving the ore

- **Problem:** The bot went down a mine for iron, made its pickaxe, bucket and flint and steel, and walked away from the ore without the 8 extra iron a chestplate needs. Most deaths happened with no armour on. Iron ore is not close by again until much later, so a chestplate planned at portal time never got made.
- **Solution:** After the bot gets an iron tool while it is still down the mine, it now mines 8 more iron for a chestplate on the same trip. This is capped at a few minutes and dropped when danger or night interrupts. If the iron is held but fuel is missing, it gathers the fuel too. Leggings wait until a chestplate is made.
- **Result:** Measured over 12 matched pairs of fresh 30-minute real-model games (two rounds of 6, same starts on both sides):

  | | Before | After |
  |---|---|---|
  | Iron chestplate worn | 0/12 | 3/12 |
  | Any iron armour piece worn | 0/12 | 5/12 |
  | Pickaxe, bucket and flint and steel | 5/12 | 7/12 |
  | Deaths | 4 | 0 |

  Neither round reached its own pass bar of 4 chestplates in 6 games. In the second round, 3 of the 6 games on the new code never finished an iron pickaxe within 30 minutes, so the new step never ran there. Small samples: this shows the direction, not a proven rate.
