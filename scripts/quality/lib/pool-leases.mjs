// Leases on warm pool machines, shared by every batch on this computer through files in one folder (ROOM_BATCH_POOL_DIR,
// default ~/.cache/mineagen/boat-pool). Nothing here calls boat, so all of it is unit-tested with real processes.
//   pool-id            a random id this computer's pool puts in every machine name, so two computers never share a machine
//   mutex              held for milliseconds around every lease and ledger change; a crashed holder's is broken after staleMs
//   leases/NAME.json   { token, pid, batch, leasedAt, heartbeatAt }: the machine named NAME is in use
//   starts.json        times of this computer's recent `boat new` calls, for pacing them under the start rate limit
//   aside/NAME.json    { reason, at }: the machine failed its cleaning check; it stays running but no batch takes it
// A lease is stale when its process is gone or it has not been refreshed for leaseStaleMs (a hung or reused pid), and a
// stale lease is broken only under the mutex, so two batches can never both take the same machine.
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(done => setTimeout(done, ms));
export const defaultPoolDir = () => path.resolve(process.env.ROOM_BATCH_POOL_DIR ?? path.join(os.homedir(), '.cache/mineagen/boat-pool'));

export function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return error.code === 'EPERM'; }
}

async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } }
async function writeJsonAtomic(file, value) {
	const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
	await writeFile(tmp, JSON.stringify(value) + '\n');
	await rename(tmp, file);
}

export function leaseStore({ dir = defaultPoolDir(), leaseStaleMs = 5 * 60_000, mutexStaleMs = 30_000, heartbeatMs = 30_000, now = Date.now, log = () => {} } = {}) {
	const leasesDir = path.join(dir, 'leases'), asideDir = path.join(dir, 'aside'), mutexFile = path.join(dir, 'mutex'), ledgerFile = path.join(dir, 'starts.json');
	const held = new Map(); // name -> token, leases this process holds
	let ready = null, beat = null;
	const setup = () => ready ??= Promise.all([mkdir(leasesDir, { recursive: true }), mkdir(asideDir, { recursive: true })]);
	const leaseFile = name => {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`bad machine name for a lease: ${name}`);
		return path.join(leasesDir, `${name}.json`);
	};

	async function withMutex(fn) {
		await setup();
		const mine = JSON.stringify({ pid: process.pid, token: randomBytes(8).toString('hex'), at: now() });
		for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
			try {
				const handle = await open(mutexFile, 'wx');
				try { await handle.writeFile(mine); } finally { await handle.close(); }
				break;
			} catch (error) {
				if (error.code !== 'EEXIST') throw error;
			}
			const text = await readFile(mutexFile, 'utf8').catch(() => null);
			let holder = null;
			try { holder = JSON.parse(text); } catch {}
			// An empty or half-written file belongs to a holder that is still writing it, unless it is old (its writer died
			// between creating and writing it); its age then comes from the file itself.
			const age = holder?.at ? now() - holder.at : await stat(mutexFile).then(info => now() - info.mtimeMs, () => null);
			if (text !== null && (holder ? !processAlive(holder.pid) || age > mutexStaleMs : age !== null && age > mutexStaleMs)) {
				// Break it by moving it aside and checking we moved the stale one; a fresh one moved by mistake goes back.
				const aside = `${mutexFile}.broken-${process.pid}-${randomBytes(3).toString('hex')}`;
				if (await rename(mutexFile, aside).then(() => true, () => false)) {
					const moved = await readFile(aside, 'utf8').catch(() => null);
					if (moved !== text) await link(aside, mutexFile).catch(() => {});
					await unlink(aside).catch(() => {});
					log(`broke a stale pool mutex${holder ? ` of pid ${holder.pid}` : ' that was never written'}`);
				}
				continue;
			}
			await sleep(wait);
		}
		try { return await fn(); }
		finally {
			// Remove only our own mutex: if ours was broken as stale, the file now belongs to someone else.
			if (await readFile(mutexFile, 'utf8').catch(() => null) === mine) await unlink(mutexFile).catch(() => {});
		}
	}

	const staleness = lease => !lease ? 'missing'
		: !processAlive(lease.pid) ? `process ${lease.pid} is gone`
		: now() - (lease.heartbeatAt ?? 0) > leaseStaleMs ? `no heartbeat for ${Math.round((now() - (lease.heartbeatAt ?? 0)) / 1000)} s`
		: null;

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
		async poolId() {
			await setup();
			const file = path.join(dir, 'pool-id');
			const id = randomBytes(3).toString('hex');
			await writeFile(file, id, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
			const text = (await readFile(file, 'utf8')).trim();
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
		async take(names, { batch = null } = {}) {
			return withMutex(async () => {
				for (const name of names) {
					const file = leaseFile(name);
					if (await readJson(path.join(asideDir, `${name}.json`))) continue;
					// Lease files are written by rename, so one that does not parse is corrupt and counts as stale.
					const current = await readJson(file);
					if (current && !staleness(current)) continue;
					if (current) log(`breaking the stale lease on ${name} (${staleness(current)}, batch ${current.batch ?? '?'})`);
					const token = randomBytes(8).toString('hex');
					await writeJsonAtomic(file, { token, pid: process.pid, batch, leasedAt: now(), heartbeatAt: now() });
					held.set(name, token);
					startHeartbeat();
					return name;
				}
				return null;
			});
		},
		holds: name => held.has(name),
		/** Drops our lease on name; a lease another batch holds is left alone. */
		async drop(name) {
			const token = held.get(name);
			held.delete(name);
			if (!held.size && beat) { clearInterval(beat); beat = null; }
			if (!token) return false;
			return withMutex(async () => {
				const lease = await readJson(leaseFile(name));
				if (lease?.token !== token) return false;
				await rm(leaseFile(name), { force: true });
				return true;
			});
		},
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
		async reserveStart({ perMinute = 20, minGapMs = Math.ceil(60_000 / perMinute), signal = null } = {}) {
			const began = now();
			while (true) {
				if (signal?.aborted) throw new Error('batch stopped');
				const wait = await withMutex(async () => {
					const at = now();
					const times = ((await readJson(ledgerFile)) ?? []).filter(time => Number.isFinite(time) && at - time < 3_600_000).sort((a, b) => a - b);
					const minute = times.filter(time => at - time < 60_000);
					const last = times.at(-1) ?? -Infinity;
					const until = Math.max(minute.length >= perMinute ? minute[minute.length - perMinute] + 60_000 : 0, last + minGapMs);
					if (until <= at) { times.push(at); await writeJsonAtomic(ledgerFile, times); return 0; }
					return until - at;
				});
				if (!wait) return now() - began;
				await sleep(Math.min(wait, 5_000));
			}
		},
		async recentStarts(windowMs = 3_600_000) { return ((await readJson(ledgerFile)) ?? []).filter(time => now() - time < windowMs).length; },
		stop() { if (beat) clearInterval(beat); beat = null; },
	};
}
