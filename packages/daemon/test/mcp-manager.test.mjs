import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { runMigrations } from '../src/migrations.mjs';
import { McpClientManager } from '../src/connectors/mcp-manager.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';

test('MCP stdio manager imports namespaced tools and enforces trust and agent grants', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE tools(id TEXT PRIMARY KEY,name TEXT,description TEXT,risk TEXT,tags TEXT,enabled INTEGER DEFAULT 1); CREATE TABLE proposals(id TEXT PRIMARY KEY,kind TEXT,target TEXT,title TEXT,evidence TEXT,status TEXT,created_at TEXT); CREATE TABLE runs(id TEXT PRIMARY KEY,task TEXT,status TEXT,created_at TEXT); CREATE TABLE approvals(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,created_at TEXT); CREATE TABLE agent_messages(id TEXT PRIMARY KEY,run_id TEXT,from_agent TEXT,to_agent TEXT,content TEXT,kind TEXT,created_at TEXT); CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT,type TEXT,base_url TEXT,model TEXT,key_ref TEXT,enabled INTEGER,created_at TEXT,updated_at TEXT);`);
  runMigrations(db);
  db.prepare('INSERT INTO agents(id,status) VALUES(?,?)').run('researcher', 'active');
  const registry = new ToolRegistry([]);
  const root = resolve(process.cwd());
  const manager = new McpClientManager({ db, registry, workspaceRoot: root, timeoutMs: 5000 });
  t.after(() => manager.shutdown());
  const item = await manager.create({ id: 'fixture-server', name: 'Fixture', command: process.execPath, args: [resolve('packages/daemon/fixtures/fake-mcp.mjs')] });
  assert.equal(item.trusted, 0);
  await assert.rejects(manager.start(item.id), /explicitly trusted and enabled/);
  await manager.update(item.id, { trusted: true, enabled: true, allowed_agents: ['researcher'] });
  assert.ok(registry.get('mcp.fixture-server.echo'));
  assert.deepEqual(registry.providerTools('researcher').map(tool => tool.name), ['mcp.fixture-server.echo']);
  assert.deepEqual(registry.providerTools('other-agent'), []);
  await assert.rejects(manager.call(item.id, 'echo', { message: 'blocked' }, { agentId: 'other-agent' }), /not granted/);
  const reply = await manager.call(item.id, 'echo', { message: 'hello' }, { agentId: 'researcher' });
  assert.equal(reply.content[0].text, 'hello');
  assert.equal(db.prepare("SELECT source FROM tools WHERE id='mcp.fixture-server.echo'").get().source, 'mcp');
  await manager.stop(item.id);
  assert.equal(registry.get('mcp.fixture-server.echo'), null);
});

test('MCP configuration rejects unsafe environment names and workspace escapes', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE tools(id TEXT PRIMARY KEY,name TEXT,description TEXT,risk TEXT,tags TEXT,enabled INTEGER DEFAULT 1); CREATE TABLE proposals(id TEXT PRIMARY KEY,kind TEXT,target TEXT,title TEXT,evidence TEXT,status TEXT,created_at TEXT); CREATE TABLE runs(id TEXT PRIMARY KEY,task TEXT,status TEXT,created_at TEXT); CREATE TABLE approvals(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,created_at TEXT); CREATE TABLE agent_messages(id TEXT PRIMARY KEY,run_id TEXT,from_agent TEXT,to_agent TEXT,content TEXT,kind TEXT,created_at TEXT); CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT,type TEXT,base_url TEXT,model TEXT,key_ref TEXT,enabled INTEGER,created_at TEXT,updated_at TEXT);`);
  runMigrations(db);
  const manager = new McpClientManager({ db, registry: new ToolRegistry([]), workspaceRoot: process.cwd() });
  t.after(() => manager.shutdown());
  await assert.rejects(manager.create({ id: 'unsafe', name: 'Unsafe', command: process.execPath, env_names: ['PATH'] }), /environment names/);
  await assert.rejects(manager.create({ id: 'outside', name: 'Outside', command: process.execPath, cwd: '..' }), /inside the workspace/);
});

test('Streamable HTTP MCP transport connects, authenticates from the environment, and calls imported tools', async (t) => {
  const oldToken=process.env.ORCHESTRA_FIXTURE_TOKEN;process.env.ORCHESTRA_FIXTURE_TOKEN='fixture-secret';
  const child = spawn(process.execPath, [resolve('packages/daemon/fixtures/fake-mcp-http.mjs')], { env: { ...process.env, ORCHESTRA_FIXTURE_TOKEN: 'fixture-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopFixture=async()=>{child.kill('SIGTERM');await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),new Promise(resolveDelay=>setTimeout(resolveDelay,2000))]);};
  let stdout='',stderr='';child.stderr.on('data',chunk=>stderr+=chunk.toString());
  const portReady = new Promise((resolvePort, reject) => {
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();const match=stdout.match(/(\d+)\s/);if(match)resolvePort(Number(match[1]));});
    child.once('error',reject);child.once('exit',code=>{if(code!==null&&code!==0)reject(new Error('HTTP MCP fixture exited: '+code));});
  });
  const port = await portReady;
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE tools(id TEXT PRIMARY KEY,name TEXT,description TEXT,risk TEXT,tags TEXT,enabled INTEGER DEFAULT 1); CREATE TABLE proposals(id TEXT PRIMARY KEY,kind TEXT,target TEXT,title TEXT,evidence TEXT,status TEXT,created_at TEXT); CREATE TABLE runs(id TEXT PRIMARY KEY,task TEXT,status TEXT,created_at TEXT); CREATE TABLE approvals(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,created_at TEXT); CREATE TABLE agent_messages(id TEXT PRIMARY KEY,run_id TEXT,from_agent TEXT,to_agent TEXT,content TEXT,kind TEXT,created_at TEXT); CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT,type TEXT,base_url TEXT,model TEXT,key_ref TEXT,enabled INTEGER,created_at TEXT,updated_at TEXT);`);
  runMigrations(db);
  db.prepare('INSERT INTO agents(id,status) VALUES(?,?)').run('researcher', 'active');
  const registry = new ToolRegistry([]),manager = new McpClientManager({db,registry,workspaceRoot:process.cwd(),timeoutMs:5000});
  t.after(async()=>{await manager.shutdown();db.close();await stopFixture();if(oldToken===undefined)delete process.env.ORCHESTRA_FIXTURE_TOKEN;else process.env.ORCHESTRA_FIXTURE_TOKEN=oldToken;});
  const item = await manager.create({id:'http-fixture',name:'HTTP fixture',transport_type:'streamable-http',url:`http://127.0.0.1:${port}/mcp`,auth_env_name:'ORCHESTRA_FIXTURE_TOKEN'});
  assert.equal(item.auth_env_name,'ORCHESTRA_FIXTURE_TOKEN');
  try{await manager.update(item.id,{trusted:true,enabled:true,allowed_agents:['researcher']});}catch(error){throw new Error(`${error.message}; fixture stderr: ${stderr}`);}
  assert.equal(registry.get('mcp.http-fixture.echo')?.source,'mcp');
  assert.equal((await manager.call(item.id,'echo',{message:'hello'}, {agentId:'researcher'})).content[0].text,'hello');
});
