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
 * The mission board's centre for the selected agent: a hero card with its body in 3D, its vitals and hotbar, then
 * its mission (goal and live plan steps) and its activity (next decision and recent events). Every value comes from
 * the agent's body as this client sees it ({@link AgentBody}) or the coordinator's live view; a part with no data
 * is left out rather than filled.
 */
final class BoardLiveView {
	static final int HERO = 92;
	static final int GAP = 6;
	static final int BUTTONS = 20;
	/** Centres at least this wide put Mission and Activity side by side. */
	static final int SIDE_BY_SIDE = 360;
	static final int SIDE_PANELS = 118;
	static final int STACK_MISSION = 96;
	static final int STACK_ACTIVITY = 112;
	/** Tallest the hero card grows when the column has room to spare: a bigger body instead of blank panels. */
	static final int HERO_MAX = 150;
	/** An agent with no task and no activity gets one strip under the hero instead of two empty panels. */
	static final int IDLE_STRIP = 40;
	static final int CARD = 0x8C141A23;
	static final int CARD_EDGE = 0x1CFFFFFF;
	static final int HIGHLIGHT = 0x24FFFFFF;
	private static final int STEP_ROW = 12;
	private static final int EVENT_ROW = 11;

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

	/** What the screen hands over each frame: everything already read, so drawing reads no game state of its own. */
	record Frame(AgentControlAgent agent, AgentBody body, JsonObject live, int accent, String inState, String attention,
			int attentionColor, float mouseX, float mouseY) {
	}

	private final Font font;

	BoardLiveView(Font font) {
		this.font = font;
	}

	/** Height the view wants when it is not given a column to fill (folded under the rail at high GUI scales). */
	static int naturalHeight(int width) {
		int panels = width >= SIDE_BY_SIDE ? SIDE_PANELS : STACK_MISSION + GAP + STACK_ACTIVITY;
		return HERO + GAP + panels + GAP + BUTTONS;
	}

	static Parts parts(AgentControlLayout.Bounds live, boolean idle) {
		int left = live.left(), right = live.right();
		int room = live.height() - BUTTONS - GAP * 2;
		int heroHeight = idle ? Math.max(HERO, room - IDLE_STRIP - GAP)
				: Math.clamp(room * 38 / 100, HERO, HERO_MAX);
		AgentControlLayout.Bounds hero = new AgentControlLayout.Bounds(left, live.top(), right, live.top() + heroHeight);
		int top = hero.bottom() + GAP;
		int bottom = Math.max(top, live.bottom() - BUTTONS - GAP);
		if (idle) {
			return new Parts(hero, new AgentControlLayout.Bounds(left, top, right, Math.min(bottom, top + IDLE_STRIP)),
					new AgentControlLayout.Bounds(left, bottom, right, bottom));
		}
		if (live.width() >= SIDE_BY_SIDE) {
			int split = left + (live.width() - GAP) * 40 / 100;
			return new Parts(hero, new AgentControlLayout.Bounds(left, top, split, bottom),
					new AgentControlLayout.Bounds(split + GAP, top, right, bottom));
		}
		int missionBottom = Math.min(bottom, top + Math.max(STACK_MISSION, (bottom - top - GAP) * 45 / 100));
		return new Parts(hero, new AgentControlLayout.Bounds(left, top, right, missionBottom),
				new AgentControlLayout.Bounds(left, Math.min(bottom, missionBottom + GAP), right, bottom));
	}

	void render(GuiGraphicsExtractor graphics, AgentControlLayout.Bounds view, AgentControlLayout.Bounds live, Frame frame) {
		Parts parts = parts(live, idle(frame));
		graphics.enableScissor(view.left(), view.top(), view.right(), view.bottom());
		try {
			hero(graphics, parts.hero(), frame);
			mission(graphics, parts.mission(), frame);
			activity(graphics, parts.activity(), frame);
		} finally {
			graphics.disableScissor();
		}
	}

	/** Nothing to show in Mission or Activity: no task, plan, decision, events, error or summary. */
	static boolean idle(Frame frame) {
		return frame.agent().currentGoal().isBlank() && frame.agent().lastSummary().isBlank() && frame.attention().isEmpty()
				&& steps(frame.live()).isEmpty() && events(frame.live()).isEmpty() && decision(frame.live()).isEmpty();
	}

	/** Translucent glass: a dark fill, a faint edge and a one-pixel highlight along the top. */
	static void glass(GuiGraphicsExtractor graphics, AgentControlLayout.Bounds bounds, int fill) {
		int x = bounds.left(), y = bounds.top(), w = bounds.width(), h = bounds.height();
		if (w <= 0 || h <= 0) return;
		ConsoleDraw.surface(graphics, x, y, w, h, ConsoleDraw.RADIUS_CARD, fill);
		ConsoleDraw.ring(graphics, x, y, w, h, ConsoleDraw.RADIUS_CARD, CARD_EDGE);
		graphics.fill(x + ConsoleDraw.RADIUS_CARD, y, x + w - ConsoleDraw.RADIUS_CARD, y + 1, HIGHLIGHT);
	}

	/** A soft glow in {@code color}: rings fading outward from the card's edge. */
	static void glow(GuiGraphicsExtractor graphics, AgentControlLayout.Bounds bounds, int color) {
		float[] alphas = {0.42F, 0.16F, 0.07F};
		for (int ring = 0; ring < alphas.length; ring++) {
			int grow = ring;
			ConsoleDraw.ring(graphics, bounds.left() - grow, bounds.top() - grow, bounds.width() + grow * 2, bounds.height() + grow * 2,
					ConsoleDraw.RADIUS_CARD + grow, ConsoleDraw.withAlpha(color, alphas[ring]));
		}
	}

	private void hero(GuiGraphicsExtractor graphics, AgentControlLayout.Bounds hero, Frame frame) {
		AgentControlAgent agent = frame.agent();
		AgentBody body = frame.body();
		glow(graphics, hero, frame.accent());
		glass(graphics, hero, CARD);
		// The stage: a spotlight in the accent colour rising from the floor, with the body or its face on it.
		int sh = hero.height() - 10;
		int stageWidth = Math.max(hero.width() < 300 ? 60 : 74, Math.min(sh * 7 / 10, hero.width() / 4));
		int sx = hero.left() + 5, sy = hero.top() + 5, sw = stageWidth;
		ConsoleDraw.surface(graphics, sx, sy, sw, sh, ConsoleDraw.RADIUS_CONTROL, 0x66070A0F);
		graphics.fillGradient(sx + 2, sy + sh / 4, sx + sw - 2, sy + sh - 2, ConsoleDraw.withAlpha(frame.accent(), 0F),
				ConsoleDraw.withAlpha(frame.accent(), 0.30F));
		graphics.fill(sx + 8, sy + sh - 2, sx + sw - 8, sy + sh - 1, ConsoleDraw.withAlpha(frame.accent(), 0.55F));
		ConsoleDraw.surface(graphics, sx + sw / 2 - 15, sy + sh - 9, 30, 5, ConsoleDraw.RADIUS_SMALL, 0x80000000);
		if (body != null && body.entity() != null) {
			int boxTop = sy + 4, boxBottom = sy + sh - 5;
			int size = (boxBottom - boxTop) * 30 / 70;
			McClientCompat.entityPreview(graphics, sx, boxTop, sx + sw, boxBottom, size, 0.0625F, frame.mouseX(), frame.mouseY(), body.entity());
		} else {
			int face = 32;
			int fx = sx + (sw - face) / 2, fy = sy + (sh - face) / 2 - 8;
			ConsoleDraw.surface(graphics, fx - 2, fy - 2, face + 4, face + 4, ConsoleDraw.RADIUS_SMALL, 0x90000000);
			if (!AgentFaces.draw(graphics, agent, fx, fy, face)) {
				ConsoleDraw.surface(graphics, fx, fy, face, face, ConsoleDraw.RADIUS_SMALL, ConsoleTheme.SURFACE_RAISED);
			}
			String away = tr("screen.mineagen.board.out_of_view");
			ConsoleDraw.label(graphics, font, away, sx + (sw - ConsoleDraw.labelWidth(font, away)) / 2, fy + face + 7, ConsoleTheme.MUTED);
		}

		int ix = sx + sw + 10;
		int right = hero.right() - 8;
		// The info block is about 80 tall; a taller card centres it beside the body.
		int y = hero.top() + 8 + Math.max(0, (hero.height() - 16 - (body == null ? 51 : 80)) / 2);
		// Name in the provider's colour, big; the state as a chip on the right.
		String state = AgentControlPresentation.stateLabel(agent.state());
		AgentControlPresentation.StateCue cue = AgentControlPresentation.stateCue(agent.state());
		int stateColor = ConsoleTheme.stateColor(cue.tone());
		int chipWidth = ConsoleDraw.labelWidth(font, state) + 21;
		int chipX = right - chipWidth;
		ConsoleDraw.surface(graphics, chipX, y, chipWidth, 14, ConsoleDraw.RADIUS_SMALL, ConsoleDraw.withAlpha(stateColor, 0.16F));
		ConsoleDraw.ring(graphics, chipX, y, chipWidth, 14, ConsoleDraw.RADIUS_SMALL, ConsoleDraw.withAlpha(stateColor, 0.35F));
		ConsoleDraw.stateMark(graphics, ConsoleDraw.stateMark(cue), chipX + 4, y + 2, 10);
		ConsoleDraw.label(graphics, font, state, chipX + 17, y + 4, stateColor);
		int nameRoom = (int) ((chipX - 8 - ix) / ConsoleDraw.TITLE_SIZE);
		String name = fitStrong(agent.displayName(), nameRoom);
		ConsoleDraw.title(graphics, font, name, ix, y, ConsoleTheme.rosterProviderColor(agent.provider()));
		y += 18;
		// The model it runs, under the provider's mark, and how long it has been in this state.
		int x = ix;
		int brand = BrandMarks.draw(graphics, BrandMarks.forProvider(agent.provider()), x, y - 1, BrandMarks.SMALL);
		if (brand > 0) x += brand + 4;
		String profile = AgentControlPresentation.profileLabel(agent);
		if (!frame.inState().isEmpty()) profile = profile + "   " + frame.inState();
		ConsoleDraw.label(graphics, font, fitLabel(profile, right - x), x, y + 1, ConsoleTheme.MUTED);
		y += 13;
		if (body == null) {
			String none = tr("screen.mineagen.board.no_body");
			for (String line : wrap(none, right - ix, 2)) {
				graphics.text(font, ConsoleText.component(line), ix, y + 2, ConsoleTheme.SUBTLE, false);
				y += 10;
			}
			return;
		}
		// Hearts, food and armour as the game's own HUD draws them.
		x = ix;
		x = hearts(graphics, x, y, body.health(), body.maxHealth()) + 6;
		if (body.knowsFood() && x + 81 <= right) x = food(graphics, x, y, body.food()) + 6;
		if (body.armor() > 0 && x + 81 <= right) armor(graphics, x, y, body.armor());
		y += 12;
		String place = tr("screen.mineagen.board.coords", body.x(), body.y(), body.z());
		graphics.text(font, ConsoleText.component(place), ix, y, ConsoleTheme.TEXT, false);
		String dimension = body.dimensionLabel();
		if (!dimension.isEmpty()) {
			int dx = ix + ConsoleText.width(font, place) + 8;
			int dimColor = dimensionColor(body.dimension());
			int dw = ConsoleDraw.labelWidth(font, dimension) + 10;
			if (dx + dw <= right) {
				ConsoleDraw.surface(graphics, dx, y - 2, dw, 12, ConsoleDraw.RADIUS_SMALL, ConsoleDraw.withAlpha(dimColor, 0.18F));
				ConsoleDraw.label(graphics, font, dimension, dx + 5, y + 1, dimColor);
			}
		}
		if (body.level() > 0) {
			String level = tr("screen.mineagen.board.level", body.level());
			int lw = ConsoleDraw.labelWidth(font, level);
			if (right - lw > ix + ConsoleText.width(font, place) + 80) ConsoleDraw.label(graphics, font, level, right - lw, y + 1, 0xFF80FF20);
		}
		y += 13;
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

	private void mission(GuiGraphicsExtractor graphics, AgentControlLayout.Bounds panel, Frame frame) {
		if (panel.height() < 24) return;
		glass(graphics, panel, CARD);
		int left = panel.left() + 8, right = panel.right() - 8, width = right - left;
		int y = panel.top() + 7;
		List<Step> steps = steps(frame.live());
		int done = (int) steps.stream().filter(step -> step.status().equals("complete")).count();
		ConsoleDraw.label(graphics, font, tr("screen.mineagen.board.mission").toUpperCase(Locale.ROOT), left, y, ConsoleTheme.SUBTLE);
		if (!steps.isEmpty()) {
			String count = tr("screen.mineagen.board.plan_progress", done, steps.size());
			ConsoleDraw.label(graphics, font, count, right - ConsoleDraw.labelWidth(font, count), y, ConsoleTheme.MUTED);
		}
		y += 12;
		AgentControlAgent agent = frame.agent();
		boolean noTask = agent.currentGoal().isBlank();
		List<String> goal = wrap(noTask ? tr("screen.mineagen.board.no_task") : agent.currentGoal(), width, 2);
		for (String line : goal) {
			graphics.text(font, noTask ? ConsoleText.component(line) : ConsoleText.strong(line), left, y, noTask ? ConsoleTheme.MUTED : ConsoleTheme.TEXT, false);
			y += 10;
		}
		if (noTask && steps.isEmpty()) {
			String hint = tr("screen.mineagen.board.no_task_hint", frame.agent().displayName());
			int hx = Math.max(left + ConsoleText.width(font, goal.getFirst()) + 12, right - ConsoleText.width(font, hint));
			if (hx + ConsoleText.width(font, hint) <= right) graphics.text(font, ConsoleText.component(hint), hx, y - 10, ConsoleTheme.SUBTLE, false);
			return;
		}
		y += 3;
		if (steps.isEmpty()) {
			if (!noTask) graphics.text(font, ConsoleText.component(tr("screen.mineagen.board.no_plan")), left, y, ConsoleTheme.SUBTLE, false);
			return;
		}
		ConsoleDraw.surface(graphics, left, y, width, 4, 2, 0xFF0A0E13);
		if (done > 0) ConsoleDraw.surface(graphics, left, y, Math.max(4, width * done / steps.size()), 4, 2, ConsoleTheme.SUCCESS);
		y += 9;
		int capacity = Math.max(0, (panel.bottom() - 6 - y) / STEP_ROW);
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
			if (current) {
				ConsoleDraw.surface(graphics, left - 4, y - 2, width + 8, STEP_ROW, ConsoleDraw.RADIUS_SMALL, ConsoleDraw.withAlpha(frame.accent(), 0.14F));
			}
			int color = switch (step.status()) {
				case "complete" -> ConsoleTheme.MUTED;
				case "active" -> ConsoleTheme.TEXT;
				case "lost" -> ConsoleTheme.ERROR;
				default -> ConsoleTheme.SUBTLE;
			};
			switch (step.status()) {
				case "complete" -> ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHECK, left, y - 1, 9, ConsoleTheme.SUCCESS);
				case "active" -> ConsoleDraw.icon(graphics, ConsoleDraw.Icon.PLAY, left, y - 1, 9, frame.accent());
				case "lost" -> ConsoleDraw.surface(graphics, left + 2, y + 1, 5, 5, ConsoleDraw.RADIUS_SMALL, ConsoleTheme.ERROR);
				default -> ConsoleDraw.ring(graphics, left + 1, y, 7, 7, ConsoleDraw.RADIUS_SMALL, ConsoleTheme.SUBTLE);
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
		glass(graphics, panel, CARD);
		int left = panel.left() + 8, right = panel.right() - 8, width = right - left;
		int bottom = panel.bottom() - 6;
		int y = panel.top() + 7;
		JsonObject live = frame.live();
		ConsoleDraw.label(graphics, font, tr("screen.mineagen.board.activity").toUpperCase(Locale.ROOT), left, y, ConsoleTheme.SUBTLE);
		String usage = usage(live);
		if (!usage.isEmpty()) ConsoleDraw.label(graphics, font, usage, right - ConsoleDraw.labelWidth(font, usage), y, ConsoleTheme.MUTED);
		y += 12;
		if (!frame.attention().isEmpty()) {
			List<String> lines = wrap(frame.attention(), width - 8, 2);
			int h = lines.size() * 10 + 5;
			ConsoleDraw.surface(graphics, left - 2, y - 2, width + 4, h, ConsoleDraw.RADIUS_SMALL, ConsoleDraw.withAlpha(frame.attentionColor(), 0.14F));
			graphics.fill(left - 2, y - 1, left - 1, y - 3 + h, frame.attentionColor());
			for (String line : lines) {
				graphics.text(font, ConsoleText.component(line), left + 3, y, frame.attentionColor(), false);
				y += 10;
			}
			y += 5;
		}
		String next = decision(live);
		if (!next.isEmpty() && y + 20 <= bottom) {
			String tag = tr("screen.mineagen.board.next").toUpperCase(Locale.ROOT);
			int tagWidth = ConsoleDraw.labelWidth(font, tag) + 8;
			ConsoleDraw.surface(graphics, left, y - 1, tagWidth, 10, ConsoleDraw.RADIUS_SMALL, ConsoleDraw.withAlpha(ConsoleTheme.WARNING, 0.2F));
			ConsoleDraw.label(graphics, font, tag, left + 4, y + 1, ConsoleTheme.WARNING);
			List<String> lines = wrap(next, width - tagWidth - 5, 2);
			for (String line : lines) {
				graphics.text(font, ConsoleText.component(line), left + tagWidth + 5, y, ConsoleTheme.TEXT, false);
				y += 10;
			}
			y += 4;
			graphics.fill(left, y - 2, right, y - 1, 0x14FFFFFF);
			y += 2;
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
		int tagColumn = 0;
		for (Event event : events) tagColumn = Math.max(tagColumn, ConsoleDraw.labelWidth(font, event.tag()));
		tagColumn = Math.min(tagColumn + 6, Math.min(56, width / 4));
		long now = System.currentTimeMillis();
		for (Event event : events) {
			if (y + EVENT_ROW > bottom + 2) break;
			ConsoleDraw.label(graphics, font, fitLabel(event.tag(), tagColumn - 4), left, y + 1, event.color());
			String when = event.at() > 0 ? since(now - event.at()) : "";
			int whenWidth = when.isEmpty() ? 0 : ConsoleDraw.labelWidth(font, when) + 6;
			if (!when.isEmpty()) ConsoleDraw.label(graphics, font, when, right - whenWidth + 6, y + 1, ConsoleTheme.SUBTLE);
			String message = fit(event.message(), width - tagColumn - whenWidth, false);
			graphics.text(font, ConsoleText.component(message), left + tagColumn, y, event.thought() ? ConsoleTheme.MUTED : ConsoleTheme.TEXT, false);
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

	record Event(String tag, String message, int color, long at, boolean thought) {
	}

	/** Recent events, newest first, with the stage shown as a short coloured tag. */
	static List<Event> events(JsonObject live) {
		List<Event> events = new ArrayList<>();
		if (live == null || !live.has("events") || !live.get("events").isJsonArray()) return events;
		for (JsonElement element : live.getAsJsonArray("events")) {
			if (!(element instanceof JsonObject event)) continue;
			String message = string(event, "message").replace('\n', ' ').replace('\r', ' ').trim();
			if (message.isEmpty()) continue;
			String stage = string(event, "stage").replace("live_", "");
			if (stage.isEmpty()) stage = "event";
			boolean thought = stage.equals("delta") || stage.equals("summary") || stage.equals("reasoning");
			String tag = switch (stage) {
				case "delta", "reasoning" -> "thinking";
				case "agent_message", "say", "chat" -> "said";
				default -> stage.replace('_', ' ');
			};
			long at = event.has("at") && event.get("at").isJsonPrimitive() && event.get("at").getAsJsonPrimitive().isNumber()
					? event.get("at").getAsLong() : 0L;
			events.add(new Event(tag, message, stageColor(stage), at, thought));
		}
		java.util.Collections.reverse(events);
		return events;
	}

	static int stageColor(String stage) {
		return switch (stage) {
			case "lifecycle" -> ConsoleTheme.ACCENT;
			case "planner", "decision" -> 0xFFFFC857;
			case "provider" -> 0xFFC79BFF;
			case "agent_message", "say", "chat" -> ConsoleTheme.SUCCESS;
			case "retry" -> ConsoleTheme.WARNING;
			case "error", "failure" -> ConsoleTheme.ERROR;
			case "tool", "action" -> 0xFF7FB2FF;
			default -> ConsoleTheme.SUBTLE;
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
