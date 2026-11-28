// Runs the coordinator on a boat.dev machine instead of this PC.
//
// The mod starts the coordinator exactly as before (`node dynamic-main.mjs --config ...`, owned by the same supervisor,
// job object or process group). With MINEAGEN_RUNS_ON=boat, dynamic-main hands over to runBoatCoordinator() below,
// and this process becomes the PC end of the session:
//
//   1. sweep machines a crashed earlier session left behind (named mineagen-runner-<install>-*);
//   2. create a small machine (no stored account secrets, no snapshots, no monitoring, a short auto-stop) whose setup
//      script starts boat-relay.mjs behind a token-gated hosted URL;
//   3. over the relay's control socket: install this coordinator's code, then start it with the config, environment
//      and (with the player's consent) the Codex/Claude sign-in files, all of which live only in the machine's tmpfs;
//   4. join every coordinator bridge connection the relay opens to the mod's local bridge;
//   5. extend the machine's auto-stop while the session lives;
//   6. on any way out (world closed, game closed or killed, owner gone): stop the coordinator, copy refreshed sign-ins
//      back, and delete the machine.
//
// The slow part of step 6 runs in a detached reaper (see startReaper), because the mod's process wrapper kills the
// runner 2 s after asking it to stop. If even the reaper dies (a Windows job ends them together), the machine still
// ends: the relay stops the coordinator and wipes the sign-ins 2 minutes after the PC disappears, boat's auto-stop
// ends the machine at most TTL_SECONDS after the last extend (a machine powering itself off does not end it: boat
// marks it degraded and keeps it), and the next launch deletes it at once. Refreshed sign-ins are copied back as soon
// as the provider writes them, so a hard kill does not leave the player's own sign-in stale.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dialRelay, RELAY_PROTOCOL_PREFIX } from './boat-relay.mjs';
import { watchCaptureShutdown } from './capture-shutdown.mjs';

const COORDINATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MACHINE_TYPE = 'small';
export const DOLLARS_PER_HOUR = 0.018; // boat's published rate for a small machine (2 vCPU, 4 GB)
export const TTL_SECONDS = 300;
const EXTEND_EVERY_MS = 60_000;
const WS_PORT = 8787;
const MACHINE_ROOT = '/tmp/mineagen';
const READY_TIMEOUT_MS = 240_000;
const STOP_TIMEOUT_MS = 12_000;
const NAME_PREFIX = 'mineagen-runner-';
// Coordinator output files the PC still wants: the bridge-side evidence the headless harness scores.
const MIRRORED_FILES = ['ARENA_PROTOCOL_AUDIT_PATH', 'ARENA_PROVIDER_TURNS_PATH', 'ARENA_HEADLESS_TRACE_PATH', 'ARENA_HEADLESS_PRIVATE_TRACE_PATH'];
// The machine gets an allowlist of this process's environment (the supervisor passes the whole PC environment): the
// mod's own ARENA_/MINEAGEN_ settings, locale, and the model providers' variables only with the player's consent.
const FORWARDED_PREFIXES = ['ARENA_', 'MINEAGEN_'];
const NOT_FORWARDED = new Set(['ARENA_CAPTURE_SHUTDOWN_PATH', 'ARENA_PRIVATE_INPUTS', 'ARENA_OWNED_JOB_ENVIRONMENT', 'MINEAGEN_RUNS_ON']);
const LOCALE = ['LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR'];
const PROVIDER_VARIABLES = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_ORG_ID', 'OPENAI_PROJECT',
	'OPENAI_PROJECT_ID', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];
const SIGN_IN = {
	codex: { name: 'auth.json', remoteDir: 'codex-home', variable: 'CODEX_HOME', local: env => path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json') },
	claude: { name: '.credentials.json', remoteDir: 'claude-config', variable: 'CLAUDE_CONFIG_DIR', local: env => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json') },
};

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------------
// Backends: the same five calls over boat's REST API (an OAuth access token the mod keeps fresh in a file) or the
// `boat` command-line tool (its own signed-in session; for development before the OAuth app exists).

/** REST backend. The token file is re-read on every call: the mod is the one process that refreshes the token. */
export function restBackend({ tokenFile, apiBase = 'https://boat.dev/api/v1', fetchImpl = globalThis.fetch }) {
	const call = async (method, route, body, { idempotencyKey, headers = {} } = {}) => {
		const token = (await readFile(tokenFile, 'utf8')).trim();
		const response = await fetchImpl(`${apiBase}${route}`, {
			method,
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}), ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
		const text = await response.text();
		let data = null;
		try { data = text ? JSON.parse(text) : null; } catch {}
		if (!response.ok) throw new BoatError(response.status, data?.error?.code ?? data?.code ?? `http_${response.status}`, data?.error?.message ?? data?.message ?? text.slice(0, 200));
		return data;
	};
	return {
		kind: 'rest',
		async create({ name, ttlSeconds, files, setupScript, port, idempotencyKey }) {
			const data = await call('POST', '/sandboxes', {
				type: MACHINE_TYPE, name, ttlSeconds, noEnv: true, snapshots: false, monitoring: false,
				hostedPorts: [{ port, public: false, localhost: true, title: 'Mineagen relay' }],
				files, setupScript,
			}, { idempotencyKey });
			const hosted = (data.hostedPorts ?? []).find(entry => entry.port === port);
			return { id: data.sandbox.id, url: hosted?.url ?? null };
		},
		async state(id) {
			const data = await call('GET', `/sandboxes/${id}`);
			return (data.sandbox ?? data).state;
		},
		async host(id, port) {
			const data = await call('POST', `/sandboxes/${id}/host`, { port, public: false, localhost: true });
			return data.url ?? data.hostedPort?.url;
		},
		extend: (id, ttlSeconds) => call('PATCH', `/sandboxes/${id}`, { ttlSeconds }),
		// Boat asks a delete to name its target again in a header, so a stray request cannot remove the wrong machine.
		remove: async id => { try { await call('DELETE', `/sandboxes/${id}`, undefined, { headers: { 'x-ascii-confirm-delete': id } }); } catch (error) { if (error.status !== 404) throw error; } },
		async list() {
			const data = await call('GET', '/sandboxes?limit=200');
			return (data.sandboxes ?? []).map(entry => ({ id: entry.id, name: entry.name, state: entry.state }));
		},
	};
}

/** CLI backend: runs the `boat` tool with the player's own boat sign-in. */
export function cliBackend({ binary = 'boat', run = runBoat } = {}) {
	const json = async args => parseCliJson(await run(binary, [...args, '--json']));
	return {
		kind: 'cli',
		async create({ name, ttlSeconds, files, setupScript, port }) {
			const folder = path.join(os.tmpdir(), `mineagen-boat-${randomBytes(6).toString('hex')}`);
			await mkdir(folder, { recursive: true, mode: 0o700 });
			const args = ['new', '--type', MACHINE_TYPE, '--name', name, '--ttl', String(ttlSeconds), '--no-env', '--no-snapshots', '--no-monitoring'];
			try {
				for (const [index, file] of files.entries()) {
					const local = path.join(folder, `file-${index}`);
					await writeFile(local, file.content, { mode: 0o600 });
					args.push('--file', `${file.path}=${local}`);
				}
				const setup = path.join(folder, 'setup.sh');
				await writeFile(setup, setupScript, { mode: 0o600 });
				args.push('--setup-file', setup);
				const data = await json(args);
				const id = data.sandbox?.id ?? data.id;
				return { id, url: null };
			} finally {
				await rm(folder, { recursive: true, force: true });
			}
		},
		async state(id) { const data = await json(['info', id]); return (data.sandbox ?? data).state; },
		async host(id, port) { const data = await json(['host', id, String(port), '--localhost', '--private']); return data.url ?? data.hostedPort?.url; },
		extend: (id, ttlSeconds) => run(binary, ['extend', id, '--ttl', String(ttlSeconds)]),
		remove: async id => {
			try { await run(binary, ['delete', id, '--yes']); }
			catch (error) { if (!/not.?found|404/i.test(error.message)) throw error; }
		},
		async list() {
			const data = await json(['list']);
			return (data.sandboxes ?? []).map(entry => ({ id: entry.id, name: entry.name, state: entry.state }));
		},
	};
}

/** `boat ... --json` may print progress objects before the result (JSON lines); the last whole object is the result. */
export function parseCliJson(text) {
	try { return JSON.parse(text); } catch {}
	const objects = text.split('\n').map(line => line.trim()).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
	if (!objects.length) throw new Error(`boat printed no JSON: ${text.slice(0, 200)}`);
	return objects.findLast(object => object.sandbox?.id || object.id) ?? objects.at(-1);
}

export class BoatError extends Error {
	constructor(status, code, message) { super(`boat ${status} ${code}: ${message}`); this.status = status; this.code = code; }
}

function runBoat(binary, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, ['--no-update', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let out = '', err = '';
		child.stdout.on('data', chunk => { out += chunk; });
		child.stderr.on('data', chunk => { err += chunk; });
		const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60_000);
		child.on('error', error => { clearTimeout(timer); reject(error); });
		child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`boat ${args[0]} exited ${code}: ${err.trim().slice(-300)}`)); });
	});
}

export function backendFromEnvironment(env = process.env) {
	if (env.MINEAGEN_BOAT_TOKEN_FILE) return restBackend({ tokenFile: env.MINEAGEN_BOAT_TOKEN_FILE, apiBase: env.MINEAGEN_BOAT_API_BASE || undefined });
	if (env.MINEAGEN_BOAT_BACKEND === 'cli') return cliBackend({ binary: env.MINEAGEN_BOAT_CLI || 'boat' });
	throw new Error('Runs on boat, but boat is not signed in: sign in with boat in the agent control screen');
}

// ---------------------------------------------------------------------------------------------------------------------
// What the machine is given.

/** Points every PC path in the coordinator config at the machine's session folder (tmpfs). */
export function remoteConfig(config) {
	const copy = structuredClone(config);
	copy.workspaceRoot = '${SESSION}/workspaces';
	copy.minecraftAgentRoot = '${SESSION}/minecraft-agent';
	delete copy.minecraftAgentTemplateRoot;
	if (copy.codex) {
		copy.codex.cwd = '${SESSION}/workspaces';
		if (copy.codex.launchProfile) copy.codex.launchProfile.cwd = '${SESSION}/workspaces';
	}
	if (copy.claude) {
		for (const key of ['cwd', 'runtimeRoot', 'executable']) delete copy.claude[key];
	}
	if (copy.voice) {
		if (copy.voice.profileAssignmentsPath) copy.voice.profileAssignmentsPath = '${SESSION}/voice-profile-assignments.json';
		delete copy.voice.localSpeechPythonPath;
		delete copy.voice.secretFile;
	}
	return copy;
}

const looksLikePath = value => typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'));

/**
 * The machine's coordinator environment: this one minus PC-only variables, with path variables moved to the session
 * folder. Returns the environment, the files to mirror back, and the names of path variables that were dropped.
 */
export function remoteEnvironment(env, { signIns = [], consent = false } = {}) {
	const out = {}, mirror = [], dropped = [];
	for (const [name, value] of Object.entries(env)) {
		const allowed = (FORWARDED_PREFIXES.some(prefix => name.startsWith(prefix)) && !NOT_FORWARDED.has(name)
			&& !name.startsWith('MINEAGEN_BOAT_') && !name.startsWith('ARENA_PROBE_'))
			|| LOCALE.includes(name) || (consent && PROVIDER_VARIABLES.includes(name));
		if (value === undefined || !allowed) continue;
		if (MIRRORED_FILES.includes(name)) {
			out[name] = `\${SESSION}/out/${name.toLowerCase()}.jsonl`;
			mirror.push({ name, path: out[name], local: value });
		} else if (name === 'ARENA_PROVIDER_CREDENTIAL_ROOT') out[name] = '${SESSION}/provider-keys';
		else if (looksLikePath(value)) dropped.push(name);
		else out[name] = value;
	}
	for (const provider of signIns) out[SIGN_IN[provider].variable] = `\${SESSION}/${SIGN_IN[provider].remoteDir}`;
	return { env: out, mirror, dropped };
}

/** The sign-in files the player consented to send, with the hash they had when sent. */
export async function collectSignIns(env, providers) {
	const found = [];
	for (const provider of providers) {
		const spec = SIGN_IN[provider];
		const local = spec.local(env);
		const bytes = await readFile(local).catch(() => null);
		if (bytes) found.push({ provider, local, name: spec.name, path: `\${SESSION}/${spec.remoteDir}/${spec.name}`, hash: sha256(bytes), content: bytes.toString('base64') });
	}
	return found;
}

/**
 * Copies a refreshed sign-in back over the player's file, but only while the player's file still holds what was sent:
 * a newer local sign-in (they signed in again during the session) wins.
 */
export async function writeBackSignIns(sent, changed, { log = () => {} } = {}) {
	const results = [];
	for (const entry of sent) {
		const fresh = changed.find(file => file.name === entry.name); // newest first
		if (!fresh) continue;
		const current = await readFile(entry.local).catch(() => null);
		if (!current || sha256(current) !== entry.hash) { results.push({ provider: entry.provider, written: false, reason: 'changed-locally' }); continue; }
		const temporary = `${entry.local}.mineagen-${process.pid}.tmp`;
		await writeFile(temporary, Buffer.from(fresh.content, 'base64'), { mode: 0o600 });
		await rename(temporary, entry.local);
		results.push({ provider: entry.provider, written: true });
	}
	for (const result of results) log('sign-in-writeback', result);
	return results;
}

export async function bundleCoordinator(root = COORDINATOR_ROOT) {
	const entries = ['src', 'config', 'package.json', 'node_modules'].filter(entry => existsSync(path.join(root, entry)));
	return new Promise((resolve, reject) => {
		const tar = spawn('tar', ['-czf', '-', '-C', root, ...entries], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		const chunks = [];
		let err = '';
		tar.stdout.on('data', chunk => chunks.push(chunk));
		tar.stderr.on('data', chunk => { err += chunk; });
		tar.on('error', reject);
		tar.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar exited ${code}: ${err.slice(-200)}`)));
	});
}

export function setupScript({ bridgePort }) {
	return [
		'#!/bin/bash',
		'umask 077',
		`mkdir -p ${MACHINE_ROOT}`,
		'command -v node >/dev/null || { [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"; }',
		`cd ${MACHINE_ROOT}`,
		`setsid nohup node ${MACHINE_ROOT}/boat-relay.mjs serve --bridge-port ${bridgePort} --ws-port ${WS_PORT} --key-file ${MACHINE_ROOT}/relay.key `
			+ `--coordinator-root ${MACHINE_ROOT}/coordinator > ${MACHINE_ROOT}/relay.log 2>&1 < /dev/null &`,
		'',
	].join('\n');
}

export function relayUrl(hostedUrl, route) {
	const url = new URL(hostedUrl);
	url.pathname = route;
	if (url.protocol === 'https:') url.protocol = 'wss:';
	else if (url.protocol === 'http:') url.protocol = 'ws:';
	return url.toString();
}

// ---------------------------------------------------------------------------------------------------------------------
// The control socket.

class Control {
	#ws; #waiters = []; #onText;
	constructor(ws, onText) {
		this.#ws = ws; this.#onText = onText;
		ws.onmessage = event => {
			if (typeof event.data !== 'string') return;
			const text = event.data;
			if (text.startsWith('ping:')) { ws.send(`pong:${text.slice(5)}`); return; }
			for (const waiter of [...this.#waiters]) if (waiter.match(text)) { this.#waiters.splice(this.#waiters.indexOf(waiter), 1); waiter.resolve(text); }
			this.#onText(text);
		};
		ws.onclose = () => { for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error('relay control socket closed')); };
	}
	static open(url, key, onText, WebSocketImpl = globalThis.WebSocket) {
		return new Promise((resolve, reject) => {
			const ws = new WebSocketImpl(url, [`${RELAY_PROTOCOL_PREFIX}${key}`]);
			const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('relay control socket did not open')); }, 20_000);
			ws.onopen = () => { clearTimeout(timer); resolve(new Control(ws, onText)); };
			ws.onerror = () => {};
			ws.onclose = () => { clearTimeout(timer); reject(new Error('relay control socket refused')); };
		});
	}
	get open() { return this.#ws.readyState === 1; }
	request(text, prefixes, timeoutMs) {
		return new Promise((resolve, reject) => {
			let timer = null;
			const waiter = { match: reply => prefixes.some(prefix => reply === prefix || reply.startsWith(`${prefix}:`)) || reply.startsWith('failed:'),
				resolve: reply => { clearTimeout(timer); resolve(reply); }, reject: error => { clearTimeout(timer); reject(error); } };
			this.#waiters.push(waiter);
			timer = setTimeout(() => { const i = this.#waiters.indexOf(waiter); if (i >= 0) { this.#waiters.splice(i, 1); reject(new Error(`relay did not answer ${text.slice(0, 12)}`)); } }, timeoutMs);
			this.#ws.send(text);
		}).then(reply => {
			if (reply.startsWith('failed:')) throw new Error(`relay: ${JSON.parse(reply.slice(7)).message}`);
			return reply;
		});
	}
	close() { try { this.#ws.close(); } catch {} }
}

// ---------------------------------------------------------------------------------------------------------------------
// The session.

function installIdentity(env) {
	const value = env.MINEAGEN_BOAT_INSTALL_ID || sha256(`${os.hostname()}|${COORDINATOR_ROOT}`).slice(0, 10);
	return String(value).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'local';
}

/** Applies one refreshed sign-in from the machine and remembers its hash, so the next refresh is applied too. */
async function applySignIn(sent, fresh, log) {
	const [result] = await writeBackSignIns(sent, [fresh], { log });
	if (result?.written) {
		const entry = sent.find(item => item.name === fresh.name);
		entry.hash = sha256(Buffer.from(fresh.content, 'base64'));
	}
}

/**
 * Teardown that outlives the runner. The mod's process wrapper kills the runner 2 s after asking it to stop, which is
 * too short to collect sign-ins and delete a machine, and a crash gives no warning at all. So the runner starts this
 * detached process (outside the coordinator's process group) and keeps its stdin open; when stdin ends without a
 * "done" line, the runner is gone and the reaper stops the session, writes back refreshed sign-ins, and deletes the
 * machine. A Windows job object ends the reaper with the runner; there the auto-stop and the next launch's sweep end
 * the machine.
 */
function startReaper(details, log) {
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--reaper'], {
		detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: process.env,
	});
	child.on('error', error => log('reaper-failed', { message: error.message }));
	child.stdin.on('error', () => {});
	child.stdin.write(`${JSON.stringify(details)}\n`);
	child.unref();
	return {
		update(fields) { Object.assign(details, fields); if (child.stdin.writable) child.stdin.write(`${JSON.stringify(details)}\n`); },
		done() { if (child.stdin.writable) child.stdin.end('done\n'); },
	};
}

async function runReaper() {
	let details = null, done = false, buffer = '';
	process.stdin.setEncoding('utf8');
	await new Promise(resolve => {
		process.stdin.on('data', chunk => {
			buffer += chunk;
			let line;
			while ((line = buffer.indexOf('\n')) >= 0) {
				const text = buffer.slice(0, line); buffer = buffer.slice(line + 1);
				if (text === 'done') done = true; else try { details = JSON.parse(text); } catch {}
			}
		});
		process.stdin.on('end', resolve);
		process.stdin.on('error', resolve);
	});
	if (done || !details?.machine) return 0;
	setTimeout(() => process.exit(1), 90_000).unref();
	const log = (event, fields = {}) => { if (details.logFile) void appendFile(details.logFile, `${JSON.stringify({ at: new Date().toISOString(), source: 'boat-reaper', event, ...fields })}\n`).catch(() => {}); };
	log('runner-gone', { machine: details.machine });
	if (details.url && details.key) {
		try {
			const control = await Control.open(relayUrl(details.url, '/control'), details.key, () => {});
			const reply = await control.request('stop', ['stopped'], STOP_TIMEOUT_MS);
			const { changed } = JSON.parse(Buffer.from(reply.slice('stopped:'.length), 'base64').toString());
			await writeBackSignIns(details.sent ?? [], changed, { log });
			control.close();
		} catch (error) { log('stop-session-failed', { message: error.message }); }
	}
	const boat = backendFromEnvironment(process.env);
	for (let attempt = 0; attempt < 3; attempt++) {
		try { await boat.remove(details.machine); log('machine-deleted', { machine: details.machine }); break; }
		catch (error) { log('machine-delete-failed', { machine: details.machine, message: error.message }); await sleep(2_000); }
	}
	if (details.statusFile) {
		try { const current = JSON.parse(await readFile(details.statusFile, 'utf8')); await writeFile(details.statusFile, JSON.stringify({ ...current, phase: 'stopped', reason: 'runner-gone', stoppedAt: Date.now() })); } catch {}
	}
	return 0;
}

export async function runBoatCoordinator({ argv = process.argv.slice(2), env = process.env, backend = null, log: logLine = null, reaper = true } = {}) {
	const configIndex = argv.indexOf('--config');
	if (configIndex < 0) throw new Error('boat runner needs --config');
	const config = JSON.parse(await readFile(argv[configIndex + 1], 'utf8'));
	const bridgePort = Number(config.bridge?.port ?? 25570);
	const statusFile = env.MINEAGEN_BOAT_STATUS_FILE || null;
	const logFile = statusFile ? `${statusFile}.log` : null;
	const log = logLine ?? ((event, fields = {}) => {
		const line = `${JSON.stringify({ at: new Date().toISOString(), source: 'boat-runner', event, ...fields })}\n`;
		process.stderr.write(line);
		if (logFile) void appendFile(logFile, line).catch(() => {});
	});
	const boat = backend ?? backendFromEnvironment(env);
	const install = installIdentity(env);
	const name = `${NAME_PREFIX}${install}-${Date.now().toString(36)}`;
	const consent = env.MINEAGEN_BOAT_SIGNIN_CONSENT === '1';
	const providers = consent ? String(env.MINEAGEN_BOAT_SIGNIN_PROVIDERS || 'codex,claude').split(',').map(s => s.trim()).filter(p => SIGN_IN[p]) : [];
	const startedAt = Date.now();
	let machine = null, control = null, dialer = null, keepAlive = null, ownerWatch = null, finished = null, phase = 'starting';
	let machineSince = null, sent = [], reaperHandle = null, writes = Promise.resolve();

	const status = async (fields = {}) => {
		if (!statusFile) return;
		const billedMs = machineSince === null ? 0 : Date.now() - machineSince;
		const body = { phase, machine: machine?.id ?? null, type: MACHINE_TYPE, dollarsPerHour: DOLLARS_PER_HOUR, startedAt,
			estimatedCostDollars: Number((billedMs / 3_600_000 * DOLLARS_PER_HOUR).toFixed(4)), updatedAt: Date.now(), ...fields };
		try {
			await mkdir(path.dirname(statusFile), { recursive: true });
			await writeFile(`${statusFile}.tmp`, JSON.stringify(body));
			await rename(`${statusFile}.tmp`, statusFile);
		} catch {}
	};

	// Full teardown, for exits that leave time for it (capture shutdown, the remote coordinator ending, a failure).
	const finish = (reason, exitCode = 0) => {
		if (finished) return finished;
		finished = (async () => {
			log('stopping', { reason, machine: machine?.id ?? null });
			phase = 'stopping'; await status({ reason });
			clearInterval(keepAlive); clearInterval(ownerWatch);
			if (control?.open) {
				try {
					const reply = await control.request('stop', ['stopped'], STOP_TIMEOUT_MS);
					const { changed } = JSON.parse(Buffer.from(reply.slice('stopped:'.length), 'base64').toString());
					await writes;
					await writeBackSignIns(sent, changed, { log });
				} catch (error) { log('stop-session-failed', { message: error.message }); }
			}
			await writes;
			dialer?.close(); control?.close();
			if (machine) {
				try { await boat.remove(machine.id); log('machine-deleted', { machine: machine.id, minutes: Number(((Date.now() - machineSince) / 60_000).toFixed(1)) }); }
				catch (error) { log('machine-delete-failed', { machine: machine.id, message: error.message }); }
			}
			reaperHandle?.done();
			phase = 'stopped'; await status({ reason, stoppedAt: Date.now() });
			return exitCode;
		})();
		return finished;
	};
	// A stop signal leaves 2 s before the wrapper's SIGKILL: exit at once and let the reaper do the slow part.
	const quickExit = reason => {
		log('signalled', { reason, machine: machine?.id ?? null });
		if (!reaperHandle) { void finish(reason).then(code => process.exit(code)); return; }
		process.exit(0);
	};
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => quickExit(signal));
	const ownerPid = Number(env.MINEAGEN_BOAT_OWNER_PID || 0);
	const parentAtStart = process.ppid;
	ownerWatch = setInterval(() => {
		let gone = process.ppid !== parentAtStart;
		if (!gone && ownerPid > 0) { try { process.kill(ownerPid, 0); } catch (error) { gone = error.code === 'ESRCH'; } }
		if (gone) quickExit('owner-gone');
	}, 2_000);
	ownerWatch.unref?.();
	// The harness waits for the acknowledgement file, so the runner must not exit before it is in place.
	let acknowledged = null, captureRequested = false;
	watchCaptureShutdown(env.ARENA_CAPTURE_SHUTDOWN_PATH, () => { captureRequested = true; return finish('capture-shutdown'); }, {
		write: (file, text) => (acknowledged = (async () => { await writeFile(`${file}.tmp`, text); await rename(`${file}.tmp`, file); })()),
	});
	const settle = async code => {
		await finished;
		for (let i = 0; captureRequested && !acknowledged && i < 40; i++) await sleep(50);
		await acknowledged?.catch(() => {});
		return code;
	};

	try {
		await status();
		// 1. Sweep this install's leftovers.
		const sweep = async (filter, why) => {
			for (const leftover of (await boat.list()).filter(filter)) {
				log('sweep', { machine: leftover.id, state: leftover.state, why });
				await boat.remove(leftover.id).catch(error => log('sweep-failed', { machine: leftover.id, message: error.message }));
			}
		};
		await sweep(entry => entry.name?.startsWith(`${NAME_PREFIX}${install}-`), 'leftover');
		if (finished) return await settle(await finished);
		// 2. Create the machine.
		const key = randomBytes(32).toString('base64url');
		const relaySource = await readFile(path.join(COORDINATOR_ROOT, 'src/boat-relay.mjs'), 'utf8');
		const t0 = Date.now();
		try {
			machine = await boat.create({
				name, ttlSeconds: TTL_SECONDS, port: WS_PORT, idempotencyKey: name,
				files: [{ path: `${MACHINE_ROOT}/boat-relay.mjs`, content: relaySource }, { path: `${MACHINE_ROOT}/relay.key`, content: key }],
				setupScript: setupScript({ bridgePort }),
			});
		} catch (error) {
			// The create may have happened even though its answer was lost or unreadable.
			await sweep(entry => entry.name === name, 'create-failed').catch(() => {});
			throw error;
		}
		machineSince = Date.now();
		log('machine-created', { machine: machine.id, ms: Date.now() - t0, backend: boat.kind });
		if (reaper) reaperHandle = startReaper({ machine: machine.id, statusFile, logFile, url: null, key, sent: [] }, log);
		await status();
		if (finished) return await settle(await finished);
		keepAlive = setInterval(() => {
			boat.extend(machine.id, TTL_SECONDS).catch(error => log('extend-failed', { message: error.message }));
		}, EXTEND_EVERY_MS);
		// 3. Wait for the machine.
		const readyBy = Date.now() + READY_TIMEOUT_MS;
		for (;;) {
			const state = await boat.state(machine.id).catch(() => 'unknown');
			if (['ready', 'idle', 'running'].includes(state)) break;
			if (['error', 'cancelled', 'archived', 'archiving'].includes(state)) throw new Error(`boat machine ended while starting (${state})`);
			if (Date.now() > readyBy) throw new Error('boat machine did not start in time');
			await sleep(2_000);
		}
		if (!machine.url) machine.url = await boat.host(machine.id, WS_PORT);
		reaperHandle?.update({ url: machine.url });
		log('machine-ready', { machine: machine.id, ms: Date.now() - t0 });
		// 4. Control socket (the relay answers once the setup script has started it): install, then start.
		const mirrorFiles = new Map();
		const onControlText = text => {
			if (text.startsWith('file:')) {
				const second = text.indexOf(':', 5);
				const local = mirrorFiles.get(text.slice(5, second));
				if (local) writes = writes.then(() => appendFile(local, Buffer.from(text.slice(second + 1), 'base64'))).catch(() => {});
			} else if (text.startsWith('signin:')) {
				const fresh = JSON.parse(Buffer.from(text.slice(7), 'base64').toString());
				writes = writes.then(() => applySignIn(sent, fresh, log)).then(() => reaperHandle?.update({ sent: sent.map(({ content, ...rest }) => rest) })).catch(() => {});
			} else if (text.startsWith('exited:')) {
				log('coordinator-exited', JSON.parse(text.slice(7)));
				void finish('coordinator-exited', 1).then(code => process.exit(code));
			}
		};
		for (;;) {
			try { control = await Control.open(relayUrl(machine.url, '/control'), key, onControlText); break; }
			catch (error) { if (Date.now() > readyBy || finished) throw new Error(`boat relay did not answer in time (${error.message})`); }
			await sleep(1_500);
		}
		log('relay-ready', { ms: Date.now() - t0 });
		if (finished) return await settle(await finished);
		const bundle = await bundleCoordinator();
		await control.request(`install:${bundle.toString('base64')}`, ['installed'], 120_000);
		log('installed', { bytes: bundle.length, ms: Date.now() - t0 });
		sent = await collectSignIns(env, providers);
		reaperHandle?.update({ sent: sent.map(({ content, ...rest }) => rest) });
		const { env: machineEnv, mirror, dropped } = remoteEnvironment(env, { signIns: sent.map(entry => entry.provider), consent });
		for (const entry of mirror) mirrorFiles.set(entry.name, entry.local);
		if (dropped.length) log('dropped-path-variables', { names: dropped });
		const payload = {
			config: remoteConfig(config),
			env: machineEnv,
			files: sent.map(entry => ({ path: entry.path, content: entry.content })),
			mirror: mirror.map(({ name: fileName, path: filePath }) => ({ name: fileName, path: filePath })),
		};
		await control.request(`start:${Buffer.from(JSON.stringify(payload)).toString('base64')}`, ['started'], 60_000);
		log('coordinator-started', { ms: Date.now() - t0, signIns: sent.map(entry => entry.provider), consent });
		// 5. Bridge connections.
		dialer = dialRelay({ url: relayUrl(machine.url, '/bridge'), key, bridgePort, bridgeHost: config.bridge?.host ?? '127.0.0.1' });
		phase = 'running';
		await status({ readyMs: Date.now() - t0 });
		// 6. Live until told to stop; a lost control socket is retried, a lost machine ends the session.
		while (!finished) {
			await sleep(5_000);
			if (finished) break;
			await status();
			if (!control.open) {
				try { control = await Control.open(relayUrl(machine.url, '/control'), key, onControlText); log('control-reopened'); }
				catch (error) {
					const state = await boat.state(machine.id).catch(() => 'unknown');
					if (['archived', 'archiving', 'error', 'cancelled'].includes(state)) { void finish(`machine-${state}`, 1); break; }
					log('control-retry', { message: error.message, state });
				}
			}
		}
		return await settle(await finished);
	} catch (error) {
		log('failed', { message: error.message });
		await status({ error: error.message });
		return await settle(await finish('failed', 1));
	}
}

/** dynamic-main calls this first when the coordinator runs on boat; it never returns. */
export async function maybeRunOnBoat(env = process.env) {
	if (env.MINEAGEN_RUNS_ON !== 'boat') return false;
	const code = await runBoatCoordinator({ env });
	process.exit(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === '--reaper') {
	process.exit(await runReaper());
}
