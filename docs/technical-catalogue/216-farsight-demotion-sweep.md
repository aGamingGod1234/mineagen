# #216 Forget unloaded chunks in far sight without asking about every chunk

- **Problem:** To forget chunks that had unloaded, the shared far-sight index asked the server about every chunk it held, on every look. With 32 bots that was thousands of chunks, many times a tick: 5.5% of the server's time, spent mostly confirming that nothing had changed.
- **Solution:** Hook the one place the server unloads a chunk, and re-check only the chunks it reported since the last sweep.
- **Result:** Sweep 5.5% → 0.0-0.2% of the server thread at 32 bots. In a self-check of 7,000 sweeps it dropped exactly the same 4,496 chunks with 1,300 times fewer checks (measured with Java Flight Recorder and a self-check build, 6 runs a side on large test machines).
