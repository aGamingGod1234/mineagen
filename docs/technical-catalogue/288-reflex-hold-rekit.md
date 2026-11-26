# #288 Reflexes finish their run under model commands; re-kit armour and eat when hurt

- **Problem:** The bot's survival reflexes (run away, take cover, fight back) were cut off by its own next decision, usually within a second, so it died mid-escape.
- **Solution:** A started reflex now finishes its run, up to 10 s, before the bot's next plan takes over. Afterwards it steps aside until the danger changes.
- **Result:** Measured on 8 fresh games before the change: about 21 of 42 deaths came right after a cut-off reflex. After, measured on 6 save points from those games (18 minutes each, 1 game per save point): no reflex was cut off by a model command before a death, and finished reflex runs went from 11 to 16. Deaths: 2 with the switches off, 0 with this and #292 together. The sample is small. It landed together with #292.
