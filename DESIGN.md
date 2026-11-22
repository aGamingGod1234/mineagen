---
name: Mineagen control center
description: A readable in-world control center for configuring and directing Minecraft agents.
colors:
  ink-panel: "#11151C"
  surface: "#1A2029"
  surface-raised: "#2A3340"
  selected-surface: "#15303A"
  inset-field: "#0B0F14"
  text: "#EEF1F5"
  label: "#8F99A8"
  subtle: "#6A7484"
  diamond: "#5FD4F4"
  diamond-ink: "#04212B"
  success-mint: "#5EE0A0"
  warning-gold: "#F5C451"
  fault-coral: "#FF6B7A"
typography:
  title:
    fontFamily: "Roboto Medium"
    fontSize: "1.5x"
  body:
    fontFamily: "Roboto Regular"
    fontSize: "1x (10 px TTF)"
  value:
    fontFamily: "Roboto Medium"
    fontSize: "1x"
  label:
    fontFamily: "Roboto Regular"
    fontSize: "0.78x"
rounded:
  small: "3px"
  control: "4px"
  card: "6px"
  panel: "8px"
spacing:
  grid: "4px"
  gutter: "16px"
  field-gap: "10px"
  label-to-field: "12px"
---

# Design System: Mineagen control center ("Diamond")

This is the visual direction. `ConsoleTheme.java` (colors), `ConsoleDraw.java` (shapes, icons, type scale),
`ConsoleMotion.java` (easing) and the widgets under `src/client/java/dev/agaminggod/mineagen/client/gui/` define
the rendered values.

## Overview

The control center opens over a live world, usually at GUI scale 3 on a 1080p screen: a 640x360 canvas with 9 px text.
Quality at that size comes from spacing rhythm, two font weights, alignment and restraint, not from effects. Grouping
comes from space and tone. There are no outlines around everything.

**Key characteristics:**

- One floating ink panel with a single soft shadow, capped at 760x440 and centered on large GUIs.
- A header row: the diamond mark, "Mineagen", a breadcrumb back, and one live status on the right.
- Each page has a title and one line of help when the panel is tall enough, then labelled fields.
- One cyan accent marks the current choice, keyboard focus and the one main action.

## Colors

- **Diamond cyan:** Selected choice, focus and the primary button (dark ink text on cyan). Never decorative.
- **Mint, gold, coral:** Ready, waiting and blocked states, shown as a small dot beside the words.
- **Ink, surface, raised, inset:** Depth by tone. Cards sit on surface, controls lift on hover, fields sink.
- **Provider colors:** Codex green and Claude orange, used only for each tool's small mark.

## Typography

Roboto Regular for body text and Roboto Medium for titles, values and buttons (`console` and `console_medium` font
definitions). Labels draw at 0.78x and titles at 1.5x through the pose stack, so text stays crisp at every GUI scale.

**The human copy rule.** Write in the player's words ("Ready · Max plan", "Not signed in. Run the tool's login there").
Never show account names, protocol slugs or raw limit kinds.

## Shape and depth

Rounded shapes, the panel shadow and icons are GUI sprites under `textures/gui/sprites/console/`. Each one is
generated once per GUI scale (`scripts/generate-console-sprites.py`) and drawn at one texel per screen pixel, because
GUI sprites are point-sampled and one hi-res texture scaled by 3 gets uneven corners. Shapes are white and tinted at
draw time.

## Motion

Motion answers input. Hover eases over about 120 ms, the segmented highlight slides over about 160 ms, and a picked
tool card fades its accent in. Nothing loops for decoration. A rebuilt widget starts settled, so redrawing a page never
replays an animation.

## Components

- **Buttons:** primary (cyan fill), secondary (raised fill), ghost (text only, gains a surface on hover, lines up with
  content edges) and danger (coral text on a dark red surface). They take an optional 12 px icon and have no outline
  at rest. Keyboard focus draws a ring.
- **Choice cards:** pick a model tool. Each has a mark, the tool's name and one status line with a state dot, its
  sign-in and its version.
- **Segmented control:** short ranked lists (thinking, speed, game mode) with every option visible.
- **Select:** a field that opens a popup list with a check on the current value.
- **Fields:** sunken fill, quiet ring, cyan ring when focused.
- **Roster tiles:** rounded cards with the agent's face, starting under the page title.

## Do's and Don'ts

### Do:

- **Do** align every text edge to the content gutter, ghost actions included.
- **Do** give each page one primary action, bottom right.
- **Do** keep destructive actions apart from routine ones, in the footer or a confirmation page.

### Don't:

- **Don't** outline every control. Use tone and space.
- **Don't** use glass blur, gradients, glows or decorative motion.
- **Don't** repeat in a status line what a control above already shows.
- **Don't** show account names anywhere, including tooltips.
