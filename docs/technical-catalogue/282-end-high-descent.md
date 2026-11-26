# End: tell the bot how to come down a tall column safely (#282)

- **Problem:** the bot builds tall columns to shoot the End crystals, then dies coming down: 5 of 6 descents from y95 or higher were fatal, each after a water pour on the top or a sideways dig.
- **Solution:** when it stands on something it built in the End, the facts it already reads say how a player gets down: mine the column under you, keep the bucket.
- **Result:** in 9 real-model game pairs that open on a y104 column, water pours on the column top went from 6 of 9 games to 1 of 9, and deaths coming down from 4 of 9 tall climbs to 1 of 9. End deaths were equal at 7 against 7 (measured; the pour gap is p ≈ 0.05, the death gap p ≈ 0.29, so it needs more games to trust).
