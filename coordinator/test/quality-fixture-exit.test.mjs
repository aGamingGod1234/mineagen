import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const quality = fileURLToPath(new URL('../../scripts/quality/', import.meta.url));

// Live fixtures that still end in process.exit(0) whatever happened. This list may only shrink: move a fixture onto
// finishRun (scripts/quality/lib/fixture-run.mjs) and delete its name here. A new fixture starts on finishRun.
const NOT_YET_ON_FINISH_RUN = [
	'test-barter-live.mjs', 'test-barter-odds-live.mjs', 'test-bed-live.mjs',
	'test-bed-spawn-live.mjs', 'test-blaze-spawner-live.mjs', 'test-bow-crystal-live.mjs', 'test-bucket-aim-live.mjs',
	'test-caged-crystal-live.mjs', 'test-cast-barter-live.mjs',
	'test-controller-contracts-live.mjs', 'test-cornered-creeper-live.mjs', 'test-count-stance-live.mjs',
	'test-crowd-live.mjs', 'test-default-reflex-live.mjs', 'test-defend-live.mjs', 'test-dig-options-live.mjs',
	'test-dragon-live.mjs', 'test-enderman-live.mjs', 'test-end-survive-live.mjs',
	'test-end-void-live.mjs', 'test-fire-live.mjs', 'test-flee-forest-live.mjs',
	'test-gold-route-live.mjs', 'test-kill-drops-live.mjs',
	'test-knockback-edge-live.mjs', 'test-lavawork-live.mjs', 'test-netherbody-live.mjs', 'test-nether-fight-live.mjs',
	'test-nether-gather-live.mjs', 'test-place-face-live.mjs',
	'test-portal-frame-live.mjs', 'test-portal-walkin-live.mjs', 'test-progress-live.mjs',
	'test-ranged-blaze-live.mjs', 'test-reflex-combat-live.mjs', 'test-reflex-core-live.mjs',
	'test-respawn-recovery-live.mjs', 'test-rest-live.mjs', 'test-route-recovery-live.mjs', 'test-routines-live.mjs',
	'test-savepoints-live.mjs', 'test-shelter-forest-live.mjs', 'test-shelter-live.mjs', 'test-shelter-ranged-live.mjs',
	'test-shelter-repair-live.mjs', 'test-shelter-terrain-live.mjs', 'test-travel-live.mjs',
	'test-travel-resume-live.mjs',
];

const liveFixtures = async () => (await readdir(quality)).filter(name => /^test-.*-live\.mjs$/.test(name)).sort();
const usesFinishRun = text => /from '\.\/lib\/fixture-run\.mjs'/.test(text) && /\bfinishRun\(/.test(text);

test('live fixtures keep damage and death counter integrity with their counts', async () => {
	for (const name of await liveFixtures()) {
		const text = await readFile(path.join(quality, name), 'utf8');
		assert.doesNotMatch(text, /\bdamageEvidence\([^\n]+\)\.damageTaken/, `${name} discards the damage counter integrity`);
		assert.doesNotMatch(text, /\bdeathEvidence\([^\n]+\)\.deaths/, `${name} discards the death counter integrity`);
	}
});

test('every live fixture reports through finishRun unless it is still on the shrinking list', async () => {
	const files = await liveFixtures();
	assert.equal(new Set(NOT_YET_ON_FINISH_RUN).size, NOT_YET_ON_FINISH_RUN.length, 'the list names a fixture twice');
	for (const name of NOT_YET_ON_FINISH_RUN) assert.ok(files.includes(name), `${name} is gone: delete it from NOT_YET_ON_FINISH_RUN`);
	for (const name of files) {
		const text = await readFile(path.join(quality, name), 'utf8');
		if (NOT_YET_ON_FINISH_RUN.includes(name)) {
			assert.ok(!usesFinishRun(text), `${name} uses finishRun now: delete it from NOT_YET_ON_FINISH_RUN`);
			continue;
		}
		assert.ok(usesFinishRun(text), `${name} must import finishRun from ./lib/fixture-run.mjs and exit with its code`);
		// A bare exit 0 at the top level (outside --help) is the silent pass this guard exists to stop.
		assert.doesNotMatch(text, /^process\.exit\(0\);?$/m, `${name} still ends in process.exit(0)`);
	}
});

test('a fixture moved onto finishRun exits 2 when it cannot run, and 0 for --help', async () => {
	const moved = (await liveFixtures()).filter(name => !NOT_YET_ON_FINISH_RUN.includes(name));
	assert.ok(moved.length >= 6);
	// No slot, template or Java: nothing can be measured, which is invalid evidence, never a pass.
	const env = { ...process.env, JAVA_HOME: '', ARENA_HEADLESS_SERVER_TEMPLATE: '', SLOT_PORT_BASE: '' };
	for (const name of moved) {
		const script = path.join(quality, name);
		const help = spawnSync(process.execPath, [script, '--help'], { env, encoding: 'utf8', timeout: 30_000 });
		assert.equal(help.status, 0, `${name} --help: ${help.stderr}`);
		assert.match(help.stdout, /exit 1 = unmet acceptance, exit 2 = invalid evidence/);
		const bare = spawnSync(process.execPath, [script, 'plan.json', 'out'], { env, encoding: 'utf8', timeout: 30_000 });
		assert.equal(bare.status, 2, `${name} without a slot exited ${bare.status}: ${bare.stderr}`);
	}
});

test('reflex fail spots: a failed spot exits 1, a named failure on an empty-inventory control passes, an errored spot exits 2', async () => {
	const { spotPassed } = await import(new URL('../../scripts/quality/lib/reflex-failspot-pass.mjs', import.meta.url));
	const { finishRun } = await import(new URL('../../scripts/quality/lib/fixture-run.mjs', import.meta.url));
	const exit = async rows => (await finishRun(rows.map((row, i) => ({ startedAt: i, finishedAt: i + 1, ...row })), { setExitCode: false })).exitCode;
	const named = [{ outcome: 'failed', detail: 'no cell out of sight of 2 mobs within 5 steps; no blocks to place' }];
	const unnamed = [{ outcome: 'failed', detail: '' }];
	// Rows shaped as the fixture's spot results (cloudSpot, coverSpot, tunnelSpot, clutchSpot).
	assert.equal(spotPassed({ kind: 'cloud' }, { died: false, events: [{ outcome: 'completed' }] }), true);
	assert.equal(spotPassed({ kind: 'cloud' }, { died: false, events: named }), false);
	assert.equal(spotPassed({ kind: 'cloud' }, { died: true, events: [] }), false);
	assert.equal(spotPassed({ kind: 'cover', namedFailureOk: true }, { died: false, events: named }), true);
	assert.equal(spotPassed({ kind: 'cover', namedFailureOk: true }, { died: false, events: unnamed }), false);
	assert.equal(spotPassed({ kind: 'cover' }, { died: false, events: named }), false);
	assert.equal(spotPassed({ kind: 'tunnel' }, { died: false, escaped: true }), true);
	assert.equal(spotPassed({ kind: 'tunnel' }, { died: true, escaped: true }), false, 'escaped and then killed is no pass');
	assert.equal(spotPassed({ kind: 'tunnel' }, { escaped: true }), false, 'an unknown death state is no pass');
	assert.equal(spotPassed({ kind: 'clutch' }, { died: false, waterPlaced: true }), true);
	assert.equal(spotPassed({ kind: 'clutchRun' }, { died: true, waterPlaced: true }), false);
	const pass = { name: 'tunnelBend', pass: spotPassed({ kind: 'tunnel' }, { died: false, escaped: true }) };
	assert.equal(await exit([pass]), 0);
	assert.equal(await exit([pass, { name: 'breathEdgeA', pass: spotPassed({ kind: 'cloud' }, { died: true, events: named }) }]), 1);
	assert.equal(await exit([pass, { name: 'breathEdgeB', error: 'Error: TIMEOUT ready' }]), 2);
});
