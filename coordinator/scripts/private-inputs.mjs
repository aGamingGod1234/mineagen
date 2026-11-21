import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
