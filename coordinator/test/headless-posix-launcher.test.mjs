import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scenarioConfig, coordinatorReady, replayRecorderInstalled, replayState } from '../../scripts/run-headless-provider-matrix.mjs';

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

test('POSIX launcher settles the recording on a close after its stop, or on nothing left to stop with no save running', () => {
	const start = '[01:37:20] [Server thread/INFO]: Starting replay for agent\n';
	const save = '[01:39:48] [Server thread/INFO]: Starting to save replay agent, please do not stop the server!\n';
	const saved = '[01:39:48] [Server thread/INFO]: Successfully saved replay agent to ./recordings/players/agent/2026-11-25--01-37-18.zip, compressed to 4.6 MiB\n';
	const closed = '[01:39:48] [Server thread/INFO]: Successfully closed replay agent\n';
	const gone = '[01:39:48] [Server thread/INFO]: System chat: No player was found\n';
	const files = ['./recordings/players/agent/2026-11-25--01-37-18.zip'];
	// Stopped by the launcher's command.
	assert.deepEqual(replayState(start, start.length), { settled: false, saved: false, files: [] });
	assert.deepEqual(replayState(start + save + saved + closed, start.length), { settled: true, saved: true, files });
	// The agent left (a stopped attempt) and its save is still running when the command finds nobody: wait for the close.
	assert.equal(replayState(start + save + gone, start.length + save.length).settled, false);
	assert.deepEqual(replayState(start + save + gone + saved + closed, start.length + save.length), { settled: true, saved: true, files });
	// The agent left well before the command: its replay already closed.
	const before = start + save + saved + closed;
	assert.deepEqual(replayState(before + gone, before.length), { settled: true, saved: true, files });
	// A 30-minute split closed a replay earlier; the open one still has to close after the command.
	assert.equal(replayState(start + save + saved + closed, (start + save + saved + closed).length).settled, false);
});
