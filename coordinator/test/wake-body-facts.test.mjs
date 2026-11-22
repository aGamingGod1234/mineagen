import assert from 'node:assert/strict';
import test from 'node:test';
import { lightLine, upLine, toolsLine, LIGHT_LINE_BYTES, TOOLS_LINE_BYTES, UP_LINE_BYTES } from '../src/wake-body-facts.mjs';
import { howtoHeldRecipe, howtoHoldings } from '../src/howto.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';

const item = (id, damage = 0, maxDamage = 0, slot = 0, count = 1) => ({ itemId: `minecraft:${id}`, count, damage, maxDamage, slot });
const sample = (dayTime = 9_600, items = [item('stone_pickaxe', 119, 131)]) => ({ ready: true, observedAtEpochMs: 1_000,
	player: { dead: false, skyOpen: true }, world: { dimension: 'minecraft:overworld', dayTime }, inventory: { selectedSlot: 0, items } });

test('light is absent by day and gives nominal dusk, night and sunrise timing across day boundaries', () => {
	assert.equal(lightLine(sample(8_399)), null);
	assert.equal(lightLine(sample(8_400)), 'dusk in ~3m (day 1); night lasts ~8m; mobs spawn in darkness; sky-exposed');
	assert.match(lightLine(sample(11_999)), /^dusk in <1m \(day 1\)/);
	assert.match(lightLine(sample(12_000)), /^sunset \(day 1\); night lasts ~8m/);
	assert.match(lightLine(sample(12_999)), /^sunset/);
	assert.match(lightLine(sample(13_000)), /^night \(day 1\); sunrise in ~8m/);
	for (const tick of [13_188, 22_812]) assert.match(lightLine(sample(tick)), /mobs spawn in darkness/);
	assert.match(lightLine(sample(22_999)), /^night .*sunrise in <1m/);
	assert.match(lightLine(sample(23_000)), /^sunrise .*daylight in <1m/);
	assert.match(lightLine(sample(23_999)), /^sunrise/);
	assert.equal(lightLine(sample(24_000)), null);
	assert.match(lightLine(sample(24_000 + 9_600)), /^dusk in ~2m \(day 2\)/);
});

test('light uses only a live Overworld clock and known sky exposure', () => {
	for (const dimension of ['minecraft:the_nether', 'minecraft:the_end', 'custom:overworld']) {
		const o = sample(); o.world.dimension = dimension; assert.equal(lightLine(o), null);
	}
	for (const dayTime of [undefined, NaN, -1, 1.5]) assert.equal(lightLine({ ...sample(), world: { dimension: 'minecraft:overworld', dayTime } }), null);
	const covered = sample(); covered.player.skyOpen = false;
	assert.match(lightLine(covered), /; sky covered$/);
	delete covered.player.skyOpen;
	assert.doesNotMatch(lightLine(covered), /sky/);
	for (const o of [{ ...sample(), ready: false }, { ...sample(), player: { dead: true } }, { ...sample(), continuity: { phase: 'dead' } },
		{ ...sample(), continuity: { rememberedSections: ['world'] } }]) assert.equal(lightLine(o), null);
});

test('wear thresholds use both remaining uses and percent, with missing wear and irrelevant tools omitted', () => {
	assert.equal(toolsLine(sample(1, [item('stone_pickaxe', 104, 131)])), null);
	assert.match(toolsLine(sample(1, [item('stone_pickaxe', 105, 131)])), /^stone_pickaxe 26 uses left/);
	assert.match(toolsLine(sample(1, [item('wooden_shovel', 34, 59)])), /^wooden_shovel 25 uses left/);
	assert.equal(toolsLine(sample(1, [item('wooden_shovel', 33, 59)])), null);
	assert.match(toolsLine(sample(1, [item('iron_axe', 200, 250)])), /^iron_axe 50 uses left/);
	assert.equal(toolsLine(sample(1, [item('iron_axe', 199, 250)])), null);
	assert.match(toolsLine(sample(1, [item('stone_sword', 131, 131)])), /^stone_sword 0 uses left/);
	for (const tool of [item('fishing_rod', 63, 64), item('stone_hoe', 130, 131), item('stone_pickaxe'),
		{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0, maxDamage: 131 }, item('stone_pickaxe', 130, 131, 0, 0)]) {
		assert.equal(toolsLine(sample(1, [tool])), null);
	}
	for (const o of [{ ...sample(), ready: false }, { ...sample(), player: { dead: true } },
		{ ...sample(), continuity: { rememberedSections: ['inventory'] } }]) assert.equal(toolsLine(o), null);
});

test('wear identifies the selected slot, reports spares, and falls back to the best tool for the authored activity', () => {
	const o = sample(1, [item('stone_pickaxe', 119, 131), item('stone_pickaxe', 0, 131, 1), item('wooden_pickaxe', 58, 59, 2)]);
	assert.match(toolsLine(o), /^stone_pickaxe 12 uses left \(2 spare pickaxes held: stone_pickaxe 131 uses/);
	o.inventory.selectedSlot = 1;
	assert.equal(toolsLine(o), null, 'a worn spare does not warn about a healthy selected tool');
	o.inventory.selectedSlot = 8;
	assert.equal(toolsLine(o), null, 'no generic inventory wear warning while empty handed');
	assert.equal(toolsLine(o, { activity: 'mine iron ore' }), null, 'the best same-tier tool is healthy');
	o.inventory.items[1].damage = 120;
	assert.match(toolsLine(o, { activity: 'mine_iron' }), /^stone_pickaxe 12 uses left/);
	o.inventory.items.push(item('iron_pickaxe', 230, 250, 3));
	assert.match(toolsLine(o, { activity: 'mine iron ore' }), /^iron_pickaxe 20 uses left/);
	o.inventory.selectedSlot = 0;
	o.inventory.items.push(item('stone_sword', 120, 131, 4));
	o.currentAction = { active: true, actionType: 'attack' };
	assert.match(toolsLine(o), /^stone_pickaxe 12 uses left/, 'the held tool remains the observed tool during combat');
	o.inventory.selectedSlot = 8;
	assert.match(toolsLine(o), /^stone_sword 11 uses left/);
	delete o.currentAction; delete o.inventory.selectedSlot; o.inventory.selectedItem = 'minecraft:stone_pickaxe';
	assert.match(toolsLine(o), /^stone_pickaxe 12 uses left/);
});

test('replacement facts reuse game recipes and distinguish held ingredients from station access', () => {
	const o = sample();
	assert.match(toolsLine(o), /no spare pickaxe; replacement materials not all held/);
	o.inventory.items.push(item('cobblestone', 0, 0, 1, 3), item('stick', 0, 0, 2, 2));
	assert.equal(toolsLine(o), 'stone_pickaxe 12 uses left (no spare pickaxe; replacement materials held: 3 cobblestone + 2 stick; crafting_table not held/seen)');
	o.inventory.items.push(item('crafting_table', 0, 0, 3));
	assert.match(toolsLine(o), /crafting_table held\/seen/);
	o.inventory.items.pop(); o.blocks = [{ blockId: 'minecraft:crafting_table' }];
	assert.match(toolsLine(o), /crafting_table held\/seen/);
	o.inventory.items[1] = item('cobbled_deepslate', 0, 0, 1, 3);
	assert.match(toolsLine(o), /3 cobbled_deepslate \+ 2 stick/);
	o.inventory.items[1].count = 2;
	assert.match(toolsLine(o), /replacement materials not all held/);
	const wood = sample(1, [item('wooden_pickaxe', 55, 59), item('oak_log', 0, 0, 1, 10)]);
	assert.match(toolsLine(wood), /materials not all held/, 'logs are not already planks and sticks');
	const index = { fuels: {}, tags: { '#material': ['oak_planks', 'birch_planks'] }, recipes: { test: [['inventory', 1, [['#material', 3], ['oak_planks', 2]]]] } };
	const holdings = howtoHoldings({ observation: sample(1, [item('oak_planks', 0, 0, 0, 3)]) });
	assert.equal(howtoHeldRecipe('minecraft:test', holdings, { index }).materialsHeld, false, 'overlapping ingredients cannot reuse held items');
});

test('replacement deficits expose G7 carried quantities without treating stone or stations as wood', () => {
	const rows = [item('wooden_pickaxe', 58, 59), item('stick', 0, 0, 1),
		item('cobblestone', 0, 0, 2, 52), ...Array.from({ length: 6 }, (_, i) => item('cobblestone', 0, 0, i + 3, 64)),
		item('cobbled_deepslate', 0, 0, 9, 134), item('crafting_table', 0, 0, 10), item('furnace', 0, 0, 11),
		item('raw_iron', 0, 0, 12, 2), item('coal', 0, 0, 13, 5), item('dirt', 0, 0, 14, 96)];
	const o = sample(1, rows), before = structuredClone(o);
	assert.equal(toolsLine(o), 'wooden_pickaxe 1 uses left (no spare pickaxe; replacement materials not all held: #wooden_tool_materials 0/3 + stick 1/2)');
	assert.deepEqual(o, before, 'facts do not consume inventory or change the selected tool');
	// A stone replacement has its own direct recipe; the worn wooden tool is not a stage prerequisite.
	o.inventory.items[0] = item('stone_pickaxe', 130, 131);
	assert.equal(toolsLine(o), 'stone_pickaxe 1 uses left (no spare pickaxe; replacement materials not all held: stick 1/2)');
	o.inventory.items[1].count = 2;
	assert.match(toolsLine(o), /replacement materials held: 2 stick \+ 3 cobbled_deepslate; crafting_table held\/seen/);
	o.inventory.items = o.inventory.items.filter(row => row.itemId !== 'minecraft:crafting_table');
	assert.match(toolsLine(o), /replacement materials held: .*crafting_table not held\/seen/);
});

test('replacement deficits preserve recipe alternatives, reservations and the default recipe API', () => {
	const o = sample(1, [item('wooden_pickaxe', 58, 59), item('oak_planks', 0, 0, 1, 2),
		item('birch_planks', 0, 0, 2), item('stick', 0, 0, 3)]);
	assert.match(toolsLine(o), /not all held: stick 1\/2\)$/);
	o.inventory.items[3].count = 0;
	assert.match(toolsLine(o), /stick 0\/2/);
	o.inventory.items[3].count = 2;
	assert.match(toolsLine(o), /materials held: .*planks/);
	const index = { fuels: {}, tags: { '#material': ['oak_planks', 'birch_planks'] },
		recipes: { test: [['inventory', 1, [['#material', 3], ['oak_planks', 2], ['stick', 2]]]] } };
	const holdings = howtoHoldings({ observation: o });
	const baseline = howtoHeldRecipe('test', holdings, { index });
	assert.deepEqual(baseline, { materialsHeld: false, station: 'inventory', stationAvailable: true, inputs: [] });
	assert.deepEqual(howtoHeldRecipe('test', holdings, { index, includeMissing: true }), {
		...baseline, missing: [{ id: 'oak_planks', held: 0, count: 2 }],
	});
	assert.equal(howtoHeldRecipe('unknown', holdings, { index, includeMissing: true }), null);
	assert.equal(howtoHeldRecipe('test', { ...holdings, known: false }, { index, includeMissing: true }), null);
});

test('replacement deficits stay sample-local and suppress stale or absent inventory', async () => {
	const views = new LiveTaskViews(), record = { agentId: 'deficits', currentGoal: 'beat the game', goalRevision: 1 };
	const o = sample(1, [item('stone_pickaxe', 130, 131), item('cobblestone', 0, 0, 1, 436), item('stick', 0, 0, 2)]);
	await views.observe(record, o);
	const supplied = structuredClone(o); supplied.observedAtEpochMs = 2_000; supplied.inventory.items[2].count = 2;
	await views.observe(record, supplied);
	assert.match(views.continuity(record).tools, /materials held/);
	assert.match(views.continuity(record, { observation: o }).tools, /stick 1\/2/);
	for (const variant of [{ ...o, continuity: { rememberedSections: ['inventory'] } }, { ...o, inventory: {} },
		{ ...o, ready: false }, { ...o, player: { dead: true } }]) assert.equal(toolsLine(variant), null);
	assert.ok(Buffer.byteLength(toolsLine(o)) <= TOOLS_LINE_BYTES);
	const longest = sample(1, [item('netherite_pickaxe', 2020, 2031), item('diamond_pickaxe', 1550, 1561, 1)]);
	assert.ok(Buffer.byteLength(toolsLine(longest)) <= TOOLS_LINE_BYTES);
	for (const tier of ['wooden', 'stone', 'copper', 'iron', 'golden', 'diamond', 'netherite']) {
		for (const kind of ['pickaxe', 'axe', 'shovel', 'sword']) {
			const fact = toolsLine(sample(1, [item(`${tier}_${kind}`, 58, 59)]));
			assert.match(fact, /replacement/);
			assert.ok(Buffer.byteLength(fact) <= TOOLS_LINE_BYTES, fact);
		}
	}
});

test('body fact lines stay byte capped, including the longest replacement recipe and large day numbers', () => {
	assert.ok(Buffer.byteLength(lightLine(sample(Number.MAX_SAFE_INTEGER))) <= LIGHT_LINE_BYTES);
	const o = sample(1, [item('netherite_pickaxe', 2020, 2031), item('diamond_pickaxe', 0, 1561, 1),
		item('netherite_upgrade_smithing_template', 0, 0, 2), item('netherite_ingot', 0, 0, 3)]);
	assert.match(toolsLine(o), /replacement materials held/);
	assert.ok(Buffer.byteLength(toolsLine(o)) <= TOOLS_LINE_BYTES);
});

test('continuity keeps each queued sample daylight and wear instead of borrowing the latest inventory or clock', async () => {
	const views = new LiveTaskViews(), record = { agentId: 'test', currentGoal: 'beat the game', goalRevision: 1 };
	const queued = sample();
	await views.observe(record, queued);
	await views.observe(record, { ...sample(24_001, [item('iron_pickaxe', 0, 250)]), observedAtEpochMs: 2_000 });
	assert.equal(views.continuity(record)?.light, undefined);
	assert.equal(views.continuity(record)?.tools, undefined);
	assert.match(views.continuity(record, { observation: queued }).light, /^dusk in ~2m/);
	assert.match(views.continuity(record, { observation: queued }).tools, /^stone_pickaxe 12 uses left/);
	for (let index = 0; index < 9; index++) await views.observe(record, { ...sample(24_001, [item('iron_pickaxe', 0, 250)]), observedAtEpochMs: 3_000 + index });
	assert.match(views.continuity(record, { observation: queued }).light, /^dusk in ~2m/, 'an evicted event still uses its own clock');
	assert.match(views.continuity(record, { observation: queued }).tools, /^stone_pickaxe 12 uses left/, 'an evicted event still uses its own inventory');
});

test('continuity can name the best carried tool for a model-authored intent while another item is selected', async () => {
	const views = new LiveTaskViews(), record = { agentId: 'test', currentGoal: 'beat the game', goalRevision: 1 };
	const o = sample(1, [item('stone_pickaxe', 120, 131), item('iron_pickaxe', 220, 250, 1), item('torch', 0, 0, 2)]);
	o.world.worldId = 'intent-world'; o.inventory.selectedSlot = 2;
	await views.observe(record, o);
	assert.equal(views.continuity(record)?.tools, undefined);
	await views.operate(record, { operation: 'intent', intent: { step: 'mine_iron', why: 'ore for armour' } });
	assert.match(views.continuity(record).tools, /^iron_pickaxe 30 uses left/);
	for (const [activity, kind] of [['chop logs', 'axe'], ['dig dirt', 'shovel'], ['fight zombies', 'sword']]) {
		const o = sample(1, [item(`stone_${kind}`, 120, 131)]); o.inventory.selectedSlot = 8;
		assert.match(toolsLine(o, { activity }), new RegExp(`^stone_${kind} 11 uses left`));
	}
});

test('night bed facts preserve colour, observed availability and unknown monster safety', async () => {
 const { sleepLine } = await import('../src/wake-body-facts.mjs');
 const o = sample(14_000, [item('white_wool',0,0,0,2),item('black_wool',0,0,1,1),item('oak_planks',0,0,2,3)]);
 o.entities=[{type:'minecraft:sheep',alive:true,distance:6}];
 assert.match(sleepLine(o), /wool 2\/3 white_wool, planks 3\/3/);
 assert.match(sleepLine(o), /sheep seen 1 .*~6m/);
 assert.match(sleepLine(o), /sleep time open; monster safety unverified/);
 o.blocks=[{blockId:'minecraft:white_bed',x:1,y:64,z:2,state:{occupied:'true'}}];
 assert.match(sleepLine(o), /bed seen 1,64,2 occupied/);
 const views=new LiveTaskViews(), record={agentId:'bed-facts',currentGoal:'Beat the game',goalRevision:1};
 await views.observe(record,o);
 assert.equal(views.continuity(record).sleep,sleepLine(o));
 o.world.sleep={bedExplodes:false,timeAllowsSleep:false};
 assert.match(sleepLine(o), /sleep time closed/);
 o.continuity={rememberedSections:['inventory','blocks','entities']};
 assert.equal(sleepLine(o), null, 'stale supplies cannot start a bed task');
 o.continuity={rememberedSections:['world']};assert.equal(sleepLine(o),null);
});

test('sleep facts distinguish normal sleep hours, storms, explosive dimensions and dead bodies', async () => {
 const {sleepLine}=await import('../src/wake-body-facts.mjs');
 for(const [tick,expected] of [[12541,'closed'],[12542,'open'],[23459,'open'],[23460,'closed']]) assert.match(sleepLine(sample(tick,[item('red_bed')])),new RegExp(`sleep time ${expected}`));
 assert.equal(sleepLine(sample(6000)),null);
 const o=sample(6000,[item('red_bed')]);o.world.thundering=true;
 assert.match(sleepLine(o),/sleep time open/);
 for(const dimension of ['minecraft:the_nether','minecraft:the_end']) {o.world.dimension=dimension;assert.match(sleepLine(o),/beds explode here/);}
 o.player.dead=true;assert.equal(sleepLine(o),null);
});

test('casting knowledge needs current Nether intent, source lava and available water capability', async () => {
 const { castingLine, CASTING_LINE_BYTES } = await import('../src/wake-body-facts.mjs');
 const o = sample(1000, [item('water_bucket')]);
 o.blocks = [{blockId:'minecraft:lava',state:{level:'0'}}];
 const args = {goal:'Enter the Nether.'};
 const line = castingLine(o,args);
 assert.ok(Buffer.byteLength(line) <= CASTING_LINE_BYTES);
 for (const fact of ['SOURCE', 'from a side or above', 'only below does nothing', 'cobblestone', 'scoops it back', '4 wide x 5 high', '10 obsidian', 'leave the cooling water placed', 'beside the supply pool', 'off the pool']) assert.ok(line.includes(fact));
 assert.equal(castingLine(o,{goal:'Gather wood'}),null);
 for (const level of ['1','8',undefined]) {
  o.blocks[0].state.level=level; assert.equal(castingLine(o,args),null);
 }
 o.blocks[0].state.level='0';
 for (const section of ['blocks','world','inventory']) {
  assert.equal(castingLine({...o,continuity:{rememberedSections:[section]}},args),null);
 }
 assert.equal(castingLine({...o,world:{dimension:'minecraft:the_nether'}},args),null);
 assert.equal(castingLine({...o,ready:false},args),null);
 o.inventory.items.push(item('obsidian')); assert.equal(castingLine(o,args),null); o.inventory.items.pop();
 o.inventory.items=[item('bucket')]; assert.equal(castingLine(o,args),null);
 o.blocks.push({blockId:'minecraft:water',state:{level:'0'}}); assert.equal(castingLine(o,args),line);
 o.inventory.items=[item('iron_ingot',0,0,0,3)]; assert.equal(castingLine(o,args),line);
 o.inventory.items[0].count=2; assert.equal(castingLine(o,args),null);
});

test('casting knowledge reaches the real wake header and preserves older sample gating', async () => {
 const views=new LiveTaskViews(), record={agentId:'caster',currentGoal:'Enter the Nether.',goalRevision:1};
 const o=sample(1000,[item('water_bucket')]); o.blocks=[{blockId:'minecraft:lava',state:{level:'0'}}];
 await views.observe(record,o);
 assert.match(views.continuity(record).casting,/10 obsidian/);
 await views.observe(record,{...o,observedAtEpochMs:2000,blocks:[]});
 assert.equal(views.continuity(record).casting,undefined);
 assert.match(views.continuity(record,{observation:o}).casting,/10 obsidian/);
});

test('frame line reads the seen portal frame back without choosing a build', async () => {
 const { frameLine, FRAME_LINE_BYTES } = await import('../src/wake-body-facts.mjs');
 const o = sample(1000);
 assert.equal(frameLine(o), null);
 o.sighted = { portalFrames: [{ x: 111, y: 64, z: 693, distance: 3, bearing: 5, axis: 'x', interior: [2, 3], obsidian: 8, needed: 10,
  missing: [[113, 64, 693, 'lava source'], [112, 67, 693, 'unseen']], blocked: [[112, 65, 693, 'cobblestone']], unseenInterior: 2, lit: false }] };
 const line = frameLine(o);
 assert.ok(Buffer.byteLength(line) <= FRAME_LINE_BYTES);
 for (const fact of ['interior 2x3 at x111..112 y64..66 z693', 'obsidian 8/10', 'missing 113,64,693 lava source; 112,67,693 unseen', 'interior blocked 112,65,693 cobblestone', '2 interior cells unseen']) assert.ok(line.includes(fact), fact);
 assert.ok(!line.includes('lights it'));
 const done = structuredClone(o); Object.assign(done.sighted.portalFrames[0], { obsidian: 10, missing: [], blocked: [], unseenInterior: undefined, axis: 'z', x: 120, z: 700 });
 assert.match(frameLine(done), /x120 y64\.\.66 z700\.\.701: obsidian 10\/10; complete, interior clear: fire inside lights it$/);
 done.sighted.portalFrames[0].lit = true; assert.match(frameLine(done), /; lit$/);
 assert.equal(frameLine({ ...o, continuity: { rememberedSections: ['sighted'] } }), null);
 assert.equal(frameLine({ ...o, ready: false }), null);
});

test('up names the last open sky and retrace only under cover well below it', () => {
	const under = (y, skyOpen = false, dimension = 'minecraft:overworld') => ({ ready: true, player: { dead: false, skyOpen, x: 380.7, y, z: -258.7 }, world: { dimension } });
	const sky = { x: 331.4, y: 73, z: -268.2, dimension: 'minecraft:overworld' };
	assert.equal(upLine(under(12), sky), 'last open sky @331,73,-269 79m dy+61; travel_to retrace:true there walks your own way back up');
	assert.ok(Buffer.byteLength(upLine(under(12), sky)) <= UP_LINE_BYTES);
	assert.equal(upLine(under(12, true), sky), null, 'under open sky now');
	assert.equal(upLine({ ...under(12), player: { dead: false, x: 380.7, y: 12, z: -258.7 } }, sky), null, 'unknown sky');
	assert.equal(upLine(under(70), sky), null, 'within 3 blocks of the sky spot height');
	assert.equal(upLine(under(12, false, 'minecraft:the_nether'), { ...sky, dimension: 'minecraft:the_nether' }), null, 'Overworld only');
	assert.equal(upLine(under(12), { ...sky, dimension: 'minecraft:the_nether' }), null, 'sky remembered in another dimension');
	assert.equal(upLine(under(12), null), null, 'no sky remembered');
});

test('the live view remembers the last open sky and shows up once under cover', async () => {
	const views = new LiveTaskViews();
	const record = { agentId: 'up-agent', goalRevision: 1, currentGoal: 'Beat the game' };
	const at = (y, skyOpen) => ({ ready: true, observedAtEpochMs: 1_000, player: { dead: false, skyOpen, onGround: true, x: 10.5, y, z: 4.5 }, world: { dimension: 'minecraft:overworld', dayTime: 1_000, worldId: 'w' }, inventory: { selectedSlot: 0, items: [] } });
	await views.observe(record, at(70, true));
	await views.observe(record, at(20, false));
	assert.equal(views.continuity(record).up, 'last open sky @10,70,4 50m dy+50; travel_to retrace:true there walks your own way back up');
	await views.observe(record, at(68, true));
	assert.equal(views.continuity(record)?.up, undefined, 'under open sky again');
});

test('a queued underground sample keeps its own last open sky, not a later one', async () => {
	const views = new LiveTaskViews();
	const record = { agentId: 'up-queue', goalRevision: 1, currentGoal: 'Beat the game' };
	const at = (x, y, skyOpen, ms) => ({ ready: true, observedAtEpochMs: ms, player: { dead: false, skyOpen, onGround: true, x, y, z: 0 }, world: { dimension: 'minecraft:overworld', dayTime: 1_000, worldId: 'w' }, inventory: { selectedSlot: 0, items: [] } });
	await views.observe(record, at(0, 70, true, 1_000));
	const queued = at(0, 20, false, 2_000);
	await views.observe(record, queued);
	await views.observe(record, at(100, 80, true, 3_000));
	await views.observe(record, at(100, 30, false, 4_000));
	assert.match(views.continuity(record, { observation: queued }).up, /^last open sky @0,70,0 /);
	assert.match(views.continuity(record).up, /^last open sky @100,80,0 /);
});
