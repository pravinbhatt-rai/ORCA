import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecretStore, createVSCodeSecretStore } from '../src/secrets.mjs';

for(const platform of ['darwin','linux','win32'])test(`${platform} secret adapter keeps credentials off process arguments and round-trips`,async()=>{
 const vault=new Map(),calls=[],runner=async(program,args,input)=>{
  calls.push({program,args,input});let action,reference,value;
  if(platform==='win32'){const request=JSON.parse(input);({action,reference,value}=request);}
  else if(platform==='darwin'){[action,reference]=args;value=input?JSON.parse(input).value:undefined;}
  else {action=args[0]==='lookup'?'read':args[0]==='clear'?'delete':args[0];reference=args[args.indexOf('reference')+1];value=input;}
  if(action==='store')vault.set(reference,value);
  if(action==='delete')vault.delete(reference);
  let stdout='';if(action==='read'){const stored=vault.get(reference)||'';stdout=platform==='win32'||platform==='darwin'?Buffer.from(stored).toString('base64'):stored;}
  return {stdout};
 };
 const store=createSecretStore({platform,commandRunner:runner,...(platform==='darwin'?{darwinHelperPath:'/mock/keychain-helper'}:{})}),secret='sk-test-secret-value-123456789';
 await store.storeSecret('fixture-provider',secret);assert.equal(await store.readSecret('fixture-provider'),secret);
 await store.storeSecret('fixture-provider','sk-rotated-secret-value-987654321');assert.equal(await store.readSecret('fixture-provider'),'sk-rotated-secret-value-987654321');
 await store.deleteSecret('fixture-provider');assert.equal(await store.readSecret('fixture-provider'),null);
 for(const call of calls)assert.ok(!call.args.includes(secret)&&!call.args.includes('sk-rotated-secret-value-987654321'));
 if(platform==='win32')assert.ok(calls.every(call=>call.program==='powershell.exe'&&!call.args.includes(secret)));
});

test('VS Code adapter delegates store, read, rotation and delete to SecretStorage',async()=>{
 const values=new Map(),api={async store(k,v){values.set(k,v)},async get(k){return values.get(k)},async delete(k){values.delete(k)}};
 const store=createVSCodeSecretStore(api);await store.storeSecret('provider-1','secret-value');assert.equal(await store.readSecret('provider-1'),'secret-value');await store.storeSecret('provider-1','rotated-secret');assert.equal(await store.readSecret('provider-1'),'rotated-secret');await store.deleteSecret('provider-1');assert.equal(await store.readSecret('provider-1'),undefined);
});
