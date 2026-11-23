# #190 Keep practice-room batches from filling the disk

- **Problem:** Practice-room batches copied every run's whole server folder home, including about 40 regenerated mod jars and the world's terrain files, and one 300-room batch filled a 936 GB disk to 0 bytes free.
- **Solution:** The remote pack leaves Fabric's mod cache behind. At home, each run's terrain is deleted as soon as the scorer's own rules show it passed, and a failed run keeps its world for replay.
- **Result:** One run's results went from 16.4 MB and 95 files to 46 KB and 49 files. That was measured on the same 3 rooms x 2 repeats on main and on the branch. At the 300-room x10 batch's size that is about 49 GB down to about 0.14 GB, an estimate from the per-run figure. Scores were byte-identical on six slimmed copies of finished batches (948 runs).
