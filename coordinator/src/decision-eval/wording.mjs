/**
 * Wake wording variants for decision evals: a test of whether the way a wake is worded pushes the model to carry on
 * with its running step. A variant rewrites the production wake (first line and the step lines of its data) after the
 * build rendered it and before it is encoded and sent; the facts are untouched. "production" sends the build's own
 * wording. Variants are an experiment of the harness, not production behaviour.
 */

const CHOOSE_LINE = 'Before any tool call, say in one line what a skilled Minecraft player would do right now and why; carrying on '
	+ 'with the current step is one option, not the default. Then make the tool call for it.';

const FRESH_QUESTION = 'Fresh look: what would a skilled Minecraft player do right now? Carrying on with the current step is one '
	+ 'option, not the default; whatever is in view now (caves, ore, lava, threats, food, a failed route) may call for something else. '
	+ 'Pick the move a player would make next.';

// Production phrases that tell the model to keep its step; the fresh variants drop them and keep the facts around them.
const CARRY_ON_PHRASES = [
	/^Update; act on fresh facts\.\s*/,
	/Keep the existing goal; choose its next unmet step from these fresh facts\.\s*/g,
	/Make progress now;\s*(?=no )/g,
];

function freshInstruction(line) {
	let rest = line;
	for (const phrase of CARRY_ON_PHRASES) rest = rest.replace(phrase, '');
	rest = rest.trim();
	return rest ? `${FRESH_QUESTION} What just happened: ${rest}` : FRESH_QUESTION;
}

function asOption(data) {
	if (typeof data.doing === 'string') data.doing = data.doing.replace(/^Doing: /, 'Current step (one option, you may switch): ');
	if (typeof data.now?.route === 'string') data.now.route = data.now.route.replace(/^usual next step: /, 'one usual next step: ');
}

/** name -> (instruction line, parsed wake JSON) -> [line, JSON] */
export const WAKE_WORDINGS = Object.freeze({
	production: null,
	// The first line asks the player question; the step lines are unchanged.
	'fresh-question': (line, wake) => [freshInstruction(line), wake],
	// The player question plus the running step and route hint shown as one option among others.
	fresh: (line, wake) => { asOption(wake?.data && typeof wake.data === 'object' ? wake.data : wake); return [freshInstruction(line), wake]; },
});

export function checkWording(wording) {
	if (wording === 'choose') return;
	if (!Object.hasOwn(WAKE_WORDINGS, wording)) throw new TypeError(`unknown wake wording ${wording}; one of ${[...Object.keys(WAKE_WORDINGS), 'choose'].join(', ')}`);
}

/** Applies a wording variant to a rendered wake input ("<instruction>\n<json>"); production returns it unchanged. */
export function applyWording(input, wording = 'production') {
	checkWording(wording);
	// choose: the wake unchanged, ending with one line asking for the player's move before the tool call.
	if (wording === 'choose') return input.includes('\n{') ? `${input}\n\n${CHOOSE_LINE}` : input;
	const variant = WAKE_WORDINGS[wording];
	if (variant === null) return input;
	// The facts start at the first line that opens a JSON object; any text lines before it are the instruction.
	const split = input.indexOf('\n{');
	if (split < 0) return freshInstruction(input);
	let wake;
	try { wake = JSON.parse(input.slice(split + 1)); } catch { return `${freshInstruction(input.slice(0, split))}${input.slice(split)}`; }
	const [line, next] = variant(input.slice(0, split), wake);
	return `${line}\n${JSON.stringify(next)}`;
}
