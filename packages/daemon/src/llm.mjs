import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

function privateAddress(address){
 const v=isIP(address);if(v===4){const octets=address.split('.').map(Number);return octets[0]===0||octets[0]===10||octets[0]===127||octets[0]>=224||(octets[0]===169&&octets[1]===254)||(octets[0]===172&&octets[1]>=16&&octets[1]<=31)||(octets[0]===192&&octets[1]===168)||(octets[0]===100&&octets[1]>=64&&octets[1]<=127)||(octets[0]===198&&(octets[1]===18||octets[1]===19));}
 if(v===6){const ip=address.toLowerCase();return ip==='::1'||ip==='::'||ip.startsWith('fc')||ip.startsWith('fd')||ip.startsWith('fe8')||ip.startsWith('fe9')||ip.startsWith('fea')||ip.startsWith('feb')||ip.startsWith('::ffff:');}
 return false;
}
export async function validateProviderEndpoint(value){
 let url;try{url=new URL(value);}catch{throw new Error('Provider endpoint must be a valid URL');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Provider endpoint must use HTTP(S) without credentials, query, or fragment');
 const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
 if(url.protocol==='http:'){
  const local=host==='localhost'||host.endsWith('.localhost')||host==='::1'||(isIP(host)===4&&host.startsWith('127.'));
  if(!local)throw new Error('HTTP provider endpoints are allowed only on loopback; use HTTPS for remote hosts');
 }else{
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||privateAddress(host))throw new Error('Provider endpoint cannot target a private or local address');
  if(!isIP(host)){
   let addresses;try{addresses=await lookup(host,{all:true,verbatim:true});}catch{throw new Error('Provider endpoint hostname could not be resolved');}
   if(!addresses.length||addresses.some(({address})=>privateAddress(address)))throw new Error('Provider endpoint resolves to a private or local address');
  }
 }
 return url.toString().replace(/\/$/,'');
}

function requestSignal(signal,timeoutMs){const timeout=AbortSignal.timeout(Math.min(120000,Math.max(250,timeoutMs||30000)));return signal?AbortSignal.any([signal,timeout]):timeout;}

export class MockProvider {
  constructor(script=[]) { this.script=[...script]; }
  async chat({messages,tools=[],signal}) {
    if(signal?.aborted) throw new Error('Request cancelled');
    if(this.script.length) return this.script.shift();
    const user=messages.filter(m=>m.role==='user').at(-1)?.content||'';
    return {text:`Mock response: ${user}\n\nNo model call or tool execution was configured for this run.`,toolCalls:[],usage:{input_tokens:0,output_tokens:0}};
  }
}

export class OpenAICompatProvider {
  constructor({baseUrl,model,apiKey,timeoutMs=30000,maxTokens=8192,temperature=.2,onUsage}) { this.baseUrl=baseUrl.replace(/\/$/,'');this.model=model;this.apiKey=apiKey;this.timeoutMs=timeoutMs;this.maxTokens=maxTokens;this.temperature=temperature;this.onUsage=onUsage; }
  async chat({messages,tools=[],temperature=.2,max_tokens=1200,signal}) {
    const response=await fetch(`${this.baseUrl}/chat/completions`,{method:'POST',signal:requestSignal(signal,this.timeoutMs),headers:{'content-type':'application/json',...(this.apiKey?{authorization:`Bearer ${this.apiKey}`}:{})},body:JSON.stringify({model:this.model,messages,temperature:this.temperature??temperature,max_tokens:Math.min(this.maxTokens??8192,max_tokens),tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})),tool_choice:tools.length?'auto':'none'})});
    if(!response.ok) throw new Error(`OpenAI-compatible provider returned HTTP ${response.status}`);
    const data=await response.json(), choice=data.choices?.[0]?.message;if(!choice)throw new Error('Provider response had no message');
    const usage={input_tokens:data.usage?.prompt_tokens||0,output_tokens:data.usage?.completion_tokens||0};try{this.onUsage?.(usage);}catch{}
    return {text:choice.content||'',toolCalls:(choice.tool_calls||[]).map(c=>({id:c.id,name:c.function.name,arguments:JSON.parse(c.function.arguments)})),usage};
  }
}

export class AnthropicProvider {
  constructor({apiKey,model='claude-sonnet-4-5',timeoutMs=30000,maxTokens=8192,temperature=.2,onUsage}) { this.apiKey=apiKey;this.model=model;this.timeoutMs=timeoutMs;this.maxTokens=maxTokens;this.temperature=temperature;this.onUsage=onUsage; }
  async chat({messages,tools=[],temperature=.2,max_tokens=1200,signal}) {
    const system=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');
    const apiMessages=messages.filter(m=>m.role!=='system').map(m=>{
      if(m.role==='assistant'&&m.tool_calls)return {role:'assistant',content:[...(m.content?[{type:'text',text:m.content}]:[]),...m.tool_calls.map(c=>({type:'tool_use',id:c.id,name:c.function.name,input:JSON.parse(c.function.arguments)}))]};
      if(m.role==='tool')return {role:'user',content:[{type:'tool_result',tool_use_id:m.tool_call_id,content:m.content}]};
      return {role:m.role==='assistant'?'assistant':'user',content:m.content};
    });
    const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',signal:requestSignal(signal,this.timeoutMs),headers:{'content-type':'application/json','x-api-key':this.apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:this.model,system,messages:apiMessages,temperature:this.temperature??temperature,max_tokens:Math.min(this.maxTokens??8192,max_tokens),tools:tools.map(t=>({name:t.name,description:t.description,input_schema:t.parameters}))})});
    if(!response.ok)throw new Error(`Anthropic provider returned HTTP ${response.status}`);
    const data=await response.json(),usage={input_tokens:data.usage?.input_tokens||0,output_tokens:data.usage?.output_tokens||0};try{this.onUsage?.(usage);}catch{}
    return {text:(data.content||[]).filter(x=>x.type==='text').map(x=>x.text).join(''),toolCalls:(data.content||[]).filter(x=>x.type==='tool_use').map(x=>({id:x.id,name:x.name,arguments:x.input})),usage};
  }
}

export function providerFromEnv() {
  if(process.env.ORCHESTRA_PROVIDER==='openai-compatible' && process.env.ORCHESTRA_BASE_URL && process.env.ORCHESTRA_MODEL) return new OpenAICompatProvider({baseUrl:process.env.ORCHESTRA_BASE_URL,model:process.env.ORCHESTRA_MODEL,apiKey:process.env.ORCHESTRA_API_KEY});
  if(process.env.ORCHESTRA_PROVIDER==='anthropic' && process.env.ANTHROPIC_API_KEY) return new AnthropicProvider({apiKey:process.env.ANTHROPIC_API_KEY,model:process.env.ORCHESTRA_MODEL||undefined});
  return new MockProvider();
}

export class ProviderManager {
  constructor({ db, secretStore }) { this.db=db;this.secretStore=secretStore; }
  async getForProfile(profile) {
    const apiKey=profile.key_ref?await this.secretStore.readSecret(profile.key_ref):undefined,timeoutMs=profile.timeout_ms||30000,maxTokens=profile.max_tokens||8192,temperature=profile.temperature??.2,onUsage=usage=>this.db.prepare('UPDATE providers SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE id=?').run(usage.input_tokens||0,usage.output_tokens||0,profile.id);
    let client;if(profile.type==='anthropic')client=new AnthropicProvider({apiKey,model:profile.model,timeoutMs,maxTokens,temperature,onUsage});
    else{const baseUrl=await validateProviderEndpoint(profile.base_url);client=new OpenAICompatProvider({baseUrl,model:profile.model,apiKey,timeoutMs,maxTokens,temperature,onUsage});}
    client.profileId=profile.id;client.profileName=profile.name;client.profileType=profile.type;return client;
  }
  async getDefault() {
    const id=this.db.prepare("SELECT value FROM settings WHERE key='default_provider'").get()?.value;
    const profile=id?this.db.prepare('SELECT * FROM providers WHERE id=? AND enabled=1').get(JSON.parse(id)):null;
    if(profile)return this.getForProfile(profile);
    if(process.env.ORCHESTRA_PROVIDER==='openai-compatible'&&process.env.ORCHESTRA_BASE_URL&&process.env.ORCHESTRA_MODEL)return new OpenAICompatProvider({baseUrl:await validateProviderEndpoint(process.env.ORCHESTRA_BASE_URL),model:process.env.ORCHESTRA_MODEL,apiKey:process.env.ORCHESTRA_API_KEY});
    return providerFromEnv();
  }
}
