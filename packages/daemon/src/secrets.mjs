import { spawn } from 'node:child_process';
import { mkdir, writeFile, chmod, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const SERVICE='com.orchestra.local.provider';
const MAX_SECRET_BYTES=4096;
let darwinHelperPromise;

function runProcess(program,args,input,{timeout=5000,maxBuffer=8192}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(program,args,{stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),settled=false;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result);};
  child.stdout.on('data',chunk=>{stdout=Buffer.concat([stdout,chunk]);if(stdout.length>maxBuffer){child.kill();finish(new Error('secret store output exceeded limit'));}});
  child.stderr.on('data',chunk=>{stderr=Buffer.concat([stderr,chunk]);if(stderr.length>maxBuffer){child.kill();finish(new Error('secret store error output exceeded limit'));}});
  child.on('error',()=>finish(new Error('secure secret store is unavailable')));
  child.on('close',code=>code===0?finish(null,{stdout:stdout.toString('utf8')}):finish(new Error('secure secret store operation failed')));
  const timer=setTimeout(()=>{child.kill();finish(new Error('secure secret store timed out'));},timeout);
  child.stdin.on('error',()=>{});child.stdin.end(input??'');
 });
}

const WINDOWS_SCRIPT=String.raw`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class OrchestraCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
 [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
 [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
 [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr buffer);
 public static bool Put(string target,string value) { byte[] bytes=Encoding.UTF8.GetBytes(value); if(bytes.Length>2500)throw new Exception("Credential exceeds Windows Credential Manager limit"); IntPtr blob=Marshal.AllocHGlobal(bytes.Length); try { Marshal.Copy(bytes,0,blob,bytes.Length); var c=new CREDENTIAL { Type=1, TargetName=target, CredentialBlobSize=(UInt32)bytes.Length, CredentialBlob=blob, Persist=2, UserName="Orchestra" }; return CredWrite(ref c,0); } finally { for(int i=0;i<bytes.Length;i++)Marshal.WriteByte(blob,i,0); Marshal.FreeHGlobal(blob); Array.Clear(bytes,0,bytes.Length); } }
 public static string Get(string target) { IntPtr p; if(!CredRead(target,1,0,out p))return null; try { var c=Marshal.PtrToStructure<CREDENTIAL>(p); var bytes=new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob,bytes,0,bytes.Length); try{return Encoding.UTF8.GetString(bytes);}finally{Array.Clear(bytes,0,bytes.Length);} } finally { CredFree(p); } }
}
'@
$inputObject=[Console]::In.ReadToEnd() | ConvertFrom-Json
$target='Orchestra/'+$inputObject.reference
switch($inputObject.action){
 'store' { if(-not [OrchestraCredential]::Put($target,[string]$inputObject.value)){throw 'Credential write failed'} }
 'read' { $value=[OrchestraCredential]::Get($target); if($null -ne $value){[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))) } }
 'delete' { [void][OrchestraCredential]::CredDelete($target,1,0) }
 default { throw 'Unknown operation' }
}`;
const WINDOWS_ARGS=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(WINDOWS_SCRIPT,'utf16le').toString('base64')];

const DARWIN_HELPER_SOURCE=`import Foundation
import Security
let args=CommandLine.arguments
guard args.count==3 else { exit(2) }
let action=args[1], reference=args[2]
let input=try JSONSerialization.jsonObject(with:FileHandle.standardInput.readDataToEndOfFile()) as! [String:Any]
let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"${SERVICE}",kSecAttrAccount as String:reference]
switch action {
case "store":
 let value=input["value"] as! String
 let attrs:[String:Any]=[kSecValueData as String:Data(value.utf8),kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
 let status=SecItemUpdate(query as CFDictionary,attrs as CFDictionary)
 if status==errSecItemNotFound { var item=query; for (key,value) in attrs { item[key]=value }; let added=SecItemAdd(item as CFDictionary,nil); if added != errSecSuccess { exit(10) } }
 else if status != errSecSuccess { exit(11) }
case "read":
 var request=query; request[kSecReturnData as String]=true; request[kSecMatchLimit as String]=kSecMatchLimitOne
 var result:CFTypeRef?; let status=SecItemCopyMatching(request as CFDictionary,&result)
 if status==errSecItemNotFound { print(""); break }; if status != errSecSuccess { exit(12) }
 let data=result as! Data; print(data.base64EncodedString())
case "delete":
 let status=SecItemDelete(query as CFDictionary); if status != errSecSuccess && status != errSecItemNotFound { exit(13) }
default: exit(2)
}`;

async function darwinHelper(){
 if(!darwinHelperPromise)darwinHelperPromise=(async()=>{const uid=process.getuid?.()??0,digest=createHash('sha256').update(DARWIN_HELPER_SOURCE).digest('hex').slice(0,16),directory=join(tmpdir(),`orchestra-keychain-helper-${uid}`),source=join(directory,`keychain-${digest}.swift`),binary=join(directory,`keychain-${digest}`);await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);await writeFile(source,DARWIN_HELPER_SOURCE,{mode:0o600});try{await runProcess('/usr/bin/swiftc',['-o',`${binary}.partial`,source],undefined,{timeout:30000,maxBuffer:4096});await rename(`${binary}.partial`,binary);}catch(error){await unlink(`${binary}.partial`).catch(()=>{});throw error;}return binary;})();
 return darwinHelperPromise;
}

export function createSecretStore({platform=process.platform,commandRunner=runProcess,powershell='powershell.exe',darwinHelperPath=null}={}){
 const invoke=async(action,reference,value)=>{
  if(typeof reference!=='string'||!reference||reference.length>500)throw new Error('Secret reference is invalid');
  if(platform==='darwin'){
   const helper=darwinHelperPath||await darwinHelper(),input=action==='store'?JSON.stringify({value}):'{}';
   const result=await commandRunner(helper,[action,reference],input,{timeout:10000,maxBuffer:8192});
   if(action==='read')return {stdout:result.stdout?Buffer.from(result.stdout.trim(),'base64').toString('utf8'):''};
   return result;
  }
  if(platform==='linux'){
   if(action==='store')return commandRunner('secret-tool',['store','--label=Orchestra provider credential','application','orchestra','reference',reference],value,{timeout:5000,maxBuffer:1024});
   if(action==='read')return commandRunner('secret-tool',['lookup','application','orchestra','reference',reference],undefined,{timeout:5000,maxBuffer:8192});
   return commandRunner('secret-tool',['clear','application','orchestra','reference',reference],undefined,{timeout:5000,maxBuffer:1024});
  }
  if(platform==='win32'){
   const input=JSON.stringify({action,reference,value});const {stdout=''}=await commandRunner(powershell,WINDOWS_ARGS,input,{timeout:10000,maxBuffer:8192});
   return action==='read'?{stdout:stdout?Buffer.from(stdout.trim(),'base64').toString('utf8'):''}:{stdout:''};
  }
  throw new Error('No supported OS secret store is available');
 };
 return {
  async storeSecret(reference,value){if(typeof value!=='string'||value.length<8||Buffer.byteLength(value)>MAX_SECRET_BYTES||/[\r\n]/.test(value))throw new Error('API key length or format is invalid');try{await invoke('store',reference,value);}catch{throw new Error('Could not store provider secret in the OS credential vault');}},
  async readSecret(reference){try{const result=await invoke('read',reference);return result.stdout.replace(/[\r\n]+$/,'')||null;}catch{return null;}},
  async deleteSecret(reference){try{await invoke('delete',reference);}catch{}}
 };
}

const nativeStore=createSecretStore();
export const storeSecret=(reference,value)=>nativeStore.storeSecret(reference,value);
export const readSecret=reference=>nativeStore.readSecret(reference);
export const deleteSecret=reference=>nativeStore.deleteSecret(reference);

export function createVSCodeSecretStore(secretStorage){
 if(!secretStorage||typeof secretStorage.store!=='function'||typeof secretStorage.get!=='function'||typeof secretStorage.delete!=='function')throw new Error('VS Code SecretStorage API is required');
 const key=reference=>`orchestra.provider.${reference}`;
 return {storeSecret:(reference,value)=>secretStorage.store(key(reference),value),readSecret:reference=>secretStorage.get(key(reference)),deleteSecret:reference=>secretStorage.delete(key(reference))};
}
