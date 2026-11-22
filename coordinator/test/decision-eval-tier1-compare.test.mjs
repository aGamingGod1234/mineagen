import test from 'node:test';
import assert from 'node:assert/strict';
import { compare } from '../../scripts/decision-eval/tier1-compare.mjs';
import { noteSightings } from '../src/decision-eval/capture.mjs';

const profile = { model: 'm', effort: 'low', provider: 'codex' };
const run = (cases) => ({ profile, wording: 'w', commit: 'c'.repeat(40), generatedAt: '2026-11-21T00:00:00Z', cases });

test('a category with a case left ungraded in one run is never called a real change', () => {
	const baseline = run({ a: { category: 'travel', good: 0, graded: 3 }, b: { category: 'travel', good: 1, graded: 3 } });
	// Case a improved 0/3 to 3/3; case b produced only errors in the new run.
	const candidate = run({ a: { category: 'travel', good: 3, graded: 3 }, b: { category: 'travel', good: 0, graded: 0 } });
	const result = compare(candidate, baseline);
	assert.equal(result.categories.travel.ungradedCases, 1);
	assert.equal(result.categories.travel.real, false);
	assert.equal(result.overall.real, false);
	assert.ok(result.notes.some((note) => /no graded answer/.test(note)));
});

test('the same sighting coordinates in another dimension are a new sighting', () => {
	const agent = {};
	const at = (dimension) => ({ world: { dimension }, sighted: { blocks: [{ x: 10, y: 20, z: 30, block: 'minecraft:lava' }] } });
	noteSightings(agent, at('minecraft:overworld'), 4);
	noteSightings(agent, at('minecraft:overworld'), 4);
	assert.equal(agent.sightings.length, 1, 'a repeat in the same dimension is not kept');
	noteSightings(agent, at('minecraft:the_nether'), 4);
	assert.equal(agent.sightings.length, 2, 'the Nether sighting at the same coordinates is kept');
});
