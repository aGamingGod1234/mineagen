// Prints shell lines that turn every default-on switch off: env for coordinator/both, -D properties for server-only.
import { SWITCHES, resolveSwitches } from '../../coordinator/src/switches.mjs';
const base = resolveSwitches({}, { properties: {} });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const env = [], props = [], none = [];
for (const sw of SWITCHES) {
  if (sw.status !== 'default-on') continue;
  const want = base.get(sw.name)?.value;
  const tryEnv = sw.env && ['off', 'false', '0'].find(v => { try { return !same(resolveSwitches({ [sw.env]: v }, { properties: {} }).get(sw.name)?.value, want); } catch { return false; } });
  if (tryEnv) { env.push(`${sw.env}=${tryEnv}`); if (sw.side !== 'both' || !sw.property) continue; }
  const tryProp = sw.property && ['false', 'off'].find(v => { try { return !same(resolveSwitches({}, { properties: { [sw.property]: v } }).get(sw.name)?.value, want); } catch { return false; } });
  if (tryProp && !tryEnv) props.push(`-D${sw.property}=${tryProp}`);
  if (!tryEnv && !tryProp) none.push(sw.name);
}
for (const e of env) console.log(`export ${e}`);
console.log(`export SMOKE_OFF_PROPS="${props.join(' ')}"`);
console.log(`# not flippable: ${none.join(',') || 'none'}`);
