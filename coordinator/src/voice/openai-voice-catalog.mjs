import { createHash } from 'node:crypto';

const VOICES = Object.freeze(['cedar', 'marin', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']);

// One explicit OpenAI voice per catalog reference voice. Speech requests carry the profile's Fish reference, so the
// table is keyed by it; named voices that reuse a reference (Adrian, Sarah, Ethan) follow that profile. Each profile
// kept its earlier hashed voice unless that voice was shared; five moved to the five voices nothing used.
// The voice chosen for each name is unreviewed by ear.
export const OPENAI_PROFILE_VOICES = Object.freeze(Object.assign(Object.create(null), {
	c5f56a6cc2ec4fa8920cb4c5889a3fb7: 'nova', // moss, shared with sable
	d8a1340984ee4b63ad1ffae27a6a4339: 'alloy', // flint
	'933563129e564b19a115bedd57b7406a': 'ash', // ember, Sarah
	'59e9dc1cb20c452584788a2690c80970': 'coral', // wren
	'536d3a5e000945adb7038665781a4aca': 'cedar', // cedar, Ethan
	bf322df2096a46f18c579d0baa36f41d: 'nova', // sable, Adrian; shared with moss
	b545c585f631496c914815291da4e893: 'marin', // quill
	ef9c79b62ef34530bf452c0e50e3c260: 'onyx', // rook
	'9259a7392c454a1eb6436141abb5a558': 'verse', // juniper
	'1936333080804be19655c6749b2ae7b2': 'shimmer', // vale, shared with nova
	'4c6a6762e4ac4bdebdb4fa8525d054a2': 'fable', // kestrel
	f8dfe9c83081432386f143e2fe9767ef: 'ballad', // sol
	'85d6a6c915f545b399b0bfb358244fb9': 'sage', // reed
	a3b3f0a9c49340bd8fa722d83c81cb08: 'shimmer', // nova, shared with vale
	f48d143a59a946ab87c0130fd081f349: 'echo', // ash, shared with piper
	'802e3bc2b27e49c2995d23ef70e6ac89': 'echo', // piper, shared with ash
	e3cd384158934cc9a01029cd7d278634: 'coral', // Laura
	b347db033a6549378b48d00acb0d06cd: 'ballad', // Selene
	'79d0bd3e4e5444b18f7b6d89b5927bf1': 'fable', // Jordan
}));

// Sixteen automatic profiles share thirteen voices. Allocation gives new agents unused voices first, so these
// pairs only share once thirteen agents already hold distinct voices.
export const OPENAI_SHARED_PROFILE_VOICES = Object.freeze({
	nova: Object.freeze(['voice.moss.v1', 'voice.sable.v1']),
	shimmer: Object.freeze(['voice.vale.v1', 'voice.nova.v1']),
	echo: Object.freeze(['voice.ash.v1', 'voice.piper.v1']),
});

/** Stable existing profile IDs map to built-in voices; speech never generates or rewrites the agent's words. */
export function openAiVoiceForProfile(voiceId) {
	if (typeof voiceId !== 'string' || voiceId.trim() === '') throw new TypeError('voiceId must not be blank');
	if (VOICES.includes(voiceId)) return voiceId;
	if (Object.hasOwn(OPENAI_PROFILE_VOICES, voiceId)) return OPENAI_PROFILE_VOICES[voiceId];
	// References outside the catalog keep the earlier hashed voice.
	return VOICES[createHash('sha256').update(voiceId).digest().readUInt32BE(0) % VOICES.length];
}
