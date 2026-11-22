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
const HELPER_IMPORT = /from '\.\/helpers\/checked-body\.mjs'/;
const IMPORTS_BODY_MODULE = new RegExp(`from '\\.\\./src/(?:${BODY_MODULES.join('|')})\\.mjs'`);
// A fake's act: a key, a method, a local function, or shorthand on a body object.
const DEFINES_ACT = /\bact\s*:|\basync\s+act\s*\(|\b(?:const|let)\s+act\s*=|[{,]\s*act\s*[,}]/;

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
		if (/\bbody\.(?:act|mine|moveTo|gather|closeMenu)\(/.test(text)) senders.push(name.replace(/\.mjs$/, ''));
	}
	assert.deepEqual(senders.filter((name) => !BODY_MODULES.includes(name)), [],
		'a new module sends a body moves: add it to BODY_MODULES so its tests must use a checked fake body');
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

test('the search body runs escape directly and the obtain body checks it, as production does', async () => {
	const search = checkedSearchBody({ act: async () => ({ state: 'SUCCEEDED' }) }, { allowRefusals: true });
	await search.act('escape', { anything: true });
	const obtain = checkedObtainBody({ act: async () => ({ state: 'SUCCEEDED' }), mine: async () => ({ state: 'SUCCEEDED' }), closeMenu: async () => ({ state: 'SUCCEEDED' }) }, { allowRefusals: true });
	await assert.rejects(obtain.act('escape', {}), /refuses escape/);
	await assert.rejects(obtain.mine({ not: 'a mine argument' }), /refuses mine/);
	await assert.rejects(obtain.closeMenu({}), /refuses menu_close/);
});
