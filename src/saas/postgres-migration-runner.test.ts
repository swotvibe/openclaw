import { describe, expect, it } from "vitest";
import { calculateSaasPostgresMigrationChecksum } from "./postgres-migration-plan.js";
import {
  SAAS_POSTGRES_MIGRATION_BOOTSTRAP_SQL,
  SaasPostgresMigrationRunnerError,
  loadAppliedSaasPostgresMigrations,
  loadAppliedSaasPostgresMigrationsReadOnly,
  runSaasPostgresMigrations,
  type SaasPostgresQueryExecutor,
} from "./postgres-migration-runner.js";
import {
  OPENCLAW_SAAS_POSTGRES_MIGRATIONS,
  getSaasPostgresMigration,
} from "./postgres-migrations.js";

type QueryCall = {
  sql: string;
  params?: readonly unknown[];
};

function createExecutor(params?: {
  appliedRows?: readonly Record<string, unknown>[];
  migrationLedgerExists?: boolean;
  failOnSqlIncludes?: string;
}): SaasPostgresQueryExecutor & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      queryParams?: readonly unknown[],
    ) {
      calls.push(queryParams ? { sql, params: queryParams } : { sql });
      if (params?.failOnSqlIncludes && sql.includes(params.failOnSqlIncludes)) {
        throw new Error("query failed");
      }
      if (sql.startsWith("SELECT to_regclass")) {
        return {
          rows: [
            {
              regclass:
                params?.migrationLedgerExists === false ? null : "openclaw_saas.schema_migrations",
            },
          ] as unknown as readonly TRow[],
        };
      }
      if (sql.startsWith("SELECT id, checksum")) {
        return { rows: (params?.appliedRows ?? []) as readonly TRow[] };
      }
      return { rows: [] as readonly TRow[] };
    },
  };
}

describe("loadAppliedSaasPostgresMigrations", () => {
  it("bootstraps the migration ledger before reading applied rows", async () => {
    const executor = createExecutor({
      appliedRows: [{ id: "0001_saas_foundation", checksum: "abc" }],
    });

    await expect(loadAppliedSaasPostgresMigrations(executor)).resolves.toEqual([
      { id: "0001_saas_foundation", checksum: "abc" },
    ]);

    expect(executor.calls.map((call) => call.sql)).toEqual([
      SAAS_POSTGRES_MIGRATION_BOOTSTRAP_SQL,
      expect.stringContaining("SELECT id, checksum"),
    ]);
  });

  it("rejects malformed migration ledger rows", async () => {
    const executor = createExecutor({
      appliedRows: [{ id: "0001_saas_foundation", checksum: 1 }],
    });

    await expect(loadAppliedSaasPostgresMigrations(executor)).rejects.toThrow(
      SaasPostgresMigrationRunnerError,
    );
  });
});

describe("loadAppliedSaasPostgresMigrationsReadOnly", () => {
  it("returns no applied migrations when the ledger table does not exist", async () => {
    const executor = createExecutor({ migrationLedgerExists: false });

    await expect(loadAppliedSaasPostgresMigrationsReadOnly(executor)).resolves.toEqual([]);

    expect(executor.calls.map((call) => call.sql)).toEqual([
      expect.stringContaining("SELECT to_regclass"),
    ]);
  });

  it("reads applied migrations without bootstrapping schema objects", async () => {
    const executor = createExecutor({
      appliedRows: [{ id: "0001_saas_foundation", checksum: "abc" }],
    });

    await expect(loadAppliedSaasPostgresMigrationsReadOnly(executor)).resolves.toEqual([
      { id: "0001_saas_foundation", checksum: "abc" },
    ]);

    expect(executor.calls.map((call) => call.sql)).toEqual([
      expect.stringContaining("SELECT to_regclass"),
      expect.stringContaining("SELECT id, checksum"),
    ]);
  });
});

describe("runSaasPostgresMigrations", () => {
  it("applies pending migrations under a locked transaction and records checksums", async () => {
    const migrations = OPENCLAW_SAAS_POSTGRES_MIGRATIONS;
    const applied = migrations.map((migration) => ({
      id: migration.id,
      checksum: calculateSaasPostgresMigrationChecksum(migration),
    }));
    const executor = createExecutor();

    await expect(runSaasPostgresMigrations(executor)).resolves.toEqual({
      applied,
      pendingBeforeRun: migrations,
    });

    expect(executor.calls.map((call) => call.sql)).toEqual([
      SAAS_POSTGRES_MIGRATION_BOOTSTRAP_SQL,
      "BEGIN",
      "LOCK TABLE openclaw_saas.schema_migrations IN ACCESS EXCLUSIVE MODE",
      expect.stringContaining("SELECT id, checksum"),
      migrations[0]?.sql,
      expect.stringContaining("INSERT INTO openclaw_saas.schema_migrations"),
      migrations[1]?.sql,
      expect.stringContaining("INSERT INTO openclaw_saas.schema_migrations"),
      "COMMIT",
    ]);
    expect(executor.calls.at(-2)?.params).toEqual(["0002_saas_tenant_deks", applied[1]?.checksum]);
  });

  it("commits without applying anything when all migrations are current", async () => {
    const executor = createExecutor({
      appliedRows: OPENCLAW_SAAS_POSTGRES_MIGRATIONS.map((migration) => ({
        id: migration.id,
        checksum: calculateSaasPostgresMigrationChecksum(migration),
      })),
    });

    await expect(runSaasPostgresMigrations(executor)).resolves.toEqual({
      applied: [],
      pendingBeforeRun: [],
    });

    expect(executor.calls.map((call) => call.sql)).toEqual([
      SAAS_POSTGRES_MIGRATION_BOOTSTRAP_SQL,
      "BEGIN",
      "LOCK TABLE openclaw_saas.schema_migrations IN ACCESS EXCLUSIVE MODE",
      expect.stringContaining("SELECT id, checksum"),
      "COMMIT",
    ]);
  });

  it("rolls back and blocks checksum drift", async () => {
    const executor = createExecutor({
      appliedRows: [{ id: "0001_saas_foundation", checksum: "old" }],
    });

    await expect(runSaasPostgresMigrations(executor)).rejects.toThrow(
      SaasPostgresMigrationRunnerError,
    );
    expect(executor.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rolls back migration execution failures", async () => {
    const executor = createExecutor({
      failOnSqlIncludes: "CREATE TABLE IF NOT EXISTS openclaw_saas.tenants",
    });

    await expect(runSaasPostgresMigrations(executor)).rejects.toThrow(
      SaasPostgresMigrationRunnerError,
    );
    expect(executor.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});
