const migrations = [
  {
    version: 2,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_checkpoints (
          run_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          approval_id TEXT,
          args_hash TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_checkpoints_approval
          ON runtime_checkpoints(approval_id);

        CREATE TABLE IF NOT EXISTS connectors (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          account_id TEXT,
          display_name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'disconnected',
          token_ref TEXT,
          scopes_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connector_grants (
          id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          scopes_json TEXT NOT NULL DEFAULT '[]',
          granted_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          UNIQUE(connector_id, agent_id)
        );

        CREATE TABLE IF NOT EXISTS library_items (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('agent','skill','tool')),
          name TEXT NOT NULL,
          definition_json TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'active',
          version INTEGER NOT NULL DEFAULT 1,
          pinned INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'local',
          content_hash TEXT NOT NULL,
          deleted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_library_items_state ON library_items(kind,state,pinned);
        CREATE TABLE IF NOT EXISTS library_history (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES library_items(id),
          version INTEGER NOT NULL,
          definition_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          change_reason TEXT NOT NULL,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(item_id,version)
        );
        CREATE TABLE IF NOT EXISTS item_metrics (
          item_id TEXT NOT NULL,
          metric TEXT NOT NULL,
          value REAL NOT NULL,
          sample_count INTEGER NOT NULL DEFAULT 0,
          measured_at TEXT NOT NULL,
          PRIMARY KEY(item_id,metric,measured_at)
        );
        CREATE TABLE IF NOT EXISTS llm_calls (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          request_json TEXT NOT NULL,
          response_json TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          latency_ms INTEGER,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id,created_at);
        CREATE TABLE IF NOT EXISTS updates (
          id TEXT PRIMARY KEY,
          component TEXT NOT NULL,
          channel TEXT NOT NULL,
          from_version TEXT,
          to_version TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          permission_diff_json TEXT NOT NULL DEFAULT '[]',
          state TEXT NOT NULL,
          previous_path TEXT,
          installed_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings_history (
          id TEXT PRIMARY KEY,
          setting_key TEXT NOT NULL,
          old_value_json TEXT,
          new_value_json TEXT,
          changed_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      const proposalColumns = new Set(db.prepare('PRAGMA table_info(proposals)').all().map((column) => column.name));
      const additions = {
        diff: "TEXT NOT NULL DEFAULT ''",
        created_by: "TEXT NOT NULL DEFAULT 'system'",
        updated_at: 'TEXT',
        evidence_json: "TEXT NOT NULL DEFAULT '[]'",
      };
      for (const [name, declaration] of Object.entries(additions)) {
        if (!proposalColumns.has(name)) db.exec(`ALTER TABLE proposals ADD COLUMN ${name} ${declaration}`);
      }
    },
  },
  {
    version: 3,
    apply(db) {
      for(const [table,name,declaration] of [
        ['runs','session_id','TEXT'],
        ['approvals','decision_scope',"TEXT NOT NULL DEFAULT 'once'"],
      ]){
        const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
        if(!columns.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
      }
    },
  },
  {
    version: 4,
    apply(db) {
      const hasTools=db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='tools'").get();
      if(hasTools)db.exec("UPDATE tools SET risk='write' WHERE id IN ('agent.message','blackboard.write')");
    },
  },
  {
    version: 5,
    apply(db) {
      const hasMessages=db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='agent_messages'").get();
      if(hasMessages){const columns=new Set(db.prepare('PRAGMA table_info(agent_messages)').all().map(column=>column.name));
        for(const [name,declaration] of [['correlation_id','TEXT'],['expires_at','TEXT']])if(!columns.has(name))db.exec(`ALTER TABLE agent_messages ADD COLUMN ${name} ${declaration}`);}
      db.exec(`CREATE TABLE IF NOT EXISTS agent_message_cursors(
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        last_rowid INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id,agent_id)
      );
      `);
      if(hasMessages)db.exec('CREATE INDEX IF NOT EXISTS idx_agent_messages_delivery ON agent_messages(run_id,to_agent,created_at); CREATE INDEX IF NOT EXISTS idx_agent_messages_correlation ON agent_messages(run_id,correlation_id);');
    },
  },
  {
    version: 6,
    apply(db) {
      const hasProviders=db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='providers'").get();
      if(!hasProviders)return;
      const columns=new Set(db.prepare('PRAGMA table_info(providers)').all().map(column=>column.name));
      for(const [name,declaration] of [
        ['timeout_ms','INTEGER NOT NULL DEFAULT 30000'],['temperature','REAL NOT NULL DEFAULT 0.2'],['max_tokens','INTEGER NOT NULL DEFAULT 1200'],
        ['key_suffix','TEXT'],['last_tested_at','TEXT'],['last_latency_ms','INTEGER'],['last_error','TEXT'],
        ['input_tokens','INTEGER NOT NULL DEFAULT 0'],['output_tokens','INTEGER NOT NULL DEFAULT 0'],
      ])if(!columns.has(name))db.exec(`ALTER TABLE providers ADD COLUMN ${name} ${declaration}`);
    },
  },
  {
    version: 7,
    apply(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS blackboard_acl(
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        can_read INTEGER NOT NULL DEFAULT 0,
        can_write INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id,key,agent_id)
      );
      CREATE TABLE IF NOT EXISTS blackboard_history(
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        author_agent TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blackboard_history_run_key ON blackboard_history(run_id,key,version);
      CREATE INDEX IF NOT EXISTS idx_blackboard_acl_agent ON blackboard_acl(run_id,agent_id);`);
    },
  },
  {
    version: 8,
    apply(db) {
      const agents=db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='agents'").get();
      if(agents){const columns=new Set(db.prepare('PRAGMA table_info(agents)').all().map(column=>column.name));if(!columns.has('provider_id'))db.exec('ALTER TABLE agents ADD COLUMN provider_id TEXT');}
      db.exec(`CREATE TABLE IF NOT EXISTS workflows(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflows_updated ON workflows(updated_at DESC);`);
    },
  },
  {
    version: 9,
    apply(db) {
      const hasTools=db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='tools'").get();
      if(hasTools){const toolColumns=new Set(db.prepare('PRAGMA table_info(tools)').all().map(column=>column.name));
        for(const [name,declaration] of [['source',"TEXT NOT NULL DEFAULT 'builtin'"],['server_id','TEXT']])if(!toolColumns.has(name))db.exec(`ALTER TABLE tools ADD COLUMN ${name} ${declaration}`);}
      db.exec(`CREATE TABLE IF NOT EXISTS mcp_servers(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT '[]',
        cwd TEXT,
        env_names_json TEXT NOT NULL DEFAULT '[]',
        tier TEXT NOT NULL DEFAULT 'write',
        trusted INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 0,
        allowed_agents_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'disabled',
        last_error TEXT,
        last_latency_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled,trusted);
      `);
    },
  },
  {
    version: 10,
    apply(db) {
      const columns=new Set(db.prepare('PRAGMA table_info(mcp_servers)').all().map(column=>column.name));
      for(const [name,declaration] of [['transport_type',"TEXT NOT NULL DEFAULT 'stdio'"],['url','TEXT'],['auth_env_name','TEXT']])if(!columns.has(name))db.exec(`ALTER TABLE mcp_servers ADD COLUMN ${name} ${declaration}`);
    },
  },
];

export function runMigrations(db, now = () => new Date().toISOString()) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  // Version 1 is the pre-migration inline schema shipped by early Orchestra builds.
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)').run(now());
  for (const migration of migrations) {
    const exists = db.prepare('SELECT 1 AS present FROM schema_migrations WHERE version=?').get(migration.version);
    if (exists) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.apply(db);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(migration.version, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
