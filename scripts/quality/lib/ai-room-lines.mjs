// The room lines room-batch.mjs --player model plays: for every chosen AI room and repeat, one line for the ai arm
// (run-ai-room.mjs: the real model through the production coordinator) and, unless left out, one for the script arm
// (the room's aiRoom.standIn: the practice room where a script plays the model's part). Both arms run the same jar.
// The Codex sign-in travels as CODEX_AUTH_FILE, an absolute path, so room-batch copies the file to each machine as a
// batch input and points the line at the copy; run-ai-room.mjs moves it into a private CODEX_HOME for that run only.

export const AI_ARM = 'ai';
export const SCRIPT_ARM = 'script';

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
export function aiRoomCommands({ scenarios, roomsPath, repeats = 1, script = true, authFile, model = null }) {
	if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats wants 1 to 20');
	if (!authFile) throw new Error('--player model needs the Codex sign-in file: --codex-auth FILE or ROOM_BATCH_CODEX_AUTH');
	const lines = [`# AI rooms from ${roomsPath}: ${scenarios.length} rooms x ${repeats} repeats, arms ${script ? `${AI_ARM} (model) and ${SCRIPT_ARM} (script stand-in)` : `${AI_ARM} (model)`}, 20 ticks per second`];
	for (const room of scenarios) {
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(room.name ?? '')) throw new Error(`AI room ${room.id} needs a lowercase name`);
		if (script && !room.aiRoom?.standIn) throw new Error(`AI room ${room.name} has no aiRoom.standIn (or pass --no-script)`);
		if (script && /FIXTURE_TICK_RATE=/.test(room.aiRoom.standIn)) throw new Error(`AI room ${room.name}: the stand-in must play at 20 ticks per second too`);
		for (let r = 1; r <= repeats; r++) {
			const name = `${room.name}-r${r}`;
			lines.push(`@${name}:${AI_ARM} CODEX_AUTH_FILE=${authFile} node scripts/quality/run-ai-room.mjs ${roomsPath} ${room.id} $OUT $JAR${model ? ` --model ${model}` : ''} --descriptive`);
			if (script) lines.push(`@${name}:${SCRIPT_ARM} ${room.aiRoom.standIn}`);
		}
	}
	return lines.join('\n') + '\n';
}
