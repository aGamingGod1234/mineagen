// Leases on warm pool machines, shared by every batch on this computer through files in one folder (ROOM_BATCH_POOL_DIR,
// default ~/.cache/mineagen/boat-pool). Nothing here calls boat, so all of it is unit-tested with real processes.
//   pool-id            a random id this computer's pool puts in every machine name, so two computers never share a machine
//   mutex              held for milliseconds around every lease and ledger change; a crashed holder's is broken after staleMs
//   leases/NAME.json   { token, pid, batch, leasedAt, heartbeatAt }: the machine named NAME is in use
//   starts.json        times of this computer's recent `boat new` calls, for pacing them under the start rate limit
//   aside/NAME.json    { reason, at }: the machine failed its cleaning check; it stays running but no batch takes it
//   idle/NAME.json     { at }: when a batch last gave the machine back (keepalive deletes the longest idle first)
// A lease is stale when its process is gone (or its pid now belongs to another process), and a
// stale lease is broken only under the mutex, so two batches can never both take the same machine.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(done => setTimeout(done, ms));
export const defaultPoolDir = () => path.resolve(process.env.ROOM_BATCH_POOL_DIR ?? path.join(os.homedir(), '.cache/mineagen/boat-pool'));

export function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return error.code === 'EPERM'; }
}

/** When process pid started, as the kernel counts it (Linux), or null where that cannot be read. Tells a reused pid apart. */
export function processStart(pid) {
	if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
	} catch { return null; }
}

async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } }
async function writeJsonAtomic(file, value) {
	const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
	await writeFile(tmp, JSON.stringify(value) + '\n');
	await rename(tmp, file);
}

/**
 * Whether a failed exclusive create of a lock file means "someone holds it, wait": EEXIST everywhere, and on Windows also
 * EPERM and EBUSY, which it returns while another process has the file open or is deleting it (a lock being released).
 * Anything else is a real error. A Windows code can also be a permanent permission error, so callers wait on it only
 * for WINDOWS_HELD_MS (lockWait).
 */
export function lockHeld(error, platform = process.platform) {
	return error?.code === 'EEXIST' || (platform === 'win32' && ['EPERM', 'EBUSY'].includes(error?.code));
}
export const WINDOWS_HELD_MS = 5_000;
/** One wait: waits(error) is true to retry, and throws once a Windows-only code has lasted WINDOWS_HELD_MS. */
export function lockWait({ platform = process.platform, clock = Date.now, heldMs = WINDOWS_HELD_MS } = {}) {
	let oddSince = null;
	return error => {
		if (!lockHeld(error, platform)) throw error;
		if (error.code === 'EEXIST') { oddSince = null; return true; }
		oddSince ??= clock();
		// A lock being released clears in milliseconds; this long is a folder that refuses the file.
		if (clock() - oddSince > heldMs) throw error;
		return true;
	};
}

// onStale (tests only) runs after a lock is judged stale and before anything is done about it.
export function leaseStore({ dir = defaultPoolDir(), leaseStaleMs = 5 * 60_000, mutexStaleMs = 30_000, heartbeatMs = 30_000, now = Date.now, log = () => {}, onStale = null } = {}) {
	const leasesDir = path.join(dir, 'leases'), asideDir = path.join(dir, 'aside'), idleDir = path.join(dir, 'idle'), mutexFile = path.join(dir, 'mutex'), ledgerFile = path.join(dir, 'starts.json');
	const held = new Map(); // name -> token, leases this process holds
	let ready = null, beat = null;
	const setup = () => ready ??= Promise.all([mkdir(leasesDir, { recursive: true }), mkdir(asideDir, { recursive: true }), mkdir(idleDir, { recursive: true })]);
	const leaseFile = name => {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`bad machine name for a lease: ${name}`);
		return path.join(leasesDir, `${name}.json`);
	};

	/**
	 * Runs fn holding the lock file `file` (created exclusively). A lock is stale when its holder's process is gone or it
	 * is older than staleMs (by its own time, or the file's when its writer died before writing it). A stale lock is
	 * removed only under a second, short breaker lock and only if it still reads the same after that lock is taken, so a
	 * contender that judged an old lock stale can never remove the fresh lock another one put in its place.
	 */
	async function withLock(file, fn, staleMs = mutexStaleMs) {
		await setup();
		await mkdir(path.dirname(file), { recursive: true });
		let mine = null;
		const held = lockWait();
		for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
			// Stamped at each attempt: a lock written after a long wait must not already read as stale.
			mine = JSON.stringify({ pid: process.pid, token: randomBytes(8).toString('hex'), at: now() });
			try {
				const handle = await open(file, 'wx');
				try { await handle.writeFile(mine); } finally { await handle.close(); }
				break;
			} catch (error) {
				held(error);
			}
			const text = await readFile(file, 'utf8').catch(() => null);
			let holder = null;
			try { holder = JSON.parse(text); } catch {}
			const age = holder?.at ? now() - holder.at : await stat(file).then(info => now() - info.mtimeMs, () => null);
			if (text !== null && (holder ? !processAlive(holder.pid) || age > staleMs : age !== null && age > staleMs)) {
				if (onStale) await onStale(file);
				const breaker = `${file}.break`;
				const broke = await open(breaker, 'wx').then(handle => handle.close().then(() => true), error => {
					if (!lockHeld(error)) throw error;
					return false;
				});
				if (broke) {
					try {
						if (await readFile(file, 'utf8').catch(() => null) === text) {
							await unlink(file).catch(() => {});
							log(`broke a stale pool lock${holder ? ` of pid ${holder.pid}` : ' that was never written'} (${path.basename(file)})`);
						}
					} finally { await unlink(breaker).catch(() => {}); }
					continue;
				}
				// A breaker held for more than a few seconds belongs to a process that died inside it.
				if (await stat(breaker).then(info => now() - info.mtimeMs > 10_000, () => false)) await unlink(breaker).catch(() => {});
			}
			await sleep(wait);
		}
		try { return await fn(); }
		finally {
			// Remove only our own lock: if ours was broken as stale, the file now belongs to someone else.
			if (await readFile(file, 'utf8').catch(() => null) === mine) await unlink(file).catch(() => {});
		}
	}
	const withMutex = fn => withLock(mutexFile, fn);

	// A lease is live while its holder's process is: an overloaded computer once kept a live batch from refreshing for
	// 505 s, and breaking its lease put two batches on the same machines (and let keepalive delete one under it). The
	// start time, when the lease carries one, tells a reused pid apart. The heartbeat no longer decides: a hung batch
	// keeps its machines until it is stopped.
	const staleness = lease => {
		if (!lease) return 'missing';
		if (!processAlive(lease.pid)) return `process ${lease.pid} is gone`;
		const started = lease.pidStart ? processStart(lease.pid) : null;
		if (started !== null && started !== lease.pidStart) return `process ${lease.pid} is a different process now`;
		return null;
	};
	const pidStart = processStart(process.pid);

	function startHeartbeat() {
		if (beat) return;
		beat = setInterval(() => { refresh().catch(error => log(`lease heartbeat failed: ${error.message}`)); }, heartbeatMs);
		beat.unref?.();
	}
	async function refresh() {
		if (!held.size) return;
		await withMutex(async () => {
			for (const [name, token] of held) {
				const lease = await readJson(leaseFile(name));
				if (lease?.token !== token) { held.delete(name); log(`lost the lease on ${name}: another batch broke it`); continue; }
				await writeJsonAtomic(leaseFile(name), { ...lease, heartbeatAt: now() });
			}
		});
	}

	return {
		dir, withMutex, staleness,
		/** Runs fn holding a lock of its own for `key` (one machine's deadline), so reads and writes of it never interleave. */
		withKey: (key, fn, staleMs = 3 * 60_000) => { leaseFile(key); return withLock(path.join(dir, 'locks', `${key}.lock`), fn, staleMs); },
		/** Whether this process still holds the lease on name, read from its file (another batch may have broken it). */
		async verify(name) {
			const token = held.get(name);
			if (!token) return false;
			const lease = await readJson(leaseFile(name));
			if (lease?.token === token) return true;
			held.delete(name);
			log(`lost the lease on ${name}: another batch broke it`);
			return false;
		},
		async poolId() {
			await setup();
			const file = path.join(dir, 'pool-id');
			const id = randomBytes(3).toString('hex');
			const created = await writeFile(file, id, { flag: 'wx' }).then(() => null, error => { if (!lockHeld(error)) throw error; return error; });
			// The id is there when the create says it is; if it cannot be read, the create's own error says why.
			const text = (await readFile(file, 'utf8').catch(error => { throw created ?? error; })).trim();
			if (!/^[a-z0-9]{1,12}$/.test(text)) throw new Error(`${file} holds no pool id`);
			return text;
		},
		/** Every lease file: [{ name, lease, stale: reason|null }]. */
		async list() {
			await setup();
			const out = [];
			for (const file of (await readdir(leasesDir)).filter(item => item.endsWith('.json'))) {
				const lease = await readJson(path.join(leasesDir, file));
				out.push({ name: file.slice(0, -5), lease, stale: staleness(lease) });
			}
			return out;
		},
		/**
		 * Under the mutex, takes the first of `names` with no live lease (breaking a stale one) and returns its name, or
		 * null. Call it with the mutex not held.
		 */
		async take(names, { batch = null, includeAside = false } = {}) {
			return withMutex(async () => {
				for (const name of names) {
					const file = leaseFile(name);
					if (!includeAside && await readJson(path.join(asideDir, `${name}.json`))) continue;
					// Lease files are written by rename, so one that does not parse is corrupt and counts as stale.
					const current = await readJson(file);
					if (current && !staleness(current)) continue;
					if (current) log(`breaking the stale lease on ${name} (${staleness(current)}, batch ${current.batch ?? '?'})`);
					const token = randomBytes(8).toString('hex');
					await writeJsonAtomic(file, { token, pid: process.pid, pidStart, batch, leasedAt: now(), heartbeatAt: now() });
					held.set(name, token);
					startHeartbeat();
					return name;
				}
				return null;
			});
		},
		holds: name => held.has(name),
		/** Drops our lease on name; a lease another batch holds is left alone. */
		/** Drops our lease; idle: false (a lease taken only to delete or inspect the machine) records no give-back time. */
		async drop(name, { idle = true } = {}) {
			const token = held.get(name);
			held.delete(name);
			if (!held.size && beat) { clearInterval(beat); beat = null; }
			if (!token) return false;
			return withMutex(async () => {
				const lease = await readJson(leaseFile(name));
				if (lease?.token !== token) return false;
				await rm(leaseFile(name), { force: true });
				if (idle) await writeJsonAtomic(path.join(idleDir, `${name}.json`), { at: now() });
				return true;
			});
		},
		/** When each machine was last given back: { name: ms }. A machine never given back since this was added has none. */
		async idleSince() {
			await setup();
			const out = {};
			for (const file of (await readdir(idleDir)).filter(item => item.endsWith('.json'))) { const record = await readJson(path.join(idleDir, file)); if (Number.isFinite(record?.at)) out[file.slice(0, -5)] = record.at; }
			return out;
		},
		async forgetIdle(name) { leaseFile(name); await rm(path.join(idleDir, `${name}.json`), { force: true }); },
		/** Sets a machine aside: it stays running, no batch leases it, and only an explicit prune or drain deletes it. */
		async setAside(name, reason) { leaseFile(name); await setup(); await writeJsonAtomic(path.join(asideDir, `${name}.json`), { reason, at: now(), pid: process.pid }); },
		async asideList() { await setup(); const out = []; for (const file of (await readdir(asideDir)).filter(item => item.endsWith('.json'))) out.push({ name: file.slice(0, -5), ...(await readJson(path.join(asideDir, file)) ?? {}) }); return out; },
		async clearAside(name) { leaseFile(name); await rm(path.join(asideDir, `${name}.json`), { force: true }); },
		/** Removes a stale lease file; a live one stays. */
		async clear(name) {
			return withMutex(async () => {
				const lease = await readJson(leaseFile(name));
				if (lease && !staleness(lease)) return false;
				await rm(leaseFile(name), { force: true });
				return true;
			});
		},
		/**
		 * Waits until a `boat new` fits the pace (perMinute starts in any 60 s, minGapMs apart, counted over every batch on
		 * this computer), then records it. Returns the ms waited.
		 */
		/**
		 * budget, when given: { starts, readAt, reserve } from the provider's limits read at readAt. The hour and day
		 * windows are checked here, under the mutex, against that read minus every start any batch on this computer
		 * recorded since (30 s earlier, to cover a start the read may not have seen yet), so two batches can never both
		 * spend the last starts above the reserve. A refused start is not recorded. A window with a planRemaining (extra
		 * starts, see boat-warm.mjs startWindows) has the wallet's limit; when the recorded start is past the plan's limit
		 * in any window, onPastPlan gets [{ window, start, planLimit }] (start counts this one) after the mutex is let go.
		 */
		async reserveStart({ perMinute = 20, minGapMs = Math.ceil(60_000 / perMinute), signal = null, budget = null, onPastPlan = null } = {}) {
			if (!Number.isInteger(perMinute) || perMinute < 1) throw new Error(`starts per minute must be a whole number of at least 1, got ${perMinute}`);
			if (!Number.isFinite(minGapMs) || minGapMs < 0) throw new Error(`the gap between starts must be a number of ms, got ${minGapMs}`);
			const began = now();
			while (true) {
				if (signal?.aborted) throw new Error('batch stopped');
				const past = [];
				const wait = await withMutex(async () => {
					const at = now();
					const times = ((await readJson(ledgerFile)) ?? []).filter(time => Number.isFinite(time) && at - time < 86_400_000).sort((a, b) => a - b);
					past.length = 0;
					if (budget?.starts && !budget.starts.unlimited) {
						const since = times.filter(time => time > budget.readAt - 30_000).length;
						// The 30 s overlap keeps the reserve safe, but a start just before the read is already in its used count:
						// counting it again would call a start past the plan while the plan still covers it.
						const afterRead = times.filter(time => time >= budget.readAt).length;
						for (const window of ['hour', 'day']) {
							const read = budget.starts[window];
							const left = (read?.remaining ?? Infinity) - since;
							const extra = Number.isFinite(read?.planRemaining);
							if (left <= budget.reserve) throw new Error(`the ${window} sandbox start limit${extra ? ' with extra starts' : ''} has ${Math.max(left, 0)} starts left, keeping ${budget.reserve} in reserve: no new machine`);
							if (extra && read.planRemaining - afterRead <= 0) past.push({ window, start: read.planLimit - read.planRemaining + afterRead + 1, planLimit: read.planLimit });
						}
					}
					const minute = times.filter(time => at - time < 60_000);
					const last = times.at(-1) ?? -Infinity;
					const until = Math.max(minute.length >= perMinute ? minute[minute.length - perMinute] + 60_000 : 0, last + minGapMs);
					if (until <= at) { times.push(at); await writeJsonAtomic(ledgerFile, times); return 0; }
					return until - at;
				});
				if (!wait) { if (past.length) onPastPlan?.(past); return now() - began; }
				await sleep(Math.min(wait, 5_000));
			}
		},
		async recentStarts(windowMs = 3_600_000) { return ((await readJson(ledgerFile)) ?? []).filter(time => now() - time < windowMs).length; },
		stop() { if (beat) clearInterval(beat); beat = null; },
	};
}
