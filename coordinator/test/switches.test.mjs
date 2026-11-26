import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
	SIDES, STATUSES, SWITCHES, SwitchValueError, describeSwitches, flag, getSwitch, integer, list, listHas, number, oneOf,
	resolveSwitches, switchEntry,
} from '../src/switches.mjs';
import { caveFirst, lavaStairs } from '../src/find-search.mjs';
import { nightMoveStop } from '../src/night-cover.mjs';
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

// The coordinator readers as they read before they moved onto the registry, copied here so the move is checked against
// them: each reader now calls getSwitch and must answer exactly as its old expression did.
const OLD_READERS = {
	'find.caveFirst': (env) => String(env?.MINEAGEN_CAVE_FIRST ?? '').trim().toLowerCase() === 'on',
	// The old reader also had MINEAGEN_LAVA_SHAFT=on force the shaft; that rollback arm is gone (stairs are off by default).
	'find.lavaStairs': (env) => env.MINEAGEN_LAVA_STAIRS === 'on',
	'obtain.costs': (env) => env.MINEAGEN_OBTAIN_COSTS !== 'off',
	'kit.habit': (env) => String(env?.MINEAGEN_KIT_HABIT ?? '').trim().toLowerCase() !== 'off',
	'night.cover': (env) => String(env?.MINEAGEN_NIGHT_COVER ?? '').trim().toLowerCase() !== 'off',
	'tools.program': (env) => String(env?.MINEAGEN_PROGRAM_TOOLS ?? '').trim().toLowerCase() === 'on',
	// On by default since the default flip; set, it reads as before (a comma list holding `instincts`).
	'instincts': (env) => env?.MINEAGEN_INSTINCTS == null || String(env.MINEAGEN_INSTINCTS).split(',').map((word) => word.trim()).includes('instincts'),
	'experience.frozen': (env) => env.MINEAGEN_EXPERIENCE_FROZEN === '1',
};
const ENV_OF = Object.fromEntries(SWITCHES.filter((item) => item.env).map((item) => [item.name, item.env]));

function withProcessEnv(values, run) {
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	const put = (entries) => { for (const [key, value] of Object.entries(entries)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
	put(values);
	try { return run(); } finally { put(saved); }
}

// Night cover off returns null before anything else; the probe is an unarmoured climb out from under cover at dusk, which
// cover refuses (night-cover.test.mjs) and off lets through.
const NIGHT = { world: { dimension: 'minecraft:overworld', dayTime: 11_500 }, player: { x: 0.5, y: 30, z: 0.5, yaw: 0, health: 20, armor: 0, skyOpen: false } };

test('every coordinator reader answers as its old expression did, through the registry', () => {
	for (const value of VALUES) {
		for (const [name, old] of Object.entries(OLD_READERS)) {
			const env = value === undefined ? {} : { [ENV_OF[name]]: value };
			assert.equal(getSwitch(name, env).value, old(env), `${name} ${JSON.stringify(value)}`);
		}
		const env = value === undefined ? {} : { MINEAGEN_CAVE_FIRST: value, MINEAGEN_PROGRAM_TOOLS: value, MINEAGEN_KIT_HABIT: value, MINEAGEN_INSTINCTS: value };
		assert.equal(caveFirst(env), OLD_READERS['find.caveFirst'](env), `cave first ${JSON.stringify(value)}`);
		assert.equal(programToolsOffered(env), OLD_READERS['tools.program'](env), `program tools ${JSON.stringify(value)}`);
		assert.equal(kitHabitEnabled(env), OLD_READERS['kit.habit'](env), `kit habit ${JSON.stringify(value)}`);
		assert.equal(instinctsEnabled(env), OLD_READERS.instincts(env), `instincts ${JSON.stringify(value)}`);
		withProcessEnv({ MINEAGEN_LAVA_STAIRS: value }, () => assert.equal(lavaStairs(), OLD_READERS['find.lavaStairs'](process.env), `lava stairs ${JSON.stringify(value)}`));
		const cover = value === undefined ? {} : { MINEAGEN_NIGHT_COVER: value };
		const offStops = OLD_READERS['night.cover'](cover) ? 'not null' : null;
		assert.equal(nightMoveStop(NIGHT, 'dig_to', { pattern: 'stairs_up', y: 54 }, { environment: cover }) === null ? null : 'not null', offStops, `night cover ${JSON.stringify(value)}`);
		const frozen = { MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: tmpdir(), ...(value === undefined ? {} : { MINEAGEN_EXPERIENCE_FROZEN: value }) };
		assert.equal(experienceSettings(frozen).frozen, OLD_READERS['experience.frozen'](frozen), `frozen ${JSON.stringify(value)}`);
	}
	// A null value is unset, as the old `?? ''` read it.
	for (const name of ['find.caveFirst', 'kit.habit', 'night.cover', 'tools.program', 'instincts']) {
		assert.equal(getSwitch(name, { [ENV_OF[name]]: null }).value, OLD_READERS[name]({ [ENV_OF[name]]: null }), `${name} null`);
	}
	// experienceSettings: off is null, lessons needs a folder outside the checkout, an unknown mode refuses to start with
	// the same message as before.
	for (const value of [undefined, '', ' off ', 'OFF', 'lessons', ' Lessons ']) {
		const env = { MINEAGEN_EXPERIENCE_DIR: tmpdir(), ...(value === undefined ? {} : { MINEAGEN_EXPERIENCE: value }) };
		const settings = experienceSettings(env);
		const old = (env.MINEAGEN_EXPERIENCE ?? 'off').trim().toLowerCase() || 'off';
		assert.equal(settings === null ? 'off' : settings.mode, old, JSON.stringify(value));
	}
	for (const value of ['on', 'true', 'lesson']) {
		assert.throws(() => experienceSettings({ MINEAGEN_EXPERIENCE: value, MINEAGEN_EXPERIENCE_DIR: tmpdir() }), (error) => error instanceof TypeError && error.message === 'MINEAGEN_EXPERIENCE must be one of off, lessons');
		assert.throws(() => getSwitch('experience', { MINEAGEN_EXPERIENCE: value }), SwitchValueError);
	}
});

// Each reader reads through the registry (no file parses its switch itself any more), at the time it read before.
const READS = [
	['find.caveFirst', 'coordinator/src/find-search.mjs', "getSwitch('find.caveFirst', environment)"],
	['find.lavaStairs', 'coordinator/src/find-search.mjs', "getSwitch('find.lavaStairs')"],
	['find.dryStart', 'coordinator/src/find-search.mjs', "getSwitch('find.dryStart', environment)"],
	['find.dryFlood', 'coordinator/src/find-search.mjs', "getSwitch('find.dryFlood', environment)"],
	['obtain.costs', 'coordinator/src/obtain-runner.mjs', "const OBTAIN_COSTS = getSwitch('obtain.costs').value;"],
	['obtain.fillLegs', 'coordinator/src/obtain-runner.mjs', "const FILL_LEGS = getSwitch('obtain.fillLegs').value;"],
	['obtain.fillEdge', 'coordinator/src/obtain-runner.mjs', "const FILL_EDGE = getSwitch('obtain.fillEdge').value;"],
	['kit.habit', 'coordinator/src/kit-habit.mjs', "getSwitch('kit.habit', environment)"],
	['night.cover', 'coordinator/src/night-cover.mjs', "getSwitch('night.cover', environment)"],
	['tools.program', 'coordinator/src/native-minecraft-tools.mjs', "getSwitch('tools.program', environment)"],
	['experience', 'coordinator/src/experience-store.mjs', "getSwitch('experience', environment)"],
	['experience.frozen', 'coordinator/src/experience-store.mjs', "getSwitch('experience.frozen', environment)"],
	['instincts', 'coordinator/src/reflexes.mjs', "getSwitch('instincts', environment)"],
	['end.fallCatch', 'coordinator/src/reflexes.mjs', "getSwitch('end.fallCatch', environment)"],
	['end.highDescent', 'coordinator/src/dragon-fight-facts.mjs', "getSwitch('end.highDescent', environment)"],
	['stock.foodFloor', 'coordinator/src/skill-fits.mjs', "getSwitch('stock.foodFloor', environment)"],
	['stock.foodFloor', 'coordinator/src/obtain-runner.mjs', "getSwitch('stock.foodFloor').value"],
	['stock.portalGate', 'coordinator/src/native-tool-runtime.mjs', "getSwitch('stock.portalGate').value"],
	['route.pearlPlan', 'coordinator/src/need-sources.mjs', "getSwitch('route.pearlPlan', environment)"],
	['instincts', 'src/main/java/dev/agaminggod/mineagen/server/runtime/reflex/Instincts.java', 'Switches.get("instincts")'],
	['travel.walkAround', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerTravelController.java', 'Switches.get("travel.walkAround")'],
	['travel.shallowShore', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerTravelController.java', 'Switches.get("travel.shallowShore")'],
	['travel.skipBuried', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerRetraceController.java', 'Switches.get("travel.skipBuried")'],
	['fight.chargeGuard', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerFightUntilController.java', 'static final boolean CHARGE_GUARD = dev.agaminggod.mineagen.server.Switches.get("fight.chargeGuard");'],
	['fight.recover', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerFightUntilController.java', 'static final boolean RECOVER = dev.agaminggod.mineagen.server.Switches.get("fight.recover");'],
	['dig.floorLavaGuard', 'src/main/java/dev/agaminggod/mineagen/server/runtime/ServerActionExecutor.java', 'static boolean FLOOR_LAVA_GUARD = dev.agaminggod.mineagen.server.Switches.get("dig.floorLavaGuard");'],
	['reflex.plugInflow', 'src/main/java/dev/agaminggod/mineagen/server/runtime/reflex/ReflexActions.java', 'static boolean PLUG_INFLOW = dev.agaminggod.mineagen.server.Switches.get("reflex.plugInflow");'],
	['fight.spawnerHold', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/SpawnerHold.java', 'public static final boolean ENABLED = dev.agaminggod.mineagen.server.Switches.get("fight.spawnerHold");'],
	['fight.spawnerHoldOpen', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/SpawnerHold.java', 'public static final boolean OPEN_FIGHT = dev.agaminggod.mineagen.server.Switches.get("fight.spawnerHoldOpen");'],
	['fight.forestHunt', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/WarpedForestHunt.java', 'static boolean enabled = dev.agaminggod.mineagen.server.Switches.get("fight.forestHunt");'],
	['fight.fullIds', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerFightUntilController.java', 'Switches.get("fight.fullIds")'],
	['fight.skipUnreachable', 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/UnreachableTargets.java', 'Switches.get("fight.skipUnreachable")'],
	['killPosition', 'src/main/java/dev/agaminggod/mineagen/server/perception/KillSighting.java', 'Switches.get("killPosition")'],
	['watch', 'src/main/java/dev/agaminggod/mineagen/server/watch/Watcher.java', 'Switches.get("watch")'],
	['kit.habit', 'scripts/quality/test-iron-kit-live.mjs', "getSwitch('kit.habit')"],
	['night.cover', 'scripts/quality/test-obtain-live.mjs', "getSwitch('night.cover')"],
];

test('every reader reads its switch through the registry, and no switch variable is parsed anywhere else', () => {
	for (const [name, path, expression] of READS) {
		assert.ok(switchEntry(name), name);
		assert.ok(source(path).includes(expression), `${path} should read ${name} as \`${expression}\``);
	}
	assert.deepEqual(SWITCHES.map((item) => item.name).filter((name) => !READS.some(([read]) => read === name)), [], 'every switch has a reader');
	// No other source names a switch's variable or property in a read (the registry and its tests aside).
	const names = SWITCHES.flatMap((item) => [item.env, item.property].filter(Boolean));
	const reads = /(?:process\.env|environment\??|env)\??\.?\[?['"]?(MINEAGEN_[A-Z_]+)|System\.(?:getenv|getProperty)\("([^"]+)"|Boolean\.getBoolean\("([^"]+)"/g;
	for (const path of new Set(READS.map(([, file]) => file))) {
		for (const match of source(path).matchAll(reads)) {
			const found = match[1] ?? match[2] ?? match[3];
			assert.ok(!names.includes(found), `${path} still reads ${found} itself`);
		}
	}
	// What the server parsers mean, through the registry.
	const cases = {
		'travel.walkAround': { env: 'MINEAGEN_TRAVEL_WALK_AROUND', property: 'mineagen.travel.walkAround', table: [[undefined, false], [' ON ', true], ['true', false]],
			properties: [[undefined, false], ['TRUE', true], [' true', false], ['on', false]] },
		'travel.shallowShore': { env: 'MINEAGEN_TRAVEL_SHALLOW_SHORE', property: 'mineagen.travel.shallowShore', table: [[undefined, true], [' FALSE ', false], ['off', true]],
			properties: [[undefined, true], ['false', false], ['FALSE', true]] },
		'travel.skipBuried': { property: 'mineagen.travel.skipBuried', properties: [[undefined, true], ['false', false], ['FALSE', true], ['no', true]] },
		'instincts': { env: 'MINEAGEN_INSTINCTS', property: 'mineagen.instincts', table: [[undefined, true], ['instincts', true], ['x, instincts', true], ['Instincts', false], ['off', false], ['', false]],
			properties: [[undefined, true], ['True', true], ['false', false], ['1', false]] },
		'fight.chargeGuard': { property: 'mineagen.fight.chargeGuard', properties: [[undefined, true], ['false', false], ['FALSE', true], ['no', true]] },
		'fight.recover': { property: 'mineagen.fight.recover', properties: [[undefined, true], ['false', false], ['False', true]] },
		'dig.floorLavaGuard': { property: 'mineagen.dig.floorLavaGuard', properties: [[undefined, true], ['false', false], ['FALSE', true]] },
		'reflex.plugInflow': { property: 'mineagen.reflex.plugInflow', properties: [[undefined, true], ['false', false], ['FALSE', true]] },
		'fight.spawnerHold': { property: 'mineagen.fight.spawnerHold', properties: [[undefined, true], ['false', false], [' false', true]] },
		'fight.spawnerHoldOpen': { property: 'mineagen.fight.spawnerHoldOpen', properties: [[undefined, true], ['false', false], ['0', true]] },
		'fight.forestHunt': { property: 'mineagen.fight.forestHunt', properties: [[undefined, false], ['true', true], ['TRUE', true], [' true', false]] },
		'fight.fullIds': { property: 'mineagen.fight.fullIds', properties: [[undefined, true], ['false', false], ['FALSE', true]] },
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
	// The dropped switches stay gone.
	assert.equal(switchEntry('find.lavaShaft'), null);
	assert.equal(switchEntry('fight.cover'), null);
});

test('sources: default, env, property, and unseen when the property cannot be read', () => {
	assert.deepEqual({ ...getSwitch('find.caveFirst', {}) }, { value: false, source: 'default' });
	assert.deepEqual({ ...getSwitch('find.caveFirst', { MINEAGEN_CAVE_FIRST: 'off' }) }, { value: false, source: 'env' });
	assert.deepEqual({ ...getSwitch('fight.forestHunt', {}) }, { value: false, source: 'unseen' });
	assert.deepEqual({ ...getSwitch('fight.forestHunt', {}, { properties: {} }) }, { value: false, source: 'default' });
	assert.deepEqual({ ...getSwitch('fight.forestHunt', {}, { properties: { 'mineagen.fight.forestHunt': 'true' } }) }, { value: true, source: 'property' });
	// Two sources: a true env value settles it even when the property is unseen; otherwise either can turn it on.
	assert.deepEqual({ ...getSwitch('instincts', { MINEAGEN_INSTINCTS: 'instincts' }) }, { value: true, source: 'env' });
	assert.deepEqual({ ...getSwitch('instincts', {}) }, { value: true, source: 'unseen' });
	assert.deepEqual({ ...getSwitch('instincts', {}, { properties: {} }) }, { value: true, source: 'default' });
	assert.deepEqual({ ...getSwitch('instincts', { MINEAGEN_INSTINCTS: 'off' }) }, { value: false, source: 'unseen' });
	assert.deepEqual({ ...getSwitch('instincts', { MINEAGEN_INSTINCTS: 'x' }, { properties: { 'mineagen.instincts': 'true' } }) }, { value: true, source: 'property' });
	assert.deepEqual({ ...getSwitch('instincts', { MINEAGEN_INSTINCTS: 'x' }, { properties: { 'mineagen.instincts': 'false' } }) }, { value: false, source: 'env' });
	assert.deepEqual({ ...getSwitch('instincts', {}, { properties: { 'mineagen.instincts': 'false' } }) }, { value: false, source: 'property' });
	// A null value is unset, as the readers' `?? ''` treats it.
	assert.deepEqual({ ...getSwitch('experience', { MINEAGEN_EXPERIENCE: null }) }, { value: 'off', source: 'default' });
	assert.equal(experienceSettings({ MINEAGEN_EXPERIENCE: null }), null);
	assert.equal(getSwitch('kit.habit', { MINEAGEN_KIT_HABIT: null }).value, kitHabitEnabled({ MINEAGEN_KIT_HABIT: null }));
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
	assert.match(line, / fight\.forestHunt=off\? /);
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

// Runs the Java mirror itself: compiles Switches.java with a small harness and feeds the same typed values to Java
// resolve()/describe() and to the coordinator's describe line. Skips when this machine has no JDK. ASCII values only:
// the two languages trim and fold case differently for some non-ASCII text (see coordinator/src/switches.mjs).
const HARNESS = `import dev.agaminggod.mineagen.server.Switches;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

public class SwitchesParity {
	// The server readers as they read before they moved onto Switches.get, on given maps instead of the JVM's: the
	// registry must answer each exactly as before. Boolean.getBoolean(name) is "true".equalsIgnoreCase(property).
	static String old(Map<String, String> env, Map<String, String> p) {
		String listed = env.get("MINEAGEN_INSTINCTS");
		// Instincts: on by default since the default flip (neither source set); a set source reads as before.
		boolean instincts = "true".equalsIgnoreCase(p.get("mineagen.instincts"))
				|| (listed != null && Arrays.stream(listed.split(",")).map(String::trim).anyMatch("instincts"::equals))
				|| (listed == null && p.get("mineagen.instincts") == null);
		boolean walkAround = "true".equalsIgnoreCase(p.get("mineagen.travel.walkAround"))
				|| "on".equalsIgnoreCase(String.valueOf(env.get("MINEAGEN_TRAVEL_WALK_AROUND")).trim());
		String shoreEnv = env.get("MINEAGEN_TRAVEL_SHALLOW_SHORE"), shoreProperty = p.get("mineagen.travel.shallowShore");
		Boolean shoreFromEnv = shoreEnv == null ? null : !"false".equalsIgnoreCase(shoreEnv.trim());
		Boolean shoreFromProperty = shoreProperty == null ? null : !"false".equals(shoreProperty);
		boolean shallowShore = Boolean.TRUE.equals(shoreFromEnv) || Boolean.TRUE.equals(shoreFromProperty) || shoreFromEnv == null && shoreFromProperty == null;
		boolean[] values = { instincts, walkAround, shallowShore, !"false".equals(p.get("mineagen.travel.skipBuried")),
				!"false".equals(p.get("mineagen.fight.chargeGuard")),
				!"false".equals(p.get("mineagen.fight.recover")),
				!"false".equals(p.get("mineagen.dig.floorLavaGuard")),
				!"false".equals(p.get("mineagen.reflex.plugInflow")),
				!"false".equals(p.get("mineagen.fight.spawnerHold")),
				!"false".equals(p.get("mineagen.fight.spawnerHoldOpen")),
				"true".equalsIgnoreCase(p.get("mineagen.fight.forestHunt")),
				!"false".equals(p.get("mineagen.fight.fullIds")),
				!"false".equals(p.get("mineagen.fight.skipUnreachable")),
				!"false".equalsIgnoreCase(p.getOrDefault("mineagen.killPosition", "true").trim()),
				"true".equalsIgnoreCase(p.getOrDefault("mineagen.watch", "false").trim()) };
		String[] names = { "instincts", "travel.walkAround", "travel.shallowShore", "travel.skipBuried", "fight.chargeGuard", "fight.recover", "dig.floorLavaGuard", "reflex.plugInflow", "fight.spawnerHold", "fight.spawnerHoldOpen",
				"fight.forestHunt", "fight.fullIds", "fight.skipUnreachable", "killPosition", "watch" };
		StringBuilder line = new StringBuilder("switches");
		for (int i = 0; i < names.length; i++) line.append(' ').append(names[i]).append('=').append(values[i] ? "on" : "off");
		return line.toString();
	}

	public static void main(String[] args) throws Exception {
		BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
		Base64.Decoder decoder = Base64.getDecoder();
		StringBuilder out = new StringBuilder();
		for (String line; (line = in.readLine()) != null; ) {
			Map<String, String> env = new HashMap<>();
			Map<String, String> properties = new HashMap<>();
			for (String token : line.isEmpty() ? new String[0] : line.split(" ")) {
				String[] parts = token.split(",", -1);
				String key = new String(decoder.decode(parts[1]), StandardCharsets.UTF_8);
				String value = new String(decoder.decode(parts[2]), StandardCharsets.UTF_8);
				(parts[0].equals("E") ? env : properties).put(key, value);
			}
			out.append(Switches.describe(Switches.resolve(env, properties))).append('\\t').append(old(env, properties)).append('\\n');
		}
		System.out.print(out);
	}
}
`;

function jdkTool(name) {
	const home = process.env.JAVA_HOME;
	const candidates = [...(home ? [join(home, 'bin', name)] : []), name];
	return candidates.find((command) => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0) ?? null;
}

test('the Java Switches mirror resolves and describes the same values as the coordinator registry', (t) => {
	const javac = jdkTool('javac');
	const java = jdkTool('java');
	if (!javac || !java) return t.skip('no JDK on this machine');
	const server = SWITCHES.filter((item) => item.side !== 'coordinator');
	const typed = VALUES.filter((value) => value !== undefined);
	const cases = [{ env: {}, properties: {} }];
	for (const item of server) {
		for (const value of typed) {
			if (item.env) cases.push({ env: { [item.env]: value }, properties: {} });
			if (item.property) cases.push({ env: {}, properties: { [item.property]: value } });
			if (item.env && item.property) for (const other of typed) cases.push({ env: { [item.env]: value }, properties: { [item.property]: other } });
		}
	}
	for (const value of typed) {
		cases.push({
			env: Object.fromEntries(server.filter((item) => item.env).map((item) => [item.env, value])),
			properties: Object.fromEntries(server.filter((item) => item.property).map((item) => [item.property, value])),
		});
	}
	const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
	const input = cases.map(({ env, properties }) => [
		...Object.entries(env).map(([key, value]) => `E,${b64(key)},${b64(value)}`),
		...Object.entries(properties).map(([key, value]) => `P,${b64(key)},${b64(value)}`),
	].join(' ')).join('\n');
	const work = mkdtempSync(join(tmpdir(), 'switches-parity-'));
	try {
		writeFileSync(join(work, 'SwitchesParity.java'), HARNESS);
		const switchesJava = fileURLToPath(new URL('src/main/java/dev/agaminggod/mineagen/server/Switches.java', ROOT));
		const compiled = spawnSync(javac, ['-d', join(work, 'classes'), switchesJava, join(work, 'SwitchesParity.java')], { encoding: 'utf8' });
		assert.equal(compiled.status, 0, compiled.stderr);
		const ran = spawnSync(java, ['-cp', join(work, 'classes'), 'SwitchesParity'], { input: `${input}\n`, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
		assert.equal(ran.status, 0, ran.stderr);
		const lines = ran.stdout.split(/\r?\n/).filter(Boolean);
		assert.equal(lines.length, cases.length, 'one Java line per case');
		cases.forEach(({ env, properties }, index) => {
			const [line, old] = lines[index].split('\t');
			const expected = describeSwitches(resolveSwitches(env, { properties, sides: ['server', 'both'] })).line;
			assert.equal(line, expected, `env ${JSON.stringify(env)} -D ${JSON.stringify(properties)}`);
			// And each value is what the old Java reader gave for the same environment and properties.
			assert.equal(line.replace(/@\w+/g, ''), old, `old readers: env ${JSON.stringify(env)} -D ${JSON.stringify(properties)}`);
		});
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
