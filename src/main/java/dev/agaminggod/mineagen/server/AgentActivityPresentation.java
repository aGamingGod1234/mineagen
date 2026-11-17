package dev.agaminggod.mineagen.server;

import dev.agaminggod.mineagen.protocol.ActionType;
import dev.agaminggod.mineagen.server.runtime.ServerActionResult;
import dev.agaminggod.mineagen.server.runtime.ServerActionState;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;

/** Player-facing activity copy. Lifecycle plumbing stays in the control center, not chat. */
public final class AgentActivityPresentation {
	private AgentActivityPresentation() {
	}

	public static String action(ActionType type) {
		return switch (Objects.requireNonNull(type, "type must not be null")) {
			case CONTROL, CONTROL_SEQUENCE -> "Carrying out the next step";
			case MOVE_TO, NAVIGATE_TO, TRAVEL_TO -> "Moving to the next position";
			case DIG_TO -> "Digging toward a goal";
			case MINE_VEIN -> "Felling a tree or mining a vein";
			case BUILD_SHELTER -> "Building a shelter";
			case CAST_OBSIDIAN -> "Casting obsidian";
			case BARTER_UNTIL -> "Bartering with piglins";
			case REST -> "Resting through the night";
			case BUILD -> "Building";
			case LOOK_AT -> "Looking around";
			case ATTACK, FIGHT_TARGET, FIGHT_UNTIL -> "Engaging a target";
			case SELECT_ITEM, SELECT_TOOL -> "Choosing the right item";
			case USE_ITEM -> "Using an item";
			case BREAK_BLOCK -> "Mining a block";
			case PLACE_BLOCK -> "Placing a block";
			case BUILD_SEQUENCE -> "Building a sequence";
			case CHAT -> "Sending a message";
			case WAIT -> "Waiting briefly";
			case SET_DOOR -> "Using a door";
			case PICK_UP_ITEM -> "Picking up an item";
			case DROP_ITEM -> "Dropping an item";
			case FLEE_FROM -> "Moving to safety";
			case FOLLOW_ENTITY -> "Following a target";
			case TRANSFER_CONTAINER -> "Moving items";
			case CRAFT_INVENTORY, CRAFT_TABLE -> "Crafting an item";
			case FURNACE_TRANSACTION -> "Using a furnace";
			case EQUIP_ITEM -> "Equipping an item";
			case BLOCK_WITH_SHIELD -> "Blocking with a shield";
			case USE_RANGED -> "Using a ranged weapon";
			case INTERACT_BLOCK -> "Interacting with a block";
			case INTERACT_ENTITY -> "Interacting with an entity";
			case DISMOUNT -> "Dismounting";
			case START_FALL_FLYING -> "Starting elytra flight";
			case SET_FLIGHT -> "Changing flight controls";
			case WAKE_UP -> "Waking up";
			case WRITE_SIGN -> "Writing a sign";
			case EDIT_BOOK -> "Writing a book";
			case MENU_CLICK -> "Using a menu";
			case MENU_CLOSE -> "Closing a menu";
			case BEACON_EFFECTS -> "Selecting beacon effects";
			case MENU_TRANSFER -> "Moving items in a menu";
			case MENU_BUTTON -> "Selecting a menu option";
			case ANVIL_RENAME -> "Naming an item";
			case RESPAWN -> "Respawning";
			case COMPLETE_GOAL -> "Finishing the task";
		};
	}

	public static String status(ActionType type, com.google.gson.JsonObject arguments) {
		String key = switch (type) {
			case BREAK_BLOCK -> "expectedBlockId";
			case PLACE_BLOCK -> "itemId";
			case CRAFT_INVENTORY, CRAFT_TABLE -> "recipeId";
			default -> null;
		};
		if (key != null && arguments.has(key) && arguments.get(key).isJsonPrimitive()
				&& arguments.getAsJsonPrimitive(key).isString()) {
			String id = arguments.get(key).getAsString();
			if (id.matches("[a-z0-9_.-]+:[a-z0-9_/.-]+") && id.length() <= 64) {
				String verb = type == ActionType.BREAK_BLOCK ? "Mining " : type == ActionType.PLACE_BLOCK ? "Placing " : "Crafting ";
				return verb + readableIdentifier(id);
			}
		}
		return action(type);
	}

	public static String goalNotComplete(java.util.List<dev.agaminggod.mineagen.agent.goal.GoalEvidence.Fact> facts) {
		var unmet = facts.stream().filter(fact -> !fact.satisfied()).toList();
		if (!unmet.isEmpty() && unmet.stream().allMatch(fact -> fact.type().equals("operator_confirmed"))) {
			return "Finished the work. Waiting for your confirmation.";
		}
		var fact = unmet.isEmpty() ? null : unmet.getFirst();
		if (fact != null && fact.type().equals("inventory_contains")) {
			return "Still need " + readableIdentifier(fact.expectedValue()) + ". I'll keep working.";
		}
		return "The goal is not complete yet. I'll keep working.";
	}

	private static String readableIdentifier(String id) {
		int separator = id.indexOf(':');
		return id.substring(separator + 1).replace('_', ' ').replace('/', ' ');
	}

	public static Optional<String> result(ServerActionResult result) {
		Objects.requireNonNull(result, "result must not be null");
		if (result.state() != ServerActionState.FAILED && result.state() != ServerActionState.TIMED_OUT) return Optional.empty();
		String reason = result.reasonCode();
		if (result.state() == ServerActionState.TIMED_OUT && (reason == null || reason.isBlank())) reason = "ACTION_TIMEOUT";
		String action = "finish " + action(result.actionType()).toLowerCase(Locale.ROOT);
		Optional<String> problem = AgentFeedPolicy.problem(action, reason, result.message());
		return problem.isEmpty() && result.state() == ServerActionState.TIMED_OUT
				? AgentFeedPolicy.problem(action, "ACTION_TIMEOUT", "") : problem;
	}


	public static boolean shouldAnnounceAction(ActionType type) {
		Objects.requireNonNull(type, "type must not be null");
		return false;
	}

	public static boolean shouldAnnounceFailure(String reasonCode) {
		return AgentFeedPolicy.shouldAnnounceFailure(reasonCode);
	}

	public static boolean shouldShowInChat(String reasonCode, boolean routine) {
		return !routine || shouldAnnounceFailure(reasonCode);
	}
}
