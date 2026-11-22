// Every fake body a helper test drives must check its moves against the real tool (test/helpers/checked-body.mjs):
// a fake that accepts anything let a refused move pass its tests and fail in the game twice on 22 Nov.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedObtainBody, checkedSearchBody } from './helpers/checked-body.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// The helpers that take a body and send it moves, by the module a test imports them from.
const BODY_MODULES = ['find-search', 'obtain-runner', 'kit-habit', 'loot-step', 'find-eyes', 'find-portal-room', 'inventory-repair'];
// Test files that drive a body helper without a checked fake, each with the reason it needs none.
const EXEMPT = new Map([
	['test/inventory-repair.test.mjs', 'drives repair through the real NativeToolRuntime with a fake bridge, so production normalization runs; its one direct runInventoryRepair fake must refuse before any move (act is assert.fail)'],
]);
// The helpers' entry points that take a body; tests import them from the helper, which wraps the body on every call.
const ENTRY_POINTS = ['searchFor', 'runObtain', 'keepKit', 'lootChest'];
const HELPER_IMPORT = /from '\.\/helpers\/checked-body\.mjs'/;
// A fake's act: a key, a method, a local function, or shorthand on a body object.
const DEFINES_ACT = /\bact\s*:|\basync\s+act\s*\(|\b(?:const|let)\s+act\s*=|[{,]\s*act\s*[,}]/;
// A static import, or a dynamic one (a test that can load another checkout's source: FIND_SEARCH_SOURCE).
const IMPORTS_BODY_MODULE = new RegExp(`(?:from |import\\()[^;]*['"]\\.\\./src/(?:${BODY_MODULES.join('|')})\\.mjs['"]`);
const MODULE = `['"]\\.\\./src/(?:${BODY_MODULES.join('|')})\\.mjs['"]`;
const STATIC_ENTRY_IMPORT = new RegExp(`^import \\{([^}]*)\\} from ${MODULE}`, 'gm');
// A dynamic import that destructures an entry point, a namespace (import * as, or a dynamic import kept whole) whose
// entry point the file uses, or a dynamic import's entry point not handed straight to checkedSearchFor or
// checkedRunObtain (how a test runs another checkout's source).
const DYNAMIC_DESTRUCTURE = new RegExp(`\\{([^}]*)\\}\\s*=\\s*await import\\([^;]*${MODULE}`, 'g');
const NAMESPACE = new RegExp(`import \\* as (\\w+) from ${MODULE}|(?:const|let) (\\w+)\\s*=\\s*await import\\([^;]*${MODULE}\\)`, 'g');
const DYNAMIC_MEMBER = new RegExp(`(.{0,40})\\(await import\\([^;]*${MODULE}\\)\\)\\.(\\w+)`, 'g');

async function testFiles(dir = 'test') {
	const entries = await readdir(path.join(root, dir), { withFileTypes: true });
	const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? testFiles(path.join(dir, entry.name))
		: /\.test\.mjs$/.test(entry.name) ? [path.join(dir, entry.name).split(path.sep).join('/')] : []));
	return nested.flat();
}

test('every source module that sends a body moves is listed as a body helper', async () => {
	const sources = (await readdir(path.join(root, 'src'))).filter((name) => name.endsWith('.mjs'));
	const senders = [];
	for (const name of sources) {
		const text = await readFile(path.join(root, 'src', name), 'utf8');
		if (/\b\w*[bB]ody\??\.(?:act|mine|moveTo|gather|closeMenu|look)\(/.test(text)) senders.push(name.replace(/\.mjs$/, ''));
	}
	assert.deepEqual(senders.filter((name) => !BODY_MODULES.includes(name)), [],
		'a new module sends a body moves: add it to BODY_MODULES so its tests must use a checked fake body');
});

test('tests call the body helpers through the checked entry points, so every body they pass is checked', async () => {
	const direct = [];
	for (const file of await testFiles()) {
		if (EXEMPT.has(file)) continue;
		const text = await readFile(path.join(root, file), 'utf8');
		for (const [, names] of text.matchAll(STATIC_ENTRY_IMPORT)) {
			for (const name of names.split(',').map((entry) => entry.trim().split(/\s+as\s+/)[0])) {
				if (ENTRY_POINTS.includes(name)) direct.push(`${file}: ${name}`);
			}
		}
		for (const [, names] of text.matchAll(DYNAMIC_DESTRUCTURE)) {
			for (const name of names.split(',').map((entry) => entry.trim().split(/\s*:\s*/)[0])) {
				if (ENTRY_POINTS.includes(name)) direct.push(`${file}: ${name} (dynamic import)`);
			}
		}
		for (const [, star, whole] of text.matchAll(NAMESPACE)) {
			const name = star ?? whole;
			for (const entry of ENTRY_POINTS) if (new RegExp(`\\b${name}\\.${entry}\\b`).test(text)) direct.push(`${file}: ${name}.${entry}`);
		}
		for (const [, before, entry] of text.matchAll(DYNAMIC_MEMBER)) {
			if (ENTRY_POINTS.includes(entry) && !/\bchecked(?:SearchFor|RunObtain)\(\s*$/.test(before)) direct.push(`${file}: ${entry} (dynamic import)`);
		}
	}
	assert.deepEqual(direct, [], `import ${ENTRY_POINTS.join(', ')} from './helpers/checked-body.mjs', not from src`);
});

test('every fake body a body-helper test drives checks its moves against the real tool', async () => {
	const unchecked = [];
	for (const file of await testFiles()) {
		const text = await readFile(path.join(root, file), 'utf8');
		if (!IMPORTS_BODY_MODULE.test(text) || !DEFINES_ACT.test(text)) continue;
		if (HELPER_IMPORT.test(text) || EXEMPT.has(file)) continue;
		unchecked.push(file);
	}
	assert.deepEqual(unchecked, [],
		'wrap each fake body with checkedSearchBody or checkedObtainBody from test/helpers/checked-body.mjs (or list the file in EXEMPT with its reason)');
});

test('every exemption still names a test file that drives a body helper', async () => {
	const files = new Set(await testFiles());
	for (const [file, reason] of EXEMPT) {
		assert.ok(files.has(file), `${file} is exempt but no longer exists`);
		assert.ok(reason.length > 20, `${file} needs a reason`);
		const text = await readFile(path.join(root, file), 'utf8');
		assert.ok(IMPORTS_BODY_MODULE.test(text), `${file} no longer drives a body helper: drop its exemption`);
	}
});

test('a checked body refuses what the real tool refuses, including an act assigned after the wrap', async () => {
	const ran = [];
	const body = checkedSearchBody({ act: async (type) => { ran.push(type); return { state: 'SUCCEEDED' }; } }, { allowRefusals: true });
	await body.act('travel_to', { x: 1, y: 64, z: 1, tolerance: 1 });
	await assert.rejects(body.act('travel_to', { x: 1, y: 64, z: 1, tolerance: 0.5 }), /tolerance must be between 1 and 64/);
	body.act = async (type) => { ran.push(`late ${type}`); return { state: 'SUCCEEDED' }; };
	await assert.rejects(body.act('travel_to', { x: 1, y: 64, z: 1, tolerance: 0.5 }), /tolerance/);
	assert.deepEqual(ran, ['travel_to'], 'a refused move never reaches the fake');
	const copy = { ...body };
	await assert.rejects(copy.act('travel_to', { x: 1, y: 64, z: 1, tolerance: 0.5 }), /tolerance/, 'a spread copy keeps the check');
});

test('the search body checks escape against the action schema and the obtain body sends it through act, as production does', async () => {
	const search = checkedSearchBody({ act: async () => ({ state: 'SUCCEEDED' }) }, { allowRefusals: true });
	await search.act('escape', {});
	await assert.rejects(search.act('escape', { anything: true }), /Unknown field 'anything'/, 'the bridge still checks escape against the action schema');
	const obtain = checkedObtainBody({ act: async () => ({ state: 'SUCCEEDED' }), mine: async () => ({ state: 'SUCCEEDED' }), closeMenu: async () => ({ state: 'SUCCEEDED' }) }, { allowRefusals: true });
	await assert.rejects(obtain.act('escape', {}), /refuses escape/);
	await assert.rejects(obtain.mine({ not: 'a mine argument' }), /refuses mine/);
	await assert.rejects(obtain.closeMenu({}), /refuses menu_close/);
});

test('a move the fake had no method for at the wrap, or a second body kind, is checked too', async () => {
	const body = checkedObtainBody(checkedSearchBody({ act: async () => ({ state: 'SUCCEEDED' }) }, { allowRefusals: true }), { allowRefusals: true });
	await assert.rejects(body.act('escape', {}), /refuses escape/, 'the obtain wrap adds its own act check over the search one');
	assert.deepEqual(Object.keys(checkedObtainBody(body)), ['act'], 'methods the fake never had stay out of its keys, wrapped twice or not');
	body.moveTo = async () => ({ state: 'SUCCEEDED' });
	await assert.rejects(body.moveTo({ bogus: true }), /refuses moveTo/);
});
