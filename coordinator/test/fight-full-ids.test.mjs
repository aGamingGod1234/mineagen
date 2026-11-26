import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The model writes "ender_pearl" or "blaze_rod" as often as the full id; fight_until keeps the full id, and every place
// that matches a remembered drop against the counted item goes through wantsDrop, never the raw string.
const source = readFileSync(new URL('../../src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerFightUntilController.java', import.meta.url), 'utf8');

test('fight_until matches remembered drops only through wantsDrop', () => {
	assert.equal(source.match(/\.equals\(untilItemId\)/g)?.length ?? 0, 1, 'besides wantsDrop, only the forest-mode check compares untilItemId');
	assert.match(source, /boolean wantsDrop\(String dropItem\) \{\s*return untilItemId\.equals\(dropItem\);/);
	const uses = source.match(/wantsDrop\(drop\.item\(\)\)/g) ?? [];
	assert.equal(uses.length, 3, 'the ledge fetch, the collect-when-clear list and the lying count');
	for (const mark of ['LedgeFetch trip = LedgeFetch.plan', 'drops.add(id);', 'lying++;']) {
		const at = source.indexOf(mark);
		assert.ok(at > 0, mark);
		assert.ok(source.lastIndexOf('wantsDrop(drop.item())', at) > source.lastIndexOf('for (UUID id', at), `${mark} follows a wantsDrop check in its loop`);
	}
});

test('fight_until keeps full ids unless fight.fullIds is false', () => {
	assert.match(source, /this\.untilItemId = fullIds \? BuiltInRegistries\.ITEM\.getKey\(untilItem\)\.toString\(\) : itemArg;/);
	assert.match(source, /this\.mobId = fullIds \? BuiltInRegistries\.ENTITY_TYPE\.getKey\(mob\)\.toString\(\) : mobArg;/);
	assert.match(source, /WarpedForestHunt\.applies\(mob == McEntityTypes\.ENDERMAN, "minecraft:ender_pearl"\.equals\(untilItemId\)/);
});
