import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const ARCHIVE_MANIFEST = 'rundata-manifest.json';

// ARENA_PRIVATE_INPUTS names the private archive root, which also holds docs/ (friction entries, run evidence). Its
// recordings keep repository-relative paths (coordinator/test/fixtures/...) either directly under the root or in the
// one subfolder that carries the archive's rundata-manifest.json. Two such subfolders are an error, never a guess.
export function recordingsRoot(root = process.env.ARENA_PRIVATE_INPUTS) {
 if (!root) return null;
 const resolved = path.resolve(root);
 if (existsSync(path.join(resolved, 'coordinator'))) return resolved;
 let sets = [];
 try {
  sets = readdirSync(resolved, { withFileTypes: true })
   .filter(entry => entry.isDirectory() && existsSync(path.join(resolved, entry.name, ARCHIVE_MANIFEST)) && existsSync(path.join(resolved, entry.name, 'coordinator')))
   .map(entry => entry.name).sort();
 } catch { return resolved; }
 if (sets.length > 1) throw new Error(`ARENA_PRIVATE_INPUTS (${resolved}) holds no coordinator/ folder and ${sets.length} recording sets with ${ARCHIVE_MANIFEST}: ${sets.join(', ')}. Point it at one of them.`);
 return sets.length ? path.join(resolved, sets[0]) : resolved;
}

// Archive entries retain their repository-relative paths. Never fall back to another recording set.
export function privateInput(relative, checkoutRoot = repositoryRoot) {
 const root = recordingsRoot();
 const file = path.resolve(root || checkoutRoot, relative);
 if (!existsSync(file)) {
  throw new Error(`Private input missing: ${relative}. Set ARENA_PRIVATE_INPUTS to the archive root (keeping repository-relative paths).${root ? ` Checked ${file}.` : ''}`);
 }
 return file;
}

export function privateInputUrl(relative) {
 const file = privateInput(relative);
 return pathToFileURL(file + (relative.endsWith('/') ? path.sep : ''));
}

// A skipped tool writes no verdict and starts no provider or worktree.
export function skipWithoutPrivateInputs(name) {
 if (!process.env.ARENA_PRIVATE_INPUTS) {
  console.log(`SKIP ${name}: private recordings unavailable; set ARENA_PRIVATE_INPUTS to the archive root or pass an explicit case path.`);
  process.exit(0);
 }
 process.env.ARENA_PRIVATE_INPUTS = recordingsRoot();
}

const coordinatorRoot = fileURLToPath(new URL('../', import.meta.url));
export const MANIFEST_PATH = 'test/private-inputs.json';
let manifestCache = null;
export function manifestEntries() {
 manifestCache ??= JSON.parse(readFileSync(path.join(coordinatorRoot, MANIFEST_PATH), 'utf8')).tests;
 return manifestCache;
}

// The inputs a selection lacks here, as npm test (run-public-suite.mjs) decides: with no archive, every input must be in
// the checkout; with the archive, a selection marked source checkout still needs the checkout's own files or Git
// objects, and any other selection is the archive's to supply (a missing recording then fails, never skips).
export function unavailableInputs(entry, archive = process.env.ARENA_PRIVATE_INPUTS) {
 if (archive && entry.source !== 'checkout') return [];
 return entry.inputs.filter((input) => {
  const gitObject = input.match(/^Private Git object ([a-f0-9]{40})\b/);
  if (gitObject) return spawnSync('git', ['cat-file', '-e', gitObject[1]], { cwd: coordinatorRoot, stdio: 'ignore' }).status !== 0;
  return !existsSync(path.resolve(coordinatorRoot, '..', input));
 });
}

const skipReason = (missing) => `private input unavailable; set ARENA_PRIVATE_INPUTS to the archive root. Missing: ${missing.join(', ')}`;
const manifestFile = (moduleUrl) => path.relative(coordinatorRoot, fileURLToPath(moduleUrl)).split(path.sep).join('/');

/**
 * A test that needs private inputs: test() when its manifest selection's inputs are here, a reported skip when they are
 * not, so `node --test <file>` run directly skips it as npm test does. The title must be the manifest entry's.
 */
export function privateTest(title, ...rest) {
 const entry = manifestEntries().find((row) => row.test === title);
 if (!entry) throw new Error(`privateTest '${title}' has no entry in ${MANIFEST_PATH}`);
 const missing = unavailableInputs(entry);
 if (missing.length === 0) return test(title, ...rest);
 const fn = rest.find((value) => typeof value === 'function');
 const options = rest.find((value) => value && typeof value === 'object') ?? {};
 return test(title, { ...options, skip: skipReason(missing) }, fn);
}

/**
 * The first statement of a test module whose whole selection (test '*') needs private inputs it loads while the module
 * evaluates: `await privateModule(import.meta.url);`. With the inputs here it returns at once. Without them, run as its
 * own process (node --test runs each file so), it reports one skipped test and holds the module there, so nothing after
 * it reads the missing inputs, and the process exits 0 instead of Node's 13 for the held await. Imported any other way
 * (--test-isolation=none, or from another module), holding would stall the rest of the run, so it throws instead.
 * suppliedBy: the value of the module's own input override, such as DECISION_EVAL_FIXTURE_DIR; when set, the module
 * runs on that input whatever the manifest inputs are.
 */
export function privateModule(moduleUrl, { entry = null, suppliedBy = null } = {}) {
 // A module pointed at another corpus by its own override (DECISION_EVAL_FIXTURE_DIR) reads that instead: no skip.
 if (suppliedBy) return Promise.resolve();
 const file = manifestFile(moduleUrl);
 const selection = entry ?? manifestEntries().find((row) => row.file === file && row.test === '*');
 if (!selection) throw new Error(`privateModule: ${file} has no module entry (test "*") in ${MANIFEST_PATH}`);
 const missing = unavailableInputs(selection);
 if (missing.length === 0) return Promise.resolve();
 // Real paths: the module URL is resolved through symlinks, junctions and subst drives, argv[1] is not.
 const real = (file) => { try { return realpathSync.native(file); } catch { return path.resolve(file); } };
 const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
 const ownProcess = Boolean(process.argv[1]) && same(real(process.argv[1]), real(fileURLToPath(moduleUrl)));
 if (!ownProcess) throw new Error(`${file}: ${skipReason(missing)}`);
 test.skip(`${file}: ${skipReason(missing)}`);
 console.log(`SKIP ${file}: the module stops loading here; Node's "unsettled top-level await" warning below is this skip.`);
 process.on('exit', (code) => { if (code === 13) process.exitCode = 0; });
 return new Promise(() => {});
}
