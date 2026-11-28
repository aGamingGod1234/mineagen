package dev.agaminggod.mineagen.client.gui;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.agaminggod.mineagen.client.compat.McClientCompat;
import dev.agaminggod.mineagen.control.AgentControlAgent;
import dev.agaminggod.mineagen.control.AgentControlPresentation;
import dev.agaminggod.mineagen.control.AgentControlResult;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.ItemStack;

/**
 * The mission board's centre for the selected agent: its body standing in the world's light with its name, state,
 * vitals and hotbar beside it, then two plain columns, Mission (goal and live plan) and Activity (what it is doing,
 * in words). Nothing here sits in a box: type, tone and one hairline carry the structure. Every value comes from the
 * agent's body as this client sees it ({@link AgentBody}) or the coordinator's live view; a part with no data is left
 * out rather than filled.
 */
final class BoardLiveView {
	static final int HERO = 100;
	static final int GAP = 14;
	/** Centres at least this wide put Mission and Activity side by side. */
	static final int SIDE_BY_SIDE = 360;
	static final int SIDE_PANELS = 118;
	static final int STACK_MISSION = 96;
	static final int STACK_ACTIVITY = 112;
	/** Tallest the hero grows when the column has room to spare: a bigger body instead of blank panels. */
	static final int HERO_MAX = 150;
	/** An idle agent's hero is taller still: it has nothing else to show. */
	static final int IDLE_HERO_MAX = 190;
	/** An agent with no task and no activity gets one line and task ideas under the hero instead of two empty panels. */
	static final int IDLE_STRIP = 44;
	/** The info block beside the body, with and without a loaded body. */
	static final int INFO_HEIGHT = 92;
	static final int INFO_HEIGHT_NO_BODY = 64;
	private static final int STEP_ROW = 12;
	private static final int EVENT_ROW = 12;

	private static final Identifier HEART_CONTAINER = Identifier.withDefaultNamespace("hud/heart/container");
	private static final Identifier HEART_FULL = Identifier.withDefaultNamespace("hud/heart/full");
	private static final Identifier HEART_HALF = Identifier.withDefaultNamespace("hud/heart/half");
	private static final Identifier FOOD_EMPTY = Identifier.withDefaultNamespace("hud/food_empty");
	private static final Identifier FOOD_FULL = Identifier.withDefaultNamespace("hud/food_full");
	private static final Identifier FOOD_HALF = Identifier.withDefaultNamespace("hud/food_half");
	private static final Identifier ARMOR_EMPTY = Identifier.withDefaultNamespace("hud/armor_empty");
	private static final Identifier ARMOR_FULL = Identifier.withDefaultNamespace("hud/armor_full");
	private static final Identifier ARMOR_HALF = Identifier.withDefaultNamespace("hud/armor_half");
	private static final Identifier HOTBAR = Identifier.withDefaultNamespace("hud/hotbar");
	private static final Identifier HOTBAR_SELECTION = Identifier.withDefaultNamespace("hud/hotbar_selection");
	private static final Identifier SLOT = Identifier.withDefaultNamespace("container/slot");

	record Parts(AgentControlLayout.Bounds hero, AgentControlLayout.Bounds mission, AgentControlLayout.Bounds activity) {
	}

	/**
	 * What the screen hands over each frame: everything already read, so drawing reads no game state of its own.
	 * {@code actionsWidth} is the room the screen's Pause, Respawn and Manage buttons take at the hero's top right.
	 */
	record Frame(AgentControlAgent agent, AgentBody body, JsonObject live, String inState, String attention,
			int attentionColor, int actionsWidth, float mouseX, float mouseY) {
	}

	private final Font font;

	BoardLiveView(Font font) {
		this.font = font;
	}

	/** Height the view needs for every part at its smallest; a shorter column scrolls. */
	static int naturalHeight(int width) {
		int panels = width >= SIDE_BY_SIDE ? SIDE_PANELS : STACK_MISSION + GAP + STACK_ACTIVITY;
		return HERO + GAP + panels;
	}

	static Parts parts(AgentControlLayout.Bounds live, boolean idle) {
		int left = live.left(), right = live.right();
		int room = live.height() - GAP;
		if (idle) {
			// Hero and its one strip sit as one block a little above the middle, so a quiet agent reads as a scene, not a void.
			int heroHeight = Math.clamp(room - IDLE_STRIP, HERO, IDLE_HERO_MAX);
			int block = heroHeight + GAP + IDLE_STRIP;
			int top = live.top() + Math.max(0, (live.height() - block) * 2 / 5);
			AgentControlLayout.Bounds hero = new AgentControlLayout.Bounds(left, top, right, top + heroHeight);
			int stripTop = hero.bottom() + GAP;
			return new Parts(hero, new AgentControlLayout.Bounds(left, stripTop, right, stripTop + IDLE_STRIP),
					new AgentControlLayout.Bounds(left, live.bottom(), right, live.bottom()));
		}
		int heroHeight = Math.clamp(room * 40 / 100, HERO, HERO_MAX);
		AgentControlLayout.Bounds hero = new AgentControlLayout.Bounds(left, live.top(), right, live.top() + heroHeight);
		int top = hero.bottom() + GAP;
		int bottom = Math.max(top, live.bottom());
		if (live.width() >= SIDE_BY_SIDE) {
			int split = left + (live.width() - GAP) * 42 / 100;
			return new Parts(hero, new AgentControlLayout.Bounds(left, top, split, bottom),
					new AgentControlLayout.Bounds(split + GAP, top, right, bottom));
		}
		int missionBottom = Math.min(bottom, top + Math.max(STACK_MISSION, (bottom - top - GAP) * 45 / 100));
		return new Parts(hero, new AgentControlLayout.Bounds(left, top, right, missionBottom),
				new AgentControlLayout.Bounds(left, Math.min(bottom, missionBottom + GAP), right, bottom));
	}

	/** Width of the body's stand at the hero's left. */
	static int stageWidth(AgentControlLayout.Bounds hero) {
		return Math.clamp(hero.height() * 6 / 10, 56, Math.max(56, hero.width() / 4));
	}

	/** Left edge of the name and vitals beside the body. */
	static int infoLeft(AgentControlLayout.Bounds hero) {
		return hero.left() + stageWidth(hero) + 14;
	}

	/** Top of the name line, the info block centred on the body; the screen lines its buttons up with it. */
	static int infoTop(AgentControlLayout.Bounds hero, boolean body) {
		int height = body ? INFO_HEIGHT : INFO_HEIGHT_NO_BODY;
		return hero.top() + Math.max(2, (hero.height() - height) / 2);
	}

	void render(GuiGraphicsExtractor graphics, AgentControlLayout.Bounds view, AgentControlLayout.Bounds live, Frame frame) {
		boolean idle = idle(frame);
		Parts parts = parts(live, idle);
		graphics.enableScissor(view.left(), view.top(), view.right(), view.bottom());
		try {
			hero(graphics, parts.hero(), frame);
			if (idle) {
				ready(graphics, parts.mission(), frame);
				return;
			}
			int divider = parts.hero().bottom() + GAP / 2;
			ConsoleDraw.hairline(graphics, live.left(), live.right(), divider, ConsoleTheme.HAIRLINE);
			mission(graphics, parts.mission(), frame);
			activity(graphics, parts.activity(), frame);
			if (parts.activity().left() > parts.mission().right()) {
				int x = (parts.mission().right() + parts.activity().left()) / 2;
				ConsoleDraw.vhairline(graphics, x, parts.mission().top() + 2, parts.mission().bottom() - 4, ConsoleTheme.HAIRLINE);
			} else if (parts.activity().top() > parts.mission().bottom()) {
				int y = (parts.mission().bottom() + parts.activity().top()) / 2;
				ConsoleDraw.hairline(graphics, live.left(), live.right(), y, ConsoleTheme.HAIRLINE);
			}
		} finally {
			graphics.disableScissor();
		}
	}

	/** Nothing to show in Mission or Activity: no task, plan, decision, events, error or summary. */
	static boolean idle(Frame frame) {
		return frame.agent().currentGoal().isBlank() && frame.agent().lastSummary().isBlank() && frame.attention().isEmpty()
				&& steps(frame.live()).isEmpty() && events(frame.live()).isEmpty() && decision(frame.live()).isEmpty();
	}

	/** The idle strip's line; the screen puts task ideas under it as buttons. */
	private void ready(GuiGraphicsExtractor graphics, AgentControlLayout.Bounds strip, Frame frame) {
		String line = tr("screen.mineagen.board.ready", frame.agent().displayName());
		graphics.text(font, ConsoleText.component(fit(line, strip.width(), false)), strip.left(), strip.top() + 2, ConsoleTheme.MUTED, false);
	}

	/** Where the idle strip's task ideas go: under its line. */
	static int ideasTop(AgentControlLayout.Bounds strip) {
		return strip.top() + 16;
	}

	private void hero(GuiGraphicsExtractor graphics, AgentControlLayout.Bounds hero, Frame frame) {
		AgentControlAgent agent = frame.agent();
		AgentBody body = frame.body();
		int sw = stageWidth(hero);
		int sx = hero.left(), sy = hero.top(), sh = hero.height();
		// The body stands on a soft floor shadow, lit by nothing but the world behind the panel.
		int floorY = sy + sh - 6;
		ConsoleDraw.surface(graphics, sx + sw / 2 - sw * 3 / 10, floorY - 2, sw * 6 / 10, 6, ConsoleDraw.RADIUS_SMALL, 0x2E000000);
		ConsoleDraw.surface(graphics, sx + sw / 2 - sw / 5, floorY - 1, sw * 2 / 5, 4, ConsoleDraw.RADIUS_SMALL, 0x4C000000);
		if (body != null && body.entity() != null) {
			int boxTop = sy + 2, boxBottom = floorY + 1;
			int size = (boxBottom - boxTop) * 30 / 66;
			McClientCompat.entityPreview(graphics, sx, boxTop, sx + sw, boxBottom, size, 0.0625F, frame.mouseX(), frame.mouseY(), body.entity());
		} else {
			int tile = Math.min(40, sw - 12);
			int fx = sx + (sw - tile) / 2, fy = sy + (sh - tile) / 2 - 8;
			AgentFaces.tile(graphics, agent, fx, fy, tile);
			String away = tr("screen.mineagen.board.out_of_view");
			ConsoleDraw.label(graphics, font, away, sx + (sw - ConsoleDraw.labelWidth(font, away)) / 2, fy + tile + 7, ConsoleTheme.SUBTLE);
		}

		int ix = infoLeft(hero);
		int right = hero.right();
		int y = infoTop(hero, body != null);
		// The name, plain and large.
		int nameRoom = (int) ((right - frame.actionsWidth() - 10 - ix) / ConsoleDraw.TITLE_SIZE);
		ConsoleDraw.title(graphics, font, fitStrong(agent.displayName(), nameRoom), ix, y, ConsoleTheme.TEXT);
		y += 19;
		// What it is doing, in its state colour, and for how long.
		AgentControlPresentation.StateCue cue = AgentControlPresentation.stateCue(agent.state());
		int stateColor = ConsoleTheme.stateColor(cue.tone());
		ConsoleDraw.surface(graphics, ix, y + 2, 5, 5, ConsoleDraw.RADIUS_SMALL, stateColor);
		String state = AgentControlPresentation.stateLabel(agent.state());
		graphics.text(font, ConsoleText.strong(state), ix + 9, y, stateColor, false);
		if (!frame.inState().isEmpty()) {
			int after = ix + 9 + ConsoleText.strongWidth(font, state) + 8;
			ConsoleDraw.label(graphics, font, fitLabel(frame.inState(), right - after), after, y + 1, ConsoleTheme.SUBTLE);
		}
		y += 13;
		int x = ix;
		int brand = BrandMarks.draw(graphics, BrandMarks.forProvider(agent.provider()), x, y - 1, BrandMarks.SMALL);
		if (brand > 0) x += brand + 5;
		ConsoleDraw.label(graphics, font, fitLabel(AgentControlPresentation.profileLabel(agent), right - x), x, y + 1, ConsoleTheme.MUTED);
		y += 15;
		if (body == null) {
			for (String line : wrap(tr("screen.mineagen.board.no_body"), right - ix, 2)) {
				graphics.text(font, ConsoleText.component(line), ix, y, ConsoleTheme.SUBTLE, false);
				y += 10;
			}
			return;
		}
		// Hearts, food and armour as the game's own HUD draws them.
		x = ix;
		x = hearts(graphics, x, y, body.health(), body.maxHealth()) + 6;
		if (body.knowsFood() && x + 81 <= right) x = food(graphics, x, y, body.food()) + 6;
		if (body.armor() > 0 && x + 81 <= right) armor(graphics, x, y, body.armor());
		y += 13;
		String place = tr("screen.mineagen.board.coords", body.x(), body.y(), body.z());
		ConsoleDraw.label(graphics, font, place, ix, y, ConsoleTheme.MUTED);
		int px = ix + ConsoleDraw.labelWidth(font, place);
		String dimension = body.dimensionLabel();
		if (!dimension.isEmpty() && px + 14 + ConsoleDraw.labelWidth(font, dimension) <= right) {
			ConsoleDraw.label(graphics, font, "·", px + 4, y, ConsoleTheme.SUBTLE);
			ConsoleDraw.label(graphics, font, dimension, px + 10, y, dimensionColor(body.dimension()));
			px += 10 + ConsoleDraw.labelWidth(font, dimension);
		}
		if (body.level() > 0) {
			String level = tr("screen.mineagen.board.level", body.level());
			if (px + 14 + ConsoleDraw.labelWidth(font, level) <= right) {
				ConsoleDraw.label(graphics, font, "·", px + 4, y, ConsoleTheme.SUBTLE);
				ConsoleDraw.label(graphics, font, level, px + 10, y, 0xFF80FF20);
			}
		}
		y += 12;
		// The hotbar on this PC's own world, else what the client is sent: armour and both hands.
		if (body.knowsHotbar() && right - ix >= 182) {
			graphics.blitSprite(RenderPipelines.GUI_TEXTURED, HOTBAR, ix, y, 182, 22);
			if (body.selectedSlot() >= 0 && body.selectedSlot() < 9) {
				graphics.blitSprite(RenderPipelines.GUI_TEXTURED, HOTBAR_SELECTION, ix - 1 + body.selectedSlot() * 20, y - 1, 24, 23);
			}
			for (int slot = 0; slot < 9; slot++) item(graphics, body.hotbar().get(slot), ix + 3 + slot * 20, y + 3);
		} else if (body.hasEquipment()) {
			int slots = Math.min(body.equipment().size(), Math.max(0, (right - ix) / 18));
			for (int index = 0; index < slots; index++) {
				int slotX = ix + index * 18;
				graphics.blitSprite(RenderPipelines.GUI_TEXTURED, SLOT, slotX, y + 2, 18, 18);
				item(graphics, body.equipment().get(index), slotX + 1, y + 3);
			}
		}
	}
	private void item(GuiGraphicsExtractor graphics, ItemStack stack, int x, int y) {
		if (stack == null || stack.isEmpty()) return;
		graphics.item(stack, x, y);
		graphics.itemDecorations(font, stack, x, y);
	}

	private static int hearts(GuiGraphicsExtractor graphics, int x, int y, float health, float maxHealth) {
		int containers = Math.clamp((int) Math.ceil(maxHealth / 2F), 1, 10);
		int halves = Math.round(health);
		for (int index = 0; index < containers; index++) {
			int hx = x + index * 8;
			graphics.blitSprite(RenderPipelines.GUI_TEXTURED, HEART_CONTAINER, hx, y, 9, 9);
			if (halves >= index * 2 + 2) graphics.blitSprite(RenderPipelines.GUI_TEXTURED, HEART_FULL, hx, y, 9, 9);
			else if (halves == index * 2 + 1) graphics.blitSprite(RenderPipelines.GUI_TEXTURED, HEART_HALF, hx, y, 9, 9);
		}
		return x + containers * 8 + 1;
	}

	private static int food(GuiGraphicsExtractor graphics, int x, int y, int food) {
		for (int index = 0; index < 10; index++) {
			int fx = x + index * 8;
			graphics.blitSprite(RenderPipelines.GUI_TEXTURED, FOOD_EMPTY, fx, y, 9, 9);
			if (food >= index * 2 + 2) graphics.blitSprite(RenderPipelines.GUI_TEXTURED, FOOD_FULL, fx, y, 9, 9);
			else if (food == index * 2 + 1) graphics.blitSprite(RenderPipelines.GUI_TEXTURED, FOOD_HALF, fx, y, 9, 9);
		}
		return x + 81;
	}

	private static int armor(GuiGraphicsExtractor graphics, int x, int y, int armor) {
		for (int index = 0; index < 10; index++) {
			int ax = x + index * 8;
			Identifier sprite = armor >= index * 2 + 2 ? ARMOR_FULL : armor == index * 2 + 1 ? ARMOR_HALF : ARMOR_EMPTY;
			graphics.blitSprite(RenderPipelines.GUI_TEXTURED, sprite, ax, y, 9, 9);
		}
		return x + 81;
	}

	static int dimensionColor(String id) {
		String path = id == null ? "" : id.substring(id.indexOf(':') + 1);
		return switch (path) {
			case "the_nether" -> 0xFFFF7A5C;
			case "the_end" -> 0xFFC79BFF;
			default -> ConsoleTheme.SUCCESS;
		};
	}

	private void heading(GuiGraphicsExtractor graphics, String text, String aside, int left, int right, int y) {
		ConsoleDraw.label(graphics, font, text, left, y, ConsoleTheme.SUBTLE);
		if (!aside.isEmpty()) ConsoleDraw.label(graphics, font, aside, right - ConsoleDraw.labelWidth(font, aside), y, ConsoleTheme.SUBTLE);
	}

	private void mission(GuiGraphicsExtractor graphics, AgentControlLayout.Bounds panel, Frame frame) {
		if (panel.height() < 24) return;
		int left = panel.left(), right = panel.right(), width = right - left;
		int y = panel.top();
		List<Step> steps = steps(frame.live());
		int done = (int) steps.stream().filter(step -> step.status().equals("complete")).count();
		heading(graphics, tr("screen.mineagen.board.mission"), steps.isEmpty() ? "" : tr("screen.mineagen.board.plan_progress", done, steps.size()),
				left, right, y);
		y += 13;
		AgentControlAgent agent = frame.agent();
		boolean noTask = agent.currentGoal().isBlank();
		List<String> goal = wrap(noTask ? tr("screen.mineagen.board.no_task") : agent.currentGoal(), width, 2);
		for (String line : goal) {
			graphics.text(font, noTask ? ConsoleText.component(line) : ConsoleText.strong(line), left, y, noTask ? ConsoleTheme.MUTED : ConsoleTheme.TEXT, false);
			y += 10;
		}
		y += 4;
		if (steps.isEmpty()) {
			if (!noTask) graphics.text(font, ConsoleText.component(tr("screen.mineagen.board.no_plan")), left, y, ConsoleTheme.SUBTLE, false);
			return;
		}
		graphics.fill(left, y, right, y + 2, 0x14FFFFFF);
		if (done > 0) graphics.fill(left, y, left + Math.max(2, width * done / steps.size()), y + 2, ConsoleTheme.ACCENT);
		y += 9;
		int capacity = Math.max(0, (panel.bottom() - 2 - y) / STEP_ROW);
		if (capacity == 0) return;
		int active = 0;
		for (int index = 0; index < steps.size(); index++) {
			if (steps.get(index).status().equals("active")) {
				active = index;
				break;
			}
			if (steps.get(index).status().equals("complete")) active = Math.min(steps.size() - 1, index + 1);
		}
		boolean overflow = steps.size() > capacity;
		int shown = overflow ? Math.max(1, capacity - 1) : steps.size();
		int start = overflow ? Math.clamp(active - shown / 3, 0, steps.size() - shown) : 0;
		for (int index = start; index < start + shown; index++) {
			Step step = steps.get(index);
			boolean current = step.status().equals("active");
			int color = switch (step.status()) {
				case "complete" -> ConsoleTheme.SUBTLE;
				case "active" -> ConsoleTheme.TEXT;
				case "lost" -> ConsoleTheme.ERROR;
				default -> ConsoleTheme.MUTED;
			};
			switch (step.status()) {
				case "complete" -> ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHECK, left, y - 1, 9, ConsoleTheme.SUBTLE);
				case "active" -> ConsoleDraw.surface(graphics, left + 2, y + 1, 5, 5, ConsoleDraw.RADIUS_SMALL, ConsoleTheme.ACCENT);
				case "lost" -> ConsoleDraw.surface(graphics, left + 2, y + 1, 5, 5, ConsoleDraw.RADIUS_SMALL, ConsoleTheme.ERROR);
				default -> ConsoleDraw.ring(graphics, left + 2, y + 1, 5, 5, ConsoleDraw.RADIUS_SMALL, ConsoleDraw.withAlpha(ConsoleTheme.SUBTLE, 0.8F));
			}
			String label = fit(step.label(), width - 14, current);
			graphics.text(font, current ? ConsoleText.strong(label) : ConsoleText.component(label), left + 14, y, color, false);
			y += STEP_ROW;
		}
		if (overflow) {
			int hidden = steps.size() - shown;
			ConsoleDraw.label(graphics, font, tr("screen.mineagen.board.more_steps", hidden), left + 14, y + 1, ConsoleTheme.SUBTLE);
		}
	}

	private void activity(GuiGraphicsExtractor graphics, AgentControlLayout.Bounds panel, Frame frame) {
		if (panel.height() < 24) return;
		int left = panel.left(), right = panel.right(), width = right - left;
		int bottom = panel.bottom();
		int y = panel.top();
		JsonObject live = frame.live();
		heading(graphics, tr("screen.mineagen.board.activity"), usage(live), left, right, y);
		y += 13;
		if (!frame.attention().isEmpty()) {
			List<String> lines = wrap(frame.attention(), width - 8, 2);
			graphics.fill(left, y - 1, left + 2, y - 3 + lines.size() * 10 + 2, frame.attentionColor());
			for (String line : lines) {
				graphics.text(font, ConsoleText.component(line), left + 8, y, frame.attentionColor(), false);
				y += 10;
			}
			y += 6;
		}
		long now = System.currentTimeMillis();
		int timeColumn = ConsoleDraw.labelWidth(font, "59m") + 8;
		String next = decision(live);
		if (!next.isEmpty() && y + 20 <= bottom) {
			ConsoleDraw.label(graphics, font, tr("screen.mineagen.board.next"), left, y + 1, ConsoleTheme.ACCENT);
			List<String> lines = wrap(next, width - timeColumn, 2);
			for (String line : lines) {
				graphics.text(font, ConsoleText.component(line), left + timeColumn, y, ConsoleTheme.TEXT, false);
				y += 10;
			}
			y += 4;
		}
		List<Event> events = events(live);
		if (events.isEmpty()) {
			if (next.isEmpty()) {
				String summary = frame.agent().lastSummary();
				boolean none = summary.isBlank();
				for (String line : wrap(none ? tr("screen.mineagen.board.no_activity") : summary, width, Math.max(1, (bottom - y) / 10))) {
					graphics.text(font, ConsoleText.component(line), left, y, none ? ConsoleTheme.SUBTLE : ConsoleTheme.MUTED, false);
					y += 10;
				}
			}
			return;
		}
		for (Event event : events) {
			if (y + EVENT_ROW > bottom + 2) break;
			String when = event.at() > 0 ? since(now - event.at()) : "";
			if (!when.isEmpty()) ConsoleDraw.label(graphics, font, when, left, y + 1, ConsoleTheme.SUBTLE);
			String repeats = event.repeats() > 1 ? "  x" + event.repeats() : "";
			int repeatsWidth = repeats.isEmpty() ? 0 : ConsoleDraw.labelWidth(font, repeats);
			String message = fit(event.message(), width - timeColumn - repeatsWidth, false);
			graphics.text(font, ConsoleText.component(message), left + timeColumn, y, event.color(), false);
			if (!repeats.isEmpty()) {
				ConsoleDraw.label(graphics, font, repeats, left + timeColumn + ConsoleText.width(font, message), y + 1, ConsoleTheme.SUBTLE);
			}
			y += EVENT_ROW;
		}
	}
	record Step(String label, String status) {
	}

	/** The live plan's steps in order; empty with no plan. */
	static List<Step> steps(JsonObject live) {
		List<Step> steps = new ArrayList<>();
		if (live == null || !(live.get("plan") instanceof JsonObject plan) || !plan.has("steps") || !plan.get("steps").isJsonArray()) return steps;
		for (JsonElement element : plan.getAsJsonArray("steps")) {
			if (!(element instanceof JsonObject step)) continue;
			String label = string(step, "label");
			if (label.isEmpty()) label = string(step, "detail");
			if (label.isEmpty()) label = string(step, "id");
			if (label.isEmpty()) continue;
			String status = string(step, "status");
			steps.add(new Step(label, status.isEmpty() ? "pending" : status.toLowerCase(Locale.ROOT)));
		}
		return steps;
	}

	record Event(ActivityText.Kind kind, String message, int color, long at, int repeats) {
		boolean thought() {
			return kind == ActivityText.Kind.THOUGHT;
		}
	}

	/**
	 * Recent events, newest first, in words ({@link ActivityText}): plumbing is dropped, and the same line repeated
	 * back to back ("Mining iron ore" five times) shows once with its count.
	 */
	static List<Event> events(JsonObject live) {
		List<Event> events = new ArrayList<>();
		if (live == null || !live.has("events") || !live.get("events").isJsonArray()) return events;
		for (JsonElement element : live.getAsJsonArray("events")) {
			if (!(element instanceof JsonObject event)) continue;
			ActivityText.Line line = ActivityText.of(string(event, "stage"), string(event, "message"));
			if (line == null) continue;
			long at = event.has("at") && event.get("at").isJsonPrimitive() && event.get("at").getAsJsonPrimitive().isNumber()
					? event.get("at").getAsLong() : 0L;
			if (!events.isEmpty() && events.getLast().message().equals(line.text())) {
				Event last = events.removeLast();
				events.add(new Event(last.kind(), last.message(), last.color(), Math.max(at, last.at()), last.repeats() + 1));
				continue;
			}
			events.add(new Event(line.kind(), line.text(), kindColor(line.kind()), at, 1));
		}
		java.util.Collections.reverse(events);
		return events;
	}

	static int kindColor(ActivityText.Kind kind) {
		return switch (kind) {
			case ACTION -> ConsoleTheme.TEXT;
			case THOUGHT, LIFE -> ConsoleTheme.MUTED;
			case SAID -> 0xFFB9E6C6;
			case WARNING -> ConsoleTheme.WARNING;
			case ERROR -> ConsoleTheme.ERROR;
		};
	}

	/** The coordinator's next action and why, from the live decision; empty when it has none. */
	static String decision(JsonObject live) {
		if (live == null || !(live.get("decision") instanceof JsonObject decision)) return "";
		String action = string(decision, "action");
		String purpose = string(decision, "purpose");
		if (action.isEmpty()) return purpose;
		return purpose.isEmpty() ? action : action + ": " + purpose;
	}

	/** Thread token totals ("12.4k in  3.1k out"); empty when the live view carries no usage. */
	static String usage(JsonObject live) {
		if (live == null || !(live.get("usage") instanceof JsonObject usage)) return "";
		long in = number(usage, "inputTokens"), out = number(usage, "outputTokens");
		if (in < 0 && out < 0) return "";
		return tr("screen.mineagen.board.usage", tokens(Math.max(0, in)), tokens(Math.max(0, out)));
	}

	static String tokens(long count) {
		if (count < 1_000L) return Long.toString(count);
		if (count < 1_000_000L) return String.format(Locale.ROOT, "%.1fk", count / 1_000D);
		return String.format(Locale.ROOT, "%.1fM", count / 1_000_000D);
	}

	static String since(long elapsedMs) {
		long seconds = Math.max(0L, elapsedMs / 1000L);
		if (seconds < 60L) return seconds + "s";
		if (seconds < 3600L) return (seconds / 60L) + "m";
		return (seconds / 3600L) + "h";
	}

	private static long number(JsonObject object, String key) {
		JsonElement value = object.get(key);
		return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber() ? value.getAsLong() : -1L;
	}

	private static String string(JsonObject object, String key) {
		JsonElement value = object.get(key);
		return value != null && value.isJsonPrimitive() ? value.getAsString().trim() : "";
	}

	private static String tr(String key, Object... args) {
		return Component.translatable(key, args).getString();
	}

	private List<String> wrap(String text, int width, int maxLines) {
		List<String> lines = AgentControlResult.wrap(text, Math.max(8, width), value -> ConsoleText.width(font, value));
		if (lines.size() <= maxLines) return lines;
		List<String> capped = new ArrayList<>(lines.subList(0, maxLines));
		capped.set(maxLines - 1, fit(capped.get(maxLines - 1) + " " + lines.get(maxLines), width, false));
		return capped;
	}

	private String fit(String value, int available, boolean strong) {
		if (width(value, strong) <= available) return value;
		int end = value.length();
		while (end > 0 && width(value.substring(0, end) + "...", strong) > available) end--;
		return end == 0 ? "" : value.substring(0, end).stripTrailing() + "...";
	}

	private String fitStrong(String value, int available) {
		return fit(value, available, true);
	}

	private String fitLabel(String value, int available) {
		if (ConsoleDraw.labelWidth(font, value) <= available) return value;
		int end = value.length();
		while (end > 0 && ConsoleDraw.labelWidth(font, value.substring(0, end) + "...") > available) end--;
		return end == 0 ? "" : value.substring(0, end) + "...";
	}

	private int width(String value, boolean strong) {
		return strong ? ConsoleText.strongWidth(font, value) : ConsoleText.width(font, value);
	}
}
