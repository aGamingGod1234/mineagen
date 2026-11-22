# PR #117: Keep an unarmoured bot under cover on its first night

- **Problem:** the bot spent its first night in the open. Safe in a mine at dusk, it climbed back up into the dark to look for logs, gravel or water, and died to skeleton arrows and zombies. In 16 from-scratch games, 10 of 14 deaths were surface mobs on night 1.
- **Solution:** a night check in the bot's search and gather helpers. Without full iron armour, from a minute before dusk until sunrise, it won't climb out of cover or walk across open ground. It rests in a dug hole or works underground instead.
- **Result:** in a practice room that starts in a mine at dusk, the bot was alive after 10 game minutes 10 of 10 times, against 6 of 10 on main (measured, practice rooms on boat, 10 runs a side; more runs pending).
