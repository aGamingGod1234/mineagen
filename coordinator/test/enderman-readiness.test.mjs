import test from 'node:test';
import assert from 'node:assert/strict';
import { endermanReadyCost, pearlHuntLine, pearlOptions } from '../src/need-sources.mjs';
import { presentLeanWake } from '../src/lean-input.mjs';

// Authored states shaped like the moments pearls were open in full games: what the model reads after the lean clip.
const position = { x: 0, y: 64, z: 0 };
const open = 'has:minecraft:ender_pearl|minecraft:ender_eye*12';
const night = (items, player = { health: 20, armor: 0 }, entities = []) => ({
	world: { dimension: 'minecraft:overworld', dayTime: 15000, biome: 'minecraft:plains' }, entities, inventory: { items }, player,
});
const lean = (options) => presentLeanWake({ now: { options } }).now.options;
const shown = (observation) => lean(pearlOptions({ observation, position, known: { sightings: [] }, items: observation.inventory.items }));

test('at night with a stone sword, no armour and no gold, the gear gap and its price lead and survive the clip', () => {
	const kit = [{ itemId: 'minecraft:stone_sword', count: 1 }, { itemId: 'minecraft:raw_iron', count: 1 }, { itemId: 'minecraft:cobblestone', count: 40 }];
	const text = shown(night(kit));
	assert.match(text, /est\. options: enderman fight: not geared \(stone weapon with 0 armour\); ready = iron sword: 2 iron ingots \+ 1 stick \(held: 0 ingots, 1 raw iron to smelt\)/);
	assert.doesNotMatch(text.split('ready =')[0], /barter/, 'no barter sums ahead of the gap when no gold is held or seen');
});

test('geared at night, the fight, stare and collect facts survive the clip with no gap', () => {
	const text = shown(night([{ itemId: 'minecraft:iron_sword', count: 1 }]));
	assert.match(text, /est\. options: enderman fight: 40 health, hits ~7 .*; a stare at its eyes provokes one; collect its pearl/);
	assert.doesNotMatch(text, /not geared/);
});

test('low health keeps the stand-down and names eating as what readies the body', () => {
	const observation = night([{ itemId: 'minecraft:iron_sword', count: 1 }], { health: 8, armor: 0 },
		[{ type: 'minecraft:enderman', distance: 9, y: 64, alive: true }]);
	assert.equal(pearlHuntLine({ observation, position, open }),
		'enderman 9 m, level, calm; pearls 0/12 open; not geared for it (health 8): it hits for 7 and has 40 health, so leave a calm one calm and do not look at it until you are; ready = eat to 14+ health');
});

test('two held ingots and sticks read as an iron sword to craft now', () => {
	const items = [{ itemId: 'minecraft:stone_sword', count: 1 }, { itemId: 'minecraft:iron_ingot', count: 2 }, { itemId: 'minecraft:stick', count: 3 }];
	assert.equal(endermanReadyCost({ player: { health: 20, armor: 0 } }, items), 'iron sword: 2 iron ingots + 1 stick (held: 2 ingots; craft it now)');
	assert.equal(endermanReadyCost({ player: { health: 20, armor: 0 } }, [{ itemId: 'minecraft:diamond_sword', count: 1 }]), '');
});

test('in the Nether with gold and calm piglins, the order is unchanged: forest route, then the held-gold barter', () => {
	const items = [{ itemId: 'minecraft:gold_ingot', count: 20 }];
	const observation = { world: { dimension: 'minecraft:the_nether' }, entities: [{ type: 'minecraft:piglin', distance: 5, alive: true }], inventory: { items }, player: { health: 20, armor: 2 } };
	assert.match(shown(observation), /est\. options: primary Nether pearl route: find a warped forest .*; barter the 20 held gold: ~1\.3 pearls expected/);
});
