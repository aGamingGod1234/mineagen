package dev.agaminggod.mineagen.server;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.DoubleArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.exceptions.DynamicCommandExceptionType;
import dev.agaminggod.mineagen.agent.AgentDomainException;
import dev.agaminggod.mineagen.agent.AgentGameMode;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.agent.AgentRecord;
import dev.agaminggod.mineagen.agent.AgentTransition;
import dev.agaminggod.mineagen.control.AgentControlCatalog;
import dev.agaminggod.mineagen.control.AgentControlCommandBuilder;
import dev.agaminggod.mineagen.pov.PovMode;
import dev.agaminggod.mineagen.server.pov.PovCommands;
import dev.agaminggod.mineagen.server.goal.GoalDraftChoice;
import dev.agaminggod.mineagen.server.goal.GoalSubmission;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletionException;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.Vec3;
import dev.agaminggod.mineagen.server.voice.VoiceConsentRegistry;
import dev.agaminggod.mineagen.server.voice.VoiceDirector;
import dev.agaminggod.mineagen.server.voice.VoiceProfile;
import dev.agaminggod.mineagen.server.voice.VoiceCatalog;
import dev.agaminggod.mineagen.server.voice.VoiceSubsystemRuntime;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class AgentCommands {
	private static final Logger LOGGER = LoggerFactory.getLogger(AgentCommands.class);
	// Same default as coordinator/src/default-models.mjs (DEFAULT_CODEX_MODEL); a coordinator test keeps the two equal.
	private static final String DEFAULT_MODEL = "gpt-6.1-sol";
	private static final String DEFAULT_REASONING = "low";
	private static final String DEFAULT_CODEX_SERVICE_TIER = "default";
	private static final String PROVIDER_CODEX = "codex";
	private static final String PROVIDER_CLAUDE = "claude";
	private static final List<String> VOICE_PROFILE_IDS = VoiceCatalog.selectableIds();
	private static final List<String> VOICE_TONES = List.of(
			"neutral", "warm", "excited", "serious", "dramatic", "whisper", "robotic", "angry");
	private static final String ARGUMENT_AGENT = "agent";
	private static final String ARGUMENT_GAME_MODE = "game_mode";
	private static final String ARGUMENT_DRAFT = "draft_id";
	private static final String ARGUMENT_MODEL = "model";
	private static final String ARGUMENT_NAME = "name";
	private static final String ARGUMENT_MESSAGE = "message";
	private static final String ARGUMENT_PROVIDER = "provider";
	private static final String ARGUMENT_PROMPT = "prompt";
	private static final String ARGUMENT_REASONING = "reasoning";
	private static final String ARGUMENT_SERVICE_TIER = "speed_mode";
	private static final DynamicCommandExceptionType COMMAND_FAILURE = new DynamicCommandExceptionType(
			message -> Component.literal(String.valueOf(message))
	);

	private AgentCommands() {
	}

	public static void register() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> register(dispatcher));
	}

	static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
		dispatcher.register(
				Commands.literal(AgentControlCommandBuilder.ROOT)
						.then(Commands.literal("summon")
								.requires(GoalControl::mayControl)
								.executes(context -> summon(context, PROVIDER_CODEX, DEFAULT_MODEL, DEFAULT_REASONING, Optional.empty()))
								.then(providerSummon(PROVIDER_CLAUDE))
								.then(Commands.argument(ARGUMENT_MODEL, AgentModelArgumentType.model())
										.then(Commands.argument(ARGUMENT_REASONING, StringArgumentType.word())
												.executes(context -> summon(
												context,
												PROVIDER_CODEX,
												StringArgumentType.getString(context, ARGUMENT_MODEL),
														StringArgumentType.getString(context, ARGUMENT_REASONING),
														Optional.empty()
												))
												.then(Commands.argument(ARGUMENT_NAME, StringArgumentType.string())
														.executes(context -> summon(
														context,
														PROVIDER_CODEX,
														StringArgumentType.getString(context, ARGUMENT_MODEL),
																StringArgumentType.getString(context, ARGUMENT_REASONING),
																Optional.of(StringArgumentType.getString(context, ARGUMENT_NAME))
														))))))
						.then(configuredSummon())
						.then(Commands.literal("dm")
								.then(agentArgument().then(
										Commands.argument(ARGUMENT_MESSAGE, StringArgumentType.greedyString())
												.executes(AgentCommands::directMessage)
								)))
						.then(Commands.literal("voice-consent")
								.then(Commands.literal("on").executes(context -> voiceConsent(context, true)))
								.then(Commands.literal("off").executes(context -> voiceConsent(context, false)))
								.then(Commands.literal("status").executes(AgentCommands::voiceConsentStatus)))
						.then(goalDraftCommands())
						.then(goalPromptCommand("start", GoalSubmission.Operation.START))
						.then(agentCommand("stop", AgentManager::stop))
						.then(agentCommand("resume", AgentManager::resume))
						.then(Commands.literal("respawn")
								.requires(GoalControl::mayControl)
								.then(agentArgument().executes(AgentCommands::respawn)))
						.then(goalPromptCommand("queue", GoalSubmission.Operation.QUEUE))
						.then(promptCommand("steer", (manager, selector, prompt, ignored) -> manager.steer(selector, prompt)))
						.then(Commands.literal("status")
								.requires(GoalControl::mayControl)
								.executes(AgentCommands::statusAll)
								.then(agentArgument().executes(AgentCommands::statusOne)))
						.then(Commands.literal("audit")
								.requires(GoalControl::mayControl)
								.then(agentArgument().executes(AgentCommands::auditOne)))
						.then(Commands.literal("list").requires(GoalControl::mayControl).executes(AgentCommands::statusAll))
						.then(Commands.literal("remove")
								.requires(GoalControl::mayControl)
								.then(agentArgument().executes(AgentCommands::remove)))
						.then(Commands.literal("auto")
								.requires(GoalControl::mayControl)
								.then(agentArgument().executes(AgentCommands::toggleAutomatic)))
						.then(voiceCommands())
						.then(PovCommands.command("spectate", PovMode.SPECTATE, AgentCommands::povAgentArgument))
						.then(PovCommands.command("takeover", PovMode.TAKEOVER, AgentCommands::povAgentArgument))
						);
	}

	private static com.mojang.brigadier.builder.LiteralArgumentBuilder<CommandSourceStack> voiceCommands() {
		var voice = Commands.literal("voice").requires(GoalControl::mayControl);
		var profile = Commands.literal("profile")
				.then(voiceAgentArgument().then(Commands.argument("profile", StringArgumentType.word())
						.suggests((context, builder) -> SharedSuggestionProvider.suggest(VOICE_PROFILE_IDS, builder))
						.executes(AgentCommands::setVoiceProfile)
						.then(Commands.argument("tone", StringArgumentType.word())
							.suggests((context, builder) -> SharedSuggestionProvider.suggest(VOICE_TONES, builder))
							.executes(AgentCommands::setVoiceProfile)
								.then(Commands.argument("speed", DoubleArgumentType.doubleArg(0.5D, 2.0D))
										.executes(AgentCommands::setVoiceProfile)
										.then(Commands.argument("radius", IntegerArgumentType.integer(1, 128))
												.executes(AgentCommands::setVoiceProfile))))));
		voice.then(profile);
		voice.then(Commands.literal("profiles").executes(AgentCommands::listVoiceProfiles));

		var say = Commands.literal("say")
				.then(voiceAgentArgument().then(Commands.argument("text", StringArgumentType.greedyString())
						.executes(AgentCommands::sayVoice)));
		voice.then(say);
		voice.then(Commands.literal("say_with").then(voiceAgentArgument()
				.then(Commands.argument("profile", StringArgumentType.word())
						.suggests((context, builder) -> SharedSuggestionProvider.suggest(VOICE_PROFILE_IDS, builder))
						.then(Commands.argument("tone", StringArgumentType.word())
								.suggests((context, builder) -> SharedSuggestionProvider.suggest(VOICE_TONES, builder))
								.then(Commands.argument("speed", DoubleArgumentType.doubleArg(0.5D, 2.0D))
										.then(Commands.argument("radius", IntegerArgumentType.integer(1, 128))
												.then(Commands.argument("text", StringArgumentType.greedyString())
														.executes(AgentCommands::sayVoiceWith))))))));

		return voice;
	}

	private static com.mojang.brigadier.builder.LiteralArgumentBuilder<CommandSourceStack> goalDraftCommands() {
		return Commands.literal("goal")
				.then(goalDraftChoice("confirm", GoalDraftChoice.CONFIRM))
				.then(goalDraftChoice("replace", GoalDraftChoice.REPLACE))
				.then(goalDraftChoice("queue", GoalDraftChoice.QUEUE))
				.then(goalDraftChoice("cancel", GoalDraftChoice.CANCEL))
				.then(Commands.literal("complete")
						.requires(GoalControl::mayControl)
						.then(agentArgument().executes(AgentCommands::confirmCompletion)));
	}

	private static int confirmCompletion(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		try {
			AgentRecord record = manager(context).resolve(StringArgumentType.getString(context, ARGUMENT_AGENT));
			AgentServerRuntime.confirmCurrentGoal(context.getSource().getServer(), record.agentId());
			context.getSource().sendSuccess(
					() -> Component.literal("Confirmed completion for " + manager(context).displayName(record) + "."),
					false
			);
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "goal completion confirmation", exception);
		}
	}

	private static com.mojang.brigadier.builder.LiteralArgumentBuilder<CommandSourceStack> goalDraftChoice(
			String literal,
			GoalDraftChoice choice
	) {
		return Commands.literal(literal).then(
				Commands.argument(ARGUMENT_DRAFT, StringArgumentType.word())
						.executes(context -> resolveGoalDraft(context, choice))
		);
	}

	private static int resolveGoalDraft(
			CommandContext<CommandSourceStack> context,
			GoalDraftChoice choice
	) throws CommandSyntaxException {
		try {
			if (choice != GoalDraftChoice.CANCEL) {
				AgentServerRuntime.requireAutomation(context.getSource().getServer());
			}
			UUID draftId = UUID.fromString(StringArgumentType.getString(context, ARGUMENT_DRAFT));
			UUID actorId = context.getSource().getEntity() instanceof ServerPlayer player
					? player.getUUID()
					: new UUID(0L, 0L);
			Optional<AgentManager.GoalDraftResult> resolved = manager(context).resolveGoalDraft(
					draftId, actorId, GoalControl.mayControl(context.getSource()), choice);
			if (resolved.isEmpty()) {
				context.getSource().sendSuccess(() -> Component.literal("Goal draft was already resolved."), false);
				return 0;
			}
			AgentManager.GoalDraftResult result = resolved.orElseThrow();
			result.transition().ifPresent(transition -> reportTransition(
					context,
					switch (result.operation()) {
						case START -> "start";
						case REPLACE -> "replace";
						case QUEUE -> "queue";
						case CANCEL -> "cancel";
					},
					transition
			));
			if (result.operation() == dev.agaminggod.mineagen.server.goal.GoalDraftResolution.Operation.CANCEL) {
				context.getSource().sendSuccess(() -> Component.literal("Cancelled goal draft " + draftId + "."), false);
			}
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (IllegalArgumentException exception) {
			throw COMMAND_FAILURE.create("INVALID_GOAL_DRAFT_ID: Draft ID must be a UUID");
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "goal draft", exception);
		}
	}

	private static int setVoiceProfile(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		try {
			String selector = StringArgumentType.getString(context, ARGUMENT_AGENT);
			String profileId = StringArgumentType.getString(context, "profile");
			if (!VoiceCatalog.accepts(profileId)) {
				throw new AgentDomainException("VOICE_PROFILE_UNKNOWN", "Unknown voice profile. Use /" + AgentControlCommandBuilder.ROOT + " voice profiles");
			}
			String tone = requireVoiceTone(getOptionalString(context, "tone", VoiceProfile.DEFAULT_TONE));
			Double speed = getOptionalDouble(context, "speed");
			int radius = getOptionalInt(context, "radius", VoiceProfile.DEFAULT_RADIUS);
			AgentRecord agent = manager(context).resolve(selector);
			AgentId agentId = agent.agentId();
			VoiceProfile settings = speed == null ? VoiceProfile.inheritingSpeed(profileId, tone, radius)
					: new VoiceProfile(profileId, tone, speed, radius);
			VoiceDirector.setProfile(context.getSource().getServer(), agentId, settings);
			context.getSource().sendSuccess(() -> Component.literal("Voice profile set for " + manager(context).displayName(agent) + "."), false);
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "voice profile", exception);
		}
	}

	private static int sayVoice(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		try {
			AgentId agentId = manager(context).resolve(StringArgumentType.getString(context, ARGUMENT_AGENT)).agentId();
			VoiceDirector.say(context.getSource().getServer(), agentId, StringArgumentType.getString(context, "text"));
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "voice say", exception);
		}
	}

	private static int sayVoiceWith(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		try {
			AgentId agentId = manager(context).resolve(StringArgumentType.getString(context, ARGUMENT_AGENT)).agentId();
			VoiceProfile settings = new VoiceProfile(StringArgumentType.getString(context, "profile"),
					requireVoiceTone(StringArgumentType.getString(context, "tone")), DoubleArgumentType.getDouble(context, "speed"),
					IntegerArgumentType.getInteger(context, "radius"));
			VoiceDirector.say(context.getSource().getServer(), agentId, StringArgumentType.getString(context, "text"), settings);
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "voice say with settings", exception);
		}
	}

	private static String requireVoiceTone(String tone) {
		try {
			return VoiceProfile.requireSupportedTone(tone);
		} catch (IllegalArgumentException exception) {
			throw new AgentDomainException("VOICE_TONE_INVALID", exception.getMessage());
		}
	}

	private static int listVoiceProfiles(CommandContext<CommandSourceStack> context) {
		context.getSource().sendSuccess(() -> Component.literal("Voice catalog: " + String.join("; ", VoiceCatalog.choices().stream().map(choice -> choice.label() + " (" + choice.id() + ")").toList())), false);
		return 1;
	}

	private static String getOptionalString(CommandContext<CommandSourceStack> context, String name, String fallback) {
		try { return StringArgumentType.getString(context, name); }
		catch (IllegalArgumentException ignored) { return fallback; }
	}

	private static Double getOptionalDouble(CommandContext<CommandSourceStack> context, String name) {
		try { return DoubleArgumentType.getDouble(context, name); }
		catch (IllegalArgumentException ignored) { return null; }
	}

	private static int getOptionalInt(CommandContext<CommandSourceStack> context, String name, int fallback) {
		try { return IntegerArgumentType.getInteger(context, name); }
		catch (IllegalArgumentException ignored) { return fallback; }
	}

	private static com.mojang.brigadier.builder.LiteralArgumentBuilder<CommandSourceStack> configuredSummon() {
		return Commands.literal("summon-configured").requires(GoalControl::mayControl).then(
				Commands.argument(ARGUMENT_PROVIDER, StringArgumentType.word())
						.suggests((context, builder) -> SharedSuggestionProvider.suggest(
								AgentServerRuntime.modelCatalog(context.getSource().getServer()).stream()
										.map(dev.agaminggod.mineagen.control.AgentControlModelOption::provider).distinct().toList(), builder))
						.then(Commands.argument(ARGUMENT_MODEL, AgentModelArgumentType.model()).then(
								Commands.argument(ARGUMENT_REASONING, StringArgumentType.word()).then(
										Commands.argument(ARGUMENT_SERVICE_TIER, StringArgumentType.word())
												.suggests((context, builder) -> SharedSuggestionProvider.suggest(
														List.of("default", "priority", "fast"), builder))
												.then(Commands.argument(ARGUMENT_GAME_MODE, StringArgumentType.word())
												.suggests((context, builder) -> SharedSuggestionProvider.suggest(
														List.of("survival", "creative", "adventure"), builder))
												.then(Commands.argument(ARGUMENT_NAME, StringArgumentType.string())
														.executes(context -> summon(
																context,
																StringArgumentType.getString(context, ARGUMENT_PROVIDER),
														StringArgumentType.getString(context, ARGUMENT_MODEL),
														StringArgumentType.getString(context, ARGUMENT_REASONING),
														StringArgumentType.getString(context, ARGUMENT_SERVICE_TIER),
														Optional.of(StringArgumentType.getString(context, ARGUMENT_NAME)).filter(value -> !value.isBlank()),
														AgentGameMode.parse(StringArgumentType.getString(context, ARGUMENT_GAME_MODE))
												)))))
		)));
	}
	private static com.mojang.brigadier.builder.LiteralArgumentBuilder<CommandSourceStack> providerSummon(String provider) {
		return Commands.literal(provider).then(
				Commands.argument(ARGUMENT_MODEL, AgentModelArgumentType.model()).then(
						Commands.argument(ARGUMENT_REASONING, StringArgumentType.word())
								.executes(context -> summon(
										context,
										provider,
										StringArgumentType.getString(context, ARGUMENT_MODEL),
										StringArgumentType.getString(context, ARGUMENT_REASONING),
										Optional.empty()
								))
								.then(Commands.argument(ARGUMENT_NAME, StringArgumentType.string())
										.executes(context -> summon(
												context,
												provider,
												StringArgumentType.getString(context, ARGUMENT_MODEL),
												StringArgumentType.getString(context, ARGUMENT_REASONING),
												Optional.of(StringArgumentType.getString(context, ARGUMENT_NAME))
										)))
				)
		);
	}

	private static com.mojang.brigadier.builder.LiteralArgumentBuilder<CommandSourceStack> promptCommand(
			String literal,
			PromptOperation operation
	) {
		return Commands.literal(literal).requires(GoalControl::mayControl).then(
				agentArgument().then(
						Commands.argument(ARGUMENT_PROMPT, StringArgumentType.greedyString())
								.executes(context -> runPromptOperation(context, literal, operation))
				)
		);
	}

	private static com.mojang.brigadier.builder.LiteralArgumentBuilder<CommandSourceStack> goalPromptCommand(
			String literal,
			GoalSubmission.Operation operation
	) {
		return Commands.literal(literal).requires(GoalControl::mayControl).then(
				agentArgument().then(
						Commands.argument(ARGUMENT_PROMPT, StringArgumentType.greedyString())
								.executes(context -> runGoalPromptOperation(context, literal, operation))
				)
		);
	}

	private static com.mojang.brigadier.builder.LiteralArgumentBuilder<CommandSourceStack> agentCommand(
			String literal,
			AgentOperation operation
	) {
		return Commands.literal(literal).requires(GoalControl::mayControl).then(
				agentArgument().executes(context -> runAgentOperation(context, literal, operation))
		);
	}

	private static com.mojang.brigadier.builder.RequiredArgumentBuilder<CommandSourceStack, String> voiceAgentArgument() {
		return Commands.argument(ARGUMENT_AGENT, StringArgumentType.string()).suggests((context, builder) ->
				SharedSuggestionProvider.suggest(manager(context).preferredSelectors().stream()
						.map(StringArgumentType::escapeIfRequired).toList(), builder));
	}

	private static com.mojang.brigadier.builder.RequiredArgumentBuilder<CommandSourceStack, String> agentArgument() {
		return Commands.argument(ARGUMENT_AGENT, StringArgumentType.word())
				.suggests((context, builder) -> SharedSuggestionProvider.suggest(
						manager(context).selectors(),
						builder
				));
	}

	// /mineagen spectate and /mineagen takeover suggest one readable name per agent; ids and legacy aliases still resolve.
	private static com.mojang.brigadier.builder.RequiredArgumentBuilder<CommandSourceStack, String> povAgentArgument() {
		return Commands.argument(ARGUMENT_AGENT, StringArgumentType.word())
				.suggests((context, builder) -> SharedSuggestionProvider.suggest(
						manager(context).preferredSelectors(),
						builder
				));
	}

	private static int summon(
			CommandContext<CommandSourceStack> context,
			String provider,
			String model,
			String reasoning,
			Optional<String> userName
	)
			throws CommandSyntaxException {
		return summon(context, provider, model, reasoning, userName, AgentGameMode.SURVIVAL);
	}

	private static int summon(
			CommandContext<CommandSourceStack> context,
			String provider,
			String model,
			String reasoning,
			Optional<String> userName,
			AgentGameMode gameMode
	)
			throws CommandSyntaxException {
		return summon(context, provider, model, reasoning,
				PROVIDER_CODEX.equals(provider) ? DEFAULT_CODEX_SERVICE_TIER : "priority", userName, gameMode);
	}

	private static int summon(
			CommandContext<CommandSourceStack> context,
			String provider,
			String model,
			String reasoning,
			String serviceTier,
			Optional<String> userName,
			AgentGameMode gameMode
	)
			throws CommandSyntaxException {
		try {
			CommandSourceStack source = context.getSource();
			if (source.getEntity() == null) {
				return summonAt(context, source.getPosition(), provider, model, reasoning, serviceTier, userName, gameMode);
			}
			// Vanilla may load chunks asynchronously. Never wait for that work on the server thread.
			var placement = AgentSpawnPlacement.availableNear(source.getLevel(), source.getPosition(), source.getEntity().getLookAngle());
			if (!placement.isDone()) {
				source.sendSuccess(() -> Component.literal("Finding a player spawn position nearby."), false);
			}
			placement.whenCompleteAsync((position, failure) -> {
				if (failure != null) {
					reportSummonFailure(source, failure);
					return;
				}
				try {
					summonAt(context, position, provider, model, reasoning, serviceTier, userName, gameMode);
				} catch (RuntimeException exception) {
					reportSummonFailure(source, exception);
				}
			}, source.getServer());
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "summon", exception);
		}
	}

	private static int summonAt(
			CommandContext<CommandSourceStack> context, Vec3 position,
			String provider, String model, String reasoning, String serviceTier,
			Optional<String> userName, AgentGameMode gameMode
	) {
		AgentManager manager = manager(context);
		AgentRecord record = manager.summon(context.getSource().getLevel(), position,
				provider, model, reasoning, serviceTier, userName, gameMode);
		succeed(context, "Creating " + manager.displayName(record) + ". It will be ready when its player joins.");
		return 1;
	}

	private static void reportSummonFailure(CommandSourceStack source, Throwable failure) {
		while (failure instanceof CompletionException && failure.getCause() != null) {
			failure = failure.getCause();
		}
		if (failure instanceof AgentDomainException exception) {
			source.sendFailure(Component.literal(exception.code() + ": " + exception.getMessage()));
			AgentControlSync.recordResult(source, false, exception.getMessage());
		} else {
			LOGGER.error("Unexpected /{} summon failure", AgentControlCommandBuilder.ROOT, failure);
			source.sendFailure(Component.literal("INTERNAL_ERROR: summon failed; see the server log"));
			AgentControlSync.recordResult(source, false,
					"Something went wrong on the server while creating the agent. Nothing was created; the server log has details.");
		}
	}

	private static int runPromptOperation(
			CommandContext<CommandSourceStack> context,
			String operationName,
			PromptOperation operation
	) throws CommandSyntaxException {
		try {
			AgentServerRuntime.requireAutomation(context.getSource().getServer());
			String selector = StringArgumentType.getString(context, ARGUMENT_AGENT);
			String prompt = StringArgumentType.getString(context, ARGUMENT_PROMPT);
			AgentTransition transition = operation.apply(manager(context), selector, prompt, context.getSource().getLevel());
			reportTransition(context, operationName, transition);
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, operationName, exception);
		}
	}

	private static int runGoalPromptOperation(
			CommandContext<CommandSourceStack> context,
			String operationName,
			GoalSubmission.Operation operation
	) throws CommandSyntaxException {
		try {
			AgentServerRuntime.requireAutomation(context.getSource().getServer());
			String selector = StringArgumentType.getString(context, ARGUMENT_AGENT);
			String prompt = StringArgumentType.getString(context, ARGUMENT_PROMPT);
			Optional<UUID> requester = context.getSource().getEntity() instanceof ServerPlayer player
					? Optional.of(player.getUUID()) : Optional.empty();
			GoalSubmission submission = AgentServerRuntime.submitGoal(
					context.getSource().getServer(), selector, prompt, context.getSource().getLevel(), requester, operation);
			if (submission.transition().isPresent()) {
				reportTransition(context, operationName, submission.transition().orElseThrow());
			} else {
				var draft = submission.pendingDraft().orElseThrow();
				String name = manager(context).displayName(manager(context).registry().require(draft.agentId()));
				// Not a confirmed result: the server may still refuse the draft, so nothing is recorded for the Control
				// Center rather than a green success. The draft's later outcome still reaches chat only.
				String interpreting = "The coordinator is interpreting the goal for " + name
						+ ". It will " + operationName + " automatically after server validation.";
				context.getSource().sendSuccess(() -> Component.literal(interpreting), false);
			}
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, operationName, exception);
		}
	}

	private static int directMessage(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		try {
			if (!(context.getSource().getEntity() instanceof ServerPlayer player)) {
				throw new AgentDomainException("PLAYER_REQUIRED", "Only an in-game player can send an agent DM");
			}
			AgentManager manager = manager(context);
			AgentRecord target = manager.resolve(StringArgumentType.getString(context, ARGUMENT_AGENT));
			AgentServerRuntime.sendDirectMessage(
					context.getSource().getServer(),
					player,
					target.agentId(),
					StringArgumentType.getString(context, ARGUMENT_MESSAGE)
			);
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "dm", exception);
		}
	}

	private static int voiceConsent(CommandContext<CommandSourceStack> context, boolean enabled) throws CommandSyntaxException {
		ServerPlayer player = requirePlayer(context);
		requireVoiceAvailable(context.getSource());
		if (enabled) VoiceConsentRegistry.grant(context.getSource().getServer(), player.getUUID());
		else VoiceConsentRegistry.revoke(context.getSource().getServer(), player.getUUID());
		context.getSource().sendSuccess(
				() -> Component.literal(voiceConsentConfirmation(enabled)),
				false
		);
		return enabled ? 1 : 0;
	}

	static String voiceConsentConfirmation(boolean enabled) {
		return "Agent voice transcription " + (enabled ? "enabled for this session." : "disabled.");
	}

	private static int voiceConsentStatus(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		ServerPlayer player = requirePlayer(context);
		requireVoiceAvailable(context.getSource());
		boolean enabled = VoiceConsentRegistry.granted(context.getSource().getServer(), player.getUUID());
		context.getSource().sendSuccess(
				() -> Component.literal("Agent voice transcription is " + (enabled ? "enabled." : "disabled.")),
				false
		);
		return enabled ? 1 : 0;
	}

	private static void requireVoiceAvailable(CommandSourceStack source) throws CommandSyntaxException {
		if (!VoiceSubsystemRuntime.available(source.getServer())) {
			throw COMMAND_FAILURE.create(voiceUnavailableMessage());
		}
	}

	static String voiceUnavailableMessage() {
		return "VOICE_UNAVAILABLE: Install and start the Mineagen Voice add-on with Simple Voice Chat";
	}

	private static ServerPlayer requirePlayer(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		if (context.getSource().getEntity() instanceof ServerPlayer player) return player;
		throw COMMAND_FAILURE.create("PLAYER_REQUIRED: Only an in-game player can change voice consent");
	}

	private static int runAgentOperation(
			CommandContext<CommandSourceStack> context,
			String operationName,
			AgentOperation operation
	) throws CommandSyntaxException {
		try {
			if (operationName.equals("resume")) {
				AgentServerRuntime.requireAutomation(context.getSource().getServer());
			}
			String selector = StringArgumentType.getString(context, ARGUMENT_AGENT);
			AgentTransition transition = operation.apply(manager(context), selector);
			reportTransition(context, operationName, transition);
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, operationName, exception);
		}
	}

	private static int statusOne(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		try {
			AgentRecord record = manager(context).resolve(StringArgumentType.getString(context, ARGUMENT_AGENT));
			context.getSource().sendSuccess(() -> Component.literal(formatStatus(record)), false);
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "status", exception);
		}
	}

	/** Read-only: interventions observed during the agent's current or last goal, for evaluators. */
	private static int auditOne(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		try {
			String selector = StringArgumentType.getString(context, ARGUMENT_AGENT);
			AgentRecord record = manager(context).resolve(selector);
			String line = dev.agaminggod.mineagen.server.audit.InterventionAuditHook.report(context.getSource().getServer(), record, selector);
			context.getSource().sendSuccess(() -> Component.literal(line), false);
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "audit", exception);
		}
	}

	private static int statusAll(CommandContext<CommandSourceStack> context) {
		List<AgentRecord> records = manager(context).records();
		if (records.isEmpty()) {
			context.getSource().sendSuccess(() -> Component.literal("You have not created any agents yet."), false);
			return 0;
		}
		for (AgentRecord record : records) {
			context.getSource().sendSuccess(() -> Component.literal(formatStatus(record)), false);
		}
		return records.size();
	}

	private static int remove(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		try {
			AgentManager manager = manager(context);
			AgentRecord removed = manager.remove(StringArgumentType.getString(context, ARGUMENT_AGENT));
			succeed(context, "Removed " + manager.displayName(removed) + ".");
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "remove", exception);
		}
	}

	private static int respawn(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		try {
			AgentManager manager = manager(context);
			AgentRecord record = manager.requestRespawn(StringArgumentType.getString(context, ARGUMENT_AGENT));
			succeed(context, "Respawning " + manager.displayName(record) + "...");
			return 1;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "respawn", exception);
		}
	}

	private static int toggleAutomatic(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		try {
			String selector = StringArgumentType.getString(context, ARGUMENT_AGENT);
			boolean enabled = manager(context).toggleAutomaticProgress(selector);
			succeed(context, "Automatic agent progress " + (enabled ? "enabled" : "disabled"));
			return enabled ? 1 : 0;
		} catch (AgentDomainException exception) {
			throw commandFailure(context, exception);
		} catch (RuntimeException exception) {
			throw unexpectedFailure(context, "auto", exception);
		}
	}

	private static void reportTransition(
			CommandContext<CommandSourceStack> context,
			String operation,
			AgentTransition transition
	) {
		String name = manager(context).displayName(transition.after());
		String message = switch (operation) {
			case "start" -> "Starting a task for " + name + "...";
			case "queue" -> "Added a task to " + name + "'s queue.";
			case "replace" -> "Replacing " + name + "'s current task...";
			case "steer" -> "Updating " + name + "'s current task...";
			case "stop" -> transition.before() == transition.after()
					? "Stopped " + name + "'s current action (no task to pause)."
					: "Paused " + name + ".";
			case "resume" -> "Resuming " + name + "...";
			default -> "Updated " + name + ".";
		};
		succeed(context, message);
	}

	private static String formatStatus(AgentRecord record) {
		String currentGoal = record.currentGoal().map(goal -> goal.prompt()).orElse("none");
		return dev.agaminggod.mineagen.agent.AgentIdentity.displayNameTag(record.profile())
				+ " | " + dev.agaminggod.mineagen.control.AgentControlPresentation.stateLabel(record.state().name())
				+ ". Current task: " + currentGoal
				+ ". Queued tasks: " + record.queuedGoals().size() + ".";
	}

	private static AgentManager manager(CommandContext<CommandSourceStack> context) {
		return AgentManager.get(context.getSource().getServer());
	}

	/** Chat keeps the coded refusal; the Control Center gets the plain reason through the player's snapshot. */
	private static CommandSyntaxException commandFailure(CommandContext<CommandSourceStack> context, AgentDomainException exception) {
		AgentControlSync.recordResult(context.getSource(), false, exception.getMessage());
		return COMMAND_FAILURE.create(exception.code() + ": " + exception.getMessage());
	}

	private static CommandSyntaxException unexpectedFailure(
			CommandContext<CommandSourceStack> context, String operation, RuntimeException exception) {
		LOGGER.error("Unexpected /{} {} failure", AgentControlCommandBuilder.ROOT, operation, exception);
		AgentControlSync.recordResult(context.getSource(), false,
				"Something went wrong on the server while trying to " + operation + ". Nothing was changed; the server log has details.");
		return COMMAND_FAILURE.create("INTERNAL_ERROR: " + operation + " failed; see the server log");
	}

	/** Sends {@code message} to chat as today and records it as the accepted result the Control Center shows. */
	private static void succeed(CommandContext<CommandSourceStack> context, String message) {
		context.getSource().sendSuccess(() -> Component.literal(message), false);
		AgentControlSync.recordResult(context.getSource(), true, message);
	}

	@FunctionalInterface
	private interface PromptOperation {
		AgentTransition apply(AgentManager manager, String selector, String prompt, ServerLevel sourceLevel);
	}

	@FunctionalInterface
	private interface AgentOperation {
		AgentTransition apply(AgentManager manager, String selector);
	}
}
