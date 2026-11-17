package dev.agaminggod.mineagen.server.runtime.controller;

public final class ServerFlightControllerAccess {
	private ServerFlightControllerAccess() {
	}

	public static ServerController.TickResult outcome(boolean stillFlying) {
		return ServerFlightController.outcome(stillFlying);
	}
}
