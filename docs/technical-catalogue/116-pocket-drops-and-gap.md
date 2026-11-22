# PR #116: Pick up iron dropped at the bottom of a mined hole and climb back out, and mine an ore underfoot beside a gap

**Iron left at the bottom of the hole it had just dug**

- **Problem:** iron mined from the floor dropped to the bottom of a narrow hole where the hole's own wall hid it, so the bot didn't know the drops were there and searched for new iron. Next to a one-block gap it gave up on the ore under its feet.
- **Solution:** we recorded where each drop really was against what the bot could see, which showed the drops were hidden, not ignored. The bot now steps into the hole, collects what it lands on, and cuts stairs back out. A place to stand across a gap is never chosen, and a refused step lets it try the next one.
- **Result:** in a room built from that case, it ended with the iron and out of the hole 10 of 10 times against 1 of 10 on main, in about 8 s instead of about a minute. Beside a gap it mined the ore 10 of 10 times against 0 of 10 (measured, 10 runs per side on cloud machines).
