package dev.agaminggod.arenaagents.server.runtime.input;

import dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard;
import net.minecraft.world.InteractionHand;
import dev.agaminggod.arenaagents.agent.AgentId;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** The production bridge must distinguish no lease from authored idle and deliberate actions. */
public final class BrinkGuardIngressVerification {
	private BrinkGuardIngressVerification() { }

	public static void main(String[] args) { System.out.println("PASS: " + verify() + " handoff ingress assertions"); }

	public static int verify() {
		check(ModelPlayerInputBridge.inputPresence(null) == BrinkGuard.InputPresence.NONE, "only no winner is idle handoff");
		check(ModelPlayerInputBridge.inputPresence(AgentInputState.idle(0, 0, 0)) == BrinkGuard.InputPresence.CONTROL,
				"authored idle/no-sneak remains explicit input");
		check(ModelPlayerInputBridge.inputPresence(state(false, false, false, true)) == BrinkGuard.InputPresence.CONTROL,
				"authored crouch can seed the next handoff");
		for (AgentInputState state : new AgentInputState[]{state(true, false, false, false),
				state(false, true, false, false), state(false, false, true, false), state(false, true, true, true)}) {
			check(ModelPlayerInputBridge.inputPresence(state) == BrinkGuard.InputPresence.ACTION,
					"jumps, attack clicks and use clicks/holds interrupt and cannot seed a handoff");
		}
		return 7 + verifyLifecycleRevocation();
	}

	private static int verifyLifecycleRevocation() {
		AgentId agent = new AgentId(UUID.fromString("00000000-0000-0000-0000-000000004071"));
		List<String> events = new ArrayList<>();
		boolean[] failRevoke = {false};
		InputStateSink sink = new InputStateSink() {
			@Override public void apply(AgentId id, AgentInputState previous, AgentInputState state) { events.add("apply"); }
			@Override public void clear(AgentId id, AgentInputState previous) { events.add("clear"); }
			@Override public void revoke(AgentId id) {
				events.add("revoke");
				if (failRevoke[0]) throw new IllegalStateException("injected revoke failure");
			}
		};
		LeasedServerInputController controller = new LeasedServerInputController(sink);
		InputLease lease = controller.acquire(agent, InputOwner.NAVIGATION, 100);
		controller.apply(lease, state(false, false, false, true));
		events.clear();
		controller.release(lease);
		check(events.equals(List.of("clear")), "last-lease release preserves handoff eligibility");
		events.clear();
		controller.clear(agent);
		check(events.equals(List.of("revoke")), "review R1: lifecycle clear revokes even after all leases released");
		lease = controller.acquire(agent, InputOwner.NAVIGATION, 100);
		controller.apply(lease, state(false, false, false, true));
		events.clear();
		controller.clear(agent);
		check(events.equals(List.of("revoke", "clear")), "full clear revokes before physical input clear");
		lease = controller.acquire(agent, InputOwner.NAVIGATION, 100);
		controller.apply(lease, state(false, false, false, true));
		events.clear(); failRevoke[0] = true;
		boolean failed = false;
		try { controller.clear(agent); } catch (IllegalStateException expected) { failed = true; }
		check(failed, "revocation failure remains visible");
		check(events.equals(List.of("revoke", "clear")), "revocation failure still neutralizes physical input");
		check(controller.currentState(agent).isEmpty(), "revocation failure still removes every lease");
		return 6;
	}

	private static AgentInputState state(boolean jump, boolean attack, boolean use, boolean sneak) {
		return new AgentInputState(0, 0, jump, sneak, false, attack, use, 0, 0, 0, InteractionHand.MAIN_HAND);
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
	}
}
