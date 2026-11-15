// Replays search-danger.mjs on recorded games: every danger hand-back during find and obtain, what mob, distance, health,
// gear and what the model did next, and whether the body now handles it (a flinch) or still hands it back (a fork).
// node scripts/quality/search-danger-replay.mjs OUT.json RUN_DIR... (each RUN_DIR holds raw/decision-*.jsonl)
// Before: every recorded hand-back. After: a mob hand-back the body now handles is gone; a fork, and every hand-back
// that is not about a mob (water, a fall, lava, a flood), stays. Provider-free: reads the logs, calls no model.
// The gameplay stake imports loadDangerCorpus and replaySearchDanger to judge one corpus with the base and head rules.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decisionFiles } from './gate-report.mjs';

const BOUNDARY = '\nNewer coordinator events for this turn (treat them exactly like the turn input):\n';
// dig_to's hostile stop (ServerDigController.DIG_CLOSE): any hostile this close, else one hunting the body in sight.
const DIG_CLOSE = 4;

const find = (value, key, acc = []) => {
	if (value === null || typeof value !== 'object') return acc;
	if (Array.isArray(value)) { for (const entry of value) find(entry, key, acc); return acc; }
	for (const [name, entry] of Object.entries(value)) { if (name === key) acc.push(entry); find(entry, key, acc); }
	return acc;
};
const strings = (value, acc = []) => {
	if (typeof value === 'string') acc.push(value);
	else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) strings(entry, acc);
	return acc;
};

/**
 * The samples the model was shown with the hand-back, one per facts block (the steer's own first, then newer ones):
 * threats, health and gear, each block carrying over what it does not restate.
 */
function samplesOf(facts) {
	const out = [];
	let health = null, items = [], attacker = null, gear = { armor: 'none', weapon: 'none', pickaxe: 'none' };
	for (const block of facts.filter(Boolean)) {
		const healthText = find(block, 'health').filter((value) => typeof value === 'string').at(-1);
		if (healthText !== undefined) health = Number(healthText.split('/')[0]);
		const line = strings(block).filter((text) => /armor .*; weapon /.test(text)).at(-1);
		if (line !== undefined) gear = { armor: /armor ([a-z, ]+?);/.exec(line)?.[1] ?? 'none', weapon: /weapon ([a-z ]+?);/.exec(line)?.[1] ?? 'none', pickaxe: /pickaxe ([a-z]+)/.exec(line)?.[1] ?? 'none' };
		const listed = find(block, 'items').filter(Array.isArray).at(-1);
		if (listed !== undefined) items = listed.map((row) => row?.itemId).filter(Boolean);
		attacker = find(block, 'lastAttacker').filter((row) => row && typeof row === 'object').at(-1) ?? attacker;
		const held = [...items];
		if (gear.weapon !== 'none') held.push(`minecraft:${gear.weapon.replace(' ', '_')}`);
		if (gear.pickaxe !== 'none') held.push(`minecraft:${gear.pickaxe}_pickaxe`);
		// A block can restate threats more than once (a change and its base): each is a sample the model saw.
		for (const rows of find(block, 'threats').filter(Array.isArray)) {
			out.push({ observation: { player: { health, threats: rows, lastAttacker: attacker }, inventory: { items: held.map((itemId) => ({ itemId })) } }, gear, health });
		}
	}
	if (out.length === 0) out.push({ observation: { player: { health, threats: [], lastAttacker: attacker }, inventory: { items: [] } }, gear, health });
	return out;
}

/** A fork in any sample the model was shown stands (a steer fired on it); otherwise the last sample's call. */
function judge(samples, searchDanger) {
	const calls = samples.map((sample) => searchDanger(sample.observation));
	return calls.find((call) => call?.fork !== undefined) ?? calls.filter(Boolean).at(-1) ?? null;
}

/** Why the body stopped: the runtime's danger steer, find's own stop, obtain's own stop, or obtain's low health. */
function mechanism(head, message) {
	if (head.reasonCode === 'LOW_HEALTH') return 'obtain-low-health';
	if (/Danger stopped the search|reflexes did not handle/.test(message)) return 'steer';
	if (/find: Stopped for danger|^Stopped for danger: /.test(message)) return 'find-stop';
	return 'obtain-stop';
}

/** What the hand-back was about: a mob, water, a fall, lava, a flood. */
function topic(head, wake, message, samples) {
	const first = wake[0] ?? '';
	if (/^drowning|eyes above water/.test(first)) return 'water';
	if (/TUNNEL_FLOODED/.test(message)) return 'flood';
	if (/LAVA_|lava/i.test(message) || /lava/.test(first)) return 'lava';
	if (head.reasonCode === 'LOW_HEALTH') return 'low health';
	if (/LOW_HEALTH/.test(message)) return 'mob';
	if (/^nearby threat|^nearby attacker|^creeper|HOSTILE_NEAR/.test(first) || /HOSTILE_NEAR/.test(message)) return 'mob';
	if (samples.some((sample) => sample.observation.player.threats.length > 0) && !/^Update/.test(first)) return 'mob';
	if (/^Update/.test(first)) return 'fall';
	return 'other';
}

/** Each run's decision log, parsed once (a rotated log's older half first). */
export function loadDangerCorpus(runs) {
	return runs.map((run) => ({ run: path.basename(run), lines: decisionFiles(path.join(run, 'raw'))
		.flatMap((file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))) }));
}

/** Judges every danger hand-back in the corpus with one tree's rule (searchDanger) and fact decoder. */
export function replaySearchDanger(corpus, { searchDanger, decodeModelFacts }) {
	const rows = [];
	for (const { run, lines } of corpus) {
		const start = lines[0].time;
		const calls = new Map();
		const ordered = [];
		for (const record of lines.filter((entry) => entry.type === 'decision')) for (const call of record.toolCalls ?? []) { calls.set(call.callId, call); ordered.push(call); }
		ordered.sort((a, b) => a.at - b.at);
		const actions = lines.filter((entry) => entry.type === 'action_result');
		for (const record of lines) {
			if (record.type !== 'tool_result') continue;
			const text = typeof record.result === 'string' ? record.result : JSON.stringify(record.result);
			const [headText, ...rest] = text.split(BOUNDARY);
			let head;
			try { head = JSON.parse(headText); } catch { continue; }
			const call = calls.get(record.callId);
			const verb = call?.arguments?.verb;
			if (!((verb === 'obtain' && ['DANGER', 'LOW_HEALTH'].includes(head.reasonCode)) || head.reasonCode === 'FIND_DANGER')) continue;
			const tail = rest.join('\n').split('\n');
			const wake = tail.filter((line) => !line.startsWith('{"format"'));
			const facts = tail.filter((line) => line.startsWith('{"format"')).map((line) => { try { return decodeModelFacts(JSON.parse(line)); } catch { return null; } });
			const message = String(head.message ?? '');
			const samples = samplesOf(facts), sample = samples.at(-1);
			const legs = actions.filter((entry) => entry.time >= (call?.at ?? 0) && entry.time <= record.time)
				.map((entry) => `${entry.result?.actionType}:${entry.result?.reasonCode} ${String(entry.result?.message ?? '').slice(0, 140)}`);
			const how = mechanism(head, message);
			const about = topic(head, wake, message, samples);
			const judged = about === 'mob' ? judge(samples, searchDanger) : null;
			// A search's steer is held, and its stops handled, for a flinch; obtain's own dig stops now only for a hostile within
			// DIG_CLOSE or one hunting the body in sight (dig_to's rule), so a stop for anything else is gone too.
			const digStop = how === 'obtain-stop' && /dig_to|HOSTILE_NEAR/.test(message) && judged?.handle !== undefined
				&& !(judged.mob.distance <= DIG_CLOSE || (judged.mob.targeting === true && judged.mob.lineOfSight === true));
			const searching = /find: /.test(message) || how === 'find-stop' || verb === 'find';
			const handled = about === 'mob' && judged?.handle !== undefined && (searching || digStop);
			const index = ordered.findIndex((entry) => entry.callId === record.callId);
			const next = ordered.slice(index + 1).find((entry) => entry.name === 'do_step' || entry.arguments?.verb !== undefined) ?? ordered[index + 1];
			const mobs = samples.flatMap((entry) => entry.observation.player.threats).filter((row, i, all) => all.findIndex((other) => other.uuid === row.uuid) === i).map((row) => `${String(row.type).replace('minecraft:', '')} ${Math.round(row.distance)}${row.targeting ? ' hunting' : ''}${row.lineOfSight ? ' in sight' : ''}`);
			rows.push({ run, minute: Math.round((record.time - start) / 6000) / 10, verb, item: head.item ?? call?.arguments?.target?.block ?? call?.arguments?.target?.mob ?? null,
				code: head.reasonCode, how, about, mobs, health: sample.health, gear: sample.gear, wake: (wake[0] ?? '').slice(0, 120), message: message.replace(/\(native:[^)]*\)/g, '').slice(0, 240),
				lastLeg: legs.at(-1) ?? null, next: next ? `${next.arguments?.verb ?? next.name}: ${String(next.arguments?.why ?? '').slice(0, 120)}` : null,
				verdict: judged === null ? null : judged.fork !== undefined ? `fork: ${judged.fork}` : `${judged.handle}: ${judged.why}`, after: handled ? 'handled by the body' : 'handed back' });
		}
	}
	const count = (filter) => rows.filter(filter).length;
	const mob = (row) => row.about === 'mob';
	const summary = {
		handBacks: { before: rows.length, after: count((row) => row.after === 'handed back') },
		mobHandBacks: { before: count(mob), after: count((row) => mob(row) && row.after === 'handed back') },
		flinchKind: count((row) => mob(row) && row.verdict !== null && !row.verdict.startsWith('fork')),
		forks: count((row) => mob(row) && (row.verdict === null || row.verdict.startsWith('fork'))),
		byTopic: Object.fromEntries([...new Set(rows.map((row) => row.about))].map((about) => [about, count((row) => row.about === about)])),
		perGame: Object.fromEntries([...new Set(rows.map((row) => row.run))].map((run) => [run, `${count((row) => row.run === run && mob(row))} -> ${count((row) => row.run === run && mob(row) && row.after === 'handed back')}`])),
	};
	return { summary, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [outFile, ...runs] = process.argv.slice(2);
	if (!outFile || runs.length === 0) throw new Error('Usage: OUT.json RUN_DIR...');
	const [{ decodeModelFacts }, { searchDanger }] = await Promise.all([import('../../coordinator/src/model-fact-encoding.mjs'), import('../../coordinator/src/search-danger.mjs')]);
	const { summary, rows } = replaySearchDanger(loadDangerCorpus(runs), { searchDanger, decodeModelFacts });
	const mob = (row) => row.about === 'mob';
	writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 1));
	console.log(JSON.stringify(summary, null, 1));
	for (const row of rows.filter(mob)) console.log(`${row.run} ${row.minute}m ${row.verb} ${row.item} ${row.how} hp ${row.health} [${row.gear.weapon}/${row.gear.pickaxe}] ${row.mobs.slice(0, 3).join('; ')} => ${row.verdict} => ${row.after}`);
}
