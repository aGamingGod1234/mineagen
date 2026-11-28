# #314 Require a full kit for Nether entry and re-entry

**Problem.** The bot entered the Nether without an iron chestplate on 15 of 17 crossings and without a shield on 6 of 17 across three recorded fresh games. The portal check looked at surface supplies, and a bot that left a mine without enough iron had to find more near the portal.

**Solution.** Mine the armour iron alongside the casting kit. The bot can stair toward y16 when the lower mine is dry. At the portal, check the live offhand, worn armour and prepared food. Redirect the walk to equip or get missing items. Two searches without supply progress allow the bot to move on in a world short on resources.

**Result.** In two matched real-model checkpoints, fully equipped crossings rose from 0/2 to 2/2. The first entry took 1m48s before and 10m22s after. From the staged re-kit start, entry took 15m37s before and 21m43s after. All four crossings followed play with zero deaths. The kit candidate later died to a magma cube and a skeleton and made no further crossing during that window. A scripted Minecraft room exercised the kit check after a real Nether death. These small samples verify the crossing behaviour and do not establish a survival improvement.
