import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { terminateChildProcess } from '../src/child-process-lifecycle.mjs';
import { CodexStdioTransport } from '../src/codex-app-server.mjs';

const FAST_STOP_TIMEOUT_MS = 5;
const REQUEST_TIMEOUT_MS = 5;
const SETTLE_TIMEOUT_MS = 100;

class UncooperativeChild extends EventEmitter {
	constructor() {
		super();
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		this.stdin = new EventEmitter();
		this.stdin.write = () => {};
		this.killed = false;
		this.exitCode = null;
		this.signalCode = null;
		this.signals = [];
	}

	kill(signal = 'SIGTERM') {
		this.killed = true;
		this.signals.push(signal);
		return true;
	}
}

test('provider transports own late stdio EPIPE errors and reject pending work once', async () => {
	for (const [name, create] of [
		['Codex', (child) => new CodexStdioTransport(
			{ model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' },
			{ spawn: spawnUncooperativeChild(child), stopTimeoutMs: FAST_STOP_TIMEOUT_MS },
		)],
	]) {
		const child = new UncooperativeChild();
		const transport = create(child);
		const exits = [];
		transport.on('exit', (error) => exits.push(error));
		await transport.start();
		const pending = transport.request('pending/request', {}, { timeoutMs: SETTLE_TIMEOUT_MS });
		child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
		await assert.rejects(pending, (error) => error?.code === 'PROCESS_IO_ERROR');
		assert.equal(exits.length, 1, `${name} reports one owned transport loss`);
		assert.throws(() => transport.notify('after/error'), (error) => error?.code === 'TRANSPORT_NOT_RUNNING');
		await transport.stop();
	}
});

function spawnUncooperativeChild(child) {
	return () => {
		queueMicrotask(() => child.emit('spawn'));
		return child;
	};
}

function spawnAlreadyRunningChild(child) {
	return () => {
		child.pid = 12345;
		child.emit('spawn');
		return child;
	};
}

async function within(promise, timeoutMs = SETTLE_TIMEOUT_MS) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`operation did not settle within ${timeoutMs} ms`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function transportCases() {
	return [
		{
			name: 'Codex',
			create(child) {
				return new CodexStdioTransport(
					{ model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' },
					{ spawn: spawnUncooperativeChild(child), stopTimeoutMs: FAST_STOP_TIMEOUT_MS },
				);
			},
		},
	];
}

function createWithSpawn(child, spawn) {
	return new CodexStdioTransport(
		{ model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' },
		{ spawn, stopTimeoutMs: FAST_STOP_TIMEOUT_MS },
	);
}

for (const entry of transportCases()) {
	test(`${entry.name} starts when the child is already running before listeners attach`, async () => {
		const child = new UncooperativeChild();
		const transport = createWithSpawn(child, spawnAlreadyRunningChild(child));

		await within(transport.start());
		child.pid = undefined;
		await within(transport.stop());
	});

	test(`${entry.name} shutdown force-kills a child that ignores graceful termination`, async () => {
		const child = new UncooperativeChild();
		const transport = entry.create(child);
		await transport.start();

		await within(transport.stop());

		assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
	});
}

test('Codex request timeout preserves the shared transport and unrelated requests', async () => {
	const child = new UncooperativeChild();
	const requests = [];
	child.stdin.write = (line) => requests.push(JSON.parse(String(line).trim()));
	const transport = new CodexStdioTransport(
		{ model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' },
		{ spawn: spawnUncooperativeChild(child), stopTimeoutMs: FAST_STOP_TIMEOUT_MS },
	);
	const protocolErrors = [];
	transport.on('protocolError', (error) => protocolErrors.push(error.code));
	await transport.start();

	const timedOut = transport.request('slow/request', {}, { timeoutMs: REQUEST_TIMEOUT_MS });
	const survivor = transport.request('fast/request', {}, { timeoutMs: SETTLE_TIMEOUT_MS });
	await assert.rejects(timedOut, (error) => error?.code === 'REQUEST_TIMEOUT');
	child.stdout.emit('data', `${JSON.stringify({ id: requests[0].id, result: { late: true } })}\n`);
	child.stdout.emit('data', `${JSON.stringify({ id: requests[1].id, result: { ok: true } })}\n`);

	assert.deepEqual(await within(survivor), { ok: true });
	assert.deepEqual(protocolErrors, []);
	assert.deepEqual(child.signals, []);
	assert.doesNotThrow(() => transport.notify('still/running'));
	await transport.stop();
});

test('Codex transport surfaces server tool requests and sends their JSON-RPC result', async () => {
	const child = new UncooperativeChild();
	const written = [];
	child.stdin.write = (line) => written.push(JSON.parse(String(line).trim()));
	const transport = new CodexStdioTransport(
		{ model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' },
		{ spawn: spawnUncooperativeChild(child), stopTimeoutMs: FAST_STOP_TIMEOUT_MS },
	);
	await transport.start();

	const request = new Promise((resolve) => transport.once('serverRequest', resolve));
	child.stdout.emit('data', `${JSON.stringify({
		id: 91,
		method: 'item/tool/call',
		params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'observe', arguments: {} },
	})}\n`);
	assert.deepEqual(await within(request), {
		id: 91,
		method: 'item/tool/call',
		params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'observe', arguments: {} },
	});

	transport.respond(91, { success: true, contentItems: [{ type: 'inputText', text: '{"ok":true}' }] });
	assert.deepEqual(written.at(-1), {
		id: 91,
		result: { success: true, contentItems: [{ type: 'inputText', text: '{"ok":true}' }] },
	});
	await transport.stop();
});

test('Windows cleanup rejects an exited PID before issuing any kill', async () => {
	const child = new UncooperativeChild(); child.pid = 4242; child.exitCode = 0;
	let executions = 0;
	await terminateChildProcess(child, { platform: 'win32', execFile: () => executions++ });
	assert.equal(executions, 0);
	assert.deepEqual(child.signals, []);
});

test('Windows cleanup uses the retained handle even if its numeric PID is reused', async () => {
	const child = new UncooperativeChild(); child.pid = 4242;
	let executions = 0;
	child.kill = signal => { child.signals.push(signal); child.exitCode = 1; child.emit('exit', 1); return true; };
	await terminateChildProcess(child, { platform: 'win32', execFile: () => executions++ });
	assert.equal(executions, 0, 'no PID lookup or PID-based kill is permitted');
	assert.deepEqual(child.signals, ['SIGTERM']);
});

test('Windows cleanup reports unconfirmed handle termination for retry', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const child = new UncooperativeChild(); child.pid = 4242;
	const rejected = assert.rejects(terminateChildProcess(child, { platform: 'win32', timeoutMs: 20 }), /Could not confirm termination/);
	t.mock.timers.tick(10);
	await new Promise(resolve => setImmediate(resolve));
	t.mock.timers.tick(10);
	await rejected;
	assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});
