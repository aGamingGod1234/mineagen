// A fake body checks every move the way the production body does before it runs it, so a move the game refuses (a
// travel_to tolerance of 0.5, where the schema's minimum is 1) fails its unit test instead of failing in a game.
// Twice on 22 Nov a refused move passed every test: the runtime rejects it before dispatch, so a fake that accepts
// anything never sees it.
//
// Two production bodies drive the helpers, and they check different calls (coordinator/src/native-tool-runtime.mjs):
// - the search body (#searchBody: find, night cover, search danger, eyes, portal room) normalizes act through
//   normalizeMinecraftToolCall('act'), except escape, which it runs directly, and builds look as a lookAround;
// - the obtain body (#executeObtain: obtain, kit habit, loot) normalizes act, mine, moveTo and gather, and closes a
//   menu as act menu_close; its look is the search body's.
// The wrap only checks: the fake still gets the raw arguments, so tests that assert on what was sent stay as they are.
// An act assigned to a wrapped body later is wrapped as it is assigned.
// A refused move rejects, and it is also recorded, so a runner that swallows the throw (production obtain turns it
// into a FAILED result) still fails the test file when its tests end.
import { after } from 'node:test';
import { normalizeMinecraftToolCall } from '../../src/native-minecraft-tools.mjs';

export const CHECKED_BODY = Symbol.for('mineagen.test.checkedBody');
const refusals = [];

after(() => {
	const unexpected = refusals.filter((row) => !row.allowed);
	if (unexpected.length > 0) {
		throw new Error(`${unexpected.length} fake-body move(s) the real tool refuses:\n${unexpected.map((row) => `  ${row.call}: ${row.message}`).join('\n')}`);
	}
});

function check(name, args, call, allowed) {
	try {
		const normalized = normalizeMinecraftToolCall(name, args);
		if (name === 'act' && normalized.kind !== 'action') throw new Error(`expected one body action, got ${normalized.kind}`);
		return normalized;
	} catch (error) {
		refusals.push({ call, message: String(error?.message ?? error), allowed });
		const refused = new Error(`fake body: the real tool refuses ${call}: ${error?.message ?? error}`);
		refused.code = error?.code ?? 'INVALID_MINECRAFT_TOOL_ARGUMENTS';
		throw refused;
	}
}

const describe = (name, args) => { try { return `${name} ${JSON.stringify(args)}`; } catch { return name; } };

/** Checks one act as the search body does: escape runs directly, every other action goes through the act tool. */
export function checkSearchAct(actionType, args, { allowRefusals = false } = {}) {
	if (actionType === 'escape') return;
	check('act', { actionType, arguments: args }, describe(actionType, args), allowRefusals);
}

/** Checks one act as the obtain body does: every action goes through the act tool, escape included. */
export function checkObtainAct(actionType, args, { allowRefusals = false } = {}) {
	check('act', { actionType, arguments: args }, describe(actionType, args), allowRefusals);
}

function checkLook(args, allowRefusals) {
	const { pitch, survey } = args ?? {};
	check('lookAround', { centerYaw: 0, pitch, steps: 4, ticksPerStep: 2, survey }, describe('look', args), allowRefusals);
}

const CHECKED_FUNCTION = Symbol('checked');

// The method becomes an accessor, so an act a test assigns later (body.act = async (...) => ...) is checked too; a
// spread copy of the body ({ ...body }) copies the checked function.
function wrap(body, key, checker) {
	if (typeof body[key] !== 'function') return;
	const checked = (fn) => {
		if (typeof fn !== 'function' || fn[CHECKED_FUNCTION]) return fn;
		// Production body moves are async, so a refusal comes back as a rejected promise, never a synchronous throw.
		const wrapped = function checkedMove(...args) {
			try { checker(...args); } catch (error) { return Promise.reject(error); }
			return fn.apply(this, args);
		};
		wrapped[CHECKED_FUNCTION] = true;
		return wrapped;
	};
	let current = checked(body[key]);
	Object.defineProperty(body, key, { configurable: true, enumerable: true, get: () => current, set: (fn) => { current = checked(fn); } });
}

function mark(body) {
	Object.defineProperty(body, CHECKED_BODY, { value: true, enumerable: false, configurable: true });
	return body;
}

/**
 * Wraps a fake search body in place (find, night cover, search danger, eyes, portal room) and returns it.
 * allowRefusals: for a test that sends a refused move on purpose; the move still throws but does not fail the file.
 */
export function checkedSearchBody(body, { allowRefusals = false } = {}) {
	if (body[CHECKED_BODY]) return body;
	wrap(body, 'act', (actionType, args) => checkSearchAct(actionType, args, { allowRefusals }));
	wrap(body, 'look', (args) => checkLook(args, allowRefusals));
	return mark(body);
}

/** Wraps a fake obtain body in place (obtain, kit habit, loot) and returns it. */
export function checkedObtainBody(body, { allowRefusals = false } = {}) {
	if (body[CHECKED_BODY]) return body;
	wrap(body, 'act', (actionType, args) => checkObtainAct(actionType, args, { allowRefusals }));
	wrap(body, 'mine', (args) => check('mine', args, describe('mine', args), allowRefusals));
	wrap(body, 'moveTo', (args) => check('moveTo', args, describe('moveTo', args), allowRefusals));
	wrap(body, 'gather', ({ itemIds, ...args } = {}) => check('gather', { itemId: itemIds?.[0], ...args }, describe('gather', { itemIds, ...args }), allowRefusals));
	wrap(body, 'closeMenu', (args) => check('act', { actionType: 'menu_close', arguments: args }, describe('menu_close', args), allowRefusals));
	wrap(body, 'look', (args) => checkLook(args, allowRefusals));
	return mark(body);
}
