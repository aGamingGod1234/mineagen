# #188: Refuse a jump off a lip into lava from any input, and into the dark in the Nether

- **Problem:** the bot's edge guard checked where a jump would land only for planned walking moves. A jump from the bot's own keys could go straight off a ledge into the lava sea, and the guard also thought a sprint jump from a standstill was a short hop, because the sprint only switches on during the very tick of the jump.
- **Solution:** every jump is now judged by where it lands, whatever sent it, as a sprint jump whenever the body really sprints that tick. Lava, fire, the void and a killing fall are refused for any input, and in the Nether so is a jump off an edge whose bottom the bot has not seen. A per-tick trace of the failing room showed both causes.
- **Result:** a held sprint jump off a deck lip 5 blocks above lava killed the bot 10 of 10 times before and 0 of 10 after (measured, practice rooms, 10 runs a side, Fisher p about 1e-5).
