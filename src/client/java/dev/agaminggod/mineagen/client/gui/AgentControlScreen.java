package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.agent.AgentConstants;
import dev.agaminggod.mineagen.agent.AgentGameMode;
import dev.agaminggod.mineagen.agent.AgentModelNames;
import dev.agaminggod.mineagen.agent.AgentVisualIdentity;
import dev.agaminggod.mineagen.client.control.AgentControlClient;
import dev.agaminggod.mineagen.client.gui.widget.AgentListRow;
import dev.agaminggod.mineagen.client.gui.widget.ComputePill;
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
import dev.agaminggod.mineagen.server.BoatAccount;
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
		if (computeOpenPending) computeOpen = true;
		computeOpenPending = false;
		builtBannerInset = bannerInset(bannerLines().size());
		overviewNow = null;
		nameInput = null;
		promptInput = null;
		taskInput = null;
		board = null;
		rosterGrid = null;
		modelDropdown = null;
		formLabels.clear();
		switch (page) {
			case OVERVIEW -> initBoard();
			case ROSTER -> initOverview();
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
		pollBoard();
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
			case OVERVIEW, ROSTER -> appendAgentNarration(narration, selectedAgent(), true);
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
		boardMouseX = mouseX;
		boardMouseY = mouseY;
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
		ConsoleDraw.hairline(graphics, layout.panelLeft(), layout.panelRight(),
				layout.panelTop(), 0x1AFFFFFF);
		renderShell(graphics);
		renderBanner(graphics);
		renderHeader(graphics);
		renderInputSurfaces(graphics);
		switch (page) {
			case OVERVIEW -> renderBoard(graphics);
			case ROSTER -> renderOverview(graphics);
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
		if (page == Page.OVERVIEW) renderDrawer(graphics, mouseX, mouseY, partialTick);
		if (modelDropdown != null) modelDropdown.renderPopup(graphics, mouseX, mouseY);
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent event, boolean doubled) {
		if (modelDropdown != null && modelDropdown.popupClick(event)) return true;
		if (page == Page.OVERVIEW && computeOpen && board != null && !inside(board.layout().drawer(), event.x(), event.y())
				&& (computePill == null || !computePill.isMouseOver(event.x(), event.y()))) {
			computeOpen = false;
			consentPending = false;
			rebuildWidgets();
			return true;
		}
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
		if (page == Page.OVERVIEW && board != null && boardScrolled(mouseX, mouseY, verticalAmount)) return true;
		if (page == Page.ROSTER && rosterGrid != null
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
			if (page == Page.OVERVIEW && computeOpen) {
				computeOpen = false;
				consentPending = false;
				rebuildWidgets();
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
			show(keysReturn);
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

	// ---- Mission board (layout B): agent list, live view, Runs on rail, task row ----

	/** Where the board reads boat state and sends boat actions; tests and the local preview harness swap these. */
	static java.util.function.Supplier<BoatAccount.Status> boatStatusSource = AgentControlClient::boatStatus;
	static java.util.function.Supplier<BoatAccount.Settings> boatSettingsSource = AgentControlClient::boatSettings;
	static java.util.function.Predicate<String> boatActionSink = AgentControlClient::sendBoatAction;
	/** The boat status is a file read: every half second is plenty for a machine that takes a minute to start. */
	private static final int BOAT_POLL_TICKS = 10;
	/** How long the switch shows a just-sent Runs on choice before trusting the settings file again. */
	private static final long RUNS_ON_PENDING_MS = 8_000L;
	static final int LIST_ROW = 26;
	static final int LIST_ROW_GAP = 3;
	/** The mission board's panel: dark glass that lets the blurred world show through. */
	private static final int BOARD_GLASS = 0xD80B0F15;
	static final int LIVE_BUTTON = 20;
	/** The live view's height when folded at the narrowest side-by-side width: hero, Mission and Activity, buttons. */
	static final int LIVE_NATURAL = BoardLiveView.naturalHeight(BoardLiveView.SIDE_BY_SIDE);
	static final int STACK_GAP = 10;

	private record Board(MissionBoardLayout layout, AgentControlLayout.Bounds view, AgentControlLayout.Bounds railView,
			AgentControlLayout.Bounds live, Rail rail, int listRowsTop, int listRowsBottom, boolean listMoreAbove,
			boolean listMoreBelow, int centreScrollMaximum, int railScrollMaximum, boolean idle, boolean bodyShown, int actionsWidth) {
	}

	/** The rail's parts, placed once per build; drawing and widgets read the same numbers. Absent parts are -1. */
	/** Rail machine block: 11px lines and a 3px gap under the title so title, detail and spec read as separate lines. */
	private static final int MACHINE_LINE = 11;
	private static final int MACHINE_TITLE_GAP = 3;

	record Rail(int left, int width, int top, int consentY, List<String> consentLines, int machineY, int machineHeight,
			BoatPanelPresentation.Machine machine, List<String> head, int titleLines, int costY, int progressY, int errorY, List<String> errors,
			int actionY, int providersY, List<BoatPanelPresentation.ProviderRow> providers, int bottom) {
		int switchY() {
			return top + LABEL_HEIGHT - 2;
		}
	}

	private Page keysReturn = Page.CREATE;
	private BoatAccount.Status boatStatus;
	private BoatAccount.Settings boatSettings = new BoatAccount.Settings(false, false);
	private boolean boatRead;
	private int boatPollCountdown;
	private Boolean runsOnPending;
	private long runsOnPendingAt;
	private boolean consentPending;
	private AgentBody body;
	private float boardMouseX;
	private float boardMouseY;
	private BoardLiveView liveView;
	private int listScroll;
	private int centreScroll;
	/** The compute drawer scrolls on its own when consent, an error and the sign-in rows are taller than it. */
	private int railScroll;
	/** The compute drawer: open from the header pill, closed by Escape or a click outside it. */
	private boolean computeOpen;
	// A new machine error waits for the next rebuild to open the drawer, so the drawer never shows stale rows or no controls.
	private boolean computeOpenPending;
	private ComputePill computePill;
	private final List<AbstractWidget> drawerWidgets = new ArrayList<>();
	private ConsoleEditBox taskInput;
	private Board board;

	static String tr(String key, Object... args) {
		return Component.translatable(key, args).getString();
	}

	private void readBoat() {
		boatRead = true;
		try {
			boatStatus = boatStatusSource.get();
		} catch (RuntimeException failure) {
			boatStatus = null;
		}
		try {
			BoatAccount.Settings read = boatSettingsSource.get();
			boatSettings = read == null ? new BoatAccount.Settings(false, false) : read;
		} catch (RuntimeException failure) {
			boatSettings = new BoatAccount.Settings(false, false);
		}
	}

	/** Re-reads boat state every {@link #BOAT_POLL_TICKS}; a change of phase, sign-in, error or setting rebuilds the rail. */
	private void pollBoard() {
		if (page != Page.OVERVIEW) return;
		if (boatRead && --boatPollCountdown > 0) return;
		boatPollCountdown = BOAT_POLL_TICKS;
		BoatAccount.Status before = boatStatus;
		BoatAccount.Settings settingsBefore = boatSettings;
		readBoat();
		if (runsOnPending != null && (runsOnPending == boatSettings.runsOnBoat()
				|| System.currentTimeMillis() - runsOnPendingAt > RUNS_ON_PENDING_MS)) {
			runsOnPending = null;
			widgetRefreshPending = true;
		}
		if (boatShapeChanged(before, boatStatus) || !settingsBefore.equals(boatSettings)) widgetRefreshPending = true;
		if (newError(before, boatStatus)) {
			computeOpenPending = true;
			widgetRefreshPending = true;
		}
		body = AgentBody.read(minecraft, selectedAgent());
	}

	/** True when the machine reports an error it did not have before; the drawer opens once to show it. */
	static boolean newError(BoatAccount.Status before, BoatAccount.Status after) {
		boolean had = before != null && before.error() != null && !before.error().isBlank();
		boolean has = after != null && after.error() != null && !after.error().isBlank();
		return has && (!had || !Objects.equals(before.error(), after.error()));
	}

	/** True when the rail's layout changes; the cost ticking up only redraws in place. */
	static boolean boatShapeChanged(BoatAccount.Status before, BoatAccount.Status after) {
		if (before == null || after == null) return before != after;
		return !Objects.equals(before.phase(), after.phase()) || before.signedIn() != after.signedIn()
				|| !Objects.equals(before.via(), after.via()) || !Objects.equals(before.error(), after.error());
	}

	private boolean shownRunsOnBoat() {
		return runsOnPending != null ? runsOnPending : boatSettings.runsOnBoat();
	}

	private void initBoard() {
		if (!boatRead) readBoat();
		drawerWidgets.clear();
		MissionBoardLayout layout = MissionBoardLayout.calculate(width, height, builtBannerInset);
		AgentControlAgent agent = selectedAgent();
		if (body == null) body = AgentBody.read(minecraft, agent);

		// The compute pill and its drawer come first, so an open drawer takes clicks before anything under it.
		AgentControlLayout shell = layout.shell();
		int middle = shell.panelTop() + AgentControlLayout.HEADER_HEIGHT / 2 + 2;
		computePill = new ComputePill(font, shell.contentRight(), middle - 8, 16, this::pillLook, () -> computeOpen, () -> {
			computeOpen = !computeOpen;
			railScroll = 0;
			rebuildWidgets();
		});
		computePill.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.translatable("screen.mineagen.board.compute_hint")));
		addRenderableWidget(computePill);
		AgentControlLayout.Bounds drawer = layout.drawer();
		AgentControlLayout.Bounds railView = new AgentControlLayout.Bounds(drawer.left(), Math.min(drawer.bottom(), drawer.top() + DRAWER_HEADER),
				drawer.right(), drawer.bottom() - 6);
		int railWidth = Math.max(40, drawer.width() - DRAWER_PAD * 2);
		int railScrollMaximum = Math.max(0, buildRail(0, 0, railWidth).bottom() + 16 - railView.height());
		railScroll = Math.clamp(railScroll, 0, railScrollMaximum);
		Rail rail = buildRail(drawer.left() + DRAWER_PAD, railView.top() + 2 - railScroll, railWidth);
		if (computeOpen) {
			addRailWidgets(rail);
			for (AbstractWidget widget : drawerWidgets) widget.visible = widget.getY() >= railView.top() && widget.getBottom() <= railView.bottom();
		}

		// Left: a count and "All" over the agents, then New agent right under the last one.
		AgentControlLayout.Bounds list = layout.list();
		List<AgentControlAgent> agents = snapshot == null ? List.of() : snapshot.agents();
		boolean compact = layout.listCompact();
		int rowsTop = compact ? list.top() : list.top() + 16;
		int rowsBottom = Math.max(rowsTop, list.bottom() - LIST_ROW - LIST_ROW_GAP);
		boolean moreAbove = false, moreBelow = false;
		if (list.width() >= MissionBoardLayout.LIST_COMPACT) {
			if (!agents.isEmpty() && !compact) {
				String all = tr("screen.mineagen.board.all");
				int allWidth = ConsoleButton.fittedWidth(font, all, false, true);
				ConsoleButton roster = ghostButton(all, list.right() - allWidth + 8, list.top() - 1, allWidth, 12, () -> show(Page.ROSTER)).small();
				roster.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.translatable("screen.mineagen.board.all_agents")));
				addRenderableWidget(roster);
			}
			int capacity = Math.max(0, (rowsBottom - rowsTop + LIST_ROW_GAP) / (LIST_ROW + LIST_ROW_GAP));
			// An overflowing list sets New agent 8px lower to clear the more-below chevron; reserve that gap too.
			if (agents.size() > capacity) capacity = Math.max(0, (rowsBottom - 8 - rowsTop + LIST_ROW_GAP) / (LIST_ROW + LIST_ROW_GAP));
			listScroll = Math.clamp(listScroll, 0, Math.max(0, agents.size() - capacity));
			int shown = 0;
			for (int index = 0; index < capacity && listScroll + index < agents.size(); index++) {
				AgentControlAgent row = agents.get(listScroll + index);
				addRenderableWidget(new AgentListRow(font, list.left(), rowsTop + index * (LIST_ROW + LIST_ROW_GAP), list.width(), LIST_ROW,
						row, row.agentId().equals(managementSelection.selectedAgentId()), () -> {
							selectAgent(row.agentId());
							body = AgentBody.read(minecraft, selectedAgent());
							rebuildWidgets();
						}, () -> {
							selectAgent(row.agentId());
							show(Page.MANAGE);
						}));
				shown++;
			}
			moreAbove = listScroll > 0;
			moreBelow = listScroll + capacity < agents.size();
			// New agent is the list's last row, a quiet one; a narrow list keeps the plus alone, named by its tooltip.
			int newTop = rowsTop + shown * (LIST_ROW + LIST_ROW_GAP) + (moreBelow ? 8 : 0);
			if (newTop + LIST_ROW <= list.bottom()) {
				ConsoleButton create = ghostButton(compact ? "" : tr("screen.mineagen.board.new_agent"), list.left(), newTop, list.width(), LIST_ROW,
						() -> show(Page.CREATE)).withIcon(ConsoleDraw.Icon.PLUS);
				create.active = canControl();
				if (compact) create.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.translatable("screen.mineagen.board.new_agent")));
				addRenderableWidget(create);
			}
		}

		// Centre: the live view, scrolling only when the column is shorter than its parts.
		AgentControlLayout.Bounds view = layout.centre();
		int natural = BoardLiveView.naturalHeight(view.width());
		int scrollMaximum = layout.centreScrollMaximum(natural);
		centreScroll = Math.clamp(centreScroll, 0, scrollMaximum);
		int liveTop = view.top() - centreScroll;
		AgentControlLayout.Bounds live = new AgentControlLayout.Bounds(view.left(), liveTop, view.right(), liveTop + layout.liveHeight(natural));
		int liveStart = children().size();
		BoardLiveView.Frame frame = agent == null ? null : frame(agent);
		boolean idle = frame != null && BoardLiveView.idle(frame);
		int actionsWidth = 0;
		if (agent != null) actionsWidth = addLiveButtons(agent, BoardLiveView.parts(live, idle).hero(), body != null);
		if (idle) addIdeas(BoardLiveView.parts(live, true).mission());
		if (agents.isEmpty() && snapshot != null) {
			String label = tr("screen.mineagen.board.create_first");
			int w = ConsoleButton.fittedWidth(font, label, true, false);
			ConsoleButton first = primaryButton(label, (view.left() + view.right() - w) / 2, emptyStateTop(live, view) + 74, w, ROW_HEIGHT,
					() -> show(Page.CREATE)).withIcon(ConsoleDraw.Icon.PLUS);
			first.active = canControl();
			addRenderableWidget(first);
		}
		hideOutside(liveStart, children().size(), view);
		if (computeOpen) {
			for (var child : children().subList(liveStart, children().size())) {
				if (child instanceof AbstractWidget widget && overlaps(widget, drawer)) widget.visible = false;
			}
		}
		addTaskRow(layout.taskRow(), agent);
		board = new Board(layout, view, railView, live, rail, rowsTop, rowsBottom, moreAbove, moreBelow, scrollMaximum, railScrollMaximum,
				idle, body != null, actionsWidth);
	}

	/** Space above the drawer's rows for its title and one line of help. */
	static final int DRAWER_HEADER = 34;
	static final int DRAWER_PAD = 12;

	private <T extends AbstractWidget> T addDrawer(T widget) {
		drawerWidgets.add(widget);
		addWidget(widget);
		return widget;
	}

	private static boolean overlaps(AbstractWidget widget, AgentControlLayout.Bounds bounds) {
		return widget.getRight() > bounds.left() && widget.getX() < bounds.right()
				&& widget.getBottom() > bounds.top() && widget.getY() < bounds.bottom();
	}

	/** What the compute pill shows now: read each frame so the cost ticks without a rebuild. */
	private ComputePill.Look pillLook() {
		BoatPanelPresentation.Pill pill = BoatPanelPresentation.pill(boatStatus, boatSettings,
				BoatPanelPresentation.providerRows(AgentControlCatalog.providerRows(), boatStatus));
		String text = pill.arg().isEmpty() ? tr(pill.key()) : tr(pill.key(), pill.arg());
		return new ComputePill.Look(text, pill.tone() == BoatPanelPresentation.Tone.MUTED ? ConsoleTheme.SUBTLE : boatToneColor(pill.tone()),
				pill.attention());
	}

	/** Everything the live view draws for {@code agent}, read once per frame. */
	private BoardLiveView.Frame frame(AgentControlAgent agent) {
		com.google.gson.JsonObject liveJson = dev.agaminggod.mineagen.client.control.LiveAgentWindows.liveView(agent);
		AgentNowCard.Live now = AgentNowCard.Live.from(liveJson);
		long stateMs = stateMs(agent);
		String inState = stateMs >= 0 ? tr("screen.mineagen.board.in_state", ago(stateMs)) : "";
		var attention = AgentNowCard.rows(agent, stateMs, now).stream()
				.filter(row -> row.kind() == AgentNowCard.Kind.WARNING || row.kind() == AgentNowCard.Kind.ERROR)
				.findFirst();
		int actionsWidth = board == null ? 0 : board.actionsWidth();
		return new BoardLiveView.Frame(agent, body, liveJson, inState,
				attention.map(row -> row.label() + ": " + row.text()).orElse(""),
				attention.map(row -> ConsoleTheme.stateColor(row.tone())).orElse(ConsoleTheme.WARNING), actionsWidth, boardMouseX, boardMouseY);
	}

	/** Controls scrolled outside {@code view} hide, so they neither draw over the header nor take clicks. */
	private void hideOutside(int from, int to, AgentControlLayout.Bounds view) {
		for (var child : children().subList(from, to)) {
			if (child instanceof AbstractWidget widget) {
				widget.visible = widget.getY() >= view.top() && widget.getBottom() <= view.bottom();
			}
		}
	}

	/**
	 * Pause or Resume, Respawn and Manage, small and quiet at the hero's top right on the name's line. A narrow hero
	 * keeps their icons alone, named by tooltips. Returns the width they take.
	 */
	private int addLiveButtons(AgentControlAgent agent, AgentControlLayout.Bounds hero, boolean hasBody) {
		boolean canStop = AgentControlActions.supports(agent, "stop");
		boolean canResume = !canStop && AgentControlActions.supports(agent, "resume");
		String operation = canResume ? "resume" : "stop";
		List<String> labels = List.of(tr(canResume ? "screen.mineagen.resume" : "screen.mineagen.stop"), tr("screen.mineagen.respawn"),
				tr("screen.mineagen.board.manage"));
		List<ConsoleDraw.Icon> icons = List.of(canResume ? ConsoleDraw.Icon.PLAY : ConsoleDraw.Icon.PAUSE, ConsoleDraw.Icon.RESPAWN,
				ConsoleDraw.Icon.AGENTS);
		int full = 0;
		for (String label : labels) full += ConsoleButton.fittedWidth(font, label, true, true) + 4;
		boolean iconsOnly = hero.right() - BoardLiveView.infoLeft(hero) - full < 150;
		int y = BoardLiveView.infoTop(hero, hasBody) - 3;
		int x = hero.right();
		List<Runnable> actions = List.of(() -> submitBoardOperation(operation), () -> submitBoardOperation("respawn"), () -> show(Page.MANAGE));
		List<Boolean> enabled = List.of(canControl() && (canStop || canResume && canUseAutomation()),
				canControl() && AgentControlActions.supports(agent, "respawn"), canControl());
		for (int index = labels.size() - 1; index >= 0; index--) {
			int w = iconsOnly ? 20 : ConsoleButton.fittedWidth(font, labels.get(index), true, true);
			x -= w;
			ConsoleButton button = consoleButton(Component.literal(iconsOnly ? "" : labels.get(index)), x, y, w, 18, false, actions.get(index))
					.withIcon(icons.get(index)).small();
			if (iconsOnly) button.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal(labels.get(index))));
			button.active = enabled.get(index);
			addRenderableWidget(button);
			x -= 4;
		}
		return hero.right() - x;
	}

	/** Three task ideas under an idle agent; a click puts the text in the task box, ready to Start. */
	private void addIdeas(AgentControlLayout.Bounds strip) {
		int x = strip.left();
		int y = BoardLiveView.ideasTop(strip);
		for (String key : List.of("screen.mineagen.board.idea.wood", "screen.mineagen.board.idea.iron", "screen.mineagen.board.idea.beat")) {
			String label = tr(key);
			int w = ConsoleButton.fittedWidth(font, label, false, true);
			if (x + w > strip.right()) break;
			ConsoleButton idea = consoleButton(Component.literal(label), x, y, w, 18, false, () -> {
				prompt = label;
				if (taskInput != null) {
					taskInput.setValue(label);
					setFocused(taskInput);
				}
			}).small();
			idea.active = canUseAutomation();
			addRenderableWidget(idea);
			x += w + 6;
		}
	}

	private int emptyStateTop(AgentControlLayout.Bounds live, AgentControlLayout.Bounds view) {
		return live.top() + Math.max(0, (Math.min(live.bottom(), view.bottom()) - live.top()) / 2 - 52);
	}

	/** The bottom row: one line of task text and Start, Queue and Steer, for the agent picked in the list. */
	private void addTaskRow(AgentControlLayout.Bounds row, AgentControlAgent agent) {
		List<String> operations = List.of("start", "queue", "steer");
		List<String> labels = List.of(tr("screen.mineagen.start"), tr("screen.mineagen.queue"), tr("screen.mineagen.steer"));
		int buttons = 0;
		int[] widths = new int[3];
		for (int index = 0; index < 3; index++) {
			widths[index] = ConsoleButton.fittedWidth(font, labels.get(index), index == 0, false);
			buttons += widths[index] + GAP;
		}
		int boxWidth = Math.max(40, row.width() - buttons);
		taskInput = new ConsoleEditBox(font, row.left(), row.top(), boxWidth, ROW_HEIGHT,
				Component.translatable("screen.mineagen.prompt"), agent == null
						? Component.translatable("screen.mineagen.board.task_hint_none")
						: Component.translatable("screen.mineagen.board.task_hint", agent.displayName()), "board-task");
		taskInput.setMaxLength(AgentConstants.MAX_PROMPT_LENGTH);
		taskInput.setValue(prompt);
		taskInput.setResponder(value -> prompt = value);
		taskInput.setEditable(agent != null && canUseAutomation());
		addRenderableWidget(taskInput);
		int x = row.left() + boxWidth + GAP;
		for (int index = 0; index < 3; index++) {
			String operation = operations.get(index);
			ConsoleButton action = index == 0
					? primaryButton(labels.get(index), x, row.top(), widths[index], ROW_HEIGHT, () -> submitBoardPrompt(operation))
							.withIcon(ConsoleDraw.Icon.PLAY)
					: consoleButton(labels.get(index), x, row.top(), widths[index], ROW_HEIGHT, false, () -> submitBoardPrompt(operation));
			action.active = agent != null && canUseAutomation() && AgentControlActions.supports(agent, operation);
			addRenderableWidget(action);
			x += widths[index] + GAP;
		}
	}

	/** Places the rail's parts from {@code top}; measured with top 0 first so a folded column knows how far it scrolls. */
	private Rail buildRail(int left, int top, int width) {
		int inner = Math.max(24, width);
		int y = top + LABEL_HEIGHT - 2 + MissionBoardLayout.ROW + 8;
		int consentY = -1;
		List<String> consent = List.of();
		if (consentPending) {
			consentY = y;
			consent = wrap(tr(BoatPanelPresentation.CONSENT_KEY), width - 10);
			y += consent.size() * 10 + 4 + MissionBoardLayout.ROW + 8;
		}
		BoatPanelPresentation.Machine machine = BoatPanelPresentation.machine(boatStatus, boatSettings);
		List<String> head = new ArrayList<>(wrap(tr(machine.titleKey()), inner));
		int titleLines = head.size();
		if (!machine.detailKey().isEmpty()) head.addAll(wrap(tr(machine.detailKey()), inner));
		if (machine.specShown()) head.addAll(wrap(tr("screen.mineagen.boat.spec", BoatAccount.MACHINE_SIZE, perHour()), inner));
		int machineY = y;
		int height = 6 + head.size() * MACHINE_LINE + (head.size() > titleLines ? MACHINE_TITLE_GAP : 0);
		int costY = -1, progressY = -1, errorY = -1, actionY = -1;
		if (machine.costShown()) {
			costY = machineY + height + 2;
			height += 2 + MACHINE_LINE;
		}
		if (machine.progress()) {
			progressY = machineY + height + 2;
			height += 8;
		}
		List<String> errors = machine.error() == null ? List.of()
				: capBannerLines(wrap(tr("screen.mineagen.boat.error", machine.error()), inner), 2, inner, value -> ConsoleText.width(font, value));
		if (!errors.isEmpty()) {
			errorY = machineY + height;
			height += errors.size() * 10;
		}
		if (machine.action() != BoatPanelPresentation.Action.NONE) {
			actionY = machineY + height + 4;
			height += 4 + 18;
		}
		height += 6;
		y = machineY + height + 8;
		int providersY = y;
		// Boat's own sign-in lives in the machine section just above, so its provider row would repeat it.
		List<BoatPanelPresentation.ProviderRow> providers = BoatPanelPresentation.providerRows(AgentControlCatalog.providerRows(), boatStatus)
				.stream().filter(row -> !"boat".equals(row.id())).toList();
		y += 12 + providers.size() * 22 - 2;
		return new Rail(left, width, top, consentY, consent, machineY, height, machine, List.copyOf(head), titleLines,
				costY, progressY, errorY, errors, actionY, providersY, providers, y);
	}

	private List<String> wrap(String text, int width) {
		return AgentControlResult.wrap(text, Math.max(8, width), value -> ConsoleText.width(font, value));
	}

	private static String perHour() {
		return tr("screen.mineagen.boat.per_hour", BoatPanelPresentation.dollars(BoatAccount.DOLLARS_PER_HOUR));
	}

	private void addRailWidgets(Rail rail) {
		boolean host = boatStatus != null;
		ConsoleSegmented<String> runsOn = new ConsoleSegmented<>(font, rail.left(), rail.switchY(), rail.width(), MissionBoardLayout.ROW,
				tr("screen.mineagen.board.runs_on"), List.of("local", "boat"), shownRunsOnBoat() ? "boat" : "local",
				value -> value.equals("boat") ? tr("screen.mineagen.board.boat") : tr("screen.mineagen.board.this_pc"), this::changeRunsOn);
		runsOn.active = host && !consentPending;
		if (!host) runsOn.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.translatable("screen.mineagen.boat.local_only")));
		addDrawer(runsOn);
		if (rail.consentY() >= 0) {
			int y = rail.consentY() + rail.consentLines().size() * 10 + 4;
			int half = (rail.width() - GAP) / 2;
			addDrawer(primaryButton(tr("screen.mineagen.boat.consent_accept"), rail.left(), y, half, MissionBoardLayout.ROW,
					this::acceptBoatConsent));
			addDrawer(ghostButton(tr("screen.mineagen.boat.consent_cancel"), rail.left() + half + GAP, y,
					rail.width() - half - GAP, MissionBoardLayout.ROW, () -> {
						consentPending = false;
						rebuildWidgets();
					}));
		}
		BoatPanelPresentation.Machine machine = rail.machine();
		if (rail.actionY() >= 0) {
			String label = tr(machine.actionKey());
			int x = rail.left(), w = rail.width();
			ConsoleButton action = switch (machine.action()) {
				case STOP_MACHINE -> dangerButton(label, x, rail.actionY(), w, 18, () -> boatRailAction(machine.action().command(),
						tr("screen.mineagen.boat.stopping_sent")));
				case SIGN_OUT -> ghostButton(label, x - 6, rail.actionY(), ConsoleButton.fittedWidth(font, label, false, true), 18,
						() -> boatRailAction(machine.action().command(), tr("screen.mineagen.boat.signing_out"))).small();
				default -> consoleButton(Component.literal(label), x, rail.actionY(), w, 18, false,
						() -> boatRailAction(machine.action().command(), tr("screen.mineagen.boat.opening", tr("screen.mineagen.provider.boat"))));
			};
			action.active = host;
			addDrawer(action);
		}
		String keys = tr("screen.mineagen.board.keys");
		int keysWidth = ConsoleButton.fittedWidth(font, keys, true, true);
		ConsoleButton keysLink = ghostButton(keys, rail.left() + rail.width() - keysWidth + 8, rail.providersY(), keysWidth, 12, () -> {
			keysReturn = Page.OVERVIEW;
			show(Page.KEYS);
		}).withIcon(ConsoleDraw.Icon.KEY).small();
		addDrawer(keysLink);
		for (int index = 0; index < rail.providers().size(); index++) {
			BoatPanelPresentation.ProviderRow row = rail.providers().get(index);
			if (!row.signIn()) continue;
			int y = rail.providersY() + 12 + index * 22;
			String label = tr(row.signInKey());
			int nameRoom = providerNameLeft(row.id(), 0) + ConsoleText.strongWidth(font, tr(row.nameKey())) + 8;
			int w = Math.max(40, Math.min(ConsoleButton.fittedWidth(font, label, false, true), rail.width() - nameRoom));
			ConsoleButton signIn = consoleButton(Component.literal(label), rail.left() + rail.width() - w, y + 1, w, 18, false,
					() -> boatRailAction(row.signInAction(), tr("screen.mineagen.boat.opening", tr(row.nameKey())))).small();
			signIn.active = host;
			signIn.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal(
					tr(row.statusKey()) + (host ? "" : ". " + tr("screen.mineagen.boat.local_only")))));
			addDrawer(signIn);
		}
	}

	/** What a click on the Runs on switch does. Boat always waits for consent first, since it receives the model sign-in. */
	enum RunsOnStep { NOTHING, ASK_CONSENT, SIGN_IN_FIRST, HOST_ONLY, SWITCH_LOCAL }

	static RunsOnStep runsOnStep(String value, boolean shownBoat, BoatAccount.Status status) {
		if ("boat".equals(value)) {
			if (shownBoat) return RunsOnStep.NOTHING;
			if (status == null) return RunsOnStep.HOST_ONLY;
			return status.signedIn() ? RunsOnStep.ASK_CONSENT : RunsOnStep.SIGN_IN_FIRST;
		}
		return shownBoat ? RunsOnStep.SWITCH_LOCAL : RunsOnStep.NOTHING;
	}

	/** Accepted consent: consent first, then the switch, and the switch only if consent was taken. */
	static boolean sendSwitchToBoat(java.util.function.Predicate<String> sink) {
		return sink.test("consent:on") && sink.test("runs_on:boat");
	}

	private void changeRunsOn(String value) {
		RunsOnStep step = runsOnStep(value, shownRunsOnBoat(), boatStatus);
		consentPending = step == RunsOnStep.ASK_CONSENT;
		switch (step) {
			case SIGN_IN_FIRST -> setFeedback(tr("screen.mineagen.boat.sign_in_first"), true);
			case HOST_ONLY -> setFeedback(tr("screen.mineagen.boat.local_only"), true);
			case SWITCH_LOCAL -> {
				if (boatAction("runs_on:local")) {
					runsOnPending = false;
					runsOnPendingAt = System.currentTimeMillis();
					setFeedback(tr("screen.mineagen.boat.switching_local"), false);
				} else {
					setFeedback(tr("screen.mineagen.boat.local_only"), true);
				}
			}
			case NOTHING, ASK_CONSENT -> { }
		}
		rebuildWidgets();
	}

	private void acceptBoatConsent() {
		consentPending = false;
		if (sendSwitchToBoat(AgentControlScreen::boatAction)) {
			runsOnPending = true;
			runsOnPendingAt = System.currentTimeMillis();
			setFeedback(tr("screen.mineagen.boat.switching_boat"), false);
		} else {
			setFeedback(tr("screen.mineagen.boat.local_only"), true);
		}
		rebuildWidgets();
	}

	private void boatRailAction(String action, String pending) {
		if (boatAction(action)) setFeedback(pending, false);
		else setFeedback(tr("screen.mineagen.boat.local_only"), true);
		boatPollCountdown = 2;
		rebuildWidgets();
	}

	private static boolean boatAction(String action) {
		try {
			return boatActionSink.test(action);
		} catch (RuntimeException failure) {
			return false;
		}
	}

	private void submitBoardPrompt(String operation) {
		AgentControlAgent agent = selectedAgent();
		if (agent == null || rejectPendingMutation()) return;
		if (!canUseAutomation()) {
			setFeedback(snapshot == null ? "Automation is not ready" : snapshot.automationStatus(), true);
			return;
		}
		try {
			String text = taskInput == null ? prompt : taskInput.getValue();
			String command = AgentControlCommandBuilder.prompt(operation, agent.agentId(), text);
			if (send(command, "Sending task...")) {
				prompt = "";
				if (taskInput != null) taskInput.setValue("");
			}
		} catch (IllegalArgumentException exception) {
			setFeedback(exception.getMessage(), true);
		}
	}

	private void submitBoardOperation(String operation) {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) return;
		send(AgentControlCommandBuilder.agent(operation, agent.agentId()), "Updating " + agent.displayName() + "...");
	}

	private boolean boardScrolled(double mouseX, double mouseY, double amount) {
		if (amount == 0) return false;
		Board current = board;
		int step = (int) Math.signum(amount);
		if (inside(current.layout().list(), mouseX, mouseY) && (current.listMoreAbove() || current.listMoreBelow())) {
			listScroll = Math.max(0, listScroll - step);
			rebuildWidgets();
			return true;
		}
		if (computeOpen && inside(current.layout().drawer(), mouseX, mouseY)) {
			if (current.railScrollMaximum() > 0) {
				railScroll = Math.clamp(railScroll - step * 24, 0, current.railScrollMaximum());
				rebuildWidgets();
			}
			return true;
		}
		if (inside(current.view(), mouseX, mouseY) && current.centreScrollMaximum() > 0) {
			centreScroll = Math.clamp(centreScroll - step * 24, 0, current.centreScrollMaximum());
			rebuildWidgets();
			return true;
		}
		return false;
	}

	private static boolean inside(AgentControlLayout.Bounds bounds, double x, double y) {
		return x >= bounds.left() && x < bounds.right() && y >= bounds.top() && y < bounds.bottom();
	}

	private static boolean shows(AgentControlLayout.Bounds view, int y, int height) {
		return y >= view.top() && y + height <= view.bottom();
	}

	private void renderBoard(GuiGraphicsExtractor graphics) {
		Board current = board;
		if (current == null) return;
		MissionBoardLayout layout = current.layout();
		if (layout.list().width() > 0) {
			int x = (layout.list().right() + layout.centre().left()) / 2;
			ConsoleDraw.vhairline(graphics, x, layout.centre().top(), layout.centre().bottom(), ConsoleTheme.HAIRLINE);
		}
		renderBoardList(graphics, current);
		renderLive(graphics, current);
		if (centreScroll < current.centreScrollMaximum()) {
			// Fade the last rows under the chevron so it never sits on top of text.
			graphics.fillGradient(current.view().left(), current.view().bottom() - 18, current.view().right(), current.view().bottom(),
					ConsoleDraw.withAlpha(PANEL, 0F), PANEL);
			ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHEVRON_DOWN, (current.view().left() + current.view().right()) / 2 - 6,
					current.view().bottom() - 8, ConsoleTheme.SUBTLE);
		}
	}

	private void renderBoardList(GuiGraphicsExtractor graphics, Board current) {
		AgentControlLayout.Bounds list = current.layout().list();
		int middle = (list.left() + list.right()) / 2 - 4;
		if (current.listMoreAbove()) ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHEVRON_DOWN, middle, current.listRowsTop() - 7, 8, ConsoleTheme.SUBTLE);
		if (current.layout().listCompact() || list.width() < 48) return;
		int count = snapshot == null ? 0 : snapshot.agents().size();
		ConsoleDraw.label(graphics, font, tr("screen.mineagen.board.agents", count), list.left() + 2, list.top() + 2, ConsoleTheme.SUBTLE);
	}

	private void renderLive(GuiGraphicsExtractor graphics, Board current) {
		AgentControlLayout.Bounds live = current.live();
		AgentControlLayout.Bounds view = current.view();
		int left = live.left(), right = live.right();
		if (snapshot == null || snapshot.agents().isEmpty()) {
			Optional<String> error = snapshot == null ? AgentControlClient.snapshotError() : Optional.empty();
			String title = snapshot != null ? tr("screen.mineagen.board.empty.title")
					: error.isPresent() ? tr("screen.mineagen.board.unreachable") : tr("screen.mineagen.board.loading");
			String detail = snapshot != null ? tr("screen.mineagen.board.empty.detail") : error.orElse("");
			int top = emptyStateTop(live, view);
			if (shows(view, top, 70)) renderEmptyStateAt(graphics, left, right, top, title, detail, error.isPresent() ? ERROR : MUTED);
			return;
		}
		AgentControlAgent agent = selectedAgent();
		if (agent == null) return;
		BoardLiveView.Frame frame = frame(agent);
		// The idle ideas and the buttons' line are placed at build; a change of either rebuilds the board.
		if (BoardLiveView.idle(frame) != current.idle() || (body != null) != current.bodyShown()) widgetRefreshPending = true;
		if (liveView == null) liveView = new BoardLiveView(font);
		liveView.render(graphics, view, current.live(), frame);
	}

	/** The drawer over the live view's right side: where agents run, the machine, and each model tool's sign-in. */
	private void renderDrawer(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float partialTick) {
		Board current = board;
		if (current == null || !computeOpen) return;
		AgentControlLayout.Bounds drawer = current.layout().drawer();
		if (drawer.height() <= 0) return;
		// Above the hero's body and hotbar items, which draw in their own pass.
		graphics.nextStratum();
		ConsoleDraw.shadow(graphics, drawer.left(), drawer.top(), drawer.width(), drawer.height(), 0x90);
		ConsoleDraw.surface(graphics, drawer.left(), drawer.top(), drawer.width(), drawer.height(), ConsoleDraw.RADIUS_CARD, ConsoleTheme.POPUP);
		ConsoleDraw.hairline(graphics, drawer.left(), drawer.right(), drawer.top(), 0x1CFFFFFF);
		int left = drawer.left() + DRAWER_PAD;
		graphics.text(font, ConsoleText.strong(fitStrong(tr("screen.mineagen.board.compute"), drawer.width() - DRAWER_PAD * 2)), left, drawer.top() + 10, TEXT, false);
		ConsoleDraw.label(graphics, font, fitLabel(tr("screen.mineagen.board.compute_hint"), drawer.width() - DRAWER_PAD * 2), left, drawer.top() + 22,
				ConsoleTheme.SUBTLE);
		AgentControlLayout.Bounds view = current.railView();
		graphics.enableScissor(view.left(), view.top(), view.right(), view.bottom());
		try {
			renderRail(graphics, current);
			for (AbstractWidget widget : drawerWidgets) widget.extractRenderState(graphics, mouseX, mouseY, partialTick);
		} finally {
			graphics.disableScissor();
		}
		if (railScroll < current.railScrollMaximum()) {
			// Fade the rows out under the chevron so it never sits on a name.
			graphics.fillGradient(drawer.left(), view.bottom() - 22, drawer.right(), view.bottom(),
					ConsoleDraw.withAlpha(ConsoleTheme.POPUP, 0F), ConsoleTheme.POPUP);
			ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHEVRON_DOWN, (view.left() + view.right()) / 2 - 6, view.bottom() - 10, ConsoleTheme.SUBTLE);
		}
	}

	/** Complete and total steps of the live plan; {0, 0} with no plan. */
	static int[] planProgress(com.google.gson.JsonObject view) {
		if (view == null || !view.has("plan") || !view.get("plan").isJsonObject()) return new int[] {0, 0};
		com.google.gson.JsonObject plan = view.getAsJsonObject("plan");
		if (!plan.has("steps") || !plan.get("steps").isJsonArray()) return new int[] {0, 0};
		int done = 0, total = 0;
		for (var element : plan.getAsJsonArray("steps")) {
			if (!element.isJsonObject()) continue;
			total++;
			var status = element.getAsJsonObject().get("status");
			if (status != null && status.isJsonPrimitive() && "complete".equals(status.getAsString())) done++;
		}
		return new int[] {done, total};
	}

	private void renderRail(GuiGraphicsExtractor graphics, Board current) {
		Rail rail = current.rail();
		int left = rail.left(), width = rail.width();
		ConsoleDraw.label(graphics, font, tr("screen.mineagen.board.runs_on"), left, rail.top(), ConsoleTheme.SUBTLE);
		if (!rail.consentLines().isEmpty()) {
			int y = rail.consentY();
			graphics.fill(left, y - 1, left + 2, y + rail.consentLines().size() * 10 - 1, ConsoleTheme.WARNING);
			for (int index = 0; index < rail.consentLines().size(); index++) {
				graphics.text(font, ConsoleText.component(rail.consentLines().get(index)), left + 8, y + index * 10, TEXT, false);
			}
		}
		BoatPanelPresentation.Machine machine = rail.machine();
		int tone = boatToneColor(machine.tone());
		// The machine: a section between two hairlines, not a card; its state in a dot after the title.
		ConsoleDraw.hairline(graphics, left, left + width, rail.machineY(), ConsoleTheme.HAIRLINE);
		ConsoleDraw.hairline(graphics, left, left + width, rail.machineY() + rail.machineHeight(), ConsoleTheme.HAIRLINE);
		int mark = BrandMarks.draw(graphics, BrandMarks.Mark.BOAT, left, rail.machineY() + 4, BrandMarks.SMALL);
		for (int index = 0; index < rail.head().size(); index++) {
			String line = rail.head().get(index);
			int y = rail.machineY() + 6 + index * MACHINE_LINE + (index >= rail.titleLines() ? MACHINE_TITLE_GAP : 0);
			if (index < rail.titleLines()) {
				int x = left + (index == 0 && mark > 0 ? mark + 5 : 0);
				graphics.text(font, ConsoleText.strong(line), x, y, TEXT, false);
				if (index == 0) {
					int dotX = x + ConsoleText.strongWidth(font, line) + 6;
					if (dotX + 5 <= left + width - 6) ConsoleDraw.surface(graphics, dotX, y + 2, 5, 5, ConsoleDraw.RADIUS_SMALL, tone);
				}
			} else {
				graphics.text(font, ConsoleText.component(line), left, y, index == rail.head().size() - 1 && machine.specShown() ? ConsoleTheme.SUBTLE : MUTED, false);
			}
		}
		if (rail.costY() >= 0 && boatStatus != null) {
			graphics.text(font, ConsoleText.strong(fit(tr("screen.mineagen.boat.cost", BoatPanelPresentation.dollars(boatStatus.costDollars())),
					width)), left, rail.costY(), TEXT, false);
		}
		if (rail.progressY() >= 0) {
			int track = width;
			graphics.fill(left, rail.progressY() + 1, left + track, rail.progressY() + 3, 0x14FFFFFF);
			// The runner reports no percentage while a machine starts, so the bar sweeps instead of claiming progress.
			int segment = Math.max(8, track / 3);
			int offset = (int) ((System.currentTimeMillis() / 12L) % (track + segment)) - segment;
			int from = Math.max(0, offset), to = Math.min(track, offset + segment);
			if (to > from) graphics.fill(left + from, rail.progressY() + 1, left + to, rail.progressY() + 3, ConsoleTheme.WARNING);
		}
		for (int index = 0; index < rail.errors().size(); index++) {
			graphics.text(font, ConsoleText.component(rail.errors().get(index)), left, rail.errorY() + index * 10, ERROR, false);
		}
		ConsoleDraw.label(graphics, font, tr("screen.mineagen.board.found"), left, rail.providersY() + 2, ConsoleTheme.SUBTLE);
		for (int index = 0; index < rail.providers().size(); index++) {
			BoatPanelPresentation.ProviderRow row = rail.providers().get(index);
			int y = rail.providersY() + 12 + index * 22;
			if (index > 0) ConsoleDraw.hairline(graphics, left, left + width, y, ConsoleTheme.HAIRLINE);
			int nameLeft = providerNameLeft(row.id(), left - 8);
			BrandMarks.draw(graphics, BrandMarks.forProvider(row.id()), left, y + 5, BrandMarks.SMALL);
			String name = tr(row.nameKey());
			graphics.text(font, ConsoleText.strong(name), nameLeft, y + 6, TEXT, false);
			if (!row.signIn()) {
				String status = tr(row.statusKey());
				int room = width - (nameLeft - left) - ConsoleText.strongWidth(font, name) - 10;
				String shown = fitLabel(status, Math.max(12, room));
				int statusColor = row.tone() == BoatPanelPresentation.Tone.SUCCESS ? MUTED : boatToneColor(row.tone());
				ConsoleDraw.label(graphics, font, shown, left + width - ConsoleDraw.labelWidth(font, shown), y + 7, statusColor);
			}
		}
	}

	/** Where a provider row's name starts: after its logo when the logo ships, else at the row's padding. */
	private static int providerNameLeft(String id, int left) {
		int mark = BrandMarks.width(BrandMarks.forProvider(id), BrandMarks.SMALL);
		return left + 8 + (mark > 0 ? mark + 5 : 0);
	}

	static int boatToneColor(BoatPanelPresentation.Tone tone) {
		return switch (tone) {
			case BOAT -> ConsoleTheme.BOAT;
			case WARNING -> ConsoleTheme.WARNING;
			case ERROR -> ConsoleTheme.ERROR;
			case SUCCESS -> ConsoleTheme.SUCCESS;
			case MUTED -> ConsoleTheme.MUTED;
		};
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
		ConsoleButton create = consoleButton("New agent", x, y, width, ROW_HEIGHT, false, () -> show(Page.CREATE))
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
		ConsoleButton create = consoleButton("New agent", x + (buttonWidth + GAP) * 2, y, width - (buttonWidth + GAP) * 2,
				ROW_HEIGHT, false, () -> show(Page.CREATE)).withIcon(ConsoleDraw.Icon.PLUS);
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
					ConsoleTheme.providerColor(row.id()), chosen, () -> chooseProvider(row.id())).withMark(providerMark(row.id())).withBrand(BrandMarks.forProvider(row.id()));
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
		// The owner's bare logo on the panel; the tinted glyph square is only the fallback when no logo ships.
		int brandWidth = BrandMarks.width(BrandMarks.forProvider(id), BrandMarks.LARGE);
		if (brandWidth > 0) {
			BrandMarks.draw(graphics, BrandMarks.forProvider(id), x + (size - brandWidth) / 2, y + (size - BrandMarks.LARGE) / 2, BrandMarks.LARGE);
			return;
		}
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
			ConsoleDraw.hairline(graphics, x, x + width, y + rowHeight, ConsoleTheme.HAIRLINE);
			renderProviderMark(graphics, row.id(), row.label(), x + 8, y + 10, 20);
			String title = row.label() + (row.version() == null ? "" : "  v" + row.version());
			graphics.text(font, ConsoleText.strong(fit(title, width - 150)), x + 36, y + 9, TEXT, false);
			ConsoleDraw.surface(graphics, x + 36, y + 24, 4, 4, ConsoleDraw.RADIUS_SMALL, providerStatusColor(row));
			// The line ends before the row's button; the button's tooltip carries the full sentence.
			ConsoleDraw.label(graphics, font, fitLabel(keyStatusLine(row), width - 43 - 112), x + 43, y + 22, MUTED);
			y += PROVIDER_KEY_ROW_HEIGHT + (editing ? 30 : 0);
		}
		// Off the host machine a key cannot be saved at all, so that reason replaces the billing note.
		String note = AgentControlClient.canSaveProviderApiKey()
				? KEY_BILLING_NOTE + " A key set in the server's environment overrides one saved here."
				: AgentControlClient.LOCAL_KEY_ONLY_REASON;
		int lineY = y + 6;
		for (String line : wrap(note, width)) {
			ConsoleDraw.label(graphics, font, line, x, lineY, ConsoleTheme.SUBTLE);
			lineY += 11;
		}
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
		int backWidth = ConsoleButton.fittedWidth(font, "Back", true, false);
		addRenderableWidget(ghostButton("Back", contentRight() - backWidth + 8, y, backWidth, ROW_HEIGHT, this::navigateBack)
				.withIcon(ConsoleDraw.Icon.BACK));
	}

	private void addCreateFooter() {
		int y = layout().footerY();
		int backWidth = ConsoleButton.fittedWidth(font, "Back", true, false);
		addRenderableWidget(ghostButton("Back", contentLeft() - 8, y, backWidth, ROW_HEIGHT, this::navigateBack)
				.withIcon(ConsoleDraw.Icon.BACK));
		addRenderableWidget(ghostButton("Sign-in & keys", contentLeft() - 8 + backWidth + 8, y,
				ConsoleButton.fittedWidth(font, "Sign-in & keys", true, false), ROW_HEIGHT, () -> {
					keysReturn = Page.CREATE;
					show(Page.KEYS);
				})
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

	/**
	 * Header row: the mark and name on the left, the page's name after them only where no page title has room, and
	 * on the right one quiet status and, on the board, the compute pill.
	 */
	private void renderShell(GuiGraphicsExtractor graphics) {
		AgentControlLayout layout = layout();
		int left = layout.contentLeft();
		int middle = layout.panelTop() + AgentControlLayout.HEADER_HEIGHT / 2 + 2;
		// A wordmark only: the drawn diamond read as clip art.
		int x = left;
		graphics.text(font, ConsoleText.strong("Mineagen"), x, middle - 4, TEXT, false);
		x += ConsoleText.strongWidth(font, "Mineagen");
		String crumb = crumb(layout);
		if (!crumb.isEmpty()) {
			ConsoleDraw.vhairline(graphics, x + 8, middle - 5, middle + 5, 0x30FFFFFF);
			graphics.text(font, ConsoleText.component(crumb), x + 16, middle - 4, MUTED, false);
			x += 16 + ConsoleText.width(font, crumb);
		}
		int right = page == Page.OVERVIEW && computePill != null ? computePill.getX() - 10 : layout.contentRight();
		renderStatus(graphics, x + 12, right, middle);
		ConsoleDraw.hairline(graphics, layout.panelLeft(), layout.panelRight(), layout.headerBottom(), ConsoleTheme.HAIRLINE);
	}

	/** The page's name in the header: none on the board, none where the page shows its own title. */
	private String crumb(AgentControlLayout layout) {
		if (page == Page.OVERVIEW || layout.roomy() && page != Page.ROSTER) return "";
		AgentControlAgent agent = selectedAgent();
		String name = agent == null ? "Agent" : agent.displayName();
		return switch (page) {
			case OVERVIEW -> "";
			case ROSTER -> tr("screen.mineagen.board.all_agents");
			case CREATE -> "New agent";
			case KEYS -> "Sign-in & keys";
			case TASK -> name;
			case MANAGE -> name;
			case REMOVE_CONFIRM -> "Remove " + name;
		};
	}

	/** Page title and one line of help, shown when the panel has room for them. */
	private void renderHeader(GuiGraphicsExtractor graphics) {
		AgentControlLayout layout = layout();
		// The board names the selected agent in its live view; it has no page title.
		if (!layout.roomy() || page == Page.OVERVIEW) return;
		AgentControlAgent agent = selectedAgent();
		String title = switch (page) {
			case OVERVIEW, ROSTER -> "Your agents";
			case CREATE -> "New agent";
			case KEYS -> "Sign-in & keys";
			case TASK -> agent == null ? "Give a task" : "Give " + agent.displayName() + " a task";
			case MANAGE -> agent == null ? "Manage agent" : agent.displayName();
			case REMOVE_CONFIRM -> agent == null ? "Remove agent" : "Remove " + agent.displayName() + "?";
		};
		String help = switch (page) {
			case OVERVIEW, ROSTER -> snapshot == null || snapshot.agents().isEmpty()
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
			ConsoleDraw.vhairline(graphics, x, detailTop, detailBottom, ConsoleTheme.HAIRLINE);
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
		ConsoleDraw.hairline(graphics, area.left(), area.right(), area.top(), ConsoleTheme.HAIRLINE);
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
		renderEmptyStateAt(graphics, left, right, top + Math.max(16, (layout().contentBottom() - top) / 2 - 30), title, detail, detailColor);
	}

	private void renderEmptyStateAt(GuiGraphicsExtractor graphics, int left, int right, int y, String title, String detail, int detailColor) {
		int center = (left + right) / 2;
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

	/** Where the header status may start: after the logo, the name and the page's name. */
	private int headerStatusLeft(AgentControlLayout layout) {
		int x = layout.contentLeft() + ConsoleText.strongWidth(font, "Mineagen");
		String crumb = crumb(layout);
		if (!crumb.isEmpty()) x += 16 + ConsoleText.width(font, crumb);
		return x + 12;
	}

	/** Where the header status must end: before the compute pill on the board. */
	private int headerStatusRight(AgentControlLayout layout) {
		if (page != Page.OVERVIEW || font == null) return layout.contentRight();
		return layout.contentRight() - ComputePill.preferredWidth(font, pillLook()) - 10;
	}

	/** The status text broken into banner lines, or none when it fits on the header line. */
	private List<String> bannerLines() {
		if (font == null) return List.of();
		AgentControlLayout base = page == Page.OVERVIEW ? AgentControlLayout.calculateBoard(width, height, 0)
				: AgentControlLayout.calculate(width, height);
		String text = status().text();
		int headerRoom = Math.max(24, headerStatusRight(base) - headerStatusLeft(base) - 10);
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
	private int renderStatus(GuiGraphicsExtractor graphics, int minimumX, int right, int middle) {
		Status status = status();
		int room = Math.max(24, right - minimumX - 10);
		// A text too long for the header is shown whole in the banner below; the header then names only its kind.
		String shown = bannerHolds(bannerLines()) ? fit(status.shortText(), room) : fit(status.text(), room);
		int textWidth = ConsoleText.width(font, shown);
		// All well reads as a muted word and a small dot; only news takes the status colour.
		boolean quiet = status.color() == SUCCESS && "Online".equals(status.text());
		graphics.text(font, ConsoleText.component(shown), right - textWidth, middle - 4, quiet ? ConsoleTheme.SUBTLE : status.color(), false);
		ConsoleDraw.surface(graphics, right - textWidth - 8, middle - 2, 4, 4, ConsoleDraw.RADIUS_SMALL, status.color());
		return right - textWidth - 8;
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
		consentPending = false;
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
		return page == Page.OVERVIEW ? AgentControlLayout.calculateBoard(width, height, builtBannerInset)
				: AgentControlLayout.calculate(width, height, builtBannerInset);
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
		/** The one-screen mission board: agent list, live view, Runs on rail and task row. */
		OVERVIEW,
		/** Every agent as a grid with search and filters; the board's "All" link opens it. */
		ROSTER,
		CREATE,
		KEYS,
		TASK,
		MANAGE,
		REMOVE_CONFIRM
	}
}
