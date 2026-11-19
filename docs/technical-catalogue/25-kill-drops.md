# PR #25: Collect kill drops, name break drops by id, and fall back when an enderman roof fails

## Kills that seemed to drop nothing

- **Problem:** In 22 recorded games, 17 kills left none of the loot the mob usually drops, and another 17 kill drops were left behind because the inventory was full (all 36 of 36 slots). It looked like a timing bug, so the obvious fix was to watch the corpse more often.
- **Solution:** Before changing anything we set a rule: add faster sampling only if some kill showed its loot arriving late. We then compared each case with Minecraft's own loot odds. No kill did, so we fixed the real causes: the fight now accepts loot that aged during a reflex pause, it throws a junk stack to make room, and a new idle habit goes back for kill loot left behind.
- **Result:** Measured on recorded games: 11 of the 17 match plain bad luck on the loot roll (12 empty kills seen against 11.85 expected without a pause). 6 came after a defend reflex paused the fight (8 empty against 4.56 expected), which fits loot that got too old for the fight's 5-tick age filter. The effect of the fixes on live games is not measured yet.

## An enderman shelter that turned into a dead end

- **Problem:** The agent hunts endermen from a small roofed shelter they cannot enter. In recorded games, 17 such hunts took 376.8 s and made 0 kills; 8 of them ended on a roof stop (the shelter not built, or a spot not reached).
- **Solution:** When the shelter fails, the same call now carries on as the open-ground hunt with a fresh wait, instead of handing back.
- **Result:** Removes a dead end that cost 35.4 s across those 8 stops (measured on recorded games). Kills after a fallback are not measured yet; enderman hunts made 0 kills in 22 recorded runs with or without a roof, so this alone does not make them succeed.
