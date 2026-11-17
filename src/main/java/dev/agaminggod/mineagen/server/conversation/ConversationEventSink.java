package dev.agaminggod.mineagen.server.conversation;

import dev.agaminggod.mineagen.agent.goal.GoalSpec;
import java.util.Optional;

@FunctionalInterface
public interface ConversationEventSink {
	void publish(ConversationEvent event, Optional<GoalSpec> wakeGoal);
}
