# PR #104: Redesign the control center

## Crisp rounded corners at every GUI scale

- **Problem:** Minecraft draws GUI images without smoothing, and the GUI is scaled by whole numbers like 2, 3 or 4. One high-resolution rounded corner scaled to fit looks lumpy at scale 3. The control center wanted soft corners, a shadow and icons anyway.
- **Solution:** a small script draws every shape and icon once per GUI scale. The game picks the set that matches the current scale and undoes the scale while drawing, so each image pixel lands on exactly one screen pixel.
- **Result:** even corners and icons at scales 1 to 6. Measured by eye on real screenshots at scales 2, 3 and 4. 130 sprites, 760 KB.
