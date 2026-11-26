// Flip every env-read switch away from its default at once; the reflex book must still arm each dimension.
import { SWITCHES, resolveSwitches } from '../../coordinator/src/switches.mjs';
import { ReflexBook, DEFAULT_REFLEXES, DIMENSION_REFLEXES } from '../../coordinator/src/reflexes.mjs';
const env = {}, flipped = [], unflippable = [];
for (const sw of SWITCHES) {
  if (!sw.env || sw.status !== 'default-on') continue;
  const base = resolveSwitches({}).get(sw.name)?.value;
  const pick = ['off', 'false', '0'].find(v => { try { return JSON.stringify(resolveSwitches({ [sw.env]: v }).get(sw.name)?.value) !== JSON.stringify(base); } catch { return false; } });
  if (pick === undefined) { unflippable.push(sw.name); continue; }
  env[sw.env] = pick; flipped.push(`${sw.name}=${pick}`);
}
const out = { flipped, unflippable, dims: {} };
Object.assign(process.env, env);
const { ReflexBook: Fresh } = await import('../../coordinator/src/reflexes.mjs?flip=' + Date.now());
for (const dim of ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end']) {
  const book = new Fresh({ defaults: DEFAULT_REFLEXES, dimensionDefaults: DIMENSION_REFLEXES });
  book.observeContext('a', { ready: true, world: { dimension: dim }, player: { health: 20 }, inventory: { items: [] } });
  out.dims[dim] = book.payload('a').rules.length;
}
for (const dim of Object.keys(out.dims)) { const b = new ReflexBook({ defaults: DEFAULT_REFLEXES, dimensionDefaults: DIMENSION_REFLEXES }); b.observeContext('a', { ready: true, world: { dimension: dim }, player: { health: 20 }, inventory: { items: [] } }); out.dims[dim] = { flipped: out.dims[dim], defaults: b.payload('a').rules.length }; }
console.log(JSON.stringify(out, null, 1));
