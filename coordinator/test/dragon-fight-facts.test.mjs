import test from 'node:test';
import assert from 'node:assert/strict';
import { combatFacts } from '../src/combat-facts.mjs';
import { buildNativeEventInput, classifyObservationTrigger } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';
import { CAGED_CRYSTAL_FACTS, END_HIGH_FEET_Y, HIGH_DESCENT_FACTS, dragonPerchEdge, dragonPerchLine, endCrystalFact, noteCombatDispatch, rememberEndCrystals, settleCombatResult } from '../src/dragon-fight-facts.mjs';

const HEAD = '00000000-0000-0000-0000-0000000000a1';
const dragon = (motion, extra = {}) => ({ stableId: 'dragon', type: 'minecraft:ender_dragon', alive: true, perceivedBy: 'sight', x: 0.5, y: 67.8, z: 0.4, distance: 9.6, appearance: { motion }, ...extra });
const head = { stableId: HEAD, type: 'minecraft:ender_dragon', parentId: 'dragon', partName: 'head', perceivedBy: 'sight', x: 2.2, y: 68.4, z: -3.1, distance: 7.2 };
const end = (entities) => ({ ready: true, observedAtEpochMs: 0, player: { health: 20, maxHealth: 20, foodLevel: 20 }, world: { dimension: 'minecraft:the_end' }, inventory: { items: [] }, entities });

test('a fountain landing is one urgent wake with the head and the vanilla perch rules', () => {
	const state = {};
	assert.equal(dragonPerchEdge(state, end([dragon('flying')]), 1_000), null);
	const perch = dragonPerchEdge(state, end([dragon('perched'), head]), 2_000);
	assert.deepEqual(perch, { distance: 9.6, head: { id: HEAD, x: 2.2, y: 68.4, z: -3.1, distance: 7.2 } });
	// Rows that drop out of view, or more perched samples, belong to the same landing.
	assert.equal(dragonPerchEdge(state, end([]), 3_000), null);
	assert.equal(dragonPerchEdge(state, end([dragon('perched')]), 6_000), null);
	assert.equal(dragonPerchEdge(state, end([dragon('ascending')]), 9_000), null);
	assert.notEqual(dragonPerchEdge(state, end([dragon('perched')]), 40_000), null);
	assert.equal(dragonPerchEdge({}, end([dragon('perched', { perceivedBy: 'sound' })]), 0), null);

	assert.deepEqual(classifyObservationTrigger({ attention: false, changedFacts: [] }, end([dragon('perched'), head]), { dragonPerch: perch }),
		{ attention: true, priority: 'urgent', trigger: 'dragon_perched' });
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['player.health'] }, end([]), { dragonPerch: perch }).trigger, 'damage');

	const record = { currentGoal: 'Defeat the Ender Dragon', goalRevision: 1 };
	const o = { ...end([dragon('perched'), head]), dragonPerch: perch };
	const lead = buildNativeEventInput(record, { event: 'observation', observation: o, trigger: 'dragon_perched', priority: 'urgent' }).split('\n')[0];
	assert.match(lead, /dragon landed on the exit fountain, 9\.6 blocks away\. Head 0{8}-0{4}-0{4}-0{4}-0{10}a1 at 2\.2,68\.4,-3\.1, 7\.2 blocks from you\./);
	assert.match(lead, /arrows bounce off.*head takes full melee damage.*within 20 blocks \(10 up or down\)/);
	const decision = buildNativeEventInput(record, { event: 'observation', observation: end([dragon('flying')]), status: { decision: { priority: 'urgent', trigger: 'dragon_perched' } } }).split('\n')[0];
	assert.match(decision, /landed on the exit fountain and is not seen perched now\..*Answer program decisions\.$/);
});

test('the perch wake states the breath geometry and the kill arithmetic for the carried weapon', () => {
	const items = [{ itemId: 'minecraft:stone_sword', count: 1, slot: 'hotbar.1' }, { itemId: 'minecraft:iron_sword', count: 1, slot: 'mainhand' }, { itemId: 'minecraft:diamond_axe', count: 1, slot: 'hotbar.2' }];
	const o = { ...end([dragon('perched', { health: 166 }), head]), inventory: { items } };
	const line = dragonPerchLine(o);
	assert.match(line, /cloud of radius 5 centred 2\.5 blocks beyond its head for about 10 s/);
	assert.match(line, /its wings throw anyone within about 6 blocks of either wing \(its sides and back.*Straight out in front of its head is clear of the wings; its breath lands there\./);
	assert.match(line, /50 damage in one perch makes it take off/);
	// fight_target swings a sword before an axe: the best sword, not the axe's 9.
	assert.match(line, /Dragon health 166 of 200\. Your iron sword hits the head for 6 \(a dragon part takes no criticals\): about 28 hits, at most 50 damage a perch, so at least 4 perches\./);
	assert.match(dragonPerchLine({ ...end([dragon('perched', { health: 40 }), head]), inventory: { items: [] } }), /Dragon health 40 of 200\. No sword or axe carried: a bare hand hits the head for 1\./);
});

test('the ordinary flying-dragon wake gives the fountain and timing facts before a short perch', () => {
	const o = end([dragon('flying')]);
	const facts = combatFacts(o);
	assert.match(facts, /waiting on open ground 10-15 blocks from the fountain/);
	assert.match(facts, /empty perch lasts only about 5 seconds, often less than a reply/);
	assert.match(facts, /iron sword recharges in 0\.625 seconds/);
	assert.match(facts, /visible cloud lasts about 10 seconds/);
	assert.match(facts, /gaze guard must outrank movement reflexes/);
	assert.match(facts, /open mouth shows anger, not its target/);
	const input = buildNativeEventInput({ currentGoal: 'Defeat the Ender Dragon', goalRevision: 1 },
		{ event: 'observation', observation: o, trigger: 'observation' });
	assert.match(input, /bedrock exit fountain/);
});

test('End crystals seen stay remembered, and a crystal broken by your own shot is counted broken', () => {
	const state = {};
	const crystal = (id, x, y, z, caged = false) => ({ stableId: id, type: 'minecraft:end_crystal', perceivedBy: 'sight', x, y, z, ...(caged ? { appearance: { caged: true } } : {}) });
	assert.equal(rememberEndCrystals(state, { ...end([crystal('c1', 0, 90, 0)]), world: { dimension: 'minecraft:overworld' } }), null);
	rememberEndCrystals(state, end([crystal('north', -11.5, 83, -39.5, true), crystal('west', -41.5, 80, -0.5, true)]));
	noteCombatDispatch(state, 'shot-1', 'use_ranged', { targetId: 'north' });
	noteCombatDispatch(state, 'shot-2', 'use_ranged', { targetId: 'west' });
	settleCombatResult(state, { actionId: 'shot-1', state: 'SUCCEEDED', message: 'Arrow loosed (aim point -12.9,87.9,-39.0); it struck the target, which broke or died' });
	settleCombatResult(state, { actionId: 'shot-2', state: 'SUCCEEDED', message: 'Arrow loosed; missed: stuck in minecraft:iron_bars at -40,80,0' });
	const tally = rememberEndCrystals(state, end([]));
	assert.deepEqual(tally, { standing: [{ x: -42, y: 80, z: -1, caged: true }], broken: 1 });
	assert.match(endCrystalFact(tally), /^End crystals you have seen: 1 standing when last seen \(-42,80,-1 caged \(beside it feet y=80\)\), 1 broken by your own hits\. The 10 obsidian pillars/);
	// Caged: the cage, why ground arrows fail, the vanilla way through, where to stand relative to the player, and the blast.
	const fact = endCrystalFact(tally, { y: 62 });
	assert.match(fact, /-42,80,-1 caged \(beside it feet y=80, 18 above you\)/);
	assert.match(fact, /Side walls stop arrows/);
	assert.match(fact, /side bars of crystal y and y\+1, and LEAVE THE LOWEST ROW \(crystal y-1\) STANDING/);
	assert.match(fact, /blast deals about 56 at 3 blocks/);
	assert.doesNotMatch(endCrystalFact({ standing: [{ x: 1, y: 90, z: 1 }], broken: 0 }), /Caged/);
	const facts = combatFacts({ ...end([]), endCrystals: tally });
	assert.match(facts, /End crystals you have seen: 1 standing/);
	assert.equal(combatFacts({ ...end([]), world: { dimension: 'minecraft:overworld' }, endCrystals: tally }), null);
});

test('A caged crystal remembers the gaps last seen in its cage', () => {
	const state = {};
	const seen = (appearance) => end([{ stableId: 'west', type: 'minecraft:end_crystal', perceivedBy: 'sight', x: -41.5, y: 80, z: -0.5, appearance }]);
	rememberEndCrystals(state, seen({ caged: true }));
	let tally = rememberEndCrystals(state, seen({ caged: true, cageOpen: ['-40,80,-1', '-40,81,-1'] }));
	assert.deepEqual(tally.standing, [{ x: -42, y: 80, z: -1, caged: true, open: ['-40,80,-1', '-40,81,-1'] }]);
	assert.match(endCrystalFact(tally, { y: 61.5 }), /-42,80,-1 caged \(beside it feet y=80, 19 above you; open bars -40,80,-1 -40,81,-1\)/);
	tally = rememberEndCrystals(state, end([]));
	assert.deepEqual(tally.standing[0].open, ['-40,80,-1', '-40,81,-1']);
});

test('cage descent offers the existing continuous shaft with its one-column preconditions', () => {
 assert.ok(CAGED_CRYSTAL_FACTS.split(/\s+/).length <= 500);
 assert.match(CAGED_CRYSTAL_FACTS, /whole end_stone column.*dragon block clearing spares it/);
 assert.doesNotMatch(CAGED_CRYSTAL_FACTS, /\bobsidian\b/);
 assert.match(CAGED_CRYSTAL_FACTS, /LEAVE THE LOWEST ROW \(crystal y-1\) STANDING: once the descent drops you one block it is the only wall between your feet and the pillar top/);
 assert.match(CAGED_CRYSTAL_FACTS, /avoid separate break-and-wait turns.*confirm a water_bucket in hotbar or offhand.*feet centred/);
 assert.match(CAGED_CRYSTAL_FACTS, /act dig_to.*pattern:"shaft", y:BASE_Y, maxShaftY:BASE_Y, throughCaves:true/);
 assert.match(CAGED_CRYSTAL_FACTS, /inventory slots 9-35 do not count.*select_tool.*sourceSlot.*hotbarSlot.*expectedItemId:"minecraft:water_bucket", minRemainingDurability:0.*fresh inventory.*Until confirmed, do not start/);
 assert.match(CAGED_CRYSTAL_FACTS, /ground FEET y, not a support-block y/);
 assert.match(CAGED_CRYSTAL_FACTS, /never use it to dig into unknown island ground/);
 assert.match(CAGED_CRYSTAL_FACTS, /Without a water bucket in hotbar\/offhand.*two-column.*do not use this method/);
 assert.match(CAGED_CRYSTAL_FACTS, /INFERRED.*not fresh sight.*UNKNOWN/);
 assert.match(CAGED_CRYSTAL_FACTS, /failure, damage, displacement or a reflex interruption.*inspect/);
 assert.match(CAGED_CRYSTAL_FACTS, /verify fresh onGround at the recorded base.*island floor intact/);
 assert.match(CAGED_CRYSTAL_FACTS, /Only once grounded.*blast separation/);
});

test('production encoded wakes deliver the whole cage procedure without changing runtime observations', () => {
	const record = { currentGoal: 'Defeat the Ender Dragon', goalRevision: 1 };
	const observation = { ...end([dragon('flying')]), world: { dimension: 'minecraft:the_end', worldId: 'cage-procedure-test' }, player: { ...end([]).player, x: 13.5, y: 64, z: 9.5, onGround: true },
		inventory: { items: [{ itemId: 'minecraft:end_stone', count: 16 }, { itemId: 'minecraft:cobblestone', count: 125 },
			{ itemId: 'minecraft:water_bucket', count: 1, slot: 'inventory.9' }, { itemId: 'minecraft:iron_pickaxe', count: 1, slot: 'hotbar.0' }] },
		endCrystals: { standing: [{ x: 20, y: 86, z: 12, caged: true }, { x: -20, y: 83, z: -12, caged: true }], broken: 8 } };
	const before = structuredClone(observation);
	const views = new ModelObservationViews();
	const render = (o, sequence, newContext = false) => decodeModelFacts(JSON.parse(encodeNativeEventInput(
		buildNativeEventInput(record, { event: 'observation', trigger: 'observation', observation: o, eventSequence: sequence, newContext }), views).split('\n')[1]));
	const first = render(observation, 1, true);
	assert.ok(first.combat.includes(CAGED_CRYSTAL_FACTS));
	assert.match(first.combat, /INFERRED.*UNKNOWN/);
	assert.match(first.combat, /inventory slots 9-35 do not count.*Until confirmed, do not start/);
	for (const slot of ['hotbar.7', 'offhand', 'inventory.9']) {
		const placed = structuredClone(observation); placed.inventory.items[2].slot = slot;
		const beforePlaced = structuredClone(placed); const delivered = render(placed, 10, true);
		assert.ok(delivered.combat.includes(CAGED_CRYSTAL_FACTS), slot);
		assert.deepEqual(placed, beforePlaced);
	}
	assert.equal(Object.hasOwn(observation, 'terrain'), false, 'cue does not invent hidden support evidence');
	assert.equal(first.combat.split(CAGED_CRYSTAL_FACTS).length - 1, 1);
	const repeated = render(observation, 2);
	assert.equal(Object.hasOwn(repeated, 'combat'), false);
	assert.ok(repeated.sameAsPreviousEvent.includes('combat'));
	const changed = structuredClone(observation);
	changed.player.y = 85;
	changed.endCrystals.standing[0].open = ['22,85,12', '22,86,12'];
	const changedBefore = structuredClone(changed);
	const next = render(changed, 3);
	assert.ok(next.combat.includes(CAGED_CRYSTAL_FACTS));
	assert.match(next.combat, /open bars 22,85,12 22,86,12/);
	assert.deepEqual(observation, before);
	assert.deepEqual(changed, changedBefore);
	for (const dimension of ['minecraft:overworld', 'minecraft:the_nether']) {
		const away = { ...observation, world: { dimension }, entities: [] };
		const saved = structuredClone(away);
		const payload = render(away, 4);
		assert.doesNotMatch(payload.combat ?? '', /CAGE ACCESS|DESCENT|End crystals/);
		assert.deepEqual(away, saved);
	}
});

test('the End crystal fact gives the column descent only while the feet are high above the island', () => {
	const tally = { standing: [{ x: 1, y: 90, z: 1 }], broken: 2 };
	assert.ok(endCrystalFact(tally, { y: END_HIGH_FEET_Y + 30 }).endsWith(HIGH_DESCENT_FACTS));
	assert.ok(!endCrystalFact(tally, { y: 63 }).includes(HIGH_DESCENT_FACTS));
	assert.ok(!endCrystalFact(tally).includes(HIGH_DESCENT_FACTS));
	assert.ok(!endCrystalFact(tally, { y: END_HIGH_FEET_Y + 30 }, { MINEAGEN_END_HIGH_DESCENT: 'off' }).includes(HIGH_DESCENT_FACTS), 'the off switch drops the advice');
	assert.match(HIGH_DESCENT_FACTS, /"pattern":"shaft","y":G,"maxShaftY":G/);
	assert.match(HIGH_DESCENT_FACTS, /Never pour the water bucket on your own column top/);
});
