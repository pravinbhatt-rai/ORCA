import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAICompatProvider, validateProviderEndpoint, ProviderManager } from '../src/llm.mjs';

test('provider endpoint validation permits loopback HTTP and blocks unsafe targets',async()=>{
 assert.equal(await validateProviderEndpoint('http://localhost:11434/v1/'),'http://localhost:11434/v1');
 assert.equal(await validateProviderEndpoint('http://127.0.0.1:1234/v1'),'http://127.0.0.1:1234/v1');
 for(const url of ['http://example.com/v1','https://127.0.0.1/v1','https://10.1.2.3/v1','http://user:pass@localhost/v1','https://example.com/v1?token=x'])await assert.rejects(()=>validateProviderEndpoint(url));
});

test('OpenAI-compatible adapter round-trips tools, usage, profile limits, and timeout',async t=>{
 let body;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'done',tool_calls:[{id:'call-1',type:'function',function:{name:'fs.read',arguments:'{"path":"note.txt"}'}}]}}],usage:{prompt_tokens:7,completion_tokens:3}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const provider=new OpenAICompatProvider({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',apiKey:'test-secret',maxTokens:12,temperature:.4,timeoutMs:1000});
 const reply=await provider.chat({messages:[{role:'user',content:'read'}],tools:[{name:'fs.read',description:'read',parameters:{type:'object'}}],max_tokens:100});
 assert.equal(reply.text,'done');assert.deepEqual(reply.toolCalls[0],{id:'call-1',name:'fs.read',arguments:{path:'note.txt'}});assert.deepEqual(reply.usage,{input_tokens:7,output_tokens:3});assert.equal(body.max_tokens,12);assert.equal(body.temperature,.4);assert.equal(body.tools[0].function.name,'fs.read');
 const slow=http.createServer(()=>{});await new Promise(resolve=>slow.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>slow.close(resolve)));
 const bounded=new OpenAICompatProvider({baseUrl:`http://127.0.0.1:${slow.address().port}/v1`,model:'fixture',timeoutMs:250});await assert.rejects(()=>bounded.chat({messages:[],tools:[]}),/abort|timeout/i);
});

test('ProviderManager applies profile settings and records runtime token usage',async t=>{
 const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok'}}],usage:{prompt_tokens:11,completion_tokens:5}}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const profile={id:'p1',type:'openai-compatible',base_url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',timeout_ms:2500,max_tokens:42,temperature:.6},usage={input:0,output:0};
 const manager=new ProviderManager({db:{prepare(sql){return {get:()=>sql.includes('default_provider')?{value:JSON.stringify('p1')}:profile,run:(...args)=>{usage.input+=args[0];usage.output+=args[1];}}}},secretStore:{readSecret:async()=>null}});
 const provider=await manager.getDefault();assert.equal(provider.timeoutMs,2500);assert.equal(provider.maxTokens,42);assert.equal(provider.temperature,.6);
 await provider.chat({messages:[],tools:[]});assert.deepEqual(usage,{input:11,output:5});
 await assert.rejects(()=>manager.getForProfile({...profile,base_url:'https://169.254.169.254/latest'}),/private or local/);
});
