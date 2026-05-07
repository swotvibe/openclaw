import {
  type AppliedSaasPostgresMigration,
  buildSaasPostgresMigrationPlan,
  calculateSaasPostgresMigrationChecksum,
} from "./postgres-migration-plan.js";
import { type SaasPostgresMigration } from "./postgres-migrations.js";

export type SaasPostgresQueryResult<
  TRow extends Record<string, unknown> = Record<string, unknown>,
> = {
  rows: readonly TRow[];
};

export type SaasPostgresQueryExecutor = {
  query: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ) => Promise<SaasPostgresQueryResult<TRow>>;
};

export type RunSaasPostgresMigrationsResult = {
  applied: readonly AppliedSaasPostgresMigration[];
  pendingBeforeRun: readonly SaasPostgresMigration[];
};

type SchemaMigrationRow = {
  id: unknown;
  checksum: unknown;
};

type RegclassRow = {
  regclass: unknown;
};

export class SaasPostgresMigrationRunnerError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SaasPostgresMigrationRunnerError";
  }
}

export const SAAS_POSTGRES_MIGRATION_BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS openclaw_saas;

CREATE TABLE IF NOT EXISTS openclaw_saas.schema_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`.trim();

const LOCK_SCHEMA_MIGRATIONS_SQL =
  "LOCK TABLE openclaw_saas.schema_migrations IN ACCESS EXCLUSIVE MODE";

const SELECT_SCHEMA_MIGRATIONS_SQL = `
SELECT id, checksum
FROM openclaw_saas.schema_migrations
ORDER BY id
`.trim();

const CHECK_SCHEMA_MIGRATIONS_EXISTS_SQL = `
SELECT to_regclass('openclaw_saas.schema_migrations')::text AS regclass
`.trim();

const INSERT_SCHEMA_MIGRATION_SQL = `
INSERT INTO openclaw_saas.schema_migrations (id, checksum)
VALUES ($1, $2)
ON CONFLICT (id) DO UPDATE
SET checksum = EXCLUDED.checksum
`.trim();

function normalizeAppliedMigrationRows(
  rows: readonly SchemaMigrationRow[],
): AppliedSaasPostgresMigration[] {
  return rows.map((row) => {
    if (typeof row.id !== "string" || typeof row.checksum !== "string") {
      throw new SaasPostgresMigrationRunnerError("Invalid SaaS PostgreSQL migration ledger row.");
    }
    return {
      id: row.id,
      checksum: row.checksum,
    };
  });
}

async function rollbackBestEffort(executor: SaasPostgresQueryExecutor): Promise<void> {
  try {
    await executor.query("ROLLBACK");
  } catch {
    // Preserve the original migration failure.
  }
}

export async function loadAppliedSaasPostgresMigrations(
  executor: SaasPostgresQueryExecutor,
): Promise<readonly AppliedSaasPostgresMigration[]> {
  await executor.query(SAAS_POSTGRES_MIGRATION_BOOTSTRAP_SQL);
  const result = await executor.query<SchemaMigrationRow>(SELECT_SCHEMA_MIGRATIONS_SQL);
  return normalizeAppliedMigrationRows(result.rows);
}

export async function loadAppliedSaasPostgresMigrationsReadOnly(
  executor: SaasPostgresQueryExecutor,
): Promise<readonly AppliedSaasPostgresMigration[]> {
  const exists = await executor.query<RegclassRow>(CHECK_SCHEMA_MIGRATIONS_EXISTS_SQL);
  if (exists.rows[0]?.regclass !== "openclaw_saas.schema_migrations") {
    return [];
  }
  const result = await executor.query<SchemaMigrationRow>(SELECT_SCHEMA_MIGRATIONS_SQL);
  return normalizeAppliedMigrationRows(result.rows);
}

export async function runSaasPostgresMigrations(
  executor: SaasPostgresQueryExecutor,
): Promise<RunSaasPostgresMigrationsResult> {
  await executor.query(SAAS_POSTGRES_MIGRATION_BOOTSTRAP_SQL);
  await executor.query("BEGIN");

  try {
    await executor.query(LOCK_SCHEMA_MIGRATIONS_SQL);
    const appliedRows = await executor.query<SchemaMigrationRow>(SELECT_SCHEMA_MIGRATIONS_SQL);
    const appliedBeforeRun = normalizeAppliedMigrationRows(appliedRows.rows);
    const plan = buildSaasPostgresMigrationPlan(appliedBeforeRun);

    if (plan.issues.length > 0) {
      throw new SaasPostgresMigrationRunnerError(
        plan.issues.map((issue) => issue.message).join(" "),
      );
    }

    const applied: AppliedSaasPostgresMigration[] = [];
    for (const migration of plan.pending) {
      const checksum = calculateSaasPostgresMigrationChecksum(migration);
      await executor.query(migration.sql);
      await executor.query(INSERT_SCHEMA_MIGRATION_SQL, [migration.id, checksum]);
      applied.push({ id: migration.id, checksum });
    }

    await executor.query("COMMIT");
    return {
      applied,
      pendingBeforeRun: plan.pending,
    };
  } catch (error) {
    await rollbackBestEffort(executor);
    if (error instanceof SaasPostgresMigrationRunnerError) {
      throw error;
    }
    throw new SaasPostgresMigrationRunnerError("Failed to run SaaS PostgreSQL migrations.", error);
  }
}
