# #315 Run the coordinator on a boat.dev machine from the game

- **Problem:** Running the coordinator on a rented cloud machine means the game on the PC and the agents far away must talk as if they sat side by side, and a crashed or killed game must never leave a paid machine running.
- **Solution:** The PC dials one outgoing secure WebSocket to a tiny relay on the machine that carries the bridge bytes. Four layers delete the machine: a normal stop, a detached reaper, boat's own timeout kept alive only by the runner, and a sweep on next launch.
- **Result (measured, live boat runs and kill tests):** machine ready and coordinator running in 6 s; bridge round trip median 263 ms; first log at 89-121 s on boat compared with 60-76 s locally; leftover machine time after a kill 1.7-3.2 s, or 309 s when every local process is killed at once.

