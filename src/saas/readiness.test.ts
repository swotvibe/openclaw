import { describe, expect, it } from "vitest";
import { calculateSaasPostgresMigrationChecksum } from "./postgres-migration-plan.js";
import { OPENCLAW_SAAS_POSTGRES_MIGRATIONS } from "./postgres-migrations.js";
import { resolveSaasReadiness } from "./readiness.js";

function appliedKnownMigrations() {
  return OPENCLAW_SAAS_POSTGRES_MIGRATIONS.map((migration) => ({
    id: migration.id,
    checksum: calculateSaasPostgresMigrationChecksum(migration),
  }));
}

describe("resolveSaasReadiness", () => {
  it("stays disabled until SaaS mode is explicitly enabled", () => {
    expect(resolveSaasReadiness({ env: {} }).status).toBe("disabled");
  });

  it("blocks SaaS mode when no tenant database endpoint is configured", () => {
    const readiness = resolveSaasReadiness({
      env: { OPENCLAW_SAAS_MODE: "1" },
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.database.issues).toEqual([
      expect.objectContaining({ code: "tenant_database_missing", severity: "error" }),
    ]);
  });

  it("requires pending migrations before reporting ready", () => {
    const readiness = resolveSaasReadiness({
      env: {
        OPENCLAW_SAAS_MODE: "1",
        OPENCLAW_POSTGRES_HOST: "db.example.com:5432",
      },
    });

    expect(readiness.status).toBe("needs_migration");
    expect(readiness.migrations.pending.map((migration) => migration.id)).toEqual([
      "0001_saas_foundation",
      "0002_saas_tenant_deks",
    ]);
  });

  it("reports ready when database config is valid and migrations are applied", () => {
    const readiness = resolveSaasReadiness({
      env: {
        OPENCLAW_SAAS_MODE: "1",
        OPENCLAW_POSTGRES_HOST: "db.example.com:5432",
      },
      appliedMigrations: appliedKnownMigrations(),
    });

    expect(readiness.status).toBe("ready");
  });

  it("blocks on migration checksum drift", () => {
    const readiness = resolveSaasReadiness({
      env: {
        OPENCLAW_SAAS_MODE: "1",
        OPENCLAW_POSTGRES_HOST: "db.example.com:5432",
      },
      appliedMigrations: [{ id: "0001_saas_foundation", checksum: "old" }],
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.migrations.issues).toEqual([
      expect.objectContaining({ code: "applied_migration_checksum_mismatch" }),
    ]);
  });
});
