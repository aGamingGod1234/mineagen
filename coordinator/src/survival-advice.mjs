// Presentation conditions only: these do not start or refuse any action.
export function foodAdviceNeeded(o) {
	if (['player', 'hud'].some(s => o?.continuity?.rememberedSections?.includes(s))) return false;
	return Number.isFinite(o?.player?.foodLevel) && o.player.foodLevel <= 14
		|| Number.isFinite(o?.player?.health) && o.player.health <= 14;
}

export function quickBedSource(o, { atPortal = false } = {}) {
	const stale = section => o?.continuity?.rememberedSections?.includes(section);
	if (o?.ready !== true || o.player?.dead === true || o.world?.dimension !== 'minecraft:overworld'
		|| stale('world') || stale('inventory') || !Array.isArray(o.inventory?.items)) return null;
	const blocks = stale('blocks') ? [] : o.blocks ?? [];
	// An open portal is an available stage, so automatic bed preparation can wait.
	const portalBlocks = stale('blocks') ? [] : [...blocks, ...(o.landmarks ?? [])];
	// The bed-by-the-portal offer is made at the portal itself (atPortal), so it keeps its source there.
	if (!atPortal && (portalBlocks.some(b => ['minecraft:nether_portal', 'minecraft:end_portal'].includes(b.blockId))
		|| !stale('sighted') && o.sighted?.portalFrames?.some(f => f.lit === true))) return null;
	const items = o.inventory.items.filter(i => i.count > 0);
	if (items.some(i => /^minecraft:\w+_bed$/.test(i.itemId ?? ''))) return 'held';
	if (blocks.some(b => /^minecraft:\w+_bed$/.test(b.blockId ?? '') && b.visible !== false)) return 'seen';
	const wool = new Map();
	for (const i of items) if (/^minecraft:\w+_wool$/.test(i.itemId ?? '')) wool.set(i.itemId, (wool.get(i.itemId) ?? 0) + i.count);
	if ([...wool.values()].some(n => n >= 3)) return 'wool';
	if (!stale('entities') && o.entities?.some(e => e.type === 'minecraft:sheep' && e.alive !== false
		&& e.visible !== false && e.perceivedBy !== 'sound')) return 'sheep';
	return null;
}

const BED = /^minecraft:(\w+)_bed$/;
const WOOL = /^minecraft:(\w+)_wool$/;

/**
 * A bed for the Overworld portal from what is in reach right now, never from a search: a bed held or in view, or one
 * colour of wool reaching 3 from wool held, wool blocks in view and adult unsheared sheep in view (one wool each; a sheep
 * of unknown colour does not count). Unlike quickBedSource, a portal in view does not hide it.
 * Returns { kind: 'held', itemId } | { kind: 'seen', block } | { kind: 'wool' | 'gather', colour, held, blocks, sheep } | null.
 */
export function portalBedSource(o) {
	const stale = section => o?.continuity?.rememberedSections?.includes(section);
	if (o?.ready !== true || o.player?.dead === true || o.world?.dimension !== 'minecraft:overworld'
		|| stale('world') || stale('inventory') || !Array.isArray(o.inventory?.items)) return null;
	const items = o.inventory.items.filter(i => i?.count > 0);
	const held = items.find(i => BED.test(i.itemId ?? ''));
	if (held) return { kind: 'held', itemId: held.itemId };
	const blocks = stale('blocks') ? [] : (o.blocks ?? []).filter(b => b?.visible !== false && b.remembered !== true && [b.x, b.y, b.z].every(Number.isFinite));
	const seen = blocks.find(b => BED.test(b.blockId ?? ''));
	if (seen) return { kind: 'seen', block: seen };
	const colours = new Map();
	const add = (colour, key, n) => { const row = colours.get(colour) ?? { colour, held: 0, blocks: 0, sheep: 0 }; row[key] += n; colours.set(colour, row); };
	for (const i of items) { const wool = WOOL.exec(i.itemId ?? ''); if (wool) add(wool[1], 'held', i.count); }
	for (const b of blocks) { const wool = WOOL.exec(b.blockId ?? ''); if (wool) add(wool[1], 'blocks', 1); }
	if (!stale('entities')) for (const e of o.entities ?? []) {
		if (e?.type !== 'minecraft:sheep' || e.alive === false || e.visible === false || e.perceivedBy === 'sound' || e.baby === true
			|| e.appearance?.baby === true || e.appearance?.sheared === true || typeof e.appearance?.woolColor !== 'string') continue;
		add(e.appearance.woolColor, 'sheep', 1);
	}
	const best = [...colours.values()].filter(row => row.held + row.blocks + row.sheep >= 3)
		.sort((a, b) => b.held - a.held || (b.held + b.blocks + b.sheep) - (a.held + a.blocks + a.sheep))[0];
	return best ? { kind: best.held >= 3 ? 'wool' : 'gather', ...best } : null;
}
