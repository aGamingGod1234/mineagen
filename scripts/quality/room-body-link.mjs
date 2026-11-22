// How a provider-free room keeps its stand-in coordinator in step with the server, as the production coordinator does
// (coordinator/src/dynamic-main.mjs). Used by test-obtain-live.mjs and test-find-spot-live.mjs.
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { newerGoalRevision } from './watch-replay.mjs';

/**
 * The runtime's requestObservation: an observation inspection the server answers with a sample taken for it. The old
 * stand-in sent request_observation and polled for a newer published sample; when that request was refused (a stale
 * revision) nothing came, and after 10 s it handed back the old sample, which the runtime refuses as
 * FRESH_OBSERVATION_REQUIRED. An inspection is answered either way, so a refusal shows as its own error.
 */
export function inspectionObserve(inspections, record) {
	return async () => {
		const result = await inspections.request(record, { section: 'observation' });
		return { ...result, observation: adaptObservation(result.observation) };
	};
}

/**
 * Follows every newer goal revision the server sends for this body (a death, a respawn, a new start, a low-health
 * hand-back with no goal_control) and answers agent_ready, as the coordinator does. A room that followed only
 * dead/respawn goal_control kept the old revision and every later call was refused STALE_REVISION.
 */
export function followGoalRevision(bridge, record) {
	bridge.on('message', (event) => {
		const revision = newerGoalRevision(record, event);
		if (revision === null) return;
		record.goalRevision = revision;
		bridge.send('agent_ready', record.agentId, { goalRevision: revision, reconciled: false }).catch(() => {});
	});
}

/**
 * Respawns a dead body and lets its task go on. A body that died with its task running comes back STARTING at the same
 * revision (AgentRecord.withLifecycle), and `start` is refused in that state, so the room no longer waits for a start
 * that never comes (60 s next to the pack that killed it). `start` is still sent: a body whose task had stopped gets a new
 * one, and followGoalRevision moves the record to it.
 */
export async function respawnBody({ command, health, sleep, send }, record, name, { prompt = 'Survive for 36000 seconds.', aliveWaitMs = 30_000 } = {}) {
	await command(`mineagen respawn ${name}`).catch(() => {});
	for (let waited = 0; waited < aliveWaitMs && !(await health().catch(() => 0) > 0); waited += 500) await sleep(500);
	await command(`mineagen start ${name} ${prompt}`).catch(() => {});
	await send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
	return await health().catch(() => 0) > 0;
}
