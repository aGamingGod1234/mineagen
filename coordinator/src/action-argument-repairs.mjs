import { MAX_DURATION_MS } from './constants.mjs';

const STAIRCASE_NAMES = new Set(['staircase', 'stairs', 'staircase_down', 'stair_down', 'stairs_downward']);
// A staircase with no direction: dig_to with no pattern climbs when its y is above the feet, else goes down.
const EITHER_WAY = new Set(['staircase', 'stairs']);
// Minecraft yaw: 0 faces south, 90 west, 180 north, -90 east.
const YAW_HEADINGS = ['south', 'west', 'north', 'east'];

/** Repairs change neither the target nor the action; the caller must show the returned notes. */
export function repairActionArguments(type, input) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) return { arguments: input };
	const miningDefault = type === 'break_block' && input.timeoutMs === undefined;
	const extraMoveTimeout = type === 'move_to' && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 1 && input.timeoutMs <= MAX_DURATION_MS;
	const staircaseName = type === 'dig_to' && typeof input.pattern === 'string' && STAIRCASE_NAMES.has(input.pattern.toLowerCase());
	const yawHeading = type === 'dig_to' && typeof input.heading === 'number' && Number.isFinite(input.heading);
	if (!miningDefault && !extraMoveTimeout && !staircaseName && !yawHeading) return { arguments: input };
	const args = Object.assign(Object.create(null), input), adjusted = {};
	if (miningDefault) {
		args.timeoutMs = 15_000;
		adjusted.timeoutMs = '15000 (default for break_block)';
	}
	if (extraMoveTimeout) {
		delete args.timeoutMs;
		adjusted.timeoutMs = 'ignored (move_to has no timeoutMs; use navigate_to for an action timeout, or the program deadline)';
	}
	if (staircaseName && EITHER_WAY.has(input.pattern.toLowerCase())) {
		delete args.pattern;
		adjusted.pattern = `left out, so stairs up or down toward y (asked ${input.pattern})`;
	} else if (staircaseName) {
		args.pattern = 'stairs_down';
		adjusted.pattern = `stairs_down (asked ${input.pattern})`;
	}
	if (yawHeading) {
		args.heading = YAW_HEADINGS[((Math.round(input.heading / 90) % 4) + 4) % 4];
		adjusted.heading = `${args.heading} (asked ${input.heading}, read as a yaw)`;
	}
	return { arguments: args, ...(Object.keys(adjusted).length ? { adjusted } : {}) };
}
