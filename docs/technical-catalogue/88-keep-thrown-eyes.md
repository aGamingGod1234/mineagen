# #88 Keep thrown eyes of ender and finish the stronghold search past lakes, trees and flooded tunnels

- **Problem:** The bot threw eyes of ender toward the stronghold and lost most of them: it watched the eye at its own hand, never saw where it landed, and gave up on any eye it could not walk straight to. It ran out of spare eyes before finding the stronghold.
  **Solution:** It now watches the eye along its flight, looks where a lost eye should lie, walks over to step on it, and leaves only the eyes it truly cannot reach, then carries on.
  **Result:** Eyes lost per throw in the reach room fell from 0.83 to 0.30 (measured, 20 runs each, 84 and 88 throws); runs that ran out of eyes fell from 8 of 20 to 0.
- **Problem:** The stronghold search stopped at ordinary terrain a player crosses without thinking: a lake on the eye's heading, a tree overhead at the start, a tunnel that flooded.
  **Solution:** Swim the lake in short hops when it cannot bridge, step out from under cover before digging up for sky, and count a walk that covered ground before water as a finished leg.
  **Result:** The three eye-throw rooms went from 22/60 to 52/60 passes (measured, 20 runs per room per arm); the lake room from 0/20 to 16/20.
- **Problem:** Digging down to the stronghold wore out the bot's only iron pickaxe before it got there, and the staircase ran off to one side of the spot.
  **Solution:** Use the steeper staircase that still checks each floor, starting across the spot the eyes pointed down at.
  **Result:** Reach room: worn-out pickaxes 4/20 → 0/19; stronghold found 6/20 → 17/19 (measured).
