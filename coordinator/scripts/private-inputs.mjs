import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

// Archive entries retain their repository-relative paths. Never fall back to another recording set.
export function privateInput(relative, checkoutRoot = repositoryRoot) {
 const root = process.env.ARENA_PRIVATE_INPUTS;
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
 process.env.ARENA_PRIVATE_INPUTS = path.resolve(process.env.ARENA_PRIVATE_INPUTS);
}
