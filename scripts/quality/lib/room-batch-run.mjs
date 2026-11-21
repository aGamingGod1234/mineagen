// The batch itself, over any pool of machines with this shape (boat-pool.mjs is the real one, tests use a fake):
//   create() -> vm (vm.id)        prepare(vm) -> layout { code, out, jobs, helper, javaHome, template, jars: {arm: path}, inputs }
//   start(vm, job)                poll(vm, room, { signal }) -> 'done' | 'running' (throws when the machine does not answer)
//   alive(vm) -> boolean          fetch(vm, room, roomsDir) puts ROOM/ under roomsDir and returns its done.json
// The boat pool's poll is a long poll that returns as soon as the room ends (up to a minute), so pollMs, the pause
// between polls, defaults to 0; retryMs is the pause after a poll that failed, so a machine that does not answer is not
// asked again in a tight loop.
//   keepAlive(vm)                 usage(vm) -> object         destroy(vm)
// Machines are destroyed when the batch ends, also on an error or a signal.
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { formatSummary, mergeArms, runQueue } from './room-batch-core.mjs';

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
	keepAliveMs = 15 * 60_000, replacements = vms, log = console.log, rewrite = (value) => value, signal = null }) {
	await mkdir(path.join(out, 'rooms'), { recursive: true });
	if ((await readdir(path.join(out, 'rooms'))).length) throw new Error(`${out} already holds rooms: use a fresh output folder`);
	const began = Date.now(), machines = [], layouts = new Map();
	let replaced = 0;
	const bringUp = async () => {
		if (signal?.aborted) throw new Error('batch stopped');
		const vm = await pool.create();
		machines.push(vm);
		log(`machine ${vm.id} created`);
		if (signal?.aborted) { await retire(vm, 'batch stopped'); throw new Error('batch stopped'); }
		const prep = Promise.resolve().then(() => pool.prepare(vm, { signal }));
		prep.catch(() => {});
		try { layouts.set(vm.id, await raceAbort(prep, signal)); }
		catch (error) { await retire(vm, signal?.aborted ? 'batch stopped' : `prepare failed: ${error.message}`); throw error; }
		if (signal?.aborted) { await retire(vm, 'batch stopped'); throw new Error('batch stopped'); }
		vm.keptAliveAt = Date.now();
		log(`machine ${vm.id} ready`);
		return vm;
	};
	const retired = new Set();
	const retire = async (vm, why) => {
		if (retired.has(vm.id)) return;
		retired.add(vm.id);
		vm.usage = await Promise.resolve().then(() => pool.usage(vm)).catch(error => ({ error: error.message }));
		await destroy(vm, why);
	};
	// Deleting is tracked apart from retiring: a delete that failed is tried again when the batch ends.
	const destroy = async (vm, why) => {
		if (vm.destroyed) return;
		try { await pool.destroy(vm); vm.destroyed = true; vm.destroyError = null; log(`machine ${vm.id} deleted (${why})`); }
		catch (error) { vm.destroyError = error.message; log(`could not delete ${vm.id} (${why}): ${error.message}`); }
	};
	let outcomes = [];
	try {
		const workers = (await Promise.allSettled(Array.from({ length: vms }, bringUp))).filter(item => item.status === 'fulfilled').map(item => item.value);
		if (!workers.length && !signal?.aborted) throw new Error('no machine came up');
		if (signal?.aborted) {
			outcomes = rooms.map(room => ({ room: room.room, lost: true, reason: 'batch stopped', attempts: 0 }));
		} else {
		const attempt = async (vm, room, tries) => {
			if (signal?.aborted) return { lost: true, reason: 'batch stopped' };
			const layout = layouts.get(vm.id);
			const job = { room: room.room, code: layout.code, outDir: path.posix.join(layout.out, room.room), javaHome: layout.javaHome, template: layout.template, timeoutMs: roomTimeoutMs, wrapper: layout.wrapper ?? [],
				lines: room.lines.map(line => ({ arm: line.arm, jar: layout.jars[line.arm], env: Object.fromEntries(Object.entries(line.env).map(([key, value]) => [key, rewrite(value, layout)])), args: line.args.map(arg => rewrite(arg, layout)) })) };
			log(`room ${room.room} -> ${vm.id} (try ${tries})`);
			// A machine that cannot start a room is deleted now, not at the end of the batch; the room is re-queued.
			try { await pool.start(vm, job); }
			catch (error) { await retire(vm, 'start failed'); return { lost: true, reason: `start failed: ${error.message}` }; }
			const deadline = Date.now() + roomTimeoutMs + 10 * 60_000;
			let silentSince = null;
			while (true) {
				if (signal?.aborted) return { lost: true, reason: 'batch stopped' };
				if (pollMs) await sleep(pollMs);
				if (Date.now() - vm.keptAliveAt > keepAliveMs) { await Promise.resolve().then(() => pool.keepAlive(vm)).then(() => { vm.keptAliveAt = Date.now(); }, () => {}); }
				let state;
				try { state = await pool.poll(vm, room.room, { signal }); silentSince = null; }
				catch (error) {
					if (signal?.aborted) return { lost: true, reason: 'batch stopped' };
					silentSince ??= Date.now();
					// Only boat saying the machine is gone skips the grace period; a failed lookup is unknown.
					const alive = await Promise.resolve().then(() => pool.alive(vm)).catch(() => null);
					if (alive === false || Date.now() - silentSince > lostAfterMs) { await retire(vm, 'lost'); return { lost: true, reason: alive !== false ? `no answer for ${Math.round(lostAfterMs / 60_000)} min` : 'machine gone' }; }
					await sleep(retryMs);
					continue;
				}
				if (state === 'done') break;
				if (Date.now() > deadline) { await retire(vm, 'room never finished'); return { lost: true, reason: 'room never wrote done.json' }; }
			}
			try {
				const done = await pool.fetch(vm, room.room, path.join(out, 'rooms'));
				log(`room ${room.room} done on ${vm.id} in ${done.seconds}s`);
				return { lost: false, arms: done.arms, seconds: done.seconds, machine: done.machine };
			} catch (error) { await retire(vm, 'copy failed'); return { lost: true, reason: `copy failed: ${error.message}` }; }
		};
		const replace = async lostVm => {
			if (replaced >= replacements || signal?.aborted) return null;
			replaced++;
			log(`bringing up a machine in place of ${lostVm.id}`);
			return bringUp();
		};
		outcomes = await runQueue({ rooms, workers, attempt, replace, release: vm => retire(vm, 'no rooms left'), log });
		// A stopped batch leaves its unfinished rooms lost for that reason, not for want of a machine.
		if (signal?.aborted) outcomes = outcomes.map(outcome => outcome?.lost ? { ...outcome, reason: 'batch stopped' } : outcome);
		}
	} finally {
		await Promise.all(machines.map(vm => retire(vm, 'batch over')));
		await Promise.all(machines.filter(vm => !vm.destroyed).map(vm => destroy(vm, 'retry at batch end')));
	}
	const wallSeconds = Math.round((Date.now() - began) / 1000);
	const armNames = arms.map(arm => arm.name);
	const merged = await mergeArms({ out, rooms, arms: armNames, outcomes });
	const text = formatSummary({ batch, merged, arms: armNames, wallSeconds, vms: machines.length, rooms });
	return { outcomes, merged, wallSeconds, text, machines: machines.map(vm => ({ id: vm.id, destroyed: !!vm.destroyed, destroyError: vm.destroyError ?? null, usage: vm.usage ?? null })) };
}
