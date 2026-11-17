// Shared fixed-cost cuts for provider-free fixture servers. boot() in watch-replay.mjs uses the first two:
//   stageServer   a case's server folder links the files of one prepared server per template (the template plus the
//                 libraries and version jar vanilla's bundler would unpack on every fresh start) instead of copying
//                 ~67 MB and unpacking ~60 MB more per case. Config files and the arena jar stay real copies.
//                 ARENA_FIXTURE_COPY_TEMPLATE=1 copies the template as before.
//   world cache   boot(dir, { seed, worldCache: true }) generates a seed's world once, saves it the moment the server is
//                 up (before any fixture command) and later boots copy that save instead of generating. The key covers
//                 the template, the arena jar and every world-relevant server property, so a new jar, level type or
//                 monster setting generates afresh. ARENA_FIXTURE_WORLD_CACHE=0 turns it off.
//   warmBoots     boots the next case's server while the current case plays, frozen (`tick freeze`) until its case
//                 takes it, so its clock, weather and mobs start where a fresh boot's would. Every case still gets its
//                 own JVM and its own copy of the world. A server booted ahead holds a free slot.sh live slot (flock on
//                 live-N.lock in ARENA_SLOT_LOCKS, default ~/Desktop/Projects/arena-beat-game/locks) until its case
//                 takes it, so the shared slot budget counts its memory and CPU; with every slot busy, or less than
//                 ARENA_FIXTURE_AHEAD_MIN_MB (default 4096) available, the case boots on demand. ARENA_FIXTURE_AHEAD=0
//                 boots each case on demand, =2 keeps two booting; without slot locks it boots ahead only when set.
//                 The playing server's tick time is read while the next one boots and when its case ends.
//   discard       a case's world is thrown away unless kept (keepWorld, ARENA_FIXTURE_KEEP=1): its server is killed
//                 without a save and its server folder deleted, so a world whose play never reached disk is never left
//                 to inspect. A kept world is saved at stop. server.log next to the folder stays either way.
// Prepared servers and worlds live under ARENA_FIXTURE_CACHE (default ~/.cache/mineagen/fixtures).
import { cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

/** Files a case may change stay copies; everything else is a link into the prepared server. */
const COPIED = new Set(['server.properties', 'eula.txt']);

export const fixtureCacheRoot = () => path.resolve(process.env.ARENA_FIXTURE_CACHE ?? path.join(homedir(), '.cache/mineagen/fixtures'));

async function walk(dir, prefix = '') {
	const files = [];
	for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
		const rel = path.join(prefix, entry.name);
		if (entry.isDirectory()) files.push(...await walk(dir, rel));
		else files.push(rel);
	}
	return files;
}

// Vanilla's bundler unpacks server.jar into libraries/ and versions/ on every start of a fresh copy. The prepared server
// holds the template with that bundle already unpacked (hashes from the bundle's own lists), so a start only verifies.
const UNPACK = `import hashlib, os, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for kind in ('libraries', 'versions'):
    for line in z.read(f'META-INF/{kind}.list').decode().splitlines():
        digest, _, rel = line.split('\\t')
        data = z.read(f'META-INF/{kind}/{rel}')
        if hashlib.sha256(data).hexdigest() != digest: sys.exit(f'bad hash {rel}')
        target = os.path.join(sys.argv[2], kind, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        open(target, 'wb').write(data)
`;

const prepared = new Map();
export async function preparedServer(template) {
	const files = (await walk(template)).filter(rel => !rel.split(path.sep).includes('world') && !rel.startsWith(`mods${path.sep}mineagen-`)).sort();
	const ids = [];
	for (const rel of files) { const info = await stat(path.join(template, rel)); ids.push(`${rel}:${info.size}:${info.mtimeMs}`); }
	const key = createHash('sha256').update(`${path.resolve(template)}\n${ids.join('\n')}`).digest('hex').slice(0, 24);
	if (prepared.has(key)) return prepared.get(key);
	const dir = path.join(fixtureCacheRoot(), 'servers', key);
	if (!await stat(path.join(dir, 'prepared.json')).then(() => true, () => false)) {
		const temp = `${dir}.tmp-${process.pid}-${Date.now()}`;
		try {
			for (const rel of files) { await mkdir(path.dirname(path.join(temp, rel)), { recursive: true }); await cp(path.join(template, rel), path.join(temp, rel)); }
			const { spawnSync } = await import('node:child_process');
			const unpack = spawnSync('python3', ['-I', '-c', UNPACK, path.join(temp, 'server.jar'), temp], { encoding: 'utf8' });
			if (unpack.status !== 0) throw new Error(`bundle unpack failed: ${unpack.stderr || unpack.error?.message}`);
			await writeFile(path.join(temp, 'prepared.json'), JSON.stringify({ template: path.resolve(template), files: ids }, null, 2));
			await rename(temp, dir).catch(() => {});
		} finally { await rm(temp, { recursive: true, force: true }).catch(() => {}); }
	}
	const list = (await walk(dir)).filter(rel => rel !== 'prepared.json');
	prepared.set(key, { dir, files: list });
	return prepared.get(key);
}

export async function stageServer(template, server, jar) {
	let ready = null;
	if (process.env.ARENA_FIXTURE_COPY_TEMPLATE !== '1') ready = await preparedServer(template).catch(error => { console.log(`[fixture] template copied (${error.message})`); return null; });
	if (!ready) {
		await cp(template, server, { recursive: true });
		for (const name of await readdir(path.join(server, 'mods'))) if (name.startsWith('mineagen-')) await rm(path.join(server, 'mods', name));
	} else {
		const dirs = new Set(ready.files.map(rel => path.dirname(rel)));
		for (const rel of [...dirs].sort()) await mkdir(path.join(server, rel), { recursive: true });
		await mkdir(path.join(server, 'mods'), { recursive: true });
		for (const rel of ready.files) {
			if (COPIED.has(rel)) await cp(path.join(ready.dir, rel), path.join(server, rel));
			else await symlink(path.join(ready.dir, rel), path.join(server, rel));
		}
	}
	await cp(jar, path.join(server, 'mods/mineagen-0.2.0.jar'));
}

/** server.properties without the per-run ports and secret; the world cache keys on exactly this text. */
export function worldProperties({ world, seed, spawnMonsters = false, extraProperties = '' }) {
	return `level-name=world\n${world ? '' : `level-seed=${seed}\n`}spawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=${spawnMonsters}\ndifficulty=normal\n${extraProperties}`;
}

export const worldCacheRoot = () => path.join(fixtureCacheRoot(), 'worlds');
export const worldCacheEnabled = () => process.env.ARENA_FIXTURE_WORLD_CACHE !== '0';

const fingerprints = new Map();
async function fileFingerprint(file) {
	const info = await stat(file);
	const memo = `${file}:${info.size}:${info.mtimeMs}`;
	if (!fingerprints.has(memo)) fingerprints.set(memo, createHash('sha256').update(await readFile(file)).digest('hex'));
	return fingerprints.get(memo);
}

/** The cache key: the Minecraft server, its mods, the arena jar and the generating properties (seed included). */
export async function worldCacheKey({ template, jar, properties }) {
	const mods = (await readdir(path.join(template, 'mods'))).filter(name => !name.startsWith('mineagen-')).sort();
	const parts = { format: 1, server: await fileFingerprint(path.join(template, 'server.jar')), mods: {}, jar: await fileFingerprint(jar), properties };
	for (const name of mods) parts.mods[name] = await fileFingerprint(path.join(template, 'mods', name));
	return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export async function lookupWorld(settings) {
	const key = await worldCacheKey(settings);
	const dir = path.join(worldCacheRoot(), key);
	const hit = await stat(path.join(dir, 'world', 'level.dat')).then(() => true, () => false);
	return { key, dir, world: path.join(dir, 'world'), hit };
}

/** Saves a just-started server's world into the cache; the case's own server keeps running unchanged. */
export async function snapshotWorld(entry, serverWorld, command) {
	const temp = `${entry.dir}.tmp-${process.pid}-${Date.now()}`;
	await command('save-off');
	try {
		await command('save-all flush');
		await cp(serverWorld, path.join(temp, 'world'), { recursive: true, filter: from => path.basename(from) !== 'session.lock' });
		await writeFile(path.join(temp, 'meta.json'), JSON.stringify({ key: entry.key, savedAt: new Date().toISOString() }, null, 2));
		await mkdir(path.dirname(entry.dir), { recursive: true });
		// Another slot may have saved the same world first: keep theirs.
		await rename(temp, entry.dir).catch(() => {});
	} finally {
		await rm(temp, { recursive: true, force: true }).catch(() => {});
		await command('save-on');
	}
}

async function memAvailableMb() {
	const text = await readFile('/proc/meminfo', 'utf8').catch(() => '');
	const kb = Number(/MemAvailable:\s+(\d+)/.exec(text)?.[1]);
	return Number.isFinite(kb) ? kb / 1024 : Infinity;
}

/** The live slots slot.sh hands out (one flock file each), or null on a machine without them. */
export function liveSlotPool(env = process.env) {
	const dir = env.ARENA_SLOT_LOCKS ?? path.join(homedir(), 'Desktop/Projects/arena-beat-game/locks');
	if (!existsSync(dir)) return null;
	let count = Number(env.LIVE_SLOTS);
	if (!(count > 0)) { try { count = Number(readFileSync(path.join(dir, 'live-slots'), 'utf8').trim()); } catch { count = 6; } }
	return { dir, count: count > 0 ? count : 6 };
}

/** Takes a free live slot as slot.sh would, without waiting; null when every slot is busy. The lock goes with this process. */
export async function reserveLiveSlot(pool) {
	for (let slot = 0; slot < pool.count; slot++) {
		const holder = spawn('flock', ['-n', path.join(pool.dir, `live-${slot}.lock`), '-c', 'echo held; exec cat'], { stdio: ['pipe', 'pipe', 'ignore'] });
		const held = await new Promise(resolve => {
			holder.stdout.once('data', () => resolve(true));
			holder.once('exit', () => resolve(false));
			holder.once('error', () => resolve(false));
		});
		if (!held) continue;
		holder.unref(); holder.stdin.unref?.(); holder.stdout.unref?.();
		return { slot, release: () => holder.stdin.end() };
	}
	return null;
}

/** `tick query`: the server's mean and 95th-percentile tick time over its last 100 ticks (50 ms is the budget). */
export async function tickTime(s) {
	const text = String(await s.command('tick query'));
	const avgMs = Number(/Average time per tick:\s*([\d.]+)\s*ms/i.exec(text)?.[1]), p95Ms = Number(/P95:\s*([\d.]+)\s*ms/i.exec(text)?.[1]);
	return Number.isFinite(avgMs) ? { avgMs, p95Ms: Number.isFinite(p95Ms) ? p95Ms : null } : null;
}

const ownedServers = new Set();
function ownServer(s) {
	if (!s || ownedServers.has(s)) return;
	ownedServers.add(s);
	s.child?.once('exit', () => ownedServers.delete(s));
}
const exitUnconfirmed = error => Boolean(error?.fixtureServer || /exit unconfirmed/i.test(String(error?.message)));
let exitHook = false;
function guardExit() {
	if (exitHook) return;
	exitHook = true;
	// Ownership includes playing servers and failed boots until their exit has been confirmed.
	const killStandby = () => { for (const s of ownedServers) if (s.child?.exitCode === null && s.child?.signalCode === null) s.child.kill('SIGKILL'); };
	process.once('exit', killStandby);
	for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
		const onSignal = () => {
			killStandby();
			// A harness with its own handler (it stops its current server) decides when to exit; otherwise exit as Node would.
			if (process.listenerCount(signal) === 0) process.exit(code);
		};
		process.once(signal, onSignal);
	}
}

/**
 * for await (const { item, index, dir, server } of warmBoots(items, planOf)) { ... await server.stop(); }
 * planOf(item, index) returns { dir, options } for boot(); options.port is the slot base, and each case gets its own
 * port triple inside the slot (replayPort). The next case boots while this one plays. The loop owns stopping each
 * server it gets; a server booted ahead and never taken is stopped here. server.ticks holds the tick-time samples.
 * A case whose server fails to boot (ahead and again on demand) comes with server null and error set.
 */
export async function* warmBoots(items, planOf, { ahead, boot, replayPort, abort, minFreeMb = Number(process.env.ARENA_FIXTURE_AHEAD_MIN_MB ?? 4096), keepWorld = process.env.ARENA_FIXTURE_KEEP === '1', pool = liveSlotPool() } = {}) {
	ahead ??= process.env.ARENA_FIXTURE_AHEAD !== undefined ? Number(process.env.ARENA_FIXTURE_AHEAD) : pool ? 1 : 0;
	if (!boot || !replayPort || !abort) {
		const replay = await import('./watch-replay.mjs');
		boot ??= replay.boot; replayPort ??= replay.replayPort; abort ??= replay.abortReplayBoot;
	}
	guardExit();
	const plans = items.map((item, index) => ({ item, index, ...planOf(item, index) }));
	const pending = new Map();
	const samples = { overlap: [], end: [] };
	let playing = null;
	const sample = async (s, kind, label) => {
		if (s.stopped) return;
		const t = await tickTime(s).catch(() => null);
		if (!t) return;
		s.ticks[kind] = t; samples[kind].push(t);
		console.log(`[fixture] ${label}: tick ${t.avgMs} ms mean, ${t.p95Ms} ms p95 (budget 50)`);
	};
	const start = async (i, early) => {
		const plan = plans[i];
		await mkdir(plan.dir, { recursive: true });
		let s;
		try {
			s = await boot(plan.dir, { ...plan.options, port: replayPort(plan.options.port, i), onSpawn: server => {
				ownServer(server);
				plan.options.onSpawn?.(server);
			} });
		}
		catch (error) { ownServer(error.fixtureServer); throw error; }
		ownServer(s);
		s.ticks = {};
		const saveAndStop = s.stop;
		s.stop = async () => {
			if (s.stopped) return;
			try {
				if (s.taken) await sample(s, 'end', `case ${i + 1} at its end`);
				if (keepWorld) await saveAndStop();
				else {
					await abort(s);
					// Play never reached disk, so a discarded world would show pre-play terrain. Windows keeps the killed
					// server's log locked for a moment (EBUSY): rm retries instead of failing a finished case.
					await rm(path.join(plan.dir, 'server'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
				}
				s.stopped = true;
				ownedServers.delete(s);
			} catch (error) { s.stopError = error; throw error; }
		};
		if (early) {
			try { await s.command('tick freeze'); } catch (error) {
				try { await s.stop(); }
				catch (cleanupError) { cleanupError.fixtureServer = s; throw cleanupError; }
				throw error;
			}
		}
		return s;
	};
	const launch = async (i) => {
		if (i >= plans.length || pending.has(i) || ahead < 1) return;
		const free = await memAvailableMb();
		if (free < minFreeMb) { console.log(`[fixture] case ${i + 1} boots on demand: ${Math.round(free)} MB available < ${minFreeMb}`); return; }
		const slot = pool ? await reserveLiveSlot(pool) : null;
		if (pool && !slot) { console.log(`[fixture] case ${i + 1} boots on demand: every live slot is busy`); return; }
		const booting = start(i, true);
		const host = playing;
		// The playing server's tick time while this one booted beside it.
		booting.then(() => host && sample(host, 'overlap', `case ${host.case} while case ${i + 1} booted ahead${slot ? ` in live slot ${slot.slot}` : ''}`), () => {});
		pending.set(i, { booting, slot });
	};
	try {
		for (let i = 0; i < plans.length; i++) {
			let s;
			const asked = Date.now(), bootedAhead = pending.has(i);
			if (pending.has(i)) {
				const { booting, slot } = pending.get(i);
				let bootError;
				s = await booting.catch(error => { if (exitUnconfirmed(error)) { bootError = error; return null; } console.log(`[fixture] case ${i + 1} failed to boot ahead (${String(error?.message ?? error).slice(0, 200)}); booting it now`); return null; });
				if (bootError) {
					yield { item: plans[i].item, index: i, dir: plans[i].dir, server: null, error: bootError };
					return;
				}
				// The case before has stopped its server: this slot runs one JVM again.
				if (s) {
					try { await s.command('tick unfreeze'); } catch (error) {
						try { await s.stop(); }
						catch (cleanupError) { cleanupError.fixtureServer = s; error = cleanupError; }
						yield { item: plans[i].item, index: i, dir: plans[i].dir, server: null, error };
						return;
					}
				}
				else await rm(path.join(plans[i].dir, 'server'), { recursive: true, force: true });
				pending.delete(i); slot?.release();
			}
			// A case whose server cannot boot is handed to the caller as error (server null), so a strict fixture records
			// invalid evidence for that case and runs the rest, as it did booting each case itself.
			if (!s) {
				try { s = await start(i, false); } catch (error) {
					console.log(`[fixture] case ${i + 1}/${plans.length} failed to boot: ${String(error?.message ?? error).slice(0, 200)}`);
					if (!exitUnconfirmed(error)) await rm(path.join(plans[i].dir, 'server'), { recursive: true, force: true }).catch(() => {});
					yield { item: plans[i].item, index: i, dir: plans[i].dir, server: null, error };
					if (exitUnconfirmed(error)) return;
					continue;
				}
			}
			s.taken = true; s.case = i + 1; playing = s;
			console.log(`[fixture] case ${i + 1}/${plans.length} server ${bootedAhead ? 'booted ahead' : 'booted on demand'}, waited ${((Date.now() - asked) / 1000).toFixed(1)} s (world ${s.worldCache ?? 'off'})`);
			for (let k = 1; k <= ahead; k++) await launch(i + k);
			yield { item: plans[i].item, index: i, dir: plans[i].dir, server: s };
			// Callers record cleanup errors and may continue their loop. Never transfer a reservation or rotate
			// back onto this server's ports until the playing server has actually stopped.
			if (!s.stopped) {
				const error = s.stopError ?? new Error('Playing fixture server was not stopped; exit unconfirmed');
				error.fixtureServer = s;
				throw error;
			}
		}
	} finally {
		if (playing && !playing.stopped && !playing.stopError) {
			await playing.stop().catch(() => {});
		}
		for (const { booting, slot } of pending.values()) {
			let s;
			try {
				s = await booting;
				await s.stop();
				ownedServers.delete(s);
				slot?.release();
			} catch (error) {
				s ??= error.fixtureServer;
				if (!s) { if (!exitUnconfirmed(error)) slot?.release(); continue; }
				ownServer(s);
				// Keep the world and reservation while shutdown is uncertain; release only on the JVM's actual exit.
				if (s.child?.exitCode === null && s.child?.signalCode === null) {
					s.child.once('exit', () => { ownedServers.delete(s); slot?.release(); });
				} else if (s.child) { ownedServers.delete(s); slot?.release(); }
			}

		}
		const worst = list => list.length ? `${Math.max(...list.map(t => t.avgMs))} ms mean, ${Math.max(...list.map(t => t.p95Ms ?? 0))} ms p95` : 'none';
		if (samples.overlap.length || samples.end.length) console.log(`[fixture] worst tick of a playing server: while another booted ${worst(samples.overlap)} (${samples.overlap.length}); at case end ${worst(samples.end)} (${samples.end.length})`);
	}
}
