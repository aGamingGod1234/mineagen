# #122 Make and wear an iron chestplate and boots after the kit, before the portal


- **Problem:** the bot never put on armour. Its shopping list for iron matched the tools exactly, so nothing was ever left over for armour.
- **Solution:** armour became its own step between the tools and the portal: make a chestplate and boots, mining more iron when needed.
- **Result:** wearing armour by the time it heads for the portal went from 0 of 26 to 19 of 25, measured in a practice room on 13 worlds. The cost was about 10 minutes (median) and 4 of 25 bots dying underground while mining the extra iron.

