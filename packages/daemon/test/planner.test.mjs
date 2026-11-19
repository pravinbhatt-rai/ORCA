import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, validatePlanOutput } from '../src/planner.mjs';

test('website task plan selects only available workers and orders review after implementation',()=>{
 const plan=buildPlan('Create a responsive portfolio website with a contact form','coder',[{id:'planner'},{id:'researcher'},{id:'coder'},{id:'reviewer'}]);
 assert.equal(plan.supervisor,'planner');assert.deepEqual(plan.selected,['researcher','coder','reviewer']);
 assert.deepEqual(plan.items.find(x=>x.key==='implementation').depends,['requirements']);assert.deepEqual(plan.items.find(x=>x.key==='review').depends,['implementation']);
});

test('LLM plan validation rejects invented agents and dependency cycles',()=>{
 const agents=['planner','coder'];assert.equal(validatePlanOutput(JSON.stringify({items:[{key:'x',title:'work',owner:'ghost',depends:[]}]}),agents),null);
 assert.equal(validatePlanOutput(JSON.stringify({items:[{key:'x',title:'work',owner:'coder',depends:['y']},{key:'y',title:'other',owner:'coder',depends:['x']}]}),agents),null);
 const valid=validatePlanOutput(JSON.stringify({items:[{key:'x',title:'work',owner:'coder',depends:[]}],risk:'write'}),agents);assert.equal(valid.items[0].owner,'coder');
});

test('planner computes dependency waves and rejects malformed or oversized dependency lists',()=>{
 const agents=['planner','coder','reviewer'];
 const plan=validatePlanOutput(JSON.stringify({items:[
  {key:'a',title:'First',owner:'coder',depends:[]},
  {key:'b',title:'Independent',owner:'reviewer',depends:[]},
  {key:'c',title:'Final review',owner:'reviewer',depends:['a','b']}
 ]}),agents);
 assert.deepEqual(plan.parallelGroups,[['a','b'],['c']]);
 assert.equal(validatePlanOutput(JSON.stringify({items:[{key:'a',title:'Bad dependency',owner:'coder',depends:'b'}]}),agents),null);
 assert.equal(validatePlanOutput(JSON.stringify({items:Array.from({length:9},(_,i)=>({key:`a${i}`,title:'Task',owner:'coder',depends:[]}))}),agents),null);
});

test('planner falls back to available general agent without inventing IDs',()=>{
 const plan=buildPlan('Do something unusual','missing-agent',[{id:'general'}]);assert.deepEqual(plan.selected,['general']);assert.ok(plan.items.every(x=>['general'].includes(x.owner)));
});
