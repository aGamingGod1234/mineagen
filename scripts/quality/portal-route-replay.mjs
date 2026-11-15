// Route replay on recorded games: node scripts/quality/portal-route-replay.mjs RUN_DIR... (a sub/long/<tag>-codex folder)
// For every model wake while the body held a bucket and flint and steel in the Overworld, the route line the game
// showed (from the decision log) beside the line this tree's routeLine gives for the same state (inventory and hunger
// from raw/quality-samples.jsonl at that moment; lava pools as many as the shown line counted), and what the model called
// next. No model call is made. Prints a summary per game, and one row per wake with --rows.
// The gameplay stake imports loadPortalCorpus and replayPortalRoute to judge one corpus with the base and head trees.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decisionFiles } from './gate-report.mjs';

const PORTAL_STEP = /^usual next step: (obtain water_bucket|find block minecraft:lava|build nether_portal|obtain bucket count|obtain flint_and_steel|enter the Nether)/;
const FOOD = /cooked_beef on the way|top up before the Nether: .*food/;
const lines = async (file) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
const items = (nbt) => [...String(nbt).matchAll(/\{(?:components: \{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}, )?count: (\d+), Slot: (-?\d+)b, id: "([^"]+)"/g)].map((m) => ({ itemId: m[3], count: Number(m[1]), slot: Number(m[2]) }));

/**
 * Each game's wakes while the kit was held, with the line shown and the state at that moment. Parsed once, so the
 * base and head trees judge the same wakes.
 */
export async function loadPortalCorpus(dirs) {
	const games = [];
	for (const dir of dirs) {
		const rows = (await Promise.all(decisionFiles(path.join(dir, 'raw')).map(lines))).flat();
		const samples = await lines(path.join(dir, 'raw', 'quality-samples.jsonl'));
		const t0 = rows[0].time;
		const sampleAt = (time) => samples.reduce((best, row) => (Math.abs(row.at - time) < Math.abs(best.at - time) ? row : best));
		let shown = null, kitAt = null;
		const wakes = [];
		for (const row of rows) {
			if (row.type !== 'decision') continue;
			for (const input of row.inputs ?? []) {
				const found = /\\?"route\\?":\\?"(usual next step: [^"\\]*)/.exec(input.text ?? '');
				if (found) shown = found[1];
			}
			const sample = sampleAt(row.time);
			const held = items(sample.inventoryNbt);
			const has = (id) => held.some((item) => item.itemId === id && item.count > 0);
			const kit = sample.dimension === 'minecraft:overworld' && held.some((item) => /^minecraft:(bucket|water_bucket|lava_bucket)$/.test(item.itemId)) && has('minecraft:flint_and_steel');
			if (kit) kitAt ??= row.time;
			if (!kit || shown === null) continue;
			const call = (row.toolCalls ?? []).map((tool) => tool.name === 'do_step' ? `${tool.arguments?.verb} ${JSON.stringify(tool.arguments?.target ?? {}).slice(0, 70)}` : tool.name)[0] ?? '(no call)';
			wakes.push({ minute: (row.time - t0) / 60000, shown, sample, held, call });
		}
		games.push({ run: path.basename(dir), kitAt: kitAt === null ? null : (kitAt - t0) / 60000, wakes });
	}
	return games;
}

/** The route line one tree (routeLine, emptyKnown, evaluatePlanCheck) gives at every wake, against the line shown. */
export function replayPortalRoute(games, { routeLine, emptyKnown, evaluatePlanCheck }) {
	const totals = { games: games.length, wakes: 0, oldPortal: 0, oldFood: 0, newPortal: 0, newFood: 0 };
	const perGame = games.map(({ run, kitAt, wakes }) => {
		const summary = { run, kitAt, wakes: 0, oldPortal: 0, oldFood: 0, newPortal: 0, newFood: 0, rows: [] };
		for (const { minute, shown, sample, held, call } of wakes) {
			const foodLevel = Number(/foodLevel: (\d+)/.exec(sample.entityNbt)?.[1]);
			const known = emptyKnown();
			const pools = Number(/lava pools seen (\d+)/.exec(shown)?.[1] ?? 0);
			for (let i = 0; i < pools; i++) known.lavaPools.push({ dimension: 'minecraft:overworld', x: i, y: -50, z: 0 });
			const observation = { ready: true, observedAtEpochMs: sample.at, player: { ...sample.position, health: sample.health, ...(Number.isFinite(foodLevel) ? { foodLevel } : {}) },
				world: { dimension: sample.dimension }, inventory: { items: held } };
			const now = routeLine({ observation, known, evaluate: evaluatePlanCheck });
			summary.wakes += 1;
			if (PORTAL_STEP.test(shown) && !FOOD.test(shown)) summary.oldPortal += 1;
			if (FOOD.test(shown)) summary.oldFood += 1;
			if (PORTAL_STEP.test(now ?? '') && !FOOD.test(now ?? '')) summary.newPortal += 1;
			if (FOOD.test(now ?? '')) summary.newFood += 1;
			summary.rows.push({ minute, foodLevel, shown, now, call });
		}
		for (const key of ['wakes', 'oldPortal', 'oldFood', 'newPortal', 'newFood']) totals[key] += summary[key];
		return summary;
	});
	return { totals, perGame };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const showRows = process.argv.includes('--rows');
	const [{ routeLine }, { emptyKnown, evaluatePlanCheck }] = await Promise.all([import('../../coordinator/src/skill-fits.mjs'), import('../../coordinator/src/plan-checks.mjs')]);
	const games = await loadPortalCorpus(process.argv.slice(2).filter((arg) => arg !== '--rows'));
	const { perGame } = replayPortalRoute(games, { routeLine, emptyKnown, evaluatePlanCheck });
	for (const summary of perGame) {
		console.log(`== ${summary.run}`);
		if (showRows) for (const row of summary.rows) console.log(`${row.minute.toFixed(1).padStart(5)} min hunger ${row.foodLevel}\n   shown: ${row.shown}\n   now:   ${row.now}\n   model: ${row.call}`);
		console.log(`-- ${summary.run}: kit first held at ${summary.kitAt === null ? 'never' : `${summary.kitAt.toFixed(1)} min`}; ${summary.wakes} wakes holding it; shown line: next portal step without a food detour ${summary.oldPortal}, food detour ${summary.oldFood}; this tree: next portal step without a food detour ${summary.newPortal}, food detour ${summary.newFood}`);
	}
}
