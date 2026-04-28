import { createHash } from "node:crypto";
import {
  OPENCLAW_SAAS_POSTGRES_MIGRATIONS,
  type SaasPostgresMigration,
} from "./postgres-migrations.js";

export type AppliedSaasPostgresMigration = {
  id: string;
  checksum: string;
};

export type SaasPostgresMigrationPlanIssueCode =
  | "applied_migration_unknown"
  | "applied_migration_checksum_mismatch";

export type SaasPostgresMigrationPlanIssue = {
  code: SaasPostgresMigrationPlanIssueCode;
  severity: "error";
  message: string;
};

export type SaasPostgresMigrationPlan = {
  pending: readonly SaasPostgresMigration[];
  applied: readonly AppliedSaasPostgresMigration[];
  issues: readonly SaasPostgresMigrationPlanIssue[];
};

export function calculateSaasPostgresMigrationChecksum(migration: SaasPostgresMigration): string {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}

export function buildSaasPostgresMigrationPlan(
  appliedMigrations: Iterable<AppliedSaasPostgresMigration>,
): SaasPostgresMigrationPlan {
  const knownMigrations = new Map(
    OPENCLAW_SAAS_POSTGRES_MIGRATIONS.map((migration) => [migration.id, migration]),
  );
  const applied = [...appliedMigrations].toSorted((left, right) => left.id.localeCompare(right.id));
  const appliedIds = new Set<string>();
  const issues: SaasPostgresMigrationPlanIssue[] = [];

  for (const appliedMigration of applied) {
    const knownMigration = knownMigrations.get(appliedMigration.id);
    if (!knownMigration) {
      issues.push({
        code: "applied_migration_unknown",
        severity: "error",
        message: `Applied SaaS PostgreSQL migration is not known by this build: ${appliedMigration.id}.`,
      });
      continue;
    }

    appliedIds.add(appliedMigration.id);
    const expectedChecksum = calculateSaasPostgresMigrationChecksum(knownMigration);
    if (appliedMigration.checksum !== expectedChecksum) {
      issues.push({
        code: "applied_migration_checksum_mismatch",
        severity: "error",
        message: `Applied SaaS PostgreSQL migration checksum mismatch for ${appliedMigration.id}.`,
      });
    }
  }

  return {
    pending: OPENCLAW_SAAS_POSTGRES_MIGRATIONS.filter((migration) => !appliedIds.has(migration.id)),
    applied,
    issues,
  };
}
