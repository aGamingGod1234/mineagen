// Runs a live fixture that reads the mod jar from the build folder (MOD_JAR in scripts/quality/mod-jar.mjs) with a
// given jar instead, so room-batch.mjs can play it with $JAR:
//   node scripts/quality/lib/with-jar.mjs JAR scripts/quality/test-bed-live.mjs OUT [ARGS...]
// JAR "-" copies nothing. An argument '$SLOT_PORT_BASE' (quoted, so room-batch leaves it alone) becomes this slot's
// port base, for a fixture such as netherbody that wants it on its command line. Paths resolve against the working
// directory (the repository root on a batch machine). The jar is copied in atomically, so two rooms side by side that
// start this with the same jar never read a half-written file.
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [jar, script, ...rest] = process.argv.slice(2);
if (!jar || !script) { console.error('Usage: with-jar.mjs JAR SCRIPT [ARGS...]'); process.exit(2); }
const root = process.cwd();
const version = /^mod_version=(.+)$/m.exec(await readFile(path.join(root, 'gradle.properties'), 'utf8'))?.[1].trim();
if (!version) { console.error('gradle.properties has no mod_version'); process.exit(2); }
const target = path.join(root, 'build', 'libs', `mineagen-${version}.jar`);
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
if (jar !== '-' && await digest(target).catch(() => null) !== await digest(jar)) {
	await mkdir(path.dirname(target), { recursive: true });
	const staging = `${target}.${process.pid}.tmp`;
	await copyFile(jar, staging);
	await rename(staging, target);
}
process.argv = [process.argv[0], path.resolve(root, script), ...rest.map(arg => arg === '$SLOT_PORT_BASE' ? String(process.env.SLOT_PORT_BASE ?? '') : arg)];
await import(pathToFileURL(path.resolve(root, script)).href);
