// The batch itself, over any pool of machines with this shape (boat-pool.mjs and windows-pool.mjs are real, tests use a fake):
//   create() -> vm (vm.id)        prepare(vm) -> layout { code, out, jobs, helper, javaHome, template, jars: {arm: path}, inputs,
//                                   and optionally wrapper [cmd...], portBase (default 28000), env {name: value} }
//   start(vm, job, { closed })    poll(vm, room, { signal }) -> 'done' | 'running' (throws when the machine does not answer)
//   alive(vm) -> boolean          fetch(vm, room, roomsDir) puts ROOM/ under roomsDir and returns its done.json
// The boat pool's poll is a long poll that returns as soon as the room ends (up to a minute), so pollMs, the pause
// between polls, defaults to 0; retryMs is the pause after a poll that failed, so a machine that does not answer is not
// asked again in a tight loop.
//   keepAlive(vm)                 usage(vm) -> object         destroy(vm)
//   closesAt(vm) -> epoch ms|null  optional: from then on no room starts on vm, and a room still playing is stopped and
//                                  re-queued without spending one of its tries
//   release(vm) -> boolean, optional: gives a machine back to a warm pool (boat-warm.mjs) instead of deleting it;
//                                   false means the pool deleted it itself (the warm pool never does: it sets it aside).
// Rooms start on each machine as soon as it is ready, not once every machine is. A machine leaves the batch when its
// queue is empty, when it is lost or fails a room, and when the batch ends (also on an error or a signal). A pool with
// release() then decides: the warm pool keeps a machine that passes its cleaning check and sets aside, still running,
// one that does not. Without release() every machine is destroyed.
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { formatSummary, mergeArms, runQueue, topUp } from './room-batch-core.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

function raceAbort(promise, signal) {
	if (!signal) return promise;
	if (signal.aborted) { promise.catch(() => {}); return Promise.reject(new Error('batch stopped')); }
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error('batch stopped'));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			value => { signal.removeEventListener('abort', onAbort); resolve(value); },
			error => { signal.removeEventListener('abort', onAbort); reject(error); },
		);
	});
}

export async function runBatch({ batch, rooms, arms, pool, vms, out, roomTimeoutMs = 40 * 60_000, pollMs = 0, retryMs = 15_000, lostAfterMs = 5 * 60_000,
	keepAliveMs = 15 * 60_000, prepareGraceMs = 120_000, replacements = vms, log = console.log, rewrite = (value) => value, signal = null, valid = null }) {
	await mkdir(path.join(out, 'rooms'), { recursive: true });
	if ((await readdir(path.join(out, 'rooms'))).length) throw new Error(`${out} already holds rooms: use a fresh output folder`);
	const began = Date.now(), machines = [], layouts = new Map();
	let replaced = 0;
	// Machines a room was lost on in this batch: a replacement never leases one of them again, since the queue would not
	// give it the room it is replacing (a room is retried on a different machine).
	const lostOn = new Set();
	const bringUp = async () => {
		if (signal?.aborted) throw new Error('batch stopped');
		const vm = await pool.create({ signal, avoid: [...lostOn] });
		machines.push(vm);
		log(`machine ${vm.id} created`);
		if (signal?.aborted) { await retire(vm, 'batch stopped'); throw new Error('batch stopped'); }
		const prep = Promise.resolve().then(() => pool.prepare(vm, { signal }));
		prep.catch(() => {});
		try { layouts.set(vm.id, await raceAbort(prep, signal)); }
		catch (error) {
			// A stop does not end the prepare still uploading into ~/batch; a machine going back to a pool waits for it
			// (2 min at most), so the next batch's cleaning never races this batch's upload.
			if (signal?.aborted && pool.release) {
				let timer, settled = false;
				await Promise.race([prep.catch(() => {}).then(() => { settled = true; }), new Promise(done => { timer = setTimeout(done, prepareGraceMs); })]);
				clearTimeout(timer);
				// Still uploading after that: the machine may not go back to a pool, where another batch would lease it.
				if (!settled) vm.unsafe = true;
			}
			await retire(vm, signal?.aborted ? 'batch stopped' : `prepare failed: ${error.message}`);
			throw error;
		}
		if (signal?.aborted) { await retire(vm, 'batch stopped'); throw new Error('batch stopped'); }
		vm.keptAliveAt = Date.now();
		log(`machine ${vm.id} ready`);
		return vm;
	};
	// Retiring is marked on the lease (the vm object), not the id: a warm pool can hand the same machine back to this
	// batch as a new lease after an earlier one was released, and that lease must be retired on its own.
	const retire = async (vm, why) => {
		if (vm.retired) return;
		vm.retired = true;
		vm.usage = await Promise.resolve().then(() => pool.usage(vm)).catch(error => ({ error: error.message }));
		if (pool.release && !vm.unsafe) {
			try {
				if (await pool.release(vm)) { vm.returned = true; log(`machine ${vm.id} returned to the pool (${why})`); }
				else { vm.destroyed = true; log(`machine ${vm.id} deleted by the pool (${why})`); }
				return;
			} catch (error) { log(`could not return ${vm.id} to the pool (${why}): ${error.message}`); }
		}
		await destroy(vm, why);
	};
	// Deleting is tracked apart from retiring: a delete that failed is tried again when the batch ends.
	const destroy = async (vm, why) => {
		if (vm.destroyed) return;
		try { await pool.destroy(vm); vm.destroyed = true; vm.destroyError = null; log(`machine ${vm.id} deleted (${why})`); }
		catch (error) { vm.destroyError = error.message; log(`could not delete ${vm.id} (${why}): ${error.message}`); }
	};
	let outcomes = [];
	// --valid N: an INVALID or lost copy is replayed (both arms together) until each arm has N valid runs, at most 2N.
	const topUps = valid ? topUp({ rooms, arms: arms.map(arm => arm.name), valid, out }) : null;
	try {
		// Each machine joins the queue as soon as it is ready; a late one no longer holds the others' rooms back.
		const arrivals = Array.from({ length: vms }, () => bringUp().catch(error => { log(`a machine did not come up: ${error.message}`); return null; }));
		const attempt = async (vm, room, tries) => {
			if (signal?.aborted) return { lost: true, reason: 'batch stopped' };
			// Read each time: a pool may move a machine's cutoff while a room plays.
			const closesAt = () => pool.closesAt?.(vm) ?? null;
			const closed = () => closesAt() !== null && Date.now() >= closesAt();
			if (closed()) { await retire(vm, 'past its cutoff'); return { lost: true, requeue: true, reason: 'its machine is past its cutoff' }; }
			const layout = layouts.get(vm.id);
			const job = { room: room.room, code: layout.code, outDir: path.posix.join(layout.out, room.room), javaHome: layout.javaHome, template: layout.template, timeoutMs: roomTimeoutMs, wrapper: layout.wrapper ?? [],
				portBase: layout.portBase ?? 28000, env: layout.env ?? {},
				lines: room.lines.map(line => ({ arm: line.arm, jar: layout.jars[line.arm], env: Object.fromEntries(Object.entries(line.env).map(([key, value]) => [key, rewrite(value, layout)])), args: line.args.map(arg => rewrite(arg, layout)) })) };
			log(`room ${room.room} -> ${vm.id} (try ${tries})`);
			// A machine that cannot start a room leaves the batch now, not at its end (deleted, or checked and kept by a warm pool); the room is re-queued.
			// The pool checks the cutoff again just before it launches, after uploads that may outlast it.
			try { await pool.start(vm, job, { closed }); }
			catch (error) {
				if (closed()) { await retire(vm, 'cutoff'); return { lost: true, requeue: true, reason: 'its machine reached its cutoff while the room started' }; }
				await retire(vm, 'start failed'); return { lost: true, reason: `start failed: ${error.message}` };
			}
			if (closed()) { await retire(vm, 'cutoff'); return { lost: true, requeue: true, reason: 'stopped at its machine\'s cutoff' }; }
			const deadline = Date.now() + roomTimeoutMs + 10 * 60_000;
			let silentSince = null;
			while (true) {
				if (signal?.aborted) return { lost: true, reason: 'batch stopped' };
				// A machine with a cutoff is checked at the cutoff itself, not up to one poll later.
				const wait = closesAt() === null ? pollMs : Math.max(0, Math.min(pollMs, closesAt() - Date.now()));
				if (wait) await sleep(wait);
				if (Date.now() - vm.keptAliveAt > keepAliveMs) { await Promise.resolve().then(() => pool.keepAlive(vm)).then(() => { vm.keptAliveAt = Date.now(); }, () => {}); }
				let state;
				try { state = await pool.poll(vm, room.room, { signal }); silentSince = null; }
				catch (error) {
					if (signal?.aborted) return { lost: true, reason: 'batch stopped' };
					if (closed()) { await retire(vm, 'cutoff'); return { lost: true, requeue: true, reason: 'stopped at its machine\'s cutoff' }; }
					silentSince ??= Date.now();
					// Only boat saying the machine is gone skips the grace period; a failed lookup is unknown.
					const alive = await Promise.resolve().then(() => pool.alive(vm)).catch(() => null);
					if (alive === false || Date.now() - silentSince > lostAfterMs) { await retire(vm, 'lost'); return { lost: true, reason: alive !== false ? `no answer for ${Math.round(lostAfterMs / 60_000)} min` : 'machine gone' }; }
					await sleep(retryMs);
					continue;
				}
				if (state === 'done') break;
				if (closed()) { await retire(vm, 'cutoff'); return { lost: true, requeue: true, reason: 'stopped at its machine\'s cutoff' }; }
				if (Date.now() > deadline) { await retire(vm, 'room never finished'); return { lost: true, reason: 'room never wrote done.json' }; }
			}
			try {
				const done = await pool.fetch(vm, room.room, path.join(out, 'rooms'));
				log(`room ${room.room} done on ${vm.id} in ${done.seconds}s`);
				return { lost: false, arms: done.arms, seconds: done.seconds, machine: done.machine };
			} catch (error) { await retire(vm, 'copy failed'); return { lost: true, reason: `copy failed: ${error.message}` }; }
		};
		const replace = async (lostVm, outcome) => {
			if (signal?.aborted) return null;
			lostOn.add(lostVm.id);
			// A cutoff is planned, not a fault: its room always asks for a machine elsewhere (the pool refuses when none is
			// open), and spends none of the replacement budget.
			if (!outcome?.requeue) { if (replaced >= replacements) return null; replaced++; }
			log(`bringing up a machine in place of ${lostVm.id}`);
			return bringUp();
		};
		outcomes = await runQueue({ rooms, workers: [], arrivals, attempt, replace, release: vm => retire(vm, 'no rooms left'), log,
			more: topUps ? async (room, outcome) => { const extra = await topUps.more(room, outcome); for (const copy of extra) log(`top-up ${copy.room}: ${copy.topUpOf} is short of ${valid} valid runs`); return extra; } : null });
		if (!layouts.size && !signal?.aborted) throw new Error('no machine came up');
		// A stopped batch leaves its unfinished rooms lost for that reason, not for want of a machine.
		if (signal?.aborted) outcomes = outcomes.map(outcome => outcome?.lost ? { ...outcome, reason: 'batch stopped' } : outcome);
	} finally {
		await Promise.all(machines.map(vm => retire(vm, 'batch over')));
		await Promise.all(machines.filter(vm => !vm.destroyed && !vm.returned).map(vm => destroy(vm, 'retry at batch end')));
	}
	const wallSeconds = Math.round((Date.now() - began) / 1000);
	const armNames = arms.map(arm => arm.name);
	const played = [...rooms, ...(topUps?.added ?? [])];
	const merged = await mergeArms({ out, rooms: played, arms: armNames, outcomes });
	let text = formatSummary({ batch, merged, arms: armNames, wallSeconds, vms: machines.length, rooms: played });
	const short = topUps?.report().filter(group => group.short.length) ?? [];
	if (topUps) text += `\n--valid ${valid}: ${topUps.added.length} top-up copies; ${short.length ? `short at the ${2 * valid}-run cap: ${short.map(group => `${group.group} (${Object.entries(group.valid).map(([arm, n]) => `${arm} ${n}`).join(', ')})`).join('; ')}` : 'every group reached it'}`;
	return { outcomes, topUps: topUps?.report() ?? null, merged, wallSeconds, text, machines: machines.map(vm => ({ id: vm.id, reused: !!vm.reused, returned: !!vm.returned, destroyed: !!vm.destroyed, destroyError: vm.destroyError ?? null, usage: vm.usage ?? null })) };
}
