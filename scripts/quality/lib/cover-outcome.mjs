// The defend rooms' cover outcome, read from a firing's report (test-defend-live.mjs coverSeen).

/**
 * In cover by a firing's report: a finished cover move ("in cover at", "already out of sight"), or a finished wall-in with
 * no side left open ("walled in from X at ...: closed ...;" or "already closed on every side at ...", no "; open ...").
 * A body closed on every side is safe from arrows and melee, which is what the cover outcome stands for.
 */
export function coverReached(detail) {
	const text = String(detail ?? '');
	// "already closed on every side" is reported only when every planned cell was solid already. A finished wall-in must
	// show its roof state right after the closed list: a stored step cut short after "closed north, east;" (or inside
	// "; open ...") would otherwise read as closed on every side.
	return /in cover at|already out of sight/.test(text)
		|| /already closed on every side at [^:]*: closed [a-z, ]+;(?! open)/.test(text)
		|| /walled in from \S+ at [^:]*: closed [a-z, ]+; (?:roofed|no roof)/.test(text);
}
