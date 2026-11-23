package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.agent.AgentConstants;
import dev.agaminggod.mineagen.agent.AgentGameMode;
import dev.agaminggod.mineagen.agent.AgentModelNames;
import dev.agaminggod.mineagen.agent.AgentVisualIdentity;
import dev.agaminggod.mineagen.client.control.AgentControlClient;
import dev.agaminggod.mineagen.client.gui.widget.ConsoleButton;
import dev.agaminggod.mineagen.client.gui.widget.ConsoleChoiceCard;
import dev.agaminggod.mineagen.client.gui.widget.ConsoleDropdown;
import dev.agaminggod.mineagen.client.gui.widget.ConsoleSegmented;
import dev.agaminggod.mineagen.client.gui.widget.ConsoleCycleButton;
import dev.agaminggod.mineagen.client.gui.widget.ConsoleEditBox;
import dev.agaminggod.mineagen.control.AgentControlActions;
import dev.agaminggod.mineagen.control.AgentControlAgent;
import dev.agaminggod.mineagen.control.AgentControlCatalog;
import dev.agaminggod.mineagen.control.AgentControlModelOption;
import dev.agaminggod.mineagen.control.AgentControlCommandBuilder;
import dev.agaminggod.mineagen.control.AgentControlPresentation;
import dev.agaminggod.mineagen.control.AgentControlSelectionState;
import dev.agaminggod.mineagen.control.AgentControlResult;
import dev.agaminggod.mineagen.control.AgentControlSnapshot;
import dev.agaminggod.mineagen.control.AgentNowCard;
import dev.agaminggod.mineagen.control.AgentRosterEntry;
import dev.agaminggod.mineagen.control.AgentRosterFilter;
import dev.agaminggod.mineagen.control.AgentRosterPage;
import dev.agaminggod.mineagen.control.AgentRosterViewState;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import com.mojang.blaze3d.platform.InputConstants;

public final class AgentControlScreen extends Screen {
	private static final int PANEL = ConsoleTheme.PANEL;
	private static final int PANEL_EDGE = ConsoleTheme.BORDER;
	private static final int BACKDROP = ConsoleTheme.BACKDROP;
	private static final int NAV_SURFACE = ConsoleTheme.NAVIGATION;
	private static final int TRACK = ConsoleTheme.TRACK;
	private static final int SURFACE = ConsoleTheme.SURFACE;
	private static final int SURFACE_SELECTED = ConsoleTheme.SURFACE_SELECTED;
	private static final int TEXT = ConsoleTheme.TEXT;
	private static final int MUTED = ConsoleTheme.MUTED;
	private static final int ACCENT = ConsoleTheme.ACCENT;
	private static final int SUCCESS = ConsoleTheme.SUCCESS;
	private static final int ERROR = ConsoleTheme.ERROR;
	private static final int ROW_HEIGHT = AgentControlLayout.CONTROL_HEIGHT;
	private static final int GAP = 6;

	private AgentControlSnapshot snapshot;
	private final Screen parent;
	private String editingKeyProvider = "";
	private String keyDraft = "";
	private ConsoleEditBox keyInput;
	private static final int PROVIDER_KEY_ROW_HEIGHT = 44;
	private static final int TITLE_BLOCK = 44;
	private static final int FORM_GAP = 10;
	private static final int LABEL_HEIGHT = 12;
	// The Now card: one row per line of what the agent is doing, inside a padded card.
	static final int NOW_ROW = 12;
	static final int NOW_PAD = 5;
	static final int NOW_GAP = 6;
	static final int NOW_MAX_ROWS = 4;
	/**
	 * The narrow overview's Now strip, placed with the roster grid when widgets are built. A snapshot can change the
	 * filtered count while a rebuild waits for a focused text box; drawn from fresh numbers, the strip would overlap the
	 * stale grid.
	 */
	private AgentControlLayout.Bounds overviewNow;
	/** How long each agent has been in its state while this client watched, for the Now card's duration. */
	private static final dev.agaminggod.mineagen.control.AgentStateClock STATE_CLOCK = new dev.agaminggod.mineagen.control.AgentStateClock();
	private static final String KEY_BILLING_NOTE = "An API key bills per token. Without one, the tool's signed-in plan is used.";
	private ConsoleDropdown<String> modelDropdown;
	private boolean animateProviderPick;
	/** How far the New agent form is scrolled; only nonzero when the form is taller than the panel (small GUIs). */
	private int createScroll;
	private int createScrollMaximum;
	private final java.util.Set<AbstractWidget> createBodyWidgets = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
	private final List<FormLabel> formLabels = new ArrayList<>();
	private final AgentControlSelectionState managementSelection = new AgentControlSelectionState();
	private final AgentRosterViewState rosterState = new AgentRosterViewState();
	private AgentRosterFilter rosterFilter = AgentRosterFilter.all();
	private List<AgentRosterEntry> rosterEntries = List.of();
	private Map<String, AgentVisualIdentity.Resolved> rosterVisuals = Map.of();
	private AgentRosterGrid rosterGrid;
	private String provider;
	private String model;
	private String reasoning;
	private String serviceTier = "priority";
	private AgentGameMode gameMode = AgentGameMode.SURVIVAL;
	private String name = "";
	private String prompt = "";
	private String feedback = "";
	private boolean feedbackError;
	/** True only when the server confirmed the change; a sent command's "Sending..." line is pending, not success. */
	private boolean feedbackConfirmed;
	/** The newest server command result this screen has shown (or found when it opened), so each shows once. */
	private long seenResultSequence;
	/** Height the status banner reserved when the widgets were last placed; {@link #layout()} pushes content below it. */
	private int builtBannerInset;
	private final SingleSubmissionGate summonSubmission = new SingleSubmissionGate();
	private boolean shownPlanWindowEnabled, shownTerminalEnabled;
	private ConsoleMutationState mutationState = ConsoleMutationState.initial(0L);
	private Page page = Page.OVERVIEW;
	private ConsoleEditBox nameInput;
	private MultiLineEditBox promptInput;
	private boolean widgetRefreshPending;
	private final DeferredRebuild inputRebuild = new DeferredRebuild();
	/** The agent a Task, Manage or Remove page was opened for; those pages close instead of retargeting if it goes. */
	private String pageAgentId = "";

	public AgentControlScreen() {
		this(null);
	}

	public AgentControlScreen(Screen parent) {
		this(parent, Page.OVERVIEW);
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	private AgentControlScreen(Screen parent, Page initialPage) {
		super(Minecraft.getInstance(), ConsoleFont.create(Minecraft.getInstance()),
				Component.translatable("screen.mineagen.controls.title"));
		this.parent = parent;
		this.page = initialPage;
		// Only provider and model are remembered; thinking depth and speed restart at their lowest/Normal defaults.
		AgentControlClient.Preferences preferences = AgentControlClient.preferences();
		CreateSelection normalized = normalizeCreateSelection(preferences.provider(), preferences.model());
		provider = normalized.provider();
		model = normalized.model();
		reasoning = normalized.reasoning();
		serviceTier = normalized.serviceTier();
		AgentControlClient.snapshot().ifPresent(this::replaceSnapshot);
	}

	public void acceptSnapshot(AgentControlSnapshot nextSnapshot) {
		acceptSnapshot(nextSnapshot, 0L, true);
	}

	public void acceptSnapshot(
			AgentControlSnapshot nextSnapshot,
			long acknowledgedMutationId,
			boolean contentChanged
	) {
		AgentControlSnapshot checkedSnapshot = Objects.requireNonNull(nextSnapshot, "nextSnapshot must not be null");
		if (!mutationState.accepts(checkedSnapshot.generatedAtEpochMs())) return;
		acceptSnapshotContent(checkedSnapshot, acknowledgedMutationId, contentChanged);
		// After the content pass, which clears a pending line once the server answers: the answer itself replaces it.
		AgentControlResult result = checkedSnapshot.result();
		if (result != null && result.sequence() > seenResultSequence) {
			seenResultSequence = result.sequence();
			feedback = result.message();
			feedbackError = !result.accepted();
			feedbackConfirmed = result.accepted();
		}
	}

	private void acceptSnapshotContent(AgentControlSnapshot checkedSnapshot, long acknowledgedMutationId, boolean contentChanged) {
		contentChanged = contentChanged || snapshot == null || !snapshot.agents().equals(checkedSnapshot.agents())
				|| !snapshot.catalog().equals(checkedSnapshot.catalog());
		boolean mutationWasPending = mutationState.mutationPending();
		boolean catalogChanged = snapshot == null || !snapshot.catalog().equals(checkedSnapshot.catalog());
		mutationState = mutationState.accept(checkedSnapshot.generatedAtEpochMs(), acknowledgedMutationId);
		if (!contentChanged) {
			snapshot = checkedSnapshot;
			if (mutationWasPending && !mutationState.mutationPending()) {
				// The server's answer may arrive a snapshot before this acknowledgement; keep it rather than blank it.
				if (!feedbackError && !feedbackConfirmed) feedback = "";
				requestWidgetRefresh();
			}
			return;
		}
		AgentControlSnapshot previous = snapshot;
		normalizeCreateSelection();
		List<AgentRosterEntry> candidateEntries = rosterEntries(checkedSnapshot);
		Map<String, AgentVisualIdentity.Resolved> candidateVisuals = rosterVisuals(checkedSnapshot);
		managementSelection.reconcile(checkedSnapshot.agents());
		rosterState.reconcile(candidateEntries);
		snapshot = checkedSnapshot;
		dev.agaminggod.mineagen.client.control.LiveAgentWindows.select(selectedAgent());
		rosterEntries = candidateEntries;
		rosterVisuals = candidateVisuals;
		if (previous != null && snapshot.generatedAtEpochMs() > previous.generatedAtEpochMs() && !feedbackError) {
			feedback = "";
		}
		if (!AgentControlLayout.rosterFiltersVisible(snapshot.agents().size())) {
			setRosterFilterWithoutRebuild(AgentRosterFilter.all());
		} else {
			normalizeRosterFilterOptions();
		}
		rosterState.focus(managementSelection.selectedAgentId());
		if (isAgentPage(page) && pageAgentGone(pageAgentId, snapshot.agents())) {
			// Another operator removed this agent. Selection has already moved to a different agent, so staying here
			// would retarget the open page (and a pending Remove) at someone else.
			page = Page.OVERVIEW;
			pageAgentId = "";
			setFeedback("That agent was removed by someone else. Nothing was changed.", true);
			widgetRefreshPending = true;
			rebuildWidgets();
			return;
		}
		if (catalogChanged && page == Page.CREATE) {
			// The form's dropdown and choices format ids from the catalog; rebuild now even while Name is focused,
			// rather than leave widgets holding ids the new catalog no longer has. Name keeps its text and focus.
			widgetRefreshPending = true;
			rebuildWidgets();
			return;
		}
		requestWidgetRefresh();
	}

	/**
	 * Tab order for a New agent form taller than the panel. Controls scrolled out of view are hidden, and vanilla
	 * Tab skips hidden widgets, so the screen walks the order itself and scrolls the next control into view.
	 */
	private boolean tabThroughScrolledForm(int direction) {
		List<AbstractWidget> ring = children().stream().filter(AbstractWidget.class::isInstance).map(AbstractWidget.class::cast)
				.filter(widget -> widget.active).toList();
		if (ring.isEmpty()) return false;
		int current = getFocused() instanceof AbstractWidget focused ? ring.indexOf(focused) : -1;
		int nextIndex = current < 0 ? (direction > 0 ? 0 : ring.size() - 1) : Math.floorMod(current + direction, ring.size());
		AbstractWidget next = ring.get(nextIndex);
		AgentControlLayout layout = layout();
		int target = createBodyWidgets.contains(next)
				? scrollToReveal(createScroll, next.getY() + createScroll, next.getBottom() + createScroll,
						layout.contentTop(), layout.contentBottom(), createScrollMaximum)
				: createScroll;
		if (target != createScroll) {
			String identity = ConsoleFocusIdentity.of(next);
			createScroll = target;
			rebuildWidgets();
			children().stream().filter(AbstractWidget.class::isInstance).map(AbstractWidget.class::cast)
					.filter(widget -> ConsoleFocusIdentity.of(widget).equals(identity)).findFirst().ifPresent(this::setInitialFocus);
		} else {
			setInitialFocus(next);
		}
		return true;
	}

	/** Scroll offset that brings the span {@code top..bottom} (unscrolled y) fully inside the view, moving as little as possible. */
	static int scrollToReveal(int scroll, int top, int bottom, int viewTop, int viewBottom, int maximum) {
		int next = scroll;
		if (top - next < viewTop) next = top - viewTop;
		else if (bottom - next > viewBottom) next = bottom - viewBottom;
		return Math.clamp(next, 0, Math.max(0, maximum));
	}

	private static boolean isAgentPage(Page page) {
		return page == Page.TASK || page == Page.MANAGE || page == Page.REMOVE_CONFIRM;
	}

	/** True when a page opened for {@code pageAgentId} must close because that agent is no longer in the roster. */
	static boolean pageAgentGone(String pageAgentId, List<AgentControlAgent> agents) {
		if (pageAgentId == null || pageAgentId.isBlank()) return false;
		return agents.stream().noneMatch(agent -> agent.agentId().equals(pageAgentId));
	}

	/** The agent the open Task, Manage or Remove page belongs to, or null if it is gone. */
	private AgentControlAgent pageAgent() {
		if (snapshot == null || pageAgentId.isBlank()) return null;
		return snapshot.agents().stream().filter(agent -> agent.agentId().equals(pageAgentId)).findFirst().orElse(null);
	}

	private void requestWidgetRefresh() {
		// Accept model updates immediately, but retain the live editor until focus leaves it.
		widgetRefreshPending = true;
		if (minecraft != null && !textEditorFocused()) rebuildWidgets();
	}

	private boolean textEditorFocused() {
		return getFocused() instanceof ConsoleEditBox || getFocused() instanceof MultiLineEditBox;
	}

	private void replaceSnapshot(AgentControlSnapshot nextSnapshot) {
		List<AgentRosterEntry> candidateEntries = rosterEntries(nextSnapshot);
		Map<String, AgentVisualIdentity.Resolved> candidateVisuals = rosterVisuals(nextSnapshot);
		managementSelection.reconcile(nextSnapshot.agents());
		rosterState.reconcile(candidateEntries);
		rosterState.focus(managementSelection.selectedAgentId());
		snapshot = nextSnapshot;
		// A result already in the snapshot when the screen opens answers an older command; do not replay it.
		if (nextSnapshot.result() != null) seenResultSequence = nextSnapshot.result().sequence();
		dev.agaminggod.mineagen.client.control.LiveAgentWindows.select(selectedAgent());
		mutationState = ConsoleMutationState.initial(nextSnapshot.generatedAtEpochMs());
		rosterEntries = candidateEntries;
		rosterVisuals = candidateVisuals;
	}

	@Override
	protected void init() {
		widgetRefreshPending = false;
		builtBannerInset = bannerInset(bannerLines().size());
		overviewNow = null;
		nameInput = null;
		promptInput = null;
		rosterGrid = null;
		modelDropdown = null;
		formLabels.clear();
		switch (page) {
			case OVERVIEW -> initOverview();
			case CREATE -> initCreate();
			case KEYS -> initKeys();
			case TASK -> initTask();
			case MANAGE -> initManage();
			case REMOVE_CONFIRM -> initRemoveConfirm();
		}
	}

	@Override
	public void tick() {
		super.tick();
		if (bannerInset(bannerLines().size()) != builtBannerInset) widgetRefreshPending = true;
		if (widgetRefreshPending && minecraft != null && !textEditorFocused()) rebuildWidgets();
		if (page == Page.MANAGE && (shownPlanWindowEnabled != dev.agaminggod.mineagen.client.control.LiveAgentWindows.planEnabled()
				|| shownTerminalEnabled != dev.agaminggod.mineagen.client.control.LiveAgentWindows.terminalEnabled())) rebuildWidgets();
	}

	@Override
	public Component getNarrationMessage() {
		MutableComponent narration = getTitle().copy();
		if (snapshot == null) {
			appendNarration(narration, Component.literal(AgentControlClient.snapshotError()
					.orElse("Loading agent roster")));
		} else if (!snapshot.canControl()) {
			appendNarration(narration, Component.literal("View only. Operator permission is required to make changes"));
		}
		switch (page) {
			case OVERVIEW -> appendAgentNarration(narration, selectedAgent(), true);
			case CREATE -> appendNarration(narration, Component.literal(createNarration(provider, model)));
			case KEYS -> appendNarration(narration, Component.literal("Sign-in and API keys for each model tool"));
			case TASK, MANAGE, REMOVE_CONFIRM -> appendAgentNarration(narration, selectedAgent(), false);
		}
		if (!feedback.isBlank()) appendNarration(narration, Component.literal(feedback));
		return narration;
	}

	// Until the provider scan picks a provider and model there is nothing in the catalog to name, and the
	// catalog throws on an unknown provider, which crashed the game when the screen narrated.
	static String createNarration(String provider, String model) {
		boolean known = provider != null && model != null && !model.isBlank()
				&& AgentControlCatalog.providers().contains(provider.toLowerCase(Locale.ROOT));
		if (!known) return "Create an agent, scanning for providers";
		try {
			return "Create an agent, " + capitalize(provider) + ", " + AgentControlCatalog.displayName(provider, model);
		} catch (IllegalArgumentException unknownModel) {
			return "Create an agent, " + capitalize(provider);
		}
	}

	private void appendAgentNarration(MutableComponent narration, AgentControlAgent agent, boolean detailed) {
		if (agent == null) return;
		String identity = detailed
				? agent.displayName() + ", " + AgentControlPresentation.profileLabel(agent)
				: agent.displayName();
		appendNarration(narration, Component.literal(identity + ", "
				+ AgentControlPresentation.stateLabel(agent.state())));
		if (!detailed) return;
		appendNarration(narration, Component.literal(agent.currentGoal().isBlank()
				? "No current task" : "Task: " + agent.currentGoal()));
		if (!agent.lastError().isBlank()) {
			appendNarration(narration, Component.literal("Needs attention: " + agent.lastError()));
		}
	}


	private static void appendNarration(MutableComponent narration, Component context) {
		if (context == null || context.getString().isBlank()) return;
		narration.append(". ").append(context);
	}

	@Override
	protected void rebuildWidgets() {
		if (!inputRebuild.request()) return;
		String focusKey = getFocused() instanceof AbstractWidget widget ? ConsoleFocusIdentity.of(widget) : "";
		super.rebuildWidgets();
		if (focusKey.isBlank()) return;
		children().stream()
				.filter(AbstractWidget.class::isInstance)
				.map(AbstractWidget.class::cast)
				.filter(widget -> ConsoleFocusIdentity.of(widget).equals(focusKey))
				.findFirst()
				.ifPresent(this::setInitialFocus);
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float partialTick) {
		// While the control center is open the selected agent's live view keeps coming, for its Now card.
		dev.agaminggod.mineagen.client.control.LiveAgentWindows.watch();
		// Every agent, not just the selected one, so a switch back does not show a duration it never watched.
		if (snapshot != null) STATE_CLOCK.observe(snapshot.agents(), System.currentTimeMillis());
		AgentControlLayout layout = layout();
		graphics.fill(0, 0, width, height, BACKDROP);
		int panelWidth = layout.panelRight() - layout.panelLeft();
		int panelHeight = layout.panelBottom() - layout.panelTop();
		ConsoleDraw.shadow(graphics, layout.panelLeft(), layout.panelTop(), panelWidth, panelHeight, 0xB0);
		ConsoleDraw.surface(graphics, layout.panelLeft(), layout.panelTop(), panelWidth, panelHeight, ConsoleDraw.RADIUS_PANEL, PANEL);
		renderShell(graphics);
		renderBanner(graphics);
		renderHeader(graphics);
		renderInputSurfaces(graphics);
		switch (page) {
			case OVERVIEW -> renderOverview(graphics);
			case CREATE -> renderCreate(graphics);
			case KEYS -> renderKeys(graphics);
			case TASK -> renderTask(graphics);
			case MANAGE -> renderManage(graphics);
			case REMOVE_CONFIRM -> renderRemoveConfirm(graphics);
		}
		for (FormLabel label : formLabels) {
			ConsoleDraw.label(graphics, font, label.text(), label.x(), label.y(), MUTED);
		}
		if (rosterGrid != null) rosterGrid.extractRenderState(graphics);
		super.extractRenderState(graphics, mouseX, mouseY, partialTick);
		if (modelDropdown != null) modelDropdown.renderPopup(graphics, mouseX, mouseY);
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent event, boolean doubled) {
		if (modelDropdown != null && modelDropdown.popupClick(event)) return true;
		inputRebuild.enter();
		try {
			return super.mouseClicked(event, doubled);
		} finally {
			if (inputRebuild.exit()) rebuildWidgets();
		}
	}

	@Override
	public boolean mouseScrolled(double mouseX, double mouseY, double horizontalAmount, double verticalAmount) {
		if (modelDropdown != null && modelDropdown.popupScroll(verticalAmount)) return true;
		if (page == Page.CREATE && createScrollMaximum > 0 && verticalAmount != 0) {
			createScroll = Math.clamp(createScroll - (int) Math.signum(verticalAmount) * 24, 0, createScrollMaximum);
			rebuildWidgets();
			return true;
		}
		if (page == Page.OVERVIEW && rosterGrid != null
				&& rosterGrid.mouseScrolled(mouseX, mouseY, horizontalAmount, verticalAmount)) {
			rebuildWidgets();
			return true;
		}
		return super.mouseScrolled(mouseX, mouseY, horizontalAmount, verticalAmount);
	}

	@Override
	public boolean keyPressed(KeyEvent event) {
		if (event.key() == InputConstants.KEY_TAB && page == Page.CREATE && createScrollMaximum > 0) {
			return tabThroughScrolledForm(event.hasShiftDown() ? -1 : 1);
		}
		inputRebuild.enter();
		try {
			return dispatchKey(event);
		} finally {
			if (inputRebuild.exit()) rebuildWidgets();
		}
	}

	private boolean dispatchKey(KeyEvent event) {
		if (event.key() == InputConstants.KEY_ESCAPE) {
			if (modelDropdown != null && modelDropdown.isOpen()) {
				modelDropdown.close();
				return true;
			}
			if (page == Page.OVERVIEW) return super.keyPressed(event);
			navigateBack();
			return true;
		}
		return super.keyPressed(event);
	}

	private void navigateBack() {
		if (page == Page.REMOVE_CONFIRM) {
			show(Page.MANAGE);
			return;
		}
		if (page == Page.KEYS) {
			show(Page.CREATE);
			return;
		}
		show(Page.OVERVIEW);
	}


	@Override
	public void onClose() {
		clearKeyDraft();
		if (minecraft != null && parent != null) dev.agaminggod.mineagen.client.compat.McClientCompat.setScreen(minecraft, parent);
		else super.onClose();
	}

	private void initOverview() {
		AgentControlLayout layout = layout();
		boolean filtersVisible = filtersVisible();
		int top = bodyTop();
		addRosterFilters(layout.canvasLeft(), top, layout.canvasWidth());
		if (layout.splitWorkspace()) {
			addRosterGrid(overviewRosterBounds(layout, filtersVisible), AgentRosterGrid.Mode.FOCUS_ONLY);
			addOverviewActions(layout.contextLeft(), top, layout.contextWidth());
			addOverviewFooter();
		} else {
			int shown = rosterState.page(1).totalFiltered();
			overviewNow = overviewNowBounds(layout, filtersVisible, shown);
			addRosterGrid(overviewRosterBounds(layout, filtersVisible, shown), AgentRosterGrid.Mode.FOCUS_ONLY);
			addCompactOverviewActions(layout.contentLeft(), layout.footerY(), layout.contentWidth());
		}
	}

	private void addRosterFilters(int x, int y, int width) {
		if (!filtersVisible()) return;
		int controlWidth = (width - GAP * 2) / 3;
		ConsoleEditBox query = new ConsoleEditBox(font, x, y, controlWidth, ROW_HEIGHT,
				Component.translatable("screen.mineagen.roster.search"),
				Component.translatable("screen.mineagen.roster.search_hint"), "roster-query");
		query.setMaxLength(80);
		query.setValue(rosterFilter.query());
		query.setResponder(value -> applyRosterFilter(
				new AgentRosterFilter(value, rosterFilter.provider(), rosterFilter.state())));
		addRenderableWidget(query);

		List<String> providers = providerOptions();
		addRenderableWidget(new ConsoleCycleButton<>(
				font, x + controlWidth + GAP, y, controlWidth, ROW_HEIGHT,
				Component.translatable("screen.mineagen.roster.filter.provider"),
				providers, rosterFilter.provider(), value -> value.isBlank()
						? Component.translatable("screen.mineagen.roster.filter.all_providers")
						: Component.literal(capitalize(value)),
				value -> applyRosterFilter(new AgentRosterFilter(rosterFilter.query(), value, rosterFilter.state()))));
		List<String> states = stateOptions();
		int stateX = x + (controlWidth + GAP) * 2;
		addRenderableWidget(new ConsoleCycleButton<>(
				font, stateX, y, x + width - stateX, ROW_HEIGHT,
				Component.translatable("screen.mineagen.roster.filter.status"),
				states, rosterFilter.state(), value -> value.isBlank()
						? Component.translatable("screen.mineagen.roster.filter.all_statuses")
						: Component.literal(value),
				value -> applyRosterFilter(new AgentRosterFilter(rosterFilter.query(), rosterFilter.provider(), value))));
	}

	private void addRosterGrid(AgentControlLayout.Bounds region, AgentRosterGrid.Mode mode) {
		if (snapshot == null || region.width() < 24 || region.height() < 24) return;
		AgentRosterPage probe = rosterState.page(1);
		AgentRosterGridLayout gridLayout;
		try {
			gridLayout = AgentRosterGridLayout.calculate(region.left(), region.top(), region.right(), region.bottom(),
					probe.totalFiltered());
		} catch (IllegalArgumentException tooSmall) {
			return; // a GUI below the design minimum has no room for a tile; the header and actions still work
		}
		AgentRosterPage rosterPage = rosterState.page(Math.max(1, gridLayout.pageSize()));
		Set<String> selected = mode == AgentRosterGrid.Mode.MULTI_SELECT
				? rosterState.selectedIds() : Set.of();
		rosterGrid = new AgentRosterGrid(
				font,
				rosterPage,
				gridLayout,
				selected,
				mode,
				id -> id.equals(rosterState.focusedId()),
				id -> rosterVisuals.get(id),
				new AgentRosterGrid.Actions() {
					@Override
					public void focus(String id) {
						selectAgent(id);
						focusRosterWidget(id);
					}

					@Override
					public void open(String id) {
						selectAgent(id);
						if (mode == AgentRosterGrid.Mode.FOCUS_ONLY) show(Page.MANAGE);
					}

					@Override
					public void toggle(String id) {
						rosterState.toggle(id);
						rebuildWidgets();
					}

					@Override
					public void selectRangeTo(String id) {
						rosterState.selectRangeTo(id);
						rebuildWidgets();
					}

					@Override
					public void selectAll() {
						rosterState.selectAll();
						rebuildWidgets();
					}

					@Override
					public void changePage(int delta) {
						if (delta < 0) rosterState.previousPage(Math.max(1, gridLayout.pageSize()));
						else if (delta > 0) rosterState.nextPage(Math.max(1, gridLayout.pageSize()));
						rebuildWidgets();
					}
				});
		for (AbstractWidget widget : rosterGrid.widgets()) addRenderableWidget(widget);
	}

	private void focusRosterWidget(String id) {
		String identity = "agent-tile:" + id;
		children().stream()
				.filter(AbstractWidget.class::isInstance)
				.map(AbstractWidget.class::cast)
				.filter(widget -> ConsoleFocusIdentity.of(widget).equals(identity))
				.findFirst()
				.ifPresent(this::setInitialFocus);
	}

	private void addOverviewActions(int x, int y, int width) {
		ConsoleButton create = primaryButton("New agent", x, y, width, ROW_HEIGHT, () -> show(Page.CREATE))
				.withIcon(ConsoleDraw.Icon.PLUS);
		create.active = canControl();
		addRenderableWidget(create);
		ConsoleButton task = consoleButton("Give a task", x, y + 30, width, ROW_HEIGHT, false, () -> show(Page.TASK))
				.withIcon(ConsoleDraw.Icon.TASK);
		task.active = canUseAutomation() && selectedAgent() != null;
		addRenderableWidget(task);
		ConsoleButton manage = consoleButton("Manage", x, y + 60, width, ROW_HEIGHT, false,
				() -> show(Page.MANAGE)).withIcon(ConsoleDraw.Icon.AGENTS);
		manage.active = canControl() && selectedAgent() != null;
		addRenderableWidget(manage);
	}

	private void addCompactOverviewActions(int x, int y, int width) {
		int buttonWidth = (width - GAP * 2) / 3;
		ConsoleButton manage = consoleButton("Manage", x, y, buttonWidth, ROW_HEIGHT,
				false, () -> show(Page.MANAGE)).withIcon(ConsoleDraw.Icon.AGENTS);
		manage.active = canControl() && selectedAgent() != null;
		addRenderableWidget(manage);
		ConsoleButton task = consoleButton("Give task", x + buttonWidth + GAP, y, buttonWidth, ROW_HEIGHT,
				false, () -> show(Page.TASK)).withIcon(ConsoleDraw.Icon.TASK);
		task.active = canUseAutomation() && selectedAgent() != null;
		addRenderableWidget(task);
		ConsoleButton create = primaryButton("New agent", x + (buttonWidth + GAP) * 2, y, width - (buttonWidth + GAP) * 2,
				ROW_HEIGHT, () -> show(Page.CREATE)).withIcon(ConsoleDraw.Icon.PLUS);
		create.active = canControl();
		addRenderableWidget(create);
	}

	/** Where a page's controls start: below its title when the panel is tall enough to show one. */
	private int bodyTop() {
		return bodyTop(layout());
	}

	static int bodyTop(AgentControlLayout layout) {
		return layout.contentTop() + (layout.roomy() ? TITLE_BLOCK : 2);
	}

	/** The overview roster region the live screen uses, shared with the layout tests so they measure the real thing. */
	static AgentControlLayout.Bounds overviewRosterBounds(AgentControlLayout layout, boolean filtersVisible) {
		return layout.rosterBounds(bodyTop(layout), filtersVisible, false);
	}

	/** The roster region once a narrow overview's Now strip has its share (see {@link #overviewNowBounds}). */
	static AgentControlLayout.Bounds overviewRosterBounds(AgentControlLayout layout, boolean filtersVisible, int shownAgents) {
		AgentControlLayout.Bounds full = overviewRosterBounds(layout, filtersVisible);
		AgentControlLayout.Bounds now = overviewNowBounds(layout, filtersVisible, shownAgents);
		return now == null ? full : new AgentControlLayout.Bounds(full.left(), full.top(), full.right(), Math.max(full.top(), now.top() - NOW_GAP));
	}

	/**
	 * Where a narrow overview (no context rail, as at 1080p GUI scale 3 or 4) draws the selected agent's Now strip: across
	 * the bottom of the roster region, as many rows (up to {@link #NOW_MAX_ROWS}) as leave the roster grid its rows and
	 * readable tiles, and at least one row while the grid still fits. Null on a wide overview (the rail carries it), with
	 * no agents shown, or when not even one row fits.
	 */
	static AgentControlLayout.Bounds overviewNowBounds(AgentControlLayout layout, boolean filtersVisible, int shownAgents) {
		if (layout.splitWorkspace() || shownAgents <= 0) return null;
		AgentControlLayout.Bounds full = overviewRosterBounds(layout, filtersVisible);
		AgentRosterGridLayout alone = grid(full, full.bottom(), shownAgents);
		if (alone == null) return null;
		for (int rows = NOW_MAX_ROWS; rows >= 1; rows--) {
			int height = rows * NOW_ROW + NOW_PAD * 2;
			AgentRosterGridLayout shared = grid(full, full.bottom() - height - NOW_GAP, shownAgents);
			boolean keepsRoster = shared != null && shared.rows() == alone.rows()
					&& shared.tileHeight() >= Math.min(alone.tileHeight(), READABLE_TILE_HEIGHT);
			if (keepsRoster || rows == 1 && shared != null) {
				return new AgentControlLayout.Bounds(full.left(), full.bottom() - height, full.right(), full.bottom());
			}
		}
		return null;
	}

	/** Roster tiles at least this tall keep the portrait, name and model line (AgentRosterGridLayout's preferred size). */
	private static final int READABLE_TILE_HEIGHT = 48;

	private static AgentRosterGridLayout grid(AgentControlLayout.Bounds region, int bottom, int entries) {
		if (bottom <= region.top()) return null;
		try {
			return AgentRosterGridLayout.calculate(region.left(), region.top(), region.right(), bottom, entries);
		} catch (IllegalArgumentException tooSmall) {
			return null;
		}
	}

	/** The Manage page's Now card: below its three rows of controls, down to the footer. Null when no row fits. */
	static AgentControlLayout.Bounds manageNowBounds(AgentControlLayout layout) {
		int top = bodyTop(layout) + 3 * (LABEL_HEIGHT + ROW_HEIGHT + FORM_GAP) - FORM_GAP + NOW_GAP;
		int bottom = Math.min(layout.contentBottom(), top + NOW_MAX_ROWS * NOW_ROW + NOW_PAD * 2);
		if (bottom - top < NOW_ROW + NOW_PAD * 2) return null;
		return new AgentControlLayout.Bounds(layout.contentLeft(), top, layout.contentRight(), bottom);
	}

	/** How many Now rows a card of this height shows. */
	static int nowRowCapacity(int height) {
		return Math.max(0, (height - NOW_PAD * 2) / NOW_ROW);
	}

	private void addFormLabel(String text, int x, int y) {
		formLabels.add(new FormLabel(text, x, y));
	}

	private void initCreate() {
		int bodyStart = children().size();
		// A form rebuilt after a catalog change can be shorter than the old scroll offset; then it restarts once.
		if (createBody(bodyStart)) return;
		addCreateFooter();
	}

	/** Builds the form body; returns true when it had to restart the whole page with a smaller scroll offset. */
	private boolean createBody(int bodyStart) {
		AgentControlLayout layout = layout();
		int x = layout.formLeft();
		int width = layout.formWidth();
		int half = (width - FORM_GAP) / 2;
		int y = bodyTop() - createScroll;
		boolean pickAnimated = animateProviderPick;
		animateProviderPick = false;
		if (!AgentControlCatalog.isEmpty()) normalizeCreateSelection();

		// Brain: one card per model tool found on the server machine; picking a card picks the provider.
		addFormLabel("Brain", x, y + 1);
		addRescanButton(x + width, y - 3);
		y += LABEL_HEIGHT;
		List<dev.agaminggod.mineagen.control.AgentControlProvider> rows = AgentControlCatalog.providerRows();
		int perRow = width >= 360 ? 2 : 1;
		int cardWidth = perRow == 2 ? half : width;
		int cardHeight = 34;
		for (int index = 0; index < rows.size(); index++) {
			var row = rows.get(index);
			int cardX = x + (index % perRow) * (cardWidth + FORM_GAP);
			int cardY = y + (index / perRow) * (cardHeight + 6);
			boolean offered = AgentControlCatalog.providers().contains(row.id());
			boolean chosen = offered && row.id().equals(provider);
			ConsoleChoiceCard card = new ConsoleChoiceCard(font, cardX, cardY, cardWidth, cardHeight,
					providerTitle(row), providerStatus(row), providerStatusColor(row), providerDetail(row),
					ConsoleTheme.providerColor(row.id()), chosen, () -> chooseProvider(row.id())).withMark(providerMark(row.id()));
			if (chosen && pickAnimated) card.animateSelection();
			card.active = canControl() && offered;
			addRenderableWidget(card);
		}
		int cardRows = Math.max(1, (rows.size() + perRow - 1) / perRow);
		y += cardRows * (cardHeight + 6) - 6 + FORM_GAP;
		if (AgentControlCatalog.isEmpty()) {
			emptyCreateTop = y;
			return finishCreateBody(bodyStart, y + 30);
		}

		addFormLabel("Model", x, y);
		addFormLabel("Thinking", x + half + FORM_GAP, y);
		y += LABEL_HEIGHT;
		List<String> models = AgentControlCatalog.models(provider);
		String dropdownProvider = provider;
		modelDropdown = new ConsoleDropdown<>(font, x, y, half, 22, "Model", models, model,
				value -> safeDisplayName(dropdownProvider, value), value -> {
					model = value;
					reasoning = AgentControlCatalog.defaultReasoning(provider, model);
					serviceTier = AgentControlCatalog.defaultServiceTier(provider, model);
					rememberPreferences();
					rebuildWidgets();
				}, this.width, height);
		modelDropdown.active = canControl();
		addRenderableWidget(modelDropdown);
		addChoice(x + half + FORM_GAP, y, width - half - FORM_GAP, "Thinking", AgentControlCatalog.reasoningEfforts(provider, model),
				reasoning, AgentControlScreen::capitalize, value -> reasoning = value, true, canControl());
		y += 22 + FORM_GAP;

		addFormLabel("Speed", x, y);
		addFormLabel("Plays in", x + half + FORM_GAP, y);
		y += LABEL_HEIGHT;
		if (AgentControlCatalog.hasSpeedMode(provider, model)) {
			String speedProvider = provider;
			addChoice(x, y, half, "Speed", AgentControlCatalog.serviceTiers(provider, model), serviceTier,
					value -> AgentControlPresentation.speedLabel(speedProvider, value), value -> serviceTier = value, true, canControl());
		} else {
			ConsoleSegmented<String> speed = new ConsoleSegmented<>(font, x, y, half, 22, "Speed", List.of("normal"), "normal",
					value -> "Normal", value -> { });
			speed.active = false;
			speed.setTooltip(net.minecraft.client.gui.components.Tooltip.create(
					Component.translatable("screen.mineagen.speed_unavailable")));
			addRenderableWidget(speed);
		}
		addChoice(x + half + FORM_GAP, y, width - half - FORM_GAP, "Game mode", List.of(AgentGameMode.values()), gameMode,
				AgentGameMode::displayName, value -> gameMode = value, false, canControl());
		y += 22 + FORM_GAP;

		addFormLabel("Name", x, y);
		y += LABEL_HEIGHT;
		nameInput = consoleEditBox(x, y, width, 22, "agent-name", Component.literal("Optional. We'll pick one if you leave it empty"));
		nameInput.setMaxLength(AgentConstants.MAX_USER_NAME_LENGTH);
		nameInput.setValue(name);
		nameInput.setResponder(value -> name = value);
		addRenderableWidget(nameInput);
		return finishCreateBody(bodyStart, y + 22);
	}

	/**
	 * On GUIs too short for the whole form (320x240, scale 4 on small screens) the body scrolls with the mouse wheel:
	 * controls outside the content area hide, and a chevron under the form says more is below.
	 */
	private boolean finishCreateBody(int bodyStart, int formBottom) {
		AgentControlLayout layout = layout();
		createScrollMaximum = Math.max(0, formBottom + createScroll - layout.contentBottom());
		if (createScroll > createScrollMaximum) {
			createScroll = createScrollMaximum;
			rebuildWidgets();
			return true;
		}
		createBodyWidgets.clear();
		for (var child : children().subList(bodyStart, children().size())) {
			if (child instanceof AbstractWidget widget) {
				widget.visible = widget.getY() >= layout.contentTop() && widget.getBottom() <= layout.contentBottom();
				createBodyWidgets.add(widget);
			}
		}
		formLabels.removeIf(label -> label.y() < layout.contentTop() || label.y() + 8 > layout.contentBottom());
		return false;
	}

	/**
	 * A segmented control when every option's label fits its segment; otherwise (many thinking levels on a narrow
	 * GUI) a cycle control, so labels never overlap a neighbour's click target.
	 */
	private <T> void addChoice(int x, int y, int width, String label, List<T> values, T current,
			java.util.function.Function<T, String> formatter, java.util.function.Consumer<T> changed, boolean ranked, boolean active) {
		AbstractWidget widget;
		if (ConsoleSegmented.fits(font, width, values, formatter)) {
			widget = new ConsoleSegmented<>(font, x, y, width, 22, label, values, current, formatter, changed);
		} else if (ranked) {
			widget = ConsoleCycleButton.ranked(font, x, y, width, 22, Component.literal(label), values, current,
					value -> Component.literal(formatter.apply(value)), changed);
		} else {
			widget = new ConsoleCycleButton<>(font, x, y, width, 22, Component.literal(label), values, current,
					value -> Component.literal(formatter.apply(value)), changed);
		}
		widget.active = active;
		addRenderableWidget(widget);
	}

	/** A model's display name, or its id once a catalog refresh has dropped it, so an old widget never throws. */
	static String safeDisplayName(String provider, String model) {
		try {
			return AgentControlCatalog.displayName(provider, model);
		} catch (IllegalArgumentException missing) {
			return model;
		}
	}

	/** Top of the message shown in place of the form when no tool offers a model yet. */
	private int emptyCreateTop;

	private void chooseProvider(String id) {
		if (id.equals(provider)) return;
		provider = id;
		model = AgentControlCatalog.defaultModel(provider);
		reasoning = AgentControlCatalog.defaultReasoning(provider, model);
		serviceTier = AgentControlCatalog.defaultServiceTier(provider, model);
		rememberPreferences();
		animateProviderPick = true;
		rebuildWidgets();
	}

	/** Small Rescan action whose text ends at {@code right}, on the same line as a field label. */
	private void addRescanButton(int right, int y) {
		int width = ConsoleButton.fittedWidth(font, "Rescan", true, true);
		// Compact layouts start the body right at the content top; keep the unscrolled button inside it so it is never
		// clipped. Once the form scrolls, the button scrolls away with the Brain label like any other control.
		int top = createScroll == 0 ? Math.max(layout().contentTop(), y) : y;
		ConsoleButton rescan = ghostButton("Rescan", right - width + 8, top, width, 14, () -> {
			AgentControlClient.requestProviderRescan();
			setFeedback("Checking the server machine for model tools...", false);
		}).withIcon(ConsoleDraw.Icon.REFRESH).small();
		rescan.active = canControl();
		rescan.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal(
				"Check the server machine again for model tools, how they sign in and their models. Starts no model calls.")));
		addRenderableWidget(rescan);
	}


	private void initKeys() {
		AgentControlLayout layout = layout();
		int x = layout.formLeft();
		int width = layout.formWidth();
		int y = bodyTop();
		boolean localKeys = AgentControlClient.canSaveProviderApiKey();
		addRescanButton(x + width, y - 3);
		y += LABEL_HEIGHT + 2;
		for (var row : AgentControlCatalog.providerRows()) {
			String id = row.id();
			boolean editing = editingKeyProvider.equals(id);
			ConsoleButton action = consoleButton(editing ? "Cancel" : row.apiKeySuffix() == null ? "Add API key" : "Remove key",
					x + width - 104, y + 9, 96, 22, false, () -> {
						if (editing) { clearKeyDraft(); rebuildWidgets(); }
						else if (row.apiKeySuffix() != null) submitProviderKey(id, "");
						else { clearKeyDraft(); editingKeyProvider = id; rebuildWidgets(); }
					});
			// A missing tool can't use a new key, but a key saved earlier must stay removable.
			action.active = canControl() && (editing || localKeys)
					&& (row.apiKeySuffix() != null || !Boolean.FALSE.equals(row.installed()));
			action.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal(keyStatusLine(row) + ". " + (localKeys
					? "A key set in the server's environment overrides a key saved here."
					: AgentControlClient.LOCAL_KEY_ONLY_REASON + " On a dedicated server, use the tool's own login or environment variables there."))));
			addRenderableWidget(action);
			if (editing) {
				keyInput = new ConsoleEditBox(font, x + 8, y + 42, width - 90, 22,
						Component.literal("API key"), Component.literal("Paste API key"), "provider-api-key");
				keyInput.maskSecret();
				keyInput.setMaxLength(512);
				keyInput.setValue(keyDraft);
				keyInput.setResponder(value -> keyDraft = value);
				keyInput.setEditable(canControl());
				addRenderableWidget(keyInput);
				ConsoleButton save = primaryButton("Save", x + width - 76, y + 42, 68, 22, () -> submitProviderKey(id, keyDraft));
				save.active = canControl() && localKeys;
				addRenderableWidget(save);
			}
			y += PROVIDER_KEY_ROW_HEIGHT + (editing ? 30 : 0);
		}
		addBackFooter();
	}

	private void clearKeyDraft() {
		if (keyInput != null) keyInput.setValue("");
		keyInput = null;
		keyDraft = "";
		editingKeyProvider = "";
	}

	private void submitProviderKey(String id, String value) {
		boolean local = AgentControlClient.canSaveProviderApiKey();
		boolean sent = local && AgentControlClient.setProviderApiKey(id, value);
		clearKeyDraft();
		setFeedback(sent ? "Key change sent. Checking the tools again..."
				: local ? "Could not send the key change." : AgentControlClient.LOCAL_KEY_ONLY_REASON, !sent);
		rebuildWidgets();
	}

	private static String providerTitle(dev.agaminggod.mineagen.control.AgentControlProvider row) {
		return row.label();
	}

	/**
	 * How the tool signs in, in the player's words. The account name the coordinator reports is never shown:
	 * the plan or the key's last four characters say enough.
	 */
	static String providerSignIn(dev.agaminggod.mineagen.control.AgentControlProvider row) {
		if (row.apiKeySuffix() != null) return "API key ····" + row.apiKeySuffix();
		if (Boolean.FALSE.equals(row.installed()) || Boolean.FALSE.equals(row.signedIn())) return "";
		if (row.plan() != null && !row.plan().isBlank()) return capitalize(row.plan()) + " plan";
		return Boolean.TRUE.equals(row.signedIn()) ? "Signed in" : "";
	}

	/** One status sentence for a tool's row on the Sign-in & keys page. */
	static String keyStatusLine(dev.agaminggod.mineagen.control.AgentControlProvider row) {
		if (Boolean.FALSE.equals(row.installed())) return "Not installed. An API key can't replace the tool itself";
		if (Boolean.FALSE.equals(row.signedIn()) && row.apiKeySuffix() == null) return "Not signed in. Run the tool's login there, or add an API key";
		String signIn = providerSignIn(row);
		return providerStatus(row) + (signIn.isBlank() ? "" : "  ·  " + signIn);
	}

	private String fitLabel(String value, int available) {
		if (ConsoleDraw.labelWidth(font, value) <= available) return value;
		int end = value.length();
		while (end > 0 && ConsoleDraw.labelWidth(font, value.substring(0, end) + "...") > available) end--;
		return value.substring(0, end) + "...";
	}

	private static String providerDetail(dev.agaminggod.mineagen.control.AgentControlProvider row) {
		List<String> parts = new ArrayList<>();
		String signIn = providerSignIn(row);
		if (!signIn.isBlank()) parts.add(signIn);
		if (row.version() != null) parts.add("v" + row.version());
		return String.join("  ·  ", parts);
	}

	private static String providerStatus(dev.agaminggod.mineagen.control.AgentControlProvider row) {
		if (Boolean.FALSE.equals(row.installed())) return "Not installed";
		if (row.installed() == null) return "Checking...";
		return Boolean.FALSE.equals(row.signedIn()) ? "Not signed in" : "Ready";
	}

	private static int providerStatusColor(dev.agaminggod.mineagen.control.AgentControlProvider row) {
		if (Boolean.FALSE.equals(row.installed())) return ERROR;
		if (row.installed() == null) return ConsoleTheme.SUBTLE;
		return Boolean.FALSE.equals(row.signedIn()) ? ConsoleTheme.WARNING : SUCCESS;
	}

	/** A small glyph per tool so two tools that share an initial still read apart at a glance. */
	private static ConsoleDraw.Icon providerMark(String id) {
		return switch (id) {
			case "codex" -> ConsoleDraw.Icon.TERMINAL;
			case "claude" -> ConsoleDraw.Icon.SPARK;
			default -> null;
		};
	}

	private void renderProviderMark(GuiGraphicsExtractor graphics, String id, String title, int x, int y, int size) {
		int mark = ConsoleTheme.providerColor(id);
		ConsoleDraw.surface(graphics, x, y, size, size, ConsoleDraw.RADIUS_CONTROL, ConsoleDraw.withAlpha(mark, 0.22F));
		ConsoleDraw.Icon icon = providerMark(id);
		if (icon != null) {
			ConsoleDraw.icon(graphics, icon, x + (size - 12) / 2, y + (size - 12) / 2, mark);
			return;
		}
		Component initial = ConsoleText.strong(title.isEmpty() ? "?" : title.substring(0, 1));
		graphics.text(font, initial, x + (size - font.width(initial)) / 2 + 1, y + (size - 8) / 2, mark, false);
	}

	private void renderKeys(GuiGraphicsExtractor graphics) {
		AgentControlLayout layout = layout();
		int x = layout.formLeft();
		int width = layout.formWidth();
		int y = bodyTop();
		ConsoleDraw.label(graphics, font, "Model tools on the server machine", x, y + 1, MUTED);
		y += LABEL_HEIGHT + 2;
		if (AgentControlCatalog.providerRows().isEmpty()) {
			graphics.text(font, ConsoleText.component("No model tool found yet. Install Codex CLI or Claude Code there, then rescan."),
					x, y + 4, MUTED, false);
			y += 24;
		}
		for (var row : AgentControlCatalog.providerRows()) {
			boolean editing = editingKeyProvider.equals(row.id());
			int rowHeight = PROVIDER_KEY_ROW_HEIGHT - 4 + (editing ? 30 : 0);
			ConsoleDraw.surface(graphics, x, y, width, rowHeight, ConsoleDraw.RADIUS_CARD, ConsoleTheme.SURFACE);
			renderProviderMark(graphics, row.id(), row.label(), x + 8, y + 10, 20);
			String title = row.label() + (row.version() == null ? "" : "  v" + row.version());
			graphics.text(font, ConsoleText.strong(fit(title, width - 150)), x + 36, y + 9, TEXT, false);
			ConsoleDraw.surface(graphics, x + 36, y + 24, 4, 4, ConsoleDraw.RADIUS_SMALL, providerStatusColor(row));
			// The line ends before the row's button; the button's tooltip carries the full sentence.
			ConsoleDraw.label(graphics, font, fitLabel(keyStatusLine(row), width - 43 - 112), x + 43, y + 22, MUTED);
			y += PROVIDER_KEY_ROW_HEIGHT + (editing ? 30 : 0);
		}
		// Off the host machine a key cannot be saved at all, so that reason replaces the billing note.
		graphics.textWithWordWrap(font, ConsoleText.component(AgentControlClient.canSaveProviderApiKey()
				? KEY_BILLING_NOTE + " A key set in the server's environment overrides one saved here."
				: AgentControlClient.LOCAL_KEY_ONLY_REASON), x, y + 4, width, ConsoleTheme.SUBTLE);
	}

	private static String ago(long elapsedMs) {
		long seconds = Math.max(0L, elapsedMs / 1000L);
		if (seconds < 90L) return seconds + " s";
		if (seconds < 5400L) return (seconds / 60L) + " min";
		return (seconds / 3600L) + " h";
	}

	private void initTask() {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) {
			show(Page.OVERVIEW);
			return;
		}
		AgentControlLayout layout = layout();
		int x = layout.contentLeft();
		int width = layout.contentWidth();
		// The editor sits 6 px inside its drawn surface (renderInputSurfaces), so inset it by that much.
		int promptY = bodyTop() + 6;
		int promptHeight = Math.max(40, layout.contentBottom() - promptY - ROW_HEIGHT - 6 - FORM_GAP);
		promptInput = multiLineInput(x + 6, promptY, width - 12, promptHeight, "Agent task",
				"Describe a clear outcome, for example: Build a safe shelter before night");
		addRenderableWidget(promptInput);
		int buttonWidth = (width - GAP * 2) / 3;
		int actionY = layout.contentBottom() - ROW_HEIGHT;
		for (int index = 0; index < 3; index++) {
			String operation = List.of("start", "queue", "steer").get(index);
			String label = List.of("Start now", "Add to queue", "Adjust current task").get(index);
			ConsoleButton action = index == 0
					? primaryButton(label,
							x + index * (buttonWidth + GAP), actionY, buttonWidth, ROW_HEIGHT,
							() -> submitPrompt(operation)).withIcon(ConsoleDraw.Icon.PLAY)
					: consoleButton(label,
							x + index * (buttonWidth + GAP), actionY, buttonWidth, ROW_HEIGHT, false,
							() -> submitPrompt(operation)).withIcon(index == 1 ? ConsoleDraw.Icon.PLUS : ConsoleDraw.Icon.TASK);
			action.active = canUseAutomation() && AgentControlActions.supports(agent, operation);
			addRenderableWidget(action);
		}
		addBackFooter();
	}

	private void initRemoveConfirm() {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) {
			show(Page.OVERVIEW);
			return;
		}
		AgentControlLayout layout = layout();
		int buttonWidth = Math.min(148, (layout.contentWidth() - GAP) / 2);
		int y = layout.footerY();
		addRenderableWidget(consoleButton("Keep agent", layout.contentLeft(), y, buttonWidth, ROW_HEIGHT,
				false, () -> show(Page.MANAGE)));
		ConsoleButton remove = dangerButton("Remove permanently", layout.contentRight() - buttonWidth, y,
				buttonWidth, ROW_HEIGHT, this::submitConfirmedRemove).withIcon(ConsoleDraw.Icon.TRASH);
		remove.active = canControl();
		addRenderableWidget(remove);
	}

	private void initManage() {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) {
			show(Page.OVERVIEW);
			return;
		}
		shownPlanWindowEnabled = dev.agaminggod.mineagen.client.control.LiveAgentWindows.planEnabled();
		shownTerminalEnabled = dev.agaminggod.mineagen.client.control.LiveAgentWindows.terminalEnabled();
		AgentControlLayout layout = layout();
		int x = layout.contentLeft();
		int width = layout.contentWidth();
		int top = bodyTop();
		int buttonWidth = (width - GAP * 2) / 3;
		int half = (width - GAP) / 2;
		// Grouped rows read as sections; the one destructive action sits apart in the footer.
		addFormLabel("Work", x, top);
		int windowsTop = top + LABEL_HEIGHT + ROW_HEIGHT + FORM_GAP;
		addFormLabel("Live windows", x, windowsTop);
		int behaviourTop = windowsTop + LABEL_HEIGHT + ROW_HEIGHT + FORM_GAP;
		addFormLabel("Between tasks", x, behaviourTop);
		top += LABEL_HEIGHT;
		for (int index = 0; index < 3; index++) {
			String operation = List.of("stop", "resume", "respawn").get(index);
			String label = List.of("Pause work", "Resume work", "Respawn").get(index);
			ConsoleButton action = consoleButton(label,
					x + index * (buttonWidth + GAP), top, buttonWidth, ROW_HEIGHT, false,
					() -> submitAgentOperation(operation))
					.withIcon(List.of(ConsoleDraw.Icon.PAUSE, ConsoleDraw.Icon.PLAY, ConsoleDraw.Icon.RESPAWN).get(index));
			action.active = canControl()
					&& (!operation.equals("resume") || canUseAutomation())
					&& AgentControlActions.supports(agent, operation);
			addRenderableWidget(action);
		}
		ConsoleButton automatic = consoleButton(
				agent.automaticProgress() ? "Automatic progress: On" : "Automatic progress: Off",
				x, behaviourTop + LABEL_HEIGHT, half, ROW_HEIGHT, agent.automaticProgress(),
				() -> submitAgentOperation("auto"));
		automatic.active = canControl();
		addRenderableWidget(automatic);
		int removeWidth = ConsoleButton.fittedWidth(font, "Remove agent...", true, false) + 8;
		ConsoleButton remove = dangerButton("Remove agent...", layout.contentRight() - removeWidth, layout.footerY(),
				removeWidth, ROW_HEIGHT, this::confirmRemove).withIcon(ConsoleDraw.Icon.TRASH);
		remove.active = canControl();
		addRenderableWidget(remove);
		ConsoleButton planWindow = consoleButton("Plan window: " + (dev.agaminggod.mineagen.client.control.LiveAgentWindows.planEnabled() ? "On" : "Off"),
				x, windowsTop + LABEL_HEIGHT, half, ROW_HEIGHT,
				dev.agaminggod.mineagen.client.control.LiveAgentWindows.planEnabled(), () -> {
					if (!dev.agaminggod.mineagen.client.control.LiveAgentWindows.togglePlan(agent)) setFeedback("Desktop windows are unavailable in a headless client", true);
					rebuildWidgets();
				});
		planWindow.withIcon(ConsoleDraw.Icon.MAP);
		planWindow.active = canControl();
		planWindow.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal("Open the selected agent's live dependency map in a separate window. Closing it leaves the task running.")));
		addRenderableWidget(planWindow);
		ConsoleButton terminalWindow = consoleButton("Model terminal: " + (dev.agaminggod.mineagen.client.control.LiveAgentWindows.terminalEnabled() ? "On" : "Off"),
				x + half + GAP, windowsTop + LABEL_HEIGHT, half, ROW_HEIGHT,
				dev.agaminggod.mineagen.client.control.LiveAgentWindows.terminalEnabled(), () -> {
					if (!dev.agaminggod.mineagen.client.control.LiveAgentWindows.toggleTerminal(agent)) setFeedback("Desktop windows are unavailable in a headless client", true);
					rebuildWidgets();
				});
		terminalWindow.withIcon(ConsoleDraw.Icon.TERMINAL);
		terminalWindow.active = canControl();
		terminalWindow.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal("View the agent's model output, tools and usage, whichever provider runs it. This starts no additional model calls.")));
		addRenderableWidget(terminalWindow);
		addBackFooter();
	}

	private void addOverviewFooter() {
		int y = layout().footerY();
		addRenderableWidget(ghostButton("Refresh", contentLeft() - 8, y, ConsoleButton.fittedWidth(font, "Refresh", true, false),
				ROW_HEIGHT, AgentControlClient::requestSnapshot).withIcon(ConsoleDraw.Icon.REFRESH));
		int closeWidth = ConsoleButton.fittedWidth(font, "Close", false, false);
		addRenderableWidget(ghostButton("Close", contentRight() - closeWidth + 8, y, closeWidth, ROW_HEIGHT, this::onClose));
	}

	private void addCreateFooter() {
		int y = layout().footerY();
		int backWidth = ConsoleButton.fittedWidth(font, "Back", true, false);
		addRenderableWidget(ghostButton("Back", contentLeft() - 8, y, backWidth, ROW_HEIGHT, this::navigateBack)
				.withIcon(ConsoleDraw.Icon.BACK));
		addRenderableWidget(ghostButton("Sign-in & keys", contentLeft() - 8 + backWidth + 8, y,
				ConsoleButton.fittedWidth(font, "Sign-in & keys", true, false), ROW_HEIGHT, () -> show(Page.KEYS))
				.withIcon(ConsoleDraw.Icon.KEY));
		ConsoleButton create = primaryButton("Create agent", contentRight() - 124, y, 124, ROW_HEIGHT, this::submitSummon)
				.withIcon(ConsoleDraw.Icon.SPARK);
		create.active = canControl() && !summonSubmission.claimed() && !AgentControlCatalog.isEmpty();
		addRenderableWidget(create);
	}

	private void addBackFooter() {
		int y = layout().footerY();
		addRenderableWidget(ghostButton("Back", contentLeft() - 8, y, ConsoleButton.fittedWidth(font, "Back", true, false),
				ROW_HEIGHT, this::navigateBack).withIcon(ConsoleDraw.Icon.BACK));
	}

	/** Header row: the mark and breadcrumb on the left, one live status on the right. */
	private void renderShell(GuiGraphicsExtractor graphics) {
		AgentControlLayout layout = layout();
		int left = layout.contentLeft();
		int middle = layout.panelTop() + AgentControlLayout.HEADER_HEIGHT / 2 + 2;
		ConsoleDraw.icon(graphics, ConsoleDraw.Icon.LOGO, left, middle - 8, 16, 0xFFFFFFFF);
		int x = left + 22;
		graphics.text(font, ConsoleText.strong("Mineagen"), x, middle - 4, TEXT, false);
		x += ConsoleText.strongWidth(font, "Mineagen") + 8;
		List<String> crumbs = breadcrumb();
		// With a page title on screen, the breadcrumb names only the way back; the title already says where you are.
		if (layout.roomy() && crumbs.size() > 1) crumbs = crumbs.subList(0, crumbs.size() - 1);
		for (String crumb : crumbs) {
			ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHEVRON_RIGHT, x - 2, middle - 6, ConsoleTheme.SUBTLE);
			x += 12;
			graphics.text(font, ConsoleText.component(crumb), x, middle - 4, MUTED, false);
			x += ConsoleText.width(font, crumb) + 6;
		}
		renderStatus(graphics, x + 12, middle);
		graphics.fill(layout.panelLeft() + 10, layout.headerBottom(), layout.panelRight() - 10, layout.headerBottom() + 1, 0x12FFFFFF);
	}

	private List<String> breadcrumb() {
		AgentControlAgent agent = selectedAgent();
		String name = agent == null ? "Agent" : agent.displayName();
		return switch (page) {
			case OVERVIEW -> List.of("Agents");
			case CREATE -> List.of("Agents", "New agent");
			case KEYS -> List.of("Agents", "New agent", "Sign-in & keys");
			case TASK -> List.of("Agents", name, "Task");
			case MANAGE -> List.of("Agents", name);
			case REMOVE_CONFIRM -> List.of("Agents", name, "Remove");
		};
	}

	/** Page title and one line of help, shown when the panel has room for them. */
	private void renderHeader(GuiGraphicsExtractor graphics) {
		AgentControlLayout layout = layout();
		if (!layout.roomy()) return;
		AgentControlAgent agent = selectedAgent();
		String title = switch (page) {
			case OVERVIEW -> "Your agents";
			case CREATE -> "New agent";
			case KEYS -> "Sign-in & keys";
			case TASK -> agent == null ? "Give a task" : "Give " + agent.displayName() + " a task";
			case MANAGE -> agent == null ? "Manage agent" : agent.displayName();
			case REMOVE_CONFIRM -> agent == null ? "Remove agent" : "Remove " + agent.displayName() + "?";
		};
		String help = switch (page) {
			case OVERVIEW -> snapshot == null || snapshot.agents().isEmpty()
					? "Agents play the game for you. Create one to get started."
					: snapshot.agents().size() + (snapshot.agents().size() == 1 ? " agent" : " agents") + ". Pick one to give it a task or manage it.";
			case CREATE -> "Pick a brain, choose how it thinks, and drop it into your world.";
			case KEYS -> "How each model tool on the server machine signs in.";
			case TASK -> agent == null ? "" : AgentControlPresentation.stateLabel(agent.state()) + ". Describe one clear outcome; you can queue more later.";
			case MANAGE -> agent == null ? "" : AgentControlPresentation.profileLabel(agent) + "  ·  " + AgentControlPresentation.stateLabel(agent.state());
			case REMOVE_CONFIRM -> "This deletes the agent and its saved progress. It can't be undone.";
		};
		int x = page == Page.CREATE || page == Page.KEYS ? layout.formLeft() : layout.contentLeft();
		int available = page == Page.CREATE || page == Page.KEYS ? layout.formWidth() : layout.contentWidth();
		ConsoleDraw.title(graphics, font, fitStrong(title, Math.round(available / ConsoleDraw.TITLE_SIZE)), x, layout.contentTop() + 6, TEXT);
		graphics.text(font, ConsoleText.component(fit(help, available)), x, layout.contentTop() + 24, MUTED, false);
	}

	private String fitStrong(String value, int available) {
		if (ConsoleText.strongWidth(font, value) <= available) return value;
		int end = value.length();
		while (end > 0 && ConsoleText.strongWidth(font, value.substring(0, end) + "...") > available) end--;
		return value.substring(0, end) + "...";
	}

	private void renderOverview(GuiGraphicsExtractor graphics) {
		AgentControlLayout layout = layout();
		int top = bodyTop();
		if (snapshot == null) {
			Optional<String> error = AgentControlClient.snapshotError();
			renderEmptyState(graphics, layout.canvasLeft(), layout.canvasRight(), top,
					error.isPresent() ? "Can't reach the agents" : "Loading your agents...",
					error.orElse(""), error.isPresent() ? ERROR : MUTED);
			return;
		}
		if (snapshot.agents().isEmpty()) {
			renderEmptyState(graphics, layout.canvasLeft(), layout.canvasRight(), top, "No agents yet",
					"Create one, choose its brain, then give it a clear task.", MUTED);
			return;
		}
		AgentControlAgent selected = selectedAgent();
		if (selected == null) return;
		if (layout.splitWorkspace()) {
			int x = layout.contextLeft();
			int width = layout.contextWidth();
			int detailTop = top + 96;
			int detailBottom = layout.contentBottom();
			if (detailBottom - detailTop < 60) return;
			ConsoleDraw.surface(graphics, x, detailTop, width, detailBottom - detailTop, ConsoleDraw.RADIUS_CARD, ConsoleTheme.SURFACE);
			int inner = x + 12;
			ConsoleDraw.label(graphics, font, "Now", inner, detailTop + 10, ConsoleTheme.SUBTLE);
			graphics.text(font, ConsoleText.strong(fit(selected.displayName(), width - 24)), inner, detailTop + 23, TEXT, false);
			ConsoleDraw.label(graphics, font, AgentControlPresentation.profileLabel(selected), inner, detailTop + 36, MUTED);
			renderNowRows(graphics, selected, inner, detailTop + 48, x + width - 12, detailBottom - NOW_PAD, false, true);
			return;
		}
		if (overviewNow != null) renderNowCard(graphics, selected, overviewNow, true);
	}

	private void renderNowCard(GuiGraphicsExtractor graphics, AgentControlAgent agent, AgentControlLayout.Bounds area, boolean named) {
		ConsoleDraw.surface(graphics, area.left(), area.top(), area.width(), area.height(), ConsoleDraw.RADIUS_CARD, ConsoleTheme.SURFACE);
		renderNowRows(graphics, agent, area.left() + 10, area.top() + NOW_PAD, area.right() - 10, area.bottom() - NOW_PAD, named, false);
	}

	/**
	 * Draws the agent's Now rows (see {@link AgentNowCard}) from the top down while they fit: one line each, or in the
	 * narrow context rail a label over up to two lines of text.
	 */
	private void renderNowRows(GuiGraphicsExtractor graphics, AgentControlAgent agent, int left, int top, int right, int bottom,
			boolean named, boolean stacked) {
		List<AgentNowCard.Row> rows = AgentNowCard.rows(agent, stateMs(agent),
				AgentNowCard.Live.from(dev.agaminggod.mineagen.client.control.LiveAgentWindows.liveView(agent)));
		int labelColumn = 0;
		for (AgentNowCard.Row row : rows) labelColumn = Math.max(labelColumn, ConsoleDraw.labelWidth(font, row.label()));
		labelColumn += 6;
		int width = right - left;
		int y = top;
		for (AgentNowCard.Row row : rows) {
			int color = row.tone() == AgentControlPresentation.StateTone.NEUTRAL ? TEXT : ConsoleTheme.stateColor(row.tone());
			if (row.kind() == AgentNowCard.Kind.STATE) {
				if (y + NOW_ROW > bottom) return;
				ConsoleDraw.stateMark(graphics, agent.state(), left, y);
				String text = named ? agent.displayName() + " · " + row.text() : row.text();
				graphics.text(font, ConsoleText.component(fit(text, width - 16)), left + 16, y + 2, color, false);
				y += NOW_ROW + (stacked ? 4 : 0);
				continue;
			}
			if (stacked) {
				List<String> lines = twoLines(row.text(), width);
				if (y + 9 + lines.size() * 10 > bottom) return;
				ConsoleDraw.label(graphics, font, row.label(), left, y, ConsoleTheme.SUBTLE);
				for (int index = 0; index < lines.size(); index++) {
					graphics.text(font, ConsoleText.component(lines.get(index)), left, y + 9 + index * 10, color, false);
				}
				y += 9 + lines.size() * 10 + 3;
				continue;
			}
			if (y + NOW_ROW > bottom) return;
			ConsoleDraw.label(graphics, font, row.label(), left, y + 3, ConsoleTheme.SUBTLE);
			graphics.text(font, ConsoleText.component(fit(row.text(), width - labelColumn)), left + labelColumn, y + 2, color, false);
			y += NOW_ROW;
		}
	}

	/** {@code text} on at most two lines of {@code width}: broken at a space where one fits, the rest cut with "...". */
	private List<String> twoLines(String text, int width) {
		if (font.width(text) <= width) return List.of(text);
		String first = font.plainSubstrByWidth(text, width);
		int space = first.lastIndexOf(' ');
		if (space > first.length() / 2) first = first.substring(0, space);
		return List.of(first, fit(text.substring(first.length()).trim(), width));
	}

	/** How long the agent has been in its current state while this client watched, or -1 when not known. */
	private static long stateMs(AgentControlAgent agent) {
		return STATE_CLOCK.durationMs(agent.agentId(), agent.state(), System.currentTimeMillis());
	}

	private void renderEmptyState(GuiGraphicsExtractor graphics, int left, int right, int top, String title, String detail, int detailColor) {
		int center = (left + right) / 2;
		int y = top + Math.max(16, (layout().contentBottom() - top) / 2 - 30);
		ConsoleDraw.surface(graphics, center - 16, y, 32, 32, ConsoleDraw.RADIUS_CARD, ConsoleTheme.SURFACE);
		ConsoleDraw.icon(graphics, ConsoleDraw.Icon.AGENTS, center - 6, y + 10, MUTED);
		Component heading = ConsoleText.strong(title);
		graphics.text(font, heading, center - font.width(heading) / 2, y + 42, TEXT, false);
		if (!detail.isBlank()) ConsoleText.centered(graphics, font, fit(detail, right - left), center, y + 56, detailColor);
	}

	private void renderCreate(GuiGraphicsExtractor graphics) {
		AgentControlLayout scrollLayout = layout();
		if (createScroll < createScrollMaximum) {
			ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHEVRON_DOWN, (scrollLayout.contentLeft() + scrollLayout.contentRight()) / 2 - 6,
					scrollLayout.contentBottom() - 4, ConsoleTheme.SUBTLE);
		}
		if (!AgentControlCatalog.isEmpty()) return;
		AgentControlLayout layout = layout();
		int x = layout.formLeft();
		int width = layout.formWidth();
		int y = emptyCreateTop;
		// With the coordinator down nothing can scan, so its own reason (missing Node, restart loop) is the answer,
		// not "no tool found", which sent a player with working tools looking in the wrong place.
		String message = snapshot != null && !snapshot.automationAvailable() ? snapshot.automationStatus()
				: AgentControlCatalog.providerRows().isEmpty()
				? "No model tool found on the server machine yet. Install Codex CLI or Claude Code there, then rescan."
				: "None of these tools can run an agent yet. Sign one in, or add an API key under Sign-in & keys.";
		int color = snapshot != null && !snapshot.automationAvailable() ? ERROR : MUTED;
		graphics.textWithWordWrap(font, ConsoleText.component(message), x, y, width, color);
	}

	private void renderTask(GuiGraphicsExtractor graphics) {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) return;
		AgentControlLayout layout = layout();
		if (!canUseAutomation()) {
			graphics.text(font, ConsoleText.component("Tasks are off until automation is ready."), contentLeft(),
					layout.contentBottom() - ROW_HEIGHT - 14, ERROR, false);
		}
	}

	private void renderManage(GuiGraphicsExtractor graphics) {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) return;
		AgentControlLayout layout = layout();
		// Short panels show no title; the breadcrumb already names the agent.
		AgentControlLayout.Bounds now = manageNowBounds(layout);
		if (now != null) renderNowCard(graphics, agent, now, false);
	}

	private void renderRemoveConfirm(GuiGraphicsExtractor graphics) {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) return;
		AgentControlLayout layout = layout();
		int left = layout.contentLeft();
		int top = bodyTop();
		int width = layout.contentWidth();
		ConsoleDraw.surface(graphics, left, top, width, 60, ConsoleDraw.RADIUS_CARD, ConsoleTheme.DANGER_SURFACE);
		ConsoleDraw.icon(graphics, ConsoleDraw.Icon.TRASH, left + 14, top + 12, ERROR);
		graphics.text(font, ConsoleText.strong("Remove " + fit(agent.displayName(), width - 60)), left + 34, top + 14, TEXT, false);
		graphics.text(font, ConsoleText.component("Its saved progress is deleted too. This can't be undone."), left + 34, top + 30, MUTED, false);
		graphics.text(font, ConsoleText.component("Choose Keep agent to go back without changing anything."), left + 34, top + 42,
				ConsoleTheme.SUBTLE, false);
	}

	private void renderInputSurfaces(GuiGraphicsExtractor graphics) {
		if (promptInput == null) return;
		int x = promptInput.getX() - 6;
		int y = promptInput.getY() - 6;
		int w = promptInput.getWidth() + 12;
		int h = promptInput.getHeight() + 12;
		ConsoleDraw.surface(graphics, x, y, w, h, ConsoleDraw.RADIUS_CARD, ConsoleTheme.TRACK);
		ConsoleDraw.ring(graphics, x, y, w, h, ConsoleDraw.RADIUS_CARD, promptInput.isFocused() ? ACCENT
				: promptInput.isHovered() ? 0xFF2E3846 : 0xFF1E252F);
	}

	/** The status line: its full text, colour, and the short label the header shows while the banner holds the text. */
	private record Status(String text, int color, String shortText, boolean danger) {
	}

	private Status status() {
		if (!feedback.isBlank()) {
			AgentControlResult.Tone tone = feedbackTone(feedbackError, feedbackConfirmed);
			String shortText = switch (tone) {
				case REFUSED -> "Not done";
				case SUCCESS -> "Done";
				case PENDING -> "Working...";
			};
			return new Status(feedback, toneColor(tone), shortText, feedbackError);
		}
		if (mutationState.mutationPending()) {
			return new Status("Waiting for the server...", toneColor(AgentControlResult.Tone.PENDING), "Waiting...", false);
		}
		if (snapshot == null) return new Status("Connecting", ConsoleTheme.WARNING, "Connecting", false);
		if (!snapshot.canControl()) {
			return new Status("View only. Operator permission is needed to make changes", ConsoleTheme.WARNING, "View only", false);
		}
		if (!snapshot.automationAvailable()) return new Status(snapshot.automationStatus(), ERROR, "Automation offline", true);
		return new Status("Online", SUCCESS, "Online", false);
	}

	/** A feedback line is a success only once the server confirmed it; a line the screen wrote itself is pending. */
	static AgentControlResult.Tone feedbackTone(boolean error, boolean confirmed) {
		return error ? AgentControlResult.Tone.REFUSED : confirmed ? AgentControlResult.Tone.SUCCESS : AgentControlResult.Tone.PENDING;
	}

	/** Pending is neutral: green means the server confirmed the change, red that it refused it. */
	static int toneColor(AgentControlResult.Tone tone) {
		return switch (tone) {
			case PENDING -> MUTED;
			case SUCCESS -> ConsoleTheme.SUCCESS;
			case REFUSED -> ConsoleTheme.ERROR;
		};
	}

	/** Where the header status may start: after the logo, the name and the longest breadcrumb this page can show. */
	private int headerStatusLeft(AgentControlLayout layout) {
		int x = layout.contentLeft() + 22 + ConsoleText.strongWidth(font, "Mineagen") + 8;
		for (String crumb : breadcrumb()) x += 12 + ConsoleText.width(font, crumb) + 6;
		return x + 12;
	}

	/** The status text broken into banner lines, or none when it fits on the header line. */
	private List<String> bannerLines() {
		if (font == null) return List.of();
		AgentControlLayout base = AgentControlLayout.calculate(width, height);
		String text = status().text();
		int headerRoom = Math.max(24, base.contentRight() - headerStatusLeft(base) - 10);
		if (ConsoleText.width(font, text) <= headerRoom) return List.of();
		java.util.function.ToIntFunction<String> measure = value -> ConsoleText.width(font, value);
		return capBannerLines(AgentControlResult.wrap(text, bannerTextWidth(base), measure), maxBannerLines(width, height),
				bannerTextWidth(base), measure);
	}

	/** Bottom of the Manage page's last control row (its three label-and-row groups), the tallest fixed page. */
	static int manageRowsBottom(AgentControlLayout layout) {
		return bodyTop(layout) + 3 * (LABEL_HEIGHT + ROW_HEIGHT + FORM_GAP) - FORM_GAP;
	}

	/**
	 * Most banner lines (up to 3) this screen holds while the Manage page's last row still ends above the footer,
	 * measured on the real layout. 0 means no banner: the header then shows the text shortened, as before.
	 */
	static int maxBannerLines(int screenWidth, int screenHeight) {
		for (int lines = 3; lines > 0; lines--) {
			AgentControlLayout with = AgentControlLayout.calculate(screenWidth, screenHeight, bannerInset(lines));
			if (manageRowsBottom(with) <= with.footerY()) return lines;
		}
		return 0;
	}

	/** {@code lines} within {@code max}; the last kept line carries the rest, shortened with "...". */
	static List<String> capBannerLines(List<String> lines, int max, int width, java.util.function.ToIntFunction<String> measure) {
		if (lines.size() <= max) return lines;
		if (max == 0) return List.of();
		List<String> kept = new java.util.ArrayList<>(lines.subList(0, max - 1));
		String rest = String.join(" ", lines.subList(max - 1, lines.size()));
		while (!rest.isEmpty() && measure.applyAsInt(rest + "...") > width) rest = rest.substring(0, rest.length() - 1);
		kept.add(rest.stripTrailing() + "...");
		return List.copyOf(kept);
	}

	static final int BANNER_LINE = 10;
	static final int BANNER_PAD = 5;

	static int bannerTextWidth(AgentControlLayout layout) {
		return Math.max(1, layout.contentWidth() - BANNER_PAD * 2);
	}

	/** Space the banner takes below the header, its 4-pixel gap to the content included; 0 with no banner. */
	static int bannerInset(int lines) {
		return lines <= 0 ? 0 : lines * BANNER_LINE + BANNER_PAD * 2 + 4;
	}

	/** Where the banner sits: from just below the header down to 4 pixels above where the page content starts. */
	static AgentControlLayout.Bounds bannerBounds(AgentControlLayout layout, int lines) {
		int top = layout.headerBottom() + 4;
		return new AgentControlLayout.Bounds(layout.contentLeft(), top, layout.contentRight(), top + Math.max(0, bannerInset(lines) - 4));
	}

	/** The full result or offline reason, wrapped below the header when the header line is too short for it. */
	private void renderBanner(GuiGraphicsExtractor graphics) {
		List<String> lines = bannerLines();
		if (!bannerHolds(lines)) return;
		Status status = status();
		AgentControlLayout layout = layout();
		int shown = lines.size();
		AgentControlLayout.Bounds area = bannerBounds(layout, shown);
		ConsoleDraw.surface(graphics, area.left(), area.top(), area.width(), area.height(), ConsoleDraw.RADIUS_CARD,
				status.danger() ? ConsoleTheme.DANGER_SURFACE : ConsoleTheme.SURFACE);
		for (int index = 0; index < shown; index++) {
			graphics.text(font, ConsoleText.component(lines.get(index)), area.left() + BANNER_PAD,
					area.top() + BANNER_PAD + index * BANNER_LINE, status.danger() ? TEXT : status.color(), false);
		}
	}

	/**
	 * True when the space reserved at the last widget build holds every banner line. While a focused text box defers
	 * that rebuild, the header keeps showing the text itself (shortened) rather than a label for a banner not yet drawn.
	 */
	private boolean bannerHolds(List<String> lines) {
		return !lines.isEmpty() && builtBannerInset >= bannerInset(lines.size());
	}

	/** One status on the header's right: the latest feedback, a pending update, or the link state. */
	private void renderStatus(GuiGraphicsExtractor graphics, int minimumX, int middle) {
		AgentControlLayout layout = layout();
		Status status = status();
		int right = layout.contentRight();
		int room = Math.max(24, right - minimumX - 10);
		// A text too long for the header is shown whole in the banner below; the header then names only its kind.
		String shown = bannerHolds(bannerLines()) ? fit(status.shortText(), room) : fit(status.text(), room);
		int textWidth = ConsoleText.width(font, shown);
		graphics.text(font, ConsoleText.component(shown), right - textWidth, middle - 4, status.color(), false);
		ConsoleDraw.surface(graphics, right - textWidth - 9, middle - 2, 5, 5, ConsoleDraw.RADIUS_SMALL, status.color());
	}

	private void submitSummon() {
		String command;
		try {
			name = nameInput.getValue();
			command = AgentControlCommandBuilder.summon(
					provider, model, reasoning, serviceTier, name, gameMode);
		} catch (IllegalArgumentException exception) {
			setFeedback(exception.getMessage(), true);
			return;
		}
		dispatchSummonOnce(
				summonSubmission,
				() -> send(command, "Creating agent..."),
				() -> {
					rememberPreferences();
					onClose();
				}
		);
	}

	private void submitPrompt(String operation) {
		AgentControlAgent agent = pageAgent();
		if (agent == null) return;
		if (rejectPendingMutation()) return;
		if (!canUseAutomation()) {
			setFeedback(snapshot == null ? "Automation is not ready" : snapshot.automationStatus(), true);
			return;
		}
		try {
			prompt = promptInput.getValue();
			send(AgentControlCommandBuilder.prompt(operation, agent.agentId(), prompt), "Sending task...");
		} catch (IllegalArgumentException exception) {
			setFeedback(exception.getMessage(), true);
		}
	}

	private void submitAgentOperation(String operation) {
		AgentControlAgent agent = pageAgent();
		if (agent == null) return;
		send(AgentControlCommandBuilder.agent(operation, agent.agentId()), "Updating " + agent.displayName() + "...");
	}

	private void confirmRemove() {
		if (selectedAgent() != null) show(Page.REMOVE_CONFIRM);
	}

	private void submitConfirmedRemove() {
		AgentControlAgent agent = pageAgent();
		if (agent == null) {
			show(Page.OVERVIEW);
			setFeedback("That agent is already gone. Nothing was removed.", true);
			return;
		}
		page = Page.OVERVIEW;
		rebuildWidgets();
		send(AgentControlCommandBuilder.agent("remove", agent.agentId()),
				"Removing " + agent.displayName() + "...");
	}

	private boolean send(String command, String pendingMessage) {
		if (rejectPendingMutation()) return false;
		if (!serverCanControl()) {
			setFeedback("View only. Operator permission is required to make changes.", true);
			return false;
		}
		OptionalLong receipt = AgentControlClient.sendCommandWithReceipt(command);
		if (receipt.isPresent()) {
			mutationState = mutationState.beginMutation(receipt.getAsLong());
			setFeedback(pendingMessage + " Awaiting server update.", false);
			rebuildWidgets();
			return true;
		}
		setFeedback("Not connected to a compatible server", true);
		return false;
	}

	private boolean rejectPendingMutation() {
		if (!mutationState.mutationPending()) return false;
		setFeedback("Wait for the current server update before sending another command.", true);
		return true;
	}

	private void show(Page next) {
		Page destination = next;
		clearKeyDraft();
		createScroll = 0;
		pageAgentId = isAgentPage(destination) ? managementSelection.selectedAgentId() : "";
		page = destination;
		feedback = "";
		rebuildWidgets();
	}

	private void setFeedback(String message, boolean error) {
		feedback = Objects.requireNonNullElse(message, "");
		feedbackError = error;
		feedbackConfirmed = false;
	}

	private void rememberPreferences() {
		AgentControlClient.rememberPreferences(provider, model);
	}

	/** Re-validates the current form against the (possibly refreshed) catalog without discarding live choices. */
	private void normalizeCreateSelection() {
		if (AgentControlCatalog.isEmpty()) return;
		CreateSelection normalized = normalizeCreateSelection(provider, model, reasoning, serviceTier);
		provider = normalized.provider();
		model = normalized.model();
		reasoning = normalized.reasoning();
		serviceTier = normalized.serviceTier();
		if (AgentControlClient.catalogAuthoritative()) rememberPreferences();
	}

	/** Fresh menu state: remembered provider/model when still offered, lowest thinking depth, Normal speed. */
	static CreateSelection normalizeCreateSelection(String provider, String model) {
		// Nothing discovered yet: keep the remembered choice until a catalog can confirm it.
		if (AgentControlCatalog.isEmpty()) return new CreateSelection(provider, model, "", "");
		List<String> providers = AgentControlCatalog.providers();
		String normalizedProvider = providers.contains(provider) ? provider : providers.getFirst();
		List<String> models = AgentControlCatalog.models(normalizedProvider);
		String normalizedModel = models.contains(model)
				? model : AgentControlCatalog.defaultModel(normalizedProvider);
		return new CreateSelection(normalizedProvider, normalizedModel,
				AgentControlCatalog.defaultReasoning(normalizedProvider, normalizedModel),
				AgentControlCatalog.defaultServiceTier(normalizedProvider, normalizedModel));
	}

	static CreateSelection normalizeCreateSelection(
			String provider,
			String model,
			String reasoning,
			String serviceTier
	) {
		CreateSelection defaults = normalizeCreateSelection(provider, model);
		if (AgentControlCatalog.isEmpty()) return new CreateSelection(provider, model, reasoning, serviceTier);
		List<String> efforts = AgentControlCatalog.reasoningEfforts(defaults.provider(), defaults.model());
		List<String> tiers = AgentControlCatalog.serviceTiers(defaults.provider(), defaults.model());
		return new CreateSelection(defaults.provider(), defaults.model(),
				efforts.contains(reasoning) ? reasoning : defaults.reasoning(),
				tiers.contains(serviceTier) ? serviceTier : defaults.serviceTier());
	}

	private AgentControlAgent selectedAgent() {
		if (snapshot == null || managementSelection.selectedAgentId().isBlank()) return null;
		AgentControlAgent selected = snapshot.agents().stream()
				.filter(agent -> agent.agentId().equals(managementSelection.selectedAgentId())).findFirst().orElse(null);
		return selected;
	}

	private void selectAgent(String agentId) {
		if (snapshot == null) return;
		managementSelection.select(agentId, snapshot.agents());
		rosterState.focus(managementSelection.selectedAgentId());
		dev.agaminggod.mineagen.client.control.LiveAgentWindows.select(selectedAgent());
	}

	private boolean filtersVisible() {
		return snapshot != null && AgentControlLayout.rosterFiltersVisible(snapshot.agents().size());
	}

	private List<String> providerOptions() {
		List<String> options = new ArrayList<>();
		options.add("");
		for (AgentRosterEntry entry : rosterEntries) {
			if (options.stream().noneMatch(value -> value.equalsIgnoreCase(entry.provider()))) {
				options.add(entry.provider());
			}
		}
		return List.copyOf(options);
	}

	private List<String> stateOptions() {
		List<String> options = new ArrayList<>();
		options.add("");
		for (AgentRosterEntry entry : rosterEntries) {
			if (options.stream().noneMatch(value -> value.equalsIgnoreCase(entry.state()))) {
				options.add(entry.state());
			}
		}
		return List.copyOf(options);
	}

	private void applyRosterFilter(AgentRosterFilter filter) {
		setRosterFilterWithoutRebuild(filter);
		selectAgent(rosterState.focusedId());
		rebuildWidgets();
	}

	private void setRosterFilterWithoutRebuild(AgentRosterFilter filter) {
		AgentRosterFilter nextFilter = Objects.requireNonNull(filter, "roster filter must not be null");
		int currentPage = rosterState.page(1).page();
		int nextPage = AgentControlLayout.rosterPageAfterFilterUpdate(rosterFilter, nextFilter, currentPage);
		rosterFilter = nextFilter;
		rosterState.setFilter(rosterFilter);
		if (nextPage != currentPage) rosterState.setPage(nextPage, 1);
		boolean focusVisible = rosterEntries.stream()
				.anyMatch(entry -> entry.id().equals(rosterState.focusedId()) && rosterFilter.matches(entry));
		if (!focusVisible) {
			rosterEntries.stream().filter(rosterFilter::matches).findFirst()
					.ifPresent(entry -> rosterState.focus(entry.id()));
		}
	}

	private void normalizeRosterFilterOptions() {
		String provider = providerOptions().stream()
				.anyMatch(value -> value.equalsIgnoreCase(rosterFilter.provider())) ? rosterFilter.provider() : "";
		String state = stateOptions().stream()
				.anyMatch(value -> value.equalsIgnoreCase(rosterFilter.state())) ? rosterFilter.state() : "";
		setRosterFilterWithoutRebuild(new AgentRosterFilter(rosterFilter.query(), provider, state));
	}

	/** The roster's entries: each carries its agent's raw lifecycle state beside the label (verified by the roster tests). */
	static List<AgentRosterEntry> rosterEntries(AgentControlSnapshot snapshot) {
		List<AgentRosterEntry> entries = new ArrayList<>();
		for (AgentControlAgent agent : snapshot.agents()) {
			entries.add(new AgentRosterEntry(
					agent.agentId(),
					agent.displayName(),
					agent.provider(),
					AgentModelNames.shortLabel(agent.provider(), agent.model()),
					AgentControlPresentation.stateLabel(agent.state()),
					true,
					"",
					agent.state()
			));
		}
		return List.copyOf(entries);
	}

	private static Map<String, AgentVisualIdentity.Resolved> rosterVisuals(AgentControlSnapshot snapshot) {
		Map<String, AgentVisualIdentity.Resolved> visuals = new LinkedHashMap<>();
		for (AgentControlAgent agent : snapshot.agents()) {
			AgentVisualIdentity.Resolved previous = visuals.put(
					agent.agentId(),
					AgentVisualIdentity.resolve(agent.provider(), agent.model(), agent.skinVariant())
			);
			if (previous != null) throw new IllegalArgumentException("Duplicate agent roster ID: " + agent.agentId());
		}
		return Map.copyOf(visuals);
	}

	private MultiLineEditBox multiLineInput(
			int x,
			int y,
			int width,
			int height,
			String narration,
			String placeholder
	) {
		MultiLineEditBox input = MultiLineEditBox.builder()
				.setX(x)
				.setY(y)
				.setPlaceholder(Component.literal(placeholder))
				.setTextColor(TEXT)
				.setTextShadow(false)
				.setCursorColor(ACCENT)
				.setShowBackground(false)
				.setShowDecorations(false)
				.build(font, width, height, Component.literal(narration));
		input.setCharacterLimit(AgentConstants.MAX_PROMPT_LENGTH);
		input.setLineLimit(Math.max(2, height / 12));
		input.setValue(prompt);
		input.setValueListener(value -> prompt = value);
		return input;
	}

	private ConsoleEditBox consoleEditBox(
			int x,
			int y,
			int width,
			int height,
			String identity,
			Component placeholder
	) {
		return new ConsoleEditBox(font, x, y, width, height,
				Component.translatable("screen.mineagen.name"), placeholder, identity);
	}

	private ConsoleButton consoleButton(
			String label,
			int x,
			int y,
			int width,
			int height,
			boolean selected,
			Runnable action
	) {
		return consoleButton(Component.literal(label), x, y, width, height, selected, action);
	}

	private ConsoleButton consoleButton(
			Component label, int x, int y, int width, int height, boolean selected, Runnable action
	) {
		return new ConsoleButton(font, x, y, width, height, label, selected, ACCENT, action);
	}

	private ConsoleButton primaryButton(
			String label, int x, int y, int width, int height, Runnable action
	) {
		return new ConsoleButton(font, x, y, width, height, Component.literal(label), false, ACCENT,
				ConsoleButton.Tone.PRIMARY, action);
	}

	private ConsoleButton ghostButton(
			String label, int x, int y, int width, int height, Runnable action
	) {
		return new ConsoleButton(font, x, y, width, height, Component.literal(label), false, ACCENT,
				ConsoleButton.Tone.GHOST, action);
	}

	private ConsoleButton dangerButton(
			String label, int x, int y, int width, int height, Runnable action
	) {
		return new ConsoleButton(font, x, y, width, height, Component.literal(label), false, ACCENT,
				ConsoleButton.Tone.DANGER, action);
	}

	private boolean canControl() {
		return serverCanControl() && !mutationState.mutationPending();
	}

	private boolean serverCanControl() {
		return snapshot != null && snapshot.canControl();
	}

	private boolean canUseAutomation() {
		return canControl() && snapshot.automationAvailable();
	}

	private int panelWidth() {
		return layout().panelWidth();
	}

	private int panelLeft() {
		return layout().panelLeft();
	}

	private int contentLeft() {
		return layout().contentLeft();
	}

	private int contentRight() {
		return layout().contentRight();
	}

	private int contentWidth() {
		return contentRight() - contentLeft();
	}

	private AgentControlLayout layout() {
		return AgentControlLayout.calculate(width, height, builtBannerInset);
	}

	private static String capitalize(String value) {
		if (value == null || value.isBlank()) return "";
		return Character.toUpperCase(value.charAt(0)) + value.substring(1).toLowerCase(Locale.ROOT);
	}

	private String fit(String value, int available) {
		if (font.width(value) <= available) return value;
		String suffix = "...";
		return font.plainSubstrByWidth(value, Math.max(1, available - font.width(suffix))) + suffix;
	}

	record CreateSelection(String provider, String model, String reasoning, String serviceTier) {
	}

	static boolean dispatchSummonOnce(
			SingleSubmissionGate gate,
			BooleanSupplier dispatch,
			Runnable onAccepted
	) {
		Objects.requireNonNull(gate, "gate must not be null");
		Objects.requireNonNull(dispatch, "dispatch must not be null");
		Objects.requireNonNull(onAccepted, "accepted callback must not be null");
		if (!gate.tryClaim()) return false;
		if (!dispatch.getAsBoolean()) {
			gate.release();
			return false;
		}
		onAccepted.run();
		return true;
	}

	static final class SingleSubmissionGate {
		private final AtomicBoolean claimed = new AtomicBoolean();

		boolean tryClaim() {
			return claimed.compareAndSet(false, true);
		}

		boolean claimed() {
			return claimed.get();
		}

		void release() {
			claimed.set(false);
		}
	}

	private record FormLabel(String text, int x, int y) {
	}

	private enum Page {
		OVERVIEW,
		CREATE,
		KEYS,
		TASK,
		MANAGE,
		REMOVE_CONFIRM
	}
}
