package dev.agaminggod.mineagen.server.goal;

@FunctionalInterface
public interface GoalSpecRequestSink {
	void publish(PendingGoalDraft draft);
}
