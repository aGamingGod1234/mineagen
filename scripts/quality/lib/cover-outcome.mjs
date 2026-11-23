// The defend rooms' cover outcome, read from a firing's report (test-defend-live.mjs coverSeen).

/**
 * In cover by a firing's report: a finished cover move ("in cover at", "already out of sight"), or a finished wall-in with
 * no side left open ("walled in from X at ...: closed ...;" or "already closed on every side at ...", no "; open ...").
 * A body closed on every side is safe from arrows and melee, which is what the cover outcome stands for.
 */
export function coverReached(detail) {
	const text = String(detail ?? '');
	return /in cover at|already out of sight/.test(text)
		|| /(?:walled in from \S+|already closed on every side) at [^:]*: closed [a-z, ]+;(?! open)/.test(text);
}
