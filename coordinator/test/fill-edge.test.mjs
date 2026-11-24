import test from 'node:test';
import assert from 'node:assert/strict';
import { waterBelowEdge } from '../src/obtain-runner.mjs';

const at = (drops) => ({ player: { x: -310.4, y: 67, z: 691.5, edges: drops === undefined ? undefined : { drops } } });

test('room kit-gate-6: a ledge over water 5 below names the pool cell and digs away from the drop', () => {
	assert.deepEqual(waterBelowEdge(at([{ dir: 'E', at: 0, drop: 5, into: 'water' }, { dir: 'N', at: 0, drop: 3, atLeast: true }])),
		{ x: -310, y: 62, z: 691, away: 'west' });
});

test('the nearer of two water drops wins; a drop two cells off counts', () => {
	assert.deepEqual(waterBelowEdge(at([{ dir: 'S', at: 1, drop: 4, into: 'water' }, { dir: 'N', at: 0, drop: 6, into: 'water' }])),
		{ x: -311, y: 61, z: 690, away: 'south' });
	assert.deepEqual(waterBelowEdge(at([{ dir: 'S', at: 1, drop: 4, into: 'water' }])), { x: -311, y: 63, z: 693, away: 'north' });
});

test('feet on a part block (farmland, a slab) still name the cell the water surface is in', () => {
	const on = (y, drop) => waterBelowEdge({ player: { x: 0.5, y, z: 0.5, edges: { drops: [{ dir: 'E', at: 0, drop, into: 'water' }] } } }).y;
	assert.equal(on(67.9375, 5), 63); // source surface 63.89
	assert.equal(on(67.5, 4), 63);
	assert.equal(on(67, 5), 62); // a flow at 62.5
});

test('no dig for dry drops, lava, unmeasured or out-of-range depths, far edges or no edges fact', () => {
	assert.equal(waterBelowEdge(at(undefined)), null);
	assert.equal(waterBelowEdge(at([{ dir: 'E', at: 0, drop: 6 }])), null);
	assert.equal(waterBelowEdge(at([{ dir: 'E', at: 0, drop: 6, into: 'lava' }])), null);
	assert.equal(waterBelowEdge(at([{ dir: 'E', at: 0, drop: 6, into: 'water', atLeast: true }])), null);
	assert.equal(waterBelowEdge(at([{ dir: 'E', at: 0, drop: 2, into: 'water' }])), null);
	assert.equal(waterBelowEdge(at([{ dir: 'E', at: 0, drop: 9, into: 'water' }])), null);
	assert.equal(waterBelowEdge(at([{ dir: 'E', at: 2, drop: 5, into: 'water' }])), null);
});
