import { ReplayPlanner } from '../../../coordinator/src/decision-eval/replay-harness.mjs';
import { normalizeMinecraftToolCall } from '../../../coordinator/src/native-minecraft-tools.mjs';

/** Fixed calls through the production coordinator's provider seam, with no model service. */
export class ScriptedPlanner extends ReplayPlanner {
	constructor(registry, { calls, budgetMs, log }) {
		super(registry); Object.assign(this, { calls, budgetMs, log });
		this.finished = Promise.withResolvers();
		this.finished.promise.catch(() => {});
		this.results = []; this.started = false; this.stopped = false;
	}
	async requestGoalSpec({ request }) {
		return { requestId: request.requestId, summary: 'Find lava incident', predicate: { type: 'operator_confirmed' } };
	}
	requestNativeTurn(request) {
		const done = super.requestNativeTurn(request);
		if (!this.started) {
			this.started = true;
			void this.run(request).then(() => {
				this.turns[0].finish({ status: 'completed', toolCalls: this.results.length });
				this.finished.resolve(this.results);
			}, error => { this.finished.reject(error); });
		}
		return done;
	}
	async steerNativeTurn(request) {
		this.log('scripted-planner', 'steer', { goalRevision: request.goalRevision, interrupted: Boolean(request.onInterrupt) });
		request.onInterrupt?.();
		if (typeof request.input === 'function') await request.input();
	}
	async run(request) {
		const started = Date.now();
		for (const [index, call] of this.calls.entries()) {
			if (this.stopped || Date.now() - started >= this.budgetMs - 10000) break;
			const args = structuredClone(call.arguments);
			if (call.name === 'do_step' && args.verb === 'find') args.target.timeoutMs = Math.min(540000, this.budgetMs - (Date.now() - started));
			const execute = (name, arguments_, suffix = '') => request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision,
				turnId: 'incident', callId: `incident-${index}${suffix}`, tool: normalizeMinecraftToolCall(name, arguments_) });
			this.log('scripted-planner', 'tool_call', { index, name: call.name, arguments: args });
			const result = await execute(call.name, args);
			this.results.push({ index, name: call.name, state: result.state, reasonCode: result.reasonCode, actionId: result.actionId, find: result.find });
			this.log('scripted-planner', 'tool_result', this.results.at(-1));
			if (['RUNNING', 'PREPARING'].includes(result.state) && result.actionId) {
				const cancelled = await execute('cancelAction', { actionId: result.actionId, goalRevision: request.goalRevision }, '-cancel');
				this.log('scripted-planner', 'cancel_returned_handle', { state: cancelled.state, reasonCode: cancelled.reasonCode });
			}
			if (result.state === 'SUCCEEDED' && result.reasonCode === 'FIND_SEEN') break;
		}
	}
	finishAll() { this.stopped = true; for (const turn of this.turns) turn.finish({ status: 'completed', toolCalls: 0 }); }
}
