import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'acorn';
import * as constants from '../src/constants.mjs';

// The coordinator drops a snapshot whose text is over its bound, and closes the bridge after several in a row
// (#120: an over-long reflex note stranded a game). This contract pairs every text field the coordinator checks in an
// observation or action progress with the place the mod clips it, so a new free-text field cannot ship unclipped.

const PROTOCOL = new URL('../src/protocol-v2.mjs', import.meta.url);
const JAVA = new URL('../../src/main/java/dev/agaminggod/mineagen/', import.meta.url);
const TEXT_CHECKS = new Set(['boundedText', 'boundedCodePointText', 'nullableBoundedText', 'requireText']);
const ROOTS = ['normalizeObservation', 'normalizeActionProgress'];

// Text the mod takes from the game or composes from game text, keyed by the coordinator validator and field. Each row
// gives the coordinator's check and bound (both checked against the source) and the Java clips with their limits.
const UTF16 = 'boundedText';
const CODE_POINTS = 'boundedCodePointText';
const FREE_TEXT = {
	'entityObservation:`${field}.name`': { check: CODE_POINTS, bound: 'MAX_CHAT_LENGTH', java: [['server/perception/ServerObservationCollector.java', /MAX_ENTITY_NAME_CODE_POINTS = (\d+);/g]] },
	'heardObservation:`${field}.sound`': { check: UTF16, bound: 128, java: [['server/perception/HearingPerception.java', /ObservationDetails\.bounded\(shortSound\(value\.heard\(\)\.sound\), (\d+)\)/g]] },
	"lastResultObservation:'lastResult.message'": { check: UTF16, bound: 'MAX_RESULT_MESSAGE_LENGTH', java: [['server/runtime/ServerActionResult.java', /message = bounded\(message, ([\d_]+)\);/g]] },
	"lastResultObservation:'lastResult.reasonCode'": { check: UTF16, bound: 'MAX_REASON_CODE_LENGTH', java: [['server/runtime/ServerActionResult.java', /reasonCode = bounded\(reasonCode, ([\d_]+)\);/g]] },
	"perceptionEvent:'event.name'": { check: CODE_POINTS, bound: 256, java: [['server/perception/PlayerObservationEvents.java', /name = ObservationDetails\.bounded\(name, (\d+)\);/g]] },
	"perceptionEvent:'event.soundId'": { check: UTF16, bound: 256, java: [['server/perception/PlayerObservationEvents.java', /addProperty\("soundId", ObservationDetails\.bounded\(id, (\d+)\)\)/g]] },
	"perceptionEvent:'event.text'": { check: UTF16, bound: 512, java: [['server/perception/PlayerObservationEvents.java', /(?:addProperty\("text", |String bounded = )ObservationDetails\.bounded\([^;]*?, (\d+)\)/g]] },
	"perceptionObservation:'bossBar.name'": { check: UTF16, bound: 256, java: [['server/perception/PlayerObservationEvents.java', /stream\.boss\(id\.toString\(\), ObservationDetails\.bounded\(name\.getString\(\), (\d+)\)/g]] },
	// Reflex notes: the coordinator clips these itself (clipText) before checking, and the mod clips them too.
	'reflexStatusObservation:`reflexes.${key}`': { check: UTF16, bound: 'maximum', java: [['server/runtime/reflex/ReflexEngine.java', /WIRE_DETAIL_CHARS = (\d+);/g]] },
	"reflexStatusObservation:'reflexes.error'": { check: UTF16, bound: 240, java: [['server/runtime/reflex/ReflexEngine.java', /agent\.error\.length\(\) > (\d+) \? agent\.error\.substring\(0, \1\)/g]] },
};

// Text drawn from a fixed vocabulary or identifiers the mod writes itself, never from players or the world.
const FIXED_TEXT = {
	"lastResultObservation:'lastResult.state'": 'action state enum',
	"normalizeActionProgress:'state'": 'action progress state: sendActionProgress writes the literal RUNNING',
	"normalizeActionProgress:'message'": 'action progress message: sendActionProgress never writes one (checked below)',
	"normalizeObservation:'status'": 'observation status code from ServerObservationCollector constants',
	'furnaceObservation:`furnace.${key}`': 'furnace estimate: fixed phrases and numbers, under 100 characters',
	'observedDetails:field': 'generic observed details: bounded at 8192, above every ObservationDetails.bounded clip (checked below)',
	'requireIdentifier:field': 'namespaced ids and UUIDs from game registries, checked against the identifier pattern',
	"reflexStatusObservation:'reflexes.events.id'": 'reflex rule id', "reflexStatusObservation:'reflexes.events.outcome'": 'reflex outcome enum',
	"reflexStatusObservation:'reflexes.firing.id'": 'reflex rule id', "reflexStatusObservation:'reflexes.rules.id'": 'reflex rule id',
	"reflexStatusObservation:'reflexes.rules.kind'": 'reflex kind enum', "reflexStatusObservation:'reflexes.rules.state'": 'reflex state enum',
	"survivalObservation:'survival.signals'": 'survival signal vocabulary', 'threatsObservation:`${field}.signals`': 'threat signal vocabulary',
};

function reachableTextChecks(source) {
	const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
	const functions = new Map();
	for (const node of ast.body) {
		const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
		if (declaration?.type === 'FunctionDeclaration') functions.set(declaration.id.name, declaration);
	}
	const walk = (node, visit) => {
		if (!node || typeof node.type !== 'string') return;
		visit(node);
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) child.forEach((entry) => walk(entry, visit));
			else if (child && typeof child.type === 'string') walk(child, visit);
		}
	};
	const fields = new Map();
	const seen = new Set();
	const queue = [...ROOTS];
	while (queue.length > 0) {
		const name = queue.pop();
		if (seen.has(name) || !functions.has(name)) continue;
		seen.add(name);
		walk(functions.get(name), (node) => {
			if (node.type === 'Identifier' && functions.has(node.name)) queue.push(node.name);
			if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && TEXT_CHECKS.has(node.callee.name)) {
				const [, field, maximum] = node.arguments;
				const key = `${name}:${source.slice(field.start, field.end)}`;
				const check = { check: node.callee.name, bound: maximum && source.slice(maximum.start, maximum.end) };
				assert.ok(!fields.has(key) || JSON.stringify(fields.get(key)) === JSON.stringify(check), `${key} is checked two different ways`);
				fields.set(key, check);
			}
		});
	}
	return fields;
}

test('every text field the coordinator bounds in a snapshot is classified', () => {
	const fields = reachableTextChecks(readFileSync(PROTOCOL, 'utf8'));
	for (const field of fields.keys()) {
		assert.ok(Object.hasOwn(FREE_TEXT, field) || Object.hasOwn(FIXED_TEXT, field),
			`${field} is a new snapshot text field: add the Java clip to FREE_TEXT, or explain in FIXED_TEXT why it cannot grow`);
	}
	for (const field of [...Object.keys(FREE_TEXT), ...Object.keys(FIXED_TEXT)]) {
		assert.ok(fields.has(field), `${field} is no longer checked by the coordinator: remove its row`);
	}
	// The table's bound and unit are the coordinator's own, so lowering a coordinator bound below the mod's clip fails here.
	for (const [field, { check, bound }] of Object.entries(FREE_TEXT)) {
		assert.deepEqual(fields.get(field), { check, bound: String(bound) }, `${field}: the coordinator check changed`);
	}
});

test('the mod clips every free-text snapshot field to the coordinator bound or below', () => {
	for (const [field, { bound, java }] of Object.entries(FREE_TEXT)) {
		const limit = typeof bound === 'number' ? bound : bound === 'maximum' ? 240 : constants[bound];
		assert.equal(typeof limit, 'number', `${field} bound ${bound}`);
		for (const [file, pattern] of java) {
			const matches = [...readFileSync(new URL(file, JAVA), 'utf8').matchAll(pattern)];
			assert.ok(matches.length > 0, `${field}: no clip found in ${file}`);
			for (const [, clip] of matches) assert.ok(Number(clip.replaceAll('_', '')) <= limit, `${field}: ${file} clips at ${clip}, above ${limit}`);
		}
	}
});

test('the mod clips by UTF-16 units, the unit the coordinator counts', () => {
	const details = readFileSync(new URL('server/perception/ObservationDetails.java', JAVA), 'utf8');
	const bounded = details.slice(details.indexOf('static String bounded('));
	const body = bounded.slice(0, bounded.indexOf('\n\t}') + 3);
	assert.match(body, /value\.length\(\) <= maximum/);
	assert.match(body, /Character\.isHighSurrogate/);
	assert.doesNotMatch(body, /codePoint/, 'a cut by code points can leave emoji text twice too long');
	let largest = 0;
	for (const file of ['HearingPerception', 'PlayerHudInspection', 'PlayerObservationEvents', 'ServerObservationCollector', 'ObservationDetails']) {
		const text = readFileSync(new URL(`server/perception/${file}.java`, JAVA), 'utf8');
		for (const [, clip] of text.matchAll(/ObservationDetails\.bounded\([^;]*?, ([\d_]+)\)/g)) largest = Math.max(largest, Number(clip.replaceAll('_', '')));
	}
	assert.ok(largest > 0 && largest <= 8192, `every generic detail clip fits the 8192 detail bound (largest ${largest})`);
	const progress = readFileSync(new URL('server/bridge/MultiplexedServerBridge.java', JAVA), 'utf8');
	const send = progress.slice(progress.indexOf('private void sendActionProgress('));
	assert.doesNotMatch(send.slice(0, send.indexOf('send("action_progress"')), /addProperty\("message"/);
});
