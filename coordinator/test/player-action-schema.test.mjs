import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MAX_ACTION_ARGUMENT_BYTES, validateAction } from '../src/schema.mjs';

const cases = JSON.parse(await readFile(new URL('../../src/test/resources/player-action-schema-cases.json', import.meta.url), 'utf8'));

for (const fixture of cases) {
	test(`player action schema: ${fixture.name}`, () => {
		if (fixture.valid) assert.doesNotThrow(() => validateAction(fixture.action));
		else assert.throws(() => validateAction(fixture.action));
	});
}

test('validated conditional frames stay detached and immutable before dispatch', () => {
	const source = structuredClone(cases.find((fixture) => fixture.name === 'on_fire boolean branch').action);
	const accepted = validateAction(source);
	source.frames[0].branches[0].nextFrame = 0;
	assert.equal(accepted.frames[0].branches[0].nextFrame, 1);
	assert.throws(() => { accepted.frames[0].branches[0].nextFrame = 0; }, TypeError);
	assert.throws(() => { accepted.frames.push(accepted.frames[0]); }, TypeError);
	assert.strictEqual(validateAction(accepted), accepted);
});

test('book budget measures serialized UTF-8 arguments including JSON escaping', () => {
	const exact = cases.find((fixture) => fixture.name === 'exact serialized argument byte budget').action;
	const { type, ...argumentsOnly } = exact;
	assert.equal(Buffer.byteLength(JSON.stringify(argumentsOnly), 'utf8'), MAX_ACTION_ARGUMENT_BYTES);
	const tooLarge = cases.find((fixture) => fixture.name === 'one byte above serialized argument budget').action;
	assert.throws(() => validateAction(tooLarge), (error) => error.code === 'ACTION_ARGUMENTS_TOO_LARGE');
	const escaped = cases.find((fixture) => fixture.name === 'JSON escaping counts toward argument budget').action;
	assert.ok(escaped.pages.reduce((sum, page) => sum + page.length, 0) < MAX_ACTION_ARGUMENT_BYTES);
	assert.throws(() => validateAction(escaped), (error) => error.code === 'ACTION_ARGUMENTS_TOO_LARGE');
});

test('search boundary fields cross the production action normalizer as an all-or-none circle', async () => {
	const { normalizeMinecraftToolCall } = await import('../src/native-minecraft-tools.mjs');
	for (const actionType of ['travel_to', 'dig_to']) {
		const args = actionType === 'travel_to' ? { x: 4, y: 70, z: 0, retrace: true } : { pattern: 'stairs_up', y: 40, timeoutMs: 60000 };
		const boundary = { boundaryX: 0.5, boundaryZ: 0.5, boundaryRadius: 16 };
		const call = normalizeMinecraftToolCall('act', { actionType, arguments: { ...args, ...boundary } });
		for (const key of Object.keys(boundary)) assert.equal(call.arguments[key], boundary[key]);
		assert.throws(() => normalizeMinecraftToolCall('act', { actionType, arguments: { ...args, boundaryRadius: 16 } }));
	}
});
