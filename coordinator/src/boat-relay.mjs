#!/usr/bin/env node
// Carries the mod's coordinator bridge between a player's PC and a boat machine.
//
// The coordinator dials the bridge at 127.0.0.1:<bridge port>. When it runs on a boat machine nothing listens there,
// and a boat machine cannot reach a home PC. So the PC side dials OUT over WSS to this relay (`serve`, on the machine,
// behind `boat host`), and the relay presents the bridge on the machine's loopback. Each coordinator connection rides
// one WebSocket as plain bytes: the bridge's own secret and handshake still authenticate end to end and the relay never
// reads them. The relay key only stops a stranger who learns the hosted URL from taking the coordinator's connection.
//
//   BOAT_RELAY_KEY=... node boat-relay.mjs serve --bridge-port N --ws-port M     (on the boat machine)
//   BOAT_RELAY_KEY=... node boat-relay.mjs dial --url wss://... --bridge-port N  (on the PC; the mod has its own dialer)
//
// Frames: binary = bridge bytes; text = control ("open", "ping:<ms>", "pong:<ms>"). The dialer keeps one spare socket
// open; a coordinator connection takes it ("open"), and the dialer opens the next spare. Text pings measure the round
// trip through boat's proxy (a WebSocket ping could be answered by the proxy itself) and are logged as JSON lines.
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const RELAY_PROTOCOL_PREFIX = 'mineagen-relay.';
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const PING_EVERY_MS = 10_000;
const SPARE_WAIT_MS = 10_000;
// With no PC on the control socket for this long, the coordinator is stopped and the sign-ins are wiped. The PC's
// keep-alive also stops extending the machine, so boat's auto-stop ends it a few minutes later.
const WATCHDOG_MS = 120_000;
export const DEFAULT_SESSION_ROOT = '/dev/shm/mineagen-session';

const log = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);

export function acceptKey(key) {
	return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encodes one unmasked (server) or masked (client) frame. */
export function encodeFrame(payload, opcode = 2, mask = null) {
	const data = typeof payload === 'string' ? Buffer.from(payload) : payload;
	const length = data.length;
	const head = length < 126 ? 2 : length < 65536 ? 4 : 10;
	const frame = Buffer.alloc(head + (mask ? 4 : 0) + length);
	frame[0] = 0x80 | opcode;
	if (length < 126) frame[1] = length;
	else if (length < 65536) { frame[1] = 126; frame.writeUInt16BE(length, 2); }
	else { frame[1] = 127; frame.writeBigUInt64BE(BigInt(length), 2); }
	if (mask) {
		frame[1] |= 0x80;
		mask.copy(frame, head);
		for (let i = 0; i < length; i++) frame[head + 4 + i] = data[i] ^ mask[i & 3];
	} else data.copy(frame, head);
	return frame;
}

/** Splits a byte stream into frames; returns { frames, rest }. Continuations keep their first frame's opcode. */
export function decodeFrames(buffer, state = { opcode: 0 }) {
	const frames = [];
	let offset = 0;
	while (buffer.length - offset >= 2) {
		const b0 = buffer[offset], b1 = buffer[offset + 1];
		let length = b1 & 0x7f, cursor = offset + 2;
		if (length === 126) { if (buffer.length - cursor < 2) break; length = buffer.readUInt16BE(cursor); cursor += 2; }
		else if (length === 127) {
			if (buffer.length - cursor < 8) break;
			const big = buffer.readBigUInt64BE(cursor);
			if (big > BigInt(MAX_FRAME_BYTES)) throw new Error('frame too large');
			length = Number(big); cursor += 8;
		}
		if (length > MAX_FRAME_BYTES) throw new Error('frame too large');
		const masked = (b1 & 0x80) !== 0;
		if (buffer.length - cursor < (masked ? 4 : 0) + length) break;
		let payload;
		if (masked) {
			const mask = buffer.subarray(cursor, cursor + 4); cursor += 4;
			payload = Buffer.allocUnsafe(length);
			for (let i = 0; i < length; i++) payload[i] = buffer[cursor + i] ^ mask[i & 3];
		} else payload = Buffer.from(buffer.subarray(cursor, cursor + length));
		cursor += length;
		let opcode = b0 & 0x0f;
		if (opcode === 0) opcode = state.opcode;
		else if (opcode < 8) state.opcode = opcode;
		frames.push({ opcode, payload, fin: (b0 & 0x80) !== 0 });
		offset = cursor;
	}
	return { frames, rest: buffer.subarray(offset) };
}

/** One accepted WebSocket on the server side. Emits 'binary', 'text', 'close'. */
class ServerPeer extends EventEmitter {
	#socket; #buffer = Buffer.alloc(0); #state = { opcode: 0 }; #closed = false; #parts = []; #partBytes = 0;
	constructor(socket, head) {
		super();
		this.#socket = socket;
		socket.setNoDelay(true);
		socket.on('data', chunk => this.#read(chunk));
		socket.on('close', () => this.#finish());
		socket.on('error', () => this.#finish());
		if (head?.length) queueMicrotask(() => this.#read(head));
	}
	get socket() { return this.#socket; }
	get closed() { return this.#closed; }
	#read(chunk) {
		this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
		let decoded;
		try { decoded = decodeFrames(this.#buffer, this.#state); } catch { this.close(); return; }
		this.#buffer = decoded.rest;
		for (const frame of decoded.frames) {
			if (frame.opcode === 9) { this.#write(encodeFrame(frame.payload, 10)); continue; }
			if (frame.opcode === 8) { this.close(); continue; }
			if (frame.opcode !== 1 && frame.opcode !== 2) continue;
			// A fragmented message (a proxy may split a large one) is delivered whole.
			this.#parts.push(frame.payload); this.#partBytes += frame.payload.length;
			if (this.#partBytes > MAX_FRAME_BYTES) { this.close(); return; }
			if (!frame.fin) continue;
			const message = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts);
			this.#parts = []; this.#partBytes = 0;
			if (frame.opcode === 2) this.emit('binary', message);
			else this.emit('text', message.toString());
		}
	}
	#write(frame) { return this.#closed ? false : this.#socket.write(frame); }
	sendBinary(data) { return this.#write(encodeFrame(data, 2)); }
	sendText(text) { return this.#write(encodeFrame(text, 1)); }
	close() {
		if (this.#closed) return;
		try { this.#socket.end(encodeFrame(Buffer.alloc(0), 8)); } catch {}
		setTimeout(() => this.#socket.destroy(), 1000).unref();
		this.#finish();
	}
	#finish() {
		if (this.#closed) return;
		this.#closed = true;
		this.emit('close');
	}
}

/**
 * The coordinator the PC asked for. Everything secret it needs (the bridge secret in its environment, the player's
 * Codex/Claude sign-in files) arrives over the control socket and is written only under sessionRoot, which is tmpfs
 * (/dev/shm), never the machine's disk. "${SESSION}" in the config, environment and file paths names that folder.
 * stop() ends the coordinator, returns every sign-in file whose bytes changed (a provider refreshed its token there,
 * which can make the player's own copy stale) and wipes the folder.
 */
export function coordinatorSession({ sessionRoot, coordinatorRoot, log, spawnProcess = spawn, send = () => {} }) {
	let child = null, sent = new Map(), startedAt = null, mirrors = [], mirrorTimer = null, pushed = new Map();
	// Files the PC wants copied back as they grow (the coordinator's audit and trace logs), sent as
	// "file:<name>:<base64 bytes>" text frames to the control socket.
	let pumping = Promise.resolve();
	const pump = () => (pumping = pumping.then(pumpMirrorsOnce).catch(() => {}));
	// A provider that refreshes its sign-in on the machine rotates the refresh token, which makes the player's own
	// copy stale. Each change is sent at once ("signin:<base64 {name, content}>"), so a hard kill loses nothing.
	const pushSignIns = async () => {
		for (const file of await signInFiles(sessionRoot)) {
			const bytes = await readFile(file).catch(() => null);
			if (!bytes) continue;
			const name = path.basename(file), hash = sha256(bytes);
			if (!sent.has(name) || sent.get(name) === hash || pushed.get(file) === hash) continue;
			pushed.set(file, hash);
			send(`signin:${Buffer.from(JSON.stringify({ name, content: bytes.toString('base64') })).toString('base64')}`);
			log('sign-in-pushed', { name });
		}
	};
	let lastSignInCheck = 0;
	const pumpMirrorsOnce = async () => {
		if (Date.now() - lastSignInCheck >= 5_000) { lastSignInCheck = Date.now(); await pushSignIns(); }
		for (const mirror of mirrors) {
			const handle = await open(mirror.file, 'r').catch(() => null);
			if (!handle) continue;
			try {
				for (;;) {
					const chunk = Buffer.allocUnsafe(256 * 1024);
					const { bytesRead } = await handle.read(chunk, 0, chunk.length, mirror.offset);
					if (bytesRead === 0) break;
					mirror.offset += bytesRead;
					send(`file:${mirror.name}:${chunk.subarray(0, bytesRead).toString('base64')}`);
				}
			} finally { await handle.close(); }
		}
	};
	const expand = value => typeof value === 'string' ? value.replaceAll('${SESSION}', sessionRoot)
		: Array.isArray(value) ? value.map(expand)
			: value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)])) : value;
	const inside = file => {
		const resolved = path.resolve(sessionRoot, file);
		if (!resolved.startsWith(sessionRoot + path.sep)) throw new Error(`session file outside the session folder: ${file}`);
		return resolved;
	};
	const stop = async () => {
		const running = child;
		child = null;
		clearInterval(mirrorTimer); mirrorTimer = null;
		if (running && running.exitCode === null) {
			try { process.kill(-running.pid, 'SIGTERM'); } catch {}
			const exited = await Promise.race([new Promise(done => running.once('exit', () => done(true))), new Promise(done => setTimeout(() => done(false), 8_000))]);
			if (!exited) try { process.kill(-running.pid, 'SIGKILL'); } catch {}
		}
		await pump();
		mirrors = [];
		const changed = [];
		for (const file of await signInFiles(sessionRoot)) {
			const bytes = await readFile(file).catch(() => null);
			if (!bytes) continue;
			const name = path.basename(file), hash = sha256(bytes), original = sent.get(name);
			if (original && original !== hash) changed.push({ name, mtimeMs: (await stat(file)).mtimeMs, content: bytes.toString('base64') });
		}
		changed.sort((a, b) => b.mtimeMs - a.mtimeMs);
		await rm(sessionRoot, { recursive: true, force: true });
		if (running) log('session-stopped', { changed: changed.length });
		sent = new Map(); pushed = new Map(); startedAt = null;
		return { changed };
	};
	return {
		get running() { return child !== null && child.exitCode === null; },
		status: () => ({ running: child !== null && child.exitCode === null, startedAt, exitCode: child?.exitCode ?? null }),
		stop,
		async start({ config, env = {}, files = [], mirror = [] }) {
			await stop();
			await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
			await chmod(sessionRoot, 0o700);
			for (const file of files) {
				const target = inside(expand(file.path));
				await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
				const bytes = Buffer.from(file.content, 'base64');
				await writeFile(target, bytes, { mode: 0o600 });
				if (SIGN_IN_FILES.has(path.basename(target))) sent.set(path.basename(target), sha256(bytes));
			}
			const configFile = path.join(sessionRoot, 'coordinator-config.json');
			await writeFile(configFile, JSON.stringify(expand(config)), { mode: 0o600 });
			const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8', ...expand(env) };
			const out = await open(path.join(sessionRoot, 'coordinator.log'), 'a', 0o600);
			child = spawnProcess(process.execPath, [path.join(coordinatorRoot, 'src/dynamic-main.mjs'), '--config', configFile],
				{ cwd: coordinatorRoot, env: childEnv, detached: true, stdio: ['ignore', out.fd, out.fd] });
			await out.close();
			startedAt = Date.now();
			mirrors = mirror.map(entry => ({ name: String(entry.name), file: inside(expand(entry.path)), offset: 0 }));
			for (const entry of mirrors) await mkdir(path.dirname(entry.file), { recursive: true, mode: 0o700 });
			mirrorTimer = setInterval(() => { void pump(); }, mirrors.length ? 500 : 5_000);
			const started = child;
			child.once('exit', (code, signal) => {
				log('coordinator-exit', { code, signal, running: started === child });
				if (started !== child) return;
				// The last lines of its log say why it ended; the session folder is wiped at stop.
				readFile(path.join(sessionRoot, 'coordinator.log'), 'utf8').catch(() => '')
					.then(text => send(`exited:${JSON.stringify({ code, signal, tail: text.slice(-1200) })}`));
			});
			log('session-started', { pid: child.pid, files: files.length });
			return { pid: child.pid };
		},
	};
}

const SIGN_IN_FILES = new Set(['auth.json', '.credentials.json']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function signInFiles(root) {
	const found = [];
	const walk = async dir => {
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (SIGN_IN_FILES.has(entry.name)) found.push(full);
		}
	};
	await walk(root);
	return found;
}

/** Replaces the coordinator code under root with a gzipped tar the PC sent. The code is not secret; it goes to disk. */
async function installBundle(bytes, root, session) {
	if (session.running) throw new Error('stop the session before installing');
	const archive = `${root}.tgz`;
	await rm(root, { recursive: true, force: true });
	await mkdir(root, { recursive: true });
	await writeFile(archive, bytes);
	await new Promise((resolve, reject) => {
		const tar = spawn('tar', ['-xzf', archive, '-C', root], { stdio: ['ignore', 'ignore', 'pipe'] });
		let err = '';
		tar.stderr.on('data', chunk => { err += chunk; });
		tar.on('error', reject);
		tar.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.slice(-200)}`)));
	});
	await rm(archive, { force: true });
	log('installed', { bytes: bytes.length });
}

function keyMatches(offered, key) {
	const a = Buffer.from(offered), b = Buffer.from(key);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The boat-machine side. Listens for the PC's WebSockets on 127.0.0.1:wsPort (boat host --localhost relays the hosted
 * URL to it) and presents the bridge on 127.0.0.1:bridgePort.
 */
export function serveRelay({ key, bridgePort, wsPort, host = '127.0.0.1', now = Date.now, sessionRoot = DEFAULT_SESSION_ROOT,
	coordinatorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), watchdogMs = WATCHDOG_MS, spawnProcess = spawn }) {
	if (!key || key.length < 32) throw new Error('BOAT_RELAY_KEY must hold at least 32 characters');
	const spares = [];
	const waiting = [];
	const live = new Set();
	const controls = new Set();
	let lastControlAt = now();
	const session = coordinatorSession({ sessionRoot, coordinatorRoot, log, spawnProcess, send: text => { for (const peer of controls) peer.sendText(text); } });
	const httpServer = http.createServer((request, response) => {
		response.writeHead(request.url === '/health' ? 200 : 404, { 'content-type': 'text/plain' });
		response.end(request.url === '/health' ? `ok spares=${spares.length} live=${live.size}\n` : 'not found\n');
	});
	httpServer.on('upgrade', (request, socket, head) => {
		const offered = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim()).find(s => s.startsWith(RELAY_PROTOCOL_PREFIX)) ?? '';
		const headerKey = String(request.headers['x-mineagen-relay-key'] ?? '');
		const presented = headerKey || offered.slice(RELAY_PROTOCOL_PREFIX.length);
		const wsKey = request.headers['sec-websocket-key'];
		const pathname = new URL(request.url, 'http://relay').pathname;
		const control = pathname.endsWith('/control');
		if (!(control || pathname.endsWith('/bridge')) || !wsKey || !keyMatches(presented, key)) {
			socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
			log('refused', { reason: presented ? 'key' : 'no-key' });
			return;
		}
		socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
			`Sec-WebSocket-Accept: ${acceptKey(wsKey)}`, ...(offered ? [`Sec-WebSocket-Protocol: ${offered}`] : []), '', ''].join('\r\n'));
		const peer = new ServerPeer(socket, head);
		peer.on('text', text => {
			if (text.startsWith('pong:')) log('rtt', { ms: now() - Number(text.slice(5)), live: live.has(peer), control: controls.has(peer) });
		});
		if (control) {
			controls.add(peer);
			lastControlAt = now();
			peer.on('text', text => {
				lastControlAt = now();
				if (text.startsWith('ping:')) peer.sendText(`pong:${text.slice(5)}`);
				else if (text.startsWith('start:')) session.start(JSON.parse(Buffer.from(text.slice(6), 'base64').toString()))
					.then(result => peer.sendText(`started:${JSON.stringify(result)}`), error => peer.sendText(`failed:${JSON.stringify({ message: String(error.message).slice(0, 300) })}`));
				else if (text === 'stop') session.stop().then(result => peer.sendText(`stopped:${Buffer.from(JSON.stringify(result)).toString('base64')}`));
				else if (text === 'status') peer.sendText(`status:${JSON.stringify(session.status())}`);
				else if (text.startsWith('install:')) installBundle(Buffer.from(text.slice(8), 'base64'), coordinatorRoot, session)
					.then(() => peer.sendText('installed'), error => peer.sendText(`failed:${JSON.stringify({ message: String(error.message).slice(0, 300) })}`));
			});
			peer.on('close', () => { controls.delete(peer); lastControlAt = now(); });
			log('control-open');
			return;
		}
		peer.on('close', () => { const i = spares.indexOf(peer); if (i >= 0) spares.splice(i, 1); live.delete(peer); });
		const next = waiting.shift();
		if (next) next(peer); else spares.push(peer);
		log('spare', { spares: spares.length });
	});
	const takeSpare = () => new Promise(resolve => {
		while (spares.length) { const peer = spares.shift(); if (!peer.closed) { resolve(peer); return; } }
		const timer = setTimeout(() => { const i = waiting.indexOf(resolve); if (i >= 0) waiting.splice(i, 1); resolve(null); }, SPARE_WAIT_MS);
		waiting.push(peer => { clearTimeout(timer); resolve(peer); });
	});
	const bridgeServer = net.createServer(async tcp => {
		tcp.setNoDelay(true);
		tcp.pause();
		const peer = await takeSpare();
		if (!peer || tcp.destroyed) { tcp.destroy(); peer?.close(); log('bridge-refused', { reason: peer ? 'gone' : 'no-pc' }); return; }
		live.add(peer);
		log('bridge-open', { live: live.size });
		peer.sendText('open');
		tcp.on('data', chunk => { if (!peer.sendBinary(chunk)) tcp.pause(); });
		peer.socket.on('drain', () => tcp.resume());
		peer.on('binary', data => { if (!tcp.write(data)) peer.socket.pause(); });
		tcp.on('drain', () => peer.socket.resume());
		const end = () => { tcp.destroy(); peer.close(); };
		tcp.on('close', end); tcp.on('error', end); peer.on('close', () => { end(); log('bridge-close', { live: live.size }); });
		tcp.resume();
	});
	const pinger = setInterval(() => {
		for (const peer of [...spares, ...live, ...controls]) if (!peer.closed) peer.sendText(`ping:${now()}`);
	}, PING_EVERY_MS);
	pinger.unref();
	const watchdog = setInterval(() => {
		if (session.running && controls.size === 0 && now() - lastControlAt > watchdogMs) {
			log('watchdog', { idleMs: now() - lastControlAt });
			void session.stop();
		}
	}, 5_000);
	watchdog.unref();
	return new Promise((resolve, reject) => {
		httpServer.once('error', reject);
		bridgeServer.once('error', reject);
		httpServer.listen(wsPort, host, () => bridgeServer.listen(bridgePort, '127.0.0.1', () => {
			log('listening', { wsPort: httpServer.address().port, bridgePort: bridgeServer.address().port });
			resolve({
				wsPort: httpServer.address().port,
				bridgePort: bridgeServer.address().port,
				close: async () => { clearInterval(pinger); clearInterval(watchdog); await session.stop(); for (const p of [...spares, ...live, ...controls]) p.close(); httpServer.close(); bridgeServer.close(); },
				session,
			});
		}));
	});
}

/**
 * The PC side (a stand-in for the mod's own dialer): keeps one spare WebSocket to the relay and, when the relay says
 * "open", joins it to a fresh connection to the local bridge.
 */
export function dialRelay({ url, key, bridgePort, bridgeHost = '127.0.0.1', WebSocketImpl = globalThis.WebSocket }) {
	let stopped = false, backoff = 500, spareOpen = false;
	const sockets = new Set();
	const openSpare = () => {
		if (stopped || spareOpen) return;
		spareOpen = true;
		const ws = new WebSocketImpl(url, [`${RELAY_PROTOCOL_PREFIX}${key}`]);
		ws.binaryType = 'arraybuffer';
		sockets.add(ws);
		let tcp = null, pending = [], used = false;
		ws.onopen = () => { backoff = 500; log('dial-open'); };
		ws.onmessage = event => {
			if (typeof event.data === 'string') {
				if (event.data.startsWith('ping:')) ws.send(`pong:${event.data.slice(5)}`);
				else if (event.data === 'open' && !used) {
					used = true; spareOpen = false; openSpare();
					tcp = net.createConnection({ host: bridgeHost, port: bridgePort });
					tcp.setNoDelay(true);
					tcp.on('connect', () => { for (const chunk of pending) tcp.write(chunk); pending = null; log('bridge-connected'); });
					tcp.on('data', chunk => ws.readyState === 1 && ws.send(chunk));
					const end = () => { try { ws.close(); } catch {} };
					tcp.on('close', end); tcp.on('error', end);
				}
				return;
			}
			const chunk = Buffer.from(event.data);
			if (pending) pending.push(chunk); else tcp?.write(chunk);
		};
		ws.onclose = event => {
			sockets.delete(ws);
			tcp?.destroy();
			if (!used) {
				spareOpen = false;
				log('dial-closed', { code: event.code, reason: event.reason || null });
				if (!stopped) { setTimeout(openSpare, backoff); backoff = Math.min(backoff * 2, 15_000); }
			}
		};
		ws.onerror = () => {};
	};
	openSpare();
	return { close() { stopped = true; for (const ws of sockets) try { ws.close(); } catch {} } };
}

function flag(args, name, fallback = undefined) {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [mode, ...args] = process.argv.slice(2);
	// --key-file is read once and deleted, so the key is on the machine's disk only for the seconds before the relay starts.
	const keyFile = flag(args, 'key-file');
	let key = process.env.BOAT_RELAY_KEY ?? '';
	if (keyFile) { key = (await readFile(keyFile, 'utf8')).trim(); await rm(keyFile, { force: true }); }
	const bridgePort = Number(flag(args, 'bridge-port'));
	if (mode === 'serve') {
		const coordinatorRoot = flag(args, 'coordinator-root');
		const relay = await serveRelay({ key, bridgePort, wsPort: Number(flag(args, 'ws-port', 8787)),
			...(coordinatorRoot ? { coordinatorRoot: path.resolve(coordinatorRoot) } : {})
		});
		for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await relay.close(); process.exit(0); });
	} else if (mode === 'dial') {
		const dialer = dialRelay({ url: flag(args, 'url'), key, bridgePort });
		for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { dialer.close(); process.exit(0); });
	} else {
		console.error('Usage: boat-relay.mjs serve --bridge-port N [--ws-port M] [--key-file F] [--coordinator-root DIR] | dial --url WSS_URL --bridge-port N (key in BOAT_RELAY_KEY)');
		process.exit(2);
	}
}
