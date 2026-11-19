import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deleteSecret, readSecret, storeSecret } from '../src/secrets.mjs';

const platform=process.platform;
const available=platform==='darwin'
 ? spawnSync('/usr/bin/which',['swiftc'],{encoding:'utf8'}).status===0
 : platform==='linux'
  ? Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)&&spawnSync('which',['secret-tool'],{encoding:'utf8'}).status===0
  : platform==='win32'
   ? spawnSync('where.exe',['powershell.exe'],{encoding:'utf8'}).status===0
   : false;

test('native OS credential vault stores, reads, rotates and deletes without argv secrets',{skip:process.env.ORCHESTRA_VERIFY_NATIVE_SECRETS!=='1'?'run through npm run verify to exercise OS vault':!available?`native vault prerequisites unavailable on ${platform}`:false},async()=>{
 const reference=`verification-${randomUUID()}`,first=randomBytes(32).toString('hex'),rotated=randomBytes(32).toString('hex');
 try{
  await storeSecret(reference,first);assert.equal(await readSecret(reference),first);
  await storeSecret(reference,rotated);assert.equal(await readSecret(reference),rotated);
 }finally{await deleteSecret(reference);}
 assert.equal(await readSecret(reference),null);
});
