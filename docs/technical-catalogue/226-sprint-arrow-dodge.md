# #226 Sprint across a skeleton's shot, and wall in from one that keeps shooting without waiting to be hit

## A dodge that walked when it should have run

- **Problem:** With two skeletons shooting and no shield, the bot's arrow dodge walked sideways while facing the archer, and flipped direction on every new draw. Skeleton arrows don't lead their target, so a dodge only works when the body is well off the line by the time the arrow arrives: in a tick trace, 63% of shots hit when the body had moved under half a block across the line during the arrow's flight, and 2% when it had moved 1.5 blocks or more. The walk was too slow, and each flip stalled it while the last arrow was still in the air.
- **Solution:** When nothing is in sword reach, the bot now turns along the sidestep and sprints it, as a player runs across a shot, and on a new draw keeps running the way it already runs when that also crosses the new line. Against crossbows it keeps the old facing strafe, since a held crossbow can outlast the dodge once the shooter is out of view.
- **Result:** Shots that hit the bot in the tick trace: 38 of 186 before, 13 of 184 after (measured, 3 runs a side). Two-skeleton room, 80 runs a side over four same-batch rounds: damage 1,646 before, 800 after (median per run 19 to 8 in the first two, p = 2e-8); survived 71 of 80 before, 77 of 80 after (more runs needed for survival alone).

## A dodge so good the bot stopped taking cover

- **Problem:** Once the sprint kept every arrow off, the bot stopped building cover from a skeleton. The part that walls in waited to be hit first, and it never was, so the bot ran side to side under the archer for the rest of the room: cover reached 7 of 15 times, against 12 of 15 before.
- **Solution:** A skeleton drawing its bow at the bot now counts like a hit for 4 seconds, so the bot walls in or takes cover while it is being shot at, not only after an arrow lands.
- **Result:** Measured, same batch, 20 runs a side: cover room 15/20 before, 20/20 after; skeleton wall-in room 17/20 with 3 deaths before, 20/20 with no deaths and no damage after.
