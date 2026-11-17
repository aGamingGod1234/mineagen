// Every fresh process needs 1.5 s to load its models, on warmup or first synthesis; 'crash-worker' exits the process.
import { createInterface } from 'node:readline';

let loaded = null;
const load = () => (loaded ??= new Promise(resolve => setTimeout(resolve, 1_500)));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
	const request = JSON.parse(line);
	if (request.op === 'tts' && request.text === 'crash-worker') process.exit(3);
	load().then(() => {
		const reply = request.op === 'warmup' ? { ok: true, sttReady: true, ttsReady: true }
			: request.op === 'tts' ? { ok: true, sampleRateHz: 24_000, pcmBase64: Buffer.from([1, 0, 2, 0]).toString('base64') }
				: { ok: false, code: 'UNKNOWN_OPERATION', message: 'Unknown operation' };
		process.stdout.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
	});
}
