// The room lines room-batch.mjs --player model plays: for every chosen AI room and repeat, one line for the ai arm
// (run-ai-room.mjs: the real model through the production coordinator) and, unless left out, one for the script arm
// (the room's aiRoom.standIn: the practice room where a script plays the model's part). Both arms run the same jar.
// The Codex sign-in travels as CODEX_AUTH_FILE, an absolute path, so room-batch copies the file to each machine as a
// batch input and points the line at the copy; run-ai-room.mjs moves it into a private CODEX_HOME for that run only.
// With several sign-ins (several accounts), the AI lines take them in turn, room by room, so the model calls of a
// batch spread evenly across the accounts.
// The script arm runs its stand-in through ai-room-standin.mjs, which leaves the fixture alone and adds the finishRun rows
// the batch merges when the fixture writes only its own report. Every word of a generated line is quoted the way
// parseCommands reads it, so paths with spaces or quotes stay one word.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { splitWords } from './room-batch-core.mjs';

export const AI_ARM = 'ai';
export const SCRIPT_ARM = 'script';

/** One word for a room line: bare when it is plain, else double-quoted with \ and " escaped (splitWords' rules). */
export const quoteWord = word => /^[A-Za-z0-9_@%+=:,./$-]+$/.test(String(word)) ? String(word) : `"${String(word).replace(/["\\]/g, '\\$&')}"`;
const envWord = (key, value) => `${key}=${quoteWord(value)}`;

/** The stand-in line rewritten to run through ai-room-standin.mjs: its env first, then the wrapper, $OUT and the fixture. */
export function standInCommand(standIn) {
	const words = splitWords(standIn), env = [];
	while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) env.push(words.shift());
	if (words[0] !== 'node' || words.length < 2 || !words.includes('$OUT')) throw new Error(`a stand-in is "ENV... node FIXTURE ... $OUT ...": ${standIn}`);
	return [...env.map(word => { const at = word.indexOf('='); return envWord(word.slice(0, at), word.slice(at + 1)); }), 'node', 'scripts/quality/ai-room-standin.mjs', '$OUT', ...words.slice(1).map(quoteWord)].join(' ');
}

/** Picks rooms by id or name; every name must match exactly one room. */
export function selectAiRooms(scenarios, select) {
	if (!select) return scenarios;
	return String(select).split(',').map(item => item.trim()).filter(Boolean).map(item => {
		const room = scenarios.find(s => s.id === item || s.name === item);
		if (!room) throw new Error(`no AI room ${item} (rooms: ${scenarios.map(s => s.name).join(', ')})`);
		return room;
	});
}

/**
 * The batch's room lines. roomsPath is how the machine finds the rooms file: a repository path, or an absolute local
 * path (copied there as an input). Each room plays its own durationBudgetMs as its time cap.
 */
export function aiRoomCommands({ scenarios, roomsPath, repeats = 1, script = true, authFile = null, authFiles = authFile ? [authFile] : [], model = null }) {
	if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats wants 1 to 20');
	if (!authFiles.length) throw new Error('--player model needs the Codex sign-in file: --codex-auth FILE[,FILE] or ROOM_BATCH_CODEX_AUTH');
	let turn = 0;
	const lines = [`# AI rooms from ${roomsPath}: ${scenarios.length} rooms x ${repeats} repeats, arms ${script ? `${AI_ARM} (model) and ${SCRIPT_ARM} (script stand-in)` : `${AI_ARM} (model)`}, 20 ticks per second`];
	for (const room of scenarios) {
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(room.name ?? '')) throw new Error(`AI room ${room.id} needs a lowercase name`);
		if (script && !room.aiRoom?.standIn) throw new Error(`AI room ${room.name} has no aiRoom.standIn (or pass --no-script)`);
		if (script && /FIXTURE_TICK_RATE=/.test(room.aiRoom.standIn)) throw new Error(`AI room ${room.name}: the stand-in must play at 20 ticks per second too`);
		for (let r = 1; r <= repeats; r++) {
			const name = `${room.name}-r${r}`;
			const ai = ['node', 'scripts/quality/run-ai-room.mjs', roomsPath, room.id, '$OUT', '$JAR', ...(model ? ['--model', model] : []), '--descriptive'].map(quoteWord);
			lines.push(`@${name}:${AI_ARM} ${envWord('CODEX_AUTH_FILE', authFiles[turn++ % authFiles.length])} ${ai.join(' ')}`);
			if (script) lines.push(`@${name}:${SCRIPT_ARM} ${standInCommand(room.aiRoom.standIn)}`);
		}
	}
	return lines.join('\n') + '\n';
}

/**
 * The first fetched AI room whose Codex sign-in was refreshed, or null. room-batch polls this while a model batch runs
 * and stops the batch on a hit: a refresh rotates the token, and every other copy of the sign-in may be signed out.
 */
export async function findRefreshedSignIn(roomsDir) {
	for (const room of (await readdir(roomsDir).catch(() => [])).filter(name => !name.startsWith('.')).sort()) {
		const rows = await readFile(path.join(roomsDir, room, AI_ARM, 'result.json'), 'utf8').then(JSON.parse, () => null);
		if (Array.isArray(rows) && rows.some(row => row?.signInRefreshed === true)) return room;
	}
	return null;
}
