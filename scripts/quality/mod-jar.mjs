// The default-target mod JAR a build writes, named from mod_version in gradle.properties, so live scripts follow a
// version bump instead of reading a stale or missing JAR. Relative to the repository root.
import { readFileSync } from 'node:fs';

const properties = readFileSync(new URL('../../gradle.properties', import.meta.url), 'utf8');
export const MOD_VERSION = /^mod_version=(.+)$/m.exec(properties)?.[1].trim();
if (!MOD_VERSION) throw new Error('gradle.properties has no mod_version');
export const MOD_JAR = `build/libs/mineagen-${MOD_VERSION}.jar`;
