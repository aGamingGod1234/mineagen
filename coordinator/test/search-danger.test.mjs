import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDanger, searchHoldsSteer } from '../src/search-danger.mjs';
import { searchFor } from '../src/find-search.mjs';

const zombie = (extra = {}) => ({ uuid: 'z1', stableId: 'z1', type: 'minecraft:zombie', distance: 5, targeting: true, lineOfSight: true, signals: ['targeting'], ...extra });
const view = (threats, { health = 20, items = ['minecraft:iron_pickaxe'], lastAttacker = undefined, hurtBy = undefined, inLava = undefined, entities = [] } = {}) => ({
	player: { x: 0.5, y: -40, z: 0.5, yaw: 0, health, skyOpen: false, threats, ...(lastAttacker ? { lastAttacker } : {}), ...(hurtBy ? { hurtBy } : {}), ...(inLava ? { inLava } : {}) },
	world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains' }, inventory: { items: items.map((itemId) => ({ itemId, count: 1 })) }, entities,
});

test('gate run 3 flinches: one zombie it can beat is fought; a mob behind rock or not after the body is passed by', () => {
	assert.equal(searchDanger(view([zombie()])).handle, 'fight', 'one zombie in sight, full health, iron pickaxe');
	assert.equal(searchDanger(view([zombie({ distance: 12, lineOfSight: false })])).handle, 'ignore', 'gate3-1 10.4 min: a zombie 12 blocks down through rock');
	assert.equal(searchDanger(view([zombie({ distance: 12, lineOfSight: false }), zombie({ uuid: 'z2', distance: 13, lineOfSight: false })])).handle, 'ignore', 'two zombies behind rock are behind a wall');
	assert.equal(searchDanger(view([{ uuid: 's', type: 'minecraft:skeleton', distance: 10, targeting: true, lineOfSight: false, signals: ['targeting'] }])).handle, 'ignore', 'a skeleton behind a wall');
	assert.equal(searchDanger(view([{ uuid: 'sp', type: 'minecraft:spider', distance: 7, targeting: false, lineOfSight: true, signals: [] }])).handle, 'ignore', 'a spider not hunting');
	assert.equal(searchDanger(view([])), null, 'no threat rows: nothing for the rule to judge');
	assert.equal(searchDanger({ player: { health: 20 } }), null, 'a sample with no threats section keeps the old path');
});

test('gate run 3 forks go back with their reason: low health, a creeper, several mobs, a ranged mob in sight, a mob it cannot beat', () => {
	assert.match(searchDanger(view([zombie()], { health: 7 })).fork, /^health 7/);
	assert.match(searchDanger(view([{ uuid: 'c', type: 'minecraft:creeper', distance: 3, targeting: true, lineOfSight: true, signals: ['creeper_close'] }])).fork, /creeper 3 blocks/);
	assert.match(searchDanger(view([zombie(), { uuid: 's', type: 'minecraft:skeleton', distance: 6, targeting: true, lineOfSight: true, signals: ['ranged_aiming'] }])).fork, /2 hostiles after it/);
	assert.match(searchDanger(view([{ uuid: 's', type: 'minecraft:skeleton', distance: 12, targeting: true, lineOfSight: true, signals: ['ranged_aiming'] }])).fork, /skeleton 12 blocks away with a line of sight/);
	assert.match(searchDanger(view([zombie()], { health: 9, items: ['minecraft:stone_pickaxe'] })).fork, /3 of its hits would end a fight at 8 with it alive/, 'three zombie hits of 3');
	// The search's fight bails at 8 (fleeAtHealth): it starts only three hits above that line, armed or not.
	assert.match(searchDanger(view([zombie()], { health: 11, items: ['minecraft:stone_pickaxe'] })).fork, /health 11: 3 of its hits/, 'gate3-5 11 min: one hit takes it to 8 and the fight bails with the zombie alive');
	assert.match(searchDanger(view([zombie()], { health: 16, items: ['minecraft:stone_pickaxe'] })).fork, /health 16/);
	assert.equal(searchDanger(view([zombie()], { health: 17, items: ['minecraft:stone_pickaxe'] })).handle, 'fight', 'a zombie\'s first hit from full health: three more hits before the line');
	assert.match(searchDanger(view([zombie({ expectedHitDamage: 4.5 })], { health: 20 })).fork, /3 of its hits/, 'a hard-difficulty hit counts as the server gives it');
	assert.equal(searchDanger(view([zombie({ expectedHitDamage: 2 })], { health: 14 })).handle, 'fight', 'an easy-difficulty or armoured hit');
	assert.match(searchDanger(view([zombie()], { items: [] })).fork, /nothing to fight it with/);
	assert.match(searchDanger(view([{ uuid: 'e', type: 'minecraft:enderman', distance: 4, targeting: true, lineOfSight: true, signals: ['targeting'] }])).fork, /not one to fight alone/);
	assert.match(searchDanger(view([zombie()], { health: 12, items: ['minecraft:stone_sword'] })).fork, /health 12/, 'armed, the same line');
	assert.equal(searchDanger(view([zombie()], { health: 18, items: ['minecraft:stone_sword'] })).handle, 'fight');
});

test('a running search holds the steer for what it handles; a hit from any other source still steers', () => {
	assert.match(searchHoldsSteer({ trigger: 'threat' }, view([zombie()])), /one zombie/);
	const zombieHit = { lastAttacker: { uuid: 'z1', type: 'minecraft:zombie' }, hurtBy: 'mob_attack by minecraft:zombie', health: 17 };
	assert.match(searchHoldsSteer({ trigger: 'damage' }, view([zombie()], zombieHit)), /one zombie/);
	assert.match(searchHoldsSteer({ trigger: 'damage' }, view([zombie()], { ...zombieHit, hurtBy: 'mob_attack' })), /one zombie/, 'the attacker out of view names no type');
	assert.equal(searchHoldsSteer({ trigger: 'damage' }, view([zombie()])), null, 'a hit with no attacker (a fall) steers');
	assert.equal(searchHoldsSteer({ trigger: 'damage' }, view([zombie()], { lastAttacker: { uuid: 'other', type: 'minecraft:skeleton' }, hurtBy: 'mob_attack by minecraft:skeleton' })), null);
	// lastAttacker stays the zombie 5 s after its hit; the damage now is lava, a fall or a wall, which the fight does not answer.
	assert.equal(searchHoldsSteer({ trigger: 'damage' }, view([zombie()], { ...zombieHit, hurtBy: 'lava', inLava: true })), null, 'knocked into lava within 5 s of the zombie\'s hit');
	assert.equal(searchHoldsSteer({ trigger: 'damage' }, view([zombie()], { ...zombieHit, hurtBy: 'mob_attack by minecraft:zombie', inLava: true })), null, 'the zombie\'s hit with the body in lava');
	assert.equal(searchHoldsSteer({ trigger: 'damage' }, view([zombie()], { ...zombieHit, hurtBy: 'fall' })), null);
	assert.equal(searchHoldsSteer({ trigger: 'damage' }, view([zombie()], { ...zombieHit, hurtBy: 'in_wall' })), null);
	assert.equal(searchHoldsSteer({ trigger: 'damage' }, view([zombie()], { ...zombieHit, hurtBy: 'mob_attack by minecraft:spider' })), null, 'a hit from another mob');
	assert.equal(searchHoldsSteer({ trigger: 'threat' }, view([zombie()], { health: 6 })), null, 'low health steers');
	assert.equal(searchHoldsSteer({ trigger: 'drowning' }, view([zombie()])), null, 'only hits and threat edges');
	assert.equal(searchHoldsSteer({ trigger: 'threat' }, view([{ uuid: 'c', type: 'minecraft:creeper', distance: 5, targeting: true, lineOfSight: true, signals: [] }])), null);
});

/** A scripted body (find-search.test.mjs's): each act answers from the script by action type. */
function fakeBody({ start, acts = {}, looks = [] }) {
	let observation = structuredClone(start), clock = 0;
	const calls = [];
	return {
		calls,
		now: () => clock,
		progress: () => {},
		observe: async () => structuredClone(observation),
		look: async ({ pitch, survey }) => { calls.push({ look: pitch, include: survey.include }); clock += 2_000; return looks.shift() ?? { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => {
			calls.push({ actionType, args });
			const script = acts[actionType]?.shift() ?? { result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } };
			clock += script.ms ?? 30_000;
			if (script.then) observation = { ...observation, ...script.then(observation) };
			return script.result;
		},
		frontier: () => ({ candidates: [], coverage: { headings: {} } }),
		known: () => null,
		places: async () => [],
	};
}
const lavaSeen = { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 8,-54,3, 9 blocks away' } };
const stopFor = (who) => ({ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: `Stopped: minecraft:${who}` } });
const atDepth = (threats, extra) => ({ ...view(threats, extra), player: { ...view(threats, extra).player, y: -54 } });

test('fixture zombie in a tunnel: find lava meets the zombie coming at it before the first look, then digs on', async () => {
	const killed = { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_KILLED' }, then: () => ({ entities: [], player: { ...atDepth([]).player } }) };
	const body = fakeBody({ start: atDepth([zombie({ distance: 3 })], { entities: [{ stableId: 'z1', type: 'minecraft:zombie', hostile: true, x: 3.5, y: -54, z: 0.5 }] }),
		acts: { dig_to: [lavaSeen], fight_target: [killed] } });
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.equal(body.calls[0].actionType, 'fight_target', 'fought before the look turns its back (the live fixture lost 9 health to it during the look)');
	assert.deepEqual([body.calls[0].args.targetId, body.calls[0].args.pursue, body.calls[0].args.timeoutMs], ['z1', false, 30_000]);
	assert.equal(body.calls.some((call) => call.actionType === 'build_shelter'), false);
	// One that comes during the dig stops it and is fought there.
	const later = fakeBody({ start: atDepth([]), acts: {
		dig_to: [{ ...stopFor('zombie z1 at 3,-54,0, 3.0 blocks away'), then: () => ({ player: { ...atDepth([zombie({ distance: 3 })]).player }, entities: [{ stableId: 'z1', type: 'minecraft:zombie', hostile: true, x: 3.5, y: -54, z: 0.5 }] }) }, lavaSeen],
		fight_target: [killed] } });
	assert.equal((await searchFor({ block: 'minecraft:lava' }, later)).reasonCode, 'FIND_SEEN');
	assert.equal(later.calls.filter((call) => call.actionType === 'fight_target').length, 1);
});

test('a zombie after the body but not in reach: the body stands for it, and one that never comes is passed by', async () => {
	const body = fakeBody({ start: atDepth([zombie({ distance: 10 })], { entities: [{ stableId: 'z1', type: 'minecraft:zombie', hostile: true, x: 10.5, y: -54, z: 0.5 }] }),
		acts: { dig_to: [stopFor('zombie z1 at 10,-54,0, 10.0 blocks away'), lavaSeen], fight_target: [{ result: { state: 'TIMED_OUT', reasonCode: 'FIGHT_TIMED_OUT' } }] } });
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const fight = body.calls.find((call) => call.actionType === 'fight_target').args;
	assert.equal(fight.pursue, false);
	assert.equal(fight.timeoutMs, 20_000);
});

test('fixture skeleton behind a wall and spider not hunting: the dig goes on, no wall, no fight, no hand-back', async () => {
	for (const mob of [{ uuid: 's', type: 'minecraft:skeleton', distance: 9, targeting: true, lineOfSight: false, signals: ['targeting'] },
		{ uuid: 'sp', type: 'minecraft:spider', distance: 6, targeting: false, lineOfSight: true, signals: [] }]) {
		const body = fakeBody({ start: atDepth([mob], { items: ['minecraft:iron_pickaxe', 'minecraft:cobblestone'] }), acts: { dig_to: [stopFor(`${mob.type} ${mob.uuid}`), lavaSeen] } });
		const result = await searchFor({ block: 'minecraft:lava' }, body);
		assert.equal(result.reasonCode, 'FIND_SEEN', `${mob.type}: ${result.message}`);
		assert.equal(body.calls.some((call) => ['build_shelter', 'fight_target', 'travel_to'].includes(call.actionType)), false, mob.type);
	}
});

test('a mob passed by that keeps stopping digs where the body stands ends in a move off the spot, not a loop', async () => {
	const skeleton = { uuid: 's', type: 'minecraft:skeleton', distance: 9, targeting: true, lineOfSight: false, signals: ['targeting'] };
	const body = fakeBody({ start: atDepth([skeleton], { items: ['minecraft:iron_pickaxe'] }), acts: { dig_to: Array.from({ length: 6 }, () => stopFor('skeleton s')) } });
	await searchFor({ block: 'minecraft:lava' }, body, { timeoutMs: 600_000 });
	assert.ok(body.calls.filter((call) => call.actionType === 'dig_to').length <= 6);
	assert.ok(body.calls.some((call) => call.actionType === 'travel_to'), 'digs going nowhere move the body off the spot');
});

test('a fork hands back at once with its reason, walled in underground', async () => {
	const creeper = { uuid: 'c', type: 'minecraft:creeper', distance: 4, targeting: true, lineOfSight: true, signals: ['creeper_close'] };
	const start = atDepth([creeper]);
	start.inventory.items = [{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:cobblestone', count: 32 }];
	const walled = fakeBody({ start, acts: { dig_to: [stopFor('creeper c')], build_shelter: [{ result: { state: 'SUCCEEDED', reasonCode: 'SHELTER_BUILT' } }] } });
	const result = await searchFor({ block: 'minecraft:lava' }, walled);
	assert.equal(result.reasonCode, 'FIND_DANGER');
	// A creeper is never built beside (its blast breaks the wall): the fork goes back with the stop's own words.
	assert.match(result.message, /^Stopped for danger: a creeper 4 blocks away \(HOSTILE_NEAR: Stopped: minecraft:creeper c\)/);
	assert.equal(walled.calls.some((call) => call.actionType === 'fight_target' || call.actionType === 'build_shelter'), false);
	const pair = atDepth([zombie({ distance: 3 }), zombie({ uuid: 'z2', stableId: 'z2', distance: 4 })]);
	pair.inventory.items = start.inventory.items;
	const two = fakeBody({ start: pair, acts: { dig_to: [stopFor('zombie z1')], build_shelter: [{ result: { state: 'SUCCEEDED', reasonCode: 'SHELTER_BUILT' } }] } });
	assert.match((await searchFor({ block: 'minecraft:lava' }, two)).message, /^Stopped for danger: 2 hostiles after it .*; walled in where it stands/);
});

test('a zombie\'s hit on the dig is answered by fighting it; a fall is still handed back', async () => {
	const hit = { result: { state: 'FAILED', reasonCode: 'DAMAGE_TAKEN', message: 'Took 3 damage (mob); health 17' } };
	const body = fakeBody({ start: atDepth([zombie({ distance: 1.5 })], { health: 17, lastAttacker: { uuid: 'z1', type: 'minecraft:zombie' }, entities: [{ stableId: 'z1', type: 'minecraft:zombie', hostile: true, x: 1.5, y: -54, z: 0.5 }] }),
		acts: { dig_to: [hit, lavaSeen], fight_target: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_KILLED' } }] } });
	assert.equal((await searchFor({ block: 'minecraft:lava' }, body)).reasonCode, 'FIND_SEEN');
	const gone = fakeBody({ start: atDepth([], { health: 14 }), acts: { dig_to: [hit, lavaSeen] } });
	assert.equal((await searchFor({ block: 'minecraft:lava' }, gone)).reasonCode, 'FIND_SEEN', 'the zombie that hit it is dead (a reflex killed it): search on');
	const fall = fakeBody({ start: atDepth([zombie({ distance: 1.5 })], { health: 17 }), acts: { dig_to: [{ result: { state: 'FAILED', reasonCode: 'DAMAGE_TAKEN', message: 'Took 3 damage (fall); health 17' } }] } });
	assert.equal((await searchFor({ block: 'minecraft:lava' }, fall)).reasonCode, 'FIND_DANGER');
});

test('a fight that leaves the mob alive hands the fork back walled in, never looks round or digs on with its back to it', async () => {
	const coming = { entities: [{ stableId: 'z1', type: 'minecraft:zombie', hostile: true, x: 3.5, y: -54, z: 0.5 }] };
	const kit = (start) => { start.inventory.items = [{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:cobblestone', count: 32 }]; return start; };
	const shelter = { result: { state: 'SUCCEEDED', reasonCode: 'SHELTER_BUILT' } };
	// Bailed at fleeAtHealth with the zombie hitting: health 8 with it 2 blocks off is the model's fork.
	const bailed = { result: { state: 'FAILED', reasonCode: 'LOW_HEALTH_BAILOUT', message: 'Health 8.0 reached fleeAtHealth 8.0' },
		then: (now) => ({ player: { ...now.player, health: 8, threats: [zombie({ distance: 2 })] } }) };
	const body = fakeBody({ start: kit(atDepth([zombie({ distance: 3 })], coming)), acts: { fight_target: [bailed], build_shelter: [shelter], dig_to: [lavaSeen] } });
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_DANGER', result.message);
	assert.match(result.message, /^Stopped for danger: health 8 with a zombie 2 blocks away \(fight LOW_HEALTH_BAILOUT\); walled in where it stands/);
	assert.deepEqual(body.calls.map((call) => call.actionType ?? 'look'), ['fight_target', 'build_shelter']);
	// Out of time with the zombie in reach and alive: the same.
	const timed = fakeBody({ start: kit(atDepth([zombie({ distance: 3 })], coming)), acts: { fight_target: [{ result: { state: 'TIMED_OUT', reasonCode: 'FIGHT_TIMED_OUT' } }], build_shelter: [shelter], dig_to: [lavaSeen] } });
	const out = await searchFor({ block: 'minecraft:lava' }, timed);
	assert.equal(out.reasonCode, 'FIND_DANGER', out.message);
	assert.match(out.message, /^Stopped for danger: health 20 with a zombie it fought and did not kill \(fight FIGHT_TIMED_OUT\)/);
	assert.equal(timed.calls.some((call) => call.look !== undefined || call.actionType === 'dig_to'), false);
	// The same fight met on a dig's stop for the zombie's hit.
	const hit = { result: { state: 'FAILED', reasonCode: 'DAMAGE_TAKEN', message: 'Took 3 damage (mob); health 17' },
		then: (now) => ({ player: { ...now.player, health: 17, threats: [zombie({ distance: 1.5 })], lastAttacker: { uuid: 'z1', type: 'minecraft:zombie' } }, ...coming }) };
	const dug = fakeBody({ start: kit(atDepth([])), acts: { dig_to: [hit, lavaSeen], fight_target: [bailed], build_shelter: [shelter] } });
	assert.match((await searchFor({ block: 'minecraft:lava' }, dug)).message, /^Stopped for danger: health 8 with a zombie/);
	assert.equal(dug.calls.filter((call) => call.actionType === 'dig_to').length, 1);
});
