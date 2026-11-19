# PR #23: Recover at low health inside obtain, and name the body's forks model-neutrally

## A gather step that gave up instead of eating

- **Problem:** When the agent's "get me this item" step got hurt down to a few hearts, it stopped and handed the whole job back to the model, even with food in its pocket or a full food bar that would heal it. The model then had to notice, eat, and start the step again, and it often did not.
- **Solution:** The step now decides for itself, with one shared rule: eat food it carries, or wait for natural healing when the food bar can pay for it, then carry on. It hands back only for a real choice (a mob it cannot ignore, no food and no healing, health still falling), and says which one with the numbers.
- **Result:** In the test fixture, an obtain at health 5 carrying food went from handing back `LOW_HEALTH` to eating and finishing with its item (fixture-measured, pass or fail, not a live gain). Live games were not run.

## Counting repeats before building a stop for them

- **Problem:** The plan was to refuse the third identical request from the model, sized by one reviewer's count of 1,391 repeats.
- **Solution:** We recounted 22 recorded games with three definitions of "identical" before building anything.
- **Result:** Measured on recorded games: 361 requests would be refused under the planned key, but 359 of them are steps inside a verb (mostly `travel_to` legs). Only 2 are the model's own requests, so a refusal at the model's door would stop about 2 requests in 22 games. The stop was held for re-scoping instead of shipped.
