// Proximity voice: the voice supervisor and the speech worker with its provider fallbacks (moved from dynamic-main.mjs).
import { strictSpendRuntime } from './strict-spend-runtime.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FishTtsProvider } from './voice/fish-tts-provider.mjs';
import { OpenAiTtsProvider, OpenAiSttProvider, DEFAULT_OPENAI_TTS_MODEL, DEFAULT_OPENAI_STT_MODEL } from './voice/openai-speech-provider.mjs';
import { DeepgramSttProvider, NoSttProvider } from './voice/deepgram-stt-provider.mjs';
import { LocalSpeechProvider } from './voice/local-speech-provider.mjs';
import { providerCacheNamespace, tagSynthesisCacheNamespace } from './voice/tts-cache-identity.mjs';
import { createVoiceHttpServer } from './voice/voice-http-server.mjs';
import { VoiceSupervisor } from './voice/voice-supervisor.mjs';
import { loadPersistentVoiceProfileStore, VoiceProfileStore } from './voice/voice-profile-store.mjs';
import { WindowsTtsProvider } from './voice/windows-tts-provider.mjs';
import { codedRuntimeError, DEFAULT_DEEPGRAM_API_KEY_ENVIRONMENT_VARIABLE, DEFAULT_FISH_API_KEY_ENVIRONMENT_VARIABLE, DEFAULT_LOCAL_SPEECH_TIMEOUT_MS, DEFAULT_VOICE_MAX_CONCURRENT, DEFAULT_VOICE_PORT, DEFAULT_VOICE_PROFILE_ASSIGNMENTS_PATH, firstNonBlank, optionalInteractiveTtsTimeoutMs, PROJECT_DIRECTORY, SOURCE_DIRECTORY } from './dynamic-config.mjs';
// Three times the slowest of ten measured gpt-4o-mini-tts calls (4,114 ms, 17 Nov 2026), rounded up to a whole second.
const DEFAULT_OPENAI_INTERACTIVE_TTS_TIMEOUT_MS = 13_000;
const DEFAULT_FISH_FALLBACK_BASE_DELAY_MS = 30_000;
const DEFAULT_FISH_FALLBACK_MAX_DELAY_MS = 300_000;
const VOICE_WARMUP_GRACE_MS = 1_000;
const DEFAULT_LOCAL_SPEECH_PYTHON_DIRECTORY = path.join('runtime', 'local-speech', '.venv');
const STT_ONLY_PROFILE_STORE = Object.freeze({
	resolve() { throw new Error('voice profiles are unavailable without TTS'); },
});
const WINDOWS_TTS_FALLBACK_CODES = new Set([
	'LOCAL_SPEECH_ERROR',
	'LOCAL_SPEECH_UNAVAILABLE',
	'LOCAL_TTS_ERROR',
	'TTS_AUDIO_TOO_LONG',
	'TTS_AUTHENTICATION_FAILED',
	'TTS_MALFORMED_AUDIO',
	'TTS_PROVIDER_ERROR',
	'TTS_RATE_LIMITED',
	'TTS_TIMEOUT',
	'TTS_UNAVAILABLE',
]);

export function createVoiceSupervisor(config, environment = process.env, dependencies = {}) {
	if (strictSpendRuntime(environment)) return { start() {}, close() {}, removeAgent() {} };
	if (config === null || typeof config !== 'object' || Array.isArray(config)) {
		throw new TypeError('voice supervisor config must be an object');
	}
	if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
		throw new TypeError('voice supervisor environment must be an object');
	}
	const localSpeechTimeoutMs = config.voice?.localSpeechTimeoutMs ?? DEFAULT_LOCAL_SPEECH_TIMEOUT_MS;
	if (!Number.isSafeInteger(localSpeechTimeoutMs) || localSpeechTimeoutMs < 1 || localSpeechTimeoutMs > 600_000) {
		throw new TypeError('voice.localSpeechTimeoutMs must be between 1 and 600000');
	}
	const reportVoiceDiagnostic = dependencies.reportVoiceDiagnostic ?? writeVoiceDiagnostic;
	if (typeof reportVoiceDiagnostic !== 'function') throw new TypeError('reportVoiceDiagnostic must be a function');
	const startWorker = dependencies.startWorker
		?? (({ signal }) => startVoiceWorker(config, environment, { signal, reportVoiceDiagnostic }));
	const reportFailure = dependencies.reportFailure ?? (({ failureCode }) => {
		process.stderr.write(`[voice-supervisor] ${failureCode}: proximity speech unavailable; retrying automatically\n`);
	});
	return new VoiceSupervisor({
		startWorker,
		warmupTimeoutMs: Math.min(Number.MAX_SAFE_INTEGER, localSpeechTimeoutMs + VOICE_WARMUP_GRACE_MS),
		onFailure: reportFailure,
		...(dependencies.supervisorOptions ?? {}),
	});
}

export async function startVoiceWorker(config, environment = process.env, dependencies = {}) {
	if (strictSpendRuntime(environment)) throw codedRuntimeError('STRICT_SPEND_AUXILIARY_DISABLED', 'Voice is disabled in strict spend mode');
	if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('voice worker config must be an object');
	if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('voice worker environment must be an object');
	const voice = config.voice ?? {};
	const localSpeechTimeoutMs = voice.localSpeechTimeoutMs ?? DEFAULT_LOCAL_SPEECH_TIMEOUT_MS;
	if (!Number.isSafeInteger(localSpeechTimeoutMs) || localSpeechTimeoutMs < 1 || localSpeechTimeoutMs > 600_000) {
		throw new TypeError('voice.localSpeechTimeoutMs must be between 1 and 600000');
	}
	const signal = dependencies.signal;
	const reportVoiceDiagnostic = dependencies.reportVoiceDiagnostic ?? (() => {});
	if (typeof reportVoiceDiagnostic !== 'function') throw new TypeError('reportVoiceDiagnostic must be a function');
	if (signal !== undefined && (signal === null || typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
		throw new TypeError('voice startup signal must be an AbortSignal');
	}
	throwIfVoiceStartupAborted(signal);
	const fishApiKey = firstNonBlank(
		environment[voice.fishApiKeyEnvironmentVariable ?? DEFAULT_FISH_API_KEY_ENVIRONMENT_VARIABLE],
		environment.FISH_API_KEY,
	);
	const deepgramApiKey = firstNonBlank(
		environment[voice.deepgramApiKeyEnvironmentVariable ?? DEFAULT_DEEPGRAM_API_KEY_ENVIRONMENT_VARIABLE],
	);
	const platform = dependencies.platform ?? process.platform;
	const openaiApiKey = firstNonBlank(environment[voice.openaiApiKeyEnvironmentVariable ?? 'OPENAI_API_KEY']);
	if (voice.provider === 'openai') {
		if (openaiApiKey === null) throw codedRuntimeError('VOICE_OPENAI_KEY_MISSING', 'Set OPENAI_API_KEY on the host and restart Minecraft to enable OpenAI speech');
		return startOpenAiVoiceWorker(voice, openaiApiKey, dependencies, {
			signal, reportVoiceDiagnostic, localSpeechTimeoutMs, interactiveTtsTimeoutMs: optionalInteractiveTtsTimeoutMs(voice.interactiveTtsTimeoutMs),
		});
	}
	const createLocalSpeechProvider = dependencies.createLocalSpeechProvider
		?? ((options) => LocalSpeechProvider.createIfAvailable(options));
	if (typeof createLocalSpeechProvider !== 'function') throw new TypeError('createLocalSpeechProvider must be a function');
	let localSpeechProvider = null;
	let profiles = null;
	let profileStore = null;
	let worker = null;
	try {
		localSpeechProvider = await createLocalSpeechProvider({
			executable: firstNonBlank(environment.ARENA_AGENT_SPEECH_PYTHON, voice.localSpeechPythonPath)
				?? path.resolve(PROJECT_DIRECTORY, defaultLocalSpeechPythonPath(platform)),
			scriptPath: path.join(SOURCE_DIRECTORY, 'voice', 'local-speech-worker.py'),
			timeoutMs: localSpeechTimeoutMs,
			environment,
			signal,
			accessFile: dependencies.localSpeechAccess,
		});
		throwIfVoiceStartupAborted(signal);
		if (localSpeechProvider === null && fishApiKey === null && deepgramApiKey === null && platform !== 'win32') return null;
		const voiceSecret = await resolveVoiceSecret(voice, dependencies.readVoiceSecret ?? readFile, signal);
		throwIfVoiceStartupAborted(signal);
		const createFishTtsProvider = dependencies.createTtsProvider ?? ((options) => new FishTtsProvider(options));
		let fishTtsProvider;
		const createTtsProvider = (options) => fishTtsProvider ??= createFishTtsProvider(options);
		const createWindowsTtsProvider = dependencies.createWindowsTtsProvider ?? ((options) => new WindowsTtsProvider(options));
		const createSttProvider = dependencies.createSttProvider ?? ((options) => new DeepgramSttProvider(options));
		const createServer = dependencies.createVoiceServer ?? createVoiceHttpServer;
		if (typeof createFishTtsProvider !== 'function') throw new TypeError('createTtsProvider must be a function');
		if (typeof createWindowsTtsProvider !== 'function') throw new TypeError('createWindowsTtsProvider must be a function');
		if (typeof createServer !== 'function') throw new TypeError('createVoiceServer must be a function');
		const hasTtsProvider = localSpeechProvider !== null || fishApiKey !== null || platform === 'win32';
		if (hasTtsProvider) {
			const profilePath = dependencies.profilePath
				?? voice.profileAssignmentsPath
				?? path.resolve(PROJECT_DIRECTORY, DEFAULT_VOICE_PROFILE_ASSIGNMENTS_PATH);
			const loadProfileStore = dependencies.loadProfileStore ?? loadPersistentVoiceProfileStore;
			if (typeof loadProfileStore !== 'function') throw new TypeError('loadProfileStore must be a function');
			try {
				profiles = await loadProfileStore(profilePath, { ...(dependencies.voiceProfileIo ?? {}), signal });
			} catch (error) {
				if (!canUseVolatileLocalProfiles({ error, localSpeechProvider, fishApiKey, deepgramApiKey, platform })) throw error;
				profiles = { store: new VoiceProfileStore() };
			}
			throwIfVoiceStartupAborted(signal);
			if (profiles === null || typeof profiles !== 'object' || profiles.store === null || typeof profiles.store?.resolve !== 'function') {
				throw new TypeError('loadProfileStore must return a profile store');
			}
			profileStore = voiceProfileStoreWithLifecycle(profiles);
		} else {
			profileStore = voiceProfileStoreWithLifecycle({ store: STT_ONLY_PROFILE_STORE });
		}
		if (deepgramApiKey !== null && typeof createSttProvider !== 'function') throw new TypeError('createSttProvider must be a function when Deepgram is configured');
		let provider;
		let sttProvider;
		let ownedSpeechProvider = localSpeechProvider;
		if (localSpeechProvider !== null) {
			const fallback = fishApiKey !== null || deepgramApiKey !== null
				? createRemoteFirstSpeechRouting(localSpeechProvider, {
					fishApiKey,
					deepgramApiKey,
					platform,
					createTtsProvider,
					createWindowsTtsProvider,
					createSttProvider,
					fallbackCircuit: voiceFallbackCircuitOptions(dependencies),
				})
				: createLocalSpeechFailover(localSpeechProvider, {
				fishApiKey,
				deepgramApiKey,
				platform,
				createTtsProvider,
				createWindowsTtsProvider,
				createSttProvider,
				fallbackCircuit: voiceFallbackCircuitOptions(dependencies),
				});
			provider = fallback.tts;
			sttProvider = fallback.stt;
			ownedSpeechProvider = fallback;
		} else {
			provider = fishApiKey === null
				? (platform === 'win32' ? createWindowsTtsProvider({}) : null)
				: createTtsProvider({ apiKey: fishApiKey });
			if (fishApiKey !== null && platform === 'win32') {
				provider = ttsProviderWithFallback(provider, createWindowsTtsProvider({}), voiceFallbackCircuitOptions(dependencies));
			}
			sttProvider = deepgramApiKey === null ? new NoSttProvider() : createSttProvider({ apiKey: deepgramApiKey });
		}
		emitVoiceDiagnostic(reportVoiceDiagnostic, fishApiKey === null
			? {
				code: 'VOICE_TTS_REMOTE_UNCONFIGURED',
				effectiveProvider: voiceProviderNamespace(provider, 'tts/unavailable'),
				reason: 'fish_credential_missing',
			}
			: {
				code: 'VOICE_TTS_REMOTE_CONFIGURED',
				effectiveProvider: voiceProviderNamespace(provider, 'fish/s2.1-pro-free'),
				reason: 'fish_credential_configured',
			});
		worker = createServer({
			provider,
			fishProvider: fishApiKey === null ? null : createTtsProvider({ apiKey: fishApiKey }),
			sttProvider,
			profileStore,
			secret: voiceSecret,
			port: voice.port ?? DEFAULT_VOICE_PORT,
			maxConcurrent: voice.maxConcurrent ?? DEFAULT_VOICE_MAX_CONCURRENT,
			requestTimeoutMs: localSpeechTimeoutMs,
			// Only a raw local provider is probed (exactly one remote key is set). Its warmup may be a whole model reload.
			probeTimeoutMs: localSpeechTimeoutMs,
			onDiagnostic: reportVoiceDiagnostic,
		});
		throwIfVoiceStartupAborted(signal);
		if (worker === null || typeof worker !== 'object' || typeof worker.start !== 'function' || typeof worker.close !== 'function') {
			throw new TypeError('createVoiceServer must return a voice worker');
		}
		await worker.start({ signal });
		throwIfVoiceStartupAborted(signal);
		return localSpeechProvider === null ? worker : voiceWorkerWithOwnedProvider(worker, ownedSpeechProvider);
	} catch (error) {
		await settleVoiceBootstrapCleanup(
			[
				() => worker?.close(),
				() => profileStore === null ? closeLoadedVoiceProfiles(profiles) : profileStore.close(),
				() => localSpeechProvider?.close(),
			],
			dependencies.cleanupTimeoutMs ?? 1_000,
		);
		throw error;
	}
}

async function startOpenAiVoiceWorker(voice, apiKey, dependencies, { signal, reportVoiceDiagnostic, localSpeechTimeoutMs, interactiveTtsTimeoutMs }) {
	let profiles = null;
	let profileStore = null;
	let worker = null;
	try {
		const secret = await resolveVoiceSecret(voice, dependencies.readVoiceSecret ?? readFile, signal);
		throwIfVoiceStartupAborted(signal);
		const loadProfiles = dependencies.loadProfileStore ?? loadPersistentVoiceProfileStore;
		profiles = await loadProfiles(dependencies.profilePath ?? voice.profileAssignmentsPath
			?? path.resolve(PROJECT_DIRECTORY, DEFAULT_VOICE_PROFILE_ASSIGNMENTS_PATH), { ...(dependencies.voiceProfileIo ?? {}), signal });
		throwIfVoiceStartupAborted(signal);
		profileStore = voiceProfileStoreWithLifecycle(profiles);
		const provider = (dependencies.createOpenAiTtsProvider ?? (options => new OpenAiTtsProvider(options)))({ apiKey, model: voice.openaiTtsModel ?? DEFAULT_OPENAI_TTS_MODEL });
		const sttProvider = (dependencies.createOpenAiSttProvider ?? (options => new OpenAiSttProvider(options)))({ apiKey, model: voice.openaiSttModel ?? DEFAULT_OPENAI_STT_MODEL });
		worker = (dependencies.createVoiceServer ?? createVoiceHttpServer)({
			provider, sttProvider, profileStore, secret, port: voice.port ?? DEFAULT_VOICE_PORT,
			maxConcurrent: voice.maxConcurrent ?? DEFAULT_VOICE_MAX_CONCURRENT, requestTimeoutMs: localSpeechTimeoutMs,
			interactiveTtsTimeoutMs: interactiveTtsTimeoutMs ?? DEFAULT_OPENAI_INTERACTIVE_TTS_TIMEOUT_MS,
			directorUsesPrimaryProvider: true, onDiagnostic: reportVoiceDiagnostic,
		});
		await worker.start({ signal });
		throwIfVoiceStartupAborted(signal);
		emitVoiceDiagnostic(reportVoiceDiagnostic, { code: 'VOICE_OPENAI_CONFIGURED', effectiveProvider: provider.cacheNamespace(), reason: 'openai_credential_configured' });
		return worker;
	} catch (error) {
		await settleVoiceBootstrapCleanup([
			() => worker?.close(), () => profileStore === null ? closeLoadedVoiceProfiles(profiles) : profileStore.close(),
		], dependencies.cleanupTimeoutMs ?? 1_000);
		throw error;
	}
}

function createRemoteFirstSpeechRouting(localProvider, {
	fishApiKey,
	deepgramApiKey,
	platform,
	createTtsProvider,
	createWindowsTtsProvider,
	createSttProvider,
	fallbackCircuit,
}) {
	const owned = new Set([localProvider]);
	let provider = localProvider;
	let sttProvider = localProvider;
	let localTtsFallback = localProvider;
	if (platform === 'win32') {
		const windows = createWindowsTtsProvider({});
		owned.add(windows);
		localTtsFallback = ttsProviderWithFallback(localProvider, windows, fallbackCircuit);
	}
	if (fishApiKey !== null) {
		const fish = createTtsProvider({ apiKey: fishApiKey });
		owned.add(fish);
		provider = ttsProviderWithFallback(fish, localTtsFallback, fallbackCircuit);
	} else {
		provider = localTtsFallback;
	}
	if (deepgramApiKey !== null) {
		const deepgram = createSttProvider({ apiKey: deepgramApiKey });
		owned.add(deepgram);
		sttProvider = sttProviderWithFallback(deepgram, localProvider);
	}
	const localIsPrimary = fishApiKey === null || deepgramApiKey === null;
	let warmupPromise = null;
	return Object.freeze({
		tts: provider,
		stt: sttProvider,
		warmup({ signal } = {}) {
			if (!localIsPrimary || typeof localProvider.warmup !== 'function') return;
			warmupPromise ??= Promise.resolve(localProvider.warmup({ signal })).catch((error) => {
				if (error?.name === 'AbortError' || signal?.aborted) {
					warmupPromise = null;
					throw error;
				}
				return undefined;
			});
			return warmupPromise;
		},
		async close() {
			await Promise.allSettled([...owned].map((candidate) => candidate?.close?.()));
		},
	});
}

function sttProviderWithFallback(primary, fallback) {
	return Object.freeze({
		async transcribe(request) {
			try {
				return await primary.transcribe(request);
			} catch (error) {
				if (!shouldUseLocalSttFallback(error, request?.signal)) throw error;
				return fallback.transcribe(request);
			}
		},
	});
}

function canUseVolatileLocalProfiles({ error, localSpeechProvider, fishApiKey, deepgramApiKey, platform }) {
	if (localSpeechProvider === null || fishApiKey !== null || deepgramApiKey === null || platform === 'win32') return false;
	if (error instanceof SyntaxError) return true;
	return ['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(error?.code);
}

function voiceProfileStoreWithLifecycle(profiles) {
	const store = profiles.store;
	const flush = profiles.flush ?? store.flush;
	const close = profiles.close ?? store.close;
	if (flush !== undefined && typeof flush !== 'function') throw new TypeError('profile store flush must be a function');
	if (close !== undefined && typeof close !== 'function') throw new TypeError('profile store close must be a function');
	const flushOperation = flush === undefined
		? null
		: flush.bind(typeof profiles.flush === 'function' ? profiles : store);
	const closeOperation = close === undefined
		? null
		: close.bind(typeof profiles.close === 'function' ? profiles : store);
	let closePromise = null;
	return Object.freeze({
		resolve(agentId) { return store.resolve(agentId); },
		...(typeof store.resolveRequested === 'function' ? { resolveRequested: store.resolveRequested.bind(store) } : {}),
		remove(agentId) { return store.remove?.(agentId) ?? false; },
		flush(options) { return flushOperation === null ? Promise.resolve() : flushOperation(options); },
		close() {
			closePromise ??= Promise.resolve().then(() => closeOperation === null ? flushOperation?.() : closeOperation());
			return closePromise;
		},
	});
}

function closeLoadedVoiceProfiles(profiles) {
	if (profiles === null || typeof profiles !== 'object') return undefined;
	if (typeof profiles.close === 'function') return profiles.close();
	if (typeof profiles.store?.close === 'function') return profiles.store.close();
	if (typeof profiles.flush === 'function') return profiles.flush();
	if (typeof profiles.store?.flush === 'function') return profiles.store.flush();
	return undefined;
}

async function settleVoiceBootstrapCleanup(operations, timeoutMs) {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('voice cleanup timeout must be positive');
	const cleanup = Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)));
	let timer;
	await Promise.race([
		cleanup,
		new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
	]);
	clearTimeout(timer);
}

function throwIfVoiceStartupAborted(signal) {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error('Voice startup was cancelled');
	error.name = 'AbortError';
	error.code = 'VOICE_OPERATION_CANCELLED';
	throw error;
}

function voiceWorkerWithOwnedProvider(worker, provider) {
	let closePromise = null;
	return Object.freeze({
		...worker,
		start: worker.start.bind(worker),
		warmup: typeof provider.warmup === 'function'
			? ({ signal } = {}) => provider.warmup({ signal })
			: undefined,
		close() {
			closePromise ??= Promise.allSettled([worker.close(), provider.close()]).then(() => undefined);
			return closePromise;
		},
	});
}

function defaultLocalSpeechPythonPath(platform) {
	return path.join(
		DEFAULT_LOCAL_SPEECH_PYTHON_DIRECTORY,
		platform === 'win32' ? 'Scripts' : 'bin',
		platform === 'win32' ? 'python.exe' : 'python',
	);
}

function createLocalSpeechFailover(localProvider, {
	fishApiKey,
	deepgramApiKey,
	platform,
	createTtsProvider,
	createWindowsTtsProvider,
	createSttProvider,
	fallbackCircuit,
}) {
	let activeTts = localProvider;
	let activeStt = localProvider;
	let fallbackTts = null;
	let fallbackStt = null;
	let localUnavailable = false;
	let ttsTransitionPromise = null;
	let sttTransitionPromise = null;
	let warmupPromise = null;
	let localClosePromise = null;
	const closeLocal = () => {
		localClosePromise ??= Promise.resolve().then(() => localProvider.close?.()).then(() => undefined, () => undefined);
		return localClosePromise;
	};
	const closeLocalIfUnused = () => {
		if (activeTts === localProvider || activeStt === localProvider) return Promise.resolve();
		localUnavailable = true;
		return closeLocal();
	};
	const fallbackTtsFactory = () => {
		if (fallbackTts !== null) return fallbackTts;
		if (fishApiKey !== null) {
			const fish = createTtsProvider({ apiKey: fishApiKey });
			fallbackTts = platform === 'win32'
				? ttsProviderWithFallback(fish, createWindowsTtsProvider({}), fallbackCircuit)
				: fish;
			return fallbackTts;
		}
		if (platform === 'win32') fallbackTts = createWindowsTtsProvider({});
		return fallbackTts;
	};
	const fallbackSttFactory = () => {
		if (fallbackStt !== null) return fallbackStt;
		fallbackStt = deepgramApiKey === null
			? new NoSttProvider()
			: createSttProvider({ apiKey: deepgramApiKey });
		return fallbackStt;
	};
	const switchTtsToFallback = async (error, signal, allowUnavailable = false) => {
		if (!shouldUseLocalTtsFallback(error, signal)) throw error;
		if (fishApiKey === null && platform !== 'win32' && !allowUnavailable) throw error;
		if (activeTts !== localProvider) return;
		ttsTransitionPromise ??= Promise.resolve().then(async () => {
			throwIfVoiceStartupAborted(signal);
			if (activeTts === localProvider) activeTts = fallbackTtsFactory();
			await closeLocalIfUnused();
		}).catch((transitionError) => {
			ttsTransitionPromise = null;
			throw transitionError;
		});
		await ttsTransitionPromise;
	};
	const switchSttToFallback = async (error, signal, allowUnavailable = false) => {
		if (!shouldUseLocalSttFallback(error, signal)) throw error;
		if (deepgramApiKey === null && !allowUnavailable) throw error;
		if (activeStt !== localProvider) return;
		sttTransitionPromise ??= Promise.resolve().then(async () => {
			throwIfVoiceStartupAborted(signal);
			if (activeStt === localProvider) activeStt = fallbackSttFactory();
			await closeLocalIfUnused();
		}).catch((transitionError) => {
			sttTransitionPromise = null;
			throw transitionError;
		});
		await sttTransitionPromise;
	};
	const switchFailedWarmupChannels = async ({ sttReady, ttsReady }, error, signal) => {
		if (error?.name === 'AbortError' || signal?.aborted) throw error;
		const ttsUsable = ttsReady || fishApiKey !== null || platform === 'win32';
		const sttUsable = sttReady || deepgramApiKey !== null;
		if (!ttsReady && !sttReady) {
			if (!ttsUsable && !sttUsable) throw error;
			await closeLocal();
			throwIfVoiceStartupAborted(signal);
			await Promise.all([
				switchTtsToFallback(error, signal, true),
				switchSttToFallback(error, signal, true),
			]);
			return;
		}
		await Promise.all([
			ttsReady ? undefined : switchTtsToFallback(error, signal, true),
			sttReady ? undefined : switchSttToFallback(error, signal, true),
		]);
	};
	return Object.freeze({
		tts: Object.freeze({
			cacheNamespace() {
				if (activeTts === localProvider) return 'local-chatterbox/chatterbox-v1';
				if (activeTts === null) return 'tts/unavailable';
				return providerCacheNamespace(
					activeTts,
					fishApiKey !== null ? 'fish/s2.1-pro-free' : 'windows/system-speech',
				);
			},
			async synthesize(request) {
				if (activeTts !== null) {
					const attemptedProvider = activeTts;
					const attemptedNamespace = attemptedProvider === localProvider
						? 'local-chatterbox/chatterbox-v1'
						: providerCacheNamespace(
							attemptedProvider,
							fishApiKey !== null ? 'fish/s2.1-pro-free' : 'windows/system-speech',
						);
					try {
						return tagSynthesisCacheNamespace(await attemptedProvider.synthesize(request), attemptedNamespace);
					} catch (error) {
						if (attemptedProvider !== localProvider) throw error;
						await switchTtsToFallback(error, request?.signal);
						const fallbackNamespace = providerCacheNamespace(
							activeTts,
							fishApiKey !== null ? 'fish/s2.1-pro-free' : 'windows/system-speech',
						);
						return tagSynthesisCacheNamespace(await activeTts.synthesize(request), fallbackNamespace);
					}
				}
				const error = new Error('Speech synthesis is not configured');
				error.code = 'TTS_UNAVAILABLE';
				throw error;
			},
		}),
		stt: Object.freeze({
			async transcribe(request) {
				const attemptedProvider = activeStt;
				try {
					return await attemptedProvider.transcribe(request);
				} catch (error) {
					if (attemptedProvider !== localProvider) throw error;
					await switchSttToFallback(error, request?.signal);
					return activeStt.transcribe(request);
				}
			},
		}),
		warmup({ signal } = {}) {
			if (localUnavailable || typeof localProvider.warmup !== 'function') return;
			warmupPromise ??= (async () => {
				let readiness;
				try {
					readiness = await localProvider.warmup({ signal });
				} catch (error) {
					await switchFailedWarmupChannels({ sttReady: false, ttsReady: false }, error, signal);
					return;
				}
				if (readiness === undefined) return;
				if (readiness === null || typeof readiness !== 'object'
						|| typeof readiness.sttReady !== 'boolean' || typeof readiness.ttsReady !== 'boolean') {
					throw new TypeError('local speech warmup must return channel readiness');
				}
				if (readiness.sttReady && readiness.ttsReady) return;
				const retryLocalOnlyChannel = (!readiness.sttReady && deepgramApiKey === null)
						|| (!readiness.ttsReady && fishApiKey === null && platform !== 'win32');
				if (retryLocalOnlyChannel && (readiness.sttReady || readiness.ttsReady)) {
					try {
						const retried = await localProvider.warmup({ signal });
						if (retried === null || typeof retried !== 'object'
								|| typeof retried.sttReady !== 'boolean' || typeof retried.ttsReady !== 'boolean') {
							throw new TypeError('local speech warmup must return channel readiness');
						}
						readiness = retried;
					} catch (error) {
						if (error?.name === 'AbortError' || signal?.aborted) throw error;
					}
					if (readiness.sttReady && readiness.ttsReady) return;
				}
				const error = Object.assign(new Error('Local speech warmup did not initialize every channel'), {
					code: 'LOCAL_SPEECH_WARMUP_FAILED',
				});
				await switchFailedWarmupChannels(readiness, error, signal);
			})().catch((error) => {
				warmupPromise = null;
				throw error;
			});
			return warmupPromise;
		},
		async close() {
			await Promise.allSettled([
				closeLocal(),
				fallbackTts?.close?.(),
				fallbackStt?.close?.(),
			]);
		},
	});
}

function shouldUseLocalTtsFallback(error, signal) {
	if (error?.name === 'AbortError' || signal?.aborted) return false;
	if (error instanceof TypeError || error?.code === 'TTS_INVALID_REQUEST') return false;
	return true;
}

function shouldUseLocalSttFallback(error, signal) {
	if (error?.name === 'AbortError' || signal?.aborted) return false;
	if (error instanceof TypeError || ['STT_INVALID_REQUEST', 'STT_MALFORMED_AUDIO'].includes(error?.code)) return false;
	return true;
}

function voiceFallbackCircuitOptions(dependencies) {
	return {
		now: dependencies.voiceFallbackNow ?? Date.now,
		baseDelayMs: dependencies.voiceFallbackBaseDelayMs ?? DEFAULT_FISH_FALLBACK_BASE_DELAY_MS,
		maxDelayMs: dependencies.voiceFallbackMaxDelayMs ?? DEFAULT_FISH_FALLBACK_MAX_DELAY_MS,
		onDiagnostic: dependencies.reportVoiceDiagnostic ?? (() => {}),
	};
}

function ttsProviderWithFallback(primary, fallback, {
	now = Date.now,
	baseDelayMs = DEFAULT_FISH_FALLBACK_BASE_DELAY_MS,
	maxDelayMs = DEFAULT_FISH_FALLBACK_MAX_DELAY_MS,
	onDiagnostic = () => {},
} = {}) {
	if (typeof now !== 'function') throw new TypeError('Fish fallback clock must be a function');
	if (typeof onDiagnostic !== 'function') throw new TypeError('Fish fallback diagnostic reporter must be a function');
	if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1) throw new TypeError('Fish fallback base delay must be positive');
	if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw new TypeError('Fish fallback maximum delay must not be less than its base delay');
	let consecutiveFailures = 0;
	let nextProbeAt = null;
	let probePromise = null;
	const readNow = () => {
		const value = now();
		if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Fish fallback clock must return a non-negative safe integer');
		return value;
	};
	const primaryProvider = voiceProviderNamespace(primary, 'tts/primary');
	const fallbackProvider = voiceProviderNamespace(fallback, 'tts/fallback');
	const recordFailure = (error) => {
		consecutiveFailures = Math.min(consecutiveFailures + 1, 31);
		const exponent = Math.min(consecutiveFailures - 1, 30);
		const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
		nextProbeAt = Math.min(Number.MAX_SAFE_INTEGER, readNow() + delay);
		emitVoiceDiagnostic(onDiagnostic, {
			code: 'VOICE_TTS_FALLBACK_ACTIVATED',
			primaryProvider,
			effectiveProvider: fallbackProvider,
			failureCode: voiceDiagnosticFailureCode(error),
		});
	};
	const synthesizeFallback = async (request) => {
		const output = await fallback.synthesize(request);
		return tagSynthesisCacheNamespace(
			{ ...output, cacheable: false },
			providerCacheNamespace(fallback, 'windows/system-speech'),
		);
	};
	const attemptPrimary = async (request) => {
		const recovering = nextProbeAt !== null;
		try {
			const output = await primary.synthesize(request);
			consecutiveFailures = 0;
			nextProbeAt = null;
			if (recovering) emitVoiceDiagnostic(onDiagnostic, {
				code: 'VOICE_TTS_PRIMARY_RESTORED',
				primaryProvider,
				effectiveProvider: primaryProvider,
			});
			return tagSynthesisCacheNamespace(output, providerCacheNamespace(primary, 'fish/s2.1-pro-free'));
		} catch (error) {
			if (!shouldUseWindowsTtsFallback(error)) throw error;
			recordFailure(error);
			return synthesizeFallback(request);
		}
	};
	return Object.freeze({
		cacheNamespace() {
			return nextProbeAt === null
				? providerCacheNamespace(primary, 'fish/s2.1-pro-free')
				: providerCacheNamespace(fallback, 'windows/system-speech');
		},
		async synthesize(request) {
			if (nextProbeAt === null) return attemptPrimary(request);
			if (probePromise !== null || readNow() < nextProbeAt) return synthesizeFallback(request);
			probePromise = attemptPrimary(request).finally(() => { probePromise = null; });
			return probePromise;
		},
	});
}

function voiceProviderNamespace(provider, fallback) {
	try {
		const namespace = providerCacheNamespace(provider, fallback);
		return /^[a-z0-9][a-z0-9._/-]{0,127}$/.test(namespace) ? namespace : 'tts/unspecified';
	} catch {
		return 'tts/unspecified';
	}
}

function voiceDiagnosticFailureCode(error) {
	const value = error?.code;
	return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'TTS_PROVIDER_ERROR';
}

function emitVoiceDiagnostic(reporter, event) {
	try { reporter(Object.freeze({ ...event })); }
	catch { /* voice diagnostics are observational */ }
}

function writeVoiceDiagnostic(event) {
	const fields = Object.entries(event)
		.filter(([key]) => key !== 'code')
		.map(([key, value]) => `${key}=${value}`)
		.join(' ');
	process.stderr.write(`[voice] ${event.code}${fields === '' ? '' : ` ${fields}`}\n`);
}

function shouldUseWindowsTtsFallback(error) {
	if (error?.name === 'AbortError') return false;
	return error?.name === 'TimeoutError' || WINDOWS_TTS_FALLBACK_CODES.has(error?.code);
}

async function resolveVoiceSecret(voice, readSecretFile, signal) {
	throwIfVoiceStartupAborted(signal);
	let secret = firstNonBlank(voice.secret);
	if (secret === null) {
		if (typeof readSecretFile !== 'function') throw new TypeError('readVoiceSecret must be a function');
		let onAbort;
		try {
			const read = Promise.resolve().then(() => readSecretFile(voice.secretFile, { encoding: 'utf8', signal }));
			const aborted = new Promise((_, reject) => {
				onAbort = () => { try { throwIfVoiceStartupAborted(signal); } catch (error) { reject(error); } };
				signal?.addEventListener('abort', onAbort, { once: true });
				if (signal?.aborted) onAbort();
			});
			secret = firstNonBlank(await Promise.race([read, aborted]));
		} catch (error) {
			throwIfVoiceStartupAborted(signal);
			throw codedRuntimeError('VOICE_SECRET_UNAVAILABLE', 'Dedicated voice authentication secret is unavailable', error);
		} finally {
			if (onAbort) signal?.removeEventListener('abort', onAbort);
		}
	}
	if (secret !== null) secret = secret.trim();
	if (secret === null || secret.length < 16 || secret.length > 512) {
		throw codedRuntimeError('VOICE_SECRET_INVALID', 'Dedicated voice authentication secret must contain 16 to 512 characters');
	}
	return secret;
}
