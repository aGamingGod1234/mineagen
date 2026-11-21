// This computer's warm pool of boat machines for room-batch.mjs (see lib/boat-warm.mjs).
//   node scripts/quality/boat-pool.mjs status [--json]
//   node scripts/quality/boat-pool.mjs warm N --snapshot NAME [--type TYPE] [--idle-ttl MIN]
//   node scripts/quality/boat-pool.mjs keepalive [--warm N] [--night HH:MM-HH:MM --night-warm N] [--grace MIN] [--keep PREFIX,...]
//     [--idle-stop PREFIX,... [--idle-stop-min MIN]] [--idle-ttl MIN] [--every MIN]
//   node scripts/quality/boat-pool.mjs drain [--snapshot NAME] [--type TYPE]
//   node scripts/quality/boat-pool.mjs prune
// status lists the pool's machines: busy (which batch holds it) or idle, the image, and the time to its auto-stop.
// warm makes sure N machines of that image and size exist, starting only the shortfall (paced, one start each), and
// leaves them idle. keepalive keeps the pool warm without paying for idle machines nobody needs: idle machines bill in
// full. It sets the auto-stop of every busy pool machine, of the --warm N idle ones a batch gave back most recently,
// and of every running machine whose name starts with a --keep prefix (machines a benchmark made for --machines) to at
// least --idle-ttl from now (default 60 min, ROOM_BATCH_IDLE_TTL_MIN), never earlier, leaving a machine with auto-stop
// off alone. Idle pool machines beyond the warm N, idle for --grace minutes (default 10), are deleted, longest idle
// first, once their lease is taken and nothing runs there; any other machine is left to reach its auto-stop. Without
// --warm every idle pool machine is kept warm; --night-warm replaces --warm during --night (this computer's clock).
// --idle-stop machines stop by themselves --idle-stop-min (default 60) after their last work or their batch's lease, and
// are never deleted here (a machine made with --no-snapshots is erased by its stop: give only machines that may go).
// With --every it repeats until stopped. drain
// deletes every idle machine (or those of one image and size); a busy one is left to its batch. prune deletes machines
// that are not running, idle machines of an image that was rebuilt or deleted, and machines a batch set aside after a
// failed cleaning check, and clears lease files of batches that are gone. Only drain, prune and keepalive --warm delete.
// --snapshot defaults to ROOM_BATCH_SNAPSHOT and --type to ROOM_BATCH_TYPE or "default".
import { LIVE, busyScript, imageHash, listSandboxes, minutesLeft, poolMember, warmBoatPool } from './lib/boat-warm.mjs';
import { boat, destroyMachine, execRemote, extendMachine } from './lib/boat-pool.mjs';
import { leaseStore } from './lib/pool-leases.mjs';

const USAGE = 'Usage: boat-pool.mjs status [--json] | warm N --snapshot NAME [--type TYPE] [--idle-ttl MIN] | keepalive [--idle-ttl MIN] [--every MIN] [--include PREFIX,...] | drain [--snapshot NAME] [--type TYPE] | prune';
const argv = process.argv.slice(2);
const command = argv.shift();
const flags = { positional: [] };
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--json') flags.json = true;
	else if (argv[i].startsWith('--')) flags[argv[i].slice(2).replace(/-(\w)/g, (_, ch) => ch.toUpperCase())] = argv[++i];
	else flags.positional.push(argv[i]);
}
const fail = message => { console.error(`${message}\n${USAGE}`); process.exit(2); };
if (!command || command === '--help' || command === 'help') { console.log(USAGE); process.exit(command ? 0 : 2); }
const idleTtlSeconds = Math.round(Number(flags.idleTtl ?? process.env.ROOM_BATCH_IDLE_TTL_MIN ?? 60) * 60);
if (!Number.isFinite(idleTtlSeconds) || idleTtlSeconds < 300) fail('--idle-ttl wants at least 5 minutes');
const snapshot = flags.snapshot ?? process.env.ROOM_BATCH_SNAPSHOT ?? null;
const type = flags.type ?? process.env.ROOM_BATCH_TYPE ?? 'default';
const log = message => console.log(`${new Date().toISOString()} ${message}`);
const store = leaseStore({ log });
const poolId = await store.poolId();
const sleep = ms => new Promise(done => setTimeout(done, ms));
// Work on a build machine: a compiler, JVM (Gradle, a server) or Node process, or a load average of 1 or more. Matching
// process names, not command lines, keeps this script from finding itself.
const WORK_SCRIPT = `if pgrep -x 'java|node|gradle|cc1|cc1plus|make|cargo|rustc|go' >/dev/null || awk '{ exit !($1 >= 1) }' /proc/loadavg; then echo busy; else echo idle; fi`;

/** The pool's machines with their lease and image state. */
async function inventory({ all = true } = {}) {
	const [sandboxes, leases, named, aside] = await Promise.all([
		listSandboxes({ all }),
		store.list(),
		boat(['snapshots', '--json'], { timeoutMs: 120_000 }).then(text => JSON.parse(text).named ?? [], () => null),
		store.asideList(),
	]);
	const asideByName = new Map(aside.map(item => [item.name, item]));
	const byName = new Map(leases.map(item => [item.name, item]));
	// Names are shortened in machine names, so two images can share a slug; the hash (full name and snapshot id) decides.
	const slugOf = name => name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'none';
	return sandboxes.map(item => poolMember(item, poolId)).filter(Boolean).map(member => {
		const lease = byName.get(member.name);
		const sameSlug = named ? named.filter(item => slugOf(item.name) === member.snapshotSlug) : null;
		const image = sameSlug?.find(item => imageHash(item.name, item.snapshotId) === member.imageHash) ?? null;
		return { ...member, lease: lease?.lease ?? null, busy: Boolean(lease && !lease.stale), staleLease: lease?.stale && lease.lease ? lease.stale : null, aside: asideByName.get(member.name)?.reason ?? null,
			image: image?.name ?? (sameSlug?.length === 1 ? sameSlug[0].name : null), currentImage: named ? Boolean(image) : null };
	});
}
const matches = member => (!snapshot || member.image === snapshot) && member.type === type.toLowerCase().replace(/[^a-z0-9]/g, '');

async function destroyIdle(member, why) {
	// Taking the lease first means no batch can lease the machine while it is being deleted.
	// A set-aside machine has no batch on it; the lease only keeps one from starting while it is deleted.
	if (!await store.take([member.name], { batch: `boat-pool ${command}`, includeAside: true })) { log(`${member.id} is busy, left alone`); return false; }
	try {
		await destroyMachine(member.id).catch(error => { if (!/not.?found|404|no such/i.test(error.message)) throw error; });
		await store.clearAside(member.name);
		await store.forgetIdle(member.name);
		log(`deleted ${member.id} (${why})`);
		return true;
	} catch (error) { log(`could not delete ${member.id}: ${error.message}`); return false; }
	finally { await store.drop(member.name); }
}

if (command === 'status') {
	const members = await inventory();
	if (flags.json) { console.log(JSON.stringify({ poolId, members }, null, 2)); process.exit(0); }
	console.log(`warm pool ${poolId} (lease files in ${store.dir}): ${members.length} machines, ${members.filter(item => item.busy).length} busy, ${members.filter(item => item.live && !item.busy && !item.aside).length} idle, ${members.filter(item => item.aside).length} set aside; boat new calls from this computer in the last hour: ${await store.recentStarts()}`);
	console.log('id            state     lease                         image                       type     auto-stop in');
	for (const item of members.sort((a, b) => a.name.localeCompare(b.name))) {
		const lease = item.aside ? `SET ASIDE: ${item.aside}` : item.busy ? `busy: ${item.lease.batch ?? '?'} (pid ${item.lease.pid})` : item.staleLease ? `idle (stale lease: ${item.staleLease})` : 'idle';
		const image = item.currentImage === null ? item.snapshotSlug : item.image ? `${item.image}${item.currentImage ? '' : ' (OLD)'}` : `${item.snapshotSlug} (gone)`;
		console.log(`${item.id.padEnd(13)} ${String(item.state).padEnd(9)} ${lease.slice(0, 29).padEnd(29)} ${image.slice(0, 27).padEnd(27)} ${item.type.padEnd(8)} ${minutesLeft(item)}`);
	}
} else if (command === 'warm') {
	const want = Number(flags.positional[0]);
	if (!Number.isInteger(want) || want < 1 || want > 200) fail('warm wants a count from 1 to 200');
	if (!snapshot) fail('warm needs --snapshot or ROOM_BATCH_SNAPSHOT');
	const have = (await inventory({ all: false })).filter(item => item.live && !item.aside && item.currentImage !== false && matches(item));
	const missing = want - have.length;
	log(`${have.length} ${type} machines of ${snapshot} in the pool${missing > 0 ? `; starting ${missing}` : ''}`);
	const pool = warmBoatPool({ snapshot, type, ttlSeconds: idleTtlSeconds, idleTtlSeconds, startsPerMinute: Number(process.env.ROOM_BATCH_STARTS_PER_MINUTE ?? 20), batch: 'boat-pool warm', log, store });
	const made = await Promise.allSettled(Array.from({ length: Math.max(missing, 0) }, async () => { const vm = await pool.startNew(); await pool.release(vm); return vm; }));
	for (const item of made.filter(result => result.status === 'rejected')) log(`a machine did not start: ${item.reason.message}`);
	log(`${made.filter(result => result.status === 'fulfilled').length} started, ${have.length} were already there`);
	if (made.some(result => result.status === 'rejected')) process.exitCode = 1;
} else if (command === 'keepalive') {
	const every = flags.every === undefined ? null : Number(flags.every) * 60_000;
	if (every !== null && !(every >= 60_000)) fail('--every wants at least 1 minute');
	const dayWarm = flags.warm === undefined ? null : Number(flags.warm);
	if (dayWarm !== null && !(Number.isInteger(dayWarm) && dayWarm >= 0)) fail('--warm wants a whole number of machines');
	// --night HH:MM-HH:MM (this computer's clock) with --night-warm N: a smaller warm pool while nobody starts batches.
	const night = flags.night === undefined ? null : /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(flags.night);
	if (flags.night !== undefined && !night) fail('--night wants HH:MM-HH:MM');
	const nightWarm = flags.nightWarm === undefined ? dayWarm : Number(flags.nightWarm);
	if (nightWarm !== null && !(Number.isInteger(nightWarm) && nightWarm >= 0)) fail('--night-warm wants a whole number of machines');
	const atNight = (date = new Date()) => {
		if (!night) return false;
		const minute = date.getHours() * 60 + date.getMinutes(), from = Number(night[1]) * 60 + Number(night[2]), to = Number(night[3]) * 60 + Number(night[4]);
		return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
	};
	// --idle-stop PREFIX,...: machines (a thread's build machines) that stop by themselves --idle-stop-min after their
	// last work: each round one doing work gets its deadline pushed that far, and an idle one with auto-stop off gets it
	// turned on. Their snapshots keep the data, so the stop can be undone; nothing here deletes them.
	const idleStop = String(flags.idleStop ?? '').split(',').map(item => item.trim()).filter(Boolean);
	const idleStopSeconds = Math.round(Number(flags.idleStopMin ?? 60) * 60);
	if (!(idleStopSeconds >= 300)) fail('--idle-stop-min wants at least 5 minutes');
	const graceMs = Number(flags.grace ?? 10) * 60_000;
	if (!(graceMs >= 0)) fail('--grace wants minutes');
	const pool = warmBoatPool({ snapshot: snapshot ?? 'any', type, idleTtlSeconds, log, store });
	// --include is the old name of --keep.
	const prefixes = String(flags.keep ?? flags.include ?? '').split(',').map(item => item.trim()).filter(Boolean);
	do {
		try {
		const members = (await inventory({ all: false })).filter(item => item.live);
		const warmCount = atNight() ? nightWarm : dayWarm;
		const since = await store.idleSince();
		const idleFor = item => Date.now() - (since[item.name] ?? 0);
		// Idle pool machines, most recently given back first. A machine with no record (given back before records were
		// kept) counts as long idle for --grace, and ranks by when it was made, newest first, behind every recorded one.
		const rank = item => since[item.name] ?? (Date.parse(item.createdAt ?? '') || 0) - 1e12;
		const idle = members.filter(item => !item.busy && !item.aside).sort((a, b) => rank(b) - rank(a));
		const warm = warmCount === null ? idle : idle.slice(0, warmCount);
		const extra = warmCount === null ? [] : idle.slice(warmCount).filter(item => idleFor(item) >= graceMs).reverse();
		let deleted = 0, skipped = 0, failed = 0;
		for (const item of extra) {
			// Nothing may be running there: a room or game left by a batch that lost track of it keeps the machine.
			const running = await execRemote(item.id, busyScript(), { timeoutSeconds: 30 }).catch(() => 'unknown');
			if (!/free/.test(running)) { skipped++; log(`${item.id} kept: ${/busy/.test(running) ? 'a room or game is still running there' : 'it did not answer'}`); continue; }
			if (await destroyIdle(item, `beyond the warm ${warmCount}, idle ${since[item.name] ? `${Math.round(idleFor(item) / 60_000)} min` : 'since before idle times were kept'}`)) { deleted++; await store.forgetIdle(item.name); }
		}
		// Extended: busy pool machines (holdFor only moves a deadline later), the warm ones, and named machines to keep.
		const named = prefixes.length ? (await listSandboxes()).filter(item => LIVE.has(item.state) && prefixes.some(prefix => String(item.name ?? '').startsWith(prefix)) && !members.some(member => member.id === item.id))
			.map(item => ({ id: item.id, name: item.name, remainingMs: item.archiveAfter ? Date.parse(item.archiveAfter) - Date.now() : Infinity })) : [];
		const hold = [...members.filter(item => item.busy), ...warm, ...named];
		let extended = 0;
		for (const item of hold) {
			try { const before = item.remainingMs; await pool.holdFor(item, idleTtlSeconds); if (before < idleTtlSeconds * 1000 - 60_000) extended++; }
			catch (error) { failed++; log(`could not extend ${item.id}: ${error.message}`); }
		}
		let stopping = 0, working = 0;
		if (idleStop.length) {
			const leased = new Set((await store.list()).filter(item => !item.stale).map(item => item.name));
			for (const item of (await listSandboxes()).filter(item => LIVE.has(item.state) && idleStop.some(prefix => String(item.name ?? '').startsWith(prefix)))) {
				try {
					// A machine a live batch holds is that batch's: its rooms may sit between steps.
					if (leased.has(item.name)) { working++; await pool.holdFor(item, idleStopSeconds); continue; }
					const state = await execRemote(item.id, WORK_SCRIPT, { timeoutSeconds: 30 }).catch(() => 'unknown');
					const remaining = item.archiveAfter == null ? Infinity : Date.parse(item.archiveAfter) - Date.now();
					if (/busy/.test(state)) { working++; await pool.holdFor(item, idleStopSeconds); }
					// Idle: auto-stop no later than --idle-stop-min from now (turned on if it was off, brought in if it was further).
					else if (/idle/.test(state) && remaining > idleStopSeconds * 1000 + 60_000) { stopping++; await extendMachine(item.id, idleStopSeconds); log(`${item.name} (${item.id}) is idle: it stops in ${Math.round(idleStopSeconds / 60)} min unless work starts`); }
				} catch (error) { failed++; log(`could not set the idle stop of ${item.id}: ${error.message}`); }
			}
		}
		const left = members.length - hold.length + named.length - deleted;
		log(`pool ${members.length} (${members.filter(item => item.busy).length} busy, ${idle.length} idle, warm ${warm.length} of ${warmCount ?? 'all'}${atNight() ? ', night' : ''}), named ${named.length}: ${deleted} deleted, ${skipped} kept with work on them, ${extended} pushed to ${Math.round(idleTtlSeconds / 60)} min, ${failed} failed; ${Math.max(left, 0)} left to their auto-stop${idleStop.length ? `; idle-stop machines: ${working} working, ${stopping} set to stop` : ''}`);
		} catch (error) {
			// One failed boat call must not end a keepalive that runs all day; the next round tries again.
			if (every === null) throw error;
			log(`keepalive round failed: ${error.message}`);
		}
		if (every !== null) await sleep(every);
	} while (every !== null);
} else if (command === 'drain') {
	const members = (await inventory()).filter(item => matches(item) || (!flags.snapshot && !flags.type));
	let deleted = 0;
	for (const item of members) if (!item.busy && await destroyIdle(item, 'drain')) deleted++;
	log(`deleted ${deleted} machines; ${members.filter(item => item.busy).length} busy ones left to their batches`);
} else if (command === 'prune') {
	const members = await inventory();
	let deleted = 0;
	for (const item of members) {
		if (item.busy) continue;
		if (!item.live) { if (await destroyIdle(item, `state ${item.state}`)) deleted++; }
		else if (item.aside) { if (await destroyIdle(item, `set aside: ${item.aside}`)) deleted++; }
		else if (item.currentImage === false) { if (await destroyIdle(item, item.image ? 'its image was rebuilt' : 'its image is gone')) deleted++; }
	}
	let cleared = 0;
	const present = new Set(members.map(item => item.name));
	for (const item of await store.asideList()) if (!present.has(item.name)) await store.clearAside(item.name);
	for (const lease of await store.list()) if (lease.stale && await store.clear(lease.name)) cleared++;
	log(`deleted ${deleted} machines, cleared ${cleared} stale lease files`);
} else fail(`unknown command ${command}`);
store.stop();
