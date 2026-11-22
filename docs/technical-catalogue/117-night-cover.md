# PR #117: Keep an unarmoured bot under cover on its first night

- **Problem:** the bot spent its first night in the open. Safe in a mine at dusk, it climbed back up into the dark to look for logs, gravel or water, and died to skeleton arrows and zombies. In 16 from-scratch games, 10 of 14 deaths were surface mobs on night 1.
- **Solution:** a night check in the bot's search and gather helpers. Without full iron armour, from a minute before dusk until sunrise, it won't climb out of cover or walk across open ground. It rests in a dug hole or works underground instead.
- **Result:** in a practice room that starts in a mine at dusk, alive after 10 game minutes went from 14 of 20 to 20 of 20. On the from-scratch iron route (10 bodies a side, 55 game minutes), deaths went from 24 to 5, and the full iron kit arrived later (measured, practice rooms on boat).
