// A shared start-validity check for practice rooms: a room declares what a good start is (footing, the mobs that must be
// there, health, inventory, time of day), reads the start once it is set up, and a bad start marks the row notExercised,
// so roomVerdict reads it INVALID (a replay, never a bot failure). Rooms adopt it one at a time:
//   const start = await readStart(text => s.command(text), AGENT, SPEC, { sight });
//   markStart(row, checkStart(SPEC, start));
// Every world test is anchored at the body (execute at AGENT ...), never at the command's origin: a mob "nearest" to the
// server origin is not the mob that threatens the body.

/**
 * spec:
 *   footing   { notIn: ['leaves', 'fluid'], solidBelow: true }   no leaves or water/lava in the feet or head cell; the body on the ground
 *   mobs      [{ type: 'minecraft:skeleton', min: 1, within: 16, inSight: true }]   at least min of type within that many blocks
 *             of the body (and, with inSight, the nearest one in the body's line of sight, as the room's sight() judges)
 *   health    { min: 20, max: 20 }
 *   inventory { has: { 'minecraft:shield': 1 }, lacks: ['minecraft:water_bucket'] }
 *   time      { from: 0, to: 12000 }   day time in ticks (from > to wraps over midnight)
 * start: what readStart read (or a room's own record): { body, health, feet, head, below, mobs, inventory, timeOfDay }.
 * A value the start does not hold is unknown, and an unknown that the spec asks about fails: a start that cannot be
 * shown good is not counted.
 */
export function checkStart(spec, start) {
	const failures = [], fail = (check, reason) => failures.push({ check, reason });
	const known = value => value !== undefined && value !== null;
	if (spec.footing) {
		for (const cell of ['feet', 'head']) for (const bad of spec.footing.notIn ?? []) {
			const value = start[cell]?.[bad];
			if (!known(value)) fail('footing', `${cell} cell: ${bad} unknown`);
			else if (value) fail('footing', `${bad} in the body's ${cell} cell${typeof value === 'string' ? ` (${value})` : ''}`);
		}
		if (spec.footing.solidBelow) {
			if (!known(start.below?.solid)) fail('footing', 'ground under the body unknown');
			else if (!start.below.solid) fail('footing', 'no solid block under the body');
		}
	}
	for (const [index, want] of (spec.mobs ?? []).entries()) {
		// Each requirement reads its own observations (mob.for, from readStart), so one mob never counts for two of them.
		const mobs = (start.mobs ?? []).filter(mob => mob.type === want.type && (mob.for === undefined || mob.for === index));
		const within = Number.isFinite(want.within) ? want.within : Infinity;
		const near = mobs.filter(mob => Number.isFinite(mob.distance) && mob.distance <= within);
		const min = want.min ?? 1;
		if (!start.mobs) { fail('mobs', `${want.type}: mobs unknown`); continue; }
		if (near.length < min) {
			const nearest = mobs.filter(mob => Number.isFinite(mob.distance)).sort((a, b) => a.distance - b.distance)[0];
			fail('mobs', `${near.length} ${want.type} within ${within} blocks, wants ${min}${nearest ? ` (nearest ${Math.round(nearest.distance)} blocks away)` : ''}`);
			continue;
		}
		if (want.inSight) {
			const seen = near.filter(mob => mob.inSight === true).length, unknown = near.some(mob => !known(mob.inSight));
			if (seen < min) fail('mobs', unknown && !seen ? `${want.type} in sight unknown` : `${seen} ${want.type} in sight within ${within} blocks, wants ${min}`);
		}
	}
	if (spec.health) {
		if (!Number.isFinite(start.health)) fail('health', 'health unknown');
		else if (Number.isFinite(spec.health.min) && start.health < spec.health.min) fail('health', `health ${start.health}, wants at least ${spec.health.min}`);
		else if (Number.isFinite(spec.health.max) && start.health > spec.health.max) fail('health', `health ${start.health}, wants at most ${spec.health.max}`);
	}
	if (spec.inventory) {
		for (const [item, count] of Object.entries(spec.inventory.has ?? {})) {
			const held = start.inventory?.[item];
			if (!Number.isFinite(held)) fail('inventory', `${item} count unknown`);
			else if (held < count) fail('inventory', `${held} ${item}, wants ${count}`);
		}
		for (const item of spec.inventory.lacks ?? []) {
			const held = start.inventory?.[item];
			if (!Number.isFinite(held)) fail('inventory', `${item} count unknown`);
			else if (held > 0) fail('inventory', `holds ${held} ${item}, wants none`);
		}
	}
	if (spec.time) {
		const t = start.timeOfDay, { from = 0, to = 24000 } = spec.time;
		if (!Number.isFinite(t)) fail('time', 'time of day unknown');
		else if (from <= to ? t < from || t > to : t < from && t > to) fail('time', `time of day ${t}, wants ${from}-${to}`);
	}
	return { ok: failures.length === 0, failures };
}

/** A bad start is not a bot failure: the row reads INVALID (notExercised) and keeps what was wrong and what was read. */
export function markStart(row, result, start = null) {
	row.startCheck = { ok: result.ok, failures: result.failures, ...(start ? { start } : {}) };
	if (!result.ok && !row.notExercised) row.notExercised = `bad start: ${result.failures.map(failure => failure.reason).join('; ')}`;
	return row;
}

const passed = reply => /test passed/i.test(String(reply));
const count = reply => { const text = String(reply); return /count: (\d+)/i.test(text) ? Number(/count: (\d+)/i.exec(text)[1]) : /test passed/i.test(text) ? 1 : /test failed/i.test(text) ? 0 : null; };
const vector = reply => String(reply).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
const number = reply => { const match = /(-?\d+(?:\.\d+)?)[a-z]?\s*$/i.exec(String(reply).trim()); return match ? Number(match[1]) : null; };
const FLUID_TESTS = [['minecraft:water', 'water'], ['minecraft:lava', 'lava'], ['minecraft:bubble_column', 'water'], ['minecraft:seagrass', 'water'], ['minecraft:tall_seagrass', 'water'],
	['minecraft:kelp', 'water'], ['minecraft:kelp_plant', 'water'], ...['slabs', 'stairs', 'fences', 'walls', 'trapdoors', 'leaves', 'all_signs', 'candles'].map(tag => [`#minecraft:${tag}[waterlogged=true]`, 'water'])];
const SELECTOR = /^[A-Za-z0-9_]{1,16}$/, ID = /^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/;

/**
 * Reads what the spec asks about with vanilla commands, every test anchored at the body. sight(mob) is the room's own
 * line-of-sight test ({ type, position, distance } -> boolean), needed only when a mob entry asks for inSight. A reply
 * the parser cannot read is unknown (null), which checkStart fails.
 */
export async function readStart(command, agent, spec, { sight = null } = {}) {
	if (!SELECTOR.test(agent)) throw new Error(`readStart wants a player name, got ${agent}`);
	const run = async text => command(text).then(String, () => '');
	const start = { body: vector(await run(`data get entity ${agent} Pos`)) };
	// The feet cell is the block at the body's position; the head cell is the block at its eyes (anchored eyes), so a body
	// standing on a slab at Y 64.5 has its head tested in block 66, where its eyes are, not 65.
	const CELL = { feet: '', head: 'anchored eyes positioned ^ ^ ^ ' };
	const at = (test, cell) => run(`execute at ${agent} ${CELL[cell]}if block ~ ~ ~ ${test}`).then(reply => /test (passed|failed)/i.test(reply) ? passed(reply) : null);
	if (spec.footing) {
		for (const cell of ['feet', 'head']) {
			const facts = {};
			for (const bad of spec.footing.notIn ?? []) {
				if (bad === 'leaves') facts.leaves = await at('#minecraft:leaves', cell);
				else if (bad === 'fluid') {
					// Water also fills underwater plants, bubble columns and waterlogged blocks; a block with a waterlogged state
					// outside these tags is not seen.
					let found = false, unknown = false;
					for (const [test, name] of FLUID_TESTS) {
						const hit = await at(test, cell);
						if (hit === null) unknown = true;
						else if (hit) { found = name; break; }
					}
					facts.fluid = found || (unknown ? null : false);
				}
				else throw new Error(`readStart cannot test ${bad} (leaves or fluid)`);
			}
			start[cell] = facts;
		}
		// Ground support from the body itself: vanilla's OnGround, so a torch or flower below never reads as ground.
		if (spec.footing.solidBelow) { const reply = await run(`execute if entity @a[name=${agent},nbt={OnGround:1b}]`); start.below = { solid: /test (passed|failed)/i.test(reply) ? passed(reply) : null }; }
	}
	if (spec.mobs) {
		start.mobs = [];
		for (const [index, want] of spec.mobs.entries()) {
			if (!ID.test(want.type)) throw new Error(`readStart wants an entity id, got ${want.type}`);
			if (want.inSight && !sight) throw new Error(`${want.type} asks for inSight: give readStart the room's sight()`);
			// Only the nearest mob's position (and so its sight) can be read; a room needing several in sight checks them itself.
			if (want.inSight && (want.min ?? 1) > 1) throw new Error(`${want.type}: readStart can judge sight for one mob; with min ${want.min} give checkStart the room's own mobs list`);
			const within = Number.isFinite(want.within) ? want.within : Infinity;
			// No range asked: every loaded mob of the type counts, as checkStart counts it.
			const range = Number.isFinite(within) ? `,distance=..${within}` : '';
			const n = count(await run(`execute at ${agent} if entity @e[type=${want.type}${range}]`));
			const nearest = vector(await run(`execute at ${agent} run data get entity @e[type=${want.type},limit=1,sort=nearest] Pos`));
			const distance = nearest && start.body ? Math.hypot(...nearest.map((value, i) => value - start.body[i])) : null;
			if (n === null) { start.mobs = null; break; }
			for (let i = 0; i < n; i++) {
				// Only the nearest has a known position; the others are within range by the selector.
				const mob = i === 0 && nearest ? { type: want.type, position: nearest, distance, for: index } : { type: want.type, distance: Number.isFinite(within) ? within : distance, for: index };
				if (want.inSight && i === 0) mob.inSight = await Promise.resolve().then(() => sight(mob)).catch(() => null);
				start.mobs.push(mob);
			}
			// A mob beyond range is still worth recording: "nearest 82 blocks away" tells a room owner what went wrong.
			if (!n && nearest) start.mobs.push({ type: want.type, position: nearest, distance, for: index });
		}
	}
	if (spec.health) start.health = number(await run(`data get entity ${agent} Health`));
	if (spec.inventory) {
		start.inventory = {};
		for (const item of [...Object.keys(spec.inventory.has ?? {}), ...(spec.inventory.lacks ?? [])]) {
			if (!ID.test(item)) throw new Error(`readStart wants an item id, got ${item}`);
			const reply = await run(`clear ${agent} ${item} 0`);
			start.inventory[item] = /found (\d+) matching/i.test(reply) ? Number(/found (\d+) matching/i.exec(reply)[1]) : /no items were found/i.test(reply) ? 0 : null;
		}
	}
	if (spec.time) { const reply = await run('time query daytime'); start.timeOfDay = /time is (\d+)/i.test(reply) ? Number(/time is (\d+)/i.exec(reply)[1]) : null; }
	return start;
}
