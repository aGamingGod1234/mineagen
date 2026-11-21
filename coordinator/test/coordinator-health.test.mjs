import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealthSampler } from '../src/coordinator-health.mjs';
import { start } from './fixtures/dynamic-main-fixture.mjs';

function fakeSampler({ cpuMs, eluShare, delayMaxMs }) {
	let now = 0, resets = 0;
	const sampler = createHealthSampler({
		now: () => now,
		cpuUsage: (previous) => previous === undefined ? { user: 0, system: 0 } : { user: cpuMs * 1000, system: 0 },
		eventLoopUtilization: (previous) => previous === undefined ? { utilization: 0 } : { utilization: eluShare },
		memoryUsage: () => ({ heapUsed: 300 * 1_048_576, rss: 700 * 1_048_576 }),
		heapLimit: () => 4096 * 1_048_576,
		freeMemory: () => 900 * 1_048_576,
		delayMonitor: { enable() {}, disable() {}, reset() { resets++; }, max: delayMaxMs * 1e6, percentile: () => delayMaxMs * 1e6 / 2 },
	});
	return { sampler, advance: (ms) => { now += ms; }, resets: () => resets };
}

test('a health row tells a starved coordinator (busy loop, little CPU) from one burning CPU', () => {
	// The stall seen on a Windows test machine on battery: the loop never idled for 226 s but the OS gave it little CPU.
	const starved = fakeSampler({ cpuMs: 30_000, eluShare: 1, delayMaxMs: 226_000 });
	assert.equal(starved.sampler.sample(), null, 'no row before a window has passed');
	starved.advance(300_000);
	const row = starved.sampler.sample({ inboundQueued: 48 });
	assert.deepEqual(row, {
		windowMs: 300_000, cpuShare: 0.1, eluShare: 1, loopDelayMaxMs: 226_000, loopDelayP99Ms: 113_000,
		heapUsedMb: 300, heapLimitMb: 4096, rssMb: 700, freeMemoryMb: 900, inboundQueued: 48,
	});
	assert.equal(starved.resets(), 1, 'each row covers only its own window');
	assert.equal(starved.sampler.sample(), null);
});

test('the coordinator writes a coordinator_health trace row from its status interval', async () => {
	const rows = [];
	let tick = null, due = false;
	const run = await start({
		traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } },
		healthSampler: { sample: (extra) => (due ? { windowMs: 30_000, cpuShare: 0.2, ...extra } : null), close() {} },
		setStatusInterval: (callback) => { tick = callback; return 1; }, clearStatusInterval: () => {},
	});
	try {
		tick();
		assert.equal(rows.filter((row) => row.event === 'coordinator_health').length, 0);
		due = true;
		tick();
		const health = rows.filter((row) => row.event === 'coordinator_health');
		assert.equal(health.length, 1);
		assert.equal(health[0].windowMs, 30_000);
		assert.equal(typeof health[0].agentOperations, 'number');
	} finally {
		await run.coordinator.stop();
	}
});
