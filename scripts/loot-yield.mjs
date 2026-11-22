#!/usr/bin/env node
// Writes coordinator/config/loot-yield.json: for every chest loot table in the game's data, the mean count of each item
// one opened chest holds (rolls x weight share x mean stack). obtain's planner prices a chest as a source with it.
// Usage: node scripts/loot-yield.mjs <server or merged Minecraft jar> [out.json]
// Needs `unzip` on PATH. Run it again when the game version changes.
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
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

// Minimal NBT reader for the game's structure files (gzip, big-endian, named root compound).
function nbt(buffer) {
	let at = 0;
	const u8 = () => buffer[at++], i16 = () => { const v = buffer.readInt16BE(at); at += 2; return v; }, i32 = () => { const v = buffer.readInt32BE(at); at += 4; return v; };
	const str = () => { const n = buffer.readUInt16BE(at); at += 2; const v = buffer.toString('utf8', at, at + n); at += n; return v; };
	const value = (type) => {
		switch (type) {
			case 1: return buffer.readInt8(at++);
			case 2: return i16();
			case 3: return i32();
			case 4: at += 8; return 0;
			case 5: at += 4; return 0;
			case 6: at += 8; return 0;
			case 7: { const n = i32(); at += n; return null; }
			case 8: return str();
			case 9: { const inner = u8(); const n = i32(); return Array.from({ length: n }, () => value(inner)); }
			case 10: { const out = {}; for (;;) { const t = u8(); if (t === 0) return out; const name = str(); out[name] = value(t); } }
			case 11: { const n = i32(); return Array.from({ length: n }, () => i32()); }
			case 12: { const n = i32(); at += 8 * n; return null; }
			default: throw new Error(`NBT tag ${type}`);
		}
	};
	const type = u8(); str();
	return value(type);
}

// Village buildings a player walks into: per job block standing in the building (none: an ordinary house), how many
// building variants there are and the loot chests they hold, so a house's chance and contents come from the game.
const JOB_BLOCKS = new Set(['smithing_table', 'grindstone', 'blast_furnace', 'smoker', 'cartography_table', 'fletching_table', 'stonecutter', 'loom', 'water_cauldron', 'cauldron', 'brewing_stand', 'barrel']);
const houses = {};
for (const name of execFileSync('unzip', ['-Z1', jar], { maxBuffer: 64 << 20 }).toString().split('\n').filter((n) => /structure\/village\/[a-z]+\/houses\/.*\.nbt$/.test(n)).sort()) {
	const root = nbt(gunzipSync(execFileSync('unzip', ['-p', jar, name], { maxBuffer: 16 << 20 })));
	const palette = (root.palette ?? root.palettes?.[0] ?? []).map((row) => String(row.Name ?? row.id).replace(/^minecraft:/, ''));
	if (!palette.some((id) => id.endsWith('_door'))) continue;
	const job = palette.find((id) => JOB_BLOCKS.has(id) && id !== 'barrel') ?? (palette.includes('barrel') ? 'barrel' : 'none');
	const chests = root.blocks.filter((b) => ['chest', 'trapped_chest', 'barrel'].includes(palette[b.state]) && b.nbt?.LootTable).map((b) => String(b.nbt.LootTable).replace(/^minecraft:/, ''));
	const row = (houses[job] ??= { buildings: 0, chests: {} });
	row.buildings++;
	for (const table of chests) row.chests[table] = (row.chests[table] ?? 0) + 1;
}
writeFileSync(out, `${JSON.stringify({ source: 'vanilla chest loot tables: mean count per opened chest; village buildings with a door by job block: variants and their loot chests', tables, houses }, null, '\t')}\n`);
console.log(`${Object.keys(tables).length} tables, ${Object.keys(houses).length} house kinds -> ${path.relative(root, out)}`);
