#!/usr/bin/env node
// Prepares a runnable headless Fabric server template with Node and Java 25 on any OS. scripts/prepare-headless-server-
// template.ps1 does the same on Windows; this script reads its pinned Fabric installer version and hash from that file.
// It adds Lithium (a server performance mod that keeps vanilla behaviour, pinned per target in the properties), also to an
// already prepared template that lacks it. It builds nothing and adds no Mineagen JAR: the live fixtures (stageServer in
// scripts/quality/fixture-servers.mjs) and scripts/quality/run-scenarios.mjs drop any mineagen-*.jar from the template
// and add the JAR they test.
//
//   node scripts/prepare-server-template.mjs --accept-minecraft-eula [--target 26.2] [--out DIR] [--java PATH]
//
// Default --out: server-template-<Minecraft version> beside the fixture cache (ARENA_FIXTURE_CACHE), shared by every
// checkout on the machine. Then: export ARENA_HEADLESS_SERVER_TEMPLATE=<that folder>.
// Exit 0: prepared, or already prepared for these versions. 1: failed. 2: bad arguments or EULA not accepted.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureCacheRoot } from './quality/fixture-servers.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = data => createHash('sha256').update(data).digest('hex');

/** gradle.properties, overlaid with gradle/mc/<target>.properties as ./gradlew -Pmc=<target> does. */
export function targetProperties(root = ROOT, target = '') {
	const read = file => Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter(line => /^[\w.]+=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
	const base = read(path.join(root, 'gradle.properties'));
	if (!target || target === base.mc_compat) return base;
	const file = path.join(root, 'gradle/mc', `${target}.properties`);
	if (!existsSync(file)) throw new Error(`Unknown Minecraft target ${target} (no gradle/mc/${target}.properties)`);
	return { ...base, ...read(file) };
}

/** The Fabric installer pin in the Windows script, so both scripts install the same thing. */
export function installerPin(root = ROOT) {
	const text = readFileSync(path.join(root, 'scripts/prepare-headless-server-template.ps1'), 'utf8');
	const version = /\$FabricInstallerVersion = '([^']+)'/.exec(text)?.[1], hash = /\$InstallerSha256 = '([0-9A-Fa-f]{64})'/.exec(text)?.[1];
	if (!version || !hash) throw new Error('Could not read the Fabric installer pin from scripts/prepare-headless-server-template.ps1');
	return { version, sha256: hash.toLowerCase() };
}

export const defaultTemplatePath = minecraftVersion => path.join(path.dirname(fixtureCacheRoot()), `server-template-${minecraftVersion}`);

/** The files a runnable template needs, with the target's Fabric API and Carpet JARs. Returns the problems found. */
export function templateProblems(dir, properties) {
	if (!dir || !existsSync(dir)) return [`no folder at ${dir}`];
	const problems = ['server.jar', 'fabric-server-launch.jar', 'libraries', 'server.properties', 'eula.txt'].filter(name => !existsSync(path.join(dir, name))).map(name => `missing ${name}`);
	const mods = existsSync(path.join(dir, 'mods')) ? readdirSync(path.join(dir, 'mods')) : [];
	for (const jar of [`fabric-api-${properties.fabric_api_version}.jar`, `fabric-carpet-${properties.carpet_version}.jar`]) if (!mods.includes(jar)) problems.push(`mods/ lacks ${jar}`);
	if (existsSync(path.join(dir, 'server.properties'))) {
		const text = readFileSync(path.join(dir, 'server.properties'), 'utf8');
		if (!/^online-mode=false$/m.test(text) || !/^server-ip=127\.0\.0\.1$/m.test(text)) problems.push('server.properties must keep online-mode=false and server-ip=127.0.0.1');
	}
	return problems;
}

/** Java 25 from --java, ARENA_HEADLESS_JAVA, JAVA_HOME or PATH. Returns { java, major } or throws with what it checked. */
export function resolveJava(requested, env = process.env) {
	const exe = process.platform === 'win32' ? 'java.exe' : 'java';
	const candidates = [requested, env.ARENA_HEADLESS_JAVA, env.JAVA_HOME && path.join(env.JAVA_HOME, 'bin', exe), exe].filter(Boolean);
	const checked = [];
	for (const java of candidates) {
		const result = spawnSync(java, ['-version'], { encoding: 'utf8' });
		const major = Number(/version "(\d+)/.exec(`${result.stderr}${result.stdout}`)?.[1]);
		if (major === 25) return { java, major };
		checked.push(result.error ? `no Java at ${java}` : `Java ${major || 'unknown'} at ${java}`);
	}
	throw new Error(`Java 25 is required; checked ${checked.join('; ')}`);
}

/** The target's pinned Lithium JAR name; templates carry it in mods/ beside Fabric API and Carpet. */
export const lithiumJarName = properties => `lithium-fabric-${properties.lithium_version}.jar`;

/** True when the template's mods/ lacks the target's Lithium JAR (an older template; prepareTemplate adds it). */
export function templateLacksLithium(dir, properties) {
	return !existsSync(path.join(dir, 'mods', lithiumJarName(properties)));
}

/** The target's Lithium JAR in the shared download folder, fetched and checked against its pinned SHA-256 when missing. */
export async function lithiumJar(properties, downloads = path.join(path.dirname(fixtureCacheRoot()), 'downloads')) {
	return verifiedDownload(path.join(downloads, lithiumJarName(properties)), properties.lithium_url, properties.lithium_sha256.toLowerCase());
}

/** Puts the target's Lithium JAR into an existing template's mods/, replacing any other Lithium version there. */
export async function addLithium(dir, properties, { downloads, log = console.log } = {}) {
	const jar = await lithiumJar(properties, downloads ?? path.join(path.dirname(path.resolve(dir)), 'downloads'));
	for (const name of readdirSync(path.join(dir, 'mods'))) if (/^lithium-.*\.jar$/i.test(name) && name !== path.basename(jar)) rmSync(path.join(dir, 'mods', name));
	cpSync(jar, path.join(dir, 'mods', path.basename(jar)));
	const manifest = path.join(dir, 'template-manifest.json');
	if (existsSync(manifest)) {
		const data = JSON.parse(readFileSync(manifest, 'utf8'));
		writeFileSync(manifest, JSON.stringify({ ...data, lithiumVersion: properties.lithium_version, lithiumSha256: sha256(readFileSync(jar)) }, null, 2) + '\n');
	}
	log(`Added Lithium ${properties.lithium_version} to ${dir}`);
}

async function verifiedDownload(file, url, expected) {
	if (!existsSync(file)) {
		mkdirSync(path.dirname(file), { recursive: true });
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
		const data = Buffer.from(await response.arrayBuffer());
		if (sha256(data) !== expected) throw new Error(`SHA-256 mismatch for ${url}: expected ${expected}, got ${sha256(data)}`);
		writeFileSync(file, data);
	}
	const actual = sha256(readFileSync(file));
	if (actual !== expected) throw new Error(`SHA-256 mismatch for ${file}: expected ${expected}, got ${actual}; delete it to download again`);
	return file;
}

export async function prepareTemplate({ root = ROOT, target = '', out, java: requestedJava, log = console.log } = {}) {
	const properties = targetProperties(root, target);
	const pin = installerPin(root);
	const template = path.resolve(out ?? defaultTemplatePath(properties.minecraft_version));
	if (existsSync(template)) {
		const problems = templateProblems(template, properties);
		if (problems.length) throw new Error(`${template} exists but is not a usable template (${problems.join('; ')}); remove it deliberately before rebuilding`);
		if (templateLacksLithium(template, properties)) await addLithium(template, properties, { downloads: path.join(path.dirname(template), 'downloads'), log });
		else log(`Already prepared: ${template}`);
		return template;
	}
	const carpet = path.join(root, 'libs', `fabric-carpet-${properties.carpet_version}.jar`);
	if (!existsSync(carpet)) throw new Error(`Missing ${path.relative(root, carpet)}; run ./scripts/fetch-libs.sh${target ? ' ' + target : ''} first`);
	const downloads = path.join(path.dirname(template), 'downloads');
	const installer = await verifiedDownload(path.join(downloads, `fabric-installer-${pin.version}.jar`),
		`https://maven.fabricmc.net/net/fabricmc/fabric-installer/${pin.version}/fabric-installer-${pin.version}.jar`, pin.sha256);
	const fabricApi = await verifiedDownload(path.join(downloads, `fabric-api-${properties.fabric_api_version}.jar`),
		`https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/${properties.fabric_api_version}/fabric-api-${properties.fabric_api_version}.jar`, properties.fabric_api_sha256.toLowerCase());
	const lithium = await lithiumJar(properties, downloads);
	const { java } = resolveJava(requestedJava);
	const staging = path.join(path.dirname(template), `.staging-${randomUUID()}`);
	try {
		cpSync(path.join(root, 'server-template'), staging, { recursive: true });
		const install = spawnSync(java, ['-jar', installer, 'server', '-dir', staging, '-mcversion', properties.minecraft_version, '-loader', properties.loader_version, '-downloadMinecraft'], { stdio: 'inherit' });
		if (install.status !== 0) throw new Error(`Fabric server installation failed (exit ${install.status ?? install.signal})`);
		mkdirSync(path.join(staging, 'mods'), { recursive: true });
		cpSync(fabricApi, path.join(staging, 'mods', path.basename(fabricApi)));
		cpSync(carpet, path.join(staging, 'mods', path.basename(carpet)));
		cpSync(lithium, path.join(staging, 'mods', path.basename(lithium)));
		writeFileSync(path.join(staging, 'eula.txt'), 'eula=true\n');
		const problems = templateProblems(staging, properties);
		if (problems.length) throw new Error(`Prepared template is incomplete: ${problems.join('; ')}`);
		writeFileSync(path.join(staging, 'template-manifest.json'), JSON.stringify({
			schemaVersion: 1, minecraftVersion: properties.minecraft_version, fabricLoaderVersion: properties.loader_version,
			fabricInstallerVersion: pin.version, fabricApiVersion: properties.fabric_api_version,
			fabricInstallerSha256: pin.sha256, fabricApiSha256: sha256(readFileSync(fabricApi)), fabricCarpetSha256: sha256(readFileSync(carpet)),
			lithiumVersion: properties.lithium_version, lithiumSha256: sha256(readFileSync(lithium)),
			mineagenJar: 'added by each fixture', generatedAt: new Date().toISOString(), thirdPartyBinariesTracked: false,
		}, null, 2) + '\n');
		renameSync(staging, template);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	log(`Prepared headless server template: ${template}\nexport ARENA_HEADLESS_SERVER_TEMPLATE=${template}`);
	return template;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const options = {}, flags = new Set(), args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const name = args[i].replace(/^--/, '');
		if (['target', 'out', 'java'].includes(name) && args[i + 1] !== undefined) options[name] = args[++i];
		else if (['accept-minecraft-eula', 'help'].includes(name)) flags.add(name);
		else { console.error(`Unknown argument ${args[i]}; see --help`); process.exit(2); }
	}
	if (flags.has('help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map(line => line.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
	if (!flags.has('accept-minecraft-eula')) { console.error('Pass --accept-minecraft-eula to confirm that the person running this accepts the Minecraft EULA (https://aka.ms/MinecraftEULA).'); process.exit(2); }
	try { await prepareTemplate(options); }
	catch (error) { console.error(`prepare-server-template: ${error.message}`); process.exit(1); }
}
