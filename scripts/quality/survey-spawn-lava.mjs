// Offline ground truth for a cast-portal fixture (never shown to the body): still lava pools around a fresh seed's spawn.
// node scripts/quality/survey-spawn-lava.mjs SEED OUT_DIR [RADIUS_BLOCKS=112] [JAR]   under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE, JAVA_HOME.
// Boots the seed with no agent, force-loads the chunks within RADIUS of the world spawn, saves, stops and runs
// lava-survey.py over the region files, then cave-start.py on each usable pool within RADIUS. Writes OUT_DIR/survey.json
// ({ seed, spawn, usable, shores }) and deletes the world.
// With POOL=x,y,z it force-loads around that pool instead and writes OUT_DIR/start.json from cave-start.py: a dry standing
// cell in the pool's cave, 16-28 walked blocks from it.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSavedWorldSpawn } from '../../coordinator/src/headless-world-spawn.mjs';
import { boot } from './watch-replay.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [seed, outArg, radiusArg, jarArg] = process.argv.slice(2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!seed || !outArg || !template || !port) throw new Error('Usage: SEED OUT_DIR [RADIUS] [JAR] under slot.sh live');
const radius = Number(radiusArg ?? 112);
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
const sleep = ms => new Promise(done => setTimeout(done, ms));
const s = await boot(out, { jar: path.resolve(jarArg ?? path.join(root, 'build/libs/mineagen-0.2.0.jar')), template, port, world: null, seed: String(seed) });
let spawn;
try {
	await s.command('save-all flush');
	await sleep(1500);
	spawn = parseSavedWorldSpawn(await readFile(path.join(out, 'server/world/level.dat')));
	const pool = process.env.POOL ? process.env.POOL.split(',').map(Number) : null;
	const [cx, cz] = pool ? [pool[0], pool[2]] : [spawn.x, spawn.z];
	const [x0, z0, x1, z1] = [cx - radius, cz - radius, cx + radius, cz + radius];
	// forceload takes at most 256 chunks a call: split the square into strips.
	for (let x = x0; x <= x1; x += 128) console.log(await s.command(`forceload add ${x} ${z0} ${Math.min(x + 127, x1)} ${z1}`));
	for (const [x, z] of [[x0, z0], [x1, z1], [x0, z1], [x1, z0]])
		for (let wait = 0; wait < 120 && !/time is/i.test(await s.command(`execute if loaded ${x} 0 ${z} run time query gametime`)); wait++) await sleep(1000);
	await sleep(5000);
	await s.command('save-all flush');
	await sleep(3000);
} finally { await s.stop(); }
if (process.env.POOL) {
	const start = JSON.parse(execFileSync('python3', ['-I', path.join(root, 'scripts/quality/cave-start.py'), path.join(out, 'server/world'), ...process.env.POOL.split(',')], { encoding: 'utf8', maxBuffer: 64 << 20 }));
	await writeFile(path.join(out, 'start.json'), JSON.stringify({ seed: String(seed), ...start }, null, 1));
	if (!process.env.KEEP) await rm(path.join(out, 'server'), { recursive: true, force: true });
	console.log(JSON.stringify({ seed, ...start }));
	process.exit(0);
}
const survey = JSON.parse(execFileSync('python3', ['-I', path.join(root, 'scripts/quality/lava-survey.py'), path.join(out, 'server/world'), String(spawn.x), String(spawn.z)], { encoding: 'utf8', maxBuffer: 64 << 20 }));
// Each pool's shore: most cave pools fill a sealed pocket wall to wall; a cast needs dry ground beside the lava.
const near = survey.usable.filter(p => p.dist <= radius);
const shores = near.length ? execFileSync('python3', ['-I', path.join(root, 'scripts/quality/cave-start.py'), path.join(out, 'server/world'), ...near.map(p => `${p.x},${p.y},${p.z}`)],
	{ encoding: 'utf8', maxBuffer: 64 << 20 }).trim().split('\n').map(line => JSON.parse(line)) : [];
survey.shores = shores;
await writeFile(path.join(out, 'survey.json'), JSON.stringify({ seed: String(seed), spawn, radius, ...survey }, null, 1));
await rm(path.join(out, 'server'), { recursive: true, force: true });
console.log(JSON.stringify({ seed, spawn, fullChunks: survey.fullChunks, pools: survey.pools, withStart: shores.filter(row => row.start) }));
process.exit(0);
