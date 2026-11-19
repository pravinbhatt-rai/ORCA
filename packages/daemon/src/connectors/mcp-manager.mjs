import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolve, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { validateProviderEndpoint } from '../llm.mjs';

const idPattern=/^[a-z][a-z0-9_-]{1,40}$/;
const tierNames=new Set(['read','write','exec','screen','network']);
const envNamePattern=/^[A-Z][A-Z0-9_]{0,80}$/;
const SAFE_ENV=['PATH','HOME','USER','TMPDIR','TEMP','SystemRoot','WINDIR','LANG','LC_ALL','APPDATA','LOCALAPPDATA'];
const json=(value,fallback)=>{try{return JSON.parse(value||'')}catch{return fallback}};

export class McpClientManager {
  constructor({db,registry,workspaceRoot,now=()=>new Date().toISOString(),audit=()=>{},timeoutMs=8000}){
    this.db=db;this.registry=registry;this.workspaceRoot=resolve(workspaceRoot);this.now=now;this.audit=audit;this.timeoutMs=timeoutMs;this.connections=new Map();
  }
  list(){return this.db.prepare('SELECT * FROM mcp_servers ORDER BY name').all().map(row=>({...row,args:json(row.args_json,[]),env_names:json(row.env_names_json,[]),allowed_agents:json(row.allowed_agents_json,[]),args_json:undefined,env_names_json:undefined,allowed_agents_json:undefined}));}
  validate(input,{partial=false}={}){
    const d=input||{};
    const id=d.id??d.name?.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-|-$/g,'');
    const transport=d.transport_type||(partial?undefined:'stdio');
    if(transport!==undefined&&!['stdio','streamable-http'].includes(transport))throw new Error('MCP transport must be stdio or streamable-http.');
    if(!partial&&(!idPattern.test(id||'')||typeof d.name!=='string'||!d.name.trim()||d.name.length>80||transport==='stdio'&&(typeof d.command!=='string'||!d.command.trim()||d.command.length>1000)||transport==='streamable-http'&&(typeof d.url!=='string'||!d.url.trim())))throw new Error('MCP server requires a valid id, name, and transport configuration.');
    if(id!==undefined&&!idPattern.test(id))throw new Error('MCP server id must be a lowercase slug (2-41 characters).');
    if(d.name!==undefined&&(typeof d.name!=='string'||!d.name.trim()||d.name.length>80))throw new Error('MCP server name is invalid.');
    if(d.command!==undefined&&(typeof d.command!=='string'||!d.command.trim()||d.command.length>1000))throw new Error('MCP command is invalid.');
    if(d.transport_type!==undefined&&!['stdio','streamable-http'].includes(d.transport_type))throw new Error('MCP transport must be stdio or streamable-http.');
    if(d.url!==undefined&&(typeof d.url!=='string'||d.url.length>2000))throw new Error('MCP URL is invalid.');
    if(d.auth_env_name!==undefined&&d.auth_env_name!==null&&(typeof d.auth_env_name!=='string'||!envNamePattern.test(d.auth_env_name)||SAFE_ENV.includes(d.auth_env_name)))throw new Error('MCP auth_env_name must name an explicit uppercase secret environment variable.');
    if(d.args!==undefined&&(!Array.isArray(d.args)||d.args.length>64||d.args.some(x=>typeof x!=='string'||x.length>4000)))throw new Error('MCP arguments must be an array of at most 64 strings.');
    if(d.env_names!==undefined&&(!Array.isArray(d.env_names)||d.env_names.length>64||d.env_names.some(x=>typeof x!=='string'||!envNamePattern.test(x)||SAFE_ENV.includes(x))))throw new Error('MCP environment names must be explicit uppercase secret/config variable names.');
    if(d.cwd!==undefined&&d.cwd!==null&&typeof d.cwd!=='string')throw new Error('MCP working directory must be a workspace-relative path.');
    if(d.tier!==undefined&&!tierNames.has(d.tier))throw new Error('MCP tool tier is invalid.');
    if(d.allowed_agents!==undefined&&(!Array.isArray(d.allowed_agents)||d.allowed_agents.length>100||d.allowed_agents.some(x=>typeof x!=='string')))throw new Error('MCP allowed_agents must be a list of agent IDs.');
    if(d.trusted!==undefined&&typeof d.trusted!=='boolean'||d.enabled!==undefined&&typeof d.enabled!=='boolean')throw new Error('MCP trust and enabled flags must be boolean.');
    return {...d,id,...(transport?{transport_type:transport}:{})};
  }
  async create(input){
    const d=this.validate(input);if(this.db.prepare('SELECT id FROM mcp_servers WHERE id=?').get(d.id))throw new Error('MCP server id already exists.');
    const cwd=d.transport_type==='stdio'?await this.resolveCwd(d.cwd||'.'):null,url=d.transport_type==='streamable-http'?await validateProviderEndpoint(d.url):null,time=this.now();
    this.db.prepare('INSERT INTO mcp_servers(id,name,command,args_json,cwd,env_names_json,tier,trusted,enabled,allowed_agents_json,status,created_at,updated_at,transport_type,url,auth_env_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(d.id,d.name.trim(),d.command||'',JSON.stringify(d.args||[]),cwd,JSON.stringify(d.env_names||[]),d.tier||'write',0,0,JSON.stringify([]),'disabled',time,time,d.transport_type,url,d.auth_env_name||null);
    this.audit('mcp.server.created',{id:d.id,name:d.name,transport:d.transport_type,command:d.transport_type==='stdio'?d.command:undefined,args:d.args||[],url});return this.get(d.id);
  }
  get(id){const row=this.db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id);return row?{...row,args:json(row.args_json,[]),env_names:json(row.env_names_json,[]),allowed_agents:json(row.allowed_agents_json,[]),args_json:undefined,env_names_json:undefined,allowed_agents_json:undefined}:null;}
  async resolveCwd(value){const requested=resolve(this.workspaceRoot,value||'.'),canonicalRoot=await realpath(this.workspaceRoot),canonical=await realpath(requested),rel=relative(canonicalRoot,canonical);if(rel==='..'||rel.startsWith(`..${sep}`)||rel.startsWith(sep))throw new Error('MCP working directory must remain inside the workspace.');return canonical;}
  async update(id,input){const row=this.get(id);if(!row)throw new Error('MCP server not found.');const d=this.validate(input,{partial:true}),next={...row,...d};next.transport_type=d.transport_type||row.transport_type||'stdio';if(next.transport_type==='stdio'&&d.cwd!==undefined)next.cwd=await this.resolveCwd(d.cwd||'.');if(next.transport_type==='streamable-http'&&d.url!==undefined)next.url=await validateProviderEndpoint(d.url);const agents=next.allowed_agents||[];if(agents.length){const placeholders=agents.map(()=>'?').join(',');const found=this.db.prepare(`SELECT count(*) AS n FROM agents WHERE status='active' AND id IN (${placeholders})`).get(...agents).n;if(found!==agents.length)throw new Error('Every MCP grant must reference an active agent.');}
    await this.stop(id);this.db.prepare('UPDATE mcp_servers SET name=?,command=?,args_json=?,cwd=?,env_names_json=?,tier=?,trusted=?,enabled=?,allowed_agents_json=?,status=?,updated_at=?,transport_type=?,url=?,auth_env_name=? WHERE id=?').run(next.name,next.command||'',JSON.stringify(next.args||[]),next.cwd,JSON.stringify(next.env_names||[]),next.tier||'write',next.trusted?1:0,next.enabled?1:0,JSON.stringify(agents),next.enabled&&next.trusted?'starting':'disabled',this.now(),next.transport_type,next.url||null,next.auth_env_name||null,id);this.removeCatalog(id);
    if(next.enabled&&next.trusted)await this.start(id);else this.setStatus(id,'disabled');this.audit('mcp.server.updated',{id,trusted:Boolean(next.trusted),enabled:Boolean(next.enabled),allowedAgents:agents,tier:next.tier||'write'});return this.get(id);
  }
  setStatus(id,status,error=null,latency=null){this.db.prepare('UPDATE mcp_servers SET status=?,last_error=?,last_latency_ms=?,updated_at=? WHERE id=?').run(status,error,latency,this.now(),id);}
  removeCatalog(id){const rows=this.db.prepare("SELECT id FROM tools WHERE source='mcp' AND server_id=?").all(id);for(const row of rows)this.registry.unregister(row.id);this.db.prepare("DELETE FROM tools WHERE source='mcp' AND server_id=?").run(id);}
  async connect(row){
    if((row.transport_type||'stdio')==='streamable-http'){
      const headers={};if(row.auth_env_name){const token=process.env[row.auth_env_name];if(token)headers.Authorization=/^Bearer\s/i.test(token)?token:`Bearer ${token}`;}
      const transport=new StreamableHTTPClientTransport(new URL(row.url),{requestInit:{headers,redirect:'error'},redirectPolicy:'same-origin',reconnectionOptions:{initialReconnectionDelay:250,maxReconnectionDelay:3000,reconnectionDelayGrowFactor:2,maxRetries:3}}),client=new Client({name:'orchestra-local',version:'0.1.0'},{capabilities:{}});
      try{await Promise.race([client.connect(transport),new Promise((_,reject)=>setTimeout(()=>reject(new Error('MCP server initialization timed out.')),this.timeoutMs))]);const listed=await client.listTools({}, {timeout:this.timeoutMs});return {client,transport,tools:listed.tools||[]};}catch(error){await transport.close().catch(()=>{});throw error;}
    }
    const env={};for(const name of json(row.env_names_json,[])){const value=process.env[name];if(value!==undefined)env[name]=value;}
    const client=new Client({name:'orchestra-local',version:'0.1.0'},{capabilities:{}}),transport=new StdioClientTransport({command:row.command,args:json(row.args_json,[]),cwd:row.cwd,env,stderr:'pipe',maxBufferSize:2*1024*1024});
    const killTimer=setTimeout(()=>transport.close().catch(()=>{}),this.timeoutMs);
    try{await Promise.race([client.connect(transport),new Promise((_,reject)=>setTimeout(()=>reject(new Error('MCP server initialization timed out.')),this.timeoutMs))]);const listed=await client.listTools({}, {timeout:this.timeoutMs});clearTimeout(killTimer);return {client,transport,tools:listed.tools||[]};}
    catch(error){clearTimeout(killTimer);await transport.close().catch(()=>{});throw error;}
  }
  async start(id){
    const row=this.db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id);if(!row)throw new Error('MCP server not found.');if(!row.enabled||!row.trusted){this.setStatus(id,'disabled');throw new Error('MCP server must be explicitly trusted and enabled before it can start.');}
    const started=Date.now();this.setStatus(id,'starting');let connected;
    try{connected=await this.connect(row);}catch(first){await new Promise(resolve=>setTimeout(resolve,100));try{connected=await this.connect(row);}catch(second){this.setStatus(id,'error',String(second.message||first.message).slice(0,300),Date.now()-started);this.audit('mcp.server.connect_failed',{id,message:'MCP server connection failed.'});throw new Error('MCP server connection failed: '+String(second.message||first.message).slice(0,200));}}
    const agents=json(row.allowed_agents_json,[]),registered=[];
    try{for(const tool of connected.tools){if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(tool.name))throw new Error('MCP tool name contains unsupported characters.');const name=`mcp.${id}.${tool.name.toLowerCase().replace(/[^a-z0-9_.-]/g,'_')}`;if(this.registry.get(name))throw new Error('MCP tool name collision: '+name);if(!tool.inputSchema||tool.inputSchema.type!=='object')throw new Error('MCP tool input schema must be a JSON object schema.');const spec={name,description:`${tool.description||tool.name} (MCP server: ${row.name})`,parameters:tool.inputSchema,tier:row.tier,source:'mcp',serverId:id,remoteName:tool.name,allowedAgents:agents};this.registry.register(spec,(args,scope)=>this.call(id,tool.name,args,scope));registered.push({id:name,name:tool.name,description:tool.description||tool.name,parameters:tool.inputSchema,tier:row.tier,tags:['mcp',`server:${id}`]});}
      for(const tool of registered)this.db.prepare("INSERT INTO tools(id,name,description,risk,tags,enabled,source,server_id) VALUES(?,?,?,?,?,1,'mcp',?)").run(tool.id,tool.name,tool.description,tool.tier,JSON.stringify(tool.tags),id);
    }catch(error){for(const tool of registered)this.registry.unregister(tool.id);await connected.transport.close().catch(()=>{});this.setStatus(id,'error',String(error.message).slice(0,300),Date.now()-started);throw error;}
    this.connections.set(id,connected);this.setStatus(id,'connected',null,Date.now()-started);this.audit('mcp.server.connected',{id,toolCount:registered.length,latencyMs:Date.now()-started});return {id,status:'connected',tools:registered};
  }
  async call(id,remoteName,args,scope){
    const row=this.db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id);if(!row||!row.enabled||!row.trusted)throw new Error('MCP server is disabled or untrusted.');const allowed=json(row.allowed_agents_json,[]);if(!allowed.includes(scope.agentId))throw new Error('Agent is not granted access to this MCP server.');
    let current=this.connections.get(id);if(!current){await this.start(id);current=this.connections.get(id);}const started=Date.now();
    try{const result=await current.client.callTool({name:remoteName,arguments:args},undefined,{timeout:this.timeoutMs,signal:scope.signal});const safe=JSON.stringify(result);if(safe.length>100000)throw new Error('MCP tool response exceeded 100 KB.');this.setStatus(id,'connected',null,Date.now()-started);return {content:result.content||[],structuredContent:result.structuredContent||null,isError:Boolean(result.isError)};}
    catch(error){this.setStatus(id,'error',String(error.message||'MCP call failed').slice(0,300),Date.now()-started);throw new Error('MCP tool call failed: '+String(error.message||'server error').slice(0,250));}
  }
  async test(id){const row=this.db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id);if(!row)throw new Error('MCP server not found.');const started=Date.now();let connected;try{connected=await this.connect(row);await connected.client.ping({timeout:this.timeoutMs});const toolCount=connected.tools.length;this.setStatus(id,'connected',null,Date.now()-started);return {connected:true,toolCount,latencyMs:Date.now()-started};}catch(error){this.setStatus(id,'error',String(error.message).slice(0,300),Date.now()-started);throw error;}finally{if(connected)await connected.transport.close().catch(()=>{});}}
  async stop(id){const conn=this.connections.get(id);if(!conn){this.removeCatalog(id);return false;}this.connections.delete(id);this.removeCatalog(id);await conn.transport.close().catch(()=>{});this.setStatus(id,'disconnected');return true;}
  async remove(id){const row=this.get(id);if(!row)throw new Error('MCP server not found.');await this.stop(id);this.db.prepare('DELETE FROM mcp_servers WHERE id=?').run(id);this.audit('mcp.server.deleted',{id});return {id,deleted:true};}
  async startEnabled(){const result=[];for(const row of this.db.prepare('SELECT id FROM mcp_servers WHERE enabled=1 AND trusted=1 ORDER BY id').all()){try{result.push(await this.start(row.id));}catch{}}return result;}
  async shutdown(){for(const id of [...this.connections.keys()])await this.stop(id);}
}
