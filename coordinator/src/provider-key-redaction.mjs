// Retain old values too: late output from a retiring CLI must remain redacted.
const credentials = new Set();
export function rememberCredential(value) {
	if (typeof value === 'string' && value.length >= 8) credentials.add(value);
}
export function redactCredentialText(value) {
	let text = String(value ?? '');
	for (const [name, value] of Object.entries(process.env)) {
		if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)) rememberCredential(value);
	}
	for (const secret of credentials) {
		text = text.split(secret).join('[REDACTED]');
		// Structured diagnostics sometimes embed an already JSON-escaped string.
		const escaped = JSON.stringify(secret).slice(1, -1);
		if (escaped !== secret) text = text.split(escaped).join('[REDACTED]');
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
