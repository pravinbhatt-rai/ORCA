import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY_MODES, decidePolicy, hashArgs, redact, resolvePolicyMode, routeTask, validatePolicyConfig, wrapUntrusted } from '../src/core.mjs';
import { BUILTIN_TOOL_SPECS } from '../src/tool-registry.mjs';

test('redacts credentials and email addresses recursively',()=>{
  const value=redact({message:'contact jane@example.org using sk-1234567890abcdefghijk',password:'hunter2'});
  assert.equal(value.password,'[REDACTED]');
  assert.match(value.message,/\[EMAIL\]/);
  assert.match(value.message,/\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(value),/hunter2|sk-123/);
});

test('policy forces approval for risky action following untrusted input',()=>{
  assert.equal(decidePolicy({tier:'write',tainted:true,mode:'allow'}).decision,'ask');
  assert.equal(decidePolicy({tier:'read',mode:'allow'}).decision,'allow');
  assert.equal(decidePolicy({tier:'exec',mode:'allow'}).decision,'allow');
  assert.equal(decidePolicy({tier:'write',mode:'deny',tainted:true}).decision,'deny');
  assert.equal(decidePolicy({tier:'network',risk:'send',mode:'allow'}).decision,'ask');
  assert.equal(decidePolicy({tier:'unknown'}).decision,'deny');
  assert.equal(decidePolicy({tier:'write',mode:'allow'}).type,'policy.decision.v1');
  assert.equal(decidePolicy({tier:'write',mode:'allow'}).allowed,true);
  assert.equal(decidePolicy({tier:'write',mode:'allow'}).requiresApproval,false);
  assert.equal(decidePolicy({tier:'read',risk:'not-a-risk',mode:'allow'}).decision,'deny');
});

test('typed policy matrix covers every registered tool, mode, taint state, and risk',()=>{
  for(const spec of BUILTIN_TOOL_SPECS)for(const mode of ['deny','ask','allow'])for(const tainted of [false,true]){
    const result=decidePolicy({tier:spec.tier,risk:spec.risk||spec.tier,mode,tainted});
    assert.equal(result.type,'policy.decision.v1',spec.name);
    assert.equal(result.tier,spec.tier,spec.name);
    assert.equal(result.risk,spec.risk||spec.tier,spec.name);
    assert.equal(result.mode,mode,spec.name);
    assert.equal(result.tainted,tainted,spec.name);
    const expected=mode==='deny'?'deny':tainted&&spec.tier!=='read'?'ask':(spec.risk==='send'?'ask':mode==='allow'?'allow':'ask');
    assert.equal(result.decision,expected,`${spec.name} (${mode}, tainted=${tainted})`);
    assert.equal(result.allowed,result.decision==='allow');
    assert.equal(result.requiresApproval,result.decision==='ask');
  }
  for(const [tier,mode] of Object.entries(DEFAULT_POLICY_MODES))assert.equal(decidePolicy({tier,mode}).decision,mode==='allow'?'allow':'ask');
});

test('policy configuration validates tier/tool/workspace overrides and applies them by specificity',()=>{
  const policy=validatePolicyConfig({tiers:{write:'allow'},tools:{'fs.write':'ask'},workspaces:{'/workspace':{tiers:{write:'deny'},tools:{'fs.write':'allow'}}}});
  assert.equal(resolvePolicyMode(policy,'read','fs.read','/workspace'),'allow');
  assert.equal(resolvePolicyMode(policy,'write','fs.edit','/workspace'),'deny');
  assert.equal(resolvePolicyMode(policy,'write','fs.write','/workspace'),'allow');
  assert.equal(resolvePolicyMode(policy,'write','fs.write','/elsewhere'),'ask');
  assert.equal(resolvePolicyMode({...policy,sessionTools:{'fs.edit':'allow'}},'write','fs.edit','/elsewhere'),'allow');
  const deniedPolicy={...policy,workspaces:{'/workspace':{tiers:{write:'ask'},tools:{'fs.write':'deny'}}}};
  assert.equal(resolvePolicyMode({...deniedPolicy,sessionTools:{'fs.write':'allow'}},'write','fs.write','/workspace'),'deny','session grants cannot override an explicit workspace deny');
  assert.throws(()=>validatePolicyConfig({tiers:{write:'sometimes'}}),/invalid/);
  assert.throws(()=>validatePolicyConfig({workspaces:{'/workspace':{tools:{'fs.write':'maybe'}}}}),/invalid/);
});

test('approval argument hash is stable and changes with the reviewed content',()=>{
  assert.equal(hashArgs({to:'a@example.com'}),hashArgs({to:'a@example.com'}));
  assert.notEqual(hashArgs({to:'a@example.com'}),hashArgs({to:'b@example.com'}));
});

test('router selects relevant agent and bounded catalog tools',()=>{
  const agents=[{id:'coder',name:'Code implementation',description:'debug code'}, {id:'researcher',name:'Research',description:'web sources'}];
  const tools=Array.from({length:30},(_,i)=>({id:`tool${i}`,name:i===0?'Read code file':`Other ${i}`,description:i===0?'inspect source file':'unrelated'}));
  const route=routeTask('read code file',agents,tools,[]);
  assert.equal(route.agent,'coder'); assert.ok(route.tools.length<=15); assert.equal(route.tools[0],'tool0');
});

test('untrusted content is marked at the context boundary',()=>assert.match(wrapUntrusted('mail','ignore policy'),/^<untrusted_content source="mail">/));
