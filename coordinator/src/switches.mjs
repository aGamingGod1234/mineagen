// One registry for the gameplay switches: the environment variables and Java system properties that turn a behaviour on
// or off for an A/B round. Each entry copies the parsing its reader uses today, quirks included (some readers trim and
// ignore case, some compare exactly), so moving a reader onto the registry changed nothing. Every reader goes through
// getSwitch; the coordinator logs describeSwitches(resolveSwitches()).line at startup and room and game results carry the
// record. The server-side mirror is src/main/java/dev/agaminggod/mineagen/server/Switches.java, and
// coordinator/test/switches.test.mjs checks the two agree.
// The two languages agree on ASCII values only. Java's String.trim drops every character up to U+0020 and its
// equalsIgnoreCase folds a few non-ASCII letters (U+017F long s to s); JS trim drops Unicode spaces (NBSP, U+2028,
// U+FEFF) and toLowerCase leaves U+017F alone. Each mirror copies the readers in its own language, so a server-read env
// switch (travel.walkAround, instincts) set to such a value can describe differently here than the mod reads it.

export const SIDES = Object.freeze(['coordinator', 'server', 'both']);
/** default-on: shipped, with an off arm kept for A/Bs; default-off: held off after a measured loss or until measured; experimental: an arm still being built or tried; diagnostic: measurement only; deprecated: kept for a rollback. */
export const STATUSES = Object.freeze(['default-on', 'default-off', 'experimental', 'diagnostic', 'deprecated']);

export class SwitchValueError extends TypeError {}

/**
 * A two-way switch: the raw text matching `token` means `means` (on or off), anything else the opposite. `trim` and
 * `anyCase` copy whether the reader trims and ignores case. Unset is the opposite of `means`.
 */
export function flag({ token, means, trim = false, anyCase = false }) {
	if (means !== 'on' && means !== 'off') throw new TypeError('flag means must be on or off');
	const id = `${means}-if:${token}${trim ? '/trim' : ''}${anyCase ? '/any-case' : ''}`;
	return Object.freeze({ id, kind: 'boolean', unset: means === 'off', parse(raw) {
		let text = String(raw);
		if (trim) text = text.trim();
		const hit = anyCase ? text.toLowerCase() === token.toLowerCase() : text === token;
		return hit === (means === 'on');
	} });
}

/** On when the comma list (items trimmed, exact case) holds `token`; `unset` is the value when the variable is not set. */
export function listHas(token, { unset = false } = {}) {
	return Object.freeze({ id: `list-has:${token}`, kind: 'boolean', unset, parse(raw) {
		return String(raw).split(',').map((word) => word.trim()).includes(token);
	} });
}

/** One of `values`, trimmed and lower-cased; empty is `fallback`; anything else is refused, as the reader refuses it. */
export function oneOf(values, fallback) {
	if (!values.includes(fallback)) throw new TypeError('enum fallback must be one of its values');
	return Object.freeze({ id: `enum:${values.join('|')}`, kind: 'enum', unset: fallback, values: Object.freeze([...values]), parse(raw) {
		const text = String(raw).trim().toLowerCase() || fallback;
		if (!values.includes(text)) throw new SwitchValueError(`must be one of ${values.join(', ')}`);
		return text;
	} });
}

/** A whole number in [min, max]; refused otherwise. */
export function integer({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, fallback }) {
	return Object.freeze({ id: `integer:${min}..${max}`, kind: 'integer', unset: fallback, parse(raw) {
		const text = String(raw).trim();
		const value = Number(text);
		if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) throw new SwitchValueError(`must be a whole number from ${min} to ${max}`);
		return value;
	} });
}

/** A finite number in [min, max]; refused otherwise. */
export function number({ min = -Infinity, max = Infinity, fallback }) {
	return Object.freeze({ id: `number:${min}..${max}`, kind: 'number', unset: fallback, parse(raw) {
		const text = String(raw).trim();
		const value = Number(text);
		if (text === '' || !Number.isFinite(value) || value < min || value > max) throw new SwitchValueError(`must be a number from ${min} to ${max}`);
		return value;
	} });
}

/** A comma list, items trimmed, empty items dropped. */
export function list({ fallback = [] } = {}) {
	return Object.freeze({ id: 'list', kind: 'list', unset: Object.freeze([...fallback]), parse(raw) {
		return Object.freeze(String(raw).split(',').map((word) => word.trim()).filter(Boolean));
	} });
}

// Java readers' shapes, named once: Boolean.getBoolean (any case, no trim), "true".equals, !"false".equals.
const JAVA_GET_BOOLEAN = flag({ token: 'true', means: 'on', anyCase: true });
const JAVA_TRUE_EXACT = flag({ token: 'true', means: 'on' });
const JAVA_NOT_FALSE_EXACT = flag({ token: 'false', means: 'off' });
const ON_WORD = flag({ token: 'on', means: 'on', trim: true, anyCase: true });
const ON_EXACT = flag({ token: 'on', means: 'on' });
const OFF_WORD = flag({ token: 'off', means: 'off', trim: true, anyCase: true });
const OFF_EXACT = flag({ token: 'off', means: 'off' });

function entry(fields) {
	const { name, env = null, property = null, side, parser, propertyParser = null, status, reason, readers } = fields;
	if (!SIDES.includes(side)) throw new TypeError(`${name}: side ${side}`);
	if (!STATUSES.includes(status)) throw new TypeError(`${name}: status ${status}`);
	if (!env && !property) throw new TypeError(`${name}: needs an env var or a property`);
	if (env && property && !propertyParser) throw new TypeError(`${name}: two sources need a property parser`);
	if (property && !env && propertyParser) throw new TypeError(`${name}: a property-only switch uses parser`);
	return Object.freeze({ name, env, property, side, default: fields.default, parser, propertyParser, status, reason, readers: Object.freeze([...readers]) });
}

/**
 * Every gameplay switch. A two-source entry (env and property) is on when either source says on, as its Java reader does.
 * `readers` names where each is read and when (per call, module load, class load); a reader keeps its timing.
 */
export const SWITCHES = Object.freeze([
	// coordinator/src/find-search.mjs caveFirst(environment): per call.
	entry({ name: 'find.caveFirst', env: 'MINEAGEN_CAVE_FIRST', side: 'coordinator', default: false, parser: ON_WORD, status: 'default-off',
		reason: 'Room batch 21 Nov (16 spawns x 10 repeats per arm): iron found in 9 of 30 runs on against 18 of 30 off; 75% of 103 cave walks found no walking way in (#68).',
		readers: ['coordinator/src/find-search.mjs caveFirst (per call)'] }),
	// coordinator/src/find-search.mjs lavaStairs(): per call, from process.env.
	entry({ name: 'find.lavaStairs', env: 'MINEAGEN_LAVA_STAIRS', side: 'coordinator', default: false, parser: ON_EXACT, status: 'default-off',
		reason: 'Stairs from the surface won lava-gate-8 (0 to 7 of 10) but lost lava-gate-3 (8 to 0 of 10, pickaxes wore out) and lava-gate-6 (deaths 0 to 7 of 10) (#74).',
		readers: ['coordinator/src/find-search.mjs lavaStairs (per call, process.env only)'] }),
	// coordinator/src/find-search.mjs dryStart(environment): per call.
	entry({ name: 'find.dryStart', env: 'MINEAGEN_FIND_DRY_START', side: 'coordinator', default: true, parser: OFF_EXACT, status: 'default-on',
		reason: 'A lava search from the surface walks off seen water before its first dig down (kit gates on main: 55 of 79 first digs met water, 3 lit); off is the A/B off arm.',
		readers: ['coordinator/src/find-search.mjs dryStart (per call)'] }),
	// coordinator/src/find-search.mjs dryFlood(environment): per call.
	entry({ name: 'find.dryFlood', env: 'MINEAGEN_FIND_DRY_FLOOD', side: 'coordinator', default: true, parser: OFF_EXACT, status: 'default-on',
		reason: 'Water that ran into an opened tunnel and stopped short of the body is a shut way the search turns from, not danger that ends it; off is the A/B off arm.',
		readers: ['coordinator/src/find-search.mjs dryFlood (per call)'] }),
	// coordinator/src/obtain-runner.mjs OBTAIN_COSTS: read once at module load.
	entry({ name: 'obtain.costs', env: 'MINEAGEN_OBTAIN_COSTS', side: 'coordinator', default: true, parser: OFF_EXACT, status: 'default-on',
		reason: 'Off plans as before chest looting, the seen-source cost model and the one-trip kit iron, for A/B rooms (#115).',
		readers: ['coordinator/src/obtain-runner.mjs OBTAIN_COSTS (module load, process.env only)'] }),
	// coordinator/src/obtain-runner.mjs FILL_LEGS: read once at module load.
	entry({ name: 'obtain.fillLegs', env: 'MINEAGEN_OBTAIN_FILL_LEGS', side: 'coordinator', default: true, parser: OFF_EXACT, status: 'default-on',
		reason: 'A walk to water goes in 10 s legs and fills at the first source in reach; off is the one 90 s walk to the sighting, for A/B rooms.',
		readers: ['coordinator/src/obtain-runner.mjs FILL_LEGS (module load, process.env only)'] }),
	// coordinator/src/skill-fits.mjs routeLine: per route line.
	entry({ name: 'route.forestPearls', env: 'MINEAGEN_ROUTE_FOREST_PEARLS', side: 'coordinator', default: true, parser: OFF_EXACT, status: 'default-on',
		reason: 'In the Nether, standing in a warped forest with pearls short, the route line names the enderman hunt there before the fortress.',
		readers: ['coordinator/src/skill-fits.mjs routeLine (per call, process.env)'] }),
	// coordinator/src/obtain-runner.mjs FILL_EDGE: read once at module load.
	entry({ name: 'obtain.fillEdge', env: 'MINEAGEN_OBTAIN_FILL_EDGE', side: 'coordinator', default: true, parser: OFF_EXACT, status: 'default-on',
		reason: 'A walk to water that ends at an edge over water 3-8 blocks below digs down beside the drop and fills there (room kit-gate-6); off is the A/B off arm.',
		readers: ['coordinator/src/obtain-runner.mjs FILL_EDGE (module load, process.env only)'] }),
	// coordinator/src/kit-habit.mjs kitHabitEnabled(environment): per call.
	entry({ name: 'kit.habit', env: 'MINEAGEN_KIT_HABIT', side: 'coordinator', default: true, parser: OFF_WORD, status: 'default-on',
		reason: 'Keeps a shield, iron armour and food in reach after each obtain; off is the A/B off arm (#32).',
		readers: ['coordinator/src/kit-habit.mjs kitHabitEnabled (per call)'] }),
	// coordinator/src/night-cover.mjs nightMoveStop(..., { environment }): per call.
	entry({ name: 'night.cover', env: 'MINEAGEN_NIGHT_COVER', side: 'coordinator', default: true, parser: OFF_WORD, status: 'default-on',
		reason: 'Keeps an unarmoured bot under cover on its first night; off restores the old climb-out for room A/Bs (#117).',
		readers: ['coordinator/src/night-cover.mjs nightMoveStop (per call)'] }),
	// coordinator/src/native-minecraft-tools.mjs programToolsOffered(environment): per call.
	entry({ name: 'tools.program', env: 'MINEAGEN_PROGRAM_TOOLS', side: 'coordinator', default: false, parser: ON_WORD, status: 'default-off',
		reason: 'Rounds 4-6 called runProgram 21 times in 7,653 calls and the 22 Nov checkpoint round made 27 program-tool calls in 25,038, so the six program tools leave the tool list unless on (#145).',
		readers: ['coordinator/src/native-minecraft-tools.mjs programToolsOffered (per call)'] }),
	// coordinator/src/experience-store.mjs experienceSettings(environment): at startup; an unknown value refuses to start.
	entry({ name: 'experience', env: 'MINEAGEN_EXPERIENCE', side: 'coordinator', default: 'off', parser: oneOf(['off', 'lessons'], 'off'), status: 'experimental',
		reason: 'Lessons from earlier games and this game\'s death review (issue #2 Step 4, #17).',
		readers: ['coordinator/src/experience-store.mjs experienceSettings (startup, throws on an unknown mode)'] }),
	// coordinator/src/experience-store.mjs experienceSettings(environment): at startup, only when experience is on.
	entry({ name: 'experience.frozen', env: 'MINEAGEN_EXPERIENCE_FROZEN', side: 'coordinator', default: false, parser: flag({ token: '1', means: 'on' }), status: 'default-off',
		reason: 'Makes the lesson store read-only, for evaluation rounds (#17).',
		readers: ['coordinator/src/experience-store.mjs experienceSettings (startup)'] }),
	// coordinator/src/reflexes.mjs instinctsEnabled(environment): per call. Instincts.java enabled(): per call.
	// On by default since #185, so practice rooms play as model games do. MINEAGEN_INSTINCTS=off (any list without
	// `instincts`) turns both halves off, unless -Dmineagen.instincts=true turns the mod's half back on (either source on
	// is on); -Dmineagen.instincts=false with the variable unset turns only the mod's half off, since the coordinator
	// cannot see the server's -D flags.
	entry({ name: 'instincts', env: 'MINEAGEN_INSTINCTS', property: 'mineagen.instincts', side: 'both', default: true, parser: listHas('instincts', { unset: true }),
		propertyParser: JAVA_GET_BOOLEAN, status: 'default-on',
		reason: 'Issue 2 Step 2 instincts arm: stance, heal, pace, fight-through, weapon and food (#24). All 300 practice rooms x10, 23 Nov: passes 2,786 of 3,203 off against 2,811 of 3,218 on, deaths 75 against 63; one room changed: travel fights through a zombie instead of stopping (#185).',
		readers: ['coordinator/src/reflexes.mjs instinctsEnabled (per call; env only)', 'Instincts.java enabled (per call; property or env)'] }),
	// coordinator/src/reflexes.mjs dimensionReflexes(environment): per call (dynamic-main at startup, each ReflexBook).
	entry({ name: 'end.fallCatch', env: 'MINEAGEN_END_FALL_CATCH', side: 'coordinator', default: true, parser: OFF_WORD, status: 'default-on',
		reason: 'Arms default-end-fall in the End: a fall of 4+ blocks places the water bucket below. End knock-off room, 10 runs a side: 60 of 60 throws caught against 0 of 60, deaths 0 against 30 (#277). off drops the rule; the equal-priority tie-break for falling rules stays in the mod.',
		readers: ['coordinator/src/reflexes.mjs dimensionReflexes (per call)'] }),
	// coordinator/src/dragon-fight-facts.mjs endCrystalFact(..., environment): per call.
	entry({ name: 'end.highDescent', env: 'MINEAGEN_END_HIGH_DESCENT', side: 'coordinator', default: true, parser: OFF_WORD, status: 'default-on',
		reason: 'Feet above y75 in the End, the crystal fact adds how to come down a built column: dig_to shaft to the ground, no water poured on the top. In End games, 5 of 6 descents from y95+ died, each after a pour on the top or a sideways dig. off leaves the advice out.',
		readers: ['coordinator/src/dragon-fight-facts.mjs endCrystalFact (per call)'] }),
	// coordinator/src/need-sources.mjs pearlTarget(text, environment): per call.
	entry({ name: 'route.pearlPlan', env: 'MINEAGEN_ROUTE_PEARL_PLAN', side: 'coordinator', default: true, parser: OFF_WORD, status: 'default-on',
		reason: 'Pearl lines count toward the eye plan (15 pearls) or a larger step count, instead of the step\'s own count or 12. A check naming the frame\'s 12 eyes stopped the pearl hunt at 12 while the route asked for 15, and 1 in 5 thrown eyes breaks. off keeps the step count.',
		readers: ['coordinator/src/need-sources.mjs pearlTarget (per call)'] }),
	// ServerTravelController.java walkAroundEnabled(): per call; property or env.
	entry({ name: 'travel.walkAround', env: 'MINEAGEN_TRAVEL_WALK_AROUND', property: 'mineagen.travel.walkAround', side: 'server', default: false, parser: ON_WORD,
		propertyParser: JAVA_GET_BOOLEAN, status: 'default-off',
		reason: 'Practice rooms 21 Nov (Nether courses): pickaxe uses per 100 blocks gained 69.8 on against 60.2 off (50 runs each), and 148.6 against 141.8 (34 each) (#68).',
		readers: ['ServerTravelController.java walkAroundEnabled (per call)'] }),
	// ServerTravelController.java shallowShoreEnabled(): per call; property or env.
	entry({ name: 'travel.shallowShore', env: 'MINEAGEN_TRAVEL_SHALLOW_SHORE', property: 'mineagen.travel.shallowShore', side: 'server', default: true,
		parser: flag({ token: 'false', means: 'off', trim: true, anyCase: true }), propertyParser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'In one-deep water the body stands and walks on the bed instead of holding jump and bobbing: the swim out stops over a shallow bank, and navigation jumps only at a step up or against the bank. In 8 fresh games 40 of 47 travel water timeouts (NO_ROUTE, about 39 min) ended bobbing over such a bank; false keeps the held jump.',
		readers: ['ServerTravelController.java shallowShoreEnabled (per call)', 'ServerNavigationController.java jumpPending via shallowShoreEnabled (per call)'] }),
	// ServerRetraceController.java skipBuriedEnabled(): per call; property only.
	entry({ name: 'travel.skipBuried', property: 'mineagen.travel.skipBuried', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'Retrace passes a remembered footstep that is now filled with solid blocks (often its own stair steps placed over an old tunnel) and heads for the next open one. In 8 fresh games 32 of 37 one-minute retrace stalls (about 39 min) had the body 1-6 blocks above a nearby footstep; false keeps aiming at them.',
		readers: ['ServerRetraceController.java skipBuriedEnabled (per call)'] }),
	// ServerTravelController.java GAZE_GUARD: read once at class load.
	entry({ name: 'travel.gazeGuard', property: 'mineagen.travel.gazeGuard', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'travel_to scans, peeks and bridges with its own looks, which skipped the calm-enderman gaze guard its walking legs already have; in a warped forest a scan can meet an enderman\'s eyes and provoke it mid-walk.',
		readers: ['ServerTravelController.java GAZE_GUARD (class load)'] }),
	// ServerTravelController.java ENDERMAN_FIGHT: read once at class load.
	entry({ name: 'travel.endermanFight', property: 'mineagen.travel.endermanFight', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'An angry enderman that hits or closes on the body during travel_to is fought there (sword or axe, health above minHealth and one of its hits) instead of stopping the trip, so the body does not stand still through the next model turn while it keeps hitting.',
		readers: ['ServerTravelController.java ENDERMAN_FIGHT (class load)'] }),
	// ServerFightUntilController.java CHARGE_GUARD: static final, class load.
	entry({ name: 'fight.chargeGuard', property: 'mineagen.fight.chargeGuard', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'Raises the shield before a charged blaze\'s volley; false is the fixture A/B off arm.',
		readers: ['ServerFightUntilController.java CHARGE_GUARD (class load)'] }),
	// ServerFightUntilController.java RECOVER: static final, class load.
	entry({ name: 'fight.recover', property: 'mineagen.fight.recover', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'Backs off to heal during a fight; false is the fixture A/B off arm.',
		readers: ['ServerFightUntilController.java RECOVER (class load)'] }),
	// ServerActionExecutor.java FLOOR_LAVA_GUARD: static (tests reassign it), class load.
	entry({ name: 'dig.floorLavaGuard', property: 'mineagen.dig.floorLavaGuard', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'break_block never breaks the floor under the feet with lava heard or seen at it, even with acceptLavaRisk; 1 of 7 lava deaths in 8 fresh games dropped into a pool that way.',
		readers: ['ServerActionExecutor.java FLOOR_LAVA_GUARD (class load)'] }),
	// ReflexActions.java LeaveFire.PLUG_INFLOW: static (tests reassign it), class load.
	entry({ name: 'reflex.plugInflow', property: 'mineagen.reflex.plugInflow', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'Before stepping back from lava seen coming, the lava reflex puts one block in the cell it flows in through; 1 of 7 lava deaths in 8 fresh games backed off a dug-into flow that then followed it.',
		readers: ['ReflexActions.java LeaveFire.PLUG_INFLOW (class load)'] }),
	// SpawnerHold.java ENABLED: static final, class load.
	entry({ name: 'fight.spawnerHold', property: 'mineagen.fight.spawnerHold', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'Holds a blaze spawner from a roofed cell; staged fortress runs lost 12 of 28 deaths to wither skeletons on open decks (#89).',
		readers: ['SpawnerHold.java ENABLED (class load)'] }),
	// SpawnerHold.java OPEN_FIGHT: static final, class load.
	entry({ name: 'fight.spawnerHoldOpen', property: 'mineagen.fight.spawnerHoldOpen', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'Fights in the open and walls in only to heal; real fortress room: the open fight kept 39 rods in 9 runs, the cell fight 7 (#89).',
		readers: ['SpawnerHold.java OPEN_FIGHT (class load)'] }),
	// WarpedForestHunt.java enabled: static (tests reassign it), class load.
	entry({ name: 'fight.forestHunt', property: 'mineagen.fight.forestHunt', side: 'server', default: false, parser: JAVA_GET_BOOLEAN, status: 'default-off',
		reason: 'Forest-walking pearl hunt: ended 22 of 40 forest hunts with a pearl against 13, but died in 9 against 4 (#78).',
		readers: ['WarpedForestHunt.java enabled (class load)'] }),
	// ServerFightUntilController.java fullIds(): per fight call.
	entry({ name: 'fight.fullIds', property: 'mineagen.fight.fullIds', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: 'fight_until keeps the mob and item ids it was given in full ("ender_pearl" -> "minecraft:ender_pearl"), so forest mode and drop pickup match bare ids from the model.',
		readers: ['ServerFightUntilController.java fullIds (per call)'] }),
	// UnreachableTargets.java fromProperty(): per fight call.
	entry({ name: 'fight.skipUnreachable', property: 'mineagen.fight.skipUnreachable', side: 'server', default: true, parser: JAVA_NOT_FALSE_EXACT, status: 'default-on',
		reason: '21 Nov room benchmark: the unreachable-enderman room passed 0 of 10 off and 10 of 10 on (added off in #39).',
		readers: ['UnreachableTargets.java fromProperty (per call)'] }),
	// KillSighting.java enabled(): per call.
	entry({ name: 'killPosition', property: 'mineagen.killPosition', side: 'server', default: true, parser: flag({ token: 'false', means: 'off', trim: true, anyCase: true }), status: 'default-on',
		reason: 'Sends where a seen kill died; false withholds it from the wire as an A/B arm (#25).',
		readers: ['KillSighting.java enabled (per call)'] }),
	// Watcher.java enabled(): per call.
	entry({ name: 'watch', property: 'mineagen.watch', side: 'server', default: false, parser: flag({ token: 'true', means: 'on', trim: true, anyCase: true }), status: 'diagnostic',
		reason: 'Writes the arena-watch progress and danger logs the quality reports read; off on players\' servers because it scans the world every few ticks.',
		readers: ['Watcher.java enabled (per call)'] }),
]);

const BY_NAME = new Map(SWITCHES.map((item) => [item.name, item]));
if (BY_NAME.size !== SWITCHES.length) throw new Error('switch names must be unique');

function parseOrRefuse(item, parser, raw, label) {
	try { return parser.parse(raw); } catch (error) {
		if (error instanceof SwitchValueError) throw new SwitchValueError(`${label} ${error.message}`);
		throw error;
	}
}

/**
 * One switch's value and where it came from: `default`, `env`, `property`, or `unseen` when the value could depend on a
 * Java property this process cannot read (the coordinator never sees the server's -D flags; pass `properties` to say).
 */
function resolveOne(item, env, properties) {
	const raw = item.env ? env?.[item.env] : undefined;
	const fromEnv = raw == null ? null : parseOrRefuse(item, item.parser, raw, item.env);
	if (!item.property) return fromEnv === null ? { value: item.default, source: 'default' } : { value: fromEnv, source: 'env' };
	// Two sources are on when either is (the readers OR them): a true env value settles it without the property.
	if (fromEnv === true) return { value: true, source: 'env' };
	if (properties == null) return { value: fromEnv ?? item.default, source: 'unseen' };
	const propertyRaw = properties[item.property];
	const fromProperty = propertyRaw === undefined || propertyRaw === null ? null
		: parseOrRefuse(item, item.env ? item.propertyParser : item.parser, propertyRaw, `-D${item.property}`);
	if (!item.env) return fromProperty === null ? { value: item.default, source: 'default' } : { value: fromProperty, source: 'property' };
	if (fromProperty === true) return { value: true, source: 'property' };
	if (fromEnv !== null) return { value: false, source: 'env' };
	if (fromProperty !== null) return { value: false, source: 'property' };
	return { value: item.default, source: 'default' };
}

/**
 * Every switch resolved: Map name -> { value, source }. `properties` is the server's Java properties when known (a
 * launcher that sets -D flags can pass them); without it, property switches report `unseen`. A value its reader would
 * refuse (an unknown experience mode) throws SwitchValueError, as the reader does.
 */
export function resolveSwitches(env = process.env, { properties = null, sides = SIDES } = {}) {
	const resolved = new Map();
	for (const item of SWITCHES) if (sides.includes(item.side)) resolved.set(item.name, Object.freeze(resolveOne(item, env, properties)));
	return resolved;
}

/** One switch by name, resolved: { value, source }. */
export function getSwitch(name, env = process.env, options = {}) {
	const item = BY_NAME.get(name);
	if (!item) throw new TypeError(`unknown switch ${name}`);
	return Object.freeze(resolveOne(item, env, options.properties ?? null));
}

export const switchEntry = (name) => BY_NAME.get(name) ?? null;

function shown(value) {
	if (value === true) return 'on';
	if (value === false) return 'off';
	if (Array.isArray(value)) return value.length ? value.join(',') : '-';
	return String(value);
}

/**
 * The resolved set for a startup log line and a result record. `line` is `switches name=value ...` with `@env` or
 * `@property` after a value that was set and `?` after one the process could not see; `record` is JSON-safe
 * { name: { value, source } }. The Java mirror's describe() writes the same line for its switches (for ASCII values).
 */
export function describeSwitches(resolved) {
	const words = [];
	const record = {};
	for (const [name, { value, source }] of resolved) {
		words.push(`${name}=${shown(value)}${source === 'default' ? '' : source === 'unseen' ? '?' : `@${source}`}`);
		record[name] = { value: Array.isArray(value) ? [...value] : value, source };
	}
	return Object.freeze({ line: `switches ${words.join(' ')}`, record });
}
