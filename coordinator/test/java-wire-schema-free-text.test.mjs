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

// Text the mod takes from the game or composes from game text. Each row names the Java clip and its limit.
const FREE_TEXT = {
	'`${field}.name`': { bound: 'MAX_CHAT_LENGTH', java: [['server/perception/ServerObservationCollector.java', /MAX_ENTITY_NAME_CODE_POINTS = (\d+);/g]] },
	'`${field}.sound`': { bound: 128, java: [['server/perception/HearingPerception.java', /ObservationDetails\.bounded\(shortSound\(value\.heard\(\)\.sound\), (\d+)\)/g]] },
	"'lastResult.message'": { bound: 'MAX_RESULT_MESSAGE_LENGTH', java: [['server/runtime/ServerActionResult.java', /message = bounded\(message, ([\d_]+)\);/g]] },
	"'lastResult.reasonCode'": { bound: 'MAX_REASON_CODE_LENGTH', java: [['server/runtime/ServerActionResult.java', /reasonCode = bounded\(reasonCode, ([\d_]+)\);/g]] },
	"'event.name'": { bound: 256, java: [['server/perception/PlayerObservationEvents.java', /name = ObservationDetails\.bounded\(name, (\d+)\);/g]] },
	"'event.soundId'": { bound: 256, java: [['server/perception/PlayerObservationEvents.java', /addProperty\("soundId", ObservationDetails\.bounded\(id, (\d+)\)\)/g]] },
	"'event.text'": { bound: 512, java: [['server/perception/PlayerObservationEvents.java', /(?:addProperty\("text", |String bounded = )ObservationDetails\.bounded\([^;]*?, (\d+)\)/g]] },
	"'bossBar.name'": { bound: 256, java: [['server/perception/PlayerObservationEvents.java', /stream\.boss\(id\.toString\(\), ObservationDetails\.bounded\(name\.getString\(\), (\d+)\)/g]] },
	// Reflex notes: the coordinator also clips these instead of refusing them.
	'`reflexes.${key}`': { bound: 240, java: [['server/runtime/reflex/ReflexEngine.java', /WIRE_DETAIL_CHARS = (\d+);/g]] },
	"'reflexes.error'": { bound: 240, java: [['server/runtime/reflex/ReflexEngine.java', /agent\.error\.length\(\) > (\d+) \? agent\.error\.substring\(0, \1\)/g]] },
};

// Text drawn from a fixed vocabulary or identifiers the mod writes itself, never from players or the world.
const FIXED_TEXT = {
	"'lastResult.state'": 'action state enum',
	"'state'": 'action progress state: sendActionProgress writes the literal RUNNING',
	"'message'": 'action progress message: sendActionProgress never writes one',
	"'status'": 'observation status code from ServerObservationCollector constants',
	'`furnace.${key}`': 'furnace estimate: fixed phrases and numbers, under 100 characters',
	field: 'generic observed details: bounded at 8192, above every Java clip',
	"'reflexes.events.id'": 'reflex rule id', "'reflexes.events.outcome'": 'reflex outcome enum',
	"'reflexes.firing.id'": 'reflex rule id', "'reflexes.rules.id'": 'reflex rule id',
	"'reflexes.rules.kind'": 'reflex kind enum', "'reflexes.rules.state'": 'reflex state enum',
	"'survival.signals'": 'survival signal vocabulary', '`${field}.signals`': 'threat signal vocabulary',
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
				fields.set(source.slice(field.start, field.end), maximum && source.slice(maximum.start, maximum.end));
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
		if (field === "'reflexes.error'" || field === '`reflexes.${key}`') continue; // Also reached through clipText.
		assert.ok(fields.has(field), `${field} is no longer checked by the coordinator: remove its row`);
	}
});

test('the mod clips every free-text snapshot field to the coordinator bound or below', () => {
	for (const [field, { bound, java }] of Object.entries(FREE_TEXT)) {
		const limit = typeof bound === 'number' ? bound : constants[bound];
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
	const progress = readFileSync(new URL('server/bridge/MultiplexedServerBridge.java', JAVA), 'utf8');
	const send = progress.slice(progress.indexOf('private void sendActionProgress('));
	assert.doesNotMatch(send.slice(0, send.indexOf('send("action_progress"')), /addProperty\("message"/);
});
