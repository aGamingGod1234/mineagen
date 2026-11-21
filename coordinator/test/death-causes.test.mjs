import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyDeath, countCauses, mergeDeaths, readDeathEvidence } from '../../scripts/quality/lib/death-causes.mjs';
import { DeathRecorder } from '../src/death-record.mjs';

// The fourteen deaths the 2026-11-19 status table counted as "other or unknown", by their vanilla messages.
const OTHER_OR_UNKNOWN = [
	['Miner burned to death', 'fire'], ['Miner was slain by Wither Skeleton', 'wither_skeleton'], ['Miner was impaled on a stalagmite', 'fall'],
	['Miner was slain by Piglin', 'piglin'], ['Miner was slain by Enderman', 'enderman'], ['Miner was slain by Hoglin', 'hoglin'],
	['Miner tried to swim in lava to escape Zombified Piglin', 'lava'], ['Miner was shot by Skeleton', 'skeleton_arrow'],
	['Miner was burned to a crisp while fighting Blaze', 'fire'], ['Miner was slain by Zombie', 'zombie'],
];

test('every death message the rounds recorded names a cause', () => {
	for (const [message, cause] of OTHER_OR_UNKNOWN) assert.equal(classifyDeath({ message }).cause, cause, message);
	assert.equal(classifyDeath({ message: 'Miner was slain by Drowned' }).cause, 'drowned_mob');
	assert.equal(classifyDeath({ message: 'Miner drowned' }).cause, 'drowning');
	assert.equal(classifyDeath({ message: 'Miner was speared by Zombie' }).cause, 'zombie');
	assert.equal(classifyDeath({ message: 'Miner hit the ground too hard while trying to escape Skeleton' }).cause, 'fall');
	assert.equal(classifyDeath({ message: 'Miner withered away while fighting Wither Skeleton' }).cause, 'wither_skeleton');
	assert.equal(classifyDeath({ message: 'Miner was fireballed by Blaze' }).cause, 'blaze');
	assert.equal(classifyDeath({ message: 'Miner was killed' }).cause, 'kill_command');
	assert.equal(classifyDeath({ message: 'Miner was slain by Polar Bear' }).cause, 'other_mob');
});

test('the server\'s damage type and attacker outrank the message, and only no evidence is unknown', () => {
	assert.equal(classifyDeath({ damageType: 'minecraft:lava', attacker: 'minecraft:zombie', message: 'x was slain by Zombie' }).cause, 'lava');
	assert.equal(classifyDeath({ damageType: 'minecraft:arrow', attacker: 'minecraft:stray' }).cause, 'skeleton_arrow');
	assert.equal(classifyDeath({ damageType: 'minecraft:explosion', attacker: 'minecraft:creeper' }).cause, 'creeper');
	assert.equal(classifyDeath({ damageType: 'minecraft:in_wall' }).cause, 'suffocation');
	assert.equal(classifyDeath({ damageType: 'minecraft:starve' }).cause, 'starvation');
	assert.equal(classifyDeath({ damageType: 'minecraft:generic_kill' }).cause, 'kill_command');
	assert.equal(classifyDeath({ damageType: 'minecraft:wither', attacker: null, message: 'x withered away while fighting Wither Skeleton' }).cause, 'wither_skeleton',
		'an effect damage type with no attacker leaves the message to name the mob');
	assert.equal(classifyDeath({ damageType: 'minecraft:magic' }).cause, 'other');
	assert.equal(classifyDeath({ message: 'unknown (counter only)' }).cause, 'unknown');
	assert.equal(classifyDeath({}).cause, 'unknown');
	assert.deepEqual(countCauses([{ message: 'a was shot by Skeleton' }, { attacker: 'minecraft:skeleton' }, {}]), { skeleton_arrow: 2, unknown: 1 });
});

test('a death after the goal revision moved still finds its receipt, and a counter-only death takes its cause', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'death-causes-'));
	try {
		const protocol = path.join(dir, 'quality-protocol.jsonl');
		const dead = (at, revision, cause, agentId = 'agent-a') => JSON.stringify({ observedAtMs: at + 5, envelope: { type: 'goal_control', agentId,
			payload: { operation: 'dead', goalRevision: revision, updatedAtEpochMs: at, death: { cause, diedAtEpochMs: at } } } });
		await writeFile(protocol, [
			dead(1_000, 1, 'Miner was shot by Skeleton'), dead(60_000, 2, 'Miner tried to swim in lava'), dead(61_000, 1, 'Other was slain by Zombie', 'agent-b'),
			JSON.stringify({ observedAtMs: 2, envelope: { type: 'observation', agentId: 'agent-a', payload: { goalRevision: 1 } } }),
		].join('\n') + '\n');
		// The Watcher's lethal hit for the second death adds its damage type to the receipt.
		await writeFile(path.join(dir, 'danger.jsonl'), JSON.stringify({ type: 'damage', agentId: 'agent-a', atMs: 60_001, damageType: 'minecraft:lava', attacker: null, lethal: true }) + '\n');
		const evidence = readDeathEvidence([protocol, path.join(dir, 'danger.jsonl'), path.join(dir, 'missing.jsonl')], { agentId: 'agent-a', from: 0, to: 100_000 });
		assert.equal(evidence.length, 2);
		assert.equal(evidence[1].damageType, 'minecraft:lava');
		// The timeline saw the second death only as a death counter step, 4 s late.
		const deaths = mergeDeaths([{ at: 1_000, message: 'Miner was shot by Skeleton' }, { at: 64_000, counterOnly: true }], evidence);
		assert.deepEqual(countCauses(deaths), { skeleton_arrow: 1, lava: 1 });
		assert.equal(deaths.length, 2);
		// A receipt nothing else listed is a death of its own.
		assert.equal(mergeDeaths([], evidence).length, 2);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the death row carries the last 10 s of health, position, action and reflex, and stays bounded', () => {
	const recorder = new DeathRecorder({ now: () => 0 });
	const observation = (at, health, extra = {}) => ({ ready: true, observedAtEpochMs: at, position: { x: at / 1000, y: 64, z: 0 }, world: { dimension: 'minecraft:overworld' },
		player: { health, foodLevel: 6, saturation: 0, armor: 4 }, currentAction: { active: true, actionId: 'a1', actionType: 'travel_to' }, ...extra });
	for (let at = 0; at <= 30_000; at += 100) recorder.observe('agent-a', observation(at, 20 - at / 2000));
	recorder.observe('agent-a', observation(30_200, 2, { reflexes: { revision: 1, rules: [], events: [], firing: { id: 'flee-lava', ms: 100 } } }));
	const row = recorder.record({ agentId: 'agent-a', goalRevision: 2 }, { cause: 'Miner tried to swim in lava', damageType: 'minecraft:lava', attacker: null,
		dimensionId: 'minecraft:the_nether', x: 1, y: 30, z: 2, diedAtEpochMs: 30_300, foodLevel: 5, armor: 0 }, { step: 'nether', doing: 'Doing: Nether: find a fortress' });
	assert.equal(row.cause, 'Miner tried to swim in lava');
	assert.equal(row.damageType, 'minecraft:lava');
	assert.equal(row.foodLevel, 5, 'the server value at death wins over the last observation');
	assert.equal(row.armor, 0);
	assert.equal(row.saturation, 0, 'falls back to the last observation');
	assert.deepEqual(row.action, { type: 'travel_to', id: 'a1' });
	assert.equal(row.reflex, 'flee-lava');
	assert.equal(row.step, 'nether');
	assert.ok(row.trail.length <= 21 && row.trail.length >= 19, `trail of ${row.trail.length} points`);
	assert.ok(row.trail.every((point) => point.s >= -10 && point.s <= 0));
	assert.equal(row.trail.at(-1).health, 2);
	assert.ok(JSON.stringify(row).length < 4096, 'one death row stays small');
	// The trail ends with the death; a dead or unready sample is not a body fact.
	assert.deepEqual(recorder.record({ agentId: 'agent-a', goalRevision: 2 }, { diedAtEpochMs: 31_000 }).trail, []);
	recorder.observe('agent-a', { ready: true, observedAtEpochMs: 32_000, player: { dead: true, health: 0 } });
	assert.equal(recorder.record({ agentId: 'agent-a', goalRevision: 2 }, { diedAtEpochMs: 32_100 }).trailBasis, 'no live observation in the last 10 s');
});
