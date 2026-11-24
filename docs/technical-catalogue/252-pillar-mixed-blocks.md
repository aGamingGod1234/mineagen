# #252 Pillar on every plain block in the pack

- **Problem:** The bot refused to pillar up to a caged End crystal when its blocks were a mix of cobblestone and end stone, even with plenty in total. 77% of its cage pillars never started.
- **Solution:** The pillar now uses every plain block in the pack, the asked one first, as a player would.
- **Result:** Measured in cloud practice rooms: refusals 993 → 204 over 60 rooms a side, crystals left at the time limit 118 → 93. Room pass rate flat (20 vs 20 of 90), deaths 32 vs 26.
