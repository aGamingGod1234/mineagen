// Death causes for the scorers (gate-report.mjs, stage-score.mjs): one cause per death, from the best evidence the run kept.
// Evidence, best first: the server's damage type and attacker ids (the mod's goal_control dead receipt, the coordinator's
// agent_death trace row, or the Watcher's lethal danger row), then the vanilla death message. "unknown" means no evidence
// at all, such as a death seen only as a death counter step with no receipt near it.
import { closeSync, openSync, readSync } from 'node:fs';

/** Cause keys in report order, with the words the goal-progress table uses. */
export const DEATH_CAUSES = Object.freeze({
	skeleton_arrow: 'skeleton arrows', zombie: 'zombies', drowned_mob: 'Drowned mobs', lava: 'lava', fire: 'fire', creeper: 'creepers',
	spider: 'spiders', enderman: 'endermen', wither_skeleton: 'wither skeletons', piglin: 'piglins', hoglin: 'hoglins', blaze: 'blazes',
	ghast: 'ghasts', dragon: 'the dragon', drowning: 'drowning', fall: 'falls', suffocation: 'suffocation', starvation: 'starvation',
	void: 'the void', explosion: 'other explosions', kill_command: '/kill or the harness', other_mob: 'other mobs', other: 'other causes',
	unknown: 'unknown',
});

const MOBS = new Map(Object.entries({
	skeleton: 'skeleton_arrow', stray: 'skeleton_arrow', bogged: 'skeleton_arrow', zombie: 'zombie', husk: 'zombie', zombie_villager: 'zombie',
	drowned: 'drowned_mob', creeper: 'creeper', spider: 'spider', cave_spider: 'spider', enderman: 'enderman', wither_skeleton: 'wither_skeleton',
	piglin: 'piglin', piglin_brute: 'piglin', zombified_piglin: 'piglin', hoglin: 'hoglin', zoglin: 'hoglin', blaze: 'blaze', ghast: 'ghast',
	ender_dragon: 'dragon',
}));
// Damage types that name the cause whoever dealt them. The rest (mob_attack, arrow, fireball, explosion...) go by attacker.
const DAMAGE_TYPES = new Map(Object.entries({
	lava: 'lava', in_fire: 'fire', on_fire: 'fire', campfire: 'fire', hot_floor: 'fire', drown: 'drowning', fall: 'fall', stalagmite: 'fall',
	fly_into_wall: 'fall', ender_pearl: 'fall', in_wall: 'suffocation', cramming: 'suffocation', starve: 'starvation', out_of_world: 'void',
	outside_border: 'void', generic_kill: 'kill_command', bad_respawn_point: 'explosion', dragon_breath: 'dragon',
}));
// Vanilla English death messages (the server renders them). Surroundings first: "tried to swim in lava to escape Zombie" is lava.
const MESSAGES = [
	[/ (tried to swim in lava|was slain by lava|discovered the floor was lava|walked into the danger zone)/, 'lava'],
	[/ (burned to death|was burned to a crisp|went up in flames|walked into fire|was burnt to a crisp)/, 'fire'],
	[/ drowned( whilst| while|$)/, 'drowning'],
	[/ (hit the ground too hard|fell from a high place|fell off |fell while|fell too far|was impaled on a stalagmite|was doomed to fall|experienced kinetic energy)/, 'fall'],
	[/ (suffocated in a wall|was squished too much|was squashed by)/, 'suffocation'],
	[/ starved to death/, 'starvation'],
	[/ (fell out of the world|didn't want to live in the same world|left the confines of this world)/, 'void'],
	[/ was killed by \[Intentional Game Design\]/, 'explosion'],
	[/ was roasted in dragon's breath/, 'dragon'],
];
const BY = / by ([A-Z][A-Za-z ]*?)(?: using .*| while .*| to escape .*)?$/;

const mobCause = (id) => {
	if (typeof id !== 'string' || !id) return null;
	return MOBS.get(id.replace(/^minecraft:/, '')) ?? 'other_mob';
};

/**
 * One death's cause: { cause, basis }. A death is any object with some of: damageType (registry id), attacker (entity
 * type id of the killer), directAttacker (entity type id of what hit, e.g. an arrow), cause or message (vanilla text).
 */
export function classifyDeath(death) {
	const damageType = typeof death?.damageType === 'string' ? death.damageType.replace(/^minecraft:/, '') : null;
	if (damageType && DAMAGE_TYPES.has(damageType)) return { cause: DAMAGE_TYPES.get(damageType), basis: 'damage type' };
	const attacker = mobCause(death?.attacker);
	if (attacker) return { cause: attacker, basis: 'attacker' };
	if (damageType && /explosion/.test(damageType)) return { cause: 'explosion', basis: 'damage type' };
	if (damageType && damageType !== 'generic') return { cause: 'other', basis: 'damage type' };
	const message = typeof death?.message === 'string' ? death.message : typeof death?.cause === 'string' ? death.cause : '';
	if (!message || /^unknown/.test(message) || message === 'Agent died') return { cause: 'unknown', basis: 'none' };
	for (const [pattern, cause] of MESSAGES) if (pattern.test(message)) return { cause, basis: 'death message' };
	// Wither from a wither skeleton's hit names the mob only as the one being fought.
	const fighting = / withered away (?:while|whilst) fighting ([A-Z][A-Za-z ]*)$/.exec(message);
	if (fighting) return { cause: mobCause(fighting[1].trim().toLowerCase().replace(/ /g, '_')), basis: 'death message' };
	const by = BY.exec(message);
	if (by) return { cause: mobCause(by[1].trim().toLowerCase().replace(/ /g, '_')), basis: 'death message' };
	if (/ was (killed|blown up)$| blew up$/.test(message)) return { cause: / was killed$/.test(message) ? 'kill_command' : 'explosion', basis: 'death message' };
	return { cause: 'other', basis: 'death message' };
}

/** Counts by cause key, in DEATH_CAUSES order, leaving out causes with no deaths. */
export function countCauses(deaths) {
	const counts = {};
	for (const death of deaths) { const { cause } = death.deathCause ?? classifyDeath(death); counts[cause] = (counts[cause] ?? 0) + 1; }
	return Object.fromEntries(Object.keys(DEATH_CAUSES).filter((key) => counts[key]).map((key) => [key, counts[key]]));
}

/** Adds counts from several runs into one. */
export function sumCauses(list) {
	const total = {};
	for (const counts of list) for (const [key, n] of Object.entries(counts ?? {})) total[key] = (total[key] ?? 0) + n;
	return Object.fromEntries(Object.keys(DEATH_CAUSES).filter((key) => total[key]).map((key) => [key, total[key]]));
}

/** "skeleton arrows 3, lava 1" for a console line. */
export const formatCauses = (counts) => Object.entries(counts ?? {}).map(([key, n]) => `${DEATH_CAUSES[key] ?? key} ${n}`).join(', ') || 'none';

const EVIDENCE = ['message', 'damageType', 'attacker', 'directAttacker'];
/**
 * Merges death evidence by time. Each base death takes the fields it lacks from the nearest unused extra row within
 * toleranceMs; an extra row no base death took is a death of its own (the base list missed it). Sorted by at.
 */
export function mergeDeaths(base, extra, { toleranceMs = 30_000 } = {}) {
	const deaths = base.map((death) => ({ ...death })), used = new Set();
	for (const death of deaths) {
		let best = -1;
		extra.forEach((row, i) => {
			if (used.has(i) || !Number.isFinite(row.at) || !Number.isFinite(death.at) || Math.abs(row.at - death.at) > toleranceMs) return;
			if (best < 0 || Math.abs(row.at - death.at) < Math.abs(extra[best].at - death.at)) best = i;
		});
		if (best < 0) continue;
		used.add(best);
		for (const key of EVIDENCE) if (death[key] == null && extra[best][key] != null) death[key] = extra[best][key];
		if (extra[best].at !== undefined && death.counterOnly) { death.at = extra[best].at; delete death.counterOnly; }
	}
	extra.forEach((row, i) => { if (!used.has(i)) deaths.push({ ...row }); });
	return deaths.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/** A row's death evidence: the goal_control dead receipt, the agent_death trace row, or a lethal Watcher danger row. */
export function deathEvidence(row) {
	const envelope = row?.envelope ?? null, payload = envelope?.payload ?? null;
	if (envelope?.type === 'goal_control' && payload?.operation === 'dead' && payload.death) {
		const d = payload.death;
		return { agentId: envelope.agentId ?? null, at: d.diedAtEpochMs ?? payload.updatedAtEpochMs ?? row.observedAtMs ?? null, message: d.cause ?? null,
			damageType: d.damageType ?? null, attacker: d.attacker ?? null, directAttacker: d.directAttacker ?? null, source: 'goal_control' };
	}
	if (row?.event === 'agent_death') return { agentId: row.agentId ?? null, at: row.diedAtEpochMs ?? row.at ?? null, message: row.cause ?? null,
		damageType: row.damageType ?? null, attacker: row.attacker ?? null, directAttacker: row.directAttacker ?? null, source: 'agent_death' };
	if (row?.type === 'damage' && row.lethal === true) return { agentId: row.agentId ?? null, at: row.atMs ?? null, message: null,
		damageType: row.damageType ?? null, attacker: row.attacker ?? null, directAttacker: null, source: 'watcher' };
	return null;
}

/**
 * Death evidence from JSONL files, read line by line so a protocol journal of hundreds of MB never becomes one string.
 * Only lines naming a death are parsed. Missing files are skipped. Keeps rows of agentId (any goal revision: the
 * revision moves during a game, and a death after a steer or resume is still this agent's death) inside [from, to].
 */
export function readDeathEvidence(files, { agentId = null, from = -Infinity, to = Infinity } = {}) {
	const rows = [];
	for (const file of files) {
		let fd;
		try { fd = openSync(file, 'r'); } catch { continue; }
		try {
			const buffer = Buffer.alloc(1 << 20);
			let rest = '';
			for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
				const lines = (rest + buffer.toString('utf8', 0, n)).split('\n');
				rest = lines.pop();
				for (const line of lines) take(line);
			}
			take(rest);
		} finally { closeSync(fd); }
	}
	function take(line) {
		if (!line || !(line.includes('"dead"') || line.includes('"agent_death"') || line.includes('"lethal":true'))) return;
		let row; try { row = JSON.parse(line); } catch { return; }
		const death = deathEvidence(row);
		if (!death || agentId && death.agentId && death.agentId !== agentId) return;
		if (!Number.isFinite(death.at) || death.at < from || death.at > to) return;
		// The same death can arrive as a receipt, a trace row and a danger row: one death per agent per 1.5 s.
		const same = rows.find((other) => other.agentId === death.agentId && Math.abs(other.at - death.at) < 1500);
		if (same) { for (const key of EVIDENCE) if (same[key] == null && death[key] != null) same[key] = death[key]; return; }
		rows.push(death);
	}
	return rows.sort((a, b) => a.at - b.at);
}
