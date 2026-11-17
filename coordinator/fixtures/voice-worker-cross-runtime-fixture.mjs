import readline from 'node:readline';

import { createVoiceHttpServer } from '../src/voice/voice-http-server.mjs';
import { VoiceProfileStore, builtInVoiceProfiles, directorVoiceProfiles } from '../src/voice/voice-profile-store.mjs';

const secret = process.env.VOICE_FIXTURE_SECRET;
if (typeof secret !== 'string' || secret.length < 16) throw new Error('VOICE_FIXTURE_SECRET is required');

const pcm = Buffer.alloc(441 * 2);
for (let index = 0; index < 441; index++) pcm.writeInt16LE((index * 71) % 20_000, index * 2);

const store = new VoiceProfileStore();
const worker = createVoiceHttpServer({
	directorUsesPrimaryProvider: true,
	provider: {
		async synthesize({ text, voiceId, speed, tone }) {
			if (text === 'Playback may finish later.') {
				const saved = directorVoiceProfiles().find(profile => profile.profileId === 'voice.ethan.v1');
				const expected = voiceId === saved.voiceId ? { speed: 1.25, tone: 'dramatic' } : { speed: 0.94, tone: 'neutral' };
				if (speed !== expected.speed || tone !== expected.tone) throw new Error('ordinary speech settings were lost before the provider');
			}
			if (text === 'Explicit speed one.' && speed !== 1) throw new Error('explicit speed was replaced');
			return { sampleRateHz: 44_100, channels: 1, sampleFormat: 's16le', pcm };
		},
	},
	sttProvider: {
		async transcribe({ pcm: input }) {
			return { transcript: `fixture heard ${input.length} bytes`, confidence: 0.88 };
		},
	},
	profileStore: {
		resolve() { return builtInVoiceProfiles()[0]; },
		resolveRequested(agentId, profileId) {
			return profileId === 'voice.auto.v1' ? builtInVoiceProfiles()[0] : store.resolveRequested(agentId, profileId);
		},
	},
	secret,
	port: 0,
});

const address = await worker.start();
process.stdout.write(`READY ${address.port}\n`);

const lines = readline.createInterface({ input: process.stdin });
lines.once('line', async (line) => {
	const exitCode = line.trim() === 'close' ? 0 : 2;
	lines.close();
	await worker.close();
	process.exit(exitCode);
});
