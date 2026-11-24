import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scenarioConfig, coordinatorReady, replayRecorderInstalled, savedReplays } from '../../scripts/run-headless-provider-matrix.mjs';

const scenario = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'priority' };
test('POSIX launcher isolates workspaces and seeds the exact requested Codex profile', () => {
	const source = { bridge: { host: 'example', port: 1 }, codex: { launchProfile: { model: 'other' } } };
	const a = scenarioConfig(source, scenario, 28000, '/tmp/lane-a');
	const b = scenarioConfig(source, scenario, 28100, '/tmp/lane-b');
	assert.equal(a.bridge.host, '127.0.0.1');
	assert.equal(a.bridge.port, 28000);
	assert.equal(a.codex.launchProfile.model, scenario.model);
	assert.equal(a.codex.launchProfile.reasoningEffort, 'low');
	assert.equal(a.codex.launchProfile.serviceTier, 'priority');
	assert.notEqual(a.minecraftAgentRoot, b.minecraftAgentRoot);
	assert.notEqual(a.codex.cwd, b.codex.cwd);
	assert.equal(source.codex.launchProfile.model, 'other');
});
test('POSIX readiness accepts authenticated exact profile or settled provider catalog, tolerating a partial tail', () => {
	const row = (type, payload) => JSON.stringify({ direction: 'coordinator_to_server', envelope: { type, payload } });
	const catalog = row('catalog_snapshot', { models: [{ provider: 'codex', model: scenario.model, reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	assert.equal(coordinatorReady(catalog + '\n{"partial"', scenario), true);
	assert.equal(coordinatorReady('', scenario), false);
	assert.equal(coordinatorReady(row('catalog_snapshot', { models: [{ provider: 'codex', model: 'other' }] }), scenario), false);
	const fallback = row('coordinator_status', { components: [{ component: 'provider:codex', state: 'degraded' }] }) + '\n' + row('catalog_snapshot', { models: [{ provider: 'codex', model: 'other' }] });
	assert.equal(coordinatorReady(fallback, scenario), true);
});
test('POSIX launcher records only when the server template carries the ServerReplay mod', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'replay-mods-'));
	try {
		const mods = path.join(root, 'mods');
		assert.equal(await replayRecorderInstalled(mods), false);
		await mkdir(mods);
		await writeFile(path.join(mods, 'fabric-carpet-26.3.jar'), '');
		assert.equal(await replayRecorderInstalled(mods), false);
		await writeFile(path.join(mods, 'ServerReplay-3.6.0+26.3.jar'), '');
		assert.equal(await replayRecorderInstalled(mods), true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('POSIX launcher reads a saved replay from the ServerReplay log lines', () => {
	assert.deepEqual(savedReplays('[01:36:06] [Server thread/INFO]: System chat: Failed to start any recordings\n'), { closed: 0, files: [] });
	const log = [
		'[01:36:16] [Server thread/INFO]: Starting to save replay ha_rec_e2e_z4hqc, please do not stop the server!',
		'[01:36:16] [Server thread/INFO]: Successfully saved replay ha_rec_e2e_z4hqc to ./recordings/players/ha_rec_e2e_z4hqc/2026-11-25--01-34-06.zip, compressed to 3.7 MiB',
		'[01:36:16] [Server thread/INFO]: Successfully closed replay ha_rec_e2e_z4hqc',
	].join('\n');
	assert.deepEqual(savedReplays(log), { closed: 1, files: ['./recordings/players/ha_rec_e2e_z4hqc/2026-11-25--01-34-06.zip'] });
});
