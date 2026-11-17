# PR #436: Make agent speech honor listeners, pacing and provider failures

## Speech outages without repeated paid calls

- **Problem:** A rejected credential still allowed more speech calls and synthetic health probes, while a slow synthesis delayed the text fallback.
- **Solution:** Separate permanent configuration failures from transient outages, block work while a channel is open, and allow one controlled recovery attempt. Fence outdated recovery successes; retain the configured local deadline so cancelled models can reload. A host can also set `voice.interactiveTtsTimeoutMs` to send a slow OpenAI line as text sooner; it is off by default because real synthesis time has not been measured.
- **Result:** The fake-time authentication regression measured 3 TTS calls before the fix and 1 afterward. With the optional cutoff set to 2,000 ms, three 500 ms fake responses completed in 503–520 ms and three 5,000 ms fake responses returned fallback errors in 2,003–2,006 ms (measured, fake provider over loopback HTTP; this shows the cutoff works, not what value suits a real provider). Speech deadlines, provider/model defaults and STT deadlines are unchanged.

## Busy scenes without losing cached speech or human input

- **Problem:** HTTP request counts rejected cached lines and identical shared speech when synthesis slots were full, so busy scenes fell back to text unnecessarily.
- **Solution:** Admit distinct synthesis work through a bounded FIFO queue with one waiting turn per agent. Cache hits and shared synthesis waiters do not consume provider-work slots; cancellation, queue expiry and provider outages release their owned reservations.
- **Result:** With four fake TTS operations blocked and the fifth worker slot reserved for STT, the cached line changed from HTTP 429 to HTTP 200 with zero additional provider calls. A fifth distinct miss waited and completed after release, while STT still returned HTTP 200. These are measured loopback regression results. The configured provider concurrency limit remains five; queue waiting defaults to 250 ms with ten waiting agents, verified by source and queue tests.
