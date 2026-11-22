# #66: Let the bot get itself out of water, holes and arrow fire in one step instead of key presses


- **Problem:** in an emergency the model steered the body by single key presses, one model call each. Between presses the body sank back into the water.
  - **Solution:** one body job that looks at where it is and does what a player would: swim up, swim to the bank and climb out, fill a flooded shaft and pillar out, or step into cover. Then it hands back.
  - **Result:** in a 9-deep pool, out 0/10 with the old hand presses and 4/10 with the best old single call, against 10/10 with one call (measured, 10 rooms each). In the find's real flooded-cave shaft, 0/10 against 10/10 (measured).
- **Problem:** a new body action has to fit a tool list about 400 bytes under its cap.
  - **Solution:** it lives only as a `do_step` verb and a program call, never in the four copies of the raw action list.
  - **Result:** 67 bytes instead of about 120 (measured with `JSON.stringify` of the tool list).

