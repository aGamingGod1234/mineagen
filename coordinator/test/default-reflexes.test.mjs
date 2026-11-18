import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_REFLEXES, MAX_REFLEXES, ReflexBook, STANCES, STANCE_SETTINGS, instinctsEnabled, materializeDefault, normalizeReflexEntries, resolveAutoStance } from '../src/reflexes.mjs';

const OVERWORLD = 'minecraft:overworld', NETHER = 'minecraft:the_nether';
const live = (dimension = OVERWORLD) => ({ world: { dimension }, player: { health: 20 } });
const dead = () => ({ player: { dead: true }, status: 'PLAYER_DEAD' });
const ids = (book) => book.list('a').map((row) => `${row.id}${row.default ? '*' : ''}`);
const FIRE = { id: 'burn', when: { type: 'on_fire' }, do: { type: 'leave_fire' } };

test('the default survival rules arm at spawn as canonical rules the mod accepts', () => {
	const book = new ReflexBook();
	assert.equal(book.observeContext('a', { ready: false }), false, 'no arming before a live sample');
	assert.equal(book.observeContext('a', live()), true, 'spawn arms them');
	assert.deepEqual(ids(book), ['default-lava*', 'default-lava-flow*', 'default-fire*', 'default-air*', 'default-edge*', 'default-creeper*', 'default-suffocate*', 'default-fireball*', 'default-arrow*', 'default-retreat*', 'default-eat*', 'default-defend*', 'default-blaze-cover*', 'default-cover*']);
	const sent = book.payload('a');
	assert.equal(sent.revision, 1);
	assert.deepEqual(sent.rules.map(({ coordinatorDefault, ...rule }) => rule), DEFAULT_REFLEXES.flatMap(({ ttlMs, cooldownMs, maxMs, ...rule }) => normalizeReflexEntries([{ ...rule, ttlS: ttlMs / 1_000, ...(cooldownMs === undefined ? {} : { cooldownS: cooldownMs / 1_000 }), ...(maxMs === undefined ? {} : { maxS: maxMs / 1_000 }) }])));
	assert.equal(book.observeContext('a', live()), false, 'an unchanged context sends nothing');
	assert.match(book.takeReport('a'), /^armed default-lava, default-lava-flow, default-fire, default-air, default-edge\(stance\), default-creeper, default-suffocate, default-fireball, default-arrow, default-retreat, default-eat\(stance\), default-defend\(stance\), default-blaze-cover, default-cover$/, 'the wake lists them by id, without their definitions');
});

test('the model switches a default off by id until the next respawn or dimension change; "*" removes only its own rules', () => {
	const book = new ReflexBook();
	book.observeContext('a', live());
	book.apply('a', normalizeReflexEntries([{ id: 'default-edge', remove: true }, FIRE]));
	assert.deepEqual(ids(book), ['default-lava*', 'default-lava-flow*', 'default-fire*', 'default-air*', 'default-creeper*', 'default-suffocate*', 'default-fireball*', 'default-arrow*', 'default-retreat*', 'default-eat*', 'default-defend*', 'default-blaze-cover*', 'default-cover*', 'burn']);
	assert.equal(book.observeContext('a', live()), false, 'switched off stays off in the same context');
	book.apply('a', normalizeReflexEntries([{ id: '*', remove: true }]));
	assert.deepEqual(ids(book), ['default-lava*', 'default-lava-flow*', 'default-fire*', 'default-air*', 'default-creeper*', 'default-suffocate*', 'default-fireball*', 'default-arrow*', 'default-retreat*', 'default-eat*', 'default-defend*', 'default-blaze-cover*', 'default-cover*'], '"*" leaves the defaults');
	assert.equal(book.observeContext('a', live(NETHER)), true, 'a dimension change arms the defaults again');
	assert.deepEqual(ids(book), ['default-lava*', 'default-lava-flow*', 'default-fire*', 'default-air*', 'default-creeper*', 'default-suffocate*', 'default-fireball*', 'default-arrow*', 'default-retreat*', 'default-eat*', 'default-defend*', 'default-blaze-cover*', 'default-cover*', 'default-edge*']);
	book.apply('a', normalizeReflexEntries([{ id: 'default-air', remove: true }]));
	assert.equal(book.observeContext('a', dead()), false);
	assert.equal(book.observeContext('a', live(NETHER)), true, 'a respawn arms the defaults again');
	assert.ok(ids(book).includes('default-air*'));
});

test('a default the model replaces by id is its own rule and is not overwritten; defaults do not use the rule allowance of the model', () => {
	const book = new ReflexBook();
	book.observeContext('a', live());
	book.apply('a', normalizeReflexEntries([{ id: 'default-lava', priority: 9, when: { type: 'lava_flowing', withinS: 4 }, do: { type: 'leave_lava' } }]));
	book.observeContext('a', live(NETHER));
	const lava = book.rules('a').find((rule) => rule.id === 'default-lava');
	assert.equal(lava.when[0].type, 'lava_flowing', 'the model\'s replacement survives a dimension change');
	assert.equal(book.list('a').find((row) => row.id === 'default-lava').default, undefined);
	book.apply('a', normalizeReflexEntries(Array.from({ length: MAX_REFLEXES - 1 }, (_, index) => ({ ...FIRE, id: `own-${index}` }))));
	assert.equal(book.payload('a').rules.length, MAX_REFLEXES + DEFAULT_REFLEXES.length - 1);
	assert.throws(() => book.apply('a', normalizeReflexEntries([{ ...FIRE, id: 'one-more' }])), /At most 12 reflexes of your own besides the default rules/);
});

test('a default the mod reports expired is armed again on the next sample', () => {
	const book = new ReflexBook();
	book.observeContext('a', live());
	const revision = book.payload('a').revision;
	const rows = ['default-fire', 'default-air', 'default-edge'].map((id) => ({ id, kind: 'trigger', state: 'armed', fired: 0, expiresInS: 3_000 }));
	book.observe('a', { revision, rules: rows, events: [{ seq: 1, id: 'default-lava', outcome: 'expired', ms: 0, detail: 'ttl reached' }] });
	assert.ok(!ids(book).includes('default-lava*'));
	assert.equal(book.observeContext('a', live()), true);
	assert.ok(ids(book).includes('default-lava*'));
});

test('the shared fixture the mod parses is exactly the default payload the coordinator sends', async () => {
	const { readFile } = await import('node:fs/promises');
	const fixture = JSON.parse(await readFile(new URL('../../src/test/resources/default-reflex-rules.json', import.meta.url), 'utf8'));
	const book = new ReflexBook();
	book.observeContext('a', live());
	assert.deepEqual(fixture, book.payload('a').rules, 'regenerate src/test/resources/default-reflex-rules.json from ReflexBook.payload');
});

// Issue 2 Step 2 item 1: the automatic stance (instincts arm only).
const fighting = (health = 20) => ({ world: { dimension: OVERWORLD }, player: { health }, currentAction: { active: true, actionId: 'x', actionType: 'fight_target' } });
const valueOf = (book, id, type) => book.payload('a').rules.find((rule) => rule.id === id).when.find((c) => c.type === type).value;

test('instincts flag: read from MINEAGEN_INSTINCTS as a comma list', () => {
	assert.equal(instinctsEnabled({}), false);
	assert.equal(instinctsEnabled({ MINEAGEN_INSTINCTS: '' }), false);
	assert.equal(instinctsEnabled({ MINEAGEN_INSTINCTS: 'instincts' }), true);
	assert.equal(instinctsEnabled({ MINEAGEN_INSTINCTS: 'aim, instincts' }), true);
	assert.equal(instinctsEnabled({ MINEAGEN_INSTINCTS: 'instinct' }), false);
});

test('auto stance: fight while a fight verb runs, cautious at low health or in the Nether or End, else steady', () => {
	assert.equal(resolveAutoStance(live()), 'steady');
	assert.equal(resolveAutoStance(fighting(5)), 'fight', 'a running fight wins over low health');
	assert.equal(resolveAutoStance({ ...live(), currentAction: { active: true, actionId: 'x', actionType: 'travel_to' } }), 'steady');
	assert.equal(resolveAutoStance(live(NETHER)), 'cautious');
	assert.equal(resolveAutoStance(live('minecraft:the_end')), 'cautious');
	assert.equal(resolveAutoStance({ ...live(), player: { health: 8 } }), 'cautious');
	assert.equal(resolveAutoStance({ ...live(), player: { health: 9 } }), 'steady');
	assert.equal(resolveAutoStance({ ...live(), player: { health: 9 } }, 'cautious'), 'cautious', 'hysteresis: cautious holds until health 10');
	assert.equal(resolveAutoStance({ ...live(), player: { health: 10 } }, 'cautious'), 'steady');
});

test('steady equals the default set; each stance changes only its numbers', () => {
	for (const rule of DEFAULT_REFLEXES) if (rule.id !== 'default-eat') assert.deepEqual(materializeDefault(rule, 'steady'), rule, rule.id);
	const fight = Object.fromEntries(DEFAULT_REFLEXES.map((rule) => [rule.id, materializeDefault(rule, 'fight')]));
	const cautious = Object.fromEntries(DEFAULT_REFLEXES.map((rule) => [rule.id, materializeDefault(rule, 'cautious')]));
	for (const [id, setting] of Object.entries(STANCE_SETTINGS)) {
		assert.equal(fight[id].when.find((c) => c.type === setting.condition).value, setting.fight, id);
		assert.equal(cautious[id].when.find((c) => c.type === setting.condition).value, setting.cautious, id);
	}
	assert.deepEqual([fight['default-retreat'], cautious['default-retreat']].map((r) => r.when[0].value), [4, 10]);
	assert.deepEqual([fight['default-cover'], cautious['default-cover']].map((r) => r.when[0].value), [4, 9]);
	assert.deepEqual([fight['default-blaze-cover'], cautious['default-blaze-cover']].map((r) => r.when[0].value), [8, 14]);
	const strip = (rule) => JSON.stringify({ ...rule, when: rule.when.map(({ value, ...c }) => c) });
	for (const rule of DEFAULT_REFLEXES) assert.equal(strip(cautious[rule.id]), strip(rule), `${rule.id} changes nothing but a number`);
});

test('flag off: no stance, the payload and wake line stay as before even in a fight', () => {
	let now = 0;
	const book = new ReflexBook({ now: () => now });
	book.observeContext('a', live());
	const before = JSON.stringify(book.payload('a'));
	now = 10_000; book.observeContext('a', fighting());
	now = 20_000; assert.equal(book.observeContext('a', fighting()), false);
	assert.equal(book.stance('a'), null);
	assert.equal(JSON.stringify({ ...book.payload('a') }), before);
	assert.doesNotMatch(book.takeReport('a'), /; stance /);
});

test('flag on: a new stance waits out its 3 s dwell, then rewrites the defaults once and says so in the wake line', () => {
	let now = 0;
	const book = new ReflexBook({ now: () => now, instincts: true });
	assert.equal(book.observeContext('a', live()), true);
	assert.equal(book.stance('a'), 'steady');
	assert.equal(valueOf(book, 'default-retreat', 'health_below'), 7);
	const revision = book.payload('a').revision;
	now = 1_000; assert.equal(book.observeContext('a', fighting()), false, 'the fight has not held 3 s yet');
	now = 2_000; assert.equal(book.observeContext('a', live()), false, 'a flicker resets the wait');
	now = 2_500; assert.equal(book.observeContext('a', fighting()), false);
	now = 5_000; assert.equal(book.observeContext('a', fighting()), false);
	now = 5_500; assert.equal(book.observeContext('a', fighting()), true, 'held 3 s: the set changes');
	assert.equal(book.stance('a'), 'fight');
	assert.equal(book.payload('a').revision, revision + 1, 'one revision');
	assert.equal(valueOf(book, 'default-retreat', 'health_below'), 4);
	assert.equal(valueOf(book, 'default-cover', 'health_below'), 4);
	assert.equal(valueOf(book, 'default-blaze-cover', 'health_below'), 8);
	assert.equal(book.observeContext('a', fighting()), false, 'no resend while it holds');
	assert.match(book.takeReport('a'), /; stance fight \(auto\)/);
});

test('flag on: a dimension change sets the stance at once; a default the model replaced keeps its own numbers', () => {
	const book = new ReflexBook({ now: () => 0, instincts: true });
	book.observeContext('a', live());
	book.apply('a', normalizeReflexEntries([{ id: 'default-cover', when: [{ type: 'health_below', value: 5 }, { type: 'attacked', withinS: 3 }], do: { type: 'take_cover', within: 8 } }]));
	assert.equal(book.observeContext('a', live(NETHER)), true);
	assert.equal(book.stance('a'), 'cautious');
	assert.equal(valueOf(book, 'default-retreat', 'health_below'), 10);
	assert.equal(valueOf(book, 'default-cover', 'health_below'), 5, 'the model owns it now');
	assert.equal(book.payload('a').rules.find((rule) => rule.id === 'default-cover').coordinatorDefault, undefined);
});

test('flag on with no injected defaults: nothing arms and there is no stance line', () => {
	const book = new ReflexBook({ defaults: [], instincts: true });
	assert.equal(book.observeContext('a', live()), false);
	assert.equal(book.takeReport('a'), null);
});

test('heal: with the flag on the default eat rule fires below hunger 18 in every stance; flag off it stays at 14', () => {
	const eat = DEFAULT_REFLEXES.find((rule) => rule.id === 'default-eat');
	for (const stance of STANCES) assert.equal(materializeDefault(eat, stance).when.find((c) => c.type === 'hunger_below').value, 18, stance);
	const off = new ReflexBook();
	off.observeContext('a', live());
	assert.equal(valueOf(off, 'default-eat', 'hunger_below'), 14);
	const on = new ReflexBook({ instincts: true });
	on.observeContext('a', live());
	assert.equal(valueOf(on, 'default-eat', 'hunger_below'), 18);
	assert.ok(on.payload('a').rules.length + MAX_REFLEXES <= 26, 'still one rule: 12 own + 14 defaults fit the mod cap');
});

test('safe eating precedence: hazards, retreat, cover and defend outrank eat, and eat holds off with a hostile within 8', () => {
	const book = new ReflexBook({ instincts: true });
	book.observeContext('a', live());
	const rules = book.payload('a').rules;
	const eat = rules.find((rule) => rule.id === 'default-eat');
	for (const id of ['default-lava', 'default-lava-flow', 'default-fire', 'default-air', 'default-suffocate', 'default-creeper', 'default-fireball', 'default-retreat', 'default-cover', 'default-blaze-cover', 'default-defend'])
		assert.ok(rules.find((rule) => rule.id === id).priority > eat.priority, `${id} outranks eat`);
	assert.deepEqual(eat.when.find((c) => c.type === 'hostile_near'), { type: 'hostile_near', not: true, within: 8 }, 'any fight in reach (under 8 blocks) holds eat off');
});

test('flag on: a respawn sets the stance at once from the new sample', () => {
	let now = 0;
	const book = new ReflexBook({ now: () => now, instincts: true });
	book.observeContext('a', live());
	now = 1_000; book.observeContext('a', fighting());
	now = 5_000; book.observeContext('a', fighting());
	assert.equal(book.stance('a'), 'fight');
	book.observeContext('a', dead());
	now = 5_100; assert.equal(book.observeContext('a', live()), true, 'respawn: no dwell');
	assert.equal(book.stance('a'), 'steady');
	assert.equal(valueOf(book, 'default-retreat', 'health_below'), 7);
});
