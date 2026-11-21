# #71 Eat below hunger 18 so a hurt bot heals between fights


- **Problem:** the bot ate only when hunger fell below 14, but Minecraft regrows health only at hunger 18 or more. So a hurt bot with food in its bag could sit at low health for minutes and walk into the next fight that way.
- **Solution:** we tested every guessed number we could put in a practice room. This one was wrong, so the eat line moved to 18. A guard keeps the bot from spending a golden apple or eating rotten flesh just to top up its hunger.
- **Result:** in a 40 s practice room with bread in the bag, the hurt bot ended at 12 health in 10 of 10 runs before, and at full health (20) in 10 of 10 after. Measured on boat, 10 runs a side. Fight rooms showed no change: 0 deaths both ways.

