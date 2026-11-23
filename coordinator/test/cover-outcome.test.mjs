import test from 'node:test';
import assert from 'node:assert/strict';
import { coverReached } from '../../scripts/quality/lib/cover-outcome.mjs';

test('cover outcome: a finished cover move or a wall-in closed on every side, never a wall-in left open', () => {
	assert.equal(coverReached('0 hit(s) back; no shield, facing the attacker; cover: in cover at -303,100,10'), true);
	assert.equal(coverReached('cover: already out of sight of minecraft:skeleton'), true);
	assert.equal(coverReached('0 hit(s) back; cover: already closed on every side at -307, 100, 11: closed north, east, south, west; no roof; 0 block(s) placed; the walls stay up; opening a side is your call'), true);
	assert.equal(coverReached('walled in from minecraft:skeleton at -300, 100, 10: closed north, east, south, west; roofed; 9 block(s) placed; the walls stay up; opening a side is your call'), true);
	// Run records mask numbers with #: the wording still reads.
	assert.equal(coverReached('cover: already closed on every side at #, #, #: closed north, east, south, west; no roof; # block(s) placed'), true);
	assert.equal(coverReached('stopped walling in: minecraft:zombie got inside before the last wall at -300, 100, 10: closed north, east; open south, west; no roof; 4 block(s) placed'), false);
	assert.equal(coverReached('walled in from minecraft:skeleton at -300, 100, 10: closed north, east, south; open west; no roof; 6 block(s) placed'), false);
	assert.equal(coverReached('walling in from minecraft:skeleton: 3/8'), false);
	assert.equal(coverReached('taking cover from minecraft:skeleton: moving 2 cell(s) left'), false);
	assert.equal(coverReached(undefined), false);
});
