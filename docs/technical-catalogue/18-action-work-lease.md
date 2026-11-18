# #18 Let long actions run to their own timeout instead of a 125 s work lease

- **Problem:** long jobs such as walking far, digging down or building a Nether portal were cut off at exactly 125 seconds, and the agent was told it had cancelled them itself.
- **Solution:** a background timer meant to catch a stuck coordinator was never refreshed for background jobs. Each job's timer now lasts as long as the job asked for, plus a margin.
- **Result:** before, 173 cut-offs at 125.0 s in 21 of 22 games, including every cancelled portal build (measured from the action results of rounds 4 to 6). After, 0 in the new fixture tests; the in-game count is measured at checkpoint round 1.
