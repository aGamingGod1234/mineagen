// The batch itself, over any pool of machines with this shape (boat-pool.mjs is the real one, tests use a fake):
//   create() -> vm (vm.id)        prepare(vm) -> layout { code, out, jobs, helper, javaHome, template, jars: {arm: path}, inputs }
//   start(vm, job)                poll(vm, room) -> 'done' | 'running' (throws when the machine does not answer)
//   alive(vm) -> boolean          fetch(vm, room, roomsDir) puts ROOM/ under roomsDir and returns its done.json
//   keepAlive(vm)                 usage(vm) -> object         destroy(vm)
// Machines are destroyed when the batch ends, also on an error or a signal.
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { formatSummary, mergeArms, runQueue } from './room-batch-core.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

export async function runBatch({ batch, rooms, arms, pool, vms, out, roomTimeoutMs = 40 * 60_000, pollMs = 20_000, lostAfterMs = 5 * 60_000,
	keepAliveMs = 15 * 60_000, replacements = vms, log = console.log, rewrite = (value) => value, signal = null }) {
	await mkdir(path.join(out, 'rooms'), { recursive: true });
	if ((await readdir(path.join(out, 'rooms'))).length) throw new Error(`${out} already holds rooms: use a fresh output folder`);
	const began = Date.now(), machines = [], layouts = new Map();
	let replaced = 0;
	const bringUp = async () => {
		const vm = await pool.create();
		machines.push(vm);
		try { layouts.set(vm.id, await pool.prepare(vm)); }
		catch (error) { await retire(vm, `prepare failed: ${error.message}`); throw error; }
		vm.keptAliveAt = Date.now();
		log(`machine ${vm.id} ready`);
		return vm;
	};
	const retired = new Set();
	const retire = async (vm, why) => {
		if (retired.has(vm.id)) return;
		retired.add(vm.id);
		vm.usage = await Promise.resolve().then(() => pool.usage(vm)).catch(error => ({ error: error.message }));
		await Promise.resolve().then(() => pool.destroy(vm)).then(() => { vm.destroyed = true; }, error => { vm.destroyError = error.message; log(`could not delete ${vm.id}: ${error.message}`); });
		log(`machine ${vm.id} deleted (${why})`);
	};
	let outcomes = [];
	try {
		const workers = (await Promise.allSettled(Array.from({ length: vms }, bringUp))).filter(item => item.status === 'fulfilled').map(item => item.value);
		if (!workers.length) throw new Error('no machine came up');
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
				await sleep(pollMs);
				if (Date.now() - vm.keptAliveAt > keepAliveMs) { await Promise.resolve().then(() => pool.keepAlive(vm)).then(() => { vm.keptAliveAt = Date.now(); }, () => {}); }
				let state;
				try { state = await pool.poll(vm, room.room); silentSince = null; }
				catch (error) {
					silentSince ??= Date.now();
					const alive = await Promise.resolve().then(() => pool.alive(vm)).catch(() => false);
					if (!alive || Date.now() - silentSince > lostAfterMs) { await retire(vm, 'lost'); return { lost: true, reason: alive ? `no answer for ${Math.round(lostAfterMs / 60_000)} min` : 'machine gone' }; }
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
	} finally {
		await Promise.all(machines.map(vm => retire(vm, 'batch over')));
	}
	const wallSeconds = Math.round((Date.now() - began) / 1000);
	const armNames = arms.map(arm => arm.name);
	const merged = await mergeArms({ out, rooms, arms: armNames, outcomes });
	const text = formatSummary({ batch, merged, arms: armNames, wallSeconds, vms: machines.length, rooms });
	return { outcomes, merged, wallSeconds, text, machines: machines.map(vm => ({ id: vm.id, destroyed: !!vm.destroyed, destroyError: vm.destroyError ?? null, usage: vm.usage ?? null })) };
}
