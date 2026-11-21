// The warm boat pool: room-batch.mjs leases machines that are already running instead of making new ones, and gives them
// back running when its batch ends. Boat counts every create, fork and resume as a start against a per-minute, per-hour
// and per-day limit; `boat extend`, ssh, scp and info are not starts. So a pool machine is never stopped or resumed (with
// --no-snapshots a stop erases it anyway): it stays alive only through its auto-stop deadline, which the pool pushes back
// while a batch holds it (lease TTL) and sets to the idle TTL when the batch gives it back. A machine nobody leases
// before that deadline stops by itself, which bounds what an idle pool costs.
// Membership is by name, rbpool-POOLID-TYPE-SNAPSHOT-IMAGEHASH-RAND, where POOLID is this computer's pool (pool-leases.mjs)
// and IMAGEHASH comes from the snapshot's id, so an image rebuilt under the same name never reuses an old machine. Each
// machine also holds ~/.mineagen-pool.json naming itself and its image, which every lease checks. Machines another batch
// or tool started are never touched: boat's "idle" state only means no agent prompt runs, not that the machine is unused.
// Before a machine goes to a batch, and again when it comes back, cleanScript() kills whatever the last batch left running
// under ~/batch or on the image's Java, checks no room port is still held, and wipes ~/batch and the fixture worlds cache,
// so a warm machine starts a room the way a fresh one does. The image (Java, template, prepared servers) stays.
import { createHash, randomBytes } from 'node:crypto';
import { boat, boatPool, createMachine, destroyMachine, execRemote, extendMachine, machineUsage, quote } from './boat-pool.mjs';
import { leaseStore } from './pool-leases.mjs';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
	if (signal?.aborted) return reject(new Error('batch stopped'));
	const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
	const onAbort = () => { clearTimeout(timer); reject(new Error('batch stopped')); };
	signal?.addEventListener('abort', onAbort, { once: true });
});

export const LIVE = new Set(['provisioned', 'cloning', 'ready', 'idle', 'running']);
export const MARKER = '.mineagen-pool.json';
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'none';
export const imageHash = (snapshot, snapshotId) => createHash('sha256').update(`${snapshot}\n${snapshotId ?? ''}`).digest('hex').slice(0, 8);
export const machineName = ({ poolId, type, snapshot, snapshotId, rand = randomBytes(2).toString('hex') }) => `rbpool-${poolId}-${slug(type)}-${slug(snapshot)}-${imageHash(snapshot, snapshotId)}-${rand}`;

/** A boat sandbox -> its pool fields when this pool made it, else null. */
export function poolMember(sandbox, poolId, now = Date.now()) {
	const match = /^rbpool-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)-([0-9a-f]{8})-([0-9a-f]+)$/.exec(sandbox?.name ?? '');
	if (!match || match[1] !== poolId) return null;
	const deadline = sandbox.archiveAfter ? Date.parse(sandbox.archiveAfter) : null;
	return { id: sandbox.id, name: sandbox.name, type: match[2], snapshotSlug: match[3], imageHash: match[4], state: sandbox.state ?? null,
		live: LIVE.has(sandbox.state), deadline, remainingMs: deadline === null ? Infinity : deadline - now, createdAt: sandbox.createdAt ?? null };
}

export async function listSandboxes({ all = false } = {}) {
	const parsed = JSON.parse(await boat(['list', ...(all ? ['--all'] : []), '--json'], { timeoutMs: 120_000 }));
	return parsed.sandboxes ?? [];
}
export async function snapshotId(snapshot) {
	const parsed = JSON.parse(await boat(['snapshots', '--json'], { timeoutMs: 120_000 }));
	return (parsed.named ?? []).find(item => item.name === snapshot)?.snapshotId ?? null;
}
export const readLimits = async () => JSON.parse(await boat(['limits', '--json'], { timeoutMs: 60_000 })).starts ?? null;

/** A failed `boat new` that hit a start limit -> { window, retryAfterSeconds }, else null. The CLI's wording is parsed loosely. */
export function rateLimited(error) {
	const text = `${error?.message ?? ''} ${error?.stdout ?? ''}`;
	if (!/rate.?limit|429|too many|start limit|limit_reached/i.test(text)) return null;
	const window = /\b(minute|hour|day)\b/i.exec(text)?.[1]?.toLowerCase() ?? 'minute';
	const seconds = Number(/retry.?after\w*["':\s=]*(\d+)/i.exec(text)?.[1] ?? /(\d+)\s*(?:s\b|sec)/i.exec(text)?.[1]);
	return { window, retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null, concurrent: /limit_reached|at once/i.test(text) };
}

/**
 * The cleaning a pool machine gets before a batch and after it. mode 'mark' first writes the marker (a fresh machine),
 * 'adopt' skips it (a machine named with --machines); otherwise a missing or different marker fails it. Fails (exit 3/4/5) when the marker, the image or a killed room says
 * the machine should not be reused.
 */
export function cleanScript({ marker, imageDir = 'rooms', mode = 'check', ports = [28000, 29999] }) {
	return [
		'H="$HOME"; W="$H/batch"; J="$H/' + imageDir + '/jdk/"; M="$H/' + MARKER + '"',
		mode === 'adopt' ? ':' : mode === 'mark' ? `printf '%s' ${quote(marker)} > "$M" || exit 3` : `test "$(cat "$M" 2>/dev/null)" = ${quote(marker)} || { echo "pool marker does not match: $(head -c 300 "$M" 2>/dev/null)" >&2; exit 3; }`,
		// Every process a room left: its cwd, binary or command line is under ~/batch, or it runs the image's Java.
		'left=""',
		'for round in 1 2 3 4 5; do',
		'  left=""',
		'  for d in /proc/[0-9]*; do',
		'    p="${d#/proc/}"; [ "$p" = "$$" ] && continue; [ "$p" = "$PPID" ] && continue',
		'    cwd="$(readlink "$d/cwd" 2>/dev/null)" || continue',
		'    exe="$(readlink "$d/exe" 2>/dev/null)"; cmd="$(tr "\\0" " " < "$d/cmdline" 2>/dev/null)"',
		'    case "$cwd/ $exe $cmd" in *"$W/"*|*"$J"*) left="$left $p";; esac',
		'  done',
		'  [ -z "$left" ] && break',
		'  kill -9 $left 2>/dev/null; sleep 1',
		'done',
		'[ -n "$left" ] && { echo "processes of an earlier batch would not die:$left" >&2; exit 4; }',
		`if command -v ss >/dev/null; then held="$(ss -Htln 2>/dev/null | awk '{ n = split($4, a, ":"); p = a[n] + 0; if (p >= ${ports[0]} && p <= ${ports[1]}) print p }' | head -5 | tr '\\n' ' ')"; [ -n "$held" ] && { echo "room ports still held: $held" >&2; exit 4; }; fi`,
		'rm -rf "$W" "$H/.cache/mineagen/fixtures/worlds" || exit 5',
		`test -x "$J/bin/java" && test -f "$H/${imageDir}/template-26.3/server.jar" || { echo 'the image is missing Java or the server template' >&2; exit 5; }`,
		"command -v eatmydata >/dev/null || { echo 'eatmydata is missing' >&2; exit 5; }",
		'echo clean',
	].join('\n');
}

/**
 * Pool options: snapshot (name), type, ttlSeconds (deadline while a batch holds a machine), idleTtlSeconds (deadline set
 * when it comes back), startsPerMinute (pace of `boat new` over every batch on this computer), startReserve (a fill
 * stops creating when the hour or day start window has this many or fewer starts left), batch (lease label), and the
 * boatPool bundle for prepare/start/poll/fetch. store and boat calls are injectable for tests.
 * machines: ids of running machines to use instead of the pool. Only those are leased; none is ever created or deleted,
 * and one that fails its cleaning is left running for a look.
 */
export function warmBoatPool({ snapshot, type = 'default', ttlSeconds = 7200, idleTtlSeconds = 7200, startsPerMinute = 20, startReserve = 5,
	minRemainingSeconds = 15 * 60, roomPorts = [28000, 29999], machines = null, batch = null, bundle = null, imageDir = 'rooms', waitSeconds, log = console.log, store = leaseStore({ log }) } = {}) {
	// prepare, start, poll, alive and fetch are the ephemeral pool's; only where machines come from and go to differs.
	const base = bundle ? boatPool({ snapshot, type, ttlSeconds, namePrefix: 'unused', bundle, imageDir, log, ...(waitSeconds ? { waitSeconds } : {}) }) : {};
	let identity = null, listing = null, limits = null;
	const init = () => identity ??= (async () => {
		const poolId = await store.poolId();
		const id = await snapshotId(snapshot).catch(error => { log(`could not read the id of snapshot ${snapshot} (${error.message}); matching by its name only`); return null; });
		return { poolId, snapshotId: id, hash: imageHash(snapshot, id) };
	})();
	const markerOf = (name, ident) => JSON.stringify({ pool: ident.poolId, name, snapshot, snapshotId: ident.snapshotId, type });
	// One `boat list` serves every machine a batch asks for at once.
	const members = () => {
		if (!listing || Date.now() - listing.at > 5_000) listing = { at: Date.now(), promise: Promise.all([init(), listSandboxes()]).then(([ident, sandboxes]) => sandboxes.map(item => poolMember(item, ident.poolId)).filter(Boolean)) };
		listing.promise.catch(() => { listing = null; });
		return listing.promise;
	};
	// boat exec answers in about 0.4 s with the real exit code; ssh costs about 2.7 s (boat-pool.mjs).
	const clean = (vm, mode) => vm.adopted ? execRemote(vm.id, cleanScript({ marker: '', imageDir, mode: 'adopt', ports: roomPorts }), { timeoutSeconds: 90 }) : init().then(ident => execRemote(vm.id, cleanScript({ marker: markerOf(vm.name, ident), imageDir, mode, ports: roomPorts }), { timeoutSeconds: 90 }));
	/** Moves the deadline to at least ttl from now, never earlier. */
	async function holdFor(vm, ttl) {
		const info = JSON.parse(await boat(['info', vm.id, '--json'], { timeoutMs: 60_000 })).sandbox ?? {};
		if (!LIVE.has(info.state)) throw new Error(`machine ${vm.id} is ${info.state ?? 'gone'}`);
		if (info.archiveAfter === null) return;
		const remaining = Date.parse(info.archiveAfter) - Date.now();
		if (Number.isFinite(remaining) && remaining >= ttl * 1000 - 60_000) return;
		await extendMachine(vm.id, ttl);
	}
	async function destroy(vm) {
		if (vm.adopted) { await store.drop(vm.name); log(`machine ${vm.id} was named with --machines: left running, not deleted`); return; }
		try { await destroyMachine(vm.id); }
		catch (error) { if (!/not.?found|404|no such/i.test(error.message)) throw error; }
		await store.drop(vm.name);
	}
	async function startBudget() {
		if (!limits || Date.now() - limits.at > 20_000) {
			const starts = await readLimits().catch(error => { log(`could not read the start limits (${error.message})`); return null; });
			limits = { at: Date.now(), starts, used: 0 };
		}
		const { starts } = limits;
		if (!starts || starts.unlimited) return;
		for (const window of ['hour', 'day']) {
			const left = (starts[window]?.remaining ?? Infinity) - limits.used;
			if (left <= startReserve) throw new Error(`the ${window} sandbox start limit has ${Math.max(left, 0)} starts left, keeping ${startReserve} in reserve: no new machine`);
		}
		limits.used++;
	}
	async function createNew(signal) {
		const ident = await init();
		await startBudget();
		const name = machineName({ poolId: ident.poolId, type, snapshot, snapshotId: ident.snapshotId });
		// The lease exists before the machine does, so no other batch can take it between ready and lease.
		await store.take([name], { batch });
		try {
			for (let attempt = 1; ; attempt++) {
				const waited = await store.reserveStart({ perMinute: startsPerMinute, signal });
				if (waited > 1000) log(`waited ${Math.round(waited / 1000)} s to pace machine starts`);
				let vm;
				try { vm = await createMachine({ from: snapshot, type, ttlSeconds, name }); }
				catch (error) {
					const limit = rateLimited(error);
					if (!limit || limit.concurrent || limit.window !== 'minute' || attempt >= 4) throw error;
					const wait = Math.min((limit.retryAfterSeconds ?? 20 * attempt) * 1000, 120_000);
					log(`sandbox start limit for this minute is full; trying ${name} again in ${Math.round(wait / 1000)} s`);
					await sleep(wait, signal);
					continue;
				}
				const fresh = { id: vm.id, name, reused: false, ttlSeconds };
				try { await clean(fresh, 'mark'); }
				catch (error) { await destroy(fresh).catch(() => {}); throw new Error(`new machine ${vm.id} failed its first check: ${error.message}`); }
				log(`machine ${vm.id} started for the warm pool (${name})`);
				return fresh;
			}
		} catch (error) { await store.drop(name); throw error; }
	}

	return {
		...base,
		/** A cleaned machine for this snapshot and type: a warm one when one is free (no start), else a new one (one start). */
		async create({ signal = null } = {}) {
			if (machines) {
				const tried = new Set();
				while (true) {
					const id = await store.take(machines.filter(item => !tried.has(item)), { batch });
					if (!id) throw new Error('every machine named with --machines is busy or unusable');
					tried.add(id);
					const vm = { id, name: id, reused: true, adopted: true, ttlSeconds };
					try { await clean(vm); await holdFor(vm, ttlSeconds); log(`machine ${id} leased (named with --machines)`); return vm; }
					catch (error) { log(`named machine ${id} is not usable, skipping it: ${error.message}`); await store.drop(id); }
				}
			}
			const ident = await init();
			const tried = new Set();
			for (let round = 0; round < 50; round++) {
				if (signal?.aborted) throw new Error('batch stopped');
				const free = (await members()).filter(item => item.live && item.type === slug(type) && item.snapshotSlug === slug(snapshot) && item.imageHash === ident.hash
					&& item.remainingMs > minRemainingSeconds * 1000 && !tried.has(item.name));
				const name = await store.take(free.map(item => item.name), { batch });
				if (!name) break;
				tried.add(name);
				const member = free.find(item => item.name === name);
				const vm = { id: member.id, name, reused: true, ttlSeconds };
				try {
					await clean(vm, 'check');
					await holdFor(vm, ttlSeconds);
					log(`machine ${vm.id} reused from the warm pool (no start)`);
					return vm;
				} catch (error) {
					log(`warm machine ${vm.id} is not reusable, deleting it: ${error.message}`);
					await destroy(vm).catch(error2 => { log(`could not delete ${vm.id}: ${error2.message}`); return store.drop(name); });
				}
			}
			return createNew(signal);
		},
		/** Gives a machine back to the pool running: its rooms killed, its batch folder wiped, its deadline the idle TTL. */
		async release(vm) {
			try {
				await clean(vm, 'check');
				await holdFor(vm, idleTtlSeconds);
				await store.drop(vm.name);
				log(`machine ${vm.id} back in the warm pool for ${Math.round(idleTtlSeconds / 60)} min`);
			} catch (error) {
				log(`machine ${vm.id} could not go back to the pool (${error.message}): ${vm.adopted ? 'leaving it running for a look' : 'deleting it'}`);
				await destroy(vm);
				return !!vm.adopted;
			}
			return true;
		},
		async keepAlive(vm) { await holdFor(vm, ttlSeconds); },
		usage: vm => machineUsage(vm.id),
		destroy,
		/** Starts one new machine (one start, paced) and leases it, without looking for a free warm one. */
		startNew: ({ signal = null } = {}) => createNew(signal),
		holdFor,
		members,
		identity: init,
		store,
	};
}

export const minutesLeft = member => member.remainingMs === Infinity ? 'no auto-stop' : `${Math.max(0, Math.round(member.remainingMs / 60_000))} min`;
