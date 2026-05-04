import { describe, expect, it } from "vitest";
import {
  buildSaasPostgresMigrationPlan,
  calculateSaasPostgresMigrationChecksum,
} from "./postgres-migration-plan.js";
import { OPENCLAW_SAAS_POSTGRES_MIGRATIONS } from "./postgres-migrations.js";

describe("buildSaasPostgresMigrationPlan", () => {
  it("returns every known migration when the ledger is empty", () => {
    const plan = buildSaasPostgresMigrationPlan([]);

    expect(plan.pending.map((migration) => migration.id)).toEqual([
      "0001_saas_foundation",
      "0002_saas_tenant_deks",
    ]);
    expect(plan.applied).toEqual([]);
    expect(plan.issues).toEqual([]);
  });

  it("does not reapply migrations whose checksum matches the current build", () => {
    const plan = buildSaasPostgresMigrationPlan(
      OPENCLAW_SAAS_POSTGRES_MIGRATIONS.map((migration) => ({
        id: migration.id,
        checksum: calculateSaasPostgresMigrationChecksum(migration),
      })),
    );

    expect(plan.pending).toEqual([]);
    expect(plan.issues).toEqual([]);
  });

  it("reports unknown applied migrations", () => {
    const plan = buildSaasPostgresMigrationPlan([
      {
        id: "9999_future",
        checksum: "sha256",
      },
    ]);

    expect(plan.issues).toEqual([
      expect.objectContaining({ code: "applied_migration_unknown", severity: "error" }),
    ]);
  });

  it("reports checksum drift for applied migrations", () => {
    const plan = buildSaasPostgresMigrationPlan([
      {
        id: "0001_saas_foundation",
        checksum: "not-the-current-checksum",
      },
    ]);

    expect(plan.issues).toEqual([
      expect.objectContaining({
        code: "applied_migration_checksum_mismatch",
        severity: "error",
      }),
    ]);
  });
});
