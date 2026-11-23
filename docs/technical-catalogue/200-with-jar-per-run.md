# #200 Give each with-jar practice-room run its own mod jar

- **Problem:** When two versions of the mod were compared in practice rooms, both versions of a room ran side by side on one machine and shared one jar file, so the last one copied in played both sides. The comparison quietly measured one version against itself.
- **Solution:** Each run is now told which jar to load instead of copying it into a shared folder.
- **Result:** Runs that loaded the jar their side named: about half before (an End refill test read 8/12 against 8/12; counted by the jar each run really loaded, 0/48 against 60/60), and 40 of 40 after (bed and bucket-aim, 10 a side, checked from each run's recorded jar hash).
