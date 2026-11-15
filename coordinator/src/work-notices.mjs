// Short player facts from the current sample. No searches, target selection or body actions.
const short = id => String(id).replace(/^minecraft:/, '');
const xyz = p => ['x', 'y', 'z'].map(k => Math.round(p[k] * 10) / 10).join(',');
const positioned = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]));
const at = o => o?.position ?? o?.player?.position ?? o?.player;
const eye = o => ({ ...at(o), y: at(o).y + (o.player?.crouching === true || o.player?.pose === 'crouching' ? 1.27
 : ['swimming', 'fall_flying', 'spin_attack'].includes(o.player?.pose) ? .4 : o.player?.pose === 'sleeping' ? .2 : 1.62) });
const distance = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
const fresh = (o, section) => o?.ready !== false && o?.freshness?.fresh !== false
 && !o?.continuity?.rememberedSections?.includes(section);
const rows = (o, section) => fresh(o, section) && Array.isArray(o?.[section]) ? o[section].filter(r => r?.visible !== false && r?.remembered !== true) : [];
const gather = /^(break_block|dig_to|pick_up_item|craft_inventory|craft_table)$/;
const resource = /^minecraft:(hay_block|[a-z_]+_log|[a-z_]+_stem|[a-z_]+_ore|ancient_debris|sugar_cane)$/;
const solid = /^minecraft:(cobblestone|cobbled_deepslate|stone|deepslate|dirt|netherrack|andesite|diorite|granite|tuff|blackstone)$/;
const FOOD = /^minecraft:(bread|apple|golden_apple|golden_carrot|carrot|baked_potato|potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|(cooked_)?(beef|porkchop|mutton|chicken|cod|salmon|rabbit)|[a-z_]+_stew|beetroot_soup)$/;
const valuable = /^minecraft:(?:deepslate_)?(diamond|iron|gold|redstone|lapis|emerald)_ore$|^minecraft:(ancient_debris|nether_gold_ore)$/;

function inventory(o) { return fresh(o, 'inventory') ? o.inventory?.items ?? [] : []; }

// Vanilla ore tiers, used only to explain visible vanilla ores; unknown/custom tools stay unknown.
export function oreToolFact(id, items) {
 const tier = id === 'minecraft:ancient_debris' ? 3 : /diamond|gold|redstone|emerald/.test(id) && id !== 'minecraft:nether_gold_ore' ? 2 : /iron|lapis/.test(id) ? 1 : 0;
 const required = ['wood+ pickaxe', 'stone+ pickaxe', 'iron+ pickaxe', 'diamond+ pickaxe'][tier];
 const tiers = { wooden: 0, golden: 0, stone: 1, copper: 1, iron: 2, diamond: 3, netherite: 4 };
 const tools = items.filter(i => i.count > 0 && (i.usesLeft === undefined || i.usesLeft > 0))
  .filter(i => (tiers[i.itemId?.match(/^minecraft:(\w+)_pickaxe$/)?.[1]] ?? -1) >= tier);
 return `${required}; ${tools.length ? `carried ${[...new Set(tools.map(t => short(t.itemId)))].join('/')}` : 'no suitable vanilla pickaxe shown'}`;
}

export function workNotices(o, receipt = o?.lastResult) {
 if (!o || o.player?.dead === true || o.continuity?.phase === 'dead' || !positioned(at(o))) return [];
 const p = at(o), notices = [], items = inventory(o);
 const own = (o.leftBehind ?? []).filter(r => positioned(r) && r.available !== false
  && (!r.dimension || r.dimension === o.world?.dimension)
  && ['minecraft:crafting_table', 'minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker'].includes(r.blockId))
  .filter(r => !items.some(i => i.itemId === r.blockId && i.count > 0)).slice(0, 2);
 if (own.length) {
  // the recorded Terra game walked back 46-155 blocks to a surface table/furnace four times and never carried one; the
  // cheaper player move is often a new one here, so the materials it holds for that are named beside the old one.
  const held = (test) => items.filter(i => test(String(i.itemId ?? ''))).reduce((sum, i) => sum + (i.count ?? 0), 0);
  const planks = held(id => /_planks$/.test(id)), stone = held(id => ['minecraft:cobblestone', 'minecraft:cobbled_deepslate', 'minecraft:blackstone'].includes(id));
  const fresh = [own.some(r => r.blockId === 'minecraft:crafting_table') && planks >= 4 ? `crafting_table from 4 planks (you hold ${planks})` : null,
   own.some(r => r.blockId === 'minecraft:furnace') && stone >= 8 ? `furnace from 8 cobblestone (you hold ${stone})` : null].filter(Boolean);
  notices.push(`Your placed ${own.map(r => `${short(r.blockId)} @${xyz(r)} (${Math.round(distance(p, r))} blocks away)`).join('; ')}; remembered, not checked now. Can mine and carry; furnaces need a pickaxe, contents drop too${fresh.length ? `; or craft a new one here: ${fresh.join(', ')}` : ''}.`);
 }
 // the recorded Oct 29 game: back at the top for a table, Sol dug a second staircase beside its own 40-level one.
 const stairs = (Array.isArray(o.ownStairs) ? o.ownStairs : []).filter(positioned).slice(0, 1);
 if (stairs.length && (!receipt || receipt.actionType !== 'dig_to' || receipt.state !== 'RUNNING'))
  notices.push(`Your staircase from here goes down ${stairs[0].levels} levels to ${xyz(stairs[0])}; travel_to ${xyz(stairs[0])} with retrace:true walks it down.`);
 // Going down the first levels of its own staircase from the surface: what it carries for the work down there. Shown
 // only when a table or food is missing; The policy requires surface work done first and one trip underground (Oct 29).
 const down = o.descent, kind0 = receipt?.actionType;
 if (down && down.levels >= 4 && down.levels <= 40 && kind0 === 'dig_to') {
  const count = (test) => items.filter(i => test(String(i.itemId ?? ''))).reduce((sum, i) => sum + (i.count ?? 0), 0);
  const tables = count(id => id === 'minecraft:crafting_table'), planks = count(id => /_planks$/.test(id)) + 4 * count(id => /_(log|stem|wood|hyphae)$/.test(id));
  const sticks = count(id => id === 'minecraft:stick'), food = count(id => FOOD.test(id)), furnaces = count(id => id === 'minecraft:furnace');
  if ((tables === 0 && planks < 4) || food === 0)
   notices.push(`${down.levels} levels below your staircase top (y${down.topY}), carrying: crafting_table ${tables}, planks ${planks} (logs counted as 4), sticks ${sticks}, food ${food}, furnace ${furnaces}. A pickaxe crafted down here needs a table (4 planks) and 2 sticks; climbing back for them takes about as long as the dig.`);
 }
 const stations = rows(o, 'blocks').filter(r => positioned(r) && ['minecraft:crafting_table', 'minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker'].includes(r.blockId)
  && distance(eye(o), { x: r.x + .5, y: r.y + .5, z: r.z + .5 }) <= 4.5
  && !items.some(i => i.itemId === r.blockId && i.count > 0)).slice(0, 2);
 if (!own.length && stations.length) notices.push(`Workstations in reach: ${stations.map(r => `${short(r.blockId)} @${xyz(r)}`).join('; ')}. Can mine and carry to the work site; furnaces need a pickaxe, contents drop too.`);
 const craftedTool = ['craft_inventory', 'craft_table'].includes(receipt?.actionType) && receipt?.state === 'SUCCEEDED'
  ? String(receipt.message ?? '').match(/Crafted \d+ minecraft:((?:wooden|golden|stone|copper|iron|diamond|netherite)_(?:pickaxe|axe|shovel|hoe|sword))\b/)?.[1] : null;
 if (craftedTool) {
  const [material, kind] = craftedTool.split('_');
  const rank = { wooden: 0, golden: 0, stone: 1, copper: 1, iron: 2, diamond: 3, netherite: 4 };
  const better = items.filter(i => i.count > 0 && (i.usesLeft === undefined || i.usesLeft > 0))
   .map(i => i.itemId?.match(new RegExp(`^minecraft:(\\w+)_${kind}$`)))
   .filter(m => m && rank[m[1]] > rank[material]).sort((a,b) => rank[b[1]] - rank[a[1]])[0];
  if (better) notices.push(`Crafted ${craftedTool}; already carrying higher-tier ${short(better[0])}.`);
 }
 const idle = o.currentAction?.active !== true;
 const kind = receipt?.actionType;
 if (idle && gather.test(kind ?? '')) {
  const ground = rows(o, 'items').filter(r => positioned(r) && r.count > 0 && typeof r.itemId === 'string' && distance(p, r) <= 8)
   .sort((a, b) => distance(p, a) - distance(p, b)).slice(0, 3);
  if (ground.length) notices.push(`On ground, not picked up: ${ground.map(r => `${short(r.itemId)} x${r.count} @${xyz(r)} (${Math.round(distance(p, r) * 10) / 10} blocks)`).join('; ')}.`);
  const broken = receipt?.actionObservation?.target?.beforeId;
  const crafted = String(receipt?.message ?? '').match(/Crafted \d+ minecraft:([\w]+)/)?.[1];
  const ids = new Set(resource.test(broken ?? '') ? [broken] : []);
  if (!ids.size && kind === 'break_block') for (const b of rows(o, 'blocks')) { if (resource.test(b.blockId)) ids.add(b.blockId); if (ids.size === 2) break; }
  if (['bread', 'wheat'].includes(crafted) || kind === 'pick_up_item' && items.some(i => ['minecraft:hay_block', 'minecraft:wheat'].includes(i.itemId) && i.count > 0)) ids.add('minecraft:hay_block');
  const blocks = rows(o, 'blocks').filter(b => ids.has(b.blockId) && positioned(b) && distance(eye(o), { x: b.x + .5, y: b.y + .5, z: b.z + .5 }) <= 4.5);
  for (const id of [...ids].slice(0, 2)) {
   const same = blocks.filter(b => b.blockId === id);
   if (same.length) notices.push(`More ${short(id)}: ${same.length} seen within mining reach (4.5 blocks), e.g. @${xyz(same[0])}; click line must be clear.`);
  }
 }
 if (idle && kind === 'dig_to' && ['WATER_AHEAD', 'LAVA_AHEAD'].includes(receipt?.reasonCode)) {
  const fluid = receipt.reasonCode === 'WATER_AHEAD' ? 'water' : 'lava';
  const cell = String(receipt.message ?? receipt.failure?.blockedBy ?? '').match(new RegExp(`${fluid}(?: seen)?(?: at)? (-?\\d+),(-?\\d+),(-?\\d+)`, 'i'));
  const seenFluid = rows(o, 'blocks').filter(b => b.blockId === `minecraft:${fluid}` && positioned(b)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  const where = cell ? cell.slice(1).join(',') : seenFluid ? xyz(seenFluid) : null;
  const held = items.filter(i => i.count > 0 && solid.test(i.itemId)).slice(0, 2).map(i => `${short(i.itemId)} x${i.count}`).join(', ');
  notices.push(`Dig stopped at ${fluid}${where ? ` @${where}` : ''}. Options: place_block a solid block in the visible fluid cell if in reach and supported (${held ? `held: ${held}` : 'no solid filler shown'}; may need more than one); or dig_to with another heading from here. Other headings are unverified.`);
 }
 // Keep ore facts separate from the bulk mined-stone tally, even when a different action just completed.
 const ores = rows(o, 'blocks').filter(b => valuable.test(b.blockId) && positioned(b));
 const groups = [...new Set(ores.map(b => b.blockId))].map(id => {
  const same = ores.filter(b => b.blockId === id).sort((a, b) => distance(p, a) - distance(p, b));
  return { id, same, near: same[0] };
 }).sort((a, b) => distance(p, a.near) - distance(p, b.near)).slice(0, 3);
 if (groups.length) notices.push(`Ores in view: ${groups.map(({ id, same, near }) => `${short(id)} x${same.length}, nearest @${xyz(near)} ${Math.round(distance(p, near) * 10) / 10} blocks; ${oreToolFact(id, items)}`).join(' | ')}.`);
 return notices;
}
