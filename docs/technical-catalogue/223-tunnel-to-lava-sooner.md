# #223 Tunnel to lava behind rock sooner when casting a portal

## Walking the same shore until no walks are left

- **Problem:** to cast a portal, the bot fills a bucket at the lava pool beside its dug cast site. Often the pool is a few blocks away behind rock. Each walk toward the shore stopped where the path it had seen ended, and the cast then retried the same few spots. In one practice room it made 16 walks to 4 spots behind the same rock and gave up with no spot to stand on. Its step that tunnels to lava behind rock never ran, because that step only comes after every shore walk, and the 16 walks were already spent.
- **Solution:** after two walks in one fetch stop at the edge of what the bot has seen, it tunnels toward the lava straight away, while it still has walks left.
- **Result:** all 24 portal gate practice rooms lit 31 of 144 runs instead of 24 of 144 (measured in the same batch, 6 runs per room on each side). The tunnel to lava ran in 11 runs instead of 3, and casts that gave up with no spot to stand on fell from 9 to 3. The gain is not yet significant (one-sided Fisher p 0.18), and no room did worse after a Holm correction.

## A first idea that lost: looking under the tunnel floor

- **Problem:** the lava search tunnels at y-54. Lava is often heard just below the tunnel floor, and the search stopped there in 28 of 103 failed searches.
- **Solution tried:** open the floor where lava was heard and look down into it.
- **Result:** in the same batch the bot lit 5 of 42 portals with it and 15 of 42 without it (measured, practice rooms). The lava it found was sealed under rock, where a portal cannot be cast, and sometimes the bot fell into its own hole. Reverted before merge.
