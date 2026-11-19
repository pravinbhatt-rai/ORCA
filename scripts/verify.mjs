import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const checks=[];
for(const [name,args] of [['Build',['run','build']],['Runtime, security, and HTTP integration tests',['test']]]){
  const result=spawnSync('npm',args,{encoding:'utf8'});const output=(result.stdout||'')+(result.stderr||'');
  checks.push({name,status:result.status===0?'PASS':'FAIL',output:output.trim()});process.stdout.write(`\n${result.status===0?'PASS':'FAIL'} ${name}\n${output}`);
  if(result.status!==0) process.exitCode=1;
}
const nativeSecrets=spawnSync(process.execPath,['--test','packages/daemon/test/secrets-native.test.mjs'],{encoding:'utf8',env:{...process.env,ORCHESTRA_VERIFY_NATIVE_SECRETS:'1'}});
const nativeOutput=(nativeSecrets.stdout||'')+(nativeSecrets.stderr||'');
const nativeStatus=nativeSecrets.status===0?(nativeOutput.includes('# skipped 1')?'SKIP':'PASS'):'FAIL';
checks.push({name:`Native ${process.platform} secret-store integration`,status:nativeStatus,output:nativeOutput.trim()});
process.stdout.write(`\n${nativeStatus} Native ${process.platform} secret-store integration\n${nativeOutput}`);
if(nativeStatus==='FAIL')process.exitCode=1;
const backlog = readFileSync(resolve('docs/IMPLEMENTATION_TODO.md'), 'utf8');
const openItems = [...backlog.matchAll(/^\s*- \[ \] (.+)$/gm)]
  .map((m) => m[1])
  .filter((item) => !/^(Close every |Keep |Required local checks)/.test(item));
const completedItems = [...backlog.matchAll(/^\s*- \[x\] (.+)$/gim)].length;
const auditStatus = openItems.length === 0 ? 'PASS' : 'FAIL';
const auditOutput = openItems.length === 0
  ? `All ${completedItems} tracked implementation requirements are closed.`
  : `${openItems.length} tracked implementation requirements remain open; ${completedItems} are closed.\n${openItems.map((item) => `OPEN: ${item}`).join('\n')}`;
checks.push({name:'Implementation requirements audit',status:auditStatus,output:auditOutput});
process.stdout.write(`\n${auditStatus} Implementation requirements audit\n${auditOutput}\n`);
if (auditStatus === 'FAIL') process.exitCode = 1;
const report=['# Verification report','',`Run date: ${new Date().toISOString()}`,'','| Check | Result |','|---|---|',...checks.map(c=>`| ${c.name} | ${c.status} |`),'','## Command output','',...checks.flatMap(c=>[`### ${c.name}`, '', '```text', c.output, '```','']),'## Outstanding requirements','',...(openItems.length?openItems.map(item=>`- [ ] ${item}`):['- None.']),'','## Skipped or unavailable checks','','- No external provider, OAuth connector, browser automation, desktop accessibility, GPU fine-tune, or VS Code extension package check was run in this invocation. These are not reported as passing.','- See `docs/KNOWN_LIMITS.md` for known implementation gaps and environmental constraints.',''].join('\n');
mkdirSync(resolve('docs'),{recursive:true});writeFileSync(resolve('docs/VERIFICATION_REPORT.md'),report);
