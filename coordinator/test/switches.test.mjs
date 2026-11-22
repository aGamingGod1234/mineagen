import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
	SIDES, STATUSES, SWITCHES, SwitchValueError, describeSwitches, flag, getSwitch, integer, list, listHas, number, oneOf,
	resolveSwitches, switchEntry,
} from '../src/switches.mjs';
import { caveFirst, lavaStairs } from '../src/find-search.mjs';
import { kitHabitEnabled } from '../src/kit-habit.mjs';
import { instinctsEnabled } from '../src/reflexes.mjs';
import { programToolsOffered } from '../src/native-minecraft-tools.mjs';
import { experienceSettings } from '../src/experience-store.mjs';

const ROOT = new URL('../../', import.meta.url);
const source = (path) => readFileSync(new URL(path, ROOT), 'utf8');
// Values a launcher or a person might type, with the spellings the readers treat differently.
const VALUES = [undefined, '', 'on', 'ON', ' on ', 'On', 'off', 'OFF', ' off ', 'true', 'TRUE', ' true ', 'false', 'FALSE', ' false ', '1', '0',
	'yes', 'instincts', 'a, instincts', 'instincts,b', 'Instincts', ' instincts ', 'lessons'];

test('every entry has a side, status, parser, reason and reader, and names are unique', () => {
	assert.equal(new Set(SWITCHES.map((item) => item.name)).size, SWITCHES.length);
	for (const item of SWITCHES) {
		assert.ok(SIDES.includes(item.side), item.name);
		assert.ok(STATUSES.includes(item.status), item.name);
		assert.ok(item.reason.length > 10 && item.readers.length > 0, item.name);
		assert.equal(item.parser.unset, item.default, `${item.name}: unset parses to the default`);
		if (item.env) assert.match(item.env, /^MINEAGEN_[A-Z0-9_]+$/);
		// Server switch names are the property without its prefix, so a -D flag and a result line read alike.
		if (item.property) assert.equal(item.property, `mineagen.${item.name}`);
		assert.equal(switchEntry(item.name), item);
	}
	// A status of default-on means the default is on, and the reverse.
	for (const item of SWITCHES.filter((entry) => entry.status === 'default-on')) assert.equal(item.default, true, item.name);
	for (const item of SWITCHES.filter((entry) => entry.status === 'default-off')) assert.equal(item.default, false, item.name);
});

test('flag parsers copy exact, trimmed and any-case comparisons', () => {
	const exactOn = flag({ token: 'on', means: 'on' });
	assert.deepEqual(['on', 'ON', ' on ', 'off', ''].map((value) => exactOn.parse(value)), [true, false, false, false, false]);
	const wordOn = flag({ token: 'on', means: 'on', trim: true, anyCase: true });
	assert.deepEqual(['on', 'ON', ' on ', 'off', 'true'].map((value) => wordOn.parse(value)), [true, true, true, false, false]);
	const exactNotFalse = flag({ token: 'false', means: 'off' });
	assert.deepEqual(['false', 'FALSE', ' false', 'true', ''].map((value) => exactNotFalse.parse(value)), [false, true, true, true, true]);
	const getBoolean = flag({ token: 'true', means: 'on', anyCase: true });
	assert.deepEqual(['true', 'TRUE', ' true', '1'].map((value) => getBoolean.parse(value)), [true, true, false, false]);
	assert.equal(exactOn.id, 'on-if:on');
	assert.equal(wordOn.id, 'on-if:on/trim/any-case');
	assert.equal(exactNotFalse.unset, true);
	assert.throws(() => flag({ token: 'x', means: 'maybe' }), TypeError);
	const has = listHas('instincts');
	assert.deepEqual(['instincts', 'a, instincts ', 'Instincts', 'instinctsx', ''].map((value) => has.parse(value)), [true, true, false, false, false]);
});

test('enum, integer, number and list parsers validate', () => {
	const mode = oneOf(['off', 'lessons'], 'off');
	assert.equal(mode.parse(' LESSONS '), 'lessons');
	assert.equal(mode.parse('  '), 'off');
	assert.throws(() => mode.parse('on'), SwitchValueError);
	const whole = integer({ min: 1, max: 10, fallback: 5 });
	assert.equal(whole.parse(' 7 '), 7);
	for (const bad of ['0', '11', '1.5', '', 'seven', '1e2']) assert.throws(() => whole.parse(bad), SwitchValueError, bad);
	const ratio = number({ min: 0, max: 1, fallback: 0.5 });
	assert.equal(ratio.parse('0.25'), 0.25);
	for (const bad of ['', '2', 'NaN', 'Infinity', '-0.1']) assert.throws(() => ratio.parse(bad), SwitchValueError, bad);
	assert.deepEqual(list().parse(' a, ,b ,'), ['a', 'b']);
	assert.deepEqual(list().unset, []);
});

test('coordinator switches resolve exactly as their readers do today', () => {
	for (const value of VALUES) {
		const env = value === undefined ? {} : { MINEAGEN_CAVE_FIRST: value, MINEAGEN_PROGRAM_TOOLS: value, MINEAGEN_KIT_HABIT: value, MINEAGEN_INSTINCTS: value };
		assert.equal(getSwitch('find.caveFirst', env).value, caveFirst(env), `cave first ${JSON.stringify(value)}`);
		assert.equal(getSwitch('tools.program', env).value, programToolsOffered(env), `program tools ${JSON.stringify(value)}`);
		assert.equal(getSwitch('kit.habit', env).value, kitHabitEnabled(env), `kit habit ${JSON.stringify(value)}`);
		assert.equal(getSwitch('instincts', env).value, instinctsEnabled(env), `instincts ${JSON.stringify(value)}`);
	}
	// lavaStairs reads process.env itself: stairs on and the shaft not forced.
	const saved = { stairs: process.env.MINEAGEN_LAVA_STAIRS, shaft: process.env.MINEAGEN_LAVA_SHAFT };
	try {
		for (const stairs of VALUES) for (const shaft of [undefined, 'on', 'ON', 'off']) {
			for (const [key, value] of [['MINEAGEN_LAVA_STAIRS', stairs], ['MINEAGEN_LAVA_SHAFT', shaft]]) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			const expected = getSwitch('find.lavaStairs').value && !getSwitch('find.lavaShaft').value;
			assert.equal(expected, lavaStairs(), `lava stairs ${JSON.stringify(stairs)} shaft ${JSON.stringify(shaft)}`);
		}
	} finally {
		for (const [key, value] of [['MINEAGEN_LAVA_STAIRS', saved.stairs], ['MINEAGEN_LAVA_SHAFT', saved.shaft]]) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
	// experienceSettings: off is null, lessons needs a folder outside the checkout, an unknown mode refuses to start.
	for (const value of [undefined, '', ' off ', 'OFF', 'lessons', ' Lessons ']) {
		const env = { MINEAGEN_EXPERIENCE_DIR: tmpdir(), ...(value === undefined ? {} : { MINEAGEN_EXPERIENCE: value }) };
		const settings = experienceSettings(env);
		assert.equal(getSwitch('experience', env).value, settings === null ? 'off' : settings.mode, JSON.stringify(value));
	}
	for (const value of ['on', 'true', 'lesson']) {
		assert.throws(() => experienceSettings({ MINEAGEN_EXPERIENCE: value, MINEAGEN_EXPERIENCE_DIR: tmpdir() }), TypeError);
		assert.throws(() => getSwitch('experience', { MINEAGEN_EXPERIENCE: value }), SwitchValueError);
	}
	for (const value of VALUES) {
		const env = { MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: tmpdir(), ...(value === undefined ? {} : { MINEAGEN_EXPERIENCE_FROZEN: value }) };
		assert.equal(getSwitch('experience.frozen', env).value, experienceSettings(env).frozen, `frozen ${JSON.stringify(value)}`);
	}
});

// Readers that keep their value private (a module constant, a Java static) are pinned by their source expression, so a
// reader that changes its parsing without the registry fails here. The sweep that moves them onto the registry drops these.
const PINNED = [
	['obtain.costs', 'coordinator/src/obtain-runner.mjs', "process.env.MINEAGEN_OBTAIN_COSTS !== 'off'"],
	['night.cover', 'coordinator/src/night-cover.mjs', "String(environment?.MINEAGEN_NIGHT_COVER ?? '').trim().toLowerCase() === 'off'"],
	['instincts', 'src/main/java/dev/agaminggod/mineagen/server/runtime/reflex/Instincts.java', 'Boolean.getBoolean("mineagen.instincts")'],
	['instincts', 'src/main/java/dev/agaminggod/mineagen/server/runtime/reflex/Instincts.java', 'Arrays.stream(value.split(",")).map(String::trim).anyMatch("instincts"::equals)'],
	['travel.walkAround', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerTravelController.java', 'Boolean.getBoolean("mineagen.travel.walkAround") || "on".equalsIgnoreCase(String.valueOf(environment).trim())'],
	['fight.cover', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerFightUntilController.java', '"true".equals(System.getProperty("mineagen.fight.cover"))'],
	['fight.chargeGuard', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerFightUntilController.java', '!"false".equals(System.getProperty("mineagen.fight.chargeGuard"))'],
	['fight.recover', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerFightUntilController.java', '!"false".equals(System.getProperty("mineagen.fight.recover"))'],
	['fight.spawnerHold', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/SpawnerHold.java', '!"false".equals(System.getProperty("mineagen.fight.spawnerHold"))'],
	['fight.spawnerHoldOpen', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/SpawnerHold.java', '!"false".equals(System.getProperty("mineagen.fight.spawnerHoldOpen"))'],
	['fight.forestHunt', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/WarpedForestHunt.java', 'static boolean enabled = Boolean.getBoolean(PROPERTY)'],
	['fight.skipUnreachable', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/UnreachableTargets.java', '!"false".equals(System.getProperty(PROPERTY))'],
	['killPosition', 'src/main/java/dev/agaminggod/mineagen/server/perception/KillSighting.java', '!"false".equalsIgnoreCase(System.getProperty(ENABLE_PROPERTY, "true").trim())'],
	['watch', 'src/main/java/dev/agaminggod/mineagen/server/watch/Watcher.java', '"true".equalsIgnoreCase(System.getProperty(ENABLE_PROPERTY, "false").trim())'],
];

test('readers without an exported value still parse the way the registry copies', () => {
	for (const [name, path, expression] of PINNED) {
		assert.ok(switchEntry(name), name);
		assert.ok(source(path).includes(expression), `${path} no longer reads ${name} as \`${expression}\`; update coordinator/src/switches.mjs and Switches.java`);
	}
	// What those expressions mean, through the registry's parsers.
	const cases = {
		'obtain.costs': { env: 'MINEAGEN_OBTAIN_COSTS', table: [[undefined, true], ['off', false], ['OFF', true], [' off', true], ['on', true]] },
		'night.cover': { env: 'MINEAGEN_NIGHT_COVER', table: [[undefined, true], ['off', false], [' OFF ', false], ['on', true], ['0', true]] },
		'travel.walkAround': { env: 'MINEAGEN_TRAVEL_WALK_AROUND', property: 'mineagen.travel.walkAround', table: [[undefined, false], [' ON ', true], ['true', false]],
			properties: [[undefined, false], ['TRUE', true], [' true', false], ['on', false]] },
		'instincts': { env: 'MINEAGEN_INSTINCTS', property: 'mineagen.instincts', table: [[undefined, false], ['instincts', true], ['x, instincts', true], ['Instincts', false]],
			properties: [[undefined, false], ['True', true], ['1', false]] },
		'fight.cover': { property: 'mineagen.fight.cover', properties: [[undefined, false], ['true', true], ['TRUE', false], [' true', false]] },
		'fight.chargeGuard': { property: 'mineagen.fight.chargeGuard', properties: [[undefined, true], ['false', false], ['FALSE', true], ['no', true]] },
		'fight.recover': { property: 'mineagen.fight.recover', properties: [[undefined, true], ['false', false], ['False', true]] },
		'fight.spawnerHold': { property: 'mineagen.fight.spawnerHold', properties: [[undefined, true], ['false', false], [' false', true]] },
		'fight.spawnerHoldOpen': { property: 'mineagen.fight.spawnerHoldOpen', properties: [[undefined, true], ['false', false], ['0', true]] },
		'fight.forestHunt': { property: 'mineagen.fight.forestHunt', properties: [[undefined, false], ['true', true], ['TRUE', true], [' true', false]] },
		'fight.skipUnreachable': { property: 'mineagen.fight.skipUnreachable', properties: [[undefined, true], ['false', false], ['FALSE', true]] },
		'killPosition': { property: 'mineagen.killPosition', properties: [[undefined, true], ['false', false], [' FALSE ', false], ['no', true]] },
		'watch': { property: 'mineagen.watch', properties: [[undefined, false], ['true', true], [' TRUE ', true], ['1', false]] },
	};
	for (const [name, { env, property, table = [], properties = [] }] of Object.entries(cases)) {
		for (const [value, expected] of table) {
			assert.equal(getSwitch(name, value === undefined ? {} : { [env]: value }, { properties: {} }).value, expected, `${name} env ${JSON.stringify(value)}`);
		}
		for (const [value, expected] of properties) {
			assert.equal(getSwitch(name, {}, { properties: value === undefined ? {} : { [property]: value } }).value, expected, `${name} -D ${JSON.stringify(value)}`);
		}
	}
});

test('sources: default, env, property, and unseen when the property cannot be read', () => {
	assert.deepEqual({ ...getSwitch('find.caveFirst', {}) }, { value: false, source: 'default' });
	assert.deepEqual({ ...getSwitch('find.caveFirst', { MINEAGEN_CAVE_FIRST: 'off' }) }, { value: false, source: 'env' });
	assert.deepEqual({ ...getSwitch('fight.cover', {}) }, { value: false, source: 'unseen' });
	assert.deepEqual({ ...getSwitch('fight.cover', {}, { properties: {} }) }, { value: false, source: 'default' });
	assert.deepEqual({ ...getSwitch('fight.cover', {}, { properties: { 'mineagen.fight.cover': 'true' } }) }, { value: true, source: 'property' });
	// Two sources: a true env value settles it even when the property is unseen; otherwise either can turn it on.
	assert.deepEqual({ ...getSwitch('instincts', { MINEAGEN_INSTINCTS: 'instincts' }) }, { value: true, source: 'env' });
	assert.deepEqual({ ...getSwitch('instincts', {}) }, { value: false, source: 'unseen' });
	assert.deepEqual({ ...getSwitch('instincts', { MINEAGEN_INSTINCTS: 'x' }, { properties: { 'mineagen.instincts': 'true' } }) }, { value: true, source: 'property' });
	assert.deepEqual({ ...getSwitch('instincts', { MINEAGEN_INSTINCTS: 'x' }, { properties: { 'mineagen.instincts': 'false' } }) }, { value: false, source: 'env' });
	assert.deepEqual({ ...getSwitch('instincts', {}, { properties: { 'mineagen.instincts': 'false' } }) }, { value: false, source: 'property' });
	assert.throws(() => getSwitch('no.such'), TypeError);
	assert.throws(() => resolveSwitches({ MINEAGEN_EXPERIENCE: 'maybe' }), SwitchValueError);
});

test('describeSwitches gives one log line and a JSON-safe record', () => {
	const resolved = resolveSwitches({ MINEAGEN_CAVE_FIRST: 'on', MINEAGEN_KIT_HABIT: 'off' });
	assert.equal(resolved.size, SWITCHES.length);
	const { line, record } = describeSwitches(resolved);
	assert.match(line, /^switches find\.caveFirst=on@env /);
	assert.match(line, / kit\.habit=off@env /);
	assert.match(line, / obtain\.costs=on /);
	assert.match(line, / experience=off /);
	assert.match(line, / fight\.cover=off\? /);
	assert.equal(line.includes('\n'), false);
	assert.deepEqual(record['find.caveFirst'], { value: true, source: 'env' });
	assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
	// The coordinator side alone has no property switch, so nothing is unseen.
	const coordinator = describeSwitches(resolveSwitches({}, { sides: ['coordinator'] }));
	assert.equal(coordinator.line.includes('?'), false);
	assert.equal(Object.keys(coordinator.record).length, SWITCHES.filter((item) => item.side === 'coordinator').length);
});

// Switches.java mirrors every server and both-side entry; parse its source as java-wire-schema.test.mjs does.
test('the Java Switches mirror has the same server entries, sources, defaults, parsers and statuses', () => {
	const java = source('src/main/java/dev/agaminggod/mineagen/server/Switches.java');
	const flags = new Map();
	for (const match of java.matchAll(/static final Flag (\w+) = new Flag\("([^"]*)", (true|false), (true|false), (true|false), (true|false)\);/g)) {
		const [, constant, token, meansOn, trim, anyCase, isList] = match;
		flags.set(constant, isList === 'true' ? listHas(token).id
			: flag({ token, means: meansOn === 'true' ? 'on' : 'off', trim: trim === 'true', anyCase: anyCase === 'true' }).id);
	}
	assert.ok(flags.size >= 5, 'Flag constants found');
	const text = (value) => (value === 'null' ? null : value.slice(1, -1));
	const entries = [...java.matchAll(/new Switch\("([^"]+)", (null|"[^"]+"), (null|"[^"]+"), "(\w+)", (true|false), (\w+), (\w+), "([^"]+)"\)/g)]
		.map(([, name, env, property, side, defaultValue, parser, propertyParser, status]) => ({
			name, env: text(env), property: text(property), side, default: defaultValue === 'true',
			parser: flags.get(parser), propertyParser: propertyParser === 'null' ? null : flags.get(propertyParser), status,
		}));
	const expected = SWITCHES.filter((item) => item.side !== 'coordinator').map((item) => ({
		name: item.name, env: item.env, property: item.property, side: item.side, default: item.default,
		parser: item.parser.id, propertyParser: item.propertyParser?.id ?? null, status: item.status,
	}));
	assert.deepEqual(entries, expected);
	assert.equal((java.match(/new Switch\(/g) ?? []).length, expected.length, 'every Java entry parsed');
	// The Java describe() writes the same `switches name=value@source` line.
	assert.ok(java.includes('new StringBuilder("switches")'));
});
