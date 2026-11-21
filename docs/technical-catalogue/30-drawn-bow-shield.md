# PR #30: Raise the shield when a skeleton draws its bow, not only when the arrow flies

## Shield up before the arrow flies

- **Problem:** The bot raised its shield only once it saw an arrow in the air, and an arrow is visible for about 6 ticks while a shield needs 5 to work. With a shield in hand, 36 of 77 skeleton arrows still hit.
- **Solution:** The body now watches the skeleton instead of the arrow: a bow drawn at it for 8 ticks raises the shield before the shot, as a player would.
- **Result:** In the live A/B fixture the share of arrow damage blocked rose from 64% to 82% (damage taken 64 HP to 29 HP, down 55%). Measured live with vanilla's shield and damage counters; baseline counts measured from the checkpoint-2 rerun (16 games) logs.
