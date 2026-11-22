package dev.agaminggod.mineagen.client.pov;

import java.util.List;

/**
 * Which lines the lasting agent-view label in the top-left corner shows. The action bar was no place for the way out:
 * the server rewrites it with the agent's status every 2.5 s, so a one-shot hint there was gone before it was read.
 * Kept free of Minecraft types so the choice is verified without a client.
 */
public final class PovCornerLabel {
	/** "F9: leave agent view", with the bound key's name as the argument. */
	public static final String LEAVE_KEY = "hud.mineagen.pov.leave";
	/** The exit key is unbound, so the chat command is the way out; its argument is the command's mode word. */
	public static final String LEAVE_COMMAND = "hud.mineagen.pov.leave_command";
	/** Spectate only: free look while the sneak key is held, with that key's name as the argument. */
	public static final String LOOK_AROUND = "hud.mineagen.pov.look_around";

	private PovCornerLabel() {
	}

	/**
	 * Translation keys of the lines to draw, top to bottom; empty without an agent view, and while the F3 debug screen
	 * fills the same corner.
	 */
	public static List<String> lines(boolean active, boolean takeover, boolean exitKeyUnbound, boolean debugScreenShown) {
		if (!active || debugScreenShown) return List.of();
		String leave = exitKeyUnbound ? LEAVE_COMMAND : LEAVE_KEY;
		// Takeover never free-looks: there the mouse drives the body.
		return takeover ? List.of(leave) : List.of(leave, LOOK_AROUND);
	}

	/** The mode word in the exit command, as /mineagen spectate exit or /mineagen takeover exit. */
	public static String commandMode(boolean takeover) {
		return takeover ? "takeover" : "spectate";
	}
}
