import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REFLEXES, MAX_REFLEXES, ReflexBook, normalizeReflexEntries } from '../src/reflexes.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';

const live = (dimension = 'minecraft:the_nether') => ({ world: { dimension }, player: { health: 20 } });

test('incoming known lava has its own escape trigger before contact, retaining contact protection', () => {
 const book = new ReflexBook();
 book.observeContext('a', live());
 const payload = book.payload('a');
 const flow = payload.rules.find(({id}) => id === 'default-lava-flow');
 assert.ok(flow, 'the default set protects the model latency before lava contact');
 assert.deepEqual(flow.when, [{type:'lava_flowing', withinS:4}]);
 assert.deepEqual(flow.do, {type:'leave_lava'});
 assert.equal(flow.kind, 'trigger');
 assert.equal(flow.priority, 9);
 assert.equal(flow.coordinatorDefault, true);
 const contact = payload.rules.find(({id}) => id === 'default-lava');
 assert.deepEqual(contact.when, [{type:'in_lava'}]);
 assert.deepEqual(contact.do, {type:'leave_lava'});
 assert.equal(book.observeContext('a', live()), false);
});

test('flow default can be removed independently, rearms at dimension change, and keeps all model slots', () => {
 const book = new ReflexBook();
 book.observeContext('a', live());
 book.apply('a', normalizeReflexEntries([{id:'default-lava-flow',remove:true}]));
 assert.ok(book.rules('a').some(({id}) => id === 'default-lava'));
 assert.ok(!book.rules('a').some(({id}) => id === 'default-lava-flow'));
 book.observeContext('a', live('minecraft:overworld'));
 assert.ok(book.rules('a').some(({id}) => id === 'default-lava-flow'));
 book.apply('a', normalizeReflexEntries(Array.from({length:MAX_REFLEXES}, (_,i) => ({id:`own-${i}`,when:{type:'in_fire'},do:{type:'leave_fire'}}))));
 const payload = book.payload('a');
 assert.equal(payload.rules.length, MAX_REFLEXES + DEFAULT_REFLEXES.length);
 assert.equal(validateProtocolV2Payload('reflex_update',payload).rules.length,27);
});
