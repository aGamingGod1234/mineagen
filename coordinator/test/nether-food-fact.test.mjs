import test from 'node:test';
import assert from 'node:assert/strict';
import { netherFoodFact } from '../src/need-sources.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';

// A measured full game: beside a fortress at 1-5 health, hunger 15-17, no food held, for 13 min. Its lit Nether portal
// was remembered about 500 blocks away but no wake named it; the body died there to a blaze.
const items = [['stone_pickaxe'], ['shield'], ['netherrack', 64], ['stone_sword']].map(([id, count = 1]) => ({ itemId: `minecraft:${id}`, count }));
const nether = (player, inventory = items) => ({ ready: true, player: { dead: false, x: -426.4, y: 48, z: -239.5, health: 5, foodLevel: 17, ...player },
	world: { dimension: 'minecraft:the_nether' }, inventory: { items: inventory } });
const frame = (dimension, x, y, z, lit = true) => ({ dimension, x, y, z, axis: 'z', obsidian: 10, needed: 10, lit });
const frames = [frame('minecraft:overworld', 103, -55, 168), frame('minecraft:the_nether', 0, 81, 28), frame('minecraft:the_nether', -300, 70, -200, false)];

test('no food held in the Nether while health cannot regrow: names the remembered lit portal out', () => {
	const fact = netherFoodFact({ observation: nether(), frames });
	assert.equal(fact, 'none held; hunger 17/20 cannot regrow health (needs 18+), so damage taken here stays. Nether food: hoglins (crimson forests, hit hard), or the Overworld\'s animals through the lit portal remembered 503m SE dy+33 @0,81,28');
	// The nearest lit Nether portal; Overworld frames and unlit frames are not a way out.
	const near = netherFoodFact({ observation: nether(), frames: [...frames, frame('minecraft:the_nether', -400, 60, -230)] });
	assert.match(near, /lit portal remembered 28m E dy\+12 @-400,60,-230$/);
	assert.match(netherFoodFact({ observation: nether(), frames: frames.slice(0, 1) }), /through a portal \(no lit portal remembered in the Nether\)$/);
	// Hungry at full health is still a body that will not heal.
	assert.match(netherFoodFact({ observation: nether({ health: 20, foodLevel: 12 }), frames }), /^none held; hunger 12\/20/);
});

test('the Nether food fact stays out while food is held, health can regrow, or the body is elsewhere', () => {
	assert.equal(netherFoodFact({ observation: nether({}, [...items, { itemId: 'minecraft:cooked_porkchop', count: 1 }]), frames }), null, 'food held');
	assert.equal(netherFoodFact({ observation: nether({}, [...items, { itemId: 'minecraft:beef', count: 2 }]), frames }), null, 'raw meat held');
	assert.notEqual(netherFoodFact({ observation: nether({}, [...items, { itemId: 'minecraft:wheat', count: 9 }]), frames }), null, 'wheat is not eaten');
	assert.equal(netherFoodFact({ observation: nether({ foodLevel: 18 }), frames }), null, 'hunger 18 regrows health');
	assert.equal(netherFoodFact({ observation: nether({ health: 20, foodLevel: 16 }), frames }), null, 'healthy and fed enough');
	assert.equal(netherFoodFact({ observation: { ...nether(), world: { dimension: 'minecraft:overworld' } }, frames }), null, 'overworld');
	assert.equal(netherFoodFact({ observation: { ...nether(), continuity: { rememberedSections: ['inventory'] } }, frames }), null, 'stale inventory');
	assert.equal(netherFoodFact({ observation: nether({ dead: true }), frames }), null, 'dead');
});

test('full game: the portal seen on arrival in the Nether is the way out named in now.food once food runs out', async () => {
	const record = { agentId: 'a1', currentGoal: 'Beat the game', goalRevision: 1 };
	const views = new LiveTaskViews();
	views.suggest(record.agentId, record.currentGoal, { steps: [{ id: 'nether', label: 'nether', kind: 'milestone', status: 'complete', dependsOn: [], detail: '', evidence: null, check: 'visited:minecraft:the_nether' },
		{ id: 'rods', label: 'rods', kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'has:minecraft:blaze_rod*6' }] });
	const arrival = { ...nether({ x: 0.5, y: 81, z: 28.5, health: 20, foodLevel: 20 }, [...items, { itemId: 'minecraft:cooked_beef', count: 4 }]), observedAtEpochMs: 1,
		world: { worldId: 'w', dimension: 'minecraft:the_nether' },
		sighted: { portalFrames: [{ axis: 'z', obsidian: 10, needed: 10, lit: true, x: 0, y: 81, z: 28, interior: [2, 3], missing: [], blocked: [] }] } };
	await views.observe(record, arrival);
	assert.equal(views.continuity(record).food, undefined, 'fed and holding food');
	await views.observe(record, { ...nether(), observedAtEpochMs: 2, world: { worldId: 'w', dimension: 'minecraft:the_nether' } });
	assert.match(views.continuity(record).food, /^none held; hunger 17\/20 cannot regrow health.*lit portal remembered 503m SE dy\+33 @0,81,28$/);
});
