# #108 Let the bot take stone and other placed blocks from a village it can see, instead of digging down


- **Problem:** The bot could see a village full of cobblestone but dug into the ground for stone, because the planner only knew about blocks right next to it. Placed blocks farther away were an unnamed blob.
- **Solution:** Far sight now names every placed block, door and chest it can see, with a position and a count, and the coordinator keeps them as one remembered list of sources the planner prices by what they drop and how far away they are.
- **Result:** From the playtest's starting tree, a stone pickaxe without digging down went from 0/10 to 10/10 (measured, practice rooms, 10 runs each).

- **Problem:** Once the mod sent the new rows, every look the bot took in a village timed out. The game server wasn't stuck, and the logs had no errors.
- **Solution:** The cause was the coordinator's strict observation check. It didn't know the new row type, so it rejected the whole observation. The check now knows the row's shape.
- **Result:** Village-room runs that ended in a timeout went from 20 of 20 to 0 of 20 (measured, practice rooms, same mod build).

