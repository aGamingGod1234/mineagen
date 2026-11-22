// Coordinator config: CLI arguments, config loading and normalization, and the shared config defaults (moved from dynamic-main.mjs).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_AGENT_CAP, DEFAULT_GOAL_QUEUE_CAP, DEFAULT_PLANNING_CONCURRENCY } from './constants.mjs';
import { DEFAULT_OPENAI_TTS_MODEL, DEFAULT_OPENAI_STT_MODEL } from './voice/openai-speech-provider.mjs';

export const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR_DIRECTORY = path.resolve(SOURCE_DIRECTORY, '..');
export const PROJECT_DIRECTORY = path.resolve(COORDINATOR_DIRECTORY, '..');
const DEFAULT_DYNAMIC_CONFIG_PATH = path.join(COORDINATOR_DIRECTORY, 'config', 'dynamic-agents.json');
const DEFAULT_INVALID_DECISION_RETRIES = 1;
export const DEFAULT_VOICE_PORT = 8_766;
export const DEFAULT_VOICE_MAX_CONCURRENT = 5;
export const DEFAULT_VOICE_PROFILE_ASSIGNMENTS_PATH = path.join('runtime', 'voice-profile-assignments.json');
const DEFAULT_VOICE_SECRET_PATH = path.join('runtime', 'voice-secret.txt');
export const DEFAULT_LOCAL_SPEECH_TIMEOUT_MS = 120_000;
export const DEFAULT_FISH_API_KEY_ENVIRONMENT_VARIABLE = 'FISH_AUDIO_API_KEY';
export const DEFAULT_DEEPGRAM_API_KEY_ENVIRONMENT_VARIABLE = 'DEEPGRAM_API_KEY';

export function parseDynamicCliArguments(args) {
	if (!Array.isArray(args)) throw new TypeError('CLI arguments must be an array');
	if (args.length === 0) return { configPath: DEFAULT_DYNAMIC_CONFIG_PATH };
	if (args.length !== 2 || args[0] !== '--config') throw new Error('Usage: node coordinator/src/dynamic-main.mjs [--config <absolute-path>]');
	if (!path.isAbsolute(args[1])) throw new Error('--config must be an absolute path');
	return { configPath: args[1] };
}

export function resolveDynamicCliRuntime(environment = process.env) {
	if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('runtime environment must be an object');
	const tracePath = environment.ARENA_HEADLESS_TRACE_PATH ?? path.join(PROJECT_DIRECTORY, 'runtime', 'traces', 'coordinator.jsonl');
	const separator = tracePath.includes('\\') ? '\\' : '/';
	const traceDirectory = tracePath.slice(0, Math.max(0, tracePath.lastIndexOf(separator)));
	return {
		tracePath,
		decisionLogDirectory: traceDirectory || '.',
		decisionLogEnabled: environment.ARENA_DECISION_LOG !== '0',
		diagnosticTracePath: environment.ARENA_HEADLESS_PRIVATE_TRACE_PATH ?? `${traceDirectory}${separator}coordinator-private.jsonl`,
		protocolAuditPath: environment.ARENA_PROTOCOL_AUDIT_PATH ?? null,
		providerTurnsPath: environment.ARENA_PROVIDER_TURNS_PATH ?? null,
		runtimeGeneration: /^[0-9a-f]{64}$/.test(environment.ARENA_AGENT_COORDINATOR_RUNTIME_GENERATION ?? '')
			? environment.ARENA_AGENT_COORDINATOR_RUNTIME_GENERATION
			: null,
		runId: environment.ARENA_HEADLESS_RUN_ID ?? 'dynamic-run',
		scenarioId: environment.ARENA_HEADLESS_SCENARIO_ID ?? 'dynamic',
	};
}

export async function loadDynamicConfig(configPath = DEFAULT_DYNAMIC_CONFIG_PATH) {
	const document = JSON.parse(await readFile(configPath, 'utf8'));
	return normalizeDynamicConfig(document, process.env);
}

export function normalizeDynamicConfig(value, environment = process.env) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('dynamic coordinator config must be an object');
	value = migrateDynamicConfig(value);
	assertKnownConfigKeys(value, ['schemaVersion', 'bridge', 'voice', 'codex', 'claude', 'limits', 'workspaceRoot', 'minecraftAgentRoot', 'minecraftAgentTemplateRoot'], 'config');
	if (value.bridge === null || typeof value.bridge !== 'object' || Array.isArray(value.bridge)) throw new TypeError('dynamic coordinator bridge config must be an object');
	if (value.codex === null || typeof value.codex !== 'object' || Array.isArray(value.codex)) throw new TypeError('dynamic coordinator Codex config must be an object');
	if (value.voice !== undefined && (value.voice === null || typeof value.voice !== 'object' || Array.isArray(value.voice))) throw new TypeError('dynamic coordinator voice config must be an object');
	assertOptionalConfigObject(value.limits, 'limits');
	assertOptionalConfigObject(value.claude, 'claude');
	assertKnownConfigKeys(value.bridge, ['host', 'port', 'secret', 'secretEnvironmentVariable', 'reconnectDelayMs', 'maxReconnectDelayMs', 'connectionQueueCap', 'agentQueueCap', 'inboundConnectionQueueCap', 'inboundAgentQueueCap', 'inboundDispatchBatch', 'trackedTerminalActionIdCap', 'handshakeTimeoutMs', 'heartbeatIntervalMs', 'heartbeatTimeoutMs', 'serverInstanceId', 'launchId'], 'bridge');
	assertKnownConfigKeys(value.voice ?? {}, ['port', 'maxConcurrent', 'profileAssignmentsPath', 'provider', 'openaiApiKeyEnvironmentVariable', 'openaiTtsModel', 'openaiSttModel', 'fishApiKeyEnvironmentVariable', 'deepgramApiKeyEnvironmentVariable', 'localSpeechTimeoutMs', 'interactiveTtsTimeoutMs', 'localSpeechPythonPath', 'secret', 'secretFile'], 'voice');
	assertKnownConfigKeys(value.codex, ['cwd', 'controlProtocol', 'planningTimeoutMs', 'maxDecisionBytes', 'catalogTtlMs', 'startupTimeoutMs', 'serviceTier', 'launchProfile', 'contextRotationTokens', 'midTurnContextRotationTokens'], 'codex');
	if (value.codex.launchProfile !== undefined) {
		assertOptionalConfigObject(value.codex.launchProfile, 'codex.launchProfile');
		assertKnownConfigKeys(value.codex.launchProfile, ['agentId', 'model', 'reasoningEffort', 'serviceTier', 'planningTimeoutMs', 'maxDecisionBytes', 'cwd'], 'codex.launchProfile');
	}
	assertKnownConfigKeys(value.claude ?? {}, ['provider', 'cwd', 'executable', 'models', 'reasoningEfforts', 'planningTimeoutMs', 'startupTimeoutMs', 'interruptTimeoutMs', 'maxDecisionBytes', 'stdoutLimitBytes', 'stderrLimitBytes', 'runtimeRoot', 'fastMode'], 'claude');
	assertKnownConfigKeys(value.limits ?? {}, ['agentCap', 'goalQueueCap', 'planningConcurrency', 'planningMode', 'urgentReserve', 'invalidDecisionRetries'], 'limits');
	const secret = value.bridge.secret ?? environment[value.bridge.secretEnvironmentVariable ?? 'ARENA_AGENT_BRIDGE_SECRET'];
	const cwd = value.codex.cwd ?? PROJECT_DIRECTORY;
	const workspaceRoot = value.workspaceRoot === undefined
		? path.join(PROJECT_DIRECTORY, 'runtime', 'agent-workspaces')
		: path.resolve(PROJECT_DIRECTORY, value.workspaceRoot);
	const minecraftAgentRoot = value.minecraftAgentRoot === undefined
		? path.join(PROJECT_DIRECTORY, 'runtime', 'minecraft-agent')
		: path.resolve(PROJECT_DIRECTORY, value.minecraftAgentRoot);
	const agentCap = positiveInteger(value.limits?.agentCap ?? DEFAULT_AGENT_CAP, 'limits.agentCap');
	const planningConcurrency = positiveInteger(value.limits?.planningConcurrency ?? DEFAULT_PLANNING_CONCURRENCY, 'limits.planningConcurrency');
	const planningMode = value.limits?.planningMode ?? 'fixed';
	if (planningMode !== 'fixed' && planningMode !== 'adaptive') throw new TypeError("limits.planningMode must be 'fixed' or 'adaptive'");
	if (agentCap > 16) throw new TypeError('limits.agentCap must not exceed 16');
	if (planningMode === 'adaptive' && (agentCap < 4 || planningConcurrency < 4 || planningConcurrency > 16 || planningConcurrency > agentCap)) {
		throw new TypeError('adaptive planningConcurrency and agentCap must be in [4, 16]');
	}
	if (planningConcurrency > agentCap) throw new TypeError('limits.planningConcurrency must not exceed limits.agentCap');
	const urgentReserve = value.limits?.urgentReserve ?? (agentCap >= 4 && planningConcurrency > 1 ? 1 : 0);
	if (!Number.isSafeInteger(urgentReserve) || urgentReserve < 0 || urgentReserve > agentCap) throw new TypeError('limits.urgentReserve must be a non-negative safe integer within limits.agentCap');
	if (urgentReserve >= (planningMode === 'adaptive' ? 4 : planningConcurrency)) throw new TypeError('limits.urgentReserve must leave at least one ordinary planning slot at every target');
	const voice = normalizeVoiceConfig(value.voice, environment);
	const codexControlProtocol = value.codex.controlProtocol ?? 'native_tools';
	if (!['arena_script', 'native_tools'].includes(codexControlProtocol)) throw new TypeError('codex.controlProtocol must be arena_script or native_tools');
	return {
		schemaVersion: 1,
		bridge: { ...value.bridge, secret },
		workspaceRoot,
		minecraftAgentRoot,
		minecraftAgentTemplateRoot: path.join(COORDINATOR_DIRECTORY, 'config', 'minecraft-agent'),
		voice,
		codex: {
			...value.codex,
			cwd,
			controlProtocol: codexControlProtocol,
			launchProfile: value.codex.launchProfile === undefined ? undefined : { ...value.codex.launchProfile, cwd },
		},
		claude: {
			provider: 'claude',
			cwd,
			// Claude agents share Codex's dedicated Minecraft workspace; only their launch prompt files live here.
			runtimeRoot: path.join(minecraftAgentRoot, 'claude'),
			...(value.claude ?? {}),
		},
		limits: {
			agentCap,
			goalQueueCap: positiveInteger(value.limits?.goalQueueCap ?? DEFAULT_GOAL_QUEUE_CAP, 'limits.goalQueueCap'),
			planningConcurrency,
			planningMode,
			urgentReserve,
			invalidDecisionRetries: nonNegativeInteger(value.limits?.invalidDecisionRetries ?? DEFAULT_INVALID_DECISION_RETRIES, 'limits.invalidDecisionRetries'),
		},
	};
}

function migrateDynamicConfig(value) {
	const schemaVersion = value.schemaVersion ?? 0;
	if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) throw new TypeError('config.schemaVersion must be a nonnegative safe integer');
	if (schemaVersion > 1) throw new TypeError(`Unsupported dynamic coordinator config schemaVersion ${schemaVersion}`);
	// Installed configs may still carry retired provider, agent-group and skit sections.
	const { kimi: _retiredKimi, cursor: _retiredCursor, gemini: _retiredGemini, opencode: _retiredOpenCode, groups: _retiredGroups, skit: _retiredSkit, director: _retiredDirector, ...current } = value;
	return { ...current, schemaVersion: 1 };
}

function assertOptionalConfigObject(value, field) {
	if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
		throw new TypeError(`dynamic coordinator ${field} config must be an object`);
	}
}

function assertKnownConfigKeys(value, allowed, field) {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new TypeError(`Unknown dynamic coordinator config key '${field}.${key}'`);
	}
}

function normalizeVoiceConfig(value, environment) {
	const source = value ?? {};
	const configuredPort = environment.ARENA_AGENT_VOICE_PORT === undefined
		? source.port ?? DEFAULT_VOICE_PORT
		: Number(environment.ARENA_AGENT_VOICE_PORT);
	if (!Number.isSafeInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) throw new TypeError('voice.port must be an integer between 1 and 65535');
	const maxConcurrent = positiveInteger(source.maxConcurrent ?? DEFAULT_VOICE_MAX_CONCURRENT, 'voice.maxConcurrent');
	if (maxConcurrent > 5) throw new TypeError('voice.maxConcurrent must not exceed 5');
	const profileAssignmentsPath = path.resolve(PROJECT_DIRECTORY, source.profileAssignmentsPath ?? DEFAULT_VOICE_PROFILE_ASSIGNMENTS_PATH);
	const localSpeechTimeoutMs = positiveInteger(source.localSpeechTimeoutMs ?? DEFAULT_LOCAL_SPEECH_TIMEOUT_MS, 'voice.localSpeechTimeoutMs');
	if (localSpeechTimeoutMs > 600_000) throw new TypeError('voice.localSpeechTimeoutMs must not exceed 600000');
	optionalInteractiveTtsTimeoutMs(source.interactiveTtsTimeoutMs);
	const secret = firstNonBlank(source.secret, environment.ARENA_AGENT_VOICE_SECRET);
	const configuredSecretFile = firstNonBlank(source.secretFile, environment.ARENA_AGENT_VOICE_SECRET_FILE);
	return {
		...source,
		secret,
		secretFile: path.resolve(PROJECT_DIRECTORY, configuredSecretFile ?? DEFAULT_VOICE_SECRET_PATH),
		port: configuredPort,
		maxConcurrent,
		profileAssignmentsPath,
		localSpeechTimeoutMs,
		provider: requireSpeechProvider(source.provider ?? 'legacy'),
		openaiApiKeyEnvironmentVariable: requireEnvironmentVariableName(source.openaiApiKeyEnvironmentVariable ?? 'OPENAI_API_KEY', 'voice.openaiApiKeyEnvironmentVariable'),
		openaiTtsModel: source.openaiTtsModel ?? DEFAULT_OPENAI_TTS_MODEL,
		openaiSttModel: source.openaiSttModel ?? DEFAULT_OPENAI_STT_MODEL,
		fishApiKeyEnvironmentVariable: requireEnvironmentVariableName(source.fishApiKeyEnvironmentVariable ?? DEFAULT_FISH_API_KEY_ENVIRONMENT_VARIABLE, 'voice.fishApiKeyEnvironmentVariable'),
		deepgramApiKeyEnvironmentVariable: requireEnvironmentVariableName(source.deepgramApiKeyEnvironmentVariable ?? DEFAULT_DEEPGRAM_API_KEY_ENVIRONMENT_VARIABLE, 'voice.deepgramApiKeyEnvironmentVariable'),
	};
}

export function optionalInteractiveTtsTimeoutMs(value) {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 600_000)) {
		throw new TypeError('voice.interactiveTtsTimeoutMs must be between 1 and 600000');
	}
	return value;
}

function requireSpeechProvider(value) {
	if (!['openai', 'legacy'].includes(value)) throw new TypeError('voice.provider must be openai or legacy');
	return value;
}

export function firstNonBlank(...values) {
	for (const value of values) if (typeof value === 'string' && value.trim() !== '') return value;
	return null;
}

function requireEnvironmentVariableName(value, field) {
	if (typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(value)) throw new TypeError(`${field} must be an environment variable name`);
	return value;
}

export function positiveInteger(value, field) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
	return value;
}

function nonNegativeInteger(value, field) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
	return value;
}

export function codedRuntimeError(code, message, cause = undefined) {
	return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}
