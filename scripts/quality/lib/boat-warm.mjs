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
// so a warm machine starts a room the way a fresh one does. The image (Java, template, prepared servers) stays. No
// batch ever deletes or stops a machine: one that fails the check is set aside, still running, for a look or a prune.
import { createHash, randomBytes } from 'node:crypto';
import { boat, boatPool, createMachine, execRemote, extendMachine, machineUsage, quote, waitHydrated } from './boat-pool.mjs';
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
export const machineName = ({ poolId, type, snapshot, snapshotId, rand = randomBytes(4).toString('hex') }) => `rbpool-${poolId}-${slug(type)}-${slug(snapshot)}-${imageHash(snapshot, snapshotId)}-${rand}`;

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
	// The CLI lists one page; pool machines past it would go unseen and be paid for again as new starts.
	if (parsed.pageInfo?.hasMore) throw new Error(`boat list has more than one page (${parsed.sandboxes?.length ?? '?'} shown): the pool cannot see every machine`);
	return parsed.sandboxes ?? [];
}
/** The snapshot's id, or null when no saved snapshot has that name (the image hash then uses the name only). */
export async function snapshotId(snapshot) {
	const parsed = JSON.parse(await boat(['snapshots', '--json'], { timeoutMs: 120_000 }));
	return (parsed.named ?? []).find(item => item.name === snapshot)?.snapshotId ?? null;
}
/** A cleaning that failed on its own verdict (exit 3, 4 or 5: marker, stuck process, image) rather than a boat call that failed. */
export const verdictFailure = error => /^command failed on \S+ \((3|4|5)\)/.test(String(error?.message ?? ''));
const goneFailure = error => /^machine \S+ is /.test(String(error?.message ?? ''));
export const readLimits = async () => JSON.parse(await boat(['limits', '--json'], { timeoutMs: 60_000 })).starts ?? null;

/** A failed `boat new` that hit a start limit -> { window, retryAfterSeconds }, else null. The CLI's wording is parsed loosely. */
export function rateLimited(error) {
	const text = `${error?.message ?? ''} ${error?.stdout ?? ''}`;
	if (!/rate.?limit|429|too many|start limit|limit_reached/i.test(text)) return null;
	const window = /\b(minute|hour|day)\b/i.exec(text)?.[1]?.toLowerCase() ?? 'minute';
	const seconds = Number(/retry.?after\w*["':\s=]*(\d+)/i.exec(text)?.[1] ?? /(\d+)\s*(?:s\b|sec)/i.exec(text)?.[1]);
	return { window, retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null, concurrent: /limit_reached|at once/i.test(text) };
}

/** The shell function scan(): pids of every process a room left (see cleanScript), one line, space separated. */
const scanFunction = killJava => `scan() { { find /proc/[0-9]*/cwd /proc/[0-9]*/exe -maxdepth 0 -printf '%p\\t%l\\n' 2>/dev/null | PW="$W/" PJ="${killJava ? '$J' : ''}" awk -F '\\t' '{ split($1, p, "/"); t = $2; sub(/ \\(deleted\\)$/, "", t); if (index(t "/", ENVIRON["PW"]) == 1 || (ENVIRON["PJ"] != "" && index(t, ENVIRON["PJ"]) == 1)) print p[3] }'; ps -eo pid=,args= 2>/dev/null | PW="$W/" PJ="${killJava ? '$J' : ''}" awk 'index($0, ENVIRON["PW"]) || (ENVIRON["PJ"] != "" && index($0, ENVIRON["PJ"])) { print $1 }'; } | sort -u | grep -vx -e "$$" -e "$PPID" | tr "\\n" " "; }`;

/** Prints busy when a room or game process runs on a pool machine, else free (keepalive checks before deleting). */
export const busyScript = ({ imageDir = 'rooms' } = {}) => ['H="$HOME"; W="$H/batch"; J="$H/' + imageDir + '/jdk/"', scanFunction(true), 'left="$(scan)"; [ -n "${left% }" ] && echo busy || echo free'].join('\n');

/**
 * The cleaning a pool machine gets before a batch and after it. mode 'mark' first writes the marker (a fresh machine),
 * 'adopt' skips it (a machine named with --machines); otherwise a missing or different marker fails it. Fails (exit 3/4/5) when the marker, the image or a killed room says
 * the machine should not be reused.
 */
export function cleanScript({ marker, imageDir = 'rooms', mode = 'check', ports = [28000, 29999] }) {
	const killJava = mode !== 'adopt';
	return [
		'H="$HOME"; W="$H/batch"; J="$H/' + imageDir + '/jdk/"; M="$H/' + MARKER + '"',
		mode === 'adopt' ? ':' : mode === 'mark' ? `printf '%s' ${quote(marker)} > "$M" || exit 3` : `test "$(cat "$M" 2>/dev/null)" = ${quote(marker)} || { echo "pool marker does not match: $(head -c 300 "$M" 2>/dev/null)" >&2; exit 3; }`,
		// Every process a room left: its cwd is under ~/batch (also once deleted, which adds " (deleted)"), its binary is the
		// image's Java (pool machines only: a machine named with --machines may run other things on that Java), or its command
		// line names either. One find and one ps cover every process; the paths reach awk through its environment, never its
		// arguments, so the scan never finds itself, and find's tab-separated output keeps paths with spaces whole.
		scanFunction(killJava),
		'left=""',
		'for round in 1 2 3 4 5; do',
		'  left="$(scan)"; left="${left% }"',
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
export function warmBoatPool({ snapshot, type = 'default', ttlSeconds = 7200, idleTtlSeconds = 3600, startsPerMinute = 20, startReserve = 5,
	minRemainingSeconds = 120, roomPorts = [28000, 29999], machines = null, batch = null, bundle = null, imageDir = 'rooms', waitSeconds, log = console.log, store = leaseStore({ log }) } = {}) {
	// prepare, start, poll, alive and fetch are the ephemeral pool's; only where machines come from and go to differs.
	const base = bundle ? boatPool({ snapshot, type, ttlSeconds, namePrefix: 'unused', bundle, imageDir, log, ...(waitSeconds ? { waitSeconds } : {}) }) : {};
	let identity = null, listing = null, limits = null, adoptable = null;
	const init = () => identity ??= (async () => {
		const poolId = await store.poolId();
		// A failed lookup must not change the image hash: nothing would match and every machine would be a new start.
		let id, lastError;
		for (let attempt = 0; attempt < 3 && id === undefined; attempt++) {
			id = await snapshotId(snapshot).catch(error => { lastError = error; return undefined; });
			if (id === undefined) await sleep(2000 * (attempt + 1));
		}
		if (id === undefined) throw new Error(`could not read the saved snapshots to match ${snapshot}: ${lastError.message}`);
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
	// The read and the extend run under the machine's own lock: two callers (a batch and keepalive) that both read the
	// old deadline could otherwise land their extends out of order and leave the shorter one.
	const holdFor = (vm, ttl) => store.withKey(`ttl-${vm.id}`, async () => {
		const info = JSON.parse(await boat(['info', vm.id, '--json'], { timeoutMs: 60_000 })).sandbox ?? {};
		if (!LIVE.has(info.state)) throw new Error(`machine ${vm.id} is ${info.state ?? 'gone'}`);
		// No auto-stop (archiveAfter null) stays as it is: extend --ttl would put a deadline back on it.
		if (info.archiveAfter == null) return;
		const remaining = Date.parse(info.archiveAfter) - Date.now();
		if (Number.isFinite(remaining) && remaining >= ttl * 1000 - 60_000) return;
		await extendMachine(vm.id, ttl);
	});
	// Machines are never deleted by a batch (the owner's rule: keep every machine on). One that fails its cleaning check is set aside:
	// it stays running, no batch leases it, and `boat-pool.mjs status` lists it until `prune` or `drain` deletes it.
	async function setAside(vm, reason) {
		if (!vm.adopted) await store.setAside(vm.name, reason);
		await store.drop(vm.name);
		log(`machine ${vm.id} ${vm.adopted ? 'named with --machines failed its check' : 'set aside'} (${reason}): left running, not deleted`);
	}
	const destroy = vm => setAside(vm, 'the batch gave it up');
	// One limits read (shared while in flight, refreshed every 20 s) feeds the start ledger, which checks the hour and
	// day windows for every batch on this computer at once (pool-leases.mjs reserveStart).
	async function startBudget() {
		if (!limits || Date.now() - limits.at > 20_000) {
			const at = Date.now();
			limits = { at, read: readLimits().then(starts => ({ starts, readAt: at, reserve: startReserve }), error => { log(`could not read the start limits (${error.message})`); return null; }) };
		}
		return limits.read;
	}
	async function createNew(signal) {
		const ident = await init();
		// The lease exists before the machine does, so no other batch can take it between ready and lease. A name another
		// start already holds is drawn again: creating under a lease we do not hold would leave the machine unowned.
		let name = null;
		for (let draw = 0; draw < 5 && !name; draw++) name = await store.take([machineName({ poolId: ident.poolId, type, snapshot, snapshotId: ident.snapshotId })], { batch });
		if (!name) throw new Error('could not reserve a free machine name for a new machine');
		try {
			for (let attempt = 1; ; attempt++) {
				const waited = await store.reserveStart({ perMinute: startsPerMinute, signal, budget: await startBudget() });
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
				// A new machine's first room waits until the image has fully arrived (see waitHydrated); a warm one has.
				const hydrating = await waitHydrated(vm.id, { log });
				if (hydrating) log(`machine ${vm.id} waited ${hydrating} s for its image to finish downloading`);
				try { await clean(fresh, 'mark'); }
				catch (error) {
					// Only the check's own verdict sets a new machine aside; one that did not answer stays in the pool for a later lease.
					if (verdictFailure(error)) await setAside(fresh, `failed its first check: ${error.message}`).catch(() => {});
					throw new Error(`new machine ${vm.id} failed its first check: ${error.message}`);
				}
				log(`machine ${vm.id} started for the warm pool (${name})`);
				return fresh;
			}
		} catch (error) { await store.drop(name); throw error; }
	}

	return {
		...base,
		/** A cleaned machine for this snapshot and type: a warm one when one is free (no start), else a new one (one start). */
		async create({ signal = null, avoid = [] } = {}) {
			if (machines) {
				// Leases are keyed by the machine's name, as pool leases are, so a named machine that is also a pool member
				// can never be held by a pool batch and a --machines batch at once.
				adoptable ??= listSandboxes().then(sandboxes => {
					const found = new Map(sandboxes.filter(item => machines.includes(item.id) && LIVE.has(item.state)).map(item => [item.name || item.id, item.id]));
					for (const id of machines) if (![...found.values()].includes(id)) log(`machine ${id} named with --machines is not running: skipped`);
					store.list().then(leases => { for (const item of leases) if (found.has(item.name) && !item.stale && !store.holds(item.name)) log(`machine ${found.get(item.name)} (${item.name}) named with --machines is held by batch ${item.lease?.batch ?? '?'} (pid ${item.lease?.pid ?? '?'}): skipped`); }).catch(() => {});
					return found;
				});
				const byName = await adoptable;
				const tried = new Set();
				while (true) {
					const name = await store.take([...byName.keys()].filter(item => !tried.has(item) && !avoid.includes(byName.get(item)) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item)), { batch });
					if (!name) {
						// Say who holds each named machine: two batches on one machine wipe each other's rooms, so this is refused.
						const held = (await store.list()).filter(item => byName.has(item.name) && !item.stale && !store.holds(item.name));
						const detail = held.map(item => `${item.name} by batch ${item.lease?.batch ?? '?'} (pid ${item.lease?.pid ?? '?'})`).join(', ');
						throw new Error(`no machine named with --machines is free${held.length ? `: ${held.length} held by a live batch: ${detail}` : ''}${tried.size ? `; ${tried.size} failed their check` : ''}`);
					}
					tried.add(name);
					const id = byName.get(name);
					const vm = { id, name, reused: true, adopted: true, ttlSeconds };
					try { await clean(vm); await holdFor(vm, ttlSeconds); log(`machine ${id} leased (named with --machines)`); return vm; }
					catch (error) { log(`named machine ${id} is not usable, skipping it: ${error.message}`); await store.drop(name); }
				}
			}
			const ident = await init();
			const tried = new Set();
			for (let round = 0; round < 50; round++) {
				if (signal?.aborted) throw new Error('batch stopped');
				const free = (await members()).filter(item => item.live && item.type === slug(type) && item.snapshotSlug === slug(snapshot) && item.imageHash === ident.hash
					&& item.remainingMs > minRemainingSeconds * 1000 && !tried.has(item.name) && !avoid.includes(item.id));
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
					// The cleaning's own verdict, or boat saying the machine is gone, sets it aside; a boat call that failed (no
					// answer, a timeout) leaves it in the pool for a later lease.
					if (verdictFailure(error) || goneFailure(error)) await setAside(vm, error.message).catch(() => store.drop(name));
					else { log(`warm machine ${vm.id} did not answer its check, skipping it: ${error.message}`); await store.drop(name); }
				}
			}
			return createNew(signal);
		},
		// A batch that lost its lease (it stalled past the heartbeat and another batch broke it) must not touch the machine.
		async start(vm, job, options) {
			if (!await store.verify(vm.name)) throw new Error(`the lease on ${vm.id} was broken by another batch`);
			return base.start(vm, job, options);
		},
		/** Gives a machine back to the pool running: its rooms killed, its batch folder wiped, its deadline the idle TTL. */
		async release(vm) {
			if (!await store.verify(vm.name)) { log(`machine ${vm.id} now belongs to another batch: left alone`); return true; }
			try {
				await clean(vm, 'check');
				await holdFor(vm, idleTtlSeconds);
				await store.drop(vm.name);
				log(vm.adopted ? `machine ${vm.id} given back, still running` : `machine ${vm.id} back in the warm pool for ${Math.round(idleTtlSeconds / 60)} min`);
			} catch (error) {
				if (vm.adopted || !(verdictFailure(error) || goneFailure(error))) {
					// Unknown state is kept: the next lease cleans and checks it again before any room plays there.
					log(`machine ${vm.id} back in the pool unchecked (${error.message}): the next lease checks it`);
					await store.drop(vm.name);
					return true;
				}
				await setAside(vm, error.message);
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
