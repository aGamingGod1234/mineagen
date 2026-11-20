# PR #33: Show the agent its instinct each wake and keep cave choices unless it overrules

## A fast instinct beside slow reasoning

- **Problem:** The bot had only slow reasoning. Reading a long strategy guide, it decided caves were too risky before it had seen one, and turned caves off in 593 of 724 calls.
- **Solution:** A fast instinct layer: each turn the bot sees the top 3 rules from a "situation -> response" book that fit what it perceives right now. For cave choices the body keeps the instinct unless the model names a fact that says otherwise.
- **Result:** Finding the right rule for a moment rose from 64% (205 of 318) to 91% (429 of 472) in the top 3, and 98% in the top 5, measured offline on decision moments labelled from the checkpoint-2 rerun (16 games); the old tagging could never match 189 of 224 rules. Replayed against the same games, 212 of the 593 cave refusals would now go through caves. Live effect not yet measured.
