export type SaasPostgresMigration = {
  id: string;
  description: string;
  sql: string;
};

export const SAAS_POSTGRES_SCHEMA = "openclaw_saas";

export const SAAS_TENANT_CONTEXT_SQL = "openclaw_saas.current_tenant_id()";

export const SAAS_TENANT_SCOPED_TABLES = [
  "tenants",
  "tenant_users",
  "agents",
  "sessions",
  "task_runs",
  "task_delivery_state",
  "usage_events",
  "tenant_deks",
  "tenant_secrets",
] as const;

export type SaasTenantScopedTable = (typeof SAAS_TENANT_SCOPED_TABLES)[number];

export const OPENCLAW_SAAS_POSTGRES_MIGRATIONS: readonly SaasPostgresMigration[] = [
  {
    id: "0001_saas_foundation",
    description: "Create SaaS tenant, runtime, task, usage, and secret metadata tables with RLS.",
    sql: `
CREATE SCHEMA IF NOT EXISTS openclaw_saas;

CREATE TABLE IF NOT EXISTS openclaw_saas.schema_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION openclaw_saas.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.current_tenant_id', true), '')::uuid
$$;

CREATE TABLE IF NOT EXISTS openclaw_saas.tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openclaw_saas.tenant_users (
  tenant_id uuid NOT NULL REFERENCES openclaw_saas.tenants(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS openclaw_saas.agents (
  tenant_id uuid NOT NULL REFERENCES openclaw_saas.tenants(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  display_name text NOT NULL,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id)
);

CREATE TABLE IF NOT EXISTS openclaw_saas.sessions (
  tenant_id uuid NOT NULL,
  session_id text NOT NULL,
  agent_id text NOT NULL,
  channel_key text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES openclaw_saas.agents(tenant_id, agent_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS openclaw_saas.task_runs (
  tenant_id uuid NOT NULL REFERENCES openclaw_saas.tenants(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  runtime text NOT NULL CHECK (runtime IN ('subagent', 'acp', 'cli', 'cron')),
  task_kind text,
  source_id text,
  requester_session_key text,
  owner_key text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('session', 'system')),
  child_session_key text,
  parent_flow_id text,
  parent_task_id text,
  agent_id text,
  run_id text,
  label text,
  task text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'lost')
  ),
  delivery_status text NOT NULL CHECK (
    delivery_status IN (
      'pending',
      'delivered',
      'session_queued',
      'failed',
      'parent_missing',
      'not_applicable'
    )
  ),
  notify_policy text NOT NULL CHECK (notify_policy IN ('done_only', 'state_changes', 'silent')),
  created_at bigint NOT NULL,
  started_at bigint,
  ended_at bigint,
  last_event_at bigint,
  cleanup_after bigint,
  error text,
  progress_summary text,
  terminal_summary text,
  terminal_outcome text CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('succeeded', 'blocked')),
  PRIMARY KEY (tenant_id, task_id)
);

CREATE TABLE IF NOT EXISTS openclaw_saas.task_delivery_state (
  tenant_id uuid NOT NULL,
  task_id text NOT NULL,
  requester_origin_json jsonb,
  last_notified_event_at bigint,
  PRIMARY KEY (tenant_id, task_id),
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES openclaw_saas.task_runs(tenant_id, task_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS openclaw_saas.usage_events (
  tenant_id uuid NOT NULL REFERENCES openclaw_saas.tenants(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  source text NOT NULL,
  agent_id text,
  session_id text,
  provider text,
  model text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  cost_microusd bigint,
  raw_usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE IF NOT EXISTS openclaw_saas.tenant_secrets (
  tenant_id uuid NOT NULL REFERENCES openclaw_saas.tenants(id) ON DELETE CASCADE,
  secret_ref text NOT NULL,
  provider text NOT NULL,
  key_id text NOT NULL,
  ciphertext bytea NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, secret_ref)
);

CREATE INDEX IF NOT EXISTS idx_saas_sessions_agent
  ON openclaw_saas.sessions(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_saas_task_runs_status
  ON openclaw_saas.task_runs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_saas_task_runs_runtime_status
  ON openclaw_saas.task_runs(tenant_id, runtime, status);
CREATE INDEX IF NOT EXISTS idx_saas_task_runs_cleanup_after
  ON openclaw_saas.task_runs(tenant_id, cleanup_after);
CREATE INDEX IF NOT EXISTS idx_saas_task_runs_last_event_at
  ON openclaw_saas.task_runs(tenant_id, last_event_at);
CREATE INDEX IF NOT EXISTS idx_saas_task_runs_owner_key
  ON openclaw_saas.task_runs(tenant_id, owner_key);
CREATE INDEX IF NOT EXISTS idx_saas_task_runs_parent_flow_id
  ON openclaw_saas.task_runs(tenant_id, parent_flow_id);
CREATE INDEX IF NOT EXISTS idx_saas_task_runs_child_session_key
  ON openclaw_saas.task_runs(tenant_id, child_session_key);
CREATE INDEX IF NOT EXISTS idx_saas_usage_events_occurred_at
  ON openclaw_saas.usage_events(tenant_id, occurred_at);

ALTER TABLE openclaw_saas.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_saas.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON openclaw_saas.tenants;
CREATE POLICY tenant_isolation ON openclaw_saas.tenants
  USING (id = openclaw_saas.current_tenant_id())
  WITH CHECK (id = openclaw_saas.current_tenant_id());

ALTER TABLE openclaw_saas.tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_saas.tenant_users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON openclaw_saas.tenant_users;
CREATE POLICY tenant_isolation ON openclaw_saas.tenant_users
  USING (tenant_id = openclaw_saas.current_tenant_id())
  WITH CHECK (tenant_id = openclaw_saas.current_tenant_id());

ALTER TABLE openclaw_saas.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_saas.agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON openclaw_saas.agents;
CREATE POLICY tenant_isolation ON openclaw_saas.agents
  USING (tenant_id = openclaw_saas.current_tenant_id())
  WITH CHECK (tenant_id = openclaw_saas.current_tenant_id());

ALTER TABLE openclaw_saas.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_saas.sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON openclaw_saas.sessions;
CREATE POLICY tenant_isolation ON openclaw_saas.sessions
  USING (tenant_id = openclaw_saas.current_tenant_id())
  WITH CHECK (tenant_id = openclaw_saas.current_tenant_id());

ALTER TABLE openclaw_saas.task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_saas.task_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON openclaw_saas.task_runs;
CREATE POLICY tenant_isolation ON openclaw_saas.task_runs
  USING (tenant_id = openclaw_saas.current_tenant_id())
  WITH CHECK (tenant_id = openclaw_saas.current_tenant_id());

ALTER TABLE openclaw_saas.task_delivery_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_saas.task_delivery_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON openclaw_saas.task_delivery_state;
CREATE POLICY tenant_isolation ON openclaw_saas.task_delivery_state
  USING (tenant_id = openclaw_saas.current_tenant_id())
  WITH CHECK (tenant_id = openclaw_saas.current_tenant_id());

ALTER TABLE openclaw_saas.usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_saas.usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON openclaw_saas.usage_events;
CREATE POLICY tenant_isolation ON openclaw_saas.usage_events
  USING (tenant_id = openclaw_saas.current_tenant_id())
  WITH CHECK (tenant_id = openclaw_saas.current_tenant_id());

ALTER TABLE openclaw_saas.tenant_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_saas.tenant_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON openclaw_saas.tenant_secrets;
CREATE POLICY tenant_isolation ON openclaw_saas.tenant_secrets
  USING (tenant_id = openclaw_saas.current_tenant_id())
  WITH CHECK (tenant_id = openclaw_saas.current_tenant_id());
`.trim(),
  },
  {
    id: "0002_saas_tenant_deks",
    description: "Create tenant DEK metadata and versioned secret encryption columns with RLS.",
    sql: `
CREATE TABLE IF NOT EXISTS openclaw_saas.tenant_deks (
  tenant_id uuid NOT NULL REFERENCES openclaw_saas.tenants(id) ON DELETE CASCADE,
  version integer NOT NULL,
  encrypted_dek bytea NOT NULL,
  kek_id text NOT NULL,
  algorithm text NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm IN ('aes-256-gcm')),
  is_active boolean NOT NULL DEFAULT true,
  rotated_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_tenant_deks_active
  ON openclaw_saas.tenant_deks(tenant_id)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_saas_tenant_deks_tenant_version
  ON openclaw_saas.tenant_deks(tenant_id, version DESC);

ALTER TABLE openclaw_saas.tenant_secrets
  ADD COLUMN IF NOT EXISTS dek_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS algorithm text NOT NULL DEFAULT 'aes-256-gcm';
ALTER TABLE openclaw_saas.tenant_secrets
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_secrets_algorithm;
ALTER TABLE openclaw_saas.tenant_secrets
  ADD CONSTRAINT chk_saas_tenant_secrets_algorithm CHECK (algorithm IN ('aes-256-gcm'));

ALTER TABLE openclaw_saas.tenant_deks ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_saas.tenant_deks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON openclaw_saas.tenant_deks;
CREATE POLICY tenant_isolation ON openclaw_saas.tenant_deks
  USING (tenant_id = openclaw_saas.current_tenant_id())
  WITH CHECK (tenant_id = openclaw_saas.current_tenant_id());
`.trim(),
  },
] as const;

export function listSaasPostgresMigrations(): readonly SaasPostgresMigration[] {
  return OPENCLAW_SAAS_POSTGRES_MIGRATIONS;
}

export function getSaasPostgresMigration(id: string): SaasPostgresMigration | undefined {
  return OPENCLAW_SAAS_POSTGRES_MIGRATIONS.find((migration) => migration.id === id);
}

export function resolvePendingSaasPostgresMigrations(
  appliedMigrationIds: Iterable<string>,
): readonly SaasPostgresMigration[] {
  const applied = new Set(appliedMigrationIds);
  return OPENCLAW_SAAS_POSTGRES_MIGRATIONS.filter((migration) => !applied.has(migration.id));
}
