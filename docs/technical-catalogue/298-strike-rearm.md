# #298 End: the dragon head strike tries again 10 s after giving up, instead of staying off

- **Problem:** a reflex that walks the bot to the dragon's head gave up for the whole game after four failed tries, and those four tries took about 4 seconds. In half of 20 End games the bot lost its main way to hurt a perched dragon, and in 3 games it lost it from the start of the fight.
- **Solution:** the reflex now rests 10 seconds and comes back, the way a player who couldn't reach the head tries again on the next landing.
- **Result:** before, the strike was switched off for the rest of the game in 10 of 20 End games (measured from reflex status in each observation). After: RESULTS_PENDING.
