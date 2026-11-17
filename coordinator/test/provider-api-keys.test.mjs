import { createCredentialLineRedactor, rememberCredential } from '../src/provider-key-redaction.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderChildEnvironment } from '../src/provider-environment.mjs';
import { probeProviderCli } from '../src/provider-cli-health.mjs';
import { buildProviderRows } from '../src/provider-discovery.mjs';
import { CodexService } from '../src/codex-service.mjs';
import { FakeSharedTransport } from './fixtures/codex-service-fixture.mjs';
import { resolveCodexLaunch } from '../src/codex-app-server.mjs';
import { resolveClaudeLaunch } from '../src/claude-service.mjs';
import { sanitizeDiagnosticText, sanitizeDiagnosticErrorStack, sanitizeDiagnosticValue } from '../src/diagnostic-sanitizer.mjs';

const key = 'synthetic-provider-key-9xYz';
const variables = { codex: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY' };
const profile = { model: 'test-model', reasoningEffort: 'low', serviceTier: 'default' };

test('API-key scan readiness requires a working installed CLI for every known provider', async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), 'arena-key-readiness-'));
	try {
		for (const [provider, variable] of Object.entries(variables)) {
			const environment = createProviderChildEnvironment(provider, { PATH: '/fake/bin', [variable]: key, ARENA_PROVIDER_CREDENTIAL_ROOT: path.join(root, 'keys') });
			let calls = 0;
			const dependencies = { platform: 'linux', environment, existsSync: () => true, execFile: (_command, args, options, callback) => {
				calls += 1;
				assert.ok(args.includes('--version'));
				assert.equal(options.env[variable], key);
				callback(null, 'CLI 1.2.3', '');
			} };
			const health = await probeProviderCli(provider, dependencies);
			assert.equal(health.status, 'ok');
			assert.equal(calls, 1, 'key readiness starts no auth/model calls');
			assert.equal(JSON.stringify(health).includes(key), false);
			assert.equal(buildProviderRows({ health: { [provider]: health } }).find(row => row.id === provider).signedIn, true);
			assert.equal((await probeProviderCli(provider, { ...dependencies, existsSync: () => false })).status, 'missing');
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('stored-key launch environments reach only their CLI and Codex selects API billing without login writes', () => {
	const environment = { OPENAI_API_KEY: key, ANTHROPIC_API_KEY: key, OPENCODE_API_KEY: key, FISH_API_KEY: 'unrelated-key' };
	const codex = resolveCodexLaunch({ ...profile, environment }, { platform: 'linux' });
	const claude = resolveClaudeLaunch({ environment }, { platform: 'linux' });
	for (const [provider, child] of [['codex', codex.environment], ['claude', claude.environment]]) {
		assert.equal(child[variables[provider]], key);
		assert.equal(child.FISH_API_KEY, undefined);
		assert.equal(child.OPENCODE_API_KEY, undefined);
		for (const [other, variable] of Object.entries(variables)) if (other !== provider) assert.equal(child[variable], undefined);
	}
	assert.ok(codex.args.includes('cli_auth_credentials_store="ephemeral"'));
	assert.equal(codex.args.some(arg => arg.startsWith('model_provider=')), false);
	assert.equal(codex.args.join(' ').includes(key), false);
	assert.equal(resolveCodexLaunch({ ...profile, environment: {} }, { platform: 'linux' }).args.includes('cli_auth_credentials_store="ephemeral"'), false);
	assert.equal(createProviderChildEnvironment('codex', { CODEX_API_KEY: key }).OPENAI_API_KEY, key);
});

test('raw API keys are redacted from scan output, diagnostic stacks and nested diagnostics', async () => {
	createProviderChildEnvironment('claude', { ANTHROPIC_API_KEY: key });
	assert.equal(sanitizeDiagnosticText('raw key ' + key).includes(key), false);
	assert.equal(sanitizeDiagnosticErrorStack(new Error('failed: ' + key)).includes(key), false);
	assert.equal(JSON.stringify(sanitizeDiagnosticValue({ detail: 'CLI said ' + key })).includes(key), false);
	const health = await probeProviderCli('claude', {
		platform: 'linux', environment: { PATH: '/fake/bin', ANTHROPIC_API_KEY: key }, existsSync: () => true,
		execFile: (_command, _args, _options, callback) => callback(Object.assign(new Error('bad'), { code: 1 }), '', 'failed with raw key ' + key),
	});
	assert.equal(health.status, 'broken');
	assert.equal(JSON.stringify(health).includes(key), false);
});


test('Codex app-server receives API-key login before model discovery and subscription mode sends no login', async () => {
	for (const environment of [{ OPENAI_API_KEY: key }, { CODEX_API_KEY: key }, {}]) {
		const transport = new FakeSharedTransport();
		const originalRequest = transport.request.bind(transport);
		transport.request = async (method, params, options) => {
			if (method === 'account/login/start') { transport.calls.push({ method, params }); return { type: 'apiKey' }; }
			return originalRequest(method, params, options);
		};
		const service = new CodexService({ cwd: '/fake/work', environment }, { transport });
		try {
			await service.start();
			const login = transport.calls.findIndex(call => call.method === 'account/login/start');
			if (Object.keys(environment).length === 0) assert.equal(login, -1);
			else {
				assert.ok(login >= 0 && login < transport.calls.findIndex(call => call.method === 'model/list'));
				assert.deepEqual(transport.calls[login].params, { type: 'apiKey', apiKey: key });
			}
		} finally { await service.stop(); }
	}
});


test('CLI stderr redaction covers split chunks and incomplete crash output', () => {
	rememberCredential(key);
	const lines = [];
	const stream = createCredentialLineRedactor(line => lines.push(line));
	stream.write('failed ' + key.slice(0, 12));
	assert.deepEqual(lines, []);
	stream.write(key.slice(12) + '\n');
	stream.write('crash ' + key);
	stream.end();
	assert.deepEqual(lines, ['failed [REDACTED]', 'crash [REDACTED]']);
});
