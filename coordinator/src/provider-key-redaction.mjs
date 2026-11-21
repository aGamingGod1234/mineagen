// Retain old values too: late output from a retiring CLI must remain redacted. Each secret maps to its JSON-escaped
// form when that differs, because structured diagnostics sometimes embed an already escaped string.
const credentials = new Map();
export function rememberCredential(value) {
	if (typeof value !== 'string' || value.length < 8 || credentials.has(value)) return;
	const escaped = JSON.stringify(value).slice(1, -1);
	credentials.set(value, escaped === value ? null : escaped);
}

/** Remembers every credential-named environment variable. Enumerating process.env is the expensive part of redaction. */
export function rememberEnvironmentCredentials() {
	for (const [name, value] of Object.entries(process.env)) {
		if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)) rememberCredential(value);
	}
}

export function redactCredentialText(value) {
	rememberEnvironmentCredentials();
	return redactRememberedCredentials(value);
}

/**
 * Redacts the credentials already remembered, without rescanning the environment. For a caller that scanned it once
 * for a whole structured value: scanning per string cost 0.3 s for each 60 KB observation in the protocol audit.
 */
export function redactRememberedCredentials(value) {
	let text = String(value ?? '');
	for (const [secret, escaped] of credentials) {
		if (text.includes(secret)) text = text.split(secret).join('[REDACTED]');
		if (escaped !== null && text.includes(escaped)) text = text.split(escaped).join('[REDACTED]');
	}
	return text;
}

/** Hold incomplete lines so a key split across stderr chunks cannot escape as separately logged fragments. */
export function createCredentialLineRedactor(emit) {
	let pending = '';
	let dropping = false;
	const flushLine = (line) => emit(dropping ? '[oversized diagnostic line omitted]' : redactCredentialText(line));
	return {
		write(chunk) {
			pending += String(chunk);
			for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
				flushLine(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
				dropping = false;
			}
			if (pending.length > 16_384) { pending = ''; dropping = true; }
		},
		end() { if (pending.length > 0 || dropping) flushLine(pending); pending = ''; dropping = false; },
	};
}
