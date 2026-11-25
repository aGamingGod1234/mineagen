# #263 Blaze rods at the spawner: wall in from several blazes, step to a blaze a block below, find the spawner

- **Problem:** a shield blocks one shooter. Against three to five blazes at a spawner, the bot held its shield up and burned down from full health in seconds.
  **Solution:** count the shooters in sight; with two or more, build a one-block shelter around the body instead of trusting the shield, and keep the arrow-shield reflex from pulling the body out of it.
  **Result:** in a practice room with only the shipped reflexes, the bot walled in in 10 of 10 trials (main: 1 of 10) and took about 12 damage per trial instead of about 30 (measured, 10 trials a side).
- **Problem:** a blaze that can see you stops coming closer, so a sword fighter who waits for it never gets a swing.
  **Solution:** walk behind the shield to a seen spot in sword reach, allowing one block up or down but never a bigger drop.
  **Result:** a blaze hovering one block below was killed 10 of 10 times instead of 0 of 10 (measured, practice room, 5 a side with and without blaze AI). From fortress save points, games with rods went from 1 of 6 to 3 of 6 with deaths level at 7 a side (measured, 45-minute games; small sample).
