import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenAiTtsProvider, OpenAiSttProvider, openAiVoiceForProfile } from '../src/voice/openai-speech-provider.mjs';
import * as openAiSpeech from '../src/voice/openai-speech-provider.mjs';
import { TtsCache } from '../src/voice/tts-cache.mjs';
import { startVoiceWorker } from '../src/dynamic-main.mjs';
import { VoiceProfileStore, builtInVoiceProfiles, loadPersistentVoiceProfileStore } from '../src/voice/voice-profile-store.mjs';
import { directorVoiceProfiles } from '../src/voice/voice-profile-store.mjs';
import { createVoiceHttpServer, createVoiceRequestHeaders } from '../src/voice/voice-http-server.mjs';

test('OpenAI TTS reads exactly the selected agent reply as bounded 24 kHz PCM', async () => {
	let request;
	const provider = new OpenAiTtsProvider({ apiKey: 'private-test-key', fetchImpl: async (url, options) => {
		request = { url, options };
		return new Response(Buffer.from([0, 0, 1, 0]), { status: 200 });
	} });
	const spoken = 'The stone pickaxe and axe are ready.';
	const audio = await provider.synthesize({ text: spoken, voiceId: 'profile-for-sol', speed: 1.03, tone: 'warm' });
	assert.equal(request.url, 'https://api.openai.com/v1/audio/speech');
	assert.equal(request.options.headers.Authorization, 'Bearer private-test-key');
	const body = JSON.parse(request.options.body);
	assert.equal(body.model, 'gpt-4o-mini-tts');
	assert.equal(body.input, spoken);
	assert.equal(body.voice, openAiVoiceForProfile('profile-for-sol'));
	assert.equal(body.response_format, 'pcm');
	assert.equal(body.speed, 1.03);
	assert.equal(audio.sampleRateHz, 24_000);
	assert.equal(audio.sampleFormat, 's16le');
	assert.deepEqual(audio.pcm, Buffer.from([0, 0, 1, 0]));
	assert.match(provider.cacheNamespace(), /^openai\/gpt-4o-mini-tts\//);
});

test('OpenAI STT uploads valid WAV containing the unmodified microphone samples', async () => {
	let request;
	const pcm = Buffer.from([1, 0, 254, 255]);
	const provider = new OpenAiSttProvider({ apiKey: 'private-test-key', fetchImpl: async (url, options) => {
		request = { url, options };
		return Response.json({ text: '  Get an iron pickaxe.  ' });
	} });
	const transcript = await provider.transcribe({ pcm });
	assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions');
	assert.equal(request.options.body.get('model'), 'gpt-transcribe');
	assert.equal(request.options.body.get('response_format'), 'json');
	assert.equal(request.options.headers['Content-Type'], undefined, 'fetch must add the multipart boundary');
	const wav = Buffer.from(await request.options.body.get('file').arrayBuffer());
	assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
	assert.equal(wav.readUInt32LE(24), 48_000);
	assert.equal(wav.readUInt16LE(22), 1);
	assert.equal(wav.readUInt32LE(40), pcm.length);
	assert.deepEqual(wav.subarray(44), pcm);
	assert.deepEqual(transcript, { transcript: 'Get an iron pickaxe.', confidence: 0 });
});

test('OpenAI speech reports authentication and rate failures without reflecting credentials', async () => {
	for (const status of [401, 403, 429, 500]) {
		const provider = new OpenAiTtsProvider({ apiKey: 'do-not-print-this-key', fetchImpl: async () =>
			new Response('upstream error containing do-not-print-this-key', { status, headers: { 'retry-after': '2' } }) });
		await assert.rejects(provider.synthesize({ text: 'Hello.', voiceId: 'cedar' }), error => {
			assert.doesNotMatch(error.message, /do-not-print/);
			assert.equal(error.code, status === 429 ? 'TTS_RATE_LIMITED' : status < 500 ? 'TTS_AUTHENTICATION_FAILED' : 'TTS_PROVIDER_ERROR');
			assert.equal(error.retryAfter, '2');
			return true;
		});
	}
});

test('OpenAI speech rejects malformed and oversized audio and transcripts', async () => {
	const tts = new OpenAiTtsProvider({ apiKey: 'test-key', fetchImpl: async () => new Response(Buffer.from([1])) });
	await assert.rejects(tts.synthesize({ text: 'Hello.', voiceId: 'cedar' }), { code: 'TTS_MALFORMED_AUDIO' });
	const huge = new OpenAiTtsProvider({ apiKey: 'test-key', fetchImpl: async () => new Response(Buffer.alloc(24_000 * 2 * 60 + 2)) });
	await assert.rejects(huge.synthesize({ text: 'Hello.', voiceId: 'cedar' }), { code: 'TTS_RESPONSE_TOO_LARGE' });
	const stt = new OpenAiSttProvider({ apiKey: 'test-key', fetchImpl: async () => Response.json({ invalid: 'no transcript' }) });
	await assert.rejects(stt.transcribe({ pcm: Buffer.alloc(10) }), { code: 'STT_PROVIDER_RESPONSE' });
	await assert.rejects(stt.transcribe({ pcm: Buffer.alloc(48_000 * 2 * 20 + 2) }), { code: 'STT_MALFORMED_AUDIO' });
});

test('cancelling OpenAI speech cancels the provider request', async () => {
	const controller = new AbortController();
	let entered;
	const started = new Promise(resolve => { entered = resolve; });
	const provider = new OpenAiTtsProvider({ apiKey: 'test-key', fetchImpl: async (_url, { signal }) => {
		entered();
		return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
	} });
	const speech = provider.synthesize({ text: 'Hello.', voiceId: 'cedar', signal: controller.signal });
	await started;
	controller.abort();
	await assert.rejects(speech, { name: 'AbortError' });
});

test('OpenAI speech bootstrap takes precedence over old Fish and Deepgram credentials without loading local models', async () => {
	const tts = new OpenAiTtsProvider({ apiKey: 'test-key' });
	const stt = new OpenAiSttProvider({ apiKey: 'test-key' });
	let started = false;
	let parameters;
	const worker = await startVoiceWorker({ voice: { secret: 'voice-bootstrap-secret', provider: 'openai' } }, {
		OPENAI_API_KEY: 'test-key', FISH_AUDIO_API_KEY: 'old-fish-key', DEEPGRAM_API_KEY: 'old-deepgram-key',
	}, {
		createLocalSpeechProvider: () => { throw new Error('OpenAI must not start local models'); },
		loadProfileStore: async () => ({ store: new VoiceProfileStore() }),
		createOpenAiTtsProvider: options => { assert.equal(options.model, 'gpt-4o-mini-tts'); return tts; },
		createOpenAiSttProvider: options => { assert.equal(options.model, 'gpt-transcribe'); return stt; },
		createVoiceServer: options => { parameters = options; return { async start() { started = true; }, async close() {} }; },
	});
	assert.equal(started, true);
	assert.equal(parameters.provider, tts);
	assert.equal(parameters.sttProvider, stt);
	assert.equal(parameters.fishProvider, undefined);
	// Three times the slowest of ten measured gpt-4o-mini-tts calls (4,114 ms), rounded up to a whole second.
	assert.equal(parameters.interactiveTtsTimeoutMs, 13_000, 'a slow OpenAI line becomes text after 13 s, not the provider\'s 30 s');
	assert.ok(parameters.requestTimeoutMs > parameters.interactiveTtsTimeoutMs, 'so the cutoff counts as a per-line deadline, not an outage');
	assert.equal(parameters.directorUsesPrimaryProvider, true, 'Named voice selections also use OpenAI');
	await worker.close();
});

test('a host voice.interactiveTtsTimeoutMs overrides the default OpenAI speech cutoff', async () => {
	const dependencies = parameters => ({
		loadProfileStore: async () => ({ store: new VoiceProfileStore() }),
		createOpenAiTtsProvider: () => new OpenAiTtsProvider({ apiKey: 'test-key' }),
		createOpenAiSttProvider: () => new OpenAiSttProvider({ apiKey: 'test-key' }),
		createVoiceServer: options => { parameters.push(options); return { async start() {}, async close() {} }; },
	});
	const seen = [];
	const worker = await startVoiceWorker({ voice: { secret: 'voice-bootstrap-secret', provider: 'openai', interactiveTtsTimeoutMs: 4_000 } }, { OPENAI_API_KEY: 'test-key' }, dependencies(seen));
	assert.equal(seen[0].interactiveTtsTimeoutMs, 4_000);
	await worker.close();
	for (const invalid of [0, -1, 1.5, '2000', 600_001]) {
		await assert.rejects(
			startVoiceWorker({ voice: { secret: 'voice-bootstrap-secret', provider: 'openai', interactiveTtsTimeoutMs: invalid } }, { OPENAI_API_KEY: 'test-key' }, dependencies([])),
			/voice\.interactiveTtsTimeoutMs must be between 1 and 600000/);
	}
});

test('explicit OpenAI speech configuration never falls back to Fish when its key is missing', async () => {
	await assert.rejects(startVoiceWorker({ voice: { provider: 'openai' } }, { FISH_AUDIO_API_KEY: 'old-fish-key' }), { code: 'VOICE_OPENAI_KEY_MISSING' });
});

test('signed in-game and named voice requests use OpenAI speech through the real loopback worker', async () => {
	const requests = [];
	const fetchImpl = async (url, options) => {
		requests.push({ url, options });
		return url.endsWith('/speech') ? new Response(Buffer.alloc(2400 * 2)) : Response.json({ text: 'Get iron tools.' });
	};
	const secret = 'openai-loopback-test-secret';
	const agentId = '00000000-0000-4000-8000-000000000001';
	const worker = createVoiceHttpServer({
		provider: new OpenAiTtsProvider({ apiKey: 'test-key', fetchImpl }),
		sttProvider: new OpenAiSttProvider({ apiKey: 'test-key', fetchImpl }),
		directorUsesPrimaryProvider: true, profileStore: new VoiceProfileStore(), secret, port: 0,
	});
	const address = await worker.start();
	async function post(path, body, contentType, identityHeaders = {}) {
		const headers = createVoiceRequestHeaders({ secret, path, body, contentType, identityHeaders });
		return globalThis.fetch(`http://127.0.0.1:${address.port}${path}`, {
			method: 'POST', body, headers: { ...identityHeaders, ...headers, 'Content-Type': contentType },
		});
	}
	try {
		for (const profileId of ['voice.auto.v1', directorVoiceProfiles()[0].profileId]) {
			const body = Buffer.from(JSON.stringify({ agentId, text: 'Tools are ready.', profileId, radius: 48, conversationSequence: 1 }));
			const response = await post('/v1/tts', body, 'application/json');
			assert.equal(response.status, 200, await response.clone().text());
			assert.equal((await response.arrayBuffer()).byteLength, 4800 * 2, '24 kHz API audio is resampled to the 48 kHz game transport');
		}
		assert.equal(requests.length, 2);
		assert.ok(requests.every(({ options }) => JSON.parse(options.body).input === 'Tools are ready.'));
		const identity = { 'X-Player-Id': agentId, 'X-Utterance-Sequence': '7', 'X-Whispering': 'true' };
		const response = await post('/v1/stt', Buffer.alloc(1920), 'audio/l16;rate=48000;channels=1', identity);
		assert.equal(response.status, 200, await response.clone().text());
		assert.deepEqual(await response.json(), { playerId: agentId, utteranceSequence: 7, whispering: true, transcript: 'Get iron tools.', confidence: 0 });
	} finally { await worker.close(); }
});


// A real call (261 characters, speed 0.88) returned 19.19 s and the same line in another voice went past 20 s and was
// discarded after it was paid for. The longest legal line, 280 characters at speed 0.5, is about 34 to 48 s at the
// measured 0.061 to 0.086 s per character; 48 s of audio must reach the game whole.
test('the longest legal OpenAI line at the slowest speed is played whole, not paid for and thrown away', async () => {
	const seconds = 48;
	let speech = 0;
	const fetchImpl = async (url, options) => {
		speech += 1;
		assert.equal(JSON.parse(options.body).speed, 0.5);
		return new Response(Buffer.alloc(24_000 * 2 * seconds, 1));
	};
	const secret = 'openai-long-line-test-secret';
	const worker = createVoiceHttpServer({
		provider: new OpenAiTtsProvider({ apiKey: 'test-key', fetchImpl }),
		directorUsesPrimaryProvider: true, profileStore: new VoiceProfileStore(), secret, port: 0,
	});
	const address = await worker.start();
	try {
		const text = 'a'.repeat(280);
		const body = Buffer.from(JSON.stringify({ agentId: '00000000-0000-4000-8000-000000000002', text, profileId: 'voice.auto.v1', radius: 48, speed: 0.5, tone: 'neutral', conversationSequence: 1 }));
		const headers = createVoiceRequestHeaders({ secret, path: '/v1/tts', body, contentType: 'application/json' });
		const response = await globalThis.fetch(`http://127.0.0.1:${address.port}/v1/tts`, { method: 'POST', body, headers: { ...headers, 'Content-Type': 'application/json' } });
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal((await response.arrayBuffer()).byteLength, 48_000 * 2 * seconds, 'every second of the line reaches the game, none cut off');
		assert.equal(speech, 1);
	} finally { await worker.close(); }
});

test('OpenAI invalid speech-model configuration has a permanent typed cause', async () => {
	for (const status of [404]) {
		const options = { apiKey: 'offline-fake-key', fetchImpl: async () => new Response('private upstream body', { status }) };
		await assert.rejects(new OpenAiTtsProvider(options).synthesize({ text: 'Hello.', voiceId: 'cedar' }), { code: 'TTS_CONFIGURATION_FAILED' });
		await assert.rejects(new OpenAiSttProvider(options).transcribe({ pcm: Buffer.alloc(1920) }), { code: 'STT_CONFIGURATION_FAILED' });
	}
});

const OPENAI_BUILT_IN_VOICES = ['cedar', 'marin', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
// Pinned on purpose: a saved profile must keep this OpenAI voice across releases. Unreviewed by ear.
const EXPECTED_OPENAI_VOICES = {
	'voice.moss.v1': 'nova', 'voice.flint.v1': 'alloy', 'voice.ember.v1': 'ash', 'voice.wren.v1': 'coral',
	'voice.cedar.v1': 'cedar', 'voice.sable.v1': 'nova', 'voice.quill.v1': 'marin', 'voice.rook.v1': 'onyx',
	'voice.juniper.v1': 'verse', 'voice.vale.v1': 'shimmer', 'voice.kestrel.v1': 'fable', 'voice.sol.v1': 'ballad',
	'voice.reed.v1': 'sage', 'voice.nova.v1': 'shimmer', 'voice.ash.v1': 'echo', 'voice.piper.v1': 'echo',
};
const voiceOf = (profile) => openAiVoiceForProfile(profile.voiceId);
function agentIds(seed, count) {
	return Array.from({ length: count }, (_, index) => {
		const hex = createHash('sha256').update(`v7:${seed}:${index}`).digest('hex');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	});
}
async function withTemporaryDirectory(run) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'arena-v7-openai-voices-'));
	try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('OpenAI gives the first thirteen new automatic agents distinct built-in voices from any hash start', async () => {
	for (let seed = 0; seed < 64; seed++) {
		const store = new VoiceProfileStore();
		const voices = agentIds(seed, 13).map((agentId) => voiceOf(store.resolve(agentId)));
		assert.equal(new Set(voices).size, 13, `seed ${seed} repeated a voice: ${voices.join(', ')}`);
	}
	await withTemporaryDirectory(async (directory) => {
		for (let seed = 0; seed < 6; seed++) {
			const owner = await loadPersistentVoiceProfileStore(path.join(directory, `assignments-${seed}.json`));
			try {
				const voices = agentIds(`persistent-${seed}`, 13).map((agentId) => voiceOf(owner.store.resolve(agentId)));
				assert.equal(new Set(voices).size, 13, `persistent seed ${seed} repeated a voice: ${voices.join(', ')}`);
			} finally { await owner.close(); }
		}
	});
	// Saved owners that already share a voice must not make new agents share another one.
	const saved = agentIds('saved-collision', 2);
	const store = new VoiceProfileStore({ [saved[0]]: 'voice.vale.v1', [saved[1]]: 'voice.nova.v1' });
	const voices = agentIds('after-saved-collision', 12).map((agentId) => voiceOf(store.resolve(agentId)));
	assert.equal(new Set([...voices, voiceOf(store.resolve(saved[0]))]).size, 13, voices.join(', '));
});

test('OpenAI voice sharing after thirteen agents is limited to the documented profile pairs', () => {
	const documented = openAiSpeech.OPENAI_SHARED_PROFILE_VOICES;
	assert.ok(documented && typeof documented === 'object', 'the provider documents which profiles share a voice');
	for (let seed = 0; seed < 32; seed++) {
		const store = new VoiceProfileStore();
		const profiles = agentIds(`sixteen-${seed}`, 16).map((agentId) => store.resolve(agentId));
		assert.equal(new Set(profiles.map(({ profileId }) => profileId)).size, 16);
		assert.equal(new Set(profiles.map(voiceOf)).size, 13);
		const holders = {};
		for (const profile of profiles) (holders[voiceOf(profile)] ??= []).push(profile.profileId);
		const shared = Object.fromEntries(Object.entries(holders).filter(([, ids]) => ids.length > 1).map(([voice, ids]) => [voice, ids.sort()]));
		assert.deepEqual(shared, Object.fromEntries(Object.entries(documented).map(([voice, ids]) => [voice, [...ids].sort()])));
	}
});

test('OpenAI maps every catalog profile explicitly and keeps the hash fallback for other legacy references', () => {
	const table = openAiSpeech.OPENAI_PROFILE_VOICES;
	assert.ok(table && typeof table === 'object', 'the provider publishes its explicit profile table');
	for (const profile of [...builtInVoiceProfiles(), ...directorVoiceProfiles()]) {
		assert.ok(Object.hasOwn(table, profile.voiceId), `${profile.profileId} falls back to the hash`);
		assert.ok(OPENAI_BUILT_IN_VOICES.includes(table[profile.voiceId]));
	}
	assert.deepEqual(Object.fromEntries(builtInVoiceProfiles().map((profile) => [profile.profileId, voiceOf(profile)])), EXPECTED_OPENAI_VOICES);
	const legacyHash = (value) => OPENAI_BUILT_IN_VOICES[createHash('sha256').update(value).digest().readUInt32BE(0) % 13];
	for (const legacy of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'not-a-catalog-id', '0123456789abcdef0123456789abcdef']) {
		assert.equal(openAiVoiceForProfile(legacy), legacyHash(legacy), legacy);
	}
	for (const voice of OPENAI_BUILT_IN_VOICES) assert.equal(openAiVoiceForProfile(voice), voice);
	assert.throws(() => openAiVoiceForProfile(' '), TypeError);
});

test('saved automatic assignments reload to the same profiles and the same OpenAI voices', async () => {
	await withTemporaryDirectory(async (directory) => {
		const file = path.join(directory, 'assignments.json');
		const ids = agentIds('reload', 17);
		const assignments = Object.fromEntries(builtInVoiceProfiles().map(({ profileId }, index) => [ids[index], profileId]));
		assignments[ids[16]] = 'voice.kestrel.v1'; // a profile already shared before this change stays shared after reload
		await writeFile(file, `${JSON.stringify({ schemaVersion: 1, assignments }, null, 2)}\n`);
		for (let round = 0; round < 2; round++) {
			const owner = await loadPersistentVoiceProfileStore(file);
			try {
				assert.deepEqual(owner.store.snapshotAssignments(), assignments);
				for (const [agentId, profileId] of Object.entries(assignments)) {
					const profile = owner.store.resolve(agentId);
					assert.equal(profile.profileId, profileId);
					assert.equal(voiceOf(profile), EXPECTED_OPENAI_VOICES[profileId]);
				}
				owner.store.resolve(ids[0]);
				await owner.flush();
			} finally { await owner.close(); }
			assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).assignments, assignments);
		}
	});
});

test('OpenAI voice mapping revision never replays audio cached under the earlier mapping', async () => {
	const legacyNamespace = 'openai/gpt-4o-mini-tts/profiles-v1';
	const cache = new TtsCache();
	const store = new VoiceProfileStore();
	const voices = [];
	const provider = new OpenAiTtsProvider({ apiKey: 'offline-fake-key', fetchImpl: async (_url, options) => {
		voices.push(JSON.parse(options.body).voice);
		return new Response(Buffer.alloc(2400 * 2, voices.length));
	} });
	const legacy = { cacheNamespace: () => legacyNamespace, synthesize: (request) => provider.synthesize(request) };
	const secret = 'openai-voice-mapping-cache-secret';
	const agentId = '00000000-0000-4000-8000-000000000007';
	for (const candidate of [legacy, provider, provider]) {
		const worker = createVoiceHttpServer({ provider: candidate, profileStore: store, cache, secret, port: 0 });
		const address = await worker.start();
		try {
			const path = '/v1/tts';
			const body = Buffer.from(JSON.stringify({ agentId, text: 'Same cached line.', profileId: 'voice.auto.v1', radius: 48, conversationSequence: 1 }));
			const headers = createVoiceRequestHeaders({ secret, path, body, contentType: 'application/json' });
			const response = await globalThis.fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', body, headers: { ...headers, 'Content-Type': 'application/json' } });
			assert.equal(response.status, 200, await response.clone().text());
			await response.arrayBuffer();
		} finally { await worker.close(); }
	}
	assert.equal(voices.length, 2, 'the revised namespace synthesizes once, then serves its own cache entry');
	assert.equal(voices[1], voiceOf(store.resolve(agentId)));
	assert.notEqual(provider.cacheNamespace(), legacyNamespace);
});
