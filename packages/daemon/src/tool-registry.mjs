const RISK_BY_TIER={read:'read',write:'write',exec:'exec',screen:'screen',network:'network'};
const RISK_LEVELS=new Set(['read','write','exec','screen','network','send']);
import { decidePolicy, hashArgs } from './core.mjs';
const OUTPUT_SCHEMAS={
 'fs.read':{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false},
 'fs.list':{type:'object',properties:{path:{type:'string'},entries:{type:'array'}},required:['path','entries'],additionalProperties:false},
 'fs.search':{type:'object',properties:{matches:{type:'array'},filesScanned:{type:'integer'},truncated:{type:'boolean'}},required:['matches','filesScanned','truncated'],additionalProperties:false},
 'fs.write':{type:'object',properties:{path:{type:'string'},bytes:{type:'integer'},alreadyApplied:{type:'boolean'}},required:['path','bytes'],additionalProperties:true},
 'fs.edit':{type:'object',properties:{path:{type:'string'},bytes:{type:'integer'},alreadyApplied:{type:'boolean'}},required:['path','bytes'],additionalProperties:false},
 'task.create':{type:'object',properties:{id:{type:'string'},status:{type:'string'}},required:['id','status'],additionalProperties:false},
 'task.update':{type:'object',properties:{id:{type:'string'},status:{type:'string'}},required:['id','status'],additionalProperties:false},
 'memory.write':{type:'object',properties:{id:{type:'string'},scope:{type:'string'}},required:['id','scope'],additionalProperties:false},
 'memory.search':{type:'array',items:{type:'object',properties:{},additionalProperties:true}},
 'git.status':{type:'object',properties:{command:{type:'string'},output:{type:'string'},truncated:{type:'boolean'}},required:['command','output','truncated'],additionalProperties:false},
 'git.diff':{type:'object',properties:{command:{type:'string'},output:{type:'string'},truncated:{type:'boolean'}},required:['command','output','truncated'],additionalProperties:false},
 'git.log':{type:'object',properties:{command:{type:'string'},output:{type:'string'},truncated:{type:'boolean'}},required:['command','output','truncated'],additionalProperties:false},
 'agent.message':{type:'object',properties:{id:{type:'string'},to_agent:{type:['string','null']},kind:{type:'string'},correlation_id:{type:['string','null']},expires_at:{type:['string','null']},status:{type:'string'}},required:['id','kind','status'],additionalProperties:true},
 'agent.inbox':{type:'array',items:{type:'object',properties:{},additionalProperties:true}},
 'blackboard.read':{type:'array',items:{type:'object',properties:{},additionalProperties:true}},
 'blackboard.write':{type:'object',properties:{key:{type:'string'},version:{type:'integer'},author:{type:'string'}},required:['key','version','author'],additionalProperties:false},
 'shell.exec':{type:'object',properties:{stdout:{type:'string'},stderr:{type:'string'},exitCode:{type:'integer'},timeoutMs:{type:'integer'}},required:['stdout','stderr','exitCode','timeoutMs'],additionalProperties:false}
};

function assertSchema(schema,label){
 if(!schema||typeof schema!=='object'||Array.isArray(schema)||!(typeof schema.type==='string'&&['object','array','string','number','integer','boolean','null'].includes(schema.type))&&!(Array.isArray(schema.type)&&schema.type.length>0&&schema.type.every(type=>['object','array','string','number','integer','boolean','null'].includes(type))))throw new Error(`${label} has an unsupported schema`);
 if(Array.isArray(schema.type)){for(const type of schema.type)assertSchema({...schema,type},label);return;}
 if(schema.type==='object'){
  if(!schema.properties||typeof schema.properties!=='object'||Array.isArray(schema.properties))throw new Error(`${label} object schema needs properties`);
  for(const [name,property] of Object.entries(schema.properties))assertSchema(property,`${label}.${name}`);
  if(schema.required&&!Array.isArray(schema.required))throw new Error(`${label}.required must be an array`);
 }
 if(schema.type==='array'&&schema.items)assertSchema(schema.items,`${label}[]`);
}
function validateValue(value,schema,path){
 const allowed=Array.isArray(schema.type)?schema.type:[schema.type];
 const matches=type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):type==='integer'?Number.isInteger(value):typeof value===type;
 if(!allowed.some(matches))throw new Error(`${path} must be ${allowed.join(' or ')}`);
 if(schema.enum&&!schema.enum.includes(value))throw new Error(`${path} must be one of ${schema.enum.join(', ')}`);
 if(typeof value==='string'&&schema.maxLength!==undefined&&value.length>schema.maxLength)throw new Error(`${path} exceeds ${schema.maxLength} characters`);
 if(typeof value==='string'&&schema.minLength!==undefined&&value.length<schema.minLength)throw new Error(`${path} must contain at least ${schema.minLength} characters`);
 if(typeof value==='number'&&schema.minimum!==undefined&&value<schema.minimum)throw new Error(`${path} must be at least ${schema.minimum}`);
 if(typeof value==='number'&&schema.maximum!==undefined&&value>schema.maximum)throw new Error(`${path} must be at most ${schema.maximum}`);
 if(Array.isArray(value)){if(schema.maxItems!==undefined&&value.length>schema.maxItems)throw new Error(`${path} has too many items`);if(schema.items)value.forEach((item,index)=>validateValue(item,schema.items,`${path}[${index}]`));}
 if(allowed.includes('object')&&value&&typeof value==='object'&&!Array.isArray(value)){
  for(const key of schema.required||[])if(!(key in value))throw new Error(`${path}.${key} is required`);
  for(const [key,item] of Object.entries(value)){const property=schema.properties?.[key];if(!property&&schema.additionalProperties===false)throw new Error(`${path}.${key} is not allowed`);if(property)validateValue(item,property,`${path}.${key}`);}
 }
}

export class ToolRegistry {
 constructor(specs,executors={}){
  if(!Array.isArray(specs))throw new Error('Tool registry requires a list of specs');this.specs=new Map();this.executors=new Map(Object.entries(executors));this.executionGrants=new WeakMap();
  for(const source of specs){if(!source||typeof source.name!=='string'||! /^[a-z][a-z0-9_.-]{0,100}$/.test(source.name))throw new Error('Tool name is invalid');if(this.specs.has(source.name))throw new Error(`Duplicate tool: ${source.name}`);if(!Object.hasOwn(RISK_BY_TIER,source.tier))throw new Error(`Tool ${source.name} has an invalid tier`);assertSchema(source.parameters,`${source.name} input`);const spec={...source,risk:source.risk||RISK_BY_TIER[source.tier],source:source.source||'bundled',availability:this.executors.has(source.name)?'executable':'catalog-only',outputSchema:source.outputSchema||OUTPUT_SCHEMAS[source.name]||{type:'object',properties:{},additionalProperties:true}};if(!RISK_LEVELS.has(spec.risk))throw new Error(`Tool ${source.name} has an invalid risk`);assertSchema(spec.outputSchema,`${source.name} output`);this.specs.set(spec.name,Object.freeze(spec));}
 }
 register(source,executor){if(!source||typeof source.name!=='string'||! /^[a-z][a-z0-9_.-]{0,100}$/.test(source.name))throw new Error('Tool name is invalid');if(this.specs.has(source.name))throw new Error('Duplicate tool: '+source.name);if(!Object.hasOwn(RISK_BY_TIER,source.tier))throw new Error('Tool tier is invalid');assertSchema(source.parameters,'Tool input');if(typeof executor!=='function')throw new Error('Tool executor must be a function');if(source.allowedAgents!==undefined&&(!Array.isArray(source.allowedAgents)||source.allowedAgents.some(agent=>typeof agent!=='string')))throw new Error('Tool allowedAgents is invalid');const spec={...source,risk:source.risk||RISK_BY_TIER[source.tier],source:source.source||'mcp',availability:'executable',outputSchema:source.outputSchema||{type:'object',properties:{},additionalProperties:true}};if(!RISK_LEVELS.has(spec.risk))throw new Error('Tool risk is invalid');assertSchema(spec.outputSchema,'Tool output');this.specs.set(spec.name,Object.freeze(spec));this.executors.set(spec.name,executor);return spec;}
 unregister(name){this.executors.delete(name);return this.specs.delete(name);}
 get(name){return this.specs.get(name)||null;}
 list(){return [...this.specs.values()];}
 isExecutable(name){return this.specs.has(name)&&this.executors.has(name);}
 validate(name,args){const spec=this.get(name);if(!spec)throw new Error('Tool is not registered');validateValue(args,spec.parameters,`${name} arguments`);return args;}
 providerTools(agentId=null){return this.list().filter(spec=>this.isExecutable(spec.name)&&(!spec.allowedAgents||!agentId||spec.allowedAgents.includes(agentId))).map(spec=>({name:spec.name,description:spec.description,parameters:spec.parameters}));}
 isAvailableTo(name,agentId){const spec=this.get(name);return Boolean(spec&&this.isExecutable(name)&&(!spec.allowedAgents||spec.allowedAgents.includes(agentId)));}
 authorize(name,args,{mode,tainted=false,context={},approval=null}={}){
  const spec=this.get(name);if(!spec||!this.isExecutable(name))throw new Error(`Tool is unavailable: ${name}`);this.validate(name,args);
  const policy=decidePolicy({tier:spec.tier,risk:spec.risk,mode,tainted,context});
  if(policy.decision==='deny')throw new Error(`Policy denied ${name}: ${policy.reason}`);
  const argsHash=hashArgs(args),approved=policy.decision==='ask'&&approval?.status==='approved'&&typeof approval.approvalId==='string'&&approval.approvalId.length>0&&approval.argsHash===argsHash;
  if(policy.decision==='ask'&&!approved)throw new Error(`Policy approval is missing or does not match ${name} arguments`);
  const grant=Object.freeze({});this.executionGrants.set(grant,{name,argsHash,decision:policy.decision,approvalId:approved?approval.approvalId:null});
  return {grant,policy};
 }
 async execute(name,args,scope={}){if(!this.isExecutable(name))throw new Error(`Tool is unavailable: ${name}`);const spec=this.get(name);this.validate(name,args);const record=scope.authorization&&this.executionGrants.get(scope.authorization);if(!record||record.name!==name||record.argsHash!==hashArgs(args))throw new Error(`Tool execution is not authorized: ${name}`);this.executionGrants.delete(scope.authorization);const result=await this.executors.get(name)(args,scope);validateValue(result,spec.outputSchema,`${name} result`);return result;}
}

export const BUILTIN_TOOL_SPECS = [
  {
    name: "fs.read",
    description: "Read a UTF-8 text file inside the active workspace.",
    tier: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "fs.list",
    description: "List files and folders inside a workspace directory.",
    tier: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "fs.search",
    description: "Find a literal string in bounded workspace text files.",
    tier: "read",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, path: { type: "string" } },
      required: ["query"], additionalProperties: false,
    },
  },
  {
    name: "fs.write",
    description: "Write UTF-8 text to a workspace file. Requires approval.",
    tier: "write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "fs.edit",
    description: "Replace one exact occurrence in a workspace file. Requires approval.",
    tier: "write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, search: { type: "string" }, replacement: { type: "string" } },
      required: ["path", "search", "replacement"], additionalProperties: false,
    },
  },
  {
    name: "task.create",
    description: "Add a task to the local task board.",
    tier: "write",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, owner: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {name:"task.update",description:"Update a task status on the local board.",tier:"write",parameters:{type:"object",properties:{id:{type:"string"},status:{type:"string",enum:["todo","doing","done","blocked"]}},required:["id","status"],additionalProperties:false}},
  {name:"memory.write",description:"Save a redacted workspace memory note.",tier:"write",parameters:{type:"object",properties:{text:{type:"string"},tags:{type:"array",items:{type:"string"}}},required:["text"],additionalProperties:false}},
  {
    name: "memory.search",
    description: "Search local workspace and private memory.",
    tier: "read",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  ...[
    ["git.status", "Read the active workspace Git status."],
    ["git.diff", "Read the unstaged workspace diff."],
    ["git.log", "Read recent workspace commit summaries."],
  ].map(([name,description])=>({name,description,tier:"read",parameters:{type:"object",properties:{},additionalProperties:false}})),
  {name:"agent.message",description:"Send a durable run-scoped message or request/reply to another active worker.",tier:"write",parameters:{type:"object",properties:{to_agent:{type:"string"},content:{type:"string",maxLength:12000},kind:{type:"string",enum:["message","request","reply"]},reply_to:{type:"string"},timeout_ms:{type:"integer",minimum:1000,maximum:300000}},required:["content"],additionalProperties:false}},
  {name:"agent.inbox",description:"Read ordered run-scoped messages once, with an optional bounded wait for replies.",tier:"read",parameters:{type:"object",properties:{limit:{type:"integer",minimum:1,maximum:50},wait_ms:{type:"integer",minimum:0,maximum:30000}},additionalProperties:false}},
  {name:"blackboard.read",description:"Read the shared run blackboard, optionally selecting one key.",tier:"read",parameters:{type:"object",properties:{key:{type:"string",maxLength:200}},additionalProperties:false}},
  {name:"blackboard.write",description:"Publish a value to the shared run blackboard for other workers.",tier:"write",parameters:{type:"object",properties:{key:{type:"string",maxLength:200},value:{type:"string",maxLength:12000},confidence:{type:"number",minimum:0,maximum:1}},required:["key","value"],additionalProperties:false}},
  {name:"shell.exec",description:"Run one argument-array command in a no-network sandbox rooted at the workspace. Requires approval.",tier:"exec",parameters:{type:"object",properties:{command:{type:"string",minLength:1,maxLength:500},args:{type:"array",items:{type:"string",maxLength:4000},maxItems:64},timeout_ms:{type:"integer",minimum:100,maximum:10000}},required:["command","args"],additionalProperties:false}},
];;

export const BUILTIN_IMPLEMENTATION_NAMES=Object.freeze(BUILTIN_TOOL_SPECS.map(spec=>spec.name));
export const DEFAULT_TOOL_REGISTRY=new ToolRegistry(BUILTIN_TOOL_SPECS,{});
export const isExecutableTool=name=>BUILTIN_IMPLEMENTATION_NAMES.includes(name);
