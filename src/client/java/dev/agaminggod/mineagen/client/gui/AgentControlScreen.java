package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.agent.AgentConstants;
import dev.agaminggod.mineagen.agent.AgentGameMode;
import dev.agaminggod.mineagen.agent.AgentModelNames;
import dev.agaminggod.mineagen.agent.AgentVisualIdentity;
import dev.agaminggod.mineagen.client.control.AgentControlClient;
import dev.agaminggod.mineagen.client.gui.widget.ConsoleButton;
import dev.agaminggod.mineagen.client.gui.widget.ConsoleCycleButton;
import dev.agaminggod.mineagen.client.gui.widget.ConsoleEditBox;
import dev.agaminggod.mineagen.control.AgentControlActions;
import dev.agaminggod.mineagen.control.AgentControlAgent;
import dev.agaminggod.mineagen.control.AgentControlCatalog;
import dev.agaminggod.mineagen.control.AgentControlModelOption;
import dev.agaminggod.mineagen.control.AgentControlCommandBuilder;
import dev.agaminggod.mineagen.control.AgentControlPresentation;
import dev.agaminggod.mineagen.control.AgentControlSelectionState;
import dev.agaminggod.mineagen.control.AgentControlSnapshot;
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
	private int createScroll;
	private static final int PROVIDER_KEY_ROW_HEIGHT = 52;
	private static final String KEY_BILLING_NOTE = "API keys bill per token; signed-in subscriptions are used when no key is set.";
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
	private final SingleSubmissionGate summonSubmission = new SingleSubmissionGate();
	private boolean shownPlanWindowEnabled, shownTerminalEnabled;
	private ConsoleMutationState mutationState = ConsoleMutationState.initial(0L);
	private Page page = Page.OVERVIEW;
	private ConsoleEditBox nameInput;
	private MultiLineEditBox promptInput;
	private boolean widgetRefreshPending;

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
		contentChanged = contentChanged || snapshot == null || !snapshot.agents().equals(checkedSnapshot.agents())
				|| !snapshot.catalog().equals(checkedSnapshot.catalog());
		boolean mutationWasPending = mutationState.mutationPending();
		mutationState = mutationState.accept(checkedSnapshot.generatedAtEpochMs(), acknowledgedMutationId);
		if (!contentChanged) {
			snapshot = checkedSnapshot;
			if (mutationWasPending && !mutationState.mutationPending()) {
				if (!feedbackError) feedback = "";
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
		requestWidgetRefresh();
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
		dev.agaminggod.mineagen.client.control.LiveAgentWindows.select(selectedAgent());
		mutationState = ConsoleMutationState.initial(nextSnapshot.generatedAtEpochMs());
		rosterEntries = candidateEntries;
		rosterVisuals = candidateVisuals;
	}

	@Override
	protected void init() {
		widgetRefreshPending = false;
		nameInput = null;
		promptInput = null;
		rosterGrid = null;
		addNavigation();
		switch (page) {
			case OVERVIEW -> initOverview();
			case CREATE -> initCreate();
			case TASK -> initTask();
			case MANAGE -> initManage();
			case REMOVE_CONFIRM -> initRemoveConfirm();
		}
	}

	@Override
	public void tick() {
		super.tick();
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
		AgentControlLayout layout = layout();
		graphics.fill(0, 0, width, height, BACKDROP);
		graphics.fill(layout.panelLeft() - 1, layout.panelTop() - 1,
				layout.panelRight() + 1, layout.panelBottom() + 1, PANEL_EDGE);
		graphics.fill(layout.panelLeft(), layout.panelTop(), layout.panelRight(), layout.panelBottom(), PANEL);
		renderShell(graphics);
		renderHeader(graphics);
		renderInputSurfaces(graphics);
		switch (page) {
			case OVERVIEW -> renderOverview(graphics);
			case CREATE -> renderCreate(graphics);
			case TASK -> renderTask(graphics);
			case MANAGE -> renderManage(graphics);
			case REMOVE_CONFIRM -> renderRemoveConfirm(graphics);
		}
		if (rosterGrid != null) rosterGrid.extractRenderState(graphics);
		super.extractRenderState(graphics, mouseX, mouseY, partialTick);
		renderStatus(graphics);
	}

	@Override
	public boolean mouseScrolled(double mouseX, double mouseY, double horizontalAmount, double verticalAmount) {
		if (page == Page.CREATE && verticalAmount != 0) {
			createScroll = Math.clamp(createScroll - (int) Math.signum(verticalAmount) * 36, 0, createScrollMaximum());
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
		if (event.key() == InputConstants.KEY_ESCAPE) {
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
		show(Page.OVERVIEW);
	}

	private void addNavigation() {
		AgentControlLayout layout = layout();
		boolean agentWorkflow = page == Page.OVERVIEW || page == Page.CREATE || page == Page.TASK
				|| page == Page.MANAGE || page == Page.REMOVE_CONFIRM;
		if (layout.sideNavigation()) {
			int left = layout.panelLeft() + 10;
			int navigationWidth = layout.contentLeft() - layout.panelLeft() - 24;
			int y = layout.navigationTop();
			addRenderableWidget(consoleButton(Component.translatable("screen.mineagen.navigation.agents"),
					left, y, navigationWidth, ROW_HEIGHT, agentWorkflow,
					() -> show(Page.OVERVIEW)));
			return;
		}
		List<String> labels = List.of("Agents");
		List<Boolean> selected = List.of(agentWorkflow);
		List<Runnable> actions = List.of(() -> show(Page.OVERVIEW));
		int available = layout.contentWidth() - GAP * (labels.size() - 1);
		int buttonWidth = available / labels.size();
		for (int index = 0; index < labels.size(); index++) {
			int x = layout.contentLeft() + index * (buttonWidth + GAP);
			int actualWidth = index == labels.size() - 1 ? layout.contentRight() - x : buttonWidth;
			addRenderableWidget(consoleButton(labels.get(index), x, layout.navigationTop(), actualWidth, ROW_HEIGHT,
					selected.get(index), actions.get(index)));
		}
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
		if (layout.splitWorkspace()) {
			addRosterFilters(layout.canvasLeft(), layout.contentTop(), layout.canvasWidth());
			addRosterGrid(layout.rosterBounds(filtersVisible, false), AgentRosterGrid.Mode.FOCUS_ONLY);
			addOverviewActions(layout.contextLeft(), layout.contentTop(), layout.contextWidth());
			addOverviewFooter();
		} else if (layout.sideNavigation()) {
			addRosterFilters(layout.canvasLeft(), layout.contentTop(), layout.canvasWidth());
			addRosterGrid(layout.rosterBounds(filtersVisible, false), AgentRosterGrid.Mode.FOCUS_ONLY);
			addCompactOverviewActions(layout.contentLeft(), layout.footerY(), layout.contentWidth());
		} else {
			addRosterFilters(layout.canvasLeft(), layout.contentTop(), layout.canvasWidth());
			addRosterGrid(layout.rosterBounds(filtersVisible, true), AgentRosterGrid.Mode.FOCUS_ONLY);
			addCompactOverviewActions(layout.contentLeft(), layout.contentBottom() - ROW_HEIGHT, layout.contentWidth());
			addOverviewFooter();
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
		AgentRosterGridLayout gridLayout = AgentRosterGridLayout.calculate(
				region.left(), region.top(), region.right(), region.bottom(), probe.totalFiltered());
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
		ConsoleButton create = primaryButton("Create an agent", x, y, width, ROW_HEIGHT, () -> show(Page.CREATE));
		create.active = canControl();
		addRenderableWidget(create);
		ConsoleButton task = consoleButton("Give a task", x, y + 32, width, 24, false, () -> show(Page.TASK));
		task.active = canUseAutomation() && selectedAgent() != null;
		addRenderableWidget(task);
		ConsoleButton manage = consoleButton("Manage selected agent", x, y + 64, width, 24, false,
				() -> show(Page.MANAGE));
		manage.active = canControl() && selectedAgent() != null;
		addRenderableWidget(manage);
	}

	private void addCompactOverviewActions(int x, int y, int width) {
		int buttonWidth = (width - GAP * 2) / 3;
		ConsoleButton create = primaryButton("Create", x, y, buttonWidth, ROW_HEIGHT, () -> show(Page.CREATE));
		create.active = canControl();
		addRenderableWidget(create);
		ConsoleButton task = consoleButton("Give task", x + buttonWidth + GAP, y, buttonWidth, ROW_HEIGHT,
				false, () -> show(Page.TASK));
		task.active = canUseAutomation() && selectedAgent() != null;
		addRenderableWidget(task);
		ConsoleButton manage = consoleButton("Manage", x + (buttonWidth + GAP) * 2, y, buttonWidth, ROW_HEIGHT,
				false, () -> show(Page.MANAGE));
		manage.active = canControl() && selectedAgent() != null;
		addRenderableWidget(manage);
	}

	private void initCreate() {
		int bodyWidgetStart = children().size();
		createScroll = Math.clamp(createScroll, 0, createScrollMaximum());
		if (AgentControlCatalog.isEmpty()) {
			addRescanButton();
			addProviderKeyWidgets();
			clipCreateWidgets(bodyWidgetStart);
			addCreateFooter();
			return;
		}
		normalizeCreateSelection();
		AgentControlLayout layout = layout();
		int x = layout.contentLeft();
		int width = layout.contentWidth();
		int half = (width - GAP) / 2;
		int y = layout.contentTop() + (layout.sideNavigation() ? 22 : 0) - createScroll;
		addRenderableWidget(new ConsoleCycleButton<>(font, x, y, half, ROW_HEIGHT, Component.literal("Provider"),
				AgentControlCatalog.providers(), provider, value -> Component.literal(capitalize(value)), value -> {
					provider = value;
					model = AgentControlCatalog.defaultModel(provider);
					reasoning = AgentControlCatalog.defaultReasoning(provider, model);
					serviceTier = AgentControlCatalog.defaultServiceTier(provider, model);
					rememberPreferences();
					rebuildWidgets();
				}));
		addRenderableWidget(new ConsoleCycleButton<>(font, x + half + GAP, y, half, ROW_HEIGHT,
				Component.literal("Model"), AgentControlCatalog.models(provider), model,
				value -> Component.literal(AgentControlCatalog.displayName(provider, value)), value -> {
					model = value;
					reasoning = AgentControlCatalog.defaultReasoning(provider, model);
					serviceTier = AgentControlCatalog.defaultServiceTier(provider, model);
					rememberPreferences();
					rebuildWidgets();
				}));
		y += 31;
		addRenderableWidget(ConsoleCycleButton.ranked(font, x, y, half, ROW_HEIGHT,
				Component.literal("Thinking depth"), AgentControlCatalog.reasoningEfforts(provider, model), reasoning,
				value -> Component.literal(capitalize(value)), value -> reasoning = value));
		if (AgentControlCatalog.hasSpeedMode(provider, model)) {
			addRenderableWidget(ConsoleCycleButton.ranked(font, x + half + GAP, y, half, ROW_HEIGHT,
					Component.literal("Speed mode"), AgentControlCatalog.serviceTiers(provider, model), serviceTier,
					value -> Component.literal(AgentControlPresentation.speedLabel(provider, value)),
					value -> serviceTier = value));
		} else {
			ConsoleButton unavailableSpeed = consoleButton(Component.translatable("screen.mineagen.speed_unavailable"), x + half + GAP, y,
					half, ROW_HEIGHT, false, () -> { });
			unavailableSpeed.active = false;
			addRenderableWidget(unavailableSpeed);
		}
		y += 31;
		addRenderableWidget(new ConsoleCycleButton<>(font, x, y, half, ROW_HEIGHT,
				Component.literal("Game mode"), List.of(AgentGameMode.values()), gameMode,
				value -> Component.literal(value.displayName()), value -> gameMode = value));
		nameInput = consoleEditBox(x + half + GAP, y, half, ROW_HEIGHT,
				"agent-name", Component.translatable("screen.mineagen.name_optional"));
		nameInput.setMaxLength(AgentConstants.MAX_USER_NAME_LENGTH);
		nameInput.setValue(name);
		nameInput.setResponder(value -> name = value);
		addRenderableWidget(nameInput);
		addRescanButton();
		addProviderKeyWidgets();
		clipCreateWidgets(bodyWidgetStart);
		addCreateFooter();
	}

	/** Top of the "Found on this machine" table: below the four selectors, or at the top when nothing was found. */
	private int foundTableTop() {
		AgentControlLayout layout = layout();
		return layout.contentTop() + (layout.sideNavigation() ? 22 : 0) + (AgentControlCatalog.isEmpty() ? 0 : 31 * 3) + 4 - createScroll;
	}

	private void addRescanButton() {
		ConsoleButton rescan = consoleButton("Rescan", contentRight() - 72, foundTableTop(), 72, ROW_HEIGHT, false, () -> {
			AgentControlClient.requestProviderRescan();
			setFeedback("Scanning this machine's model CLIs...", false);
		});
		rescan.active = canControl();
		rescan.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal(
				"Check the server machine again for model CLIs, signed-in accounts and their models. Starts no model calls.")));
		addRenderableWidget(rescan);
	}

	private int providerListTop() {
		return foundTableTop() + ROW_HEIGHT + 5 + (AgentControlCatalog.isEmpty() ? 16 : 0);
	}

	static int providerKeyScrollMaximum(int contentTop, int footerY, int tableTop, int rowCount) {
		return Math.max(0, tableTop + 24 + 5 + rowCount * PROVIDER_KEY_ROW_HEIGHT + 28 - (footerY - 6));
	}

	private int createScrollMaximum() {
		return providerKeyScrollMaximum(layout().contentTop(), layout().footerY(),
				foundTableTop() + createScroll + (AgentControlCatalog.isEmpty() ? 16 : 0),
				AgentControlCatalog.providerRows().size());
	}

	private void clipCreateWidgets(int start) {
		for (var child : children().subList(start, children().size())) if (child instanceof AbstractWidget widget) {
			widget.visible = widget.getY() >= layout().contentTop() && widget.getBottom() <= layout().footerY() - 6;
		}
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
		setFeedback(sent ? "API key change sent. Scanning model CLIs..."
				: local ? "Could not send API key change." : AgentControlClient.LOCAL_KEY_ONLY_REASON, !sent);
		rebuildWidgets();
	}

	private void addProviderKeyWidgets() {
		int y = providerListTop();
		boolean localKeys = AgentControlClient.canSaveProviderApiKey();
		for (var row : AgentControlCatalog.providerRows()) {
			String id = row.id();
			boolean editing = editingKeyProvider.equals(id);
			ConsoleButton action = consoleButton(editing ? "Cancel" : row.apiKeySuffix() == null ? "Use API key" : "Remove key",
					contentRight() - 104, y, 104, ROW_HEIGHT, false, () -> {
						if (editing) { clearKeyDraft(); rebuildWidgets(); }
						else if (row.apiKeySuffix() != null) submitProviderKey(id, "");
						else { clearKeyDraft(); editingKeyProvider = id; rebuildWidgets(); }
					});
			action.active = canControl() && (editing || localKeys);
			action.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal(localKeys
					? providerStatus(row) + ". " + providerDetails(row) + ". Explicit server API key environment variables override stored keys."
					: AgentControlClient.LOCAL_KEY_ONLY_REASON + " On a dedicated server, use the CLI login or environment variables there.")));
			addRenderableWidget(action);
			if (editing) {
				keyInput = new ConsoleEditBox(font, contentLeft(), y + 24, contentWidth() - 64, 24,
						Component.literal("API key"), Component.literal("Paste API key"), "provider-api-key");
				keyInput.maskSecret();
				keyInput.setMaxLength(512);
				keyInput.setValue(keyDraft);
				keyInput.setResponder(value -> keyDraft = value);
				keyInput.setEditable(canControl());
				addRenderableWidget(keyInput);
				ConsoleButton save = consoleButton("Save", contentRight() - 58, y + 24, 58, 24, false,
						() -> submitProviderKey(id, keyDraft));
				save.active = canControl() && localKeys;
				addRenderableWidget(save);
			}
			y += PROVIDER_KEY_ROW_HEIGHT;
		}
	}

	private static String providerDetails(dev.agaminggod.mineagen.control.AgentControlProvider row) {
		List<AgentControlModelOption> offered = AgentControlCatalog.currentOptions().stream()
				.filter(option -> option.provider().equals(row.id())).toList();
		List<String> details = new java.util.ArrayList<>();
		if (row.apiKeySuffix() != null) details.add(row.apiKeyLabel());
		if (row.account() != null) details.add(row.account());
		if (row.plan() != null) details.add(row.plan());
		if (details.isEmpty()) details.add("Subscription / CLI sign-in");
		if (!offered.isEmpty()) {
			details.add(offered.stream().map(AgentControlModelOption::displayName).collect(java.util.stream.Collectors.joining(", ")));
			details.add("Reasoning: " + offered.stream().flatMap(option -> option.reasoningEfforts().stream()).distinct().collect(java.util.stream.Collectors.joining(", ")));
			details.add("Speed: " + offered.stream().flatMap(option -> AgentControlCatalog.serviceTiers(row.id(), option.model()).stream()).distinct()
					.map(tier -> AgentControlPresentation.speedLabel(row.id(), tier)).collect(java.util.stream.Collectors.joining(", ")));
		}
		if (row.limit() != null) details.add(row.limit());
		else if (!row.limitKind().equals("unknown")) details.add(row.limitKind().replace('_', ' '));
		return String.join(" · ", details);
	}

	private static String providerStatus(dev.agaminggod.mineagen.control.AgentControlProvider row) {
		if (Boolean.FALSE.equals(row.installed())) return "CLI missing or broken; a key cannot replace it";
		if (row.installed() == null) return "Waiting for CLI scan";
		return Boolean.FALSE.equals(row.signedIn()) ? "Not signed in" : "Ready";
	}

	/** The key itself never enters rendered text, narration, feedback, or the saved preferences. */
	private void renderFoundTable(GuiGraphicsExtractor graphics) {
		int top = foundTableTop();
		int left = contentLeft();
		int width = contentWidth();
		graphics.enableScissor(left, layout().contentTop(), contentRight(), layout().footerY() - 6);
		graphics.text(font, "Found on this machine", left, top + 6, MUTED, false);
		// With the coordinator down nothing can scan, so its own reason (missing Node, restart loop) is the answer,
		// not "no CLI found", which sent a player with working CLIs looking in the wrong place.
		if (snapshot != null && !snapshot.automationAvailable()) graphics.textWithWordWrap(font,
				Component.literal(snapshot.automationStatus()), left, top + ROW_HEIGHT + 5, width, ERROR);
		else if (AgentControlCatalog.isEmpty()) graphics.text(font, fit("No usable model CLI found on the server machine.", width),
				left, top + ROW_HEIGHT + 5, MUTED, false);
		int y = providerListTop();
		for (var row : AgentControlCatalog.providerRows()) {
			String title = row.label() + (row.version() == null ? "" : " " + row.version());
			graphics.text(font, fit(title, width - 110), left, y + 2, TEXT, false);
			graphics.text(font, fit(providerStatus(row), width - 110), left, y + 13, MUTED, false);
			if (!editingKeyProvider.equals(row.id())) {
				String details = providerDetails(row);
				graphics.text(font, fit(details, width), left, y + 30, MUTED, false);
			}
			y += PROVIDER_KEY_ROW_HEIGHT;
		}
		// Off the host machine a key cannot be saved at all, so the reason replaces the billing note.
		graphics.textWithWordWrap(font, Component.literal(AgentControlClient.canSaveProviderApiKey()
				? KEY_BILLING_NOTE : AgentControlClient.LOCAL_KEY_ONLY_REASON), left, y + 4, width, MUTED);
		graphics.disableScissor();
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
		int promptY = layout.contentTop() + (layout.sideNavigation() ? 28 : 0);
		int promptHeight = Math.max(40, layout.contentBottom() - promptY - ROW_HEIGHT - 7);
		promptInput = multiLineInput(x, promptY, width, promptHeight, "Agent task",
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
							() -> submitPrompt(operation))
					: consoleButton(label,
							x + index * (buttonWidth + GAP), actionY, buttonWidth, ROW_HEIGHT, false,
							() -> submitPrompt(operation));
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
				buttonWidth, ROW_HEIGHT, this::submitConfirmedRemove);
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
		int top = layout.contentTop() + (layout.sideNavigation() ? 28 : 0);
		int buttonWidth = (width - GAP * 2) / 3;
		for (int index = 0; index < 3; index++) {
			String operation = List.of("stop", "resume", "respawn").get(index);
			String label = List.of("Pause work", "Resume work", "Respawn").get(index);
			ConsoleButton action = consoleButton(label,
					x + index * (buttonWidth + GAP), top, buttonWidth, ROW_HEIGHT, false,
					() -> submitAgentOperation(operation));
			action.active = canControl()
					&& (!operation.equals("resume") || canUseAutomation())
					&& AgentControlActions.supports(agent, operation);
			addRenderableWidget(action);
		}
		ConsoleButton automatic = consoleButton(
				agent.automaticProgress() ? "Automatic progress: On" : "Automatic progress: Off",
				x, top + 32, (width - GAP) / 2, ROW_HEIGHT, agent.automaticProgress(),
				() -> submitAgentOperation("auto"));
		automatic.active = canControl();
		addRenderableWidget(automatic);
		ConsoleButton remove = dangerButton("Remove agent...", x + (width - GAP) / 2 + GAP, top + 32,
				(width - GAP) / 2, ROW_HEIGHT, this::confirmRemove);
		remove.active = canControl();
		addRenderableWidget(remove);
		ConsoleButton planWindow = consoleButton("Plan window: " + (dev.agaminggod.mineagen.client.control.LiveAgentWindows.planEnabled() ? "On" : "Off"),
				x, top + 64, (width - GAP) / 2, ROW_HEIGHT,
				dev.agaminggod.mineagen.client.control.LiveAgentWindows.planEnabled(), () -> {
					if (!dev.agaminggod.mineagen.client.control.LiveAgentWindows.togglePlan(agent)) setFeedback("Desktop windows are unavailable in a headless client", true);
					rebuildWidgets();
				});
		planWindow.active = canControl();
		planWindow.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal("Open the selected agent's live dependency map in a separate window. Closing it leaves the task running.")));
		addRenderableWidget(planWindow);
		ConsoleButton codexWindow = consoleButton("Model terminal: " + (dev.agaminggod.mineagen.client.control.LiveAgentWindows.terminalEnabled() ? "On" : "Off"),
				x + (width - GAP) / 2 + GAP, top + 64, (width - GAP) / 2, ROW_HEIGHT,
				dev.agaminggod.mineagen.client.control.LiveAgentWindows.terminalEnabled(), () -> {
					if (!dev.agaminggod.mineagen.client.control.LiveAgentWindows.toggleTerminal(agent)) setFeedback("Desktop windows are unavailable in a headless client", true);
					rebuildWidgets();
				});
		codexWindow.active = canControl();
		codexWindow.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal("View the agent's model output, tools and usage, whichever provider runs it. This starts no additional model calls.")));
		addRenderableWidget(codexWindow);
		addBackFooter();
	}

	private void addOverviewFooter() {
		int y = layout().footerY();
		int x = contentLeft();
		int buttonWidth = (contentWidth() - GAP) / 2;
		addRenderableWidget(consoleButton("Refresh", x, y, buttonWidth, ROW_HEIGHT, false,
				AgentControlClient::requestSnapshot));
		addRenderableWidget(consoleButton("Close", contentRight() - buttonWidth, y, buttonWidth, ROW_HEIGHT, false, this::onClose));
	}

	private void addCreateFooter() {
		int y = layout().footerY();
		boolean scrollable = createScrollMaximum() > 0;
		int backWidth = scrollable ? 88 : 130;
		addRenderableWidget(consoleButton("Back to agents", contentLeft(), y, backWidth, ROW_HEIGHT, false, this::navigateBack));
		if (scrollable) {
			ConsoleButton scroll = consoleButton(createScroll == 0 ? "Keys ↓" : "Setup ↑", contentLeft() + backWidth + 4, y, 64, ROW_HEIGHT, false,
					() -> { createScroll = createScroll == 0 ? createScrollMaximum() : 0; rebuildWidgets(); });
			addRenderableWidget(scroll);
		}
		ConsoleButton create = primaryButton("Create agent", contentRight() - (scrollable ? 108 : 130), y, scrollable ? 108 : 130, ROW_HEIGHT,
				this::submitSummon);
		create.active = canControl() && !summonSubmission.claimed() && !AgentControlCatalog.isEmpty();
		addRenderableWidget(create);
	}

	private void addBackFooter() {
		int y = layout().footerY();
		addRenderableWidget(consoleButton("Back to agents", contentLeft(), y, 130, ROW_HEIGHT, false,
				this::navigateBack));
	}

	private void renderShell(GuiGraphicsExtractor graphics) {
		AgentControlLayout layout = layout();
		int left = layout.panelLeft();
		if (layout.sideNavigation()) {
			int navigationRight = layout.contentLeft() - 14;
			graphics.fill(left, layout.panelTop(), navigationRight, layout.panelBottom(), NAV_SURFACE);
			graphics.fill(navigationRight, layout.panelTop(), navigationRight + 1, layout.panelBottom(), PANEL_EDGE);
			graphics.fill(layout.contentLeft(), layout.panelTop() + 31, layout.panelRight(), layout.panelTop() + 32, PANEL_EDGE);
			graphics.text(font, "Arena", left + 14, layout.panelTop() + 8, ACCENT, false);
			graphics.text(font, "Agents", left + 14, layout.panelTop() + 19, TEXT, false);
			graphics.text(font, "Field Console", left + 14, layout.panelTop() + 35, MUTED, false);
			graphics.text(font, "Operations", left + 14, layout.navigationTop() - 15, MUTED, false);
		} else {
			graphics.fill(left, layout.panelTop(), layout.panelRight(), layout.panelTop() + 37, NAV_SURFACE);
			graphics.fill(left, layout.panelTop() + 37, layout.panelRight(), layout.panelTop() + 38, PANEL_EDGE);
			graphics.text(font, "Mineagen", left + 14, layout.panelTop() + 10, TEXT, false);
			graphics.text(font, "Field Console", left + 14, layout.panelTop() + 22, MUTED, false);
		}
		String connection = snapshot == null ? "Syncing" : snapshot.canControl() ? "Link online" : "View only";
		int connectionColor = snapshot != null && snapshot.canControl() ? SUCCESS : ACCENT;
		if (layout.sideNavigation()) {
			int navigationRight = layout.contentLeft() - 14;
			graphics.fill(left + 10, layout.panelBottom() - 50, navigationRight - 10, layout.panelBottom() - 24, TRACK);
			graphics.fill(left + 16, layout.panelBottom() - 42, left + 21, layout.panelBottom() - 37, connectionColor);
			graphics.text(font, connection, left + 27, layout.panelBottom() - 44, connectionColor, false);
			graphics.text(font, AgentControlClient.openControlKeyLabel() + "  open console",
					left + 16, layout.panelBottom() - 32, MUTED, false);
		} else {
			int textX = layout.panelRight() - font.width(connection) - 14;
			graphics.fill(textX - 10, layout.panelTop() + 10, textX - 5, layout.panelTop() + 15, connectionColor);
			graphics.text(font, connection, textX, layout.panelTop() + 8, connectionColor, false);
		}
	}

	private void renderHeader(GuiGraphicsExtractor graphics) {
		AgentControlLayout layout = layout();
		if (!layout.sideNavigation()) return;
		String heading = switch (page) {
			case OVERVIEW -> "Your agents";
			case CREATE -> "Create an agent";
			case TASK -> selectedAgent() == null ? "Give a task" : "Give " + selectedAgent().displayName() + " a task";
			case MANAGE -> selectedAgent() == null ? "Manage agent" : "Manage " + selectedAgent().displayName();
			case REMOVE_CONFIRM -> "Confirm agent removal";
		};
		graphics.text(font, heading, contentLeft(), layout.panelTop() + 9, TEXT, false);
		if (snapshot != null) {
			String automation = fit(snapshot.automationStatus(), Math.max(80, contentWidth() / 2));
			graphics.text(font, automation, contentRight() - font.width(automation), layout.panelTop() + 9,
					snapshot.automationAvailable() ? SUCCESS : ERROR, false);
		}
	}

	private void renderOverview(GuiGraphicsExtractor graphics) {
		AgentControlLayout layout = layout();
		if (snapshot == null) {
			Optional<String> error = AgentControlClient.snapshotError();
			graphics.text(font, error.isPresent() ? "Agent roster unavailable" : "Loading your agents...",
					contentLeft(), layout.contentTop() + 27, error.isPresent() ? ERROR : MUTED, false);
			error.ifPresent(message -> graphics.text(font, fit(message, contentWidth()), contentLeft(),
					layout.contentTop() + 43, MUTED, false));
			return;
		}
		if (snapshot.agents().isEmpty()) {
			graphics.text(font, "No agents yet", contentLeft(), layout.contentTop() + 27, TEXT, false);
			graphics.text(font, "Create one, choose its model, then give it a clear task.", contentLeft(), layout.contentTop() + 43, MUTED, false);
			return;
		}
		AgentControlAgent selected = selectedAgent();
		if (layout.splitWorkspace() && selected != null) {
			int x = layout.contextLeft();
			int detailTop = layout.contentTop() + 126;
			graphics.text(font, "Selected agent", x, detailTop, MUTED, false);
			graphics.text(font, selected.displayName(), x, detailTop + 17, TEXT, false);
			graphics.text(font, AgentControlPresentation.profileLabel(selected), x, detailTop + 31, MUTED, false);
			graphics.text(font, AgentControlPresentation.stateLabel(selected.state()), x, detailTop + 45,
					stateColor(selected.state()), false);
			String goal = selected.currentGoal().isBlank() ? "No current task" : "Task: " + selected.currentGoal();
			graphics.textWithWordWrap(font, Component.literal(goal), x, detailTop + 64,
					contentRight() - x, MUTED);
			if (!selected.lastError().isBlank()) {
				graphics.textWithWordWrap(font, Component.literal("Needs attention: " + selected.lastError()), x, detailTop + 104,
						contentRight() - x, ERROR);
			}
		}
	}

	private void renderCreate(GuiGraphicsExtractor graphics) {
		AgentControlLayout layout = layout();
		if (layout.sideNavigation() && createScroll == 0) {
			graphics.text(font, "Configure one agent. Use Tab to move and Left or Right to change a value.",
					contentLeft(), layout.contentTop() + 4, MUTED, false);
		}
		renderFoundTable(graphics);
	}

	private void renderTask(GuiGraphicsExtractor graphics) {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) return;
		AgentControlLayout layout = layout();
		if (layout.sideNavigation()) {
			graphics.text(font, "Current status: " + AgentControlPresentation.stateLabel(agent.state()), contentLeft(), layout.contentTop() + 4, MUTED, false);
			graphics.text(font, "Write one clear outcome. Follow-up work can be queued later.", contentLeft(), layout.contentTop() + 16, MUTED, false);
		}
		if (!canUseAutomation()) {
			graphics.text(font, "Tasks are disabled until automation is ready.", contentLeft(), layout.contentBottom() - 38, ERROR, false);
		}
	}

	private void renderManage(GuiGraphicsExtractor graphics) {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) return;
		AgentControlLayout layout = layout();
		if (!layout.sideNavigation()) return;
		graphics.text(font, AgentControlPresentation.profileLabel(agent), contentLeft(), layout.contentTop() + 4, MUTED, false);
		graphics.text(font, "Status: " + AgentControlPresentation.stateLabel(agent.state()), contentLeft(), layout.contentTop() + 16,
				stateColor(agent.state()), false);
		graphics.text(font, "Routine controls are separated here so creating and assigning agents stays simple.",
				contentLeft(), layout.contentTop() + 94, MUTED, false);
	}

	private void renderRemoveConfirm(GuiGraphicsExtractor graphics) {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) return;
		AgentControlLayout layout = layout();
		int left = layout.contentLeft();
		int top = layout.contentTop() + (layout.sideNavigation() ? 22 : 0);
		int right = layout.contentRight();
		int bottom = Math.min(layout.contentBottom(), top + 104);
		graphics.fill(left, top, right, bottom, ConsoleTheme.ERROR);
		graphics.fill(left + 2, top + 2, right - 2, bottom - 2, ConsoleTheme.SURFACE);
		graphics.text(font, "Remove " + fit(agent.displayName(), right - left - 34),
				left + 14, top + 14, ERROR, false);
		graphics.text(font, "This deletes the agent and its saved state.", left + 14, top + 37, TEXT, false);
		graphics.text(font, "This cannot be undone from the Field Console.", left + 14, top + 53, MUTED, false);
		graphics.text(font, "Choose Keep Agent to return without changing anything.", left + 14, top + 75,
				MUTED, false);
	}

	private void renderInputSurfaces(GuiGraphicsExtractor graphics) {
		if (promptInput == null) return;
		int outline = promptInput.isFocused() ? ConsoleTheme.FOCUS
				: promptInput.isHovered() ? ConsoleTheme.ACCENT : ConsoleTheme.BORDER;
		graphics.fill(promptInput.getX() - 1, promptInput.getY() - 1,
				promptInput.getRight() + 1, promptInput.getBottom() + 1, outline);
		graphics.fill(promptInput.getX(), promptInput.getY(), promptInput.getRight(), promptInput.getBottom(),
				ConsoleTheme.TRACK);
	}

	private void renderStatus(GuiGraphicsExtractor graphics) {
		if (!feedback.isBlank()) {
			AgentControlLayout layout = layout();
			int y = layout.sideNavigation() ? layout.footerY() - 14 : layout.contentTop() - 9;
			ConsoleText.centered(graphics, font, fit(feedback, layout.contentWidth()), width / 2, y,
					feedbackError ? ERROR : SUCCESS);
		} else if (mutationState.mutationPending()) {
			AgentControlLayout layout = layout();
			ConsoleText.centered(graphics, font, "Waiting for the server update...", width / 2,
					layout.sideNavigation() ? layout.footerY() - 14 : layout.contentTop() - 9, ACCENT);
		} else if (snapshot != null && !snapshot.canControl()) {
			AgentControlLayout layout = layout();
			ConsoleText.centered(graphics, font, "View only. Operator permission is required to make changes.",
					width / 2, layout.sideNavigation() ? layout.footerY() - 14 : layout.contentTop() - 9, ACCENT);
		}
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
		AgentControlAgent agent = selectedAgent();
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
		AgentControlAgent agent = selectedAgent();
		if (agent == null) return;
		send(AgentControlCommandBuilder.agent(operation, agent.agentId()), "Updating " + agent.displayName() + "...");
	}

	private void confirmRemove() {
		if (selectedAgent() != null) show(Page.REMOVE_CONFIRM);
	}

	private void submitConfirmedRemove() {
		AgentControlAgent agent = selectedAgent();
		if (agent == null) return;
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
		page = destination;
		feedback = "";
		rebuildWidgets();
	}

	private void setFeedback(String message, boolean error) {
		feedback = Objects.requireNonNullElse(message, "");
		feedbackError = error;
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

	private static List<AgentRosterEntry> rosterEntries(AgentControlSnapshot snapshot) {
		List<AgentRosterEntry> entries = new ArrayList<>();
		for (AgentControlAgent agent : snapshot.agents()) {
			entries.add(new AgentRosterEntry(
					agent.agentId(),
					agent.displayName(),
					agent.provider(),
					AgentModelNames.shortLabel(agent.provider(), agent.model()),
					AgentControlPresentation.stateLabel(agent.state()),
					true,
					""
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
		return AgentControlLayout.calculate(width, height);
	}

	private static int stateColor(String state) {
		return switch (state.toUpperCase(Locale.ROOT)) {
			case "ERROR", "DEAD", "DISCONNECTED" -> ERROR;
			case "IDLE", "COMPLETED" -> SUCCESS;
			default -> ACCENT;
		};
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

	private enum Page {
		OVERVIEW,
		CREATE,
		TASK,
		MANAGE,
		REMOVE_CONFIRM
	}
}
