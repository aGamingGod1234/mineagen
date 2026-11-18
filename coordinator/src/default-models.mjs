// The one place scripts, benchmarks and the decision-eval harness take their default play and judge models from.
// ARENA_CODEX_MODEL and ARENA_CLAUDE_MODEL change the play default only; judges keep the project default.
// The mod keeps its own copy for `/mineagen summon` with no model (AgentCommands.DEFAULT_MODEL); a test keeps the two equal.
export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
export const DEFAULT_MODELS = Object.freeze({ codex: DEFAULT_CODEX_MODEL, claude: DEFAULT_CLAUDE_MODEL });

const MODEL_ENV = Object.freeze({ codex: 'ARENA_CODEX_MODEL', claude: 'ARENA_CLAUDE_MODEL' });
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * A provider's default model. ARENA_CODEX_MODEL or ARENA_CLAUDE_MODEL overrides it for a whole session, so every
 * script and benchmark of one arm runs (and analyses) the same model without a flag on each command.
 */
export function defaultModel(provider, env = process.env) {
	if (!(provider in DEFAULT_MODELS)) throw new TypeError(`No default model for provider ${provider}`);
	const override = env?.[MODEL_ENV[provider]];
	if (override === undefined || override === '') return DEFAULT_MODELS[provider];
	if (!MODEL_ID.test(override)) throw new TypeError(`${MODEL_ENV[provider]} must be a model id, got ${JSON.stringify(override)}`);
	return override;
}

/**
 * A provider's default judge model. It ignores the session override, so an arm that plays another model is still
 * scored by the same judge as every other arm, and judge scores stay comparable across sessions.
 */
export function defaultJudgeModel(provider) {
	if (!(provider in DEFAULT_MODELS)) throw new TypeError(`No default model for provider ${provider}`);
	return DEFAULT_MODELS[provider];
}
