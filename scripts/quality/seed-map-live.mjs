// Surface map round a world's spawn, for diagnosing a start: node scripts/quality/seed-map-live.mjs SEED OUT_DIR [RADIUS] [STEP] [JAR]
// under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME. One fresh server, no player: every chunk within
// RADIUS of the spawn is generated, then each STEP-block column's top block is classed as water, leaves, log or land.
// Writes map.json ({ spawn, step, radius, rows: [[x, z, class, y]] }) and map.txt (a character grid, north up:
// '~' water, 'T' tree, '.' land, '@' the spawn).
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './watch-replay.mjs';
import { parseSavedWorldSpawn } from '../../coordinator/src/headless-world-spawn.mjs';
import { MOD_JAR } from './mod-jar.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [seed, outArg, radiusArg = '320', stepArg = '8', jarArg] = process.argv.slice(2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!seed || !outArg || !template || !port) throw new Error('Usage: SEED OUT_DIR [RADIUS] [STEP] [JAR] under slot.sh live');
const out = path.resolve(outArg), radius = Number(radiusArg), step = Number(stepArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const s = await boot(out, { jar: path.resolve(jarArg ?? path.join(root, MOD_JAR)), template, port, world: null, seed, extraProperties: 'max-tick-time=-1\n' });
try {
	await s.command('save-all flush');
	const { x: sx, z: sz } = parseSavedWorldSpawn(await readFile(path.join(out, 'server', 'world', 'level.dat')));
	const top = async (x, z, test) => /passed/i.test(await s.command(`execute positioned ${x} 0 ${z} positioned over motion_blocking if block ~ ~-1 ~ ${test}`).catch(() => ''));
	const rows = [];
	for (let x0 = sx - radius; x0 < sx + radius; x0 += 16) {
		await s.command(`forceload add ${x0} ${sz - radius} ${x0 + 15} ${sz + radius}`);
		for (let x = x0; x < x0 + 16; x += step) {
			for (let z = sz - radius; z <= sz + radius; z += step) {
				for (let wait = 0; wait < 120 && !/time is/i.test(await s.command(`execute if loaded ${x} 0 ${z} run time query gametime`)); wait++) await new Promise((r) => setTimeout(r, 500));
				const kind = await top(x, z, 'minecraft:water') ? 'water' : await top(x, z, '#minecraft:leaves') ? 'leaves' : await top(x, z, '#minecraft:logs') ? 'log' : 'land';
				rows.push([x, z, kind]);
			}
		}
		await s.command(`forceload remove ${x0} ${sz - radius} ${x0 + 15} ${sz + radius}`);
	}
	await writeFile(path.join(out, 'map.json'), JSON.stringify({ seed, spawn: [sx, sz], step, radius, rows }));
	const grid = new Map(rows.map(([x, z, kind]) => [`${x},${z}`, kind]));
	const lines = [];
	for (let z = sz - radius; z <= sz + radius; z += step) {
		let line = '';
		for (let x = sx - radius; x < sx + radius; x += step) {
			const kind = grid.get(`${x},${z}`);
			line += Math.abs(x - sx) < step && Math.abs(z - sz) < step ? '@' : kind === 'water' ? '~' : kind === 'leaves' || kind === 'log' ? 'T' : kind === 'land' ? '.' : ' ';
		}
		lines.push(line);
	}
	await writeFile(path.join(out, 'map.txt'), `seed ${seed} spawn ${sx},${sz}; step ${step}; north up, west left; x ${sx - radius}..${sx + radius}, z ${sz - radius}..${sz + radius}\n${lines.join('\n')}\n`);
	console.log(`mapped ${rows.length} columns round ${sx},${sz}`);
} finally {
	await s.stop().catch(() => {});
}
process.exit(0);
