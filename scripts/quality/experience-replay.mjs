#!/usr/bin/env node
// Replays recorded games through the coordinator's own death and failure review (experience-runtime.mjs), in order,
// into one experience folder, as if they were played one after another by one player profile. No model calls.
//
// Usage: node scripts/quality/experience-replay.mjs --experience-dir DIR_OUTSIDE_CHECKOUT [--profile NAME] [--out report.json]
//          GAME_DIR [GAME_DIR ...]
// Each GAME_DIR holds raw/quality-protocol.jsonl (the bridge rows of one game) and, if present, raw/manifest.json with
// the scenario seed. Prints per game: deaths reviewed, lessons recorded, and how many observations would have shown
// a lesson carried from an earlier game (situation match), plus the bytes those lessons add to a summary.
// Recordings that keep only trimmed observations (world, inventory, blocks) get health from raw/quality-samples.jsonl;
// they carry no entities, so lessons that need a mob in view are recorded but never match a sampled situation.
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { RuntimeMemoryContext } from '../../coordinator/src/runtime-memory-context.mjs';
import { TaskMemoryStore } from '../../coordinator/src/task-memory-store.mjs';
import { experienceSettings } from '../../coordinator/src/experience-store.mjs';
import { createExperience } from '../../coordinator/src/experience-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'experience-dir': { type: 'string' }, profile: { type: 'string', default: 'replay' }, out: { type: 'string' }, 'sample-every': { type: 'string', default: '10' } } });
if (!values['experience-dir'] || positionals.length === 0) { console.error('Usage: experience-replay.mjs --experience-dir DIR [--profile NAME] [--out FILE] GAME_DIR...'); process.exit(2); }
const directory = path.resolve(values['experience-dir']);
if (!path.relative(ROOT, directory).startsWith('..')) { console.error('--experience-dir must be outside the checkout'); process.exit(2); }
const sampleEvery = Number(values['sample-every']);
// A replay is one profile's history from empty: reusing a profile or a recording would count the same games twice.
if (new Set(positionals.map((game) => path.resolve(game))).size !== positionals.length) { console.error('Each recording may appear once'); process.exit(2); }
if (existsSync(directory) && (await readdir(directory)).length > 0) { console.error('--experience-dir must be empty or missing'); process.exit(2); }

async function healthSamples(gameDirectory) {
	const file = path.join(gameDirectory, 'raw/quality-samples.jsonl');
	const rows = [];
	if (!existsSync(file)) return rows;
	for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
		try { const row = JSON.parse(line); if (Number.isFinite(row.at) && Number.isFinite(row.health)) rows.push({ at: row.at, health: row.health }); } catch { /* skip */ }
	}
	return rows;
}
/** The full observation when the recording has one; otherwise the trimmed row with the nearest earlier health sample. */
function observationOf(payload, health, recording) {
	try { return { observation: adaptObservation(payload.observation ?? payload), trimmed: false }; } catch { /* trimmed recording */ }
	const { goalRevision, dimension, ...rest } = payload;
	// Long-run rows may keep only the dimension: give each recording its own stable world identity.
	// The recording folder names the game (hashed before it is stored), so separate invocations agree on identities.
	const world = { worldId: rest.world?.worldId ?? `replay:${recording}`, ...(rest.world ?? {}) };
	world.dimension ??= world.dimensionId ?? dimension;
	rest.world = world;
	const at = rest.observedAtEpochMs;
	while (health.index + 1 < health.rows.length && health.rows[health.index + 1].at <= at) health.index += 1;
	const sample = health.rows[health.index];
	return { observation: { ready: true, ...rest, player: { ...(sample && sample.at <= at ? { health: sample.health } : {}) }, entities: [] }, trimmed: true };
}

async function seedOf(gameDirectory) {
	for (const file of ['raw/manifest.json', 'raw/world-manifest.json']) {
		const full = path.join(gameDirectory, file);
		if (!existsSync(full)) continue;
		const text = await readFile(full, 'utf8');
		const found = /"seed"\s*:\s*"?(-?\d+)"?/.exec(text);
		if (found) return found[1];
	}
	return null;
}

const report = [];
for (const [index, gameDirectory] of positionals.entries()) {
	const seed = await seedOf(gameDirectory);
	const events = [];
	const env = { MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: values.profile, ...(seed ? { MINEAGEN_WORLD_SEED_HASH: seed } : {}) };
	const experience = createExperience(experienceSettings(env), { trace: (event, fields) => events.push({ event, ...fields }) });
	const memory = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience });
	const agents = new Map();
	const health = { rows: await healthSamples(gameDirectory), index: 0 };
	const stats = { trimmedObservations: 0, game: index + 1, seedKnown: seed !== null, observations: 0, dispatches: 0, results: 0, deaths: 0, rejected: 0, sampled: 0, sampledWithCarried: 0, sampledWithAny: 0, carriedBytes: [], shownRules: {} };
	const lines = createInterface({ input: createReadStream(path.join(gameDirectory, 'raw/quality-protocol.jsonl')), crlfDelay: Infinity });
	for await (const line of lines) {
		let row; try { row = JSON.parse(line); } catch { continue; }
		const envelope = row.envelope ?? {};
		const payload = envelope.payload ?? {};
		if (typeof envelope.agentId !== 'string') continue;
		const goalRevision = Number.isSafeInteger(payload.goalRevision) ? payload.goalRevision : agents.get(envelope.agentId) ?? 1;
		agents.set(envelope.agentId, goalRevision);
		const record = { agentId: envelope.agentId, goalRevision };
		try {
			if (envelope.type === 'observation') {
				const { observation, trimmed } = observationOf(payload, health, path.resolve(gameDirectory));
				if (trimmed) stats.trimmedObservations += 1;
				memory.observe(record, observation);
				stats.observations += 1;
				if (stats.observations % sampleEvery === 0) {
					const { entries: lessons } = await experience.lessonsFor(record.agentId, { at: observation.observedAtEpochMs ?? Date.now() });
					stats.sampled += 1;
					if (lessons.length) stats.sampledWithAny += 1;
					const carried = lessons.filter((lesson) => /earlier game/.test(lesson.src));
					if (carried.length) { stats.sampledWithCarried += 1; stats.carriedBytes.push(Buffer.byteLength(JSON.stringify(carried))); }
				}
			} else if (envelope.type === 'action_command') {
				await memory.recordDispatch(record, { actionId: payload.actionId, actionType: payload.actionType, goalRevision, arguments: payload.arguments ?? {} });
				stats.dispatches += 1;
			} else if (envelope.type === 'action_result') {
				if (await memory.recordResult(record, payload)) stats.results += 1;
			} else if (envelope.type === 'goal_control' && payload.operation === 'dead' && payload.death) {
				memory.observe(record, { death: payload.death });
				stats.deaths += 1;
			}
		} catch { stats.rejected += 1; }
	}
	await memory.flush();
	const recorded = events.filter((event) => event.event === 'experience_lesson_recorded');
	const reviewed = events.filter((event) => event.event === 'experience_death_reviewed');
	const bytes = stats.carriedBytes.sort((a, b) => a - b);
	// LONG captures drop action rows: without them the failure rules and the action-dependent death rules cannot fire.
	if (stats.dispatches === 0 && stats.results === 0) console.warn(`game ${index + 1}: no action rows in this recording; failure and action-dependent death lessons were not reviewed`);
	report.push({ ...stats, actionEvidence: stats.dispatches + stats.results > 0, carriedBytes: undefined,
		carriedBytesMedian: bytes.length ? bytes[Math.floor(bytes.length / 2)] : 0, carriedBytesMax: bytes.at(-1) ?? 0,
		deathsReviewed: reviewed.length, deathCauses: reviewed.map((event) => event.escaping ? `${event.cause}<-${event.escaping}` : event.cause),
		lessonsRecorded: recorded.map((event) => event.lessonId), state: experience.state() });
	console.log(JSON.stringify(report.at(-1)));
}
if (values.out) await writeFile(path.resolve(values.out), `${JSON.stringify(report, null, '\t')}\n`);
