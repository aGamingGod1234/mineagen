import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import v8 from 'node:v8';

export const HEALTH_INTERVAL_MS = 30_000;

/**
 * One `coordinator_health` trace row per window: enough to tell why the coordinator fell behind. On a Windows test
 * machine on battery the event loop ran flat out for up to 226 s while the Minecraft server on the same machine was
 * only 2 s behind, and nothing recorded whether the process burned CPU, was starved by the OS, or was collecting
 * garbage. cpuShare well below eluShare means the OS withheld the CPU; both near 1 means our own work; heap near its
 * limit means garbage collection.
 */
export function createHealthSampler(dependencies = {}) {
	const now = dependencies.now ?? (() => performance.now());
	const cpuUsage = dependencies.cpuUsage ?? ((previous) => process.cpuUsage(previous));
	const memoryUsage = dependencies.memoryUsage ?? (() => process.memoryUsage());
	const heapLimit = dependencies.heapLimit ?? (() => v8.getHeapStatistics().heap_size_limit);
	const freeMemory = dependencies.freeMemory ?? (() => os.freemem());
	const utilization = dependencies.eventLoopUtilization ?? ((previous) => performance.eventLoopUtilization(previous));
	const intervalMs = dependencies.intervalMs ?? HEALTH_INTERVAL_MS;
	let delay = null;
	try { delay = dependencies.delayMonitor ?? monitorEventLoopDelay({ resolution: 20 }); delay.enable(); } catch { delay = null; }
	let startedAt = now(), cpu = cpuUsage(), loop = utilization();
	return {
		/** The row for the window that just ended, or null before a window has passed. */
		sample(extra = {}) {
			const at = now();
			const windowMs = at - startedAt;
			if (!(windowMs >= intervalMs)) return null;
			try {
				const spent = cpuUsage(cpu), elapsed = utilization(loop), memory = memoryUsage();
				const mb = (bytes) => Math.round(bytes / 1_048_576);
				const row = {
					windowMs: Math.round(windowMs),
					cpuShare: round((spent.user + spent.system) / 1000 / windowMs),
					eluShare: round(elapsed.utilization),
					loopDelayMaxMs: delay === null ? null : Math.round(delay.max / 1e6),
					loopDelayP99Ms: delay === null ? null : Math.round(delay.percentile(99) / 1e6),
					heapUsedMb: mb(memory.heapUsed), heapLimitMb: mb(heapLimit()), rssMb: mb(memory.rss), freeMemoryMb: mb(freeMemory()),
					...extra,
				};
				return row;
			} finally {
				startedAt = at; cpu = cpuUsage(); loop = utilization(); delay?.reset();
			}
		},
		close() { try { delay?.disable(); } catch { /* observational */ } },
	};
}

function round(value) { return Number.isFinite(value) ? Math.round(value * 100) / 100 : null; }
