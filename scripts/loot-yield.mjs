#!/usr/bin/env node
// Writes coordinator/config/loot-yield.json: for every chest loot table in the game's data, the mean count of each item
// one opened chest holds (rolls x weight share x mean stack). obtain's planner prices a chest as a source with it.
// Usage: node scripts/loot-yield.mjs <server or merged Minecraft jar> [out.json]
// Needs `unzip` on PATH. Run it again when the game version changes.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [jar, out = path.join(root, 'coordinator/config/loot-yield.json')] = process.argv.slice(2);
if (!jar) { console.error('usage: node scripts/loot-yield.mjs <minecraft jar> [out.json]'); process.exit(2); }

const PREFIX = 'data/minecraft/loot_table/';
const names = execFileSync('unzip', ['-Z1', jar], { maxBuffer: 64 << 20 }).toString().split('\n')
	.filter((name) => name.startsWith(`${PREFIX}chests/`) && name.endsWith('.json'));
const read = (name) => JSON.parse(execFileSync('unzip', ['-p', jar, name], { maxBuffer: 16 << 20 }).toString());

/** Mean of a number provider: a constant, uniform, or binomial; anything else counts as 1. */
export function mean(provider) {
	if (typeof provider === 'number') return provider;
	if (!provider || typeof provider !== 'object') return 1;
	const type = String(provider.type ?? '').replace(/^minecraft:/, '');
	if (type === 'uniform') return (mean(provider.min) + mean(provider.max)) / 2;
	if (type === 'binomial') return mean(provider.n) * mean(provider.p);
	if (type === 'constant') return mean(provider.value);
	return 1;
}

/** Mean stack size from an entry's set_count modifier (26.x "modifier", older "functions"). */
function stack(entry) {
	const mods = [entry.modifier, entry.functions].flat().filter(Boolean);
	let count = 1;
	for (const mod of mods) {
		const list = Array.isArray(mod) ? mod : [mod];
		for (const one of list) {
			const type = String(one?.type ?? one?.function ?? '').replace(/^minecraft:/, '');
			if (type === 'set_count') count = one.add ? count + mean(one.count) : mean(one.count);
			if (type === 'sequence') for (const inner of one.functions ?? one.modifiers ?? []) if (String(inner?.type ?? inner?.function ?? '').endsWith('set_count')) count = mean(inner.count);
		}
	}
	return count;
}

export function tableYield(table) {
	const items = {};
	for (const pool of table.pools ?? []) {
		const entries = pool.entries ?? [];
		const total = entries.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
		if (total <= 0) continue;
		const rolls = mean(pool.rolls);
		for (const entry of entries) {
			if (String(entry.type).replace(/^minecraft:/, '') !== 'item' || typeof entry.name !== 'string') continue;
			const id = entry.name.replace(/^minecraft:/, '');
			items[id] = (items[id] ?? 0) + rolls * ((entry.weight ?? 1) / total) * stack(entry);
		}
	}
	return Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)).map(([id, n]) => [id, Math.round(n * 1000) / 1000]));
}

const tables = {};
for (const name of names.sort()) tables[name.slice(PREFIX.length, -'.json'.length)] = tableYield(read(name));
writeFileSync(out, `${JSON.stringify({ source: 'vanilla chest loot tables: mean count per opened chest', tables }, null, '\t')}\n`);
console.log(`${Object.keys(tables).length} tables -> ${path.relative(root, out)}`);
