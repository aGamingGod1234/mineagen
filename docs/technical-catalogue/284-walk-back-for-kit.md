# #284 After a death, walk back for the dropped kit, with an off switch

- **Problem:** After dying, the bot treated its dropped iron kit as gone and spent 10-20 minutes rebuilding it, though the drops were still waiting for it.
- **Solution:** A walk-back step and a respawn wake that says where the drops are and that they only age while the bot is near. The bot makes a stone pickaxe first when the drops are underground.
- **Result:** Kit back in 5 of 10 paired games with the fix and in 2 of 10 without (measured, A/B on staged real deaths, 25-minute games). When it got the kit back, that took a median of 9.5 minutes. Rebuilding an iron pickaxe from nothing took 12.5-21 minutes, and rebuilding gets none of the buckets, shield or portal kit back.
