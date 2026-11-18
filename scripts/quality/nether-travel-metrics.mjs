#!/usr/bin/env node
// Read only the gameplay protocol or the per-second samples, never provider workspaces. Teleports and sampling gaps
// are reported, not movement. scripts/quality/gate-report.mjs imports netherTravel for its per-game Nether numbers.
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const NETHER = 'minecraft:the_nether';
const OVERWORLD = 'minecraft:overworld';
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** A quality-samples.jsonl row in the observation shape netherTravel reads; the sample's death counter comes along. */
export const sampleObservation = (row) => ({ observedAtEpochMs: row.at, position: row.position, world: { dimension: row.dimension, gameTime: row.gameTime },
	player: { health: row.health }, deathCounter: row.deathCounter });

/**
 * Nether travel and recovery over one game, fed observation by observation, optionally clipped to a playing window.
 * Deaths come from the death counter when observations carry one (samples), else from the dead status (protocol).
 * A death belongs to the dimension of the last live observation before it. The entry portal is the Overworld side:
 * the last live Overworld position before the latest Nether entry, so a respawn distance compares like with like.
 */
export function netherTravel({ windowStart = null, windowEnd = null } = {}) {
	let last = null, last10 = null, entry = null, netherMs = 0, pathBlocks = 0, path10Blocks = 0, gaps = 0, excludedJumps = 0, deaths = 0, dead = false;
	let firstFortress = null, maxFromEntry = 0, activeMs = 0, travelGain = 0, travelCalls = 0;
	let counter = null, alive = null, lastTime = null, portal = null, firstEntry = null, deathsAfterFirstEntry = 0, respawning = null;
	// Deaths recorded from health while the sample's counter read was missing; a later counter rise already counts them.
	let fallbackDeaths = 0;
	const calls = new Map(), reasons = {}, results = new Set(), netherDeaths = [];
	let tickSpan = 0, tickWallMs = 0;
	const died = (time) => {
		deaths++;
		if (firstEntry && time >= firstEntry.atMs) deathsAfterFirstEntry++;
		if (alive?.dimension !== NETHER) return;
		respawning = { atMs: time, diedAt: { ...alive.at }, portal: portal && { ...portal }, respawn: null, respawnBlocks: null, backAtMs: null };
		netherDeaths.push(respawning);
	};
	return {
		observation(o) {
			const at = o.position, time = o.observedAtEpochMs, dimension = o.world?.dimension;
			const isDead = o.status === 'PLAYER_DEAD' || o.player?.health <= 0;
			if (!Number.isFinite(time)) return;
			if (windowStart !== null && time < windowStart || windowEnd !== null && time > windowEnd) {
				last = null; last10 = null;
				if (Number.isFinite(o.deathCounter)) counter = o.deathCounter;
				return;
			}
			lastTime = time;
			if (Number.isFinite(o.deathCounter)) {
				if (counter !== null && o.deathCounter > counter) {
					const rise = o.deathCounter - counter, already = Math.min(rise, fallbackDeaths);
					fallbackDeaths -= already;
					for (let i = already; i < rise; i++) died(time);
					last = null; last10 = null;
				}
				if (counter === null) fallbackDeaths = 0;
				counter = o.deathCounter;
				dead = isDead;
			} else {
				if (isDead && !dead) { died(time); if (counter !== null) fallbackDeaths++; }
				if (isDead !== dead) { dead = isDead; last = null; last10 = null; }
			}
			if (!at) return;
			if (!isDead) {
				if (dimension === NETHER && alive?.dimension === OVERWORLD) {
					portal = { ...alive.at };
					firstEntry ??= { atMs: time, portal: { ...portal } };
				}
				// A window or capture that starts in the Nether: the first entry is the first live Nether sample, its portal unknown.
				if (dimension === NETHER && alive === null) firstEntry ??= { atMs: time, portal: null };
				if (respawning) {
					respawning.respawn = { dimension, ...at };
					respawning.respawnBlocks = respawning.portal && dimension === OVERWORLD ? flat(at, respawning.portal) : null;
					respawning = null;
				}
				if (dimension === NETHER) for (const death of netherDeaths) if (death.backAtMs === null && death.respawn) death.backAtMs = time;
				alive = { dimension, at };
			}
			if (dimension === NETHER && !isDead) entry ??= { ...at, atMs: time };
			if (last?.dimension === NETHER && dimension === NETHER && time >= last.time) {
				const dt = time - last.time;
				netherMs += dt;
				const ticks = o.world?.gameTime;
				if (dt > 0 && Number.isFinite(ticks) && Number.isFinite(last.ticks) && ticks >= last.ticks) {
					tickSpan += ticks - last.ticks; tickWallMs += dt;
				}
				if (dt <= 5000) {
					const step = flat(at, last.at);
					if (step <= Math.max(2, dt / 1000 * 10)) pathBlocks += step; else excludedJumps++;
				} else gaps++;
			}
			if (dimension === NETHER && !isDead && entry) {
				maxFromEntry = Math.max(maxFromEntry, flat(at, entry));
				if (!last10) last10 = { at, time };
				else if (time - last10.time >= 10000) {
					const step = flat(at, last10.at);
					if (step < 200) path10Blocks += step;
					last10 = { at, time };
				}
				const structures = o.sighted?.structures ?? [];
				const fortress = structures.find(s => /fortress/i.test(s.structure ?? '') || (s.blocks ?? []).some(b => /(^|:)nether_brick/.test(b)));
				const bricks = [...(o.blocks ?? []), ...(o.landmarks ?? [])].find(b => /(^|:)nether_brick/.test(b.blockId ?? ''));
				if (!firstFortress && (fortress || bricks)) firstFortress = { netherMinutes: netherMs / 60000, wallMinutes: (time - entry.atMs) / 60000, wallFromGameStartMinutes: windowStart === null ? null : (time - windowStart) / 60000, at: { ...at }, seen: fortress ?? bricks };
			}
			if (dimension !== NETHER) last10 = null;
			last = { dimension, at, time, ticks: o.world?.gameTime };
		},
		command(p) { if (p.actionType === 'travel_to' && last?.dimension === NETHER) calls.set(p.actionId, last.time); },
		result(p) {
			if (!calls.has(p.actionId) || results.has(p.actionId) || !['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(p.state)) return;
			results.add(p.actionId); travelCalls++; activeMs += p.elapsedMs ?? 0; reasons[p.reasonCode] = (reasons[p.reasonCode] ?? 0) + 1;
			const gain = /covered (-?[\d.]+) blocks toward it/.exec(p.message ?? ''); if (gain) travelGain += Number(gain[1]);
		},
		report() {
			const minutes = netherMs / 60000, end = windowEnd ?? lastTime;
			return { playingWindow: { startedAt: windowStart, endedAt: windowEnd }, netherMinutes: minutes, pathBlocks, path10Blocks, blocksPerNetherMinute: minutes ? path10Blocks / minutes : null,
				sampledPathBlocksPerNetherMinute: minutes ? pathBlocks / minutes : null,
				maxFromEntry, maxDisplacementPerNetherMinute: minutes ? maxFromEntry / minutes : null, firstFortress, deaths,
				// Recovery: each Nether death, how far from the entry portal it respawned, and how long until it was back in
				// the Nether. A death never followed by a return counts its minutes to the end of the window instead.
				recovery: { firstEntry, deathsAfterFirstEntry, netherDeaths: netherDeaths.map((death) => ({ ...death,
					backMinutes: death.backAtMs === null ? null : (death.backAtMs - death.atMs) / 60000,
					untilEndMinutes: death.backAtMs === null && Number.isFinite(end) ? Math.max(0, end - death.atMs) / 60000 : null })) },
				travel: { calls: travelCalls, activeMinutes: activeMs / 60000, netGain: travelGain, netBlocksPerActiveMinute: activeMs ? travelGain / (activeMs / 60000) : null, reasons },
				serverTickRate: tickWallMs ? tickSpan / (tickWallMs / 1000) : null,
				sampling: { displacementCadenceSeconds: 10, gapsOver5s: gaps, excludedJumps } };
		},
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [file, output, startArg, endArg] = process.argv.slice(2);
	const windowStart = startArg === undefined ? null : Number(startArg), windowEnd = endArg === undefined ? null : Number(endArg);
	if ((windowStart !== null && !Number.isFinite(windowStart)) || (windowEnd !== null && (!Number.isFinite(windowEnd) || windowStart === null || windowEnd < windowStart))) throw new Error('Invalid playing-window timestamps');
	if (!file || !output) throw new Error('Usage: nether-travel-metrics.mjs quality-protocol.jsonl|quality-samples.jsonl out.json [playing-start-ms playing-end-ms]');
	const travel = netherTravel({ windowStart, windowEnd });
	for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
		let row; try { row = JSON.parse(line); } catch { continue; }
		if (!row.envelope && !row.type && Number.isFinite(row.at)) { travel.observation(sampleObservation(row)); continue; }
		const e = row.envelope ?? row, p = e.payload ?? {};
		if (e.type === 'observation') travel.observation(p.observation ?? p);
		else if (e.type === 'action_command') travel.command(p);
		else if (e.type === 'action_result') travel.result(p);
	}
	const report = { protocol: file, ...travel.report() };
	await writeFile(output, JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ netherMinutes: report.netherMinutes, blocksPerNetherMinute: report.blocksPerNetherMinute, firstFortressMinutes: report.firstFortress?.netherMinutes ?? null, deaths: report.deaths,
		netherDeaths: report.recovery.netherDeaths.length, travelNetBlocksPerActiveMinute: report.travel.netBlocksPerActiveMinute }));
}
