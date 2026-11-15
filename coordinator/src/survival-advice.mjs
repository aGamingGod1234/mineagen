// Presentation conditions only: these do not start or refuse any action.
export function foodAdviceNeeded(o) {
	if (['player', 'hud'].some(s => o?.continuity?.rememberedSections?.includes(s))) return false;
	return Number.isFinite(o?.player?.foodLevel) && o.player.foodLevel <= 14
		|| Number.isFinite(o?.player?.health) && o.player.health <= 14;
}

export function quickBedSource(o) {
	const stale = section => o?.continuity?.rememberedSections?.includes(section);
	if (o?.ready !== true || o.player?.dead === true || o.world?.dimension !== 'minecraft:overworld'
		|| stale('world') || stale('inventory') || !Array.isArray(o.inventory?.items)) return null;
	const blocks = stale('blocks') ? [] : o.blocks ?? [];
	// An open portal is an available stage, so automatic bed preparation can wait.
	const portalBlocks = stale('blocks') ? [] : [...blocks, ...(o.landmarks ?? [])];
	if (portalBlocks.some(b => ['minecraft:nether_portal', 'minecraft:end_portal'].includes(b.blockId))
		|| !stale('sighted') && o.sighted?.portalFrames?.some(f => f.lit === true)) return null;
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
