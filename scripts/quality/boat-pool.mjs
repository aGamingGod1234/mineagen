// This computer's warm pool of boat machines for room-batch.mjs (see lib/boat-warm.mjs).
//   node scripts/quality/boat-pool.mjs status [--json]
//   node scripts/quality/boat-pool.mjs warm N --snapshot NAME [--type TYPE] [--idle-ttl MIN]
//   node scripts/quality/boat-pool.mjs keepalive [--idle-ttl MIN] [--every MIN]
//   node scripts/quality/boat-pool.mjs drain [--snapshot NAME] [--type TYPE]
//   node scripts/quality/boat-pool.mjs prune
// status lists the pool's machines: busy (which batch holds it) or idle, the image, and the time to its auto-stop.
// warm makes sure N machines of that image and size exist, starting only the shortfall (paced, one start each), and
// leaves them idle. keepalive sets every idle machine's auto-stop to at least --idle-ttl from now (default 120 min,
// ROOM_BATCH_IDLE_TTL_MIN); with --every it repeats until stopped, so the pool stays up between batches. An idle
// machine is never extended without it, so a forgotten pool stops by itself. drain deletes every idle machine (or
// those of one image and size); a busy one is left to its batch. prune deletes machines that are not running, idle
// machines of an image that was rebuilt or deleted, and lease files of batches that are gone.
// --snapshot defaults to ROOM_BATCH_SNAPSHOT and --type to ROOM_BATCH_TYPE or "default".
import { imageHash, listSandboxes, minutesLeft, poolMember, warmBoatPool } from './lib/boat-warm.mjs';
import { boat, destroyMachine } from './lib/boat-pool.mjs';
import { leaseStore } from './lib/pool-leases.mjs';

const USAGE = 'Usage: boat-pool.mjs status [--json] | warm N --snapshot NAME [--type TYPE] [--idle-ttl MIN] | keepalive [--idle-ttl MIN] [--every MIN] | drain [--snapshot NAME] [--type TYPE] | prune';
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
const idleTtlSeconds = Math.round(Number(flags.idleTtl ?? process.env.ROOM_BATCH_IDLE_TTL_MIN ?? 120) * 60);
if (!Number.isFinite(idleTtlSeconds) || idleTtlSeconds < 300) fail('--idle-ttl wants at least 5 minutes');
const snapshot = flags.snapshot ?? process.env.ROOM_BATCH_SNAPSHOT ?? null;
const type = flags.type ?? process.env.ROOM_BATCH_TYPE ?? 'default';
const log = message => console.log(`${new Date().toISOString()} ${message}`);
const store = leaseStore({ log });
const poolId = await store.poolId();
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** The pool's machines with their lease and image state. */
async function inventory({ all = true } = {}) {
	const [sandboxes, leases, named] = await Promise.all([
		listSandboxes({ all }),
		store.list(),
		boat(['snapshots', '--json'], { timeoutMs: 120_000 }).then(text => JSON.parse(text).named ?? [], () => null),
	]);
	const byName = new Map(leases.map(item => [item.name, item]));
	const images = named && new Map(named.map(item => [`${item.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}`, item]));
	return sandboxes.map(item => poolMember(item, poolId)).filter(Boolean).map(member => {
		const lease = byName.get(member.name);
		const image = images?.get(member.snapshotSlug);
		return { ...member, lease: lease?.lease ?? null, busy: Boolean(lease && !lease.stale), staleLease: lease?.stale && lease.lease ? lease.stale : null,
			image: image?.name ?? null, currentImage: images ? Boolean(image && imageHash(image.name, image.snapshotId) === member.imageHash) : null };
	});
}
const matches = member => (!snapshot || member.image === snapshot) && member.type === type.toLowerCase().replace(/[^a-z0-9]/g, '');

async function destroyIdle(member, why) {
	// Taking the lease first means no batch can lease the machine while it is being deleted.
	if (!await store.take([member.name], { batch: `boat-pool ${command}` })) { log(`${member.id} is busy, left alone`); return false; }
	try {
		await destroyMachine(member.id).catch(error => { if (!/not.?found|404|no such/i.test(error.message)) throw error; });
		log(`deleted ${member.id} (${why})`);
		return true;
	} catch (error) { log(`could not delete ${member.id}: ${error.message}`); return false; }
	finally { await store.drop(member.name); }
}

if (command === 'status') {
	const members = await inventory();
	if (flags.json) { console.log(JSON.stringify({ poolId, members }, null, 2)); process.exit(0); }
	console.log(`warm pool ${poolId} (lease files in ${store.dir}): ${members.length} machines, ${members.filter(item => item.busy).length} busy, ${members.filter(item => item.live && !item.busy).length} idle; boat new calls from this computer in the last hour: ${await store.recentStarts()}`);
	console.log('id            state     lease                         image                       type     auto-stop in');
	for (const item of members.sort((a, b) => a.name.localeCompare(b.name))) {
		const lease = item.busy ? `busy: ${item.lease.batch ?? '?'} (pid ${item.lease.pid})` : item.staleLease ? `idle (stale lease: ${item.staleLease})` : 'idle';
		const image = item.currentImage === null ? item.snapshotSlug : item.image ? `${item.image}${item.currentImage ? '' : ' (OLD)'}` : `${item.snapshotSlug} (gone)`;
		console.log(`${item.id.padEnd(13)} ${String(item.state).padEnd(9)} ${lease.slice(0, 29).padEnd(29)} ${image.slice(0, 27).padEnd(27)} ${item.type.padEnd(8)} ${minutesLeft(item)}`);
	}
} else if (command === 'warm') {
	const want = Number(flags.positional[0]);
	if (!Number.isInteger(want) || want < 1 || want > 200) fail('warm wants a count from 1 to 200');
	if (!snapshot) fail('warm needs --snapshot or ROOM_BATCH_SNAPSHOT');
	const have = (await inventory({ all: false })).filter(item => item.live && item.currentImage !== false && matches(item));
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
	const pool = warmBoatPool({ snapshot: snapshot ?? 'any', type, idleTtlSeconds, log, store });
	do {
		const idle = (await inventory({ all: false })).filter(item => item.live && !item.busy);
		let extended = 0;
		for (const item of idle) {
			try { const before = item.remainingMs; await pool.holdFor(item, idleTtlSeconds); if (before < idleTtlSeconds * 1000 - 60_000) extended++; }
			catch (error) { log(`could not extend ${item.id}: ${error.message}`); }
		}
		log(`${idle.length} idle machines: ${extended} pushed to ${Math.round(idleTtlSeconds / 60)} min from now, the rest already had longer`);
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
		else if (item.currentImage === false) { if (await destroyIdle(item, item.image ? 'its image was rebuilt' : 'its image is gone')) deleted++; }
	}
	let cleared = 0;
	for (const lease of await store.list()) if (lease.stale && await store.clear(lease.name)) cleared++;
	log(`deleted ${deleted} machines, cleared ${cleared} stale lease files`);
} else fail(`unknown command ${command}`);
store.stop();
