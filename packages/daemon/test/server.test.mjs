import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('local API protects data and binds approval to exact arguments',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'orchestra-test-'));
  const port=31000+Math.floor(Math.random()*15000);
  const child=spawn(process.execPath,['packages/daemon/src/server.mjs'],{env:{...process.env,ORCHESTRA_HOME:dir,ORCHESTRA_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let output='',errors=''; child.stdout.on('data',c=>output+=c.toString());child.stderr.on('data',c=>errors+=c.toString());
  t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true})});
  const base=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let i=0;i<80;i++){try{const r=await fetch(base+'/api/status');if(r.status===200){ready=true;break}}catch{} await new Promise(r=>setTimeout(r,50))}
  assert.ok(ready,'daemon starts');
  assert.doesNotMatch(output,/One-time dashboard token:/,'daemon does not print an authentication token');
  const auth={'content-type':'application/json'};
  const cookie={};
  const canvasResponse=await fetch(base+'/api/canvas',{headers:{cookie}});assert.equal(canvasResponse.status,200);const canvas=await canvasResponse.json();assert.ok(canvas.workspace);assert.ok(canvas.agents.some(a=>a.id==='researcher'));assert.ok(Array.isArray(canvas.tools));
  const workflowCreate=await fetch(base+'/api/workflows',{method:'POST',headers:auth,body:JSON.stringify({name:'local research flow',description:'Research then review',definition:{nodes:[{key:'research',title:'Research findings',owner:'researcher',depends:[]},{key:'review',title:'Review findings',owner:'reviewer',depends:['research']}]}})});assert.equal(workflowCreate.status,201);const workflow=await workflowCreate.json();assert.equal(workflow.definition.items.length,2);
  const workflowRead=await (await fetch(base+'/api/workflows',{headers:{cookie}})).json();assert.ok(workflowRead.items.some(w=>w.id===workflow.id));
  const workflowUpdate=await fetch(base+`/api/workflows/${workflow.id}`,{method:'PUT',headers:auth,body:JSON.stringify({name:'edited local research flow'})});assert.equal(workflowUpdate.status,200);assert.equal((await workflowUpdate.json()).name,'edited local research flow');
  const workflowRunResponse=await fetch(base+`/api/workflows/${workflow.id}/run`,{method:'POST',headers:auth,body:'{}'});assert.equal(workflowRunResponse.status,202);const workflowRun=await workflowRunResponse.json();assert.ok(workflowRun.id);
  const liveCanvas=(await (await fetch(base+'/api/canvas',{headers:{cookie}})).json());assert.ok(liveCanvas.runs.some(r=>r.id===workflowRun.id&&r.workflowId===workflow.id));assert.equal(liveCanvas.workflows.find(w=>w.id===workflow.id).definition.items.length,2);
  const workflowDelete=await fetch(base+`/api/workflows/${workflow.id}`,{method:'DELETE',headers:auth});assert.equal(workflowDelete.status,200);assert.equal((await fetch(base+`/api/workflows/${workflow.id}`,{headers:{cookie}})).status,404);
  const directLoopback=await fetch(base+'/api/policy',{method:'PUT',headers:{'content-type':'application/json'},body:'{}'});assert.equal(directLoopback.status,200);
  assert.equal((await fetch(base+'/api/status',{headers:{cookie}})).status,200);
  const providers=await fetch(base+'/api/providers',{headers:{cookie}});assert.equal(providers.status,200);assert.deepEqual((await providers.json()).items,[]);
  const policyResponse=await fetch(base+'/api/policy',{headers:{cookie}});assert.equal(policyResponse.status,200);assert.deepEqual((await policyResponse.json()).policy,{tiers:{},tools:{},workspaces:{},sessionTools:{}});
  const invalidPolicy=await fetch(base+'/api/policy',{method:'PUT',headers:auth,body:JSON.stringify({policy:{tiers:{write:'sometimes'}}})});assert.equal(invalidPolicy.status,400);
  const savedPolicy=await fetch(base+'/api/policy',{method:'PUT',headers:auth,body:JSON.stringify({policy:{tiers:{write:'deny'}}})});assert.equal(savedPolicy.status,200);assert.equal((await savedPolicy.json()).policy.tiers.write,'deny');
  const bad=await fetch(base+'/api/no-such-route',{headers:{cookie}});const badBody=await bad.json();assert.equal(bad.status,404);assert.ok(badBody.error.requestId);assert.equal(badBody.error.code,'NOT_FOUND');assert.ok(badBody.error.suggestion);
  const malformed=await fetch(base+'/api/policy',{method:'PUT',headers:auth,body:'{bad json'});const malformedBody=await malformed.json();assert.equal(malformed.status,400);assert.equal(malformedBody.error.code,'INVALID_JSON');assert.ok(malformedBody.error.requestId);assert.ok(malformedBody.error.suggestion);
  const oversized=await fetch(base+'/api/policy',{method:'PUT',headers:auth,body:'x'.repeat(1_000_001)});const oversizedBody=await oversized.json();assert.equal(oversized.status,413);assert.equal(oversizedBody.error.code,'PAYLOAD_TOO_LARGE');assert.ok(oversizedBody.error.requestId);assert.ok(oversizedBody.error.suggestion);
  const unsafeProvider=await fetch(base+'/api/providers',{method:'POST',headers:auth,body:JSON.stringify({name:'unsafe fixture',type:'openai-compatible',base_url:'https://169.254.169.254/latest',model:'fixture'})});assert.equal(unsafeProvider.status,400);
  const providerCreate=await fetch(base+'/api/providers',{method:'POST',headers:auth,body:JSON.stringify({name:'unreachable fixture',type:'openai-compatible',base_url:'http://127.0.0.1:1/v1',model:'fixture',timeout_ms:1500,max_tokens:100,temperature:.7})});const providerProfile=await providerCreate.json();assert.equal(providerCreate.status,201);
  const providerList=(await (await fetch(base+'/api/providers',{headers:{cookie}})).json()).items.find(x=>x.id===providerProfile.id);assert.equal(providerList.timeout_ms,1500);assert.equal(providerList.max_tokens,100);assert.equal(providerList.temperature,.7);assert.equal(providerList.has_key,false);
  const providerTest=await fetch(base+`/api/providers/${providerProfile.id}/test`,{method:'POST',headers:auth,body:'{}'});const providerError=await providerTest.json();assert.equal(providerTest.status,502);assert.equal(providerError.error.code,'PROVIDER_UNAVAILABLE');assert.equal(providerError.error.message,'Provider connection failed.');assert.doesNotMatch(JSON.stringify(providerError),/fetch failed|127\.0\.0\.1/);assert.ok(providerError.error.requestId);assert.ok(providerError.error.suggestion);
  const failedProvider=(await (await fetch(base+'/api/providers',{headers:{cookie}})).json()).items.find(x=>x.id===providerProfile.id);assert.ok(failedProvider.last_tested_at);assert.ok(failedProvider.last_latency_ms>=0);assert.equal(failedProvider.last_error,'Provider connection failed.');
  const updateProvider=await fetch(base+`/api/providers/${providerProfile.id}`,{method:'PUT',headers:auth,body:JSON.stringify({timeout_ms:2500,max_tokens:256,temperature:.4,enabled:false})});assert.equal(updateProvider.status,200);
  const updatedProvider=(await (await fetch(base+'/api/providers',{headers:{cookie}})).json()).items.find(x=>x.id===providerProfile.id);assert.equal(updatedProvider.timeout_ms,2500);assert.equal(updatedProvider.max_tokens,256);assert.equal(updatedProvider.temperature,.4);assert.equal(updatedProvider.enabled,0);
  if(process.platform==='darwin'){
    const credential='sk-provider-profile-fixture-123456789',rotated='sk-rotated-provider-profile-fixture-987654321';
    const credentialCreate=await fetch(base+'/api/providers',{method:'POST',headers:auth,body:JSON.stringify({name:'credential fixture',type:'openai-compatible',base_url:'http://localhost:11434/v1',model:'fixture',api_key:credential})});const credentialProfile=await credentialCreate.json();assert.equal(credentialCreate.status,201);assert.equal(credentialProfile.masked_key,'••••6789');
    const listedCredentials=JSON.stringify((await (await fetch(base+'/api/providers',{headers:{cookie}})).json()).items);assert.doesNotMatch(listedCredentials,new RegExp(credential));
    for(const file of await readdir(dir)){if(file.endsWith('.sqlite')||file.endsWith('.sqlite-wal'))assert.ok(!(await readFile(join(dir,file))).includes(Buffer.from(credential)));}
    assert.doesNotMatch(output+errors,new RegExp(credential));assert.doesNotMatch(child.spawnargs.join(' '),new RegExp(credential));
    const rotatedResponse=await fetch(base+`/api/providers/${credentialProfile.id}`,{method:'PUT',headers:auth,body:JSON.stringify({api_key:rotated})});assert.equal(rotatedResponse.status,200);assert.equal((await rotatedResponse.json()).masked_key,'••••4321');
    assert.equal((await fetch(base+`/api/providers/${credentialProfile.id}`,{method:'DELETE',headers:auth})).status,200);
  }
  const started=await fetch(base+'/api/runs',{method:'POST',headers:auth,body:JSON.stringify({task:'Inspect a local file'})});const run=await started.json();assert.equal(started.status,202,JSON.stringify({run,errors}));
  const firstStream=await fetch(base+`/api/runs/${run.id}/stream`,{headers:{cookie}});assert.equal(firstStream.status,200);const firstReader=firstStream.body.getReader(),decoder=new TextDecoder();let initialSse='';while(!initialSse.includes('event: run.queued')){const chunk=await firstReader.read();if(chunk.done)break;initialSse+=decoder.decode(chunk.value,{stream:true});}const queuedId=initialSse.match(/id: ([^\n]+)\nevent: run\.queued/)?.[1];assert.ok(queuedId,'SSE emits a resumable event ID');await firstReader.cancel();
  await fetch(base+`/api/runs/${run.id}/messages`,{method:'POST',headers:auth,body:JSON.stringify({from_agent:'planner',content:'arrived while disconnected'})});
  const resumedStream=await fetch(base+`/api/runs/${run.id}/stream`,{headers:{cookie,'last-event-id':queuedId}});const resumedReader=resumedStream.body.getReader();let resumedSse='';while(!resumedSse.includes('event: agent.message')){const chunk=await resumedReader.read();if(chunk.done)break;resumedSse+=decoder.decode(chunk.value,{stream:true});}assert.match(resumedSse,/event: agent\.message/);assert.doesNotMatch(resumedSse,/event: run\.queued/);await resumedReader.cancel();
  const board=await fetch(base+`/api/runs/${run.id}/blackboard`,{method:'POST',headers:auth,body:JSON.stringify({key:'plan',value:{step:'inspect'},author_agent:'planner'})});assert.equal(board.status,200);
  const boardUpdate=await fetch(base+`/api/runs/${run.id}/blackboard`,{method:'POST',headers:auth,body:JSON.stringify({key:'plan',value:{step:'review'},author_agent:'reviewer'})});assert.equal((await boardUpdate.json()).version,2);
  const boardAcl=await fetch(base+`/api/runs/${run.id}/blackboard`,{method:'POST',headers:auth,body:JSON.stringify({key:'plan',access:{agent_id:'coder',can_read:true,can_write:false}})});assert.equal(boardAcl.status,200);assert.equal((await boardAcl.json()).can_write,false);
  const boardData=await (await fetch(base+`/api/runs/${run.id}/blackboard`,{headers:{cookie}})).json();assert.equal(boardData.items.find(x=>x.key==='plan').version,2);const planHistory=boardData.history.filter(x=>x.key==='plan');assert.equal(planHistory.length,2);assert.equal(JSON.parse(planHistory.find(x=>x.version===2).value).step,'review');
  assert.equal((await fetch(base+`/api/runs/${run.id}/blackboard`,{headers:{cookie}})).status,200);
  assert.equal((await fetch(base+`/api/runs/${run.id}/messages`,{method:'POST',headers:auth,body:JSON.stringify({from_agent:'planner',to_agent:'coder',content:'Inspect the entry point.'})})).status,201);
  const runEventResponse=await fetch(base+`/api/runs/${run.id}/events`,{headers:{cookie}});assert.equal(runEventResponse.status,200);assert.ok((await runEventResponse.json()).items.some(x=>x.event==='run.queued'));
  const siteRunResponse=await fetch(base+'/api/runs',{method:'POST',headers:auth,body:JSON.stringify({task:'Create a responsive portfolio website with a contact form'})});const siteRun=await siteRunResponse.json();assert.equal(siteRunResponse.status,202);
  let finalRun;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,25));const poll=await fetch(base+`/api/runs/${siteRun.id}`,{headers:{cookie}});finalRun=await poll.json();if(finalRun.status==='completed'||finalRun.status==='failed')break;}
  assert.equal(finalRun.status,'completed');const subtasks=await fetch(base+`/api/runs/${siteRun.id}/subtasks`,{headers:{cookie}});assert.equal((await subtasks.json()).items.length,3);
  assert.match(finalRun.final_text,/researcher/);assert.match(finalRun.final_text,/coder/);assert.match(finalRun.final_text,/reviewer/);assert.deepEqual(finalRun.router.plan.parallelGroups,[['requirements'],['implementation'],['review']]);
  const messages=await fetch(base+`/api/runs/${siteRun.id}/messages`,{headers:{cookie}});assert.equal((await messages.json()).items.length,3);
  const boardResponse=await fetch(base+`/api/runs/${siteRun.id}/blackboard`,{headers:{cookie}});const siteBoard=(await boardResponse.json()).items;assert.equal(siteBoard.length,3);const firstResult=JSON.parse(siteBoard[0].value);assert.equal(firstResult.status,'completed');
  const timeline=(await (await fetch(base+`/api/runs/${siteRun.id}/events`,{headers:{cookie}})).json()).items;assert.ok(timeline.some(e=>e.event==='worker.event'));assert.ok(timeline.some(e=>e.event==='blackboard.updated'));assert.ok(timeline.some(e=>e.event==='run.completed'));
  const childRunResponse=await fetch(base+`/api/runs/${firstResult.childRunId}`,{headers:{cookie}});assert.equal((await childRunResponse.json()).parent_run_id,siteRun.id);
  const toolCatalog=(await (await fetch(base+'/api/tools',{headers:{cookie}})).json()).items;for(const id of ['agent.message','agent.inbox','blackboard.read','blackboard.write'])assert.equal(toolCatalog.find(x=>x.id===id)?.availability,'executable');
  assert.equal((await fetch(base+'/api/tasks',{method:'POST',headers:auth,body:JSON.stringify({title:'Check API workflow'})})).status,201);
  const approval=await fetch(base+'/api/approvals',{method:'POST',headers:auth,body:JSON.stringify({tool:'mail.send',tier:'network',args:{to:'person@example.com',body:'Review this'}})});
  const created=await approval.json(); assert.equal(approval.status,201); assert.equal(created.status,'pending');
  const changed=await fetch(base+`/api/approvals/${created.id}`,{method:'POST',headers:auth,body:JSON.stringify({status:'approved',args_hash:'changed'})}); assert.equal(changed.status,409);assert.equal((await changed.json()).error.code,'CONFLICT');
  const stored=await fetch(base+'/api/approvals',{headers:{cookie}}); const row=(await stored.json()).items[0];
  const accepted=await fetch(base+`/api/approvals/${created.id}`,{method:'POST',headers:auth,body:JSON.stringify({status:'approved',scope:'workspace',args_hash:row.args_hash})}); assert.equal(accepted.status,200);
  const persistedWorkspacePolicy=(await (await fetch(base+'/api/policy',{headers:{cookie}})).json()).policy;
  assert.equal(persistedWorkspacePolicy.workspaces[process.cwd()].tools['mail.send'],'allow');
  const providerFixture=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text),task=body.messages?.find(m=>m.role==='user')?.content||'',owner=task.includes('DeepSeek automatic routing fixture')?'researcher':'general',content=body.tools?.length?'Fake profile run completed.':JSON.stringify({items:[{key:'inspect',title:'Inspect the request',owner,depends:[]}],risk:'read',explanation:'One bounded inspection.'});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content}}],usage:{prompt_tokens:9,completion_tokens:4}}));});await new Promise(resolve=>providerFixture.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>providerFixture.close(resolve)));
  const profileEnabled=await fetch(base+`/api/providers/${providerProfile.id}`,{method:'PUT',headers:auth,body:JSON.stringify({enabled:true,base_url:`http://127.0.0.1:${providerFixture.address().port}/v1`})});assert.equal(profileEnabled.status,200);
  assert.equal((await fetch(base+`/api/providers/${providerProfile.id}/default`,{method:'POST',headers:auth,body:'{}'})).status,200);
  const deepseekCreate=await fetch(base+'/api/providers',{method:'POST',headers:auth,body:JSON.stringify({name:'DeepSeek Research',type:'openai-compatible',base_url:`http://127.0.0.1:${providerFixture.address().port}/v1`,model:'deepseek-chat'})});const deepseekProfile=await deepseekCreate.json();assert.equal(deepseekCreate.status,201);
  const modelAssignment=await fetch(base+'/api/agents/general/model',{method:'PUT',headers:auth,body:JSON.stringify({provider_id:providerProfile.id})});assert.equal(modelAssignment.status,200);assert.equal((await modelAssignment.json()).mode,'manual');
  let assignedAgent=(await (await fetch(base+'/api/agents',{headers:{cookie}})).json()).items.find(x=>x.id==='general');assert.equal(assignedAgent.model_mode,'manual');assert.equal(assignedAgent.provider_name,'unreachable fixture');
  const manualAgentRunResponse=await fetch(base+'/api/runs',{method:'POST',headers:auth,body:JSON.stringify({task:'Use the manually assigned general agent and provider',agent_id:'general'})});const manualAgentRun=await manualAgentRunResponse.json();assert.equal(manualAgentRunResponse.status,202);assert.equal(manualAgentRun.decision.manualAgent,'general');let manualAgentResult;
  for(let i=0;i<80;i++){await new Promise(resolve=>setTimeout(resolve,25));manualAgentResult=await (await fetch(base+`/api/runs/${manualAgentRun.id}`,{headers:{cookie}})).json();if(['completed','failed'].includes(manualAgentResult.status))break;}
  assert.equal(manualAgentResult.status,'completed');assert.ok(manualAgentResult.final_text.includes('Fake profile run completed.'));
  const resetAgentModel=await fetch(base+'/api/agents/general/model',{method:'PUT',headers:auth,body:JSON.stringify({provider_id:null})});assert.equal((await resetAgentModel.json()).mode,'automatic');
  const deepseekBeforeOverride=(await (await fetch(base+'/api/providers',{headers:{cookie}})).json()).items.find(p=>p.id===deepseekProfile.id).input_tokens;
  const taskOverrideResponse=await fetch(base+'/api/runs',{method:'POST',headers:auth,body:JSON.stringify({task:'Use this per-task provider override',agent_id:'general',provider_id:deepseekProfile.id})});const taskOverride=await taskOverrideResponse.json();assert.equal(taskOverrideResponse.status,202);assert.equal(taskOverride.decision.providerId,deepseekProfile.id);let taskOverrideResult;for(let i=0;i<80;i++){await new Promise(resolve=>setTimeout(resolve,25));taskOverrideResult=await (await fetch(base+`/api/runs/${taskOverride.id}`,{headers:{cookie}})).json();if(['completed','failed'].includes(taskOverrideResult.status))break;}assert.equal(taskOverrideResult.status,'completed');const deepseekAfterOverride=(await (await fetch(base+'/api/providers',{headers:{cookie}})).json()).items.find(p=>p.id===deepseekProfile.id).input_tokens;assert.ok(deepseekAfterOverride>deepseekBeforeOverride,'per-task override profile is used for the assigned worker');
  const planningOverrideResponse=await fetch(base+'/api/runs',{method:'POST',headers:auth,body:JSON.stringify({task:'A second run-level provider override',provider_id:deepseekProfile.id})});const planningOverride=await planningOverrideResponse.json();assert.equal(planningOverrideResponse.status,202);let planningOverrideResult;for(let i=0;i<80;i++){await new Promise(resolve=>setTimeout(resolve,25));planningOverrideResult=await (await fetch(base+`/api/runs/${planningOverride.id}`,{headers:{cookie}})).json();if(['completed','failed'].includes(planningOverrideResult.status))break;}assert.equal(planningOverrideResult.status,'completed');assert.equal(planningOverrideResult.router.plannerProviderId,deepseekProfile.id,'run-level provider override also selects the planner model');
  const automaticResearch=await fetch(base+'/api/runs',{method:'POST',headers:auth,body:JSON.stringify({task:'DeepSeek automatic routing fixture: research this topic'})});const automaticResearchRun=await automaticResearch.json();assert.equal(automaticResearch.status,202);let automaticResearchResult;for(let i=0;i<80;i++){await new Promise(resolve=>setTimeout(resolve,25));automaticResearchResult=await (await fetch(base+`/api/runs/${automaticResearchRun.id}`,{headers:{cookie}})).json();if(['completed','failed'].includes(automaticResearchResult.status))break;}assert.equal(automaticResearchResult.status,'completed',JSON.stringify(automaticResearchResult));const deepseekUsage=(await (await fetch(base+'/api/providers',{headers:{cookie}})).json()).items.find(p=>p.id===deepseekProfile.id);assert.ok(deepseekUsage.input_tokens>0,'research-category agent is automatically routed to the DeepSeek profile');
  const researchCanvasRun=(await (await fetch(base+'/api/canvas',{headers:{cookie}})).json()).runs.find(item=>item.id===automaticResearchRun.id);const researchWorker=researchCanvasRun.nodes.find(node=>node.agent==='researcher');assert.equal(researchWorker.providerId,deepseekProfile.id);assert.equal(researchWorker.model,'deepseek-chat','canvas identifies the actual automatically selected model');
  const profileRunResponse=await fetch(base+'/api/runs',{method:'POST',headers:auth,body:JSON.stringify({task:'Use the configured provider profile for this task'})});const profileRun=await profileRunResponse.json();assert.equal(profileRunResponse.status,202);let profileResult;
  for(let i=0;i<80;i++){await new Promise(resolve=>setTimeout(resolve,25));profileResult=await (await fetch(base+`/api/runs/${profileRun.id}`,{headers:{cookie}})).json();if(['completed','failed'].includes(profileResult.status))break;}
  assert.equal(profileResult.status,'completed');assert.match(profileResult.final_text,/general/);const usedProfile=(await (await fetch(base+'/api/providers',{headers:{cookie}})).json()).items.find(x=>x.id===providerProfile.id);assert.ok(usedProfile.input_tokens>=18);assert.ok(usedProfile.output_tokens>=8);
  assert.equal((await fetch(base+`/api/providers/${deepseekProfile.id}`,{method:'DELETE',headers:auth})).status,200);
  const reassignedAgent=await fetch(base+'/api/agents/general/model',{method:'PUT',headers:auth,body:JSON.stringify({provider_id:providerProfile.id})});assert.equal(reassignedAgent.status,200);assert.equal((await fetch(base+`/api/providers/${providerProfile.id}`,{method:'DELETE',headers:auth})).status,200);const detachedAgent=(await (await fetch(base+'/api/agents',{headers:{cookie}})).json()).items.find(x=>x.id==='general');assert.equal(detachedAgent.model_mode,'automatic','deleting assigned provider safely returns agents to automatic routing');
  const badHost=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:'/api/status',headers:{Host:`attacker.invalid:${port}`}},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end()});
  assert.equal(badHost.status,421,'rejects invalid Host');assert.equal(badHost.body.error.code,'HOST_REJECTED');
});

test('pending approval survives a daemon restart and resumes the same worker turn',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'orchestra-recovery-db-'));
  const workspace=await mkdtemp(join(tmpdir(),'orchestra-recovery-workspace-'));
  const daemonPort=31000+Math.floor(Math.random()*12000),providerPort=daemonPort+12000;
  const calls=[];
  let failAfterFirstApprovedEffect=true;
  const fakeProvider=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);calls.push(request);
    const tools=request.tools||[],hasToolResult=request.messages.some(message=>message.role==='tool');
    const userContent=request.messages.filter(message=>message.role==='user').map(message=>message.content).join('\n');
    const filePath=userContent.includes('timeout approval')?'timeout.txt':userContent.includes('another file')?'denied.txt':'recovered.txt';
    if(hasToolResult&&request.messages.some(message=>message.role==='tool'&&message.content.includes('recovered.txt'))&&failAfterFirstApprovedEffect){failAfterFirstApprovedEffect=false;res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"fixture interruption after approved effect"}');return;}
    const message=tools.length===0
      ?{role:'assistant',content:JSON.stringify({items:[{key:'write',title:'Write requested file',owner:'coder',depends:[]}],risk:'write',explanation:'One file write.'})}
      :!hasToolResult
        ?{role:'assistant',content:'',tool_calls:[{id:'restart-write-1',type:'function',function:{name:'fs.write',arguments:JSON.stringify({path:filePath,content:'written exactly once'})}}]}
        :{role:'assistant',content:'The approved file is present.'};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:4,completion_tokens:3}}));
  });
  await new Promise(resolve=>fakeProvider.listen(providerPort,'127.0.0.1',resolve));
  let daemon;
  const start=async()=>{
    daemon=spawn(process.execPath,['packages/daemon/src/server.mjs'],{env:{...process.env,ORCHESTRA_HOME:dataDir,ORCHESTRA_WORKSPACE:workspace,ORCHESTRA_PORT:String(daemonPort),ORCHESTRA_PROVIDER:'openai-compatible',ORCHESTRA_BASE_URL:`http://127.0.0.1:${providerPort}`,ORCHESTRA_MODEL:'fixture-model'},stdio:['ignore','pipe','pipe']});
    let output='';daemon.stdout.on('data',chunk=>output+=chunk.toString());daemon.stderr.on('data',chunk=>output+=chunk.toString());
    const base=`http://127.0.0.1:${daemonPort}`;let ready=false;
    for(let i=0;i<100;i++){try{if((await fetch(base+'/api/status')).status===200){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,25));}
    assert.ok(ready,`daemon starts: ${output}`);
    return {base,cookie:{},auth:{'content-type':'application/json'}};
  };
  const stop=async()=>{if(!daemon)return;const child=daemon;daemon=null;child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));};
  t.after(async()=>{await stop();await new Promise(resolve=>fakeProvider.close(resolve));await rm(dataDir,{recursive:true,force:true});await rm(workspace,{recursive:true,force:true});});

  let client=await start();
  const runResponse=await fetch(client.base+'/api/runs',{method:'POST',headers:client.auth,body:JSON.stringify({task:'Write a file using the workspace tool'})});
  const run=await runResponse.json();assert.equal(runResponse.status,202);
  let approval;
  for(let i=0;i<100;i++){
    const list=await fetch(client.base+'/api/approvals',{headers:{cookie:client.cookie}});const rows=(await list.json()).items;
    approval=rows.find(row=>row.status==='pending');if(approval)break;await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(approval,'the worker pauses on an approval');
  let waiting;
  for(let i=0;i<100;i++){waiting=await (await fetch(`${client.base}/api/runs/${run.id}`,{headers:{cookie:client.cookie}})).json();if(waiting.status==='waiting_for_approval')break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(waiting.status,'waiting_for_approval');
  await stop();

  client=await start();
  const pendingAfterRestart=await fetch(client.base+'/api/approvals',{headers:{cookie:client.cookie}});
  const durableApproval=(await pendingAfterRestart.json()).items.find(row=>row.id===approval.id);assert.equal(durableApproval.status,'pending');
  const approved=await fetch(`${client.base}/api/approvals/${approval.id}`,{method:'POST',headers:client.auth,body:JSON.stringify({status:'approved',scope:'session',args_hash:approval.args_hash})});assert.equal(approved.status,200);
  let finished;
  let childRun;
  for(let i=0;i<200;i++){childRun=await (await fetch(`${client.base}/api/runs/${approval.run_id}`,{headers:{cookie:client.cookie}})).json();if(childRun.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(childRun.status,'failed','a provider interruption retains the approved continuation after the file effect');await stop();client=await start();
  for(let i=0;i<200;i++){finished=await (await fetch(`${client.base}/api/runs/${run.id}`,{headers:{cookie:client.cookie}})).json();if(['completed','failed'].includes(finished.status))break;await new Promise(resolve=>setTimeout(resolve,25));}
  const recoveryApprovals=(await (await fetch(`${client.base}/api/approvals`,{headers:{cookie:client.cookie}})).json()).items;
  assert.equal(finished.status,'completed',JSON.stringify({finished,recoveryApprovals,childRun}));
  childRun=await (await fetch(`${client.base}/api/runs/${approval.run_id}`,{headers:{cookie:client.cookie}})).json();assert.equal(childRun.status,'completed');
  assert.equal(await (await import('node:fs/promises')).readFile(join(workspace,'recovered.txt'),'utf8'),'written exactly once');
  const events=(await (await fetch(`${client.base}/api/runs/${run.id}/events`,{headers:{cookie:client.cookie}})).json()).items;
  assert.equal(events.filter(event=>event.event==='run.completed').length,1);
  const effectEvents=events.filter(event=>event.event==='worker.event'&&event.payload.event==='agent.tool_result').map(event=>event.payload.payload.result);
  assert.equal(effectEvents.filter(result=>result.alreadyApplied!==true).length,1,'the approved file write takes effect once');
  assert.ok(childRun.context.some(entry=>entry.kind==='tool'&&entry.result.includes('alreadyApplied')),'recovery recognizes the completed effect instead of repeating it');
  assert.ok(calls.some(request=>request.messages.some(message=>message.role==='tool'&&message.tool_call_id==='restart-write-1'&&message.content.includes('recovered.txt'))),'the resumed transcript returns the tool result to the same model turn');
  const canvasAfterWrite=(await (await fetch(`${client.base}/api/canvas`,{headers:{cookie:client.cookie}})).json()).runs.find(item=>item.id===run.id);assert.ok(canvasAfterWrite.nodes.some(node=>node.artifacts?.some(artifact=>artifact.path==='recovered.txt'&&artifact.tool==='fs.write')),'canvas data exposes the approved workspace file artifact from persisted tool-result events');

  const deniedRunResponse=await fetch(client.base+'/api/runs',{method:'POST',headers:client.auth,body:JSON.stringify({task:'Write another file and wait for approval'})});
  const deniedRun=await deniedRunResponse.json();let deniedApproval;
  for(let i=0;i<100;i++){
    const rows=(await (await fetch(client.base+'/api/approvals',{headers:{cookie:client.cookie}})).json()).items;
    deniedApproval=rows.find(row=>row.run_id!==approval.run_id&&row.status==='pending');if(deniedApproval)break;await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(deniedApproval,'a second worker waits for its own approval');await stop();client=await start();
  const denied=await fetch(`${client.base}/api/approvals/${deniedApproval.id}`,{method:'POST',headers:client.auth,body:JSON.stringify({status:'denied',args_hash:deniedApproval.args_hash})});assert.equal(denied.status,200);
  for(let i=0;i<200;i++){finished=await (await fetch(`${client.base}/api/runs/${deniedRun.id}`,{headers:{cookie:client.cookie}})).json();if(['completed','failed'].includes(finished.status))break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(finished.status,'completed');await assert.rejects(()=>import('node:fs/promises').then(fs=>fs.readFile(join(workspace,'denied.txt'))),{code:'ENOENT'});
  const deniedEvents=(await (await fetch(`${client.base}/api/runs/${deniedRun.id}/events`,{headers:{cookie:client.cookie}})).json()).items;
  assert.equal(deniedEvents.filter(event=>event.event==='worker.event'&&event.payload.event==='agent.tool_result').length,0,'denial performs no write');

  const timeoutRunResponse=await fetch(client.base+'/api/runs',{method:'POST',headers:client.auth,body:JSON.stringify({task:'Write a file after timeout approval'})});
  const timeoutRun=await timeoutRunResponse.json();let timeoutApproval;
  for(let i=0;i<100;i++){
    const rows=(await (await fetch(client.base+'/api/approvals',{headers:{cookie:client.cookie}})).json()).items;
    timeoutApproval=rows.find(row=>row.run_id!==approval.run_id&&row.run_id!==deniedApproval.run_id&&row.status==='pending');if(timeoutApproval)break;await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(timeoutApproval,'the timeout scenario reaches approval');await stop();
  const persistedDb=new DatabaseSync(join(dataDir,'orchestra.sqlite'));
  persistedDb.prepare('UPDATE approvals SET created_at=? WHERE id=?').run(new Date(Date.now()-180000).toISOString(),timeoutApproval.id);persistedDb.close();
  client=await start();
  for(let i=0;i<200;i++){finished=await (await fetch(`${client.base}/api/runs/${timeoutRun.id}`,{headers:{cookie:client.cookie}})).json();if(['completed','failed'].includes(finished.status))break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(finished.status,'completed');await assert.rejects(()=>import('node:fs/promises').then(fs=>fs.access(join(workspace,'timeout.txt'))),{code:'ENOENT'});
  const timedOutApproval=(await (await fetch(client.base+'/api/approvals',{headers:{cookie:client.cookie}})).json()).items.find(row=>row.id===timeoutApproval.id);assert.equal(timedOutApproval.status,'denied','an approval past its persisted deadline expires after restart');
});
