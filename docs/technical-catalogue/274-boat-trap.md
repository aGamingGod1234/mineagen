# #274 Trap a calm enderman in a boat, and hunt endermen on Overworld nights

## The bot had no pearl method that fit its kit
- **Problem:** in from-scratch games the bot met endermen with a stone sword and no armour, and its only advice was to leave them alone. It saw 98 endermen in 8 games and killed 2.
- **Solution:** the bot now knows the player's boat trap: put a boat in the enderman's path, stare at it, and kill it while it sits stuck in the boat. A refused boat goes on the nearest clear floor, the way a player turns to a clear spot.
- **Result:** in a practice room with no model, a block beside the boat spot used to stop the trap. The boat was placed 0 of 3 times before and 3 of 3 after, and the enderman sat and died in 3 of 3 with 0 health lost. Measured.

## It could not tell when the trap had worked
- **Problem:** in a live game the bot placed the boat, then hit the empty boat about 10 times and broke it. Nothing in what it sees said whether a mob was sitting in a boat.
- **Solution:** what the bot sees now marks a mob seated in a boat, and a boat's rider. The trap advice says to strike only once it shows as seated.
- **Result:** in the practice room, the seated enderman showed as seated in 9 of 9 trials across 3 setups, and each was killed with 0 deaths. Measured.

## Night rules kept it underground while pearls were short
- **Problem:** across 48 recorded games the bot spent 49% of night minutes underground. It walked up to 0 of 19 calm Overworld endermen it saw within 48 m, and only 2 of 48 games ever held a pearl.
- **Solution:** with pearls short and a trap or blade in hand, an Overworld night is now the hunt. It stays near cover on the surface, is woken by endermen up to 48 m away, and may walk out to one. The suggested move names the trap first when it holds a boat.
- **Result:** in a first set of night games from saved positions, the share of night minutes above ground went from 19% to 35%. Close meetings with an enderman went from 0 to 3 in about 90 night minutes per side. That is a small set; pearls stayed at 0 v 0. Measured.
