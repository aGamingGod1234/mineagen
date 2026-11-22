# PR #102: Eat after turning away from a crafting table instead of freezing, and let a spectator always leave the view

- **Problem:** a reflex could hold the bot's body forever. Eating while facing a crafting table only reopened the table, the craft waiting underneath never timed out, and the model was never told. A spectator watching could not leave either, because each reopened table popped up over their screen faster than chat could open.
- **Solution:** the bot turns away from usable blocks before eating; a meal that cannot start counts as a failure and gives the body back; any non-combat reflex that holds an action for 2 minutes ends it and reports why. The spectator gets a default leave key that works inside the agent's screens.
- **Result:** eat-at-the-table practice room 0/10 on main, 10/10 with the fix (measured, 10 boat runs per arm). Live playtest before: 32 failed meals in a row and over 5 minutes standing still.
