# PR #90: Barter gold for ender pearls as one job

## A barter call that stopped every nine ingots

- **Problem:** The bot only had one way to get the 12 ender pearls the End needs: kill endermen, which drop one half the time. Bartering gold with piglins is the usual player way, but the bot's barter call stopped every 9 ingots to ask the AI to craft more gold. It gave up on piglins more than 16 blocks away, and the returned gravel and blackstone filled its bags.
- **Solution:** Bartering is now one job. The bot puts on gold armour it carries, crafts its gold blocks and nuggets into ingots as it goes, leaves rubble returns on the ground, and walks to the nearest calm piglin group.
- **Result:** In practice rooms with bastion gold (10 repeats, same loot seeds on both builds), it traded 184 ingots per 10 game minutes against 80 on main, for 116 pearls against 49, and the AI's calls per game fell from 42 to 21. Measured.

## A sword sweep that turned a whole piglin group

- **Problem:** Fighting a hoglin beside piglins, the sword's sweep hit the calm piglins next to it, and the whole group turned on the bot. Every death in the bastion-gold rooms came this way.
- **Solution:** A sword swing now waits while a calm piglin, or another calm neutral mob, stands where its sweep would land.
- **Result:** Deaths in the bastion-gold rooms went from 2 in 10 games to 0 in 10. In 10 other fight rooms (10 repeats each) nothing got worse. Measured.

## Honest barter time

- **Problem:** The AI was told bartering takes 6 seconds per ingot divided by every piglin in view, about 50 ingots a minute with five piglins.
- **Solution:** The estimate now uses the measured speed.
- **Result:** Measured 19 ingots a minute with 5 piglins (3,329 ingots over 20 practice-room runs), about 2.6 times slower than the old promise.
