import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CONTROL_REFERENCE_TOPICS } from '../src/minecraft-control-reference.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, minecraftCapabilities, normalizeMinecraftToolCall, toolResultContent } from '../src/native-minecraft-tools.mjs';
import { DEFAULT_REFLEXES } from '../src/reflexes.mjs';

const referenceUrl = new URL('../config/minecraft-agent/.codex/skills/minecraft-control/references/control-reference.md', import.meta.url);

test('complete control reference is lossless through bounded existing-tool pages', async () => {
	const source = await readFile(referenceUrl, 'utf8');
	const index = minecraftCapabilities({ section: 'control' });
	assert.equal(index.section, 'control');
	assert.deepEqual(index.completeReference.arguments, { section: 'control', topic: 'all', offset: 0 });
	assert.ok(index.topics.some(({ id }) => id === 'validation'));
	let text = '', offset = 0, pages = 0;
	for (;;) {
		const args = { section: 'control', topic: 'all', offset };
		assert.deepEqual(normalizeMinecraftToolCall('capabilities', args), { kind: 'capabilities', ...args });
		const page = minecraftCapabilities(args);
		const rendered = toolResultContent(page).contentItems[0].text;
		assert.ok(Buffer.byteLength(rendered, 'utf8') <= 16_384);
		assert.deepEqual(JSON.parse(rendered), page, 'transport must not truncate a reference page');
		assert.equal(page.offset, offset);
		assert.equal(page.coverage.returnedCharacters, Array.from(page.reference).length);
		text += page.reference;
		pages += 1;
		if (page.nextOffset === undefined) {
			assert.equal(page.coverage.complete, true);
			break;
		}
		assert.equal(page.coverage.complete, false);
		assert.ok(page.nextOffset > offset);
		offset = page.nextOffset;
	}
	assert.ok(pages > 1, 'full original documentation remains available beyond one transport page');
	assert.equal(text, source, 'every byte of the original instructions and examples is recoverable');
});

test('every native tool and action has its narrow original contract available', () => {
	const expected = [
		...MINECRAFT_DYNAMIC_TOOLS.map(({ name }) => `tool:${name}`),
		...[...MINECRAFT_DYNAMIC_TOOLS.find(({ name }) => name === 'act').inputSchema.properties.arguments.description.matchAll(/([a-z_]+)\(/g)].map(([, name]) => `action:${name}`),
	];
	for (const topic of expected) {
		assert.ok(CONTROL_REFERENCE_TOPICS.includes(topic), `missing reference topic ${topic}`);
		const reference = minecraftCapabilities({ section: 'control', topic });
		assert.ok(reference.reference.includes('```json executor-call'), `missing accepted syntax for ${topic}`);
		assert.equal(JSON.parse(toolResultContent(reference).contentItems[0].text).reference, reference.reference);
	}
});

test('compact instructions keep decision, danger, recovery and verification rules with strong references', async () => {
	const skill = await readFile(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/SKILL.md', import.meta.url), 'utf8');
	const original = await readFile(referenceUrl, 'utf8');
	assert.ok(Buffer.byteLength(skill) < Buffer.byteLength(original) * 0.35, 'always-loaded instructions should remove detailed example inflation');
	for (const rule of [
		/You choose every strategy, target, route, reaction and retry/,
		/postAction\.observation and program observation already contain inventory/,
		/Missing or coverage-omitted facts are unknown/,
		/Batch independent reads while the body works/,
		/Damage takes priority over gathering/,
		/after:"reconsider"/,
		/Default unhandled damage\/fire\/lava\/suffocation\/hazardous-fall policy pauses unrelated work/,
		/Death interrupts the same project/,
		/Compare recovering earlier equipment with rebuilding/,
		/finish asks the server to verify goalSpec/,
		/AWAITING_OPERATOR_CONFIRMATION means report once with say, end the turn/,
		/Default minecraft:inventory\/containerId0 exists during ordinary gameplay and does not block it/,
		/action:<actionType> or tool:<name> for semantics and examples/,
	]) assert.match(skill, rule);
	// How to reach the reference is stated once, in the always-sent capabilities description.
	const capabilitiesDescription = MINECRAFT_DYNAMIC_TOOLS.find(({ name }) => name === 'capabilities').description;
	for (const rule of [/read tool:<name> or action:<actionType> before unfamiliar calls/, /follow nextOffset/, /topic all is complete/]) {
		assert.match(capabilitiesDescription, rule);
	}
});

test('reference fields stay scoped, bounded and explicitly read-only', () => {
	for (const args of [
		{ topic: 'all' }, { section: 'all', offset: 0 }, { section: 'program', topic: 'all' },
		{ section: 'control', topic: 'private-files' }, { section: 'control', offset: 0 },
		{ section: 'control', topic: 'all', offset: -1 }, { section: 'control', topic: 'all', offset: 0.5 },
		{ section: 'control', topic: 'all', path: '../auth.json' },
	]) assert.throws(() => normalizeMinecraftToolCall('capabilities', args), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	assert.throws(() => minecraftCapabilities({ section: 'control', topic: 'all', offset: 1_000_000 }), /exceeds this topic/);
	assert.match(minecraftCapabilities({ section: 'control' }).detail, /queries perform no gameplay/);
});

test('each narrow action topic names every field the action accepts, optional ones marked', async () => {
	const { ACTION_FIELDS, OPTIONAL_ACTION_FIELDS } = await import('../src/constants.mjs');
	// act.actionType is generated from the validation field table (contracts), not a schema enum.
	const actions = Object.keys(ACTION_FIELDS);
	for (const action of actions) {
		const reference = minecraftCapabilities({ section: 'control', topic: `action:${action}` }).reference;
		const declared = parseFieldDeclaration(reference.match(/^Fields:.*$/m)?.[0] ?? '');
		for (const field of ACTION_FIELDS[action] ?? []) {
			assert.ok(declared.has(field), `action:${action} Fields line omits ${field}`);
			const optional = (OPTIONAL_ACTION_FIELDS[action] ?? []).includes(field);
			assert.equal(declared.get(field), optional, `action:${action} marks ${field} ${optional ? 'required' : 'optional'}`);
		}
	}
});

test('portal crossings and dragon damage are discoverable topics that state the existing tool contracts', () => {
	const portals = minecraftCapabilities({ section: 'control', topic: 'portals' });
	assert.equal(portals.title, 'Portals and dimension changes');
	assert.match(portals.reference, /DIMENSION_TRANSITION/);
	assert.match(portals.reference, /does not retry the old leg/);
	assert.match(portals.reference, /world\.state\(\)\.dimension/);
	const attack = minecraftCapabilities({ section: 'control', topic: 'action:attack' }).reference;
	for (const required of [/parentId/, /partName/, /use that part uuid as `targetId`/, /End crystals/, /TARGET_NOT_LIVING/, /leads the dragon's flight/, /no arrow damage/, /not damage/]) assert.match(attack, required);
	// fight_target fights the dragon through a named part, as a player's swings land on parts.
	assert.match(attack, /fight_target also takes a part uuid/);
});

test('the Fields parser binds each optional marker to its own field', () => {
	const parsed = parseFieldDeclaration('Fields: `durationMs`, `hand` optional, `expectedItemId`, `mode` optional.');
	assert.deepEqual([...parsed], [['durationMs', false], ['hand', true], ['expectedItemId', false], ['mode', true]]);
	const prefixed = parseFieldDeclaration('Fields: `targetId`, optional `desiredRange` (1..6, default 2.5), `fleeAtHealth` and `flag` (default false). Prose `RESULT`.');
	assert.deepEqual([...prefixed], [['targetId', false], ['desiredRange', true], ['fleeAtHealth', true], ['flag', true]]);
});

// Splits the declaration (up to its first sentence end) into comma clauses outside parentheses. A field is optional
// when its own clause says `field` optional, or after a leading "optional" that introduces the rest of the list.
function parseFieldDeclaration(line) {
	const declared = new Map();
	let text = line.replace(/^Fields:\s*/, '');
	let depth = 0;
	const clauses = [''];
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === '(') depth++;
		if (character === ')') depth--;
		if (depth === 0 && character === '.' && (index === text.length - 1 || text[index + 1] === ' ')) break;
		if (depth === 0 && character === ',') clauses.push('');
		else clauses[clauses.length - 1] += character;
	}
	let listOptional = false;
	for (const clause of clauses) {
		const outer = clause.replace(/\([^()]*\)/g, '').trim();
		if (/^optional\s/.test(outer)) listOptional = true;
		for (const [, name] of clause.matchAll(/`([A-Za-z]+)`/g)) {
			if (declared.has(name)) continue;
			declared.set(name, listOptional || new RegExp(`\`${name}\`\\s+optional\\b`).test(outer));
		}
	}
	return declared;
}


test('survival guidance: always-loaded first-call rule and default reflexes, details in the survival topic; eye contracts explain landing and reserves', async () => {
	const agent = await readFile(new URL('../config/minecraft-agent/AGENTS.md', import.meta.url), 'utf8');
	const skill = await readFile(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/SKILL.md', import.meta.url), 'utf8');
	assert.match(agent, /Fifteen reflexes are on from spawn, each respawn and dimension change/);
	assert.match(agent, /When danger already acts on you and no reflex handles it, your first call is the escape or the defence itself, not a lookup\./);
	// The full teaching moved from AGENTS.md into the control reference survival topic.
	const survival = minecraftCapabilities({ section: 'control', topic: 'survival' }).reference;
	assert.match(survival, /While safe, arm reflexes before exposed work/);
	assert.match(survival, /standing guard for a larger escape program authored from current facts/);
	assert.match(survival, /When danger is visible, close or acting on you, your first call is the immediate survival or setup action/);
	assert.match(survival, /that same call carries reflexes for what follows/);
	assert.match(skill, /thinking gaps and respawn/);
	assert.match(skill, /Fight in-reach melee mobs when healthy, flee creepers, escape fire\/lava, swim to the reported breathable target at low air, and retreat\/eat at low health/);
	assert.match(skill, /Author a standing guard with standing:\{id,when,guard:true\} and your own source/);
	assert.match(skill, /LOW_HEALTH_BAILOUT reports a bounded retreat attempt; pursue:false holds ground/);
	for (const action of ['use_item', 'use_ranged']) {
		const { reference } = minecraftCapabilities({ section: 'control', topic: `action:${action}` });
		assert.match(reference, /[Ii]nspect first/);
		assert.match(reference, /mode:"inspect"/);
		assert.match(reference, /footing:false.*unknown_terrain.*without support \(void\/fall\)/);
		assert.match(reference, /landing fields are authoritative/);
	}
	const eyes = minecraftCapabilities({ section: 'control', topic: 'action:use_item' }).reference;
	assert.match(eyes, /only locate a stronghold \(20% break per throw\)/);
	assert.match(eyes, /silverfish spawner, lava, stairs/);
	assert.match(eyes, /Keep 12 eyes minus pre-filled frames/);
});

test('reflex guidance does not limit authoring to rules the defaults miss', async () => {
	const agent = await readFile(new URL('../config/minecraft-agent/AGENTS.md', import.meta.url), 'utf8');
	const skill = await readFile(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/SKILL.md', import.meta.url), 'utf8');
	// Whole topics: one call returns only the first page of tool:reflexes.
	const topic = (name) => {
		let text = '', offset = 0;
		for (;;) {
			const page = minecraftCapabilities({ section: 'control', topic: name, offset });
			text += page.reference;
			if (page.nextOffset === undefined) return text;
			assert.ok(page.nextOffset > offset);
			offset = page.nextOffset;
		}
	};
	const survival = topic('survival'), reflexes = topic('tool:reflexes');
	for (const text of [agent, skill, survival, reflexes]) {
		assert.doesNotMatch(text, /Add a rule only for a danger/);
		assert.doesNotMatch(text, /only missing (live-authored reflexes|protection|rules)/);
		assert.doesNotMatch(text, /needs only missing protection/);
	}
	assert.match(agent, /Add rules for any danger they miss \(control topic tool:reflexes\)/);
	assert.match(skill, /Arm live-authored reflexes on the first body call/);
	// The cues against churn and re-arming stay.
	assert.match(skill, /Keep working rules, and revise failed rules by the same id/);
	assert.match(survival, /Keep working definitions unchanged; add missing protection/);
	assert.match(survival, /A new program keeps the rules already armed/);
	assert.match(reflexes, /Keep working rules across programs/);
	// The real limits stay.
	assert.match(skill, /standing\.template guards are outside/);
	assert.match(reflexes, /Author every rule live; no saved or named sets/);
});

test('the always-loaded player instructions stay a few KB: the role, steps, the route, seven rules and reflexes on', async () => {
	const agent = await readFile(new URL('../config/minecraft-agent/AGENTS.md', import.meta.url), 'utf8');
	// 20,888 B before rw-loop (rules added one past death at a time); the facts moved to the on-demand references.
	// Deliberately raised ceiling; never meet it by trimming text a measured round saw. +380 for the Instinct section.
	assert.ok(Buffer.byteLength(agent) <= 5_400, `AGENTS.md grew to ${Buffer.byteLength(agent)} bytes`);
	assert.match(agent, /you decide what to do and why, and the body decides how/);
	assert.match(agent, /nothing starts unless you name it/);
	assert.match(agent, /do_step \{verb, target, why, until\?\}/);
	assert.match(agent, /now\.route suggests the usual next step/);
	assert.match(agent, /The objective is the goal in the least game time, done properly: survive and keep progress\./);
	assert.match(agent, /verify completion with finish, not actions alone\./);
	for (const rule of ['Batch the work', 'Finish what is in front of you', 'Leave nothing you will need again', 'Reuse before you rebuild', 'Take the shortest safe way, then commit', 'Every move has a destination', 'Be ready before the risk']) {
		assert.ok(agent.includes(rule), rule);
	}
	assert.equal([...agent.matchAll(/^[1-7]\. /gm)].length, 7, 'seven general rules');
	for (const { id } of DEFAULT_REFLEXES) assert.ok(agent.includes(id), `the default reflex ${id} is named so the model can switch it off`);
});

// Issue #2 3c: the in-game text names no model and reads the same to any of them; a stop names its fork. The council
// kept line 3 (until plan-continue ships) and line 37 as they are.
test('the in-game instructions are model-neutral and name the forks the body stops at', async () => {
	const agent = await readFile(new URL('../config/minecraft-agent/AGENTS.md', import.meta.url), 'utf8');
	const skill = await readFile(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/SKILL.md', import.meta.url), 'utf8');
	const { NATIVE_AGENT_INSTRUCTIONS } = await import('../src/native-minecraft-tools.mjs');
	for (const text of [agent, skill, NATIVE_AGENT_INSTRUCTIONS]) assert.doesNotMatch(text, /\b(claude|codex|gpt|openai|anthropic|opus|sonnet|haiku|gemini)\b/i);
	const lines = agent.split('\n');
	assert.match(lines[2], /^You control one persistent Minecraft player .* You pick every step yourself; nothing starts unless you name it\. /);
	assert.equal(lines[36], 'do_step covers most play. Use the low-level tools (act, sequence, startAction, moveTo, mine, control, runProgram) only for what no verb does: one precise placement or click, a menu, eating or equipping, a short repair, or a conditional routine. Read the control topic before an unfamiliar call.');
	assert.match(agent, /the body stops it \(stuck, or a fork such as low health\)/);
	assert.match(agent, /When the body stopped it, answer its reason: recover, go around, change the way or the step/);
	assert.doesNotMatch(skill, /Runtime and other models choose no gameplay/);
	assert.match(skill, /Other models choose no gameplay; reflexes act for safety, and steps act only inside work you chose\./);
});
