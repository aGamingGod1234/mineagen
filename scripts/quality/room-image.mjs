// Builds the saved boat image room-batch.mjs forks its machines from. Rerun it when the template or Java changes.
//   node scripts/quality/room-image.mjs --template TEMPLATE_DIR --snapshot NAME [--type TYPE] [--warm-jar JAR]
//     [--jdk-url URL --jdk-sha256 HEX] [--keep]
// One fresh --no-env machine gets, under its home: rooms/jdk (Temurin, checked against its SHA-256), rooms/template-26.3
// (TEMPLATE_DIR copied as is; ARENA_HEADLESS_SERVER_TEMPLATE for every room) and rooms/image.json. Node 22 or newer and
// python3 (fixture-servers.mjs unpacks the vanilla bundle with it) must already be on the machine; eatmydata (rooms run
// under it) and zstd (the batch bundle is packed with it), see boat-pool.mjs, are installed when missing. --warm-jar plays one short room (carve-hidden-lava) with that
// jar, through the same helper a batch uses; the image is saved only when that room passes, which proves the image and
// leaves the prepared server in the fixture cache so batch rooms skip the unpack. The machine is then saved with
// `boat snapshot ID NAME` and deleted (--keep leaves it running).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boat, boatPool, buildBundle, createMachine, destroyMachine, machineUsage, quote, remote, upload, waitHydrated } from './lib/boat-pool.mjs';
import { parseCommands } from './lib/room-batch-core.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Temurin 25.0.5+8, the build the Linux fixture machine runs; the hash is the one Adoptium publishes next to the archive.
const JDK_URL = 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jdk_x64_linux_hotspot_25.0.5_8.tar.gz';
const JDK_SHA256 = '68982529869257d0ee6b824ec5aa270ff8b118bb438670da0b97ebdab178d7fb';
const WARM_ROOM = '@warm BUILD_ONLY=carve-hidden-lava node scripts/quality/test-build-live.mjs scripts/quality/carve-hidden-fluid-spots.json $OUT $JAR --descriptive';

const argv = process.argv.slice(2), flags = {};
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--keep' || argv[i] === '--help') flags[argv[i].slice(2)] = true;
	else flags[argv[i].slice(2).replace(/-(\w)/g, (_, ch) => ch.toUpperCase())] = argv[++i];
}
if (flags.help || !flags.template || !flags.snapshot) {
	console.log('Usage: room-image.mjs --template TEMPLATE_DIR --snapshot NAME [--type TYPE] [--warm-jar JAR] [--jdk-url URL --jdk-sha256 HEX] [--keep]');
	process.exit(flags.help ? 0 : 2);
}
const template = path.resolve(flags.template), type = flags.type ?? process.env.ROOM_BATCH_TYPE ?? 'default';
const jdkUrl = flags.jdkUrl ?? JDK_URL, jdkSha = flags.jdkSha256 ?? (flags.jdkUrl ? null : JDK_SHA256);
if (!jdkSha) { console.error('--jdk-url needs --jdk-sha256'); process.exit(2); }
const serverSha = createHash('sha256').update(readFileSync(path.join(template, 'server.jar'))).digest('hex');
const step = message => console.log(`${new Date().toISOString()} ${message}`);

const work = await mkdtemp(path.join(os.tmpdir(), 'room-image-'));
const began = Date.now();
step(`creating a ${type} machine`);
// Ctrl-C (or SIGTERM) deletes the machine before exiting, at any point of the build.
let vm = null, creating = null, deleting = null, stopping = false;
const deleteVmOnce = () => {
	if (deleting) return deleting;
	if (!vm) return Promise.resolve();
	const id = vm.id;
	vm = null;
	deleting = destroyMachine(id).then(() => step(`deleted ${id}`), error => step(`could not delete ${id}: ${error.message}`));
	return deleting;
};
const stopAndExit = async (code) => {
	if (creating) {
		try { vm = await creating; } catch {}
		creating = null;
	}
	await deleteVmOnce();
	await rm(work, { recursive: true, force: true }).catch(() => {});
	process.exit(code);
};
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => {
	if (stopping) return;
	stopping = true;
	step(`${name}: deleting the image machine`);
	void stopAndExit(130);
});
try {
	creating = createMachine({ type, ttlSeconds: 3600, name: `room-image-${flags.snapshot}`, snapshots: true });
	vm = await creating;
	creating = null;
	if (stopping) await new Promise(() => {});
} catch (error) {
	creating = null;
	if (stopping) await new Promise(() => {});
	await rm(work, { recursive: true, force: true }).catch(() => {});
	throw error;
}
step(`machine ${vm.id}`);
let saved = false;
try {
	// A machine can answer before boat has finished downloading its files, and a room on it then fails (waitHydrated).
	const hydrating = await waitHydrated(vm.id, { log: step });
	if (hydrating) step(`waited ${hydrating} s for the machine's files to finish downloading`);
	const home = (await remote(vm.id, 'printf %s "$HOME"')).trim();
	const rooms = `${home}/rooms`;
	step('installing Java');
	await remote(vm.id, `set -e; rm -rf ${quote(rooms)}; mkdir -p ${quote(rooms)}/jdk; cd ${quote(rooms)}; curl -fsSL -o jdk.tgz ${quote(jdkUrl)}
echo ${quote(`${jdkSha}  jdk.tgz`)} | sha256sum -c -; tar -xzf jdk.tgz -C jdk --strip-components=1; rm jdk.tgz; jdk/bin/java -version 2>&1 | head -1
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
missing=$(for tool in eatmydata zstd; do command -v $tool >/dev/null || echo $tool; done)
[ -z "$missing" ] || { sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing; }
command -v python3 tar gzip zstd setsid eatmydata >/dev/null`, { timeoutMs: 15 * 60_000 });
	step('copying the template');
	execFileSync('tar', ['-czf', path.join(work, 'template.tgz'), '-C', template, '.']);
	await upload(vm.id, path.join(work, 'template.tgz'), `${rooms}/template.tgz`);
	await remote(vm.id, `set -e; mkdir -p ${quote(rooms)}/template-26.3; tar -xzf ${quote(rooms)}/template.tgz -C ${quote(rooms)}/template-26.3; rm ${quote(rooms)}/template.tgz
echo ${quote(`${serverSha}  ${rooms}/template-26.3/server.jar`)} | sha256sum -c - >/dev/null`);
	let warm = null;
	if (flags.warmJar) {
		step('playing the warm-up room');
		const bundle = await buildBundle({ root, ref: 'HEAD', jars: { warm: path.resolve(flags.warmJar) }, helper: path.join(root, 'scripts/quality/lib/room-batch-remote.mjs'), work });
		const pool = boatPool({ snapshot: null, type, namePrefix: 'unused', bundle });
		const layout = await pool.prepare(vm);
		const [room] = parseCommands(WARM_ROOM, ['warm']);
		const job = { room: room.room, code: layout.code, outDir: `${layout.out}/${room.room}`, javaHome: layout.javaHome, template: layout.template, timeoutMs: 15 * 60_000, wrapper: layout.wrapper,
			lines: room.lines.map(line => ({ ...line, jar: layout.jars.warm })) };
		await pool.start(vm, job);
		// poll waits on the machine for up to a minute at a time, so no sleep between polls.
		const deadline = Date.now() + job.timeoutMs + 5 * 60_000;
		while (await pool.poll(vm, room.room) !== 'done') {
			if (Date.now() > deadline) throw new Error('the warm-up room never wrote done.json; the image is not saved');
		}
		const done = JSON.parse(await remote(vm.id, `cat ${quote(`${job.outDir}/done.json`)}`));
		const summary = JSON.parse(await remote(vm.id, `cat ${quote(`${job.outDir}/warm/result-summary.json`)} 2>/dev/null || echo null`));
		warm = { seconds: done.seconds, exit: done.arms.warm.exit, cantKeepUp: done.arms.warm.cantKeepUp, minAvailableMb: done.machine.minAvailableMb, summary };
		step(`warm-up room: ${JSON.stringify(warm)}`);
		if (done.arms.warm.timedOut || done.arms.warm.signal || done.arms.warm.error) throw new Error(`the warm-up room was killed (${JSON.stringify(done.arms.warm)}); the image is not saved`);
		if (summary?.status !== 'PASS') throw new Error(`the warm-up room did not pass (${summary?.status ?? 'no summary'}); the image is not saved`);
		// Keep the prepared server (keyed on the template's path and file times, which every fork shares); drop the rest.
		await remote(vm.id, `rm -rf ${quote(`${home}/batch`)} ${quote(`${home}/.cache/mineagen/fixtures/worlds`)}; ls ${quote(`${home}/.cache/mineagen/fixtures/servers`)}`);
	}
	const image = { snapshot: flags.snapshot, builtAt: new Date().toISOString(), jdkUrl, jdkSha256: jdkSha, templateServerSha256: serverSha, warm,
		java: (await remote(vm.id, `${quote(rooms)}/jdk/bin/java -version 2>&1 | head -2`)).trim(), node: (await remote(vm.id, 'node -v')).trim() };
	await remote(vm.id, `cat > ${quote(`${rooms}/image.json`)} <<'EOF'\n${JSON.stringify(image, null, 2)}\nEOF\nsync`);
	step(`saving snapshot ${flags.snapshot}`);
	console.log((await boat(['snapshot', vm.id, flags.snapshot, '--json'], { timeoutMs: 30 * 60_000 })).trim());
	saved = true;
	console.log(JSON.stringify(image, null, 2));
} finally {
	if (!stopping && vm) {
		const id = vm.id;
		const usage = await machineUsage(id).catch(error => ({ error: error.message }));
		if (flags.keep) { vm = null; step(`kept ${id}; delete it with boat delete ${id} --yes`); }
		else await deleteVmOnce();
		step(`machine usage ${JSON.stringify(usage)}; ${saved ? 'image saved' : 'image NOT saved'} in ${Math.round((Date.now() - began) / 1000)}s`);
	}
	await rm(work, { recursive: true, force: true }).catch(() => {});
}
