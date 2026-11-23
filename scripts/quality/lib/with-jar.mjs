// Runs a live fixture that reads the mod jar from MOD_JAR (scripts/quality/mod-jar.mjs) with a given jar instead, so
// room-batch.mjs can play it with $JAR:
//   node scripts/quality/lib/with-jar.mjs JAR scripts/quality/test-bed-live.mjs OUT [ARGS...]
// JAR "-" leaves MOD_JAR as it is. An argument '$SLOT_PORT_BASE' (quoted, so room-batch leaves it alone) becomes this
// slot's port base, for a fixture such as netherbody that wants it on its command line. Paths resolve against the
// working directory (the repository root on a batch machine). The jar is handed over as ARENA_MOD_JAR for this run only,
// never copied into the shared build folder: room-batch plays a room's arms side by side on one machine, and a shared
// copy let the last arm's jar play both arms.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [jar, script, ...rest] = process.argv.slice(2);
if (!jar || !script) { console.error('Usage: with-jar.mjs JAR SCRIPT [ARGS...]'); process.exit(2); }
const root = process.cwd();
if (jar !== '-') {
	const file = path.resolve(root, jar);
	if (!await readFile(file).then(() => true, () => false)) { console.error(`with-jar: no jar at ${file}`); process.exit(2); }
	process.env.ARENA_MOD_JAR = file;
}
process.argv = [process.argv[0], path.resolve(root, script), ...rest.map(arg => arg === '$SLOT_PORT_BASE' ? String(process.env.SLOT_PORT_BASE ?? '') : arg)];
await import(pathToFileURL(path.resolve(root, script)).href);
