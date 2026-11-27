# PR #311: Name a fortress's raised blaze spawner platform when it is in sight, and walk to it when searching for the spawner

- **Problem:** the bot walked right past fortress blaze spawners. A spawner sits on top of a raised platform that hides it from the bridges below, and the bot only knew "there is a fortress here". In 26 earlier fortress games, 13 never saw the spawner at all.
- **Solution:** the bot now recognises the spawner platform itself when a real line of sight reaches it (never through walls), and walks there first when it searches for the spawner.
- **Result:** in a 6-pair A/B with the same build, fortress-entrance starts and 40-minute games (measured), the bot saw the spawner and came within 8 blocks of it in 5 of 6 games with the change and 2 of 6 without. It picked up 5 blaze rods with the change and 1 without. Deaths were the same, 6 v 6.
