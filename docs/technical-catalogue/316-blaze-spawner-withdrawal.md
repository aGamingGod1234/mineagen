# PR #316 Withdraw from blaze spawners with the rods in hand

- **Problem** The bot could lose the rods it had already collected by fighting without a working shield or staying close to the spawner.
- **Solution** The bot replaces a broken shield and heals under cover when it can, then uses seen ground to withdraw once it reaches the rod target.
- **Result** In four matched 40-minute fortress pairs, games with a rod rose from 1/4 to 4/4, rods held alive at the end rose from 0 to 1, and deaths fell from 5 to 4. No fortress game reached seven rods. In a separate model-free room that started with six rods, the selected build collected the seventh and moved 16.1 blocks from the spawner alive.
