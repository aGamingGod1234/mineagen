import { rememberCredential } from './provider-key-redaction.mjs';

/** Only process-local settings change. The operator's existing CLI login and config stay intact. */
export function configureProviderKeyAuth(provider, child) {
	for (const [name, value] of Object.entries(child)) {
		if (/(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/i.test(name)) rememberCredential(value);
	}
	if (provider === 'codex' && !child.OPENAI_API_KEY && child.CODEX_API_KEY) child.OPENAI_API_KEY = child.CODEX_API_KEY;
	return child;
}
