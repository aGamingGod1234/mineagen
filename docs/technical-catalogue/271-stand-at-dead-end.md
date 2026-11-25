# Stand and fight at a dead end instead of fleeing to it (#271)

- **Problem:** running from a zombie along a bridge or down a tunnel, the bot fled to the very end and was knocked off or cornered with its back turned.
- **Solution:** while fleeing a melee mob, it measures how much ground the way it has seen actually gains; if a wall or a drop ends it soon, it turns and holds its ground behind the shield and lets the chaser come into reach.
- **Result:** measured in practice rooms, same build both sides: deaths 25 to 17 over 90 paired fights, damage per fight weighted by real-game killers 12.28 to 9.11, cornered corridor damage 15.6 to 2.4 per run (15 runs a side).
