import { describe, expect, it } from "vitest";
import { resolveSaasDatabaseConfig, resolveSaasFeatureFlags } from "./feature-flags.js";

describe("resolveSaasFeatureFlags", () => {
  it("keeps all SaaS paths disabled by default", () => {
    expect(resolveSaasFeatureFlags({ DATABASE_URL: "postgres://tenant/openclaw" })).toEqual({
      saasMode: false,
      databaseEnabled: false,
      configStoreDual: false,
      configStoreDb: false,
      sessionStoreDual: false,
      sessionStoreDb: false,
      secretsVault: false,
      taskRegistryDb: false,
      channelIsolation: false,
      mediaIsolation: false,
      memoryIsolation: false,
      billingEnabled: false,
      usageMeteringEnabled: false,
    });
  });

  it("enables only flags that are explicitly set in SaaS mode", () => {
    const flags = resolveSaasFeatureFlags({
      OPENCLAW_SAAS_MODE: "1",
      OPENCLAW_POSTGRES_HOST: "tenant-db.example.com",
      OPENCLAW_CONFIG_STORE_DUAL: "yes",
      OPENCLAW_SESSION_STORE_DB: "true",
      OPENCLAW_MEMORY_ISOLATION: "on",
      OPENCLAW_BILLING: "0",
    });

    expect(flags).toMatchObject({
      saasMode: true,
      databaseEnabled: true,
      configStoreDual: true,
      sessionStoreDb: true,
      memoryIsolation: true,
      billingEnabled: false,
    });
  });
});

describe("resolveSaasDatabaseConfig", () => {
  it("does not require database URLs when SaaS mode is off", () => {
    expect(resolveSaasDatabaseConfig({})).toMatchObject({
      saasMode: false,
      tenantDatabaseConfigured: false,
      serviceDatabaseConfigured: false,
      tenantConnection: { configured: false, issues: [] },
      serviceConnection: { configured: false, issues: [] },
      issues: [],
    });
  });

  it("reports missing tenant database URL when SaaS mode is enabled", () => {
    expect(resolveSaasDatabaseConfig({ OPENCLAW_SAAS_MODE: "1" }).issues).toEqual([
      expect.objectContaining({ code: "tenant_database_missing", severity: "error" }),
    ]);
  });

  it("requires a separate service database URL once tenant database is configured", () => {
    const config = resolveSaasDatabaseConfig({
      OPENCLAW_SAAS_MODE: "1",
      OPENCLAW_POSTGRES_HOST: "tenant-db.example.com:5432",
    });

    expect(config).toMatchObject({
      tenantDatabaseConfigured: true,
      tenantDatabaseUrl: "postgresql://openclaw@tenant-db.example.com:5432/openclaw",
      issues: [expect.objectContaining({ code: "service_database_missing", severity: "warn" })],
    });
  });

  it("reports invalid tenant database inputs", () => {
    const config = resolveSaasDatabaseConfig({
      OPENCLAW_SAAS_MODE: "1",
      DATABASE_URL: "https://tenant-db.example.com",
    });

    expect(config).toMatchObject({
      tenantDatabaseConfigured: false,
      issues: [expect.objectContaining({ code: "tenant_database_invalid", severity: "error" })],
    });
  });

  it("rejects matching tenant and service connection strings", () => {
    const config = resolveSaasDatabaseConfig({
      OPENCLAW_SAAS_MODE: "1",
      DATABASE_URL: "postgres://same/openclaw",
      OPENCLAW_SERVICE_DATABASE_URL: "postgres://same/openclaw",
    });

    expect(config.issues).toEqual([
      expect.objectContaining({ code: "service_database_matches_tenant", severity: "error" }),
    ]);
  });
});
