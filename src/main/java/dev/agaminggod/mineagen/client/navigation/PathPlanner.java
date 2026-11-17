package dev.agaminggod.mineagen.client.navigation;

@FunctionalInterface
public interface PathPlanner {
	PathPlan findPath(WalkabilityView view, GridPosition start, GridPosition destination);
}
