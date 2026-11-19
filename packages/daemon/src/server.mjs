import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { decidePolicy, hashArgs, makeId, redact, routeTask, validatePolicyConfig, wrapUntrusted } from './core.mjs';
import { ProviderManager, validateProviderEndpoint } from './llm.mjs';
import { AgentRuntime } from './runtime.mjs';
import * as secretStore from './secrets.mjs';
import { buildPlan, validatePlanOutput } from './planner.mjs';
import { runMigrations } from './migrations.mjs';
import { CheckpointStore } from './checkpoint-store.mjs';
import { McpClientManager } from './connectors/mcp-manager.mjs';
import { isExecutableTool } from './tool-registry.mjs';
import { errorEnvelope, InvalidJsonError, OrchestraError, PayloadTooLargeError, publicError } from './errors.mjs';

const port = Number(process.env.ORCHESTRA_PORT || 4173);
const dataDir = resolve(process.env.ORCHESTRA_HOME || join(homedir(), '.orchestra'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dataDir, 'orchestra.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,name TEXT,category TEXT,description TEXT,status TEXT DEFAULT 'active',version INTEGER DEFAULT 1,created_at TEXT);
CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY,name TEXT,description TEXT,body TEXT,permissions TEXT DEFAULT '[]',status TEXT DEFAULT 'active',pinned INTEGER DEFAULT 0,created_at TEXT);
CREATE TABLE IF NOT EXISTS tools(id TEXT PRIMARY KEY,name TEXT,description TEXT,risk TEXT,tags TEXT DEFAULT '[]',enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task TEXT,agent TEXT,status TEXT,created_at TEXT,router_json TEXT,context_json TEXT,token_count INTEGER DEFAULT 0,final_text TEXT);
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,run_id TEXT,tool TEXT,args_json TEXT,args_hash TEXT,reason TEXT,status TEXT DEFAULT 'pending',created_at TEXT);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT,status TEXT,owner TEXT,parent_id TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT,owner TEXT,text TEXT,tags TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,kind TEXT,target TEXT,title TEXT,evidence TEXT,status TEXT DEFAULT 'pending',created_at TEXT);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,action TEXT,actor TEXT,details TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,name TEXT,type TEXT,base_url TEXT,model TEXT,key_ref TEXT,enabled INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT);
CREATE TABLE IF NOT EXISTS run_events(id TEXT PRIMARY KEY,run_id TEXT,event TEXT,payload TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS subtasks(id TEXT PRIMARY KEY,run_id TEXT,title TEXT,owner_agent TEXT,status TEXT,depends_on TEXT DEFAULT '[]',created_at TEXT,updated_at TEXT);
CREATE TABLE IF NOT EXISTS agent_messages(id TEXT PRIMARY KEY,run_id TEXT,from_agent TEXT,to_agent TEXT,content TEXT,kind TEXT DEFAULT 'message',created_at TEXT);
CREATE TABLE IF NOT EXISTS blackboard_entries(id TEXT PRIMARY KEY,run_id TEXT,key TEXT,value TEXT,author_agent TEXT,confidence REAL DEFAULT 1,visibility TEXT DEFAULT 'run',version INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT,UNIQUE(run_id,key));
CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,run_id TEXT,agent TEXT,path TEXT,kind TEXT,summary TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS routing_log(id TEXT PRIMARY KEY,run_id TEXT,task_hash TEXT,decision TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC); CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status); CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status); CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id,created_at); CREATE INDEX IF NOT EXISTS idx_subtasks_run ON subtasks(run_id,status); CREATE INDEX IF NOT EXISTS idx_messages_run ON agent_messages(run_id,created_at); CREATE INDEX IF NOT EXISTS idx_blackboard_run ON blackboard_entries(run_id,key); CREATE INDEX IF NOT EXISTS idx_providers_enabled ON providers(enabled);');

const insert = (sql, ...args) => db.prepare(sql).run(...args);
const select = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);
const now = () => new Date().toISOString();
const agentColumns={system_prompt:"TEXT NOT NULL DEFAULT ''",responsibilities:"TEXT NOT NULL DEFAULT '[]'",allowed_tools:"TEXT NOT NULL DEFAULT '[]'",allowed_skills:"TEXT NOT NULL DEFAULT '[]'",permission_tier:"TEXT NOT NULL DEFAULT 'read'",max_steps:"INTEGER NOT NULL DEFAULT 8",max_tokens:"INTEGER NOT NULL DEFAULT 12000",model_preference:"TEXT",provider_id:"TEXT",input_schema:"TEXT NOT NULL DEFAULT '{}'",output_schema:"TEXT NOT NULL DEFAULT '{}'",examples:"TEXT NOT NULL DEFAULT '[]'",dependencies:"TEXT NOT NULL DEFAULT '[]'",updated_at:"TEXT"};
const existingAgentColumns=new Set(select('PRAGMA table_info(agents)').map(c=>c.name));for(const [name,type] of Object.entries(agentColumns))if(!existingAgentColumns.has(name))db.exec(`ALTER TABLE agents ADD COLUMN ${name} ${type}`);
if(!new Set(select('PRAGMA table_info(runs)').map(c=>c.name)).has('parent_run_id'))db.exec('ALTER TABLE runs ADD COLUMN parent_run_id TEXT');
if(!new Set(select('PRAGMA table_info(runs)').map(c=>c.name)).has('final_text'))db.exec('ALTER TABLE runs ADD COLUMN final_text TEXT');
runMigrations(db, now);
const checkpointStore = await CheckpointStore.open(db, dataDir);
function seed() {
  if (one('SELECT count(*) AS n FROM agents').n) return;
  const agents = [
    ['coder','Coder','coding','Implements software changes, investigates bugs, and explains code.'],
    ['reviewer','Code reviewer','review','Finds correctness, security, and maintainability issues in changes.'],
    ['researcher','Researcher','research','Finds and synthesizes evidence with source attribution.'],
    ['planner','Planner','planning','Breaks larger requests into owned, trackable work.'],
    ['general','General assistant','general','Handles conversation and work that does not need a specialist.']
  ];
  for (const [id,name,category,description] of agents) insert('INSERT INTO agents(id,name,category,description,created_at) VALUES(?,?,?,?,?)',id,name,category,description,now());
  const skills = [
    ['code-review','Review code','Check behavior, edge cases, security boundaries, and maintainability.','1. Read the changed code and its callers.\n2. Trace failure and success paths.\n3. Report only actionable findings, ordered by impact.','["read"]'],
    ['debugging','Debug a failure','Reproduce the failure, locate its cause, and verify the smallest safe correction.','1. Read the failure and relevant implementation.\n2. Form a falsifiable hypothesis.\n3. Make the smallest correction and run the requested check.','["read","write"]'],
    ['technical-research','Technical research','Compare primary documentation and return a concise, sourced recommendation.','Prefer official documentation. Record version, assumptions, and links. Separate observed facts from inference.','["network"]'],
    ['incident-triage','Incident triage','Establish impact, likely cause, and the next safe diagnostic action.','Preserve evidence. Bound the impact. Avoid destructive recovery steps. Give an owner and concrete next check.','["read"]'],
    ['release-notes','Release notes','Turn verified changes into clear user-facing release notes.','Group by user outcome. Omit internal implementation detail unless it affects users. Never claim unverified behavior.','["read"]']
  ];
  for (const [id,name,description,body,permissions] of skills) insert('INSERT INTO skills(id,name,description,body,permissions,created_at) VALUES(?,?,?,?,?,?)',id,name,description,body,permissions,now());
  const tools = [
    ['catalog.search','Search catalog','Find tools and skills by purpose.','read','catalog'],['memory.search','Search memory','Search user and workspace memories.','read','memory'],
    ['task.create','Create task','Add work to the shared task board.','write','tasks'],['fs.read','Read workspace file','Read a file under the selected workspace.','read','filesystem'],
    ['fs.list','List workspace files','List files below the active workspace.','read','filesystem'],['fs.search','Search workspace','Search bounded text files in the active workspace.','read','filesystem'],['fs.write','Write workspace file','Write a file after policy approval.','write','filesystem'],['fs.edit','Edit workspace file','Replace exact file text after policy approval.','write','filesystem'],['shell.exec','Run command','Run an argument-array command in an isolated sandbox.','exec','shell'],
    ['git.status','Git status','Read workspace branch and change status.','read','git'],['git.diff','Git diff','Read local unstaged changes.','read','git'],['git.log','Git log','Read recent commit summaries.','read','git'],
    ['web.fetch','Fetch web page','Fetch a public page with size and timeout limits.','network','web'],['desktop.snapshot','Read desktop','Read an accessibility snapshot from an approved app.','screen','desktop'],
    ['gmail.search','Search Gmail','Search mail with a least-privilege connector grant.','read','gmail'],['gmail.send','Send email','Send an exact reviewed email after approval.','network','gmail'],
    ['agent.message','Send a run-scoped agent message.','Deliver a bounded message to one active worker or broadcast to all workers.','write','orchestration'],['agent.inbox','Read worker messages.','Read messages addressed to this worker or broadcast in the current run.','read','orchestration'],['blackboard.read','Read shared run state.','Read a run-scoped blackboard entry or snapshot.','read','orchestration'],['blackboard.write','Publish shared run state.','Write a bounded run-scoped blackboard value for peer workers.','write','orchestration']
  ];
  for (const [id,name,description,risk,tags] of tools) insert('INSERT INTO tools(id,name,description,risk,tags) VALUES(?,?,?,?,?)',id,name,description,risk,JSON.stringify([tags]));
  insert('INSERT INTO tasks(id,title,status,owner,created_at) VALUES(?,?,?,?,?)',makeId('task'),'Review workspace security boundaries','todo','reviewer',now());
  insert('INSERT INTO tasks(id,title,status,owner,created_at) VALUES(?,?,?,?,?)',makeId('task'),'Document local setup and verification','doing','general',now());
  insert('INSERT INTO proposals(id,kind,target,title,evidence,created_at) VALUES(?,?,?,?,?,?)',makeId('proposal'),'create','technical-research','Add a focused local research checklist','Seed proposal for demonstrating human-reviewed lifecycle workflows.',now());
}
seed();
const agentPrompts={coder:'Implement the requested code change in the active workspace. Inspect before editing, keep changes focused, and report files and verification.',reviewer:'Review code for correctness, security and regressions. Report actionable findings with evidence; do not edit unless asked.',researcher:'Research the request using available local evidence and configured sources. Separate observed facts from inference.',planner:'Break the task into concrete ordered work items with dependencies, risks and verifiable outcomes.',general:'Help with general local workspace tasks. Ask for approval before any write and explain what you changed.'};
for(const [id,prompt] of Object.entries(agentPrompts))insert('UPDATE agents SET system_prompt=?,responsibilities=?,allowed_tools=?,allowed_skills=?,permission_tier=?,max_steps=?,max_tokens=?,updated_at=? WHERE id=? AND (system_prompt IS NULL OR system_prompt=\'\')',prompt,JSON.stringify([prompt]),JSON.stringify(['fs.read','fs.list','fs.search','task.create','memory.search']),JSON.stringify([]),id==='coder'?'write':'read',8,12000,now(),id);
for(const [id,name,description,risk,tag] of [['git.status','Git status','Read workspace branch and change status.','read','git'],['git.diff','Git diff','Read local unstaged changes.','read','git'],['git.log','Git log','Read recent commit summaries.','read','git'],['fs.search','Search workspace','Search bounded text files in the active workspace.','read','filesystem'],['fs.edit','Edit workspace file','Replace exact file text after policy approval.','write','filesystem'],['task.update','Update task','Update a task state after approval.','write','tasks'],['memory.write','Write memory','Save a redacted workspace memory after approval.','write','memory'],['agent.message','Send a run-scoped agent message.','Deliver a bounded message to a worker or broadcast in the current run.','write','orchestration'],['agent.inbox','Read worker messages.','Read messages addressed to this worker or broadcast in the current run.','read','orchestration'],['blackboard.read','Read shared run state.','Read a run-scoped blackboard entry or snapshot.','read','orchestration'],['blackboard.write','Publish shared run state.','Write a bounded run-scoped blackboard value for other workers.','write','orchestration']])insert('INSERT OR IGNORE INTO tools(id,name,description,risk,tags) VALUES(?,?,?,?,?)',id,name,description,risk,JSON.stringify([tag]));
const route = task => routeTask(task,select("SELECT id,name,description,category FROM agents WHERE status='active'").map(a=>({...a,tags:[a.category]})),select('SELECT id,name,description,risk,tags FROM tools WHERE enabled=1').map(t=>({...t,tags:JSON.parse(t.tags||'[]')})),select("SELECT id,name,description FROM skills WHERE status='active'").map(s=>({...s,tags:[]})));
const providerManager=new ProviderManager({db,secretStore});
async function providerForAgent(agent={}){
 if(agent.provider_id){const assigned=one('SELECT * FROM providers WHERE id=? AND enabled=1',agent.provider_id);if(!assigned)throw new Error(`The assigned provider profile for ${agent.name||agent.id||'this agent'} is disabled or missing.`);return providerManager.getForProfile(assigned);}
 const category=String(agent.category||'').toLowerCase(),profiles=select('SELECT * FROM providers WHERE enabled=1');
 const score=profile=>{const label=`${profile.name} ${profile.model}`.toLowerCase();if(category==='research')return /deepseek/.test(label)?5:/research|reason|sonar|perplexity/.test(label)?4:/claude|anthropic/.test(label)?2:0;if(category==='coding')return /coder|code|codex/.test(label)?5:/claude|anthropic/.test(label)?3:0;if(category==='review')return /claude|anthropic/.test(label)?3:/review|reason|deepseek/.test(label)?2:0;return 0;};
 const ranked=profiles.map(profile=>({profile,score:score(profile)})).sort((a,b)=>b.score-a.score);if(ranked[0]?.score>0)return providerManager.getForProfile(ranked[0].profile);
 return providerManager.getDefault();
}
const sessionPolicyGrants=new Map();
const readPolicyConfig=(sessionId)=>{const row=one("SELECT value FROM settings WHERE key='policy'");return {...validatePolicyConfig(row?JSON.parse(row.value):{}),sessionTools:sessionPolicyGrants.get(sessionId)||{}};};
const activeProvider=()=>{const id=one("SELECT value FROM settings WHERE key='default_provider'")?.value;const profile=id?one('SELECT type FROM providers WHERE id=? AND enabled=1',JSON.parse(id)):null;return profile?.type||process.env.ORCHESTRA_PROVIDER||'mock';};
const streams=new Map();
const pendingApprovals=new Map();
const runControllers=new Map();
const resumingApprovals=new Set();
function writeSse(client,row){client.res.write(`id: ${row.id}\nevent: ${row.event}\ndata: ${JSON.stringify(row)}\n\n`);}
function emitRunEvent(runId,event,payload={}){const row={id:makeId('event'),run_id:runId,event,payload:redact(payload),created_at:now()};insert('INSERT INTO run_events(id,run_id,event,payload,created_at) VALUES(?,?,?,?,?)',row.id,runId,event,JSON.stringify(row.payload),row.created_at);if(event==='approval.requested')insert('UPDATE runs SET status=? WHERE id=?','waiting_for_approval',runId);if(event==='approval.approved'||event==='approval.denied')insert('UPDATE runs SET status=? WHERE id=?','running',runId);for(const client of streams.get(runId)||[]){if(client.buffering)client.pending.push(row);else writeSse(client,row);}}
function waitForApproval(id,signal){return new Promise(resolve=>{const finish=result=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);pendingApprovals.delete(id);resolve(result);},aborted=()=>finish({approved:false});const timer=setTimeout(()=>{insert('UPDATE approvals SET status=? WHERE id=? AND status=?','denied',id,'pending');finish({approved:false});},120000);pendingApprovals.set(id,finish);if(signal?.aborted)aborted();else signal?.addEventListener('abort',aborted,{once:true});});}
const runtime = new AgentRuntime({db,provider:{chat:async args=>(await providerManager.getDefault()).chat(args)},providerForAgent,workspaceRoot:process.env.ORCHESTRA_WORKSPACE||process.cwd(),audit,route,emit:emitRunEvent,waitApproval:waitForApproval,checkpointStore,policyConfig:readPolicyConfig,now});
const mcpManager = new McpClientManager({db,registry:runtime.toolRegistry,workspaceRoot:process.env.ORCHESTRA_WORKSPACE||process.cwd(),audit,now});
function queueOrchestratedRun(task,decision,sessionId){
 const id=makeId('run'),time=now();insert('INSERT INTO runs(id,task,agent,status,created_at,router_json,context_json,token_count,session_id) VALUES(?,?,?,?,?,?,?,?,?)',id,redact(task),decision.agent,'queued',time,JSON.stringify(decision),'[]',0,sessionId);
 insert('INSERT INTO routing_log(id,run_id,task_hash,decision,created_at) VALUES(?,?,?,?,?)',makeId('route'),id,hashArgs(task),JSON.stringify(decision),time);
 const controller=new AbortController();runControllers.set(id,controller);setImmediate(()=>executeOrchestratedRun(task,id,decision,controller.signal).catch(error=>console.error(JSON.stringify({level:'error',code:error.code||'RUN_FAILED',runId:id,message:'Run execution failed.'}))).finally(()=>runControllers.delete(id)));
 emitRunEvent(id,'run.queued',{agent:decision.agent,task:redact(task),routingMode:decision.manualAgent?'manual':'automatic'});return {id,status:'queued',decision};
}
function validateWorkflowDefinition(value){
 if(value?.items&&!value.nodes)value={nodes:value.items};
 if(!value||typeof value!=='object'||!Array.isArray(value.nodes)||value.nodes.length<1||value.nodes.length>8)throw new Error('A workflow must contain between 1 and 8 task nodes.');
 const nodes=value.nodes.map((node,index)=>({key:node?.key||`step-${index+1}`,title:node?.title,owner:node?.owner,depends:node?.depends||[]}));
 const active=select("SELECT id FROM agents WHERE status='active'");const valid=validatePlanOutput(JSON.stringify({items:nodes,risk:'write'}),active,nodes[0]?.owner);if(!valid)throw new Error('Workflow nodes need unique keys, valid active agents, titles, and acyclic dependencies.');
 return {...valid,items:valid.items.map(item=>{const source=value.nodes.find(node=>(node.key||`step-${value.nodes.indexOf(node)+1}`)===item.key),providerId=source?.providerId||null;if(providerId&&!one('SELECT id FROM providers WHERE id=? AND enabled=1',providerId))throw new Error('Workflow references a disabled or missing provider profile.');return {...item,providerId};})};
}
async function executeOrchestratedRun(task,parentId,initialDecision,signal){
 const available=select("SELECT id,name,description FROM agents WHERE status='active'"),stored=one('SELECT router_json,session_id FROM runs WHERE id=?',parentId),storedDecision=stored?.router_json?JSON.parse(stored.router_json):null;
 const budget={limit:30000,usedTokens:storedDecision?.plannerTokens||0,reservedTokens:0},plannerPrompt=`Create a small work plan as JSON only. Use only these agent IDs: ${JSON.stringify(available)}. Shape: {"items":[{"key":"short_id","title":"one concrete outcome","owner":"existing id","depends":[]}],"risk":"read|write|high","explanation":"brief reason"}. Maximum 8 subtasks. Add review after implementation. Do not claim unavailable capabilities.`;
 let plan=storedDecision?.plan||storedDecision?.manualPlan,plannerTokens=storedDecision?.plannerTokens||0;
 if(!plan){
  if(storedDecision?.manualAgent){plan={supervisor:storedDecision.manualAgent,items:[{key:'manual',title:task,owner:storedDecision.manualAgent,depends:[],providerId:storedDecision.providerId||null}],selected:[storedDecision.manualAgent],parallelGroups:[['manual']],risk:'write',explanation:'Manually assigned to the selected agent.'};}
  else{
   try{const planningProfile=initialDecision.providerId?one('SELECT * FROM providers WHERE id=? AND enabled=1',initialDecision.providerId):null,provider=planningProfile?await providerManager.getForProfile(planningProfile):await providerManager.getDefault();initialDecision.plannerProviderId=provider.profileId||null;initialDecision.plannerProviderName=provider.profileName||null;initialDecision.plannerProviderType=provider.profileType||null;initialDecision.plannerModel=provider.model||null;const reply=await provider.chat({messages:[{role:'system',content:plannerPrompt},{role:'user',content:task}],tools:[],temperature:0,max_tokens:900});plannerTokens=(reply.usage?.input_tokens||0)+(reply.usage?.output_tokens||0);budget.usedTokens=plannerTokens;emitRunEvent(parentId,'budget.updated',{used:budget.usedTokens,limit:budget.limit,phase:'planning'});plan=validatePlanOutput(reply.text,available,initialDecision.agent);}
   catch(error){audit('planner.fallback',{runId:parentId,error:publicError(error)});}
   if(!plan)plan=buildPlan(task,initialDecision.agent,available);
  }
  insert('UPDATE runs SET status=?,agent=?,router_json=? WHERE id=?','planning',plan.supervisor,JSON.stringify({...initialDecision,plan,plannerTokens,tokenBudget:budget.limit}),parentId);
  emitRunEvent(parentId,'plan.created',plan);
 }else{
  budget.usedTokens=plannerTokens;
  insert('UPDATE runs SET status=? WHERE id=?','planning',parentId);
 }
 const completed=new Set(),results=[];
 for(const child of select('SELECT id,agent,status,router_json,final_text,token_count FROM runs WHERE parent_run_id=? AND status=?',parentId,'completed')){
  let meta={};try{meta=JSON.parse(child.router_json||'{}')}catch{}
  if(!meta.subtask)continue;
  const item=plan.items.find(x=>x.key===meta.subtask);if(!item)continue;
  completed.add(item.key);results.push({key:item.key,subtaskId:meta.subtaskId||null,agent:child.agent,title:item.title,status:'completed',text:child.final_text||'',tokens:child.token_count||0});budget.usedTokens+=child.token_count||0;
 }
 let totalTokens=budget.usedTokens;
 try{
  while(completed.size<plan.items.length){
   if(signal?.aborted)throw Object.assign(new Error('Run cancelled'),{cancelled:true});
   const ready=plan.items.filter(x=>!completed.has(x.key)&&x.depends.every(d=>completed.has(d)));
   if(!ready.length)throw new Error('Plan dependency cycle detected');
   // Bound provider and filesystem pressure when independent branches are ready together.
   const batch=ready.slice(0,3);
   const settled=await Promise.allSettled(batch.map(async item=>{
    const subtaskId=makeId('subtask'),childId=makeId('run'),time=now();
    insert('INSERT INTO subtasks(id,run_id,title,owner_agent,status,depends_on,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',subtaskId,parentId,item.title,item.owner,'running',JSON.stringify(item.depends),time,time);
    const assignedProfile=one('SELECT provider_id FROM agents WHERE id=?',item.owner),assignedProviderId=item.providerId||storedDecision?.providerId||assignedProfile?.provider_id||null;
    insert('INSERT INTO runs(id,parent_run_id,task,agent,status,created_at,router_json,context_json,token_count,session_id) VALUES(?,?,?,?,?,?,?,?,?,?)',childId,parentId,redact(`${item.title}\nOriginal task: ${task}`),item.owner,'running',time,JSON.stringify({agent:item.owner,supervisor:plan.supervisor,subtask:item.key,subtaskId,providerId:assignedProviderId,workflowId:storedDecision?.workflowId||null}),JSON.stringify([]),0,stored?.session_id||null);
    emitRunEvent(parentId,'subtask.created',{id:subtaskId,key:item.key,title:item.title,owner_agent:item.owner,depends_on:item.depends});
    emitRunEvent(parentId,'agent.started',{runId:childId,subtaskId,agent:item.owner});
    const dependencyResults=results.filter(x=>item.depends.includes(x.key)).map(x=>({key:x.key,agent:x.agent,result:x.text}));
    const workerTask=`${item.title}\nOriginal user task: ${task}\nSubtask key: ${item.key}\nDependency findings: ${wrapUntrusted('prior_agent_results',JSON.stringify(dependencyResults))}`;
    const workerEmit=(workerRun,event,payload)=>{
     emitRunEvent(workerRun,event,payload);
     if(event==='approval.requested')insert('UPDATE runs SET status=? WHERE id=?','waiting_for_approval',parentId);
     if(event==='approval.approved'||event==='approval.denied')insert('UPDATE runs SET status=? WHERE id=?','planning',parentId);
     emitRunEvent(parentId,'worker.event',{runId:workerRun,subtaskId,agent:item.owner,event,payload:redact(payload)});
     if(event==='budget.updated')emitRunEvent(parentId,'budget.updated',{...payload,subtaskId});
    };
    const result=await runtime.run(workerTask,{runId:childId,runScopeId:parentId,agentId:item.owner,providerId:assignedProviderId,assignedTaskKey:item.key,sessionId:stored?.session_id,signal,emit:workerEmit,budget,deferCheckpointCleanup:true});
    insert('UPDATE runs SET status=?,router_json=?,context_json=?,token_count=?,final_text=? WHERE id=?',result.status,JSON.stringify({...result.decision,subtask:item.key,subtaskId}),JSON.stringify(result.context),result.tokens,redact(result.text),childId);
    const subtaskStatus=result.status==='completed'?'done':result.status;
    insert('UPDATE subtasks SET status=?,updated_at=? WHERE id=?',subtaskStatus,now(),subtaskId);
    const boardKey=`result:${item.key}`,boardValue={status:result.status,text:result.text,childRunId:childId},boardId=one('SELECT id FROM blackboard_entries WHERE run_id=? AND key=?',parentId,boardKey)?.id||makeId('board'),boardTime=now(),boardVersion=(one('SELECT version FROM blackboard_entries WHERE run_id=? AND key=?',parentId,boardKey)?.version||0)+1;
    insert('INSERT INTO blackboard_entries(id,run_id,key,value,author_agent,confidence,visibility,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,key) DO UPDATE SET value=excluded.value,author_agent=excluded.author_agent,version=excluded.version,updated_at=excluded.updated_at',boardId,parentId,boardKey,JSON.stringify(redact(boardValue)),item.owner,.8,'run',boardVersion,boardTime,boardTime);
    insert('INSERT INTO blackboard_acl(run_id,key,agent_id,can_read,can_write,updated_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,key,agent_id) DO UPDATE SET can_read=1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',parentId,boardKey,item.owner,1,0,plan.supervisor,boardTime);
    insert('INSERT INTO blackboard_history(id,run_id,key,value,author_agent,source,confidence,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)',makeId('board-history'),parentId,boardKey,JSON.stringify(redact(boardValue)),item.owner,'worker_result',.8,boardVersion,boardTime);
    emitRunEvent(parentId,'blackboard.updated',{key:boardKey,author:item.owner,version:boardVersion,source:'worker_result'});
    insert('INSERT INTO agent_messages(id,run_id,from_agent,to_agent,content,kind,created_at) VALUES(?,?,?,?,?,?,?)',makeId('message'),parentId,item.owner,plan.supervisor,redact(result.text),'worker_result',now());
    emitRunEvent(parentId,'agent.message',{from_agent:item.owner,to_agent:plan.supervisor,subtaskId,content:redact(result.text)});
    emitRunEvent(parentId,'agent.completed',{runId:childId,subtaskId,agent:item.owner,status:result.status});
    if(result.status!=='awaiting_approval')checkpointStore.delete(childId);
    return {key:item.key,subtaskId,agent:item.owner,title:item.title,status:result.status,text:result.text,tokens:result.tokens};
   }));
   const failure=settled.find(x=>x.status==='rejected');
   if(failure)throw failure.reason;
   const outcomes=settled.map(x=>x.value);
   if(outcomes.some(x=>x.status==='budget_exhausted'))throw Object.assign(new Error('Shared run token budget exhausted'),{budgetExhausted:true});
   for(const result of outcomes){results.push(result);completed.add(result.key);totalTokens+=result.tokens;}
  }
  const status=results.every(x=>x.status==='completed')?'completed':'failed';
  const summary=results.map(x=>`[${x.agent} · ${x.status}] ${x.title}\n${x.text}`).join('\n\n');
  const parentContext=results.map(x=>({kind:'agent_result',agent:x.agent,subtaskId:x.subtaskId,text:redact(x.text),tokens:x.tokens}));
  insert('UPDATE runs SET status=?,context_json=?,token_count=?,final_text=? WHERE id=?',status,JSON.stringify(parentContext),totalTokens,redact(summary),parentId);
  audit('run.orchestration.completed',{runId:parentId,status,workers:results.length,tokens:totalTokens});
  emitRunEvent(parentId,status==='completed'?'run.completed':'run.failed',{status,tokens:totalTokens,tokenBudget:{used:budget.usedTokens,limit:budget.limit},workers:results.length});
  return summary;
 }catch(error){
  const state=error.cancelled||signal?.aborted?'cancelled':'failed';
  insert('UPDATE runs SET status=? WHERE id=?',state,parentId);
  const safe=publicError(error);
  audit(`run.orchestration.${state}`,{runId:parentId,error:safe});
  emitRunEvent(parentId,state==='cancelled'?'run.cancelled':'run.failed',{code:safe.code,message:safe.message,suggestion:safe.suggestion});
  throw error;
 }
}

async function resumeCheckpointedApproval(approvalId,decisionSessionId=null){
 if(resumingApprovals.has(approvalId))return;
 const approval=one('SELECT * FROM approvals WHERE id=?',approvalId),checkpoint=checkpointStore.getForApproval(approvalId);
 if(!approval||!checkpoint||!['approved','denied'].includes(approval.status))return;
 resumingApprovals.add(approvalId);
 const state=checkpoint.state,runId=state.runId,priorRun=one('SELECT * FROM runs WHERE id=?',runId);
 let priorMeta={};try{priorMeta=JSON.parse(priorRun?.router_json||'{}')}catch{}
 try{
  if(priorRun&&['completed','cancelled'].includes(priorRun.status)){
   checkpointStore.delete(runId);
   if(priorRun.parent_run_id)scheduleParentRecovery(priorRun.parent_run_id);
   return;
  }
  if(!priorRun)insert('INSERT INTO runs(id,task,agent,status,created_at,router_json,context_json,token_count) VALUES(?,?,?,?,?,?,?,?)',runId,redact(state.task),state.agentId,'running',now(),JSON.stringify(state.decision),JSON.stringify(state.context),state.tokens||0);
  const controller=new AbortController();runControllers.set(runId,controller);
  const parentId=priorRun?.parent_run_id||null,subtaskId=priorMeta.subtaskId;
  const recoveredEmit=(eventRun,event,payload)=>{emitRunEvent(eventRun,event,payload);if(parentId)emitRunEvent(parentId,'worker.event',{runId:eventRun,subtaskId,agent:state.agentId,event,payload:redact(payload)});};
  const result=await runtime.run(state.task,{runId,runScopeId:state.scopeId,agentId:state.agentId,sessionId:decisionSessionId||state.sessionId,resumeState:state,approvalResolution:{approvalId,status:approval.status,argsHash:approval.args_hash},signal:controller.signal,emit:recoveredEmit,deferCheckpointCleanup:true});
  insert('UPDATE runs SET status=?,router_json=?,context_json=?,token_count=?,final_text=? WHERE id=?',result.status,JSON.stringify({...result.decision,...priorMeta}),JSON.stringify(result.context),result.tokens,redact(result.text),runId);
  if(priorRun?.parent_run_id){
   const subtaskId=priorMeta.subtaskId;
   if(subtaskId)insert('UPDATE subtasks SET status=?,updated_at=? WHERE id=?',result.status==='completed'?'done':result.status,now(),subtaskId);
   if(result.status!=='awaiting_approval')checkpointStore.delete(runId);
   emitRunEvent(parentId,'worker.event',{runId,event:'agent.recovered',status:result.status,approvalId});
   scheduleParentRecovery(parentId);
  }else{
   if(result.status!=='awaiting_approval')checkpointStore.delete(runId);
   emitRunEvent(runId,result.status==='completed'?'run.completed':'run.failed',{status:result.status,recovered:true});
  }
 }catch(error){
  audit('approval.resume.failed',{approvalId,runId,error:publicError(error)});
  insert('UPDATE runs SET status=?,final_text=? WHERE id=?','failed','Approval continuation was interrupted; its encrypted checkpoint is retained for recovery.',runId);
  if(priorRun?.parent_run_id)emitRunEvent(priorRun.parent_run_id,'worker.event',{runId,event:'approval.resume_failed',approvalId,message:'Encrypted continuation retained for daemon restart recovery.'});
 }finally{runControllers.delete(runId);resumingApprovals.delete(approvalId);}
}

async function scheduleParentRecovery(parentId){
 const parent=one('SELECT task,router_json FROM runs WHERE id=?',parentId);
 const outstanding=one('SELECT count(*) AS n FROM runtime_checkpoints c JOIN runs r ON r.id=c.run_id WHERE r.parent_run_id=?',parentId)?.n||0;
 if(!parent||outstanding||runControllers.has(parentId))return;
 const decision=JSON.parse(parent.router_json||'{}'),controller=new AbortController();runControllers.set(parentId,controller);
 try{await executeOrchestratedRun(parent.task,parentId,decision,controller.signal);}catch(error){audit('run.recovery.failed',{runId:parentId,error:publicError(error)});}finally{runControllers.delete(parentId);}
}

function scheduleApprovalRecovery(approvalId){
 const approval=one('SELECT status,created_at FROM approvals WHERE id=?',approvalId);
 if(!approval)return;
 if(approval.status==='approved'||approval.status==='denied'){setImmediate(()=>resumeCheckpointedApproval(approvalId));return;}
 if(approval.status!=='pending')return;
 const remaining=Math.max(0,120000-(Date.now()-Date.parse(approval.created_at)));
 const timer=setTimeout(()=>{
  const changed=insert("UPDATE approvals SET status='denied' WHERE id=? AND status='pending'",approvalId);
  if(changed.changes){const row=one('SELECT run_id FROM approvals WHERE id=?',approvalId);audit('approval.expired',{approvalId});if(row?.run_id)emitRunEvent(row.run_id,'approval.expired',{approvalId});resumeCheckpointedApproval(approvalId).catch(()=>{});}
 },remaining);
 timer.unref();
}

const hostAllowed = new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
const publicDir = resolve(new URL('../../dashboard/public/', import.meta.url).pathname);
function json(res, status, payload, headers={}) {
  if(status>=400){
    const raw=typeof payload.error==='string'?payload.error:payload.error?.message||'The request could not be completed.';
    const code=payload.code||payload.error?.code||(status===401?'AUTHENTICATION_REQUIRED':status===403?'AUTHORIZATION_DENIED':status===404?'NOT_FOUND':status===409?'CONFLICT':status===413?'PAYLOAD_TOO_LARGE':status===421?'HOST_REJECTED':status===400?'INVALID_REQUEST':status===502?'PROVIDER_UNAVAILABLE':'INTERNAL_ERROR');
    const candidate=payload.error instanceof Error?payload.error:new OrchestraError(code,raw,{status,suggestion:payload.suggestion||payload.error?.suggestion});
    payload=errorEnvelope(candidate,res.requestId,status).payload;
  }
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-request-id':res.requestId,...headers}); res.end(JSON.stringify(payload));
}
function currentSessionId(){return 'local-loopback';}
async function body(req) {
  let data=''; for await (const chunk of req) { data+=chunk; if(data.length>1_000_000) throw new PayloadTooLargeError(); }
  if(!data) return {}; try { return JSON.parse(data); } catch { throw new InvalidJsonError(); }
}
function audit(action, details, actor='local-user') { insert('INSERT INTO audit(id,action,actor,details,created_at) VALUES(?,?,?,?,?)',makeId('audit'),action,actor,JSON.stringify(redact(details)),now()); }
function pageRows(table, limit=100, offset=0) { const allowed=['agents','skills','tools','runs','tasks','approvals','proposals','audit','memories']; if(!allowed.includes(table)) throw new Error('Invalid collection');const order=table==='tools'?'id ASC':'created_at DESC'; return select(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`,Math.min(250,Math.max(1,Number(limit)||100)),Math.max(0,Number(offset)||0)); }

async function handle(req,res) {
  const host=req.headers.host;
  if(!hostAllowed.has(host)) return json(res,421,{error:'Host rejected'});
  const url=new URL(req.url,`http://${host}`);
  if(url.pathname.startsWith('/api/') && !['GET','HEAD'].includes(req.method) && req.headers['origin'] && req.headers.origin!==`http://${host}`) return json(res,403,{error:'Cross-origin request rejected'});
  if(req.method==='GET' && url.pathname==='/api/status') return json(res,200,{name:'Orchestra',version:'0.1.0',provider:activeProvider(),router:'bm25',database:'sqlite',uptime:process.uptime(),localOnly:true});
  if(req.method==='GET' && url.pathname==='/api/overview') return json(res,200,{counts:Object.fromEntries(['runs','agents','skills','tools','approvals','tasks','proposals'].map(t=>[t,one(`SELECT count(*) AS n FROM ${t}`).n])),pendingApprovals:one("SELECT count(*) AS n FROM approvals WHERE status='pending'").n,activity:select("SELECT substr(created_at,1,10) day,count(*) count FROM runs WHERE created_at>=datetime('now','-7 days') GROUP BY day ORDER BY day"),router:'bm25',provider:activeProvider(),autonomy:'suggest'});
  if(req.method==='GET' && url.pathname==='/api/runs') return json(res,200,{items:pageRows('runs',url.searchParams.get('limit'),url.searchParams.get('offset')),total:one('SELECT count(*) n FROM runs').n});
  const cancelRun=url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if(req.method==='POST'&&cancelRun){const id=cancelRun[1],run=one('SELECT status FROM runs WHERE id=?',id);if(!run)return json(res,404,{error:'Run not found'});if(['completed','failed','cancelled'].includes(run.status))return json(res,409,{error:'Run is already finished'});const controller=runControllers.get(id);if(!controller)return json(res,409,{error:'Run has no active worker to cancel'});controller.abort();emitRunEvent(id,'run.cancel_requested',{});const children=select('SELECT id FROM runs WHERE parent_run_id=?',id).map(x=>x.id);for(const approval of select(`SELECT id FROM approvals WHERE status='pending' AND run_id IN (${[id,...children].map(()=>'?').join(',')})`,id,...children)){insert('UPDATE approvals SET status=? WHERE id=?','denied',approval.id);pendingApprovals.get(approval.id)?.({approved:false});}return json(res,202,{id,status:'cancelling'});}
  if(req.method==='POST' && url.pathname==='/api/runs') {
    const d=await body(req);if(typeof d.task!=='string'||!d.task.trim()||d.task.length>10000)return json(res,400,{error:'task is required (maximum 10,000 characters)'});
    const decision=route(d.task),sessionId=currentSessionId(req);
    if(d.agent_id){const agent=one("SELECT id FROM agents WHERE id=? AND status='active'",d.agent_id);if(!agent)return json(res,400,{error:'Manual assignment requires an active agent.'});decision.agent=d.agent_id;decision.manualAgent=d.agent_id;decision.routingMode='manual';}
    if(d.provider_id){if(!one('SELECT id FROM providers WHERE id=? AND enabled=1',d.provider_id))return json(res,400,{error:'Manual provider assignment requires an enabled provider profile.'});decision.providerId=d.provider_id;}
    const queued=queueOrchestratedRun(d.task,decision,sessionId);return json(res,202,queued);
  }
  const runStream=url.pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
  if(req.method==='GET'&&runStream){const id=runStream[1];if(!one('SELECT id FROM runs WHERE id=?',id))return json(res,404,{error:'Run not found'});const cursor=req.headers['last-event-id']||url.searchParams.get('after');const anchor=cursor?one('SELECT rowid AS sequence FROM run_events WHERE id=? AND run_id=?',cursor,id):null;if(cursor&&!anchor)return json(res,409,{code:'EVENT_CURSOR_INVALID',error:'Event cursor is unknown for this run.',suggestion:'Reconnect without a cursor to replay the run history.'});res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','x-request-id':res.requestId});res.write(': connected\n\n');const client={res,buffering:true,pending:[]},clients=streams.get(id)||new Set();clients.add(client);streams.set(id,clients);const replay=anchor?select('SELECT * FROM run_events WHERE run_id=? AND rowid>? ORDER BY rowid',id,anchor.sequence):select('SELECT * FROM run_events WHERE run_id=? ORDER BY rowid',id);const sent=new Set();for(const e of replay){const row={...e,payload:JSON.parse(e.payload)};writeSse(client,row);sent.add(row.id);}client.buffering=false;for(const row of client.pending)if(!sent.has(row.id))writeSse(client,row);client.pending=[];const heartbeat=setInterval(()=>res.write(': ping\n\n'),15000);res.on('close',()=>{clearInterval(heartbeat);clients.delete(client);if(!clients.size)streams.delete(id);});return;}
  const runEvents=url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if(req.method==='GET'&&runEvents){const id=runEvents[1];return json(res,200,{items:select('SELECT * FROM run_events WHERE run_id=? ORDER BY rowid LIMIT 500',id).map(e=>({...e,payload:JSON.parse(e.payload)}))});}
  const runAgents=url.pathname.match(/^\/api\/runs\/([^/]+)\/agents$/),runMessages=url.pathname.match(/^\/api\/runs\/([^/]+)\/messages$/),runBoard=url.pathname.match(/^\/api\/runs\/([^/]+)\/blackboard$/),runSubtasks=url.pathname.match(/^\/api\/runs\/([^/]+)\/subtasks$/);
  if(req.method==='GET'&&runAgents){const r=one('SELECT id,agent,status,token_count,created_at FROM runs WHERE id=?',runAgents[1]);return r?json(res,200,{items:[{id:r.id,agent:r.agent,status:r.status,tokens:r.token_count,started_at:r.created_at}]}):json(res,404,{error:'Run not found'});}
  if(req.method==='GET'&&runMessages)return json(res,200,{items:select('SELECT * FROM agent_messages WHERE run_id=? ORDER BY created_at LIMIT 500',runMessages[1])});
  if(req.method==='POST'&&runMessages){const d=await body(req);if(!d.content||d.content.length>20000)return json(res,400,{error:'message content is required (maximum 20,000 characters)'});const id=makeId('message');insert('INSERT INTO agent_messages(id,run_id,from_agent,to_agent,content,kind,created_at) VALUES(?,?,?,?,?,?,?)',id,runMessages[1],d.from_agent||'supervisor',d.to_agent||null,redact(d.content),d.kind||'message',now());emitRunEvent(runMessages[1],'agent.message',{id,from_agent:d.from_agent||'supervisor',to_agent:d.to_agent||null,content:redact(d.content)});return json(res,201,{id});}
  if(req.method==='GET'&&runBoard){if(!one('SELECT id FROM runs WHERE id=?',runBoard[1]))return json(res,404,{error:'Run not found'});return json(res,200,{items:select('SELECT * FROM blackboard_entries WHERE run_id=? ORDER BY key LIMIT 500',runBoard[1]),history:select('SELECT id,key,value,author_agent,source,confidence,version,created_at FROM blackboard_history WHERE run_id=? ORDER BY rowid DESC LIMIT 500',runBoard[1])});}
  if(req.method==='POST'&&runBoard){if(!one('SELECT id FROM runs WHERE id=?',runBoard[1]))return json(res,404,{error:'Run not found'});const d=await body(req);if(!d.key||d.key.length>200)return json(res,400,{error:'key is required (maximum 200 characters)'});if(d.access){if(typeof d.access.agent_id!=='string'||!one("SELECT id FROM agents WHERE id=? AND status='active'",d.access.agent_id)||typeof d.access.can_read!=='boolean'||typeof d.access.can_write!=='boolean')return json(res,400,{error:'access requires an active agent_id and boolean can_read/can_write'});insert('INSERT INTO blackboard_acl(run_id,key,agent_id,can_read,can_write,updated_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,key,agent_id) DO UPDATE SET can_read=excluded.can_read,can_write=excluded.can_write,updated_by=excluded.updated_by,updated_at=excluded.updated_at',runBoard[1],d.key,d.access.agent_id,d.access.can_read?1:0,d.access.can_write?1:0,'local-user',now());audit('blackboard.acl.updated',{runId:runBoard[1],key:d.key,agentId:d.access.agent_id,can_read:d.access.can_read,can_write:d.access.can_write});return json(res,200,{key:d.key,agent_id:d.access.agent_id,can_read:d.access.can_read,can_write:d.access.can_write});}if(d.value===undefined)return json(res,400,{error:'value is required'});const previous=one('SELECT id,version FROM blackboard_entries WHERE run_id=? AND key=?',runBoard[1],d.key),id=previous?.id||makeId('board'),ver=(previous?.version||0)+1,time=now(),author=d.author_agent||'supervisor',value=JSON.stringify(redact(d.value)),confidence=Math.min(1,Math.max(0,Number(d.confidence??1)));insert('INSERT INTO blackboard_entries(id,run_id,key,value,author_agent,confidence,visibility,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,key) DO UPDATE SET value=excluded.value,author_agent=excluded.author_agent,confidence=excluded.confidence,visibility=excluded.visibility,version=excluded.version,updated_at=excluded.updated_at',id,runBoard[1],d.key,value,author,confidence,d.visibility||'run',ver,time,time);insert('INSERT INTO blackboard_acl(run_id,key,agent_id,can_read,can_write,updated_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,key,agent_id) DO UPDATE SET can_read=1,can_write=1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',runBoard[1],d.key,author,1,1,'local-user',time);insert('INSERT INTO blackboard_history(id,run_id,key,value,author_agent,source,confidence,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)',makeId('board-history'),runBoard[1],d.key,value,author,'dashboard',confidence,ver,time);emitRunEvent(runBoard[1],'blackboard.updated',{key:d.key,version:ver,author,source:'dashboard'});return json(res,200,{id,version:ver});}
  if(req.method==='GET'&&runSubtasks)return json(res,200,{items:select('SELECT * FROM subtasks WHERE run_id=? ORDER BY created_at LIMIT 500',runSubtasks[1])});
  if(req.method==='POST'&&runSubtasks){const d=await body(req);if(!d.title||d.title.length>500)return json(res,400,{error:'subtask title is required'});const id=makeId('subtask'),time=now();insert('INSERT INTO subtasks(id,run_id,title,owner_agent,status,depends_on,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',id,runSubtasks[1],redact(d.title),d.owner_agent||'general','queued',JSON.stringify(d.depends_on||[]),time,time);emitRunEvent(runSubtasks[1],'subtask.created',{id,title:d.title,owner_agent:d.owner_agent||'general'});return json(res,201,{id,status:'queued'});}
  const workflowRun=url.pathname.match(/^\/api\/workflows\/([^/]+)\/run$/),workflowItem=url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if(req.method==='GET'&&url.pathname==='/api/workflows')return json(res,200,{items:select('SELECT * FROM workflows ORDER BY updated_at DESC').map(row=>({...row,definition:JSON.parse(row.definition_json)}))});
  if(req.method==='POST'&&url.pathname==='/api/workflows'){
    const d=await body(req);if(typeof d.name!=='string'||!d.name.trim()||d.name.length>100)return json(res,400,{error:'Workflow name is required (maximum 100 characters).'});
    let definition;try{definition=validateWorkflowDefinition(d.definition);}catch(error){return json(res,400,{error:error.message});}
    const id=makeId('workflow'),time=now();insert('INSERT INTO workflows(id,name,description,definition_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',id,redact(d.name.trim()),redact(String(d.description||'').slice(0,1000)),JSON.stringify(definition),time,time);audit('workflow.created',{id,name:d.name,nodes:definition.items.length});return json(res,201,{id,name:d.name,description:d.description||'',definition,created_at:time,updated_at:time});
  }
  if(req.method==='PUT'&&workflowItem){const id=workflowItem[1],old=one('SELECT * FROM workflows WHERE id=?',id);if(!old)return json(res,404,{error:'Workflow not found'});const d=await body(req),name=String(d.name??old.name).trim();if(!name||name.length>100)return json(res,400,{error:'Workflow name is required (maximum 100 characters).'});let definition;try{definition=validateWorkflowDefinition(d.definition??JSON.parse(old.definition_json));}catch(error){return json(res,400,{error:error.message});}const description=String(d.description??old.description).slice(0,1000);insert('UPDATE workflows SET name=?,description=?,definition_json=?,updated_at=? WHERE id=?',redact(name),redact(description),JSON.stringify(definition),now(),id);audit('workflow.updated',{id,name,nodes:definition.items.length});return json(res,200,{id,name,description,definition,updated_at:now()});}
  if(req.method==='DELETE'&&workflowItem){const id=workflowItem[1];if(!one('SELECT id FROM workflows WHERE id=?',id))return json(res,404,{error:'Workflow not found'});insert('DELETE FROM workflows WHERE id=?',id);audit('workflow.deleted',{id});return json(res,200,{id,deleted:true});}
  if(req.method==='POST'&&workflowRun){const storedWorkflow=one('SELECT * FROM workflows WHERE id=?',workflowRun[1]);if(!storedWorkflow)return json(res,404,{error:'Workflow not found'});const definition=JSON.parse(storedWorkflow.definition_json),task=storedWorkflow.description||`Run workflow: ${storedWorkflow.name}`,decision={agent:definition.items[0].owner,workflowId:storedWorkflow.id,workflowName:storedWorkflow.name,manualPlan:definition,routingMode:'manual-workflow'},queued=queueOrchestratedRun(task,decision,currentSessionId(req));return json(res,202,queued);}
  if(req.method==='GET'&&url.pathname==='/api/canvas'){
    const agents=select("SELECT id,name,category,description,status,permission_tier,provider_id FROM agents WHERE status='active' ORDER BY name").map(agent=>({...agent,provider:agent.provider_id?one('SELECT id,name,type,model,enabled FROM providers WHERE id=?',agent.provider_id):null}));
    const providers=select('SELECT id,name,type,model,enabled FROM providers ORDER BY name');
    const tools=select('SELECT id,name,description,tags,source,server_id,risk,enabled FROM tools ORDER BY id').map(tool=>({...tool,tags:JSON.parse(tool.tags||'[]')}));
    const workflows=select('SELECT id,name,description,definition_json,created_at,updated_at FROM workflows ORDER BY updated_at DESC').map(w=>({...w,definition:JSON.parse(w.definition_json)}));
    const parentRuns=select('SELECT * FROM runs WHERE parent_run_id IS NULL ORDER BY created_at DESC LIMIT 15');
    const runs=parentRuns.map(parent=>{
      let router={};try{router=JSON.parse(parent.router_json||'{}')}catch{}
      const children=select('SELECT * FROM runs WHERE parent_run_id=? ORDER BY created_at',parent.id),subtasks=select('SELECT * FROM subtasks WHERE run_id=? ORDER BY created_at',parent.id),messages=select('SELECT id,from_agent,to_agent,content,kind,created_at,correlation_id,expires_at FROM agent_messages WHERE run_id=? ORDER BY created_at LIMIT 200',parent.id);
      const runIds=[parent.id,...children.map(child=>child.id)],events=runIds.flatMap(runId=>select('SELECT id,run_id,event,payload,created_at FROM run_events WHERE run_id=? ORDER BY rowid LIMIT 500',runId).map(event=>({...event,payload:JSON.parse(event.payload)})));
      const nodes=[{id:parent.id,agent:parent.agent,title:parent.task,status:parent.status,supervisor:true,providerId:router.plannerProviderId||router.providerId||null,providerName:router.plannerProviderName||router.providerName||null,model:router.plannerModel||router.model||null,tools:(JSON.parse(parent.context_json||'[]')||[]).filter(x=>x.kind==='tool').map(x=>x.tool),artifacts:[],messages:messages.filter(m=>m.from_agent===parent.agent||m.to_agent===parent.agent)}];
      for(const child of children){let meta={};try{meta=JSON.parse(child.router_json||'{}')}catch{}let context=[];try{context=JSON.parse(child.context_json||'[]')}catch{};nodes.push({id:child.id,agent:child.agent,title:subtasks.find(x=>x.id===meta.subtaskId)?.title||child.task,status:child.status,supervisor:false,subtaskId:meta.subtaskId,subtaskKey:meta.subtask,depends:subtasks.find(x=>x.id===meta.subtaskId)?JSON.parse(subtasks.find(x=>x.id===meta.subtaskId).depends_on||'[]'):[],providerId:meta.providerId||null,providerName:meta.providerName||null,model:meta.model||null,tools:context.filter(x=>x.kind==='tool').map(x=>x.tool),artifacts:[],messages:messages.filter(m=>m.from_agent===child.agent||m.to_agent===child.agent)});}
      for(const event of events){if(event.event==='agent.tool_call'){const node=nodes.find(n=>n.id===event.run_id);if(node&&!node.tools.includes(event.payload.tool))node.tools.push(event.payload.tool);}if(event.event==='worker.event'&&event.payload?.event==='agent.tool_call'){const node=nodes.find(n=>n.id===event.payload.runId);if(node&&!node.tools.includes(event.payload.payload?.tool))node.tools.push(event.payload.payload?.tool);}const result=event.event==='agent.tool_result'?event.payload:event.event==='worker.event'&&event.payload?.event==='agent.tool_result'?event.payload.payload:null;if(result&&['fs.write','fs.edit'].includes(result.tool)&&result.result?.path){const node=nodes.find(n=>n.id===(event.event==='worker.event'?event.payload.runId:event.run_id));if(node)node.artifacts.push({path:result.result.path,tool:result.tool,bytes:result.result.bytes||0,alreadyApplied:Boolean(result.result.alreadyApplied)});}}
      return {id:parent.id,task:parent.task,status:parent.status,created_at:parent.created_at,workflowId:router.workflowId||null,workflowName:router.workflowName||null,plan:router.plan||router.manualPlan||null,nodes,subtasks,messages,events};
    });
    return json(res,200,{workspace:resolve(process.env.ORCHESTRA_WORKSPACE||process.cwd()),agents,providers,tools,workflows,runs});
  }
  const agentModel=url.pathname.match(/^\/api\/agents\/([^/]+)\/model$/);
  if(req.method==='PUT'&&agentModel){const id=agentModel[1],agent=one('SELECT id FROM agents WHERE id=?',id);if(!agent)return json(res,404,{error:'Agent not found'});const d=await body(req),providerId=d.provider_id||null;if(providerId&&!one('SELECT id FROM providers WHERE id=? AND enabled=1',providerId))return json(res,400,{error:'Provider assignment must reference an enabled profile.'});insert('UPDATE agents SET provider_id=?,model_preference=?,updated_at=? WHERE id=?',providerId,providerId?'manual':'auto',now(),id);audit('agent.model_assignment.updated',{agentId:id,providerId,mode:providerId?'manual':'automatic'});return json(res,200,{agent_id:id,provider_id:providerId,mode:providerId?'manual':'automatic'});}
  if(req.method==='GET'&&url.pathname==='/api/mcp/servers')return json(res,200,{items:mcpManager.list()});
  if(req.method==='POST'&&url.pathname==='/api/mcp/servers'){try{return json(res,201,{item:await mcpManager.create(await body(req))});}catch(error){return json(res,400,{error:error.message});}}
  const mcpRoute=url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)(?:\/(connect|disconnect|test))?$/);
  if(mcpRoute){const [,id,action]=mcpRoute;if(req.method==='GET'&&!action){const item=mcpManager.get(id);return item?json(res,200,{item}):json(res,404,{error:'MCP server not found'});}if(req.method==='PUT'&&!action){try{return json(res,200,{item:await mcpManager.update(id,await body(req))});}catch(error){return json(res,400,{error:error.message});}}if(req.method==='DELETE'&&!action){try{return json(res,200,await mcpManager.remove(id));}catch(error){return json(res,404,{error:error.message});}}if(req.method==='POST'&&action==='connect'){try{return json(res,200,await mcpManager.start(id));}catch(error){return json(res,502,{error:error.message});}}if(req.method==='POST'&&action==='disconnect'){await mcpManager.stop(id);return json(res,200,{id,status:'disconnected'});}if(req.method==='POST'&&action==='test'){try{return json(res,200,await mcpManager.test(id));}catch(error){return json(res,502,{error:error.message});}}}
  const collection=url.pathname.match(/^\/api\/(agents|skills|tools|tasks|approvals|proposals|audit|memories)$/);
  if(req.method==='GET' && collection) { const t=collection[1];let items=pageRows(t,url.searchParams.get('limit'),url.searchParams.get('offset'));if(t==='tools')items=items.map(x=>({...x,availability:runtime.toolRegistry.isExecutable(x.id)?'executable':'catalog-only'}));if(t==='agents')items=items.map(x=>({...x,model_mode:x.provider_id?'manual':'automatic',provider_name:x.provider_id?one('SELECT name FROM providers WHERE id=?',x.provider_id)?.name:null}));return json(res,200,{items,total:one(`SELECT count(*) n FROM ${t}`).n}); }
  const checkpointRoute=url.pathname.match(/^\/api\/runs\/([^/]+)\/checkpoint$/);
  if(req.method==='GET'&&checkpointRoute){
    const id=checkpointRoute[1],run=one('SELECT id,status,final_text FROM runs WHERE id=?',id);
    if(!run)return json(res,404,{error:'Run not found'});
    const checkpoint=checkpointStore.get(id);
    return json(res,200,{run_id:id,status:run.status,checkpoint:checkpoint?{approval_id:checkpoint.approval_id,args_hash:checkpoint.args_hash,updated_at:checkpoint.updated_at,persisted:true}:null,checkpoint_retained:Boolean(checkpoint)});
  }
  if(req.method==='GET' && url.pathname.startsWith('/api/runs/')) { const run=one('SELECT * FROM runs WHERE id=?',url.pathname.split('/').pop()); return run?json(res,200,{...run,router:JSON.parse(run.router_json),context:JSON.parse(run.context_json)}):json(res,404,{error:'Run not found'}); }
  if(req.method==='POST' && url.pathname==='/api/route') {
    const data=await body(req); if(!data.task || data.task.length>10000) return json(res,400,{error:'task is required (maximum 10,000 characters)'});
    const decision=route(data.task);
    audit('router.preview',{task:data.task,decision}); return json(res,200,decision);
  }
  if(req.method==='POST' && url.pathname==='/api/chat') {
    const data=await body(req); if(!data.task || data.task.length>10000) return json(res,400,{error:'task is required (maximum 10,000 characters)'});
    const sessionId=currentSessionId(req),result=await runtime.run(data.task,{sessionId,deferCheckpointCleanup:true}),time=now();
    insert('INSERT INTO runs(id,task,agent,status,created_at,router_json,context_json,token_count,session_id) VALUES(?,?,?,?,?,?,?,?,?)',result.id,redact(data.task),result.agent,result.status,time,JSON.stringify(result.decision),JSON.stringify(result.context),result.tokens,sessionId);
    if(result.status!=='awaiting_approval')checkpointStore.delete(result.id);
    audit('run.finished',{runId:result.id,agent:result.agent,status:result.status,tokens:result.tokens}); return json(res,200,{...result,reply:result.text,created_at:time});
  }
  if(req.method==='POST' && url.pathname==='/api/approvals') {
    const data=await body(req); if(!data.tool || !data.args) return json(res,400,{error:'tool and args are required'});
    const policy=decidePolicy({tier:data.tier||'network',tainted:Boolean(data.tainted),mode:'ask',risk:data.risk}); const id=makeId('approval');
    const argsHash=hashArgs(data.args);
    insert('INSERT INTO approvals(id,run_id,tool,args_json,args_hash,reason,created_at) VALUES(?,?,?,?,?,?,?)',id,data.run_id||null,data.tool,JSON.stringify(redact(data.args)),argsHash,policy.reason,now()); audit('approval.requested',{id,tool:data.tool,policy,argsHash});
    return json(res,201,{id,status:'pending',policy});
  }
  if(req.method==='POST' && url.pathname==='/api/tasks') {
    const data=await body(req); if(!data.title || data.title.length>250) return json(res,400,{error:'title is required (maximum 250 characters)'});
    const id=makeId('task'); insert('INSERT INTO tasks(id,title,status,owner,parent_id,created_at) VALUES(?,?,?,?,?,?)',id,redact(data.title),'todo',data.owner||'general',data.parent_id||null,now()); audit('task.created',{id,title:data.title}); return json(res,201,{id,status:'todo'});
  }
  if(req.method==='POST' && url.pathname.startsWith('/api/approvals/')) {
    const id=url.pathname.split('/')[3], data=await body(req); if(!['approved','denied'].includes(data.status)) return json(res,400,{error:'status must be approved or denied'});
    const approval=one('SELECT * FROM approvals WHERE id=?',id); if(!approval) return json(res,404,{error:'Approval not found'}); if(approval.status!=='pending') return json(res,409,{error:'Approval already decided'});
    if(data.args_hash!==approval.args_hash) return json(res,409,{error:'Approval arguments changed; request a new review'});
    const decisionScope=data.status==='approved'?(data.scope||'once'):'once';if(!['once','session','workspace'].includes(decisionScope))return json(res,400,{error:'scope must be once, session, or workspace'});
    const sessionId=currentSessionId(req);
    if(data.status==='approved'&&decisionScope==='session'){
      const grants=sessionPolicyGrants.get(sessionId)||{};grants[approval.tool]='allow';sessionPolicyGrants.set(sessionId,grants);
      const checkpoint=checkpointStore.getForApproval(id);if(checkpoint){checkpoint.state.sessionTools={...checkpoint.state.sessionTools,[approval.tool]:'allow'};checkpointStore.save(approval.run_id,checkpoint.state,id,approval.args_hash,now());}
    }
    if(data.status==='approved'&&decisionScope==='workspace'){
      const policy=readPolicyConfig(),workspace=resolve(process.env.ORCHESTRA_WORKSPACE||process.cwd());
      policy.workspaces[workspace]||={tiers:{},tools:{}};policy.workspaces[workspace].tools[approval.tool]='allow';
      insert('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at','policy',JSON.stringify(policy),now());
    }
    insert('UPDATE approvals SET status=?,decision_scope=? WHERE id=?',data.status,decisionScope,id); audit('approval.decided',{id,status:data.status,scope:decisionScope});
    const decision={approved:data.status==='approved',argsHash:approval.args_hash};
    const waiter=pendingApprovals.get(id);if(waiter)waiter(decision);else if(checkpointStore.getForApproval(id))setImmediate(()=>resumeCheckpointedApproval(id,sessionId));
    if(approval.run_id)emitRunEvent(approval.run_id,data.status==='approved'?'approval.approved':'approval.denied',{approvalId:id,tool:approval.tool});return json(res,200,{id,status:data.status});
  }
  if(req.method==='POST' && url.pathname.startsWith('/api/tasks/')) {
    const id=url.pathname.split('/').pop(), data=await body(req); if(!['todo','doing','done','blocked'].includes(data.status)) return json(res,400,{error:'Invalid task state'});
    insert('UPDATE tasks SET status=? WHERE id=?',data.status,id); audit('task.updated',{id,status:data.status}); return json(res,200,{id,status:data.status});
  }
  if(req.method==='POST' && url.pathname.startsWith('/api/proposals/')) {
    const id=url.pathname.split('/').pop(), data=await body(req); if(!['approved','rejected','snoozed'].includes(data.status)) return json(res,400,{error:'Invalid proposal state'});
    insert('UPDATE proposals SET status=? WHERE id=? AND status="pending"',data.status,id); audit('proposal.reviewed',{id,status:data.status}); return json(res,200,{id,status:data.status});
  }
  if(req.method==='POST' && url.pathname==='/api/memories') {
    const data=await body(req); if(!data.text || data.text.length>20000) return json(res,400,{error:'text required (maximum 20,000 characters)'});
    const id=makeId('memory'); insert('INSERT INTO memories(id,scope,owner,text,tags,created_at) VALUES(?,?,?,?,?,?)',id,data.scope||'workspace','local-user',redact(data.text),JSON.stringify(data.tags||[]),now()); audit('memory.created',{id,scope:data.scope||'workspace'}); return json(res,201,{id});
  }
  if(req.method==='GET' && url.pathname==='/api/settings') return json(res,200,{items:select('SELECT key,value,updated_at FROM settings ORDER BY key')});
  if(req.method==='GET'&&url.pathname==='/api/policy')return json(res,200,{policy:readPolicyConfig(),workspace:resolve(process.env.ORCHESTRA_WORKSPACE||process.cwd())});
  if(req.method==='PUT'&&url.pathname==='/api/policy'){
    const data=await body(req);let policy;try{policy=validatePolicyConfig(data.policy);}catch(error){return json(res,400,{error:error.message});}
    insert('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at','policy',JSON.stringify(policy),now());
    audit('policy.updated',{policy});return json(res,200,{policy,updated_at:now()});
  }
  if(req.method==='GET' && url.pathname==='/api/providers') return json(res,200,{items:select('SELECT id,name,type,base_url,model,enabled,timeout_ms,temperature,max_tokens,key_suffix,last_tested_at,last_latency_ms,last_error,input_tokens,output_tokens,created_at,updated_at FROM providers ORDER BY name').map(p=>({...p,has_key:Boolean(one('SELECT key_ref FROM providers WHERE id=?',p.id)?.key_ref),masked_key:p.key_suffix?`••••${p.key_suffix}`:null})),defaultId:one("SELECT value FROM settings WHERE key='default_provider'")?.value?JSON.parse(one("SELECT value FROM settings WHERE key='default_provider'").value):null});
  if(req.method==='POST' && url.pathname==='/api/providers') {
    const d=await body(req);if(!d.name||typeof d.name!=='string'||d.name.length>80||!['anthropic','openai-compatible'].includes(d.type)||!d.model||typeof d.model!=='string'||d.model.length>200||d.type==='openai-compatible'&&!d.base_url)return json(res,400,{error:'name, supported type, model, and OpenAI-compatible base_url are required'});
    const timeout=Number(d.timeout_ms??30000),maxTokens=Number(d.max_tokens??1200),temperature=Number(d.temperature??.2);if(!Number.isInteger(timeout)||timeout<250||timeout>120000||!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>8192||!Number.isFinite(temperature)||temperature<0||temperature>2)return json(res,400,{error:'timeout_ms (250-120000), max_tokens (1-8192), or temperature (0-2) is invalid'});
    let baseUrl='https://api.anthropic.com';try{if(d.type==='openai-compatible')baseUrl=await validateProviderEndpoint(d.base_url);}catch(error){return json(res,400,{error:error.message});}
    if(d.api_key!==undefined&&(typeof d.api_key!=='string'||d.api_key.length<8||Buffer.byteLength(d.api_key)>4096))return json(res,400,{error:'API key length is invalid'});
    const id=makeId('provider'),ref=`provider:${id}`;if(d.api_key)await secretStore.storeSecret(ref,d.api_key);
    insert('INSERT INTO providers(id,name,type,base_url,model,key_ref,enabled,created_at,updated_at,timeout_ms,temperature,max_tokens,key_suffix) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,redact(d.name),d.type,baseUrl,redact(d.model),d.api_key?ref:null,d.enabled===false?0:1,now(),now(),timeout,temperature,maxTokens,d.api_key?d.api_key.slice(-4):null);audit('provider.created',{id,name:d.name,type:d.type,hasKey:Boolean(d.api_key)});return json(res,201,{id,name:d.name,type:d.type,model:d.model,has_key:Boolean(d.api_key),masked_key:d.api_key?`••••${d.api_key.slice(-4)}`:null});
  }
  if(req.method==='PUT' && url.pathname.match(/^\/api\/providers\/[^/]+$/)) {
    const id=url.pathname.split('/').pop(),p=one('SELECT * FROM providers WHERE id=?',id);if(!p)return json(res,404,{error:'Provider profile not found'});const d=await body(req),type=d.type??p.type;if(!['anthropic','openai-compatible'].includes(type))return json(res,400,{error:'Unsupported provider type'});
    const model=d.model??p.model,name=d.name??p.name;if(typeof name!=='string'||!name||name.length>80||typeof model!=='string'||!model||model.length>200)return json(res,400,{error:'Provider name or model is invalid'});
    const timeout=Number(d.timeout_ms??p.timeout_ms),maxTokens=Number(d.max_tokens??p.max_tokens),temperature=Number(d.temperature??p.temperature);if(!Number.isInteger(timeout)||timeout<250||timeout>120000||!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>8192||!Number.isFinite(temperature)||temperature<0||temperature>2)return json(res,400,{error:'timeout_ms (250-120000), max_tokens (1-8192), or temperature (0-2) is invalid'});
    let baseUrl=type==='anthropic'?'https://api.anthropic.com':d.base_url??p.base_url;try{if(type==='openai-compatible')baseUrl=await validateProviderEndpoint(baseUrl);}catch(error){return json(res,400,{error:error.message});}
    let keyRef=p.key_ref,keySuffix=p.key_suffix;if(d.api_key!==undefined&&d.api_key!==''){if(typeof d.api_key!=='string'||d.api_key.length<8||Buffer.byteLength(d.api_key)>4096)return json(res,400,{error:'API key length is invalid'});keyRef=keyRef||`provider:${id}`;await secretStore.storeSecret(keyRef,d.api_key);keySuffix=d.api_key.slice(-4);}
    const enabled=d.enabled===undefined?p.enabled:(d.enabled?1:0);insert('UPDATE providers SET name=?,type=?,base_url=?,model=?,enabled=?,key_ref=?,updated_at=?,timeout_ms=?,temperature=?,max_tokens=?,key_suffix=? WHERE id=?',redact(name),type,baseUrl,redact(model),enabled,keyRef,now(),timeout,temperature,maxTokens,keySuffix,id);if(!enabled){const detached=one('SELECT count(*) n FROM agents WHERE provider_id=?',id).n;insert("UPDATE agents SET provider_id=NULL,model_preference='auto',updated_at=? WHERE provider_id=?",now(),id);if(detached)audit('agent.model_assignments.cleared',{providerId:id,count:detached,reason:'provider_disabled'});}audit('provider.updated',{id,rotatedKey:d.api_key!==undefined&&d.api_key!==''});return json(res,200,{id,updated:true,has_key:Boolean(keyRef),masked_key:keySuffix?`••••${keySuffix}`:null});
  }
  if(req.method==='DELETE' && url.pathname.startsWith('/api/providers/')) {const id=url.pathname.split('/').pop(),p=one('SELECT key_ref FROM providers WHERE id=?',id);if(!p)return json(res,404,{error:'Provider profile not found'});if(p.key_ref)await secretStore.deleteSecret(p.key_ref);const detached=one('SELECT count(*) n FROM agents WHERE provider_id=?',id).n;insert("UPDATE agents SET provider_id=NULL,model_preference='auto',updated_at=? WHERE provider_id=?",now(),id);insert('DELETE FROM providers WHERE id=?',id);if(one("SELECT value FROM settings WHERE key='default_provider'")?.value===JSON.stringify(id))insert('DELETE FROM settings WHERE key=?','default_provider');audit('provider.deleted',{id,detachedAgents:detached});return json(res,200,{id,deleted:true,detachedAgents:detached});}
  if(req.method==='POST' && url.pathname.match(/^\/api\/providers\/[^/]+\/test$/)) {const id=url.pathname.split('/')[3],p=one('SELECT * FROM providers WHERE id=?',id);if(!p)return json(res,404,{error:'Provider profile not found'});const started=Date.now();try{const client=await providerManager.getForProfile(p),reply=await client.chat({messages:[{role:'user',content:'Reply with OK.'}],tools:[],max_tokens:8});const latency=Date.now()-started;insert('UPDATE providers SET last_tested_at=?,last_latency_ms=?,last_error=NULL WHERE id=?',now(),latency,id);return json(res,200,{connected:true,provider:p.type,model:p.model,latency_ms:latency,usage:reply.usage||{input_tokens:0,output_tokens:0}});}catch{const latency=Date.now()-started;insert("UPDATE providers SET last_tested_at=?,last_latency_ms=?,last_error='Provider connection failed.' WHERE id=?",now(),latency,id);return json(res,502,{code:'PROVIDER_UNAVAILABLE',error:'Provider connection failed.',suggestion:'Check the provider endpoint, credentials, and service availability.',connected:false,provider:p.type,latency_ms:latency});}}
  if(req.method==='POST' && url.pathname.match(/^\/api\/providers\/[^/]+\/default$/)) {const id=url.pathname.split('/')[3],p=one('SELECT id FROM providers WHERE id=? AND enabled=1',id);if(!p)return json(res,404,{error:'Enabled provider profile not found'});insert('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at','default_provider',JSON.stringify(id),now());audit('provider.default.changed',{id});return json(res,200,{defaultId:id});}
  if(req.method==='PUT' && url.pathname.startsWith('/api/settings/')) { const key=url.pathname.split('/').pop(), data=await body(req); insert('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',key,JSON.stringify(data.value),now()); audit('settings.updated',{key,value:data.value}); return json(res,200,{key,value:data.value}); }
  if(req.method==='GET' && url.pathname==='/api/export') { const out=Object.fromEntries(['runs','agents','skills','tools','approvals','tasks','proposals','audit','memories'].map(t=>[t,pageRows(t,250,0)])); return json(res,200,redact(out)); }
  if(url.pathname.startsWith('/api/')) return json(res,404,{error:'API route not found'});
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(file.includes('..') || file.includes('\\')) return json(res,400,{error:'Invalid path'});
  try { const content=await readFile(join(publicDir,file)); const type=file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'; res.writeHead(200,{'content-type':`${type}; charset=utf-8`,'content-security-policy':"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff','referrer-policy':'no-referrer'}); res.end(content); } catch { json(res,404,{error:'Not found'}); }
}

const server=http.createServer((req,res)=>{ res.requestId=makeId('req'); handle(req,res).catch(err=>{const normalized=errorEnvelope(err,res.requestId);console.error(JSON.stringify({level:'error',requestId:res.requestId,route:new URL(req.url,'http://localhost').pathname,status:normalized.status,code:normalized.payload.error.code,message:normalized.payload.error.message}));json(res,normalized.status,normalized.payload); }); });
server.listen(port,'127.0.0.1',()=>{
 console.log(`Orchestra dashboard: http://127.0.0.1:${port}`);console.log(`Data directory: ${dataDir}`);
 for(const row of select('SELECT approval_id FROM runtime_checkpoints'))scheduleApprovalRecovery(row.approval_id);
 mcpManager.startEnabled().catch(()=>{});
 for(const row of select(`SELECT id FROM runs p WHERE parent_run_id IS NULL AND status IN ('planning','waiting_for_approval')
   AND router_json LIKE '%"plan"%' AND NOT EXISTS(SELECT 1 FROM runtime_checkpoints c JOIN runs child ON child.id=c.run_id WHERE child.parent_run_id=p.id)`))scheduleParentRecovery(row.id);
});
for (const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>{server.close(async()=>{await mcpManager.shutdown();db.close();process.exit(0);});});
