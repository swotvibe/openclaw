import { describe, expect, it } from "vitest";
import {
  OPENCLAW_SAAS_POSTGRES_MIGRATIONS,
  SAAS_TENANT_CONTEXT_SQL,
  SAAS_TENANT_SCOPED_TABLES,
  getSaasPostgresMigration,
  listSaasPostgresMigrations,
  resolvePendingSaasPostgresMigrations,
} from "./postgres-migrations.js";

function foundationSql(): string {
  const migration = getSaasPostgresMigration("0001_saas_foundation");
  if (!migration) {
    throw new Error("missing foundation migration");
  }
  return migration.sql;
}

function allMigrationSql(): string {
  return OPENCLAW_SAAS_POSTGRES_MIGRATIONS.map((migration) => migration.sql).join("\n");
}

describe("SaaS PostgreSQL migrations", () => {
  it("keeps migration ids stable, unique, and sorted", () => {
    const ids = OPENCLAW_SAAS_POSTGRES_MIGRATIONS.map((migration) => migration.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
    expect(listSaasPostgresMigrations()).toBe(OPENCLAW_SAAS_POSTGRES_MIGRATIONS);
  });

  it("defines a tenant context function backed by PostgreSQL settings", () => {
    const sql = foundationSql();

    expect(SAAS_TENANT_CONTEXT_SQL).toBe("openclaw_saas.current_tenant_id()");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION openclaw_saas.current_tenant_id()");
    expect(sql).toContain("current_setting('app.current_tenant_id', true)");
  });

  it("enables forced RLS and a tenant isolation policy on every tenant-scoped table", () => {
    const sql = allMigrationSql();

    for (const table of SAAS_TENANT_SCOPED_TABLES) {
      expect(sql).toContain(`ALTER TABLE openclaw_saas.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE openclaw_saas.${table} FORCE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`DROP POLICY IF EXISTS tenant_isolation ON openclaw_saas.${table};`);
      expect(sql).toContain(`CREATE POLICY tenant_isolation ON openclaw_saas.${table}`);
    }
  });

  it("creates the tenant-owned stores needed before routing SaaS traffic to PostgreSQL", () => {
    const sql = allMigrationSql();

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS openclaw_saas.tenants");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS openclaw_saas.agents");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS openclaw_saas.sessions");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS openclaw_saas.task_runs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS openclaw_saas.task_delivery_state");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS openclaw_saas.usage_events");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS openclaw_saas.tenant_deks");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS openclaw_saas.tenant_secrets");
  });

  it("resolves pending migrations from the ledger ids", () => {
    expect(resolvePendingSaasPostgresMigrations([])).toEqual(OPENCLAW_SAAS_POSTGRES_MIGRATIONS);
    expect(
      resolvePendingSaasPostgresMigrations(["0001_saas_foundation"]).map(
        (migration) => migration.id,
      ),
    ).toEqual(["0002_saas_tenant_deks"]);
    expect(
      resolvePendingSaasPostgresMigrations(["0001_saas_foundation", "0002_saas_tenant_deks"]),
    ).toEqual([]);
  });
});
