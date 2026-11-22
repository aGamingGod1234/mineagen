# PR #139: Judge room A/Bs by Holm-adjusted rooms and pooled target and guard tests

- **Problem:** with dozens of practice rooms compared one at a time, chance makes some rooms look better or worse, and a small gain spread over many rooms never shows in any one room.
- **Solution:** each room's p is corrected for how many rooms were compared (Holm). Then two pooled exact tests are run, one stratum per room: are the rooms the change targets better, and are all the other rooms worse?
- **Result (measured offline on stored batches):** in the portal-casting A/B, one of two "better" rooms turned out to be noise after correction. The 8 target rooms pooled from 44/80 to 65/80 (p < 0.0001), with no loss shown across 10 guard rooms (p .10). A synthetic +1-pass-per-room change over 30 rooms reads as no change per room but p .01 pooled.
