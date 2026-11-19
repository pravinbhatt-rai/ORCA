import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/migrations.mjs';
import { CheckpointStore } from '../src/checkpoint-store.mjs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('schema migration upgrades the inline schema and is safe to run repeatedly', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE proposals(id TEXT PRIMARY KEY, kind TEXT, target TEXT, title TEXT, evidence TEXT,
      status TEXT DEFAULT 'pending', created_at TEXT);
    CREATE TABLE tools(id TEXT PRIMARY KEY,name TEXT,description TEXT,risk TEXT,tags TEXT DEFAULT '[]',enabled INTEGER DEFAULT 1);
    CREATE TABLE runs(id TEXT PRIMARY KEY,task TEXT,status TEXT,created_at TEXT);
    CREATE TABLE approvals(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,created_at TEXT);
    CREATE TABLE agent_messages(id TEXT PRIMARY KEY,run_id TEXT,from_agent TEXT,to_agent TEXT,content TEXT,kind TEXT,created_at TEXT);
    CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT,type TEXT,base_url TEXT,model TEXT,key_ref TEXT,enabled INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version,applied_at) VALUES(1,'2026-11-18T00:00:00.000Z');
    INSERT INTO proposals(id,kind,target,title,evidence,created_at)
      VALUES('proposal-1','create','skill-x','Create skill','test evidence','2026-11-18T00:00:00.000Z');
  `);

  runMigrations(db, () => '2026-11-18T01:00:00.000Z');
  runMigrations(db, () => '2026-11-18T02:00:00.000Z');

  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(db.prepare('SELECT title FROM proposals WHERE id=?').get('proposal-1').title, 'Create skill');
  const proposalColumns = new Set(db.prepare('PRAGMA table_info(proposals)').all().map((column) => column.name));
  for (const name of ['diff', 'created_by', 'updated_at', 'evidence_json']) assert.ok(proposalColumns.has(name));
  assert.ok(new Set(db.prepare('PRAGMA table_info(runs)').all().map(column=>column.name)).has('session_id'));
  assert.ok(new Set(db.prepare('PRAGMA table_info(approvals)').all().map(column=>column.name)).has('decision_scope'));
  assert.ok(new Set(db.prepare('PRAGMA table_info(agent_messages)').all().map(column=>column.name)).has('correlation_id'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_message_cursors'").get());
  const providerColumns=new Set(db.prepare('PRAGMA table_info(providers)').all().map(column=>column.name));for(const name of ['timeout_ms','temperature','max_tokens','key_suffix','last_tested_at','last_latency_ms','last_error','input_tokens','output_tokens'])assert.ok(providerColumns.has(name));
  for(const table of ['blackboard_acl','blackboard_history'])assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_servers'").get());
  for (const table of ['runtime_checkpoints', 'connectors', 'connector_grants', 'library_items', 'library_history', 'item_metrics', 'llm_calls', 'updates', 'settings_history']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), `missing table ${table}`);
  }
});

test('failed migration rolls back schema changes and leaves its version unapplied', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  assert.throws(() => runMigrations(db), /no such table: proposals/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version=2').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='runtime_checkpoints'").get().n, 0);
});

test('checkpoint state is authenticated, encrypted at rest, and survives reopening', async (t) => {
  const directory=await mkdtemp(join(tmpdir(),'orchestra-checkpoint-key-'));
  const db=new DatabaseSync(':memory:');t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  db.exec('CREATE TABLE runtime_checkpoints(run_id TEXT PRIMARY KEY,state_json TEXT NOT NULL,approval_id TEXT,args_hash TEXT,attempts INTEGER DEFAULT 0,updated_at TEXT);');
  const first=await CheckpointStore.open(db,directory),state={task:'write',secretPayload:'sensitive checkpoint body'};
  first.save('run-1',state,'approval-1','hash-1');
  const stored=db.prepare('SELECT state_json FROM runtime_checkpoints WHERE run_id=?').get('run-1').state_json;
  assert.doesNotMatch(stored,/sensitive checkpoint body/);
  const reopened=await CheckpointStore.open(db,directory);assert.deepEqual(reopened.getForApproval('approval-1').state,state);
  const mode=(await stat(join(directory,'checkpoint.key'))).mode&0o777;if(process.platform!=='win32')assert.equal(mode,0o600);
  const segments=stored.split('.');segments[3]=(segments[3][0]==='A'?'B':'A')+segments[3].slice(1);const tampered=segments.join('.');
  assert.throws(()=>reopened.unseal(tampered));
  assert.equal((await readFile(join(directory,'checkpoint.key'))).length,32);
});
