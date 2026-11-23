# #202 Keep the body sheltered at night when nothing fits right beside it

- **Problem:** At dusk the bot only checked the four blocks touching its feet for a bed, a crafting table or a hole. A flower, a slope or a tree trunk on every side meant it stood in the open all night.
- **Solution:** It looks for the nearest flat spot within reach, tries another spot when one is refused, and falls back to the move every player knows: dig two blocks down, drop in, cover the top.
- **Result:** Failed 13 of 80 practice-room nights before, 3 of 80 after (measured, 4 rest rooms x 20 runs a side in the same batches; one-sided Fisher p 0.008).
