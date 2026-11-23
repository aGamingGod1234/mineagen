// Runs a live fixture that reads the mod jar from MOD_JAR (scripts/quality/mod-jar.mjs) with a given jar instead, so
// room-batch.mjs can play it with $JAR:
//   node scripts/quality/lib/with-jar.mjs JAR scripts/quality/test-bed-live.mjs OUT [ARGS...]
// JAR "-" leaves MOD_JAR as it is. An argument '$SLOT_PORT_BASE' (quoted, so room-batch leaves it alone) becomes this
// slot's port base, for a fixture such as netherbody that wants it on its command line. Paths resolve against the
// working directory (the repository root on a batch machine). The jar is copied to a folder named by its own hash under
// build/libs/by-sha and handed over as ARENA_MOD_JAR for this run, never copied to the shared build output path:
// room-batch plays a room's arms side by side on one machine, and a shared copy let the last arm's jar play both arms.
// The copy stays inside the checkout so MOD_JAR is a relative path on every drive.
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [jar, script, ...rest] = process.argv.slice(2);
if (!jar || !script) { console.error('Usage: with-jar.mjs JAR SCRIPT [ARGS...]'); process.exit(2); }
const root = process.cwd();
if (jar !== '-') {
	const file = path.resolve(root, jar);
	const bytes = await readFile(file).catch(() => null);
	if (bytes === null) { console.error(`with-jar: no jar at ${file}`); process.exit(2); }
	const sha = createHash('sha256').update(bytes).digest('hex');
	const target = path.join(root, 'build', 'libs', 'by-sha', sha.slice(0, 16), path.basename(file));
	const have = await readFile(target).then(found => createHash('sha256').update(found).digest('hex'), () => null);
	if (have !== sha) {
		await mkdir(path.dirname(target), { recursive: true });
		// Atomic, so two runs of the same jar starting together never read a half-written file.
		const staging = `${target}.${process.pid}.tmp`;
		await copyFile(file, staging);
		await rename(staging, target);
	}
	process.env.ARENA_MOD_JAR = path.relative(root, target);
}
process.argv = [process.argv[0], path.resolve(root, script), ...rest.map(arg => arg === '$SLOT_PORT_BASE' ? String(process.env.SLOT_PORT_BASE ?? '') : arg)];
await import(pathToFileURL(path.resolve(root, script)).href);
