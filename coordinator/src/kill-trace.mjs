/**
 * The entity_killed trace row (issue #2, 1b). A kill carries at only when the body saw it and the server sent the
 * position (killFacts, and the position not switched off); positioned says whether it came, which is not the same as
 * whether the body saw the kill (the Watcher's kill row has that). The block is position: the trace keeps at as its timestamp.
 */
export function killTraceFields(record, payload) {
	return { agentId: record.agentId, goalRevision: record.goalRevision, entityType: payload.entityType, positioned: payload.at !== undefined,
		...(payload.at === undefined ? {} : { position: { x: payload.at.x, y: payload.at.y, z: payload.at.z } }) };
}
