import assert from 'node:assert/strict';
import test from 'node:test';
import { MINECRAFT_DYNAMIC_TOOLS, normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const help = MINECRAFT_DYNAMIC_TOOLS.find(tool => tool.name === 'do_step').description;

test('primary step help names direct frame casting after a portal build refusal', () => {
 assert.match(help, /after a refused Overworld portal build, do_step cast_obsidian target:\{frame:true,x,y,z,axis:x\|z\} attempts a frame: water_bucket, empty bucket, dry footing within bucket reach of a lava source/);
 assert.match(help, /choose its lowest corner; resume:true pins the body-reported x,y,z,axis and requires frame:true; default false may relocate/);
 assert.ok(help.indexOf('after a refused Overworld portal build') < help.indexOf('until "seen:'), 'the existing smaller hand is explained before generic step guidance');
 assert.ok(Buffer.byteLength(JSON.stringify(MINECRAFT_DYNAMIC_TOOLS)) <= 39_476, 'the advice fits the current complete tool payload budget');
});

test('the advertised smaller hand is an ordinary background step with the model chosen frame preserved', () => {
 for (const axis of ['x', 'z']) {
  const target = { frame: true, x: 12, y: -54, z: 20, axis };
  const call = normalizeMinecraftToolCall('do_step', { verb: 'cast_obsidian', target, why: 'Try the existing frame caster after the site refusal.' });
  assert.equal(call.kind, 'start_action');
  assert.equal(call.actionType, 'cast_obsidian');
  assert.deepEqual(call.arguments, { timeoutMs: 300000, ...target });
 }
});
