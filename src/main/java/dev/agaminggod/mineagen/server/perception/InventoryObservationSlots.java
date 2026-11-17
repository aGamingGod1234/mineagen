package dev.agaminggod.mineagen.server.perception;

final class InventoryObservationSlots {
	private InventoryObservationSlots() {
	}

	static boolean shouldEmitNumeric(int slot, int selectedMainHandSlot, boolean mappedEquipmentSlot) {
		return slot != selectedMainHandSlot && !mappedEquipmentSlot;
	}
}
