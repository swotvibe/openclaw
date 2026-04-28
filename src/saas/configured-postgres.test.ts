import { describe, expect, it, vi } from "vitest";

vi.mock("./postgres-pg-executor.js", () => ({
  loadAppliedSaasPostgresMigrationsReadOnlyWithPg: vi.fn(async () => [
    { id: "0001_saas_foundation", checksum: "checksum-read-only" },
  ]),
  loadAppliedSaasPostgresMigrationsWithPg: vi.fn(async () => [
    { id: "0001_saas_foundation", checksum: "checksum" },
  ]),
  runSaasPostgresMigrationsWithPg: vi.fn(async () => ({
    applied: [{ id: "0001_saas_foundation", checksum: "checksum" }],
    pendingBeforeRun: [],
  })),
  provisionSaasTenantWithPg: vi.fn(async () => ({
    created: true,
    tenantId: "550e8400-e29b-41d4-a716-446655440000",
    slug: "acme",
    displayName: "Acme",
    ownerUserId: "owner@example.com",
  })),
  writeSaasTenantSecretWithPg: vi.fn(async () => ({
    written: true,
    tenantId: "550e8400-e29b-41d4-a716-446655440000",
    secretRef: "openai/api-key",
    provider: "openai",
    keyId: "OPENAI_API_KEY",
    dekVersion: 1,
    algorithm: "aes-256-gcm",
    metadata: {},
  })),
  readSaasTenantSecretWithPg: vi.fn(async () => ({
    tenantId: "550e8400-e29b-41d4-a716-446655440000",
    secretRef: "openai/api-key",
    provider: "openai",
    keyId: "OPENAI_API_KEY",
    dekVersion: 1,
    algorithm: "aes-256-gcm",
    metadata: {},
    plaintext: Buffer.from("secret"),
  })),
  runSaasRlsIsolationSmokeWithPg: vi.fn(async () => ({
    ok: true,
    rolledBack: true,
    tenantA: "550e8400-e29b-41d4-a716-446655440000",
    tenantB: "550e8400-e29b-41d4-a716-446655440001",
    checks: [],
    issues: [],
  })),
}));

import {
  SaasDatabaseConfigurationError,
  loadConfiguredSaasPostgresMigrationsReadOnly,
  loadConfiguredSaasPostgresMigrations,
  provisionConfiguredSaasTenant,
  readConfiguredSaasTenantSecret,
  resolveConfiguredSaasTenantDatabaseUrl,
  runConfiguredSaasRlsIsolationSmoke,
  runConfiguredSaasPostgresMigrations,
  writeConfiguredSaasTenantSecret,
} from "./configured-postgres.js";
import {
  loadAppliedSaasPostgresMigrationsReadOnlyWithPg,
  loadAppliedSaasPostgresMigrationsWithPg,
  provisionSaasTenantWithPg,
  readSaasTenantSecretWithPg,
  runSaasRlsIsolationSmokeWithPg,
  runSaasPostgresMigrationsWithPg,
  writeSaasTenantSecretWithPg,
} from "./postgres-pg-executor.js";

describe("resolveConfiguredSaasTenantDatabaseUrl", () => {
  it("resolves the configured tenant database URL", () => {
    expect(
      resolveConfiguredSaasTenantDatabaseUrl({
        OPENCLAW_SAAS_MODE: "1",
        DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
      }),
    ).toBe("postgresql://tenant:secret@db.example.com/openclaw");
  });

  it("throws a configuration error when the tenant database URL is invalid", () => {
    expect(() =>
      resolveConfiguredSaasTenantDatabaseUrl({
        OPENCLAW_SAAS_MODE: "1",
        DATABASE_URL: "https://db.example.com",
      }),
    ).toThrow(SaasDatabaseConfigurationError);
  });
});

describe("configured SaaS PostgreSQL helpers", () => {
  it("loads migrations in read-only mode through the pg adapter", async () => {
    await expect(
      loadConfiguredSaasPostgresMigrationsReadOnly({
        env: {
          OPENCLAW_SAAS_MODE: "1",
          DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
        },
        poolOptions: { applicationName: "test-readiness" },
      }),
    ).resolves.toEqual([{ id: "0001_saas_foundation", checksum: "checksum-read-only" }]);

    expect(loadAppliedSaasPostgresMigrationsReadOnlyWithPg).toHaveBeenCalledWith(
      "postgresql://tenant:secret@db.example.com/openclaw",
      { applicationName: "test-readiness" },
    );
  });

  it("loads migrations through the pg adapter using the configured URL", async () => {
    await expect(
      loadConfiguredSaasPostgresMigrations({
        env: {
          OPENCLAW_SAAS_MODE: "1",
          DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
        },
        poolOptions: { applicationName: "test-loader" },
      }),
    ).resolves.toEqual([{ id: "0001_saas_foundation", checksum: "checksum" }]);

    expect(loadAppliedSaasPostgresMigrationsWithPg).toHaveBeenCalledWith(
      "postgresql://tenant:secret@db.example.com/openclaw",
      { applicationName: "test-loader" },
    );
  });

  it("runs migrations through the pg adapter using the configured URL", async () => {
    await expect(
      runConfiguredSaasPostgresMigrations({
        env: {
          OPENCLAW_SAAS_MODE: "1",
          DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
        },
        poolOptions: { applicationName: "test-runner" },
      }),
    ).resolves.toMatchObject({
      applied: [{ id: "0001_saas_foundation", checksum: "checksum" }],
    });

    expect(runSaasPostgresMigrationsWithPg).toHaveBeenCalledWith(
      "postgresql://tenant:secret@db.example.com/openclaw",
      { applicationName: "test-runner" },
    );
  });

  it("provisions a tenant through the pg adapter using the configured URL", async () => {
    const input = {
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      slug: "acme",
      displayName: "Acme",
      ownerUserId: "owner@example.com",
    };

    await expect(
      provisionConfiguredSaasTenant({
        input,
        env: {
          OPENCLAW_SAAS_MODE: "1",
          DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
          OPENCLAW_MASTER_KEY: `hex:${Buffer.alloc(32, 1).toString("hex")}`,
        },
        poolOptions: { applicationName: "test-provisioning" },
      }),
    ).resolves.toMatchObject({
      created: true,
      slug: "acme",
    });

    expect(provisionSaasTenantWithPg).toHaveBeenCalledWith(
      "postgresql://tenant:secret@db.example.com/openclaw",
      input,
      {
        kmsProvider: expect.objectContaining({
          keyId: expect.any(Function),
          encrypt: expect.any(Function),
          decrypt: expect.any(Function),
        }),
      },
      { applicationName: "test-provisioning" },
    );
  });

  it("runs the RLS smoke through the pg adapter using the configured URL", async () => {
    await expect(
      runConfiguredSaasRlsIsolationSmoke({
        env: {
          OPENCLAW_SAAS_MODE: "1",
          DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
        },
        poolOptions: { applicationName: "test-rls-smoke" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      rolledBack: true,
    });

    expect(runSaasRlsIsolationSmokeWithPg).toHaveBeenCalledWith(
      "postgresql://tenant:secret@db.example.com/openclaw",
      { applicationName: "test-rls-smoke" },
    );
  });

  it("writes tenant secrets through the pg adapter using configured database and KMS", async () => {
    const input = {
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      secretRef: "openai/api-key",
      provider: "openai",
      keyId: "OPENAI_API_KEY",
      plaintext: "secret",
    };

    await expect(
      writeConfiguredSaasTenantSecret({
        input,
        env: {
          OPENCLAW_SAAS_MODE: "1",
          DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
          OPENCLAW_MASTER_KEY: `hex:${Buffer.alloc(32, 2).toString("hex")}`,
        },
        poolOptions: { applicationName: "test-secret-write" },
      }),
    ).resolves.toMatchObject({
      written: true,
      secretRef: "openai/api-key",
    });

    expect(writeSaasTenantSecretWithPg).toHaveBeenCalledWith(
      "postgresql://tenant:secret@db.example.com/openclaw",
      input,
      {
        kmsProvider: expect.objectContaining({
          keyId: expect.any(Function),
          encrypt: expect.any(Function),
          decrypt: expect.any(Function),
        }),
      },
      { applicationName: "test-secret-write" },
    );
  });

  it("reads tenant secrets through the pg adapter using configured database and KMS", async () => {
    const input = {
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      secretRef: "openai/api-key",
    };

    await expect(
      readConfiguredSaasTenantSecret({
        input,
        env: {
          OPENCLAW_SAAS_MODE: "1",
          DATABASE_URL: "postgresql://tenant:secret@db.example.com/openclaw",
          OPENCLAW_MASTER_KEY: `hex:${Buffer.alloc(32, 3).toString("hex")}`,
        },
        poolOptions: { applicationName: "test-secret-read" },
      }),
    ).resolves.toMatchObject({
      secretRef: "openai/api-key",
      plaintext: Buffer.from("secret"),
    });

    expect(readSaasTenantSecretWithPg).toHaveBeenCalledWith(
      "postgresql://tenant:secret@db.example.com/openclaw",
      input,
      {
        kmsProvider: expect.objectContaining({
          keyId: expect.any(Function),
          encrypt: expect.any(Function),
          decrypt: expect.any(Function),
        }),
      },
      { applicationName: "test-secret-read" },
    );
  });
});
