import { describe, expect, it, vi } from "vitest";
import { calculateSaasPostgresMigrationChecksum } from "./postgres-migration-plan.js";
import { OPENCLAW_SAAS_POSTGRES_MIGRATIONS } from "./postgres-migrations.js";

vi.mock("./configured-postgres.js", () => ({
  loadConfiguredSaasPostgresMigrationsReadOnly: vi.fn(async () => []),
}));

import { loadConfiguredSaasPostgresMigrationsReadOnly } from "./configured-postgres.js";
import { loadSaasReadinessWithPg } from "./readiness-pg.js";

function appliedKnownMigrations() {
  return OPENCLAW_SAAS_POSTGRES_MIGRATIONS.map((migration) => ({
    id: migration.id,
    checksum: calculateSaasPostgresMigrationChecksum(migration),
  }));
}

describe("loadSaasReadinessWithPg", () => {
  it("does not touch PostgreSQL when SaaS mode is disabled", async () => {
    await expect(loadSaasReadinessWithPg({ env: {} })).resolves.toMatchObject({
      status: "disabled",
    });
    expect(loadConfiguredSaasPostgresMigrationsReadOnly).not.toHaveBeenCalled();
  });

  it("does not touch PostgreSQL when local configuration is blocked", async () => {
    await expect(
      loadSaasReadinessWithPg({ env: { OPENCLAW_SAAS_MODE: "1" } }),
    ).resolves.toMatchObject({
      status: "blocked",
    });
    expect(loadConfiguredSaasPostgresMigrationsReadOnly).not.toHaveBeenCalled();
  });

  it("reports pending migrations from a read-only migration ledger check", async () => {
    vi.mocked(loadConfiguredSaasPostgresMigrationsReadOnly).mockResolvedValueOnce([]);

    await expect(
      loadSaasReadinessWithPg({
        env: {
          OPENCLAW_SAAS_MODE: "1",
          DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
        },
        poolOptions: { applicationName: "readiness-test" },
      }),
    ).resolves.toMatchObject({
      status: "needs_migration",
    });

    expect(loadConfiguredSaasPostgresMigrationsReadOnly).toHaveBeenCalledWith({
      env: {
        OPENCLAW_SAAS_MODE: "1",
        DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
      },
      poolOptions: { applicationName: "readiness-test" },
    });
  });

  it("reports ready when all migrations are already applied", async () => {
    vi.mocked(loadConfiguredSaasPostgresMigrationsReadOnly).mockResolvedValueOnce(
      appliedKnownMigrations(),
    );

    await expect(
      loadSaasReadinessWithPg({
        env: {
          OPENCLAW_SAAS_MODE: "1",
          DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
        },
      }),
    ).resolves.toMatchObject({
      status: "ready",
    });
  });
});
