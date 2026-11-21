#!/usr/bin/env node
// Scan recorded traces and extract raw decision moments for the decision-eval corpus.
//
//   node scripts/decision-eval/capture.mjs --root <dir> --out moments.jsonl [--cooldown-ms 30000] [--at <file.json>] <trace dir>...
//
// --at names a JSON array of { atMs, label, agentId? } pins: instead of the triggers, one moment is captured on the first live
// observation at or after each pin (trigger "pinned", the pin in `detail`). Use it for moments chosen elsewhere,
// such as a decision-log line; give one trace dir with it. --sightings N also keeps up to N earlier observations of the
// same life that first sighted a cave, vein or lava, so remembered places reach the replayed wake.
//
// Each trace dir (searched recursively) is a folder holding quality-protocol.jsonl (preferred) or protocol.jsonl,
// optionally provider-turns.private.jsonl and player-memory/plans/*.json. Trace paths in the output are relative
// to --root so provenance stays portable. A summary with counts per trace and trigger goes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { MomentCapture, summarizeMoments } from '../../coordinator/src/decision-eval/capture.mjs';

function parseArgs(argv) {
	const args = { root: process.cwd(), out: null, cooldownMs: undefined, at: null, sightings: 0, dirs: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--root') args.root = argv[++i];
		else if (arg === '--out') args.out = argv[++i];
		else if (arg === '--cooldown-ms') args.cooldownMs = Number(argv[++i]);
		else if (arg === '--at') args.at = argv[++i];
		else if (arg === '--sightings') args.sightings = Number(argv[++i]);
		else if (arg === '--help' || arg === '-h') args.help = true;
		else args.dirs.push(arg);
	}
	return args;
}

export function findTraceDirs(start) {
	const found = [];
	const walk = (dir, depth) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
		// quality-protocol.jsonl is the complete audit; protocol.jsonl is a subset of the same run. Other
		// *protocol.jsonl files (live smoke captures) are separate traces.
		const protocol = names.has('quality-protocol.jsonl') ? 'quality-protocol.jsonl' : (names.has('protocol.jsonl') ? 'protocol.jsonl' : null);
		if (protocol) found.push({ dir, protocol: path.join(dir, protocol) });
		else for (const name of [...names].filter((n) => n.endsWith('protocol.jsonl')).sort()) found.push({ dir, protocol: path.join(dir, name) });
		if (depth > 6) return;
		for (const entry of entries) if (entry.isDirectory() && !['node_modules', 'server', 'logs', '.git'].includes(entry.name)) walk(path.join(dir, entry.name), depth + 1);
	};
	walk(start, 0);
	return found;
}

function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

export function readRecordedPlan(dir) {
	const plansDir = [path.join(dir, 'player-memory', 'plans'), path.join(dir, 'provider-workspaces', 'player-memory', 'plans')].find((p) => fs.existsSync(p));
	if (!plansDir) return null;
	const plans = fs.readdirSync(plansDir).filter((name) => name.endsWith('.json')).map((name) => {
		try { return JSON.parse(fs.readFileSync(path.join(plansDir, name), 'utf8')); } catch { return null; }
	}).filter((plan) => Array.isArray(plan?.plan?.steps) && plan.plan.steps.length > 0).sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));
	if (plans.length === 0) return null;
	return { steps: plans[0].plan.steps.map((step) => ({ ...step, status: step.check || ['inventory', 'world'].includes(step.kind) ? 'pending' : step.status })) };
}

export async function captureTrace({ dir, protocol }, { root, cooldownMs, pinned = [], sightings = 0 } = {}) {
	const relative = path.relative(root, dir).split(path.sep).join('/') || '.';
	const base = path.basename(protocol);
	const trace = ['quality-protocol.jsonl', 'protocol.jsonl'].includes(base) ? relative : `${relative}/${base}`;
	const turns = readJsonl(path.join(dir, 'provider-turns.private.jsonl'));
	const capture = new MomentCapture({ trace, turns, options: { ...(cooldownMs ? { cooldownMs } : {}), ...(sightings > 0 ? { sightingObservations: sightings } : {}) }, pinned });
	const lines = readline.createInterface({ input: fs.createReadStream(protocol), crlfDelay: Infinity });
	let line = 0;
	for await (const text of lines) {
		line++;
		if (!/"type":"(observation|action_command|action_result|goal_control|goal_spec_request)"/.test(text)) continue;
		let row;
		try { row = JSON.parse(text); } catch { continue; }
		capture.ingest(row, line);
	}
	const plan = readRecordedPlan(dir);
	for (const moment of capture.moments) {
		moment.source.protocolFile = path.basename(protocol);
		if (plan) { moment.state.agent.taskPlan = plan; moment.source.taskPlan = 'last recorded plan definitions; checked steps pending (renderer re-evaluates checks)'; }
	}
	return { trace, moments: capture.moments, stats: capture.stats };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || args.dirs.length === 0 || !args.out) {
		process.stderr.write('usage: capture.mjs --root <dir> --out <moments.jsonl> [--cooldown-ms N] <trace dir>...\n');
		process.exit(args.help ? 0 : 2);
	}
	const root = path.resolve(args.root);
	const pinned = args.at === null ? [] : JSON.parse(fs.readFileSync(args.at, 'utf8'));
	if (args.at !== null && args.dirs.length !== 1) { process.stderr.write('--at needs exactly one trace dir\n'); process.exit(2); }
	const out = fs.createWriteStream(args.out);
	const report = [];
	for (const start of args.dirs) {
		for (const trace of findTraceDirs(path.resolve(start))) {
			const { trace: name, moments, stats } = await captureTrace(trace, { root, cooldownMs: args.cooldownMs, pinned, sightings: args.sightings });
			for (const moment of moments) out.write(`${JSON.stringify(moment)}\n`);
			report.push({ trace: name, ...summarizeMoments(moments), stats });
			process.stderr.write(`${name}: ${moments.length} moments (${stats.observations} observations, ${stats.failures} failures, ${stats.deaths} deaths)\n`);
		}
	}
	await new Promise((resolve) => out.end(resolve));
	process.stderr.write(`${JSON.stringify({ traces: report.length, moments: report.reduce((n, r) => n + r.total, 0) })}\n`);
	fs.writeFileSync(`${args.out}.summary.json`, JSON.stringify(report, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
