package dev.agaminggod.mineagen.control;

import java.util.List;

public final class AgentControlSelectionState {
	private String selectedAgentId = "";

	public void reconcile(List<AgentControlAgent> agents) {
		selectedAgentId = AgentControlSelection.resolve(selectedAgentId, agents);
	}

	public void select(String agentId, List<AgentControlAgent> agents) {
		selectedAgentId = AgentControlSelection.resolve(agentId, agents);
	}

	public String selectedAgentId() {
		return selectedAgentId;
	}
}
