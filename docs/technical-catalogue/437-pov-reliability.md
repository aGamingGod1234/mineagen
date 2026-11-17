# PR #437: POV session reliability

## Preserve takeover reports after logout

- **Problem:** A second takeover could overwrite the first summary, and a disconnected operator prevented either report from reaching the agent.
- **Solution:** Keep an ordered world-saved outbox, retain the operator identity without its live player object, and retry historical direct conversation after the bridge recovers.
- **Result:** The original runtime regression fails to retain both reports. The corrected runtime and fake sink retain and admit both reports once in order, including a saved-data reload. These are measured offline test outcomes; exactly-once model processing across process crashes is not claimed.

## Keep an exited view closed when packets arrive late

- **Problem:** A delayed state packet could reopen a POV session after the player had already exited locally.
- **Solution:** Remember closed session IDs for the current connection and reset that history on disconnect. Pose and menu matching remains tied to the active session.
- **Result:** The same delayed-state test changes from reopening the view to rejecting the packet. Offline tests also reject delayed pose/menu matching, preserve the fence across unrelated stop packets, accept a new session and allow ID reuse on a new connection. These are measured state-machine outcomes, not a measured network failure frequency.

## Share snapshot work without sharing viewer state

- **Problem:** Every spectator copied the same agent inventory and effects again each tick. Rejected state or menu publication could also leave a viewer waiting for another game-state change before recovering.
- **Solution:** Capture common agent data once per end tick, derive menu visibility separately, and keep each viewer's revision and successful-send baselines independent. Count anchored-viewer additions and entity range hooks while preserving all rechecks.
- **Result:** Two spectators over 20 end ticks go from 40 to 20 common inventory captures, a measured 50% reduction in that fixture, while each still receives 20 poses. Offline fault tests retry state, menu, forced resync and absent-body publication. Synthetic tracking-hook tests count 40 viewer additions and 40 range reads; no server timing, allocation-byte or network saving is claimed.
