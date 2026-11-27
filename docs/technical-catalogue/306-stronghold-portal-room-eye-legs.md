# PR 306: Stronghold: skip unreachable portal-room spots, walk longer between eye throws

- **Problem:** Following eyes of ender, the bot threw one every 60 blocks on the same bearing, so a long trip used up most of its twelve eyes before it reached the stronghold.
  **Solution:** Walk up to 300 blocks between throws while the eye keeps its bearing, or toward the crossing point the throws give, and never throw while standing on water.
  **Result:** Measured live in one game: legs between throws grew to 240 and 298 blocks against about 64 on `main`, and it reached the stronghold with 10 eyes against 8. Decision tests: 4 legs cover 960 blocks against 312. n=1, low trust.
- **Problem:** Inside a stronghold, the bot kept trying the same unreachable spots and spent 87 minutes without reaching the portal room.
  **Solution:** The search remembers spots it failed to reach and moves on to new ones.
  **Result:** Measured in one A/B pair: 0 repeated spots in both arms, so no difference shown yet; the bot still did not reach the portal room. Not catalogue-ready until a follow-up fixes the wall-top targets.
- **Problem:** The stronghold search treated the tops of walls and ceilings as floor, so the bot kept walking into walls trying to stand on them.
  **Solution:** A full brick at or above the feet counts as wall, while stairs and slabs still count as steps, and spots well above wait until the bot has climbed near them.
  **Result:** Measured in 8 games of 30 minutes started inside the stronghold: failed walks to wall and ceiling tops fell from 215 to 30. The portal room was reached 0 of 4 times in both arms, because the search then runs out of floor it has seen.
