import assert from 'node:assert/strict';
import test from 'node:test';
import { blazeBlocksErrand, searchDanger } from '../src/search-danger.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';
import { factToWireObservation } from './fixtures/dynamic-main-fixture.mjs';
import { DEFAULT_REFLEXES, MAX_REFLEXES, ReflexBook, normalizeReflexEntries } from '../src/reflexes.mjs';
import { checkedObtainBody, runObtain } from './helpers/checked-body.mjs';

function view({visible=true,targeting=false,distance=10,items=[],blocks=[]}={}) {
 const w=factToWireObservation({player:{health:20},inventory:{items},blocks},1,1,false,1000);
 w.threats={entries:[{uuid:'blaze-a',type:'minecraft:blaze',distance,bearing:0,targeting,swelling:false,lineOfSight:visible,visible,signals:[]}]};
 return adaptObservation(w);
}

test('production adapter makes current blaze LOS block errands, not hidden/heard stale reports',()=>{
 assert.ok(blazeBlocksErrand(view()));
 assert.match(searchDanger(view()).fork,/errand/);
 assert.equal(blazeBlocksErrand(view({visible:false,targeting:true,distance:10})),null);
 assert.ok(blazeBlocksErrand(view({visible:false,targeting:true,distance:2})));
 for(const change of [{ready:false},{continuity:{phase:'dead'}},{continuity:{rememberedSections:['player']}},{player:{dead:true}}])assert.equal(blazeBlocksErrand({...view(),...change}),null);
 const peaceful=view();peaceful.player.threats=[];assert.equal(blazeBlocksErrand(peaceful),null);
});

test('default cover reaches native wire without using the twelve model slots; hazard/shield priorities still win',()=>{
 const book=new ReflexBook();book.observeContext('a',view());
 book.apply('a',normalizeReflexEntries(Array.from({length:MAX_REFLEXES},(_,i)=>({id:'own-'+i,when:{type:'on_fire'},do:{type:'leave_fire'}}))));
 const rules=book.payload('a').rules,cover=rules.find(r=>r.id==='default-blaze-cover');
 assert.equal(rules.length,27);assert.ok(cover);assert.equal(cover.do.type,'take_cover');
 assert.ok(cover.when.some(c=>c.type==='exposed'&&c.mobs.includes('minecraft:blaze')));
 for(const mob of ['minecraft:skeleton','minecraft:stray','minecraft:bogged'])assert.ok(cover.when.some(c=>c.type==='exposed'&&c.mobs.includes(mob)),'bow skeletons are covered too (K8): '+mob);
 for(const id of ['default-lava','default-lava-flow','default-air','default-fire','default-arrow','default-retreat'])assert.ok(DEFAULT_REFLEXES.find(r=>r.id===id).priority>cover.priority,id);
 book.apply('a',normalizeReflexEntries([{id:'default-blaze-cover',remove:true}]));
 assert.equal(book.payload('a').rules.some(r=>r.id==='default-blaze-cover'),false,'model can deliberately disable it');
});

test('resource obtain stops before any search or gather dispatch under seen blazes',async()=>{
 const calls=[],o=view(), body={note:()=>{},observe:async()=>o,interrupted:()=>false,stopped:()=>false,
 act:async(t)=>{calls.push(t);return{state:'FAILED',reasonCode:'NO_SOURCE'};},
 search:async()=>{calls.push('search');return{state:'FAILED',reasonCode:'NO_SOURCE'};},
 gather:async()=>{calls.push('gather');return{state:'FAILED',reasonCode:'NO_SOURCE'};},
 moveTo:async()=>{calls.push('move');return{state:'FAILED',reasonCode:'NO_ROUTE'};},mine:async()=>{calls.push('mine');return{state:'FAILED',reasonCode:'NO_TOOL'};}};
 const result=await runObtain({item:'diamond',timeoutMs:10000},checkedObtainBody(body));
 assert.equal(result.reasonCode,'DANGER');assert.equal(result.state,'INTERRUPTED');assert.equal(calls.some(c=>['search','gather','move','travel_to','dig_to'].includes(c)),false);
});


test('held bow inputs can still be crafted at a known table without an errand',async()=>{
 const o=view({items:[{itemId:'minecraft:stick',count:3},{itemId:'minecraft:string',count:3}],blocks:[{blockId:'minecraft:crafting_table',x:1,y:64,z:0}]});
 const calls=[],body={note:()=>{},observe:async()=>o,interrupted:()=>false,stopped:()=>false,
 act:async(type)=>{calls.push(type);if(type==='craft_table'){o.inventory.items.push({itemId:'minecraft:bow',count:1,slot:2});return{state:'SUCCEEDED',reasonCode:'CRAFT_CONFIRMED'};}return{state:'FAILED',reasonCode:'UNEXPECTED_TEST_ACTION'};},
 search:async()=>{throw Error('unexpected resource search');},gather:async()=>{throw Error('unexpected gather');}};
 const result=await runObtain({item:'bow',timeoutMs:10000},checkedObtainBody(body));
 assert.equal(result.reasonCode,'OBTAINED');assert.ok(calls.includes('craft_table'));
 assert.equal(calls.some(t=>['travel_to','dig_to','navigate_to'].includes(t)),false);
});
