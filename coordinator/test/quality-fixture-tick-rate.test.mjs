import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { bootTickRate, installTickRate, frozenFixtureSetup } from '../../scripts/quality/watch-replay.mjs';

// A fake server: records the commands a fixture sends and the tick rate it is left at.
function server() {
	const s = { sent: [], serverRate: 20 };
	s.command = async text => {
		s.sent.push(text);
		const m = /^tick rate (\d+)$/.exec(text);
		if (m) s.serverRate = Number(m[1]);
		return '';
	};
	return s;
}

test('a rate the fixture raised itself is brought back to 20 by normalRate, at a fixture rate of 20', async () => {
	// The rest fixture at its default (FIXTURE_TICK_RATE unset, TICK_RATE 60): it speeds up a walled-in night, and the
	// next case must start at 20 again.
	const s = installTickRate(server(), 20);
	await s.normalRate();
	assert.deepEqual(s.sent, [], 'already at 20: nothing sent');
	await s.setRate(60);
	assert.equal(s.serverRate, 60);
	await s.normalRate();
	assert.equal(s.serverRate, 20);
	assert.equal(s.rate, 20);
	assert.deepEqual(s.sent, ['tick rate 60', 'tick rate 20']);
});

test('fastRate and normalRate switch a raised fixture between its rate and 20, sending only real changes', async () => {
	const s = installTickRate(server(), 80);
	await s.applyTickRate();
	await s.fastRate();
	await s.normalRate();
	await s.normalRate();
	await s.fastRate();
	assert.deepEqual(s.sent, ['tick rate 80', 'tick rate 20', 'tick rate 80']);
	assert.equal(s.serverRate, 80);
});

test('at a fixture rate of 20 the waits are the plain wall-clock ones', async () => {
	const waited = [];
	const s = installTickRate(server(), 20, { wait: async ms => { waited.push(ms); } });
	await s.gameSleep(1500);
	assert.deepEqual(waited, [1500]);
	assert.deepEqual(s.sent, [], 'no world clock reads');
});

test('an idle wait passes at the fixture rate for its full game time and returns to the rate it ran at', async () => {
	const s = server();
	let gametime = 1000;
	const command = s.command;
	s.command = async text => { await command(text); return text === 'time query gametime' ? `The time is ${gametime}` : ''; };
	installTickRate(s, 80, { wait: async ms => { gametime += Math.round(ms * s.serverRate / 1000); } });
	const rates = [];
	const gameSleep = s.gameSleep;
	s.gameSleep = async ms => { rates.push(s.serverRate); return gameSleep(ms); };
	await s.idleSleep(3500);
	assert.deepEqual(rates, [80], 'the wait runs at the fixture rate');
	assert.ok(gametime - 1000 >= 70, `all 70 game ticks pass (${gametime - 1000})`);
	assert.equal(s.serverRate, 20, 'back at 20 for the next harness step');
	await s.fastRate();
	await s.idleSleep(500);
	assert.equal(s.serverRate, 80, 'a fixture already at its rate stays there');
	const plain = installTickRate(server(), 20, { wait: async () => {} });
	await plain.idleSleep(800);
	assert.deepEqual(plain.sent, [], 'at 20 nothing changes');
});

test('boot runs a fixture at 20 unless it passes a rate, and says why when FIXTURE_TICK_RATE is set', () => {
	const warnings = [];
	const warn = text => warnings.push(text);
	assert.equal(bootTickRate(undefined, {}, warn), 20);
	assert.equal(bootTickRate(undefined, { FIXTURE_TICK_RATE: '20' }, warn), 20);
	assert.deepEqual(warnings, []);
	assert.equal(bootTickRate(undefined, { FIXTURE_TICK_RATE: '80' }, warn), 20, 'an unconverted fixture keeps 20 TPS');
	assert.match(warnings[0], /FIXTURE_TICK_RATE=80 ignored/);
	assert.equal(bootTickRate(80, { FIXTURE_TICK_RATE: '80' }, warn), 80, 'a converted fixture passes its rate');
	assert.throws(() => bootTickRate(undefined, { FIXTURE_TICK_RATE: 'fast' }, warn), /FIXTURE_TICK_RATE must be/);
});

// rest: at 80, 2 of 6 walled-in nights took 3-4 damage and 1 of 6 bed nights could not place its bed; no run at 20 did
// (cause not known). build: its pass needs no damage, fire or fall, and its sampler reads take wall time, so it has not
// been shown to play the same at a raised rate. travel: its own waits are still wall time. None may pass a raised rate.
for (const fixture of ['rest', 'build', 'travel']) {
	test(`the ${fixture} fixture boots at 20 TPS whatever FIXTURE_TICK_RATE says`, async () => {
		const source = await readFile(new URL(`../../scripts/quality/test-${fixture}-live.mjs`, import.meta.url), 'utf8');
		// A boot() call, or the boot options a fixture hands warmBoots (fixture-servers.mjs).
		const boots = [...(source.match(/\bboot\([^)]*\{[^}]*\}\s*\)/g) ?? []), ...(/\bwarmBoots\(/.test(source) ? source.match(/\boptions: \{[^}]*\}/g) ?? [] : [])];
		assert.ok(boots.length > 0, `the ${fixture} fixture calls boot()`);
		for (const call of boots) assert.doesNotMatch(call, /tickRate/, `${fixture} boots with a tick rate: ${call}`);
	});
}

test('a game timer records the rate asked for and the rate the world clock reached', async () => {
	// A fake world clock: 'time query gametime' answers a tick count set by the test.
	let ticks = 1000;
	const make = rate => {
		const s = server(), command = s.command;
		s.command = async text => text === 'time query gametime' ? `The time is ${ticks}` : command(text);
		return installTickRate(s, rate);
	};
	const fast = make(80);
	await fast.fastRate();
	const timer = await fast.gameTimer();
	ticks += 4000;
	await new Promise(done => setTimeout(done, 50));
	const rates = await timer.rates();
	assert.equal(rates.askedTps, 80);
	assert.equal(rates.gameTicks, 4000);
	assert.ok(rates.reachedTps > 80, `4000 ticks in ~0.05 s reads as far above 80: ${rates.reachedTps}`);
	// A fixture that never raised the rate records 20 asked, so a 20-vs-20 "comparison" shows itself.
	const plain = make(20);
	await plain.fastRate();
	const still = await plain.gameTimer();
	assert.equal((await still.rates()).askedTps, 20);
	assert.deepEqual(plain.sent, [], 'a fixture at 20 sends no tick rate');
});

for (const rate of [20, 80]) {
	test(`an explicit world-tick timer at ${rate} TPS measures ticks and rejects missing/decreasing evidence`, async () => {
		let ticks = 1000;
		const s = installTickRate({ command: async () => ticks === null ? '' : `The time is ${ticks}` }, rate);
		const timer = await s.gameTimer({ worldTicks: true });
		assert.equal(await timer.elapsed(), 0, 'a stopped world has no elapsed game time');
		ticks += 80;
		assert.equal(await timer.elapsed(), 4000, '80 world ticks, independent of wall time');
		ticks = 999;
		await assert.rejects(timer.elapsed(), /decreased/);
		ticks = null;
		await assert.rejects(timer.elapsed(), /unavailable/);
		await assert.rejects(s.gameTimer({ worldTicks: true }), /unavailable/);
	});
}

test('frozen setup releases the world before the caller can await a bridge action', async () => {
	const s = server();
	const value = await frozenFixtureSetup(s, async () => {
		await s.command('summon zombie');
		await s.command('summon skeleton');
		return 'ready';
	});
	assert.equal(value, 'ready');
	assert.deepEqual(s.sent, ['tick freeze', 'summon zombie', 'summon skeleton', 'tick unfreeze']);
});

test('frozen setup releases the world when setup or the freeze acknowledgement fails', async () => {
	for (const failFreeze of [false, true]) {
		const sent = [];
		const s = { command: async text => {
			sent.push(text);
			if (failFreeze && text === 'tick freeze') throw new Error('freeze acknowledgement lost');
		} };
		await assert.rejects(frozenFixtureSetup(s, async () => { throw new Error('setup failed'); }), /failed|lost/);
		assert.deepEqual(sent, ['tick freeze', 'tick unfreeze']);
	}
});
