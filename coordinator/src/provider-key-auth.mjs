import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rememberCredential } from './provider-key-redaction.mjs';
let temporaryHome = null;

/** Only process-local settings change. The operator's existing CLI login and config stay intact. */
export function configureProviderKeyAuth(provider, child, credentialRoot = null) {
	for (const [name, value] of Object.entries(child)) {
		if (/(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/i.test(name)) rememberCredential(value);
	}
	if (provider === 'codex' && !child.OPENAI_API_KEY && child.CODEX_API_KEY) child.OPENAI_API_KEY = child.CODEX_API_KEY;
	if (provider === 'gemini' && child.GEMINI_API_KEY?.trim()) {
		const home = credentialRoot ? path.resolve(credentialRoot, '..', 'provider-cli-homes', 'gemini')
			: (temporaryHome ??= mkdtempSync(path.join(os.tmpdir(), 'arena-agents-gemini-')));
		const directory = path.join(home, '.gemini', 'antigravity-cli');
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ modelProvider: 'gemini' }), { mode: 0o600 });
		child.HOME = home;
		child.USERPROFILE = home;
		delete child.AGY_HOME;
		delete child.GEMINI_CLI_HOME;
	}
	return child;
}
