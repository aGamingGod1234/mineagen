# PR #241: Turn another way when water in the tunnel stops short of the bot

- **Problem:** Deep underground, water broke into the bot's tunnel and stopped before reaching it. The bot was safe and dry, but the search still gave up and called it danger.
- **Solution:** The search now tells a flood that stopped short from one that caught the bot. It turns another way, up to twice, unless lava could be involved.
- **Result:** Searches ended by a stopped flood: 10 of 158 before, 2 of 158 after (measured, two same-batch A/Bs on practice rooms). Portal lit 47/158 to 55/158, within chance.
