import test from 'node:test';
import assert from 'node:assert/strict';
import { LEAN_INPUT_ENV, leanInputEnabled, presentLeanObservation, presentLeanWake, withoutWorldId } from '../src/lean-input.mjs';
import { ModelObservationViews, decodeModelFacts, encodeNativeEventInput, withoutDuplicatePlayerThreat } from '../src/model-fact-encoding.mjs';
import { combatFacts } from '../src/combat-facts.mjs';

const withEnv = async (value, run) => {
	const previous = process.env[LEAN_INPUT_ENV];
	if (value === undefined) delete process.env[LEAN_INPUT_ENV]; else process.env[LEAN_INPUT_ENV] = value;
	try { return await run(); } finally { if (previous === undefined) delete process.env[LEAN_INPUT_ENV]; else process.env[LEAN_INPUT_ENV] = previous; }
};

const threat = { uuid: 'b-1', type: 'minecraft:blaze', distance: 4.9, bearing: 7.1, targeting: true, swelling: false, lineOfSight: true, visible: null, meleeCandidate: false, perception: 'unknown', signals: ['ranged_sight'], risk: 33.8 };
const observation = () => ({
	world: { worldId: 'w-1', dimension: 'minecraft:the_nether' },
	threats: [threat],
	health: '18/20', foodLevel: 14, onFire: false, inLava: false,
	player: { x: 15.188, y: 58.232, z: -4.489, yaw: -90.337, pitch: 20.1, dead: false, swimming: false, gameMode: 'survival', effects: [], heard: [1, 2, 3, 4, 5].map(n => ({ sound: `s${n}` })), threat: { stableId: 'b-1', ...threat } },
	inventory: { items: [{ itemId: 'minecraft:diamond_sword', count: 1, slot: 'mainhand', maxDamage: 1561, usesLeft: 1561, maxStackSize: 1, tags: ['minecraft:swords'] },
		{ itemId: 'minecraft:shield', count: 1, slot: 'offhand', maxDamage: 336, usesLeft: 40 },
		{ itemId: 'minecraft:potion', count: 1, slot: 3, displayName: 'Potion of Fire Resistance' }, { itemId: 'minecraft:cooked_beef', count: 16, slot: 2, displayName: 'Cooked Beef' }],
		selectedItem: 'minecraft:diamond_sword', tagCounts: 'note', fingerprints: 'note' },
	entities: [{ stableId: 'b-1', type: 'minecraft:blaze', x: 20.0574, y: 58, z: -3.91, distance: 4.9, bounds: [1, 2, 3, 4, 5, 6], velocity: { x: 0, y: -0.078, z: 0 }, hostile: true },
		...Array.from({ length: 9 }, (_, n) => ({ stableId: `p-${n}`, type: 'minecraft:zombified_piglin', x: 30 + n, y: 60, z: 0, distance: 15 + n, hostile: false, bounds: [0, 0, 0, 1, 1, 1] }))],
	blocks: [{ x: 15, y: 57, z: -6, blockId: 'minecraft:basalt' }, { x: 15, y: 57, z: -7, blockId: 'minecraft:magma_block', replaceable: false, placeableFaces: [] }, { x: 14, y: 58, z: -8, blockId: 'minecraft:lava' }],
	landmarks: [{ x: 1, y: 1, z: 1, distance: 6, blockId: 'minecraft:nether_bricks', elevation: 3 }, { x: 2, y: 2, z: 2, distance: 9, blockId: 'minecraft:lava', elevation: 1 }],
	itemTags: { 'minecraft:diamond_sword': ['minecraft:swords'] }, blockTags: { 'minecraft:basalt': ['x'] }, coverage: { complete: false }, snapshotCounts: { blocks: 3 },
	perception: { events: [{ type: 'system_message', text: 'advancement' }], bossBars: [] },
	interaction: { mainHandItemId: 'minecraft:diamond_sword', offHandItemId: 'minecraft:air', attackCooldown: 1, input: { forward: 1 }, menu: { type: 'minecraft:inventory', slots: [] }, rayTarget: { type: 'miss' } },
	currentAction: { active: true, actionId: 'a-1', actionType: 'navigate_to' }, lastResult: { state: 'FAILED', reasonCode: 'ACTION_TIMEOUT' },
});

test('lean input is off unless ARENA_LEAN_INPUT is set to a true value', () => {
	assert.equal(leanInputEnabled({}), false);
	assert.equal(leanInputEnabled({ [LEAN_INPUT_ENV]: '0' }), false);
	for (const value of ['1', 'true', 'ON', ' yes ']) assert.equal(leanInputEnabled({ [LEAN_INPUT_ENV]: value }), true);
});

test('lean observation keeps decision facts and drops tables, far rows and duplicates', () => {
	const lean = presentLeanObservation(observation());
	assert.deepEqual(lean.lastResult, { state: 'FAILED', reasonCode: 'ACTION_TIMEOUT' });
	assert.equal(lean.currentAction.actionId, 'a-1');
	assert.equal(lean.health, '18/20');
	assert.deepEqual(lean.threats, [{ uuid: 'b-1', type: 'minecraft:blaze', distance: 4.9, bearing: 7.1, targeting: true, lineOfSight: true, signals: ['ranged_sight'], risk: 33.8 }]);
	for (const key of ['itemTags', 'blockTags', 'coverage', 'snapshotCounts', 'perception']) assert.equal(Object.hasOwn(lean, key), false, key);
	assert.equal(lean.player.threat, undefined, 'player.threat repeats the threats row with its uuid');
	assert.equal(lean.player.x, 15.2);
	assert.equal(lean.player.heard.length, 2);
	assert.equal(Object.hasOwn(lean.player, 'swimming'), false);
	// Worn uses and potion names stay; a fresh tool's maximum and a plain title-case name do not.
	assert.deepEqual(lean.inventory.items, [{ itemId: 'minecraft:diamond_sword', count: 1, slot: 'mainhand' }, { itemId: 'minecraft:shield', count: 1, slot: 'offhand', usesLeft: 40 },
		{ itemId: 'minecraft:potion', count: 1, slot: 3, displayName: 'Potion of Fire Resistance' }, { itemId: 'minecraft:cooked_beef', count: 16, slot: 2 }]);
	// The threat's entity row keeps only identity and position; six nearest rows, the rest counted.
	assert.deepEqual(lean.entities[0], { stableId: 'b-1', type: 'minecraft:blaze', x: 20.1, y: 58, z: -3.9 });
	assert.equal(lean.entities.length, 6);
	assert.equal(lean.entitiesOmitted, 4);
	// Terrain is counted; hazards stay as rows.
	assert.deepEqual(lean.blocks.map(row => row.blockId), ['minecraft:magma_block', 'minecraft:lava']);
	assert.deepEqual(lean.blocks[0], { x: 15, y: 57, z: -7, blockId: 'minecraft:magma_block' });
	assert.deepEqual(lean.terrainCounts, { 'minecraft:basalt': 1 });
	// Nether bricks mark a fortress, so they stay a landmark.
	assert.deepEqual(lean.landmarks, [{ x: 1, y: 1, z: 1, distance: 6, blockId: 'minecraft:nether_bricks' }, { x: 2, y: 2, z: 2, distance: 9, blockId: 'minecraft:lava' }]);
	assert.deepEqual(lean.interaction, { rayTarget: { type: 'miss' } });
	assert.match(lean.lean, /observe for all/);
});

test('lean keeps an unlisted player.threat, a carried cursor stack and container menus', () => {
	const value = observation();
	value.player.threat = { uuid: 'other', type: 'minecraft:ghast' };
	value.interaction.menu = { type: 'minecraft:inventory', cursor: { itemId: 'minecraft:stick', count: 2 } };
	const lean = presentLeanObservation(value);
	assert.deepEqual(lean.player.threat, { uuid: 'other', type: 'minecraft:ghast' });
	assert.deepEqual(lean.interaction.menu.cursor, { itemId: 'minecraft:stick', count: 2 });
	value.interaction.menu = { type: 'minecraft:furnace', slots: [] };
	assert.equal(presentLeanObservation(value).interaction.menu.type, 'minecraft:furnace');
});

test('lean blocks keep hazards first when rows exceed the cap', () => {
	const value = observation();
	value.blocks = [...Array.from({ length: 30 }, (_, n) => ({ x: n, y: 58, z: 0, blockId: 'minecraft:iron_ore' })), { x: 40, y: 58, z: 0, blockId: 'minecraft:lava' }];
	const lean = presentLeanObservation(value);
	assert.equal(lean.blocks.length, 14);
	assert.ok(lean.blocks.some(row => row.blockId === 'minecraft:lava'));
	assert.equal(lean.blocksOmitted, 17);
});

test('lean wake trims option and known text by segment and keeps goal lines and receipts tail', () => {
	const wake = presentLeanWake({
		event: 'observation', goalNow: 'blaze_rod 1/6', skillFits: 'fight_target fits', danger: '1 targeting you',
		now: { plan: 'p', options: `${'a'.repeat(400)} | route ${'b'.repeat(300)} | now: 0 gold; fortress seen 12m E`, known: `caves: ${Array.from({ length: 9 }, (_, n) => `cave ${n} far away`).join(', ')}; places: nether fortress 12m E; lava: lava 4m N` },
		program: { result: { receipts: [1, 2, 3, 4, 5].map(n => ({ state: n === 2 ? 'FAILED' : 'COMPLETED', n })) } },
		taskMemory: { progress: [], places: [{ name: 'portal' }], totals: { entries: 1 } },
		observation: observation(),
	});
	assert.equal(wake.goalNow, 'blaze_rod 1/6');
	assert.equal(wake.skillFits, 'fight_target fits');
	assert.equal(wake.danger, '1 targeting you');
	assert.match(wake.now.options, /\(trimmed\) \| now: 0 gold; fortress seen 12m E$/);
	assert.doesNotMatch(wake.now.options, /route/);
	assert.match(wake.now.known, /; places: nether fortress 12m E; lava: lava 4m N$/);
	assert.deepEqual(wake.program.result.receipts.map(row => row.n), [2, 4, 5]);
	assert.equal(wake.program.result.omittedReceipts, 2);
	assert.deepEqual(wake.taskMemory, { places: [{ name: 'portal' }], totals: { entries: 1 } });
});

test('withoutWorldId strips only the world UUID from presented sections', () => {
	const presented = withoutWorldId({ observation: { world: { worldId: 'w', dimension: 'd' } }, observationView: { replace: { world: { worldId: 'w', dimension: 'd' } } } });
	assert.deepEqual(presented, { observation: { world: { dimension: 'd' } }, observationView: { replace: { world: { dimension: 'd' } } } });
});

test('lean dedupe names player.threat only when it repeats a threats row exactly', () => {
	const value = observation();
	assert.deepEqual(withoutDuplicatePlayerThreat(value).player.threat, { uuid: 'b-1', sameAs: 'threats row with this uuid' });
	value.player.threat = { ...value.player.threat, distance: 9 };
	assert.equal(withoutDuplicatePlayerThreat(value), value);
});

const wakeInput = () => `Instruction line\n${JSON.stringify({ event: 'observation', trigger: 'threat', goalNow: 'blaze_rod 0/6', observation: observation(), goal: 'g' })}`;
const decode = text => decodeModelFacts(JSON.parse(text.slice(text.indexOf('\n') + 1)));

test('encodeNativeEventInput applies lean only when the switch is on', async () => {
	const full = await withEnv(undefined, () => decode(encodeNativeEventInput(wakeInput(), new ModelObservationViews())));
	assert.ok(full.observation.itemTags);
	assert.equal(full.observation.world.worldId, 'w-1');
	assert.equal(full.observation.lean, undefined);
	const lean = await withEnv('1', () => decode(encodeNativeEventInput(wakeInput(), new ModelObservationViews())));
	assert.equal(lean.goalNow, 'blaze_rod 0/6');
	assert.equal(lean.observation.itemTags, undefined);
	assert.deepEqual(lean.observation.world, { dimension: 'minecraft:the_nether' });
	assert.match(lean.observation.lean, /observe for all/);
	const fullBytes = Buffer.byteLength(JSON.stringify(full)), leanBytes = Buffer.byteLength(JSON.stringify(lean));
	assert.ok(leanBytes < fullBytes * 0.7, `${leanBytes} vs ${fullBytes}`);
});

test('lean action replies trim the fresh sample; explicit observe stays full', async () => {
	await withEnv('1', () => {
		const views = new ModelObservationViews();
		const sample = { freshness: { fresh: true }, observation: { ...observation(), ready: true } };
		const action = views.prepare({ state: 'COMPLETED', postAction: structuredClone(sample) }, { kind: 'action' });
		assert.equal(action.value.postAction.observation.itemTags, undefined);
		assert.match(action.value.postAction.observation.lean, /observe/);
		const observe = new ModelObservationViews().prepare(structuredClone(sample), { kind: 'observe' });
		assert.ok(observe.value.observation.itemTags);
		assert.equal(observe.value.observation.lean, undefined);
	});
});

test('lean combat facts keep the live facts and shorten the static mechanics', () => {
	const obs = { ready: true, world: { dimension: 'minecraft:the_nether' }, player: { threats: [] },
		entities: [{ type: 'minecraft:blaze' }, { type: 'minecraft:wither_skeleton' }, { type: 'minecraft:zombified_piglin' }],
		inventory: { items: [{ itemId: 'minecraft:diamond_sword', count: 1, slot: 'mainhand' }] } };
	const full = combatFacts(obs), lean = combatFacts(obs, { lean: true });
	assert.ok(lean.length < full.length * 0.5, `${lean.length} vs ${full.length}`);
	for (const fact of ['Gold armor not worn', 'Blazes: 20 health', 'kills one in 3 hits', 'Wither skeletons', 'zombified piglin']) assert.ok(lean.includes(fact), fact);
	// The arguments the model passes stay: use_ranged draw and aim, shield vs bow, pursue default, drop UUIDs.
	for (const fact of ['use_ranged with targetId, drawDurationMs:1000 and no aim fields', 'shield and bow cannot be used together', 'fight_target pursues by default',
		'pursue:false only once a blaze is in reach', 'drop UUIDs for pick_up_item']) assert.ok(lean.includes(fact), fact);
});

test('lean blocks keep placeable terrain beside the feet and count the rest', () => {
	const lean = presentLeanObservation({ player: { x: 10.5, y: 64, z: 10.5 }, blocks: [
		{ x: 10, y: 63, z: 10, blockId: 'minecraft:netherrack', placeableFaces: ['up'] },
		{ x: 10, y: 63, z: 20, blockId: 'minecraft:netherrack', placeableFaces: ['up'] },
		{ x: 11, y: 64, z: 10, blockId: 'minecraft:basalt' },
		{ x: 12, y: 64, z: 10, blockId: 'minecraft:nether_bricks' }] });
	assert.deepEqual(lean.blocks.map(row => `${row.blockId}@${row.z}`), ['minecraft:netherrack@10', 'minecraft:nether_bricks@10']);
	assert.deepEqual(lean.terrainCounts, { 'minecraft:netherrack': 1, 'minecraft:basalt': 1 });
	assert.match(lean.lean, /terrainCounts and \*Omitted count rows left out/);
});

test('lean options keep the fortress search grid, bastion-seen and unseen region segments whole (nether-fortress-search)', () => {
	const options = `(step nether) blaze_rod: 6 more needed, est. options: none seen | Nether route, your choice: bastion first = barter ${'r'.repeat(300)}`
		+ ` | option golden helmet: 5 gold ingots, 2 armour like iron | Fortress search, your choice: fortresses and bastions share one grid of 432-block regions ${'g'.repeat(300)}`
		+ ' | bastion seen, so no fortress in: x 0..431 z 0..431 (@120,80) | regions with nothing seen yet, nearest unseen start ground on average first: E x 432..863 z 0..431: nearest unseen start ground @432,40 300 blocks ~1.2 min walking, 100% unseen';
	const lean = presentLeanWake({ now: { options } }).now.options;
	assert.match(lean, /Fortress search, your choice: .*g{300}/);
	assert.match(lean, /\| bastion seen, so no fortress in: x 0\.\.431 z 0\.\.431 \(@120,80\)/);
	assert.match(lean, /nearest unseen start ground @432,40 300 blocks ~1\.2 min walking, 100% unseen$/);
	assert.doesNotMatch(lean, /Nether route|option golden helmet:/);
});

test('lean options keep every need segment and drop long nested asides (enderman-pearl-hunt-05 regression)', () => {
	const options = `(step nether) blaze_rod: seen none remembered; ways (typical): only from blazes at fortress spawners and in fortress pieces, ${'x'.repeat(120)}`
		+ ' | ender_pearl: 12 more needed (pearls and eyes held 0/12: 0 pearls; 0 gold; eyes: 1 per empty End portal frame of 12 (a frame starts filled 10% of the time), 1 in 5 breaks), est. options: 1 enderman in view: 0-1 pearl per kill (~0.5 each)'
		+ ' | Nether route, your choice: bastion first = barter gold | now: 0 gold ingots';
	const lean = presentLeanWake({ now: { options } }).now.options;
	assert.match(lean, /\| ender_pearl: 12 more needed, est\. options: 1 enderman in view: 0-1 pearl per kill \(~0\.5 each\)/);
	assert.match(lean, /\| now: 0 gold ingots$/);
	assert.doesNotMatch(lean, /Nether route|pearls and eyes held/);
});
