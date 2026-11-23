// The mod JAR live scripts load, relative to the repository root: the default-target JAR a build writes, named from
// mod_version in gradle.properties so live scripts follow a version bump instead of reading a stale or missing JAR.
// ARENA_MOD_JAR overrides it for one run (lib/with-jar.mjs sets it to an arm's jar); an absolute path is made relative
// to the root, since scripts join MOD_JAR onto it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const properties = readFileSync(new URL('../../gradle.properties', import.meta.url), 'utf8');
export const MOD_VERSION = /^mod_version=(.+)$/m.exec(properties)?.[1].trim();
if (!MOD_VERSION) throw new Error('gradle.properties has no mod_version');
const root = fileURLToPath(new URL('../..', import.meta.url));
const override = process.env.ARENA_MOD_JAR;
export const MOD_JAR = override ? (path.isAbsolute(override) ? path.relative(root, override) : override) : `build/libs/mineagen-${MOD_VERSION}.jar`;
