import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_BYTES, knownLine } from '../src/need-sources.mjs';

const position = { x: 0, y: 16, z: 0 };
const lava = { what: 'minecraft:lava', kind: 'lava', x: 10, y: 12, z: 0 };
const cell = (level, at = lava) => ({ blockId: 'minecraft:lava', x: at.x, y: at.y, z: at.z,
	...(level === undefined ? {} : { blockState: JSON.stringify({ level }) }) });
const line = (blocks) => knownLine({ position, known: { sightings: [lava], blocks } });

test('remembered flowing lava keeps its state in the model-facing known line', () => {
	assert.equal(line([cell('6')]), 'lava: lava(flowing; source unverified) 10m E dy-4 y12');
});

test('a source cell is reported as one seen source without certifying a usable pool', () => {
	const text = line([cell('0')]);
	assert.equal(text, 'lava: lava(source seen) 10m E dy-4 y12');
	assert.doesNotMatch(text, /pool|usable|enough/);
});

test('missing, malformed and unrelated block state leave a sighting unverified', () => {
	for (const blocks of [[], [cell(undefined)], [{ ...cell('0'), blockState: '{}' }],
		[cell('0', { ...lava, x: lava.x + 1 })], [{ ...cell('0'), blockId: 'minecraft:water' }]]) {
		assert.equal(line(blocks), 'lava: lava(source unverified) 10m E dy-4 y12');
	}
});

test('qualification remains atomic within the existing known-line byte cap', () => {
	const known = { sightings: Array.from({ length: 24 }, (_, index) => ({ ...lava, x: 10 + index * 20 })),
		blocks: [cell('6')] };
	const text = knownLine({ position, known });
	assert.ok(Buffer.byteLength(text) <= KNOWN_BYTES);
	assert.match(text, /lava\(flowing; source unverified\)/);
	assert.equal(knownLine({ position, known, cap: 10 }), null);
});
