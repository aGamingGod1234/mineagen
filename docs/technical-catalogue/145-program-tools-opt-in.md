# #145 Send the rarely used program tools only when switched on, cutting each call's tool list by 4,355 bytes

### The tool list was 99% full

- **Problem:** every model call carries the definitions of all 32 tools. They had grown to 38,540 bytes against a 38,900-byte cap, and six of them, for writing scripts, were used 27 times in 25,038 calls.
- **Solution:** the six script tools are now behind one switch, off by default; everything else the bot uses is still sent.
- **Result:** 38,540 bytes of tool definitions per call down to 34,185 (11% smaller), measured; a small rules-only reflexes tool stays offered. Replaying the recorded token counts of 17 games shows about 1.3% fewer input tokens per call, simulated.
