// Builds for decision evals: a checkout runs in place when it carries this harness; a commit is checked out into a
// temporary worktree with this checkout's harness copied in, so the harness imports that build's own coordinator.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HARNESS_DIR = path.join('coordinator', 'src', 'decision-eval');
export const RUNNER_SCRIPT = path.join('scripts', 'decision-eval', 'run.mjs');

export async function git(cwd, ...gitArgs) { return (await execFileAsync('git', gitArgs, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim(); }

export async function harnessFiles(root) {
	const directory = path.join(root, HARNESS_DIR);
	const names = existsSync(directory) ? (await readdir(directory)).filter((name) => name.endsWith('.mjs')).sort() : [];
	return [...names.map((name) => path.join(HARNESS_DIR, name)), RUNNER_SCRIPT];
}

export async function harnessDigest(root) {
	const hash = createHash('sha256');
	// Checkouts of one commit differ only in line endings (core.autocrlf), so those are not a different harness.
	for (const file of await harnessFiles(root)) hash.update(`${file}\0`).update(existsSync(path.join(root, file)) ? (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n') : 'missing');
	return hash.digest('hex');
}

/**
 * Resolves a build spec (a checkout path or a commit) to { spec, root, commit, temporary }. Temporary worktrees are
 * pushed onto `temporary` for the caller to remove with removeWorktrees.
 */
export async function resolveBuild(spec, name, { harnessRoot = HARNESS_ROOT, temporary = [] } = {}) {
	if (existsSync(spec)) {
		const root = path.resolve(await git(path.resolve(spec), 'rev-parse', '--show-toplevel'));
		if (root !== harnessRoot && await harnessDigest(root) !== await harnessDigest(harnessRoot)) {
			throw new Error(`${name} checkout ${root} carries a different decision-eval harness; pass a commit instead (it is checked out into a temporary worktree with this harness)`);
		}
		return { spec, root, commit: await git(root, 'rev-parse', 'HEAD'), temporary: false };
	}
	let commit;
	try { commit = await git(harnessRoot, 'rev-parse', '--verify', `${spec}^{commit}`); } catch { throw new Error(`${name}: ${spec} is neither a checkout nor a commit`); }
	const root = path.join(os.tmpdir(), 'arena-decision-eval', 'worktrees', `${name}-${commit.slice(0, 10)}-${randomBytes(3).toString('hex')}`);
	await mkdir(path.dirname(root), { recursive: true });
	await git(harnessRoot, 'worktree', 'add', '--detach', root, commit);
	temporary.push(root);
	for (const file of await harnessFiles(harnessRoot)) {
		await mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await copyFile(path.join(harnessRoot, file), path.join(root, file));
	}
	// Every worktree installs its own locked dependencies; node_modules is never shared.
	await new Promise((resolve, reject) => {
		const child = spawn('npm ci --ignore-scripts --omit=dev --no-audit --no-fund', { cwd: path.join(root, 'coordinator'), shell: true, stdio: ['ignore', 'ignore', 'pipe'] });
		let errorText = '';
		child.stderr.on('data', (chunk) => { errorText += chunk; });
		child.on('error', reject);
		child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`npm ci failed in ${root}: ${errorText.slice(-2000)}`)));
	});
	return { spec, root, commit, temporary: true };
}

export async function removeWorktrees(temporary, { harnessRoot = HARNESS_ROOT, say = (line) => process.stderr.write(`${line}\n`) } = {}) {
	for (const root of temporary.splice(0)) await git(harnessRoot, 'worktree', 'remove', '--force', root).catch((error) => say(`could not remove worktree ${root}: ${error.message}`));
}
