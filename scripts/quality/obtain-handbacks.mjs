// One obtain run in the live harness: the call, and what happens at a danger hand-back. By default the run ends at
// the hand-back (what comes next is the model's to decide, and the harness scores obtain, not a stand-in model).
// mode 'answer' restores the stand-in: answer the hand-back, then call obtain again, up to 6 calls inside the budget.
export async function callObtain({ mode, budgetMs, started, now = Date.now, execute, answer, alive }) {
	const results = [], handBacks = [];
	let result;
	for (let attempt = 0; attempt < (mode === 'answer' ? 6 : 1); attempt++) {
		const left = budgetMs - (now() - started);
		if (attempt > 0 && left < 60_000) break;
		result = await execute(attempt, left);
		results.push(result);
		if (result?.state !== 'INTERRUPTED') break;
		handBacks.push(String(result.message ?? '').slice(0, 200));
		if (mode !== 'answer') break;
		if (!(await alive())) break;
		const note = await answer(result, attempt);
		if (note) handBacks.push(note);
	}
	return { result, results, handBacks };
}
