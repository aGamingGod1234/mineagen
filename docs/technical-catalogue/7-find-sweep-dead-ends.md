# PR #7: Stop find's surface sweep from walking into the same dead ends

## A search that kept walking into the same walls

- **Problem:** When the agent searched the surface for something it could not see, its own search pattern kept sending it into walls. In 22 measured games, 1,358 of its 1,662 "no route" failures came from the sweep's walking legs, about 187 minutes of play. After each leg it forgot which headings were blocked, looked around again even when it had not moved, searched under a roof without climbing out, and even searched the Nether for trees.
- **Solution:** The sweep now keeps building along a heading once building gets it through, looks around only from new ground, climbs out from under a roof before a tree or animal search, and refuses at once to search for a block that never generates in the current dimension.
- **Result:** In a provider-free fixture, doomed walking legs between build legs went from 23 to 0, looks around from 43 to 5, and the time to hand back from 212 s to 67 s. These are measured fixture outcomes; the effect on real games is not measured yet.
