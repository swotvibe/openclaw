import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SaasReadiness } from "../saas/readiness.js";
import { registerSaasCli } from "./saas-cli.js";

type SaasReadinessOverrides = Omit<Partial<SaasReadiness>, "database" | "flags" | "migrations"> & {
  database?: Partial<SaasReadiness["database"]>;
  flags?: Partial<SaasReadiness["flags"]>;
  migrations?: Partial<SaasReadiness["migrations"]>;
};

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  const runtime = createCliRuntimeMock(vi);
  return {
    loadDotEnv: vi.fn(),
    resolveSaasReadiness: vi.fn(),
    loadSaasReadinessWithPg: vi.fn(),
    runConfiguredSaasPostgresMigrations: vi.fn(),
    runConfiguredSaasRlsIsolationSmoke: vi.fn(),
    provisionConfiguredSaasTenant: vi.fn(),
    ...runtime,
  };
});

const {
  loadDotEnv,
  resolveSaasReadiness,
  loadSaasReadinessWithPg,
  runConfiguredSaasPostgresMigrations,
  runConfiguredSaasRlsIsolationSmoke,
  provisionConfiguredSaasTenant,
  runtimeLogs,
  runtimeErrors,
} = mocks;

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../infra/dotenv.js", () => ({
  loadDotEnv: (opts: unknown) => mocks.loadDotEnv(opts),
}));

vi.mock("../saas/readiness.js", () => ({
  resolveSaasReadiness: () => mocks.resolveSaasReadiness(),
}));

vi.mock("../saas/readiness-pg.js", () => ({
  loadSaasReadinessWithPg: () => mocks.loadSaasReadinessWithPg(),
}));

vi.mock("../saas/configured-postgres.js", () => ({
  runConfiguredSaasPostgresMigrations: () => mocks.runConfiguredSaasPostgresMigrations(),
  runConfiguredSaasRlsIsolationSmoke: () => mocks.runConfiguredSaasRlsIsolationSmoke(),
  provisionConfiguredSaasTenant: (params: unknown) => mocks.provisionConfiguredSaasTenant(params),
}));

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerSaasCli(program);
  return program;
}

function createReadiness(overrides: SaasReadinessOverrides = {}): SaasReadiness {
  const base: SaasReadiness = {
    status: "ready",
    flags: {
      saasMode: true,
      databaseEnabled: true,
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
    },
    database: {
      saasMode: true,
      tenantDatabaseConfigured: true,
      serviceDatabaseConfigured: false,
      tenantConnection: {
        configured: true,
        source: "connection-url",
        connectionUrl: "postgresql://openclaw:secret@postgres:5432/openclaw",
        redactedConnectionUrl: "postgresql://openclaw:<redacted>@postgres:5432/openclaw",
        issues: [],
      },
      serviceConnection: {
        configured: false,
        issues: [],
      },
      tenantDatabaseUrl: "postgresql://openclaw:secret@postgres:5432/openclaw",
      tenantDatabaseUrlRedacted: "postgresql://openclaw:<redacted>@postgres:5432/openclaw",
      issues: [],
    },
    migrations: {
      applied: [],
      pending: [],
      issues: [],
    },
  };

  return {
    ...base,
    ...overrides,
    flags: {
      ...base.flags,
      ...overrides.flags,
    },
    database: {
      ...base.database,
      ...overrides.database,
    },
    migrations: {
      ...base.migrations,
      ...overrides.migrations,
    },
  };
}

describe("saas CLI", () => {
  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    loadDotEnv.mockReset();
    resolveSaasReadiness.mockReset();
    loadSaasReadinessWithPg.mockReset();
    runConfiguredSaasPostgresMigrations.mockReset();
    runConfiguredSaasRlsIsolationSmoke.mockReset();
    provisionConfiguredSaasTenant.mockReset();
  });

  it("prints local status JSON without leaking the raw database URL", async () => {
    resolveSaasReadiness.mockReturnValue(createReadiness());

    await createProgram().parseAsync(["saas", "status", "--json"], { from: "user" });

    expect(resolveSaasReadiness).toHaveBeenCalledTimes(1);
    expect(loadDotEnv).toHaveBeenCalledWith({ quiet: true });
    expect(loadSaasReadinessWithPg).not.toHaveBeenCalled();
    const output = String(runtimeLogs.at(-1));
    expect(output).toContain("postgresql://openclaw:<redacted>@postgres:5432/openclaw");
    expect(output).not.toContain("postgresql://openclaw:secret@postgres:5432/openclaw");
    expect(output).not.toContain(":secret@");

    const payload = JSON.parse(output);
    expect(payload.status).toBe("ready");
    expect(payload.live).toBe(false);
    expect(payload.database.tenant.url).toBe(
      "postgresql://openclaw:<redacted>@postgres:5432/openclaw",
    );
    expect(payload.database.tenant.connectionUrl).toBeUndefined();
  });

  it("uses the read-only PostgreSQL readiness check for live status", async () => {
    loadSaasReadinessWithPg.mockResolvedValue(
      createReadiness({
        status: "needs_migration",
        migrations: {
          applied: [],
          pending: [
            {
              id: "0001_saas_foundation",
              description: "Create SaaS foundation schema.",
              sql: "select 1",
            },
          ],
          issues: [],
        },
      }),
    );

    await createProgram().parseAsync(["saas", "status", "--live"], { from: "user" });

    expect(loadSaasReadinessWithPg).toHaveBeenCalledTimes(1);
    expect(runConfiguredSaasPostgresMigrations).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("live PostgreSQL ledger (read-only)");
    expect(runtimeLogs.join("\n")).toContain("0001_saas_foundation");
  });

  it("dry-runs migrate by default and does not apply migrations", async () => {
    loadSaasReadinessWithPg.mockResolvedValue(
      createReadiness({
        status: "needs_migration",
        migrations: {
          applied: [],
          pending: [
            {
              id: "0001_saas_foundation",
              description: "Create SaaS foundation schema.",
              sql: "select 1",
            },
          ],
          issues: [],
        },
      }),
    );

    await createProgram().parseAsync(["saas", "migrate"], { from: "user" });

    expect(loadSaasReadinessWithPg).toHaveBeenCalledTimes(1);
    expect(runConfiguredSaasPostgresMigrations).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("Dry-run only");
    expect(runtimeLogs.join("\n")).toContain("openclaw saas migrate --yes");
  });

  it("applies migrations only when --yes is provided and SaaS mode is enabled", async () => {
    resolveSaasReadiness.mockReturnValue(createReadiness({ status: "needs_migration" }));
    runConfiguredSaasPostgresMigrations.mockResolvedValue({
      pendingBeforeRun: [
        {
          id: "0001_saas_foundation",
          description: "Create SaaS foundation schema.",
          sql: "select 1",
        },
      ],
      applied: [
        {
          id: "0001_saas_foundation",
          checksum: "checksum",
        },
      ],
    });

    await createProgram().parseAsync(["saas", "migrate", "--yes"], { from: "user" });

    expect(resolveSaasReadiness).toHaveBeenCalledTimes(1);
    expect(runConfiguredSaasPostgresMigrations).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain("Applied: 0001_saas_foundation");
  });

  it("refuses to apply migrations when SaaS mode is disabled", async () => {
    resolveSaasReadiness.mockReturnValue(
      createReadiness({
        status: "disabled",
        flags: { saasMode: false, databaseEnabled: false },
        database: { saasMode: false, tenantDatabaseConfigured: false },
      }),
    );

    await expect(
      createProgram().parseAsync(["saas", "migrate", "--yes"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(runConfiguredSaasPostgresMigrations).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Set OPENCLAW_SAAS_MODE=1");
  });

  it("redacts PostgreSQL URLs from command errors", async () => {
    loadSaasReadinessWithPg.mockRejectedValue(
      new Error(
        "connect failed for postgresql://openclaw:secret@postgres:5432/openclaw with timeout",
      ),
    );

    await expect(
      createProgram().parseAsync(["saas", "status", "--live"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.join("\n")).not.toContain("secret");
    expect(runtimeErrors.join("\n")).toContain("redacted");
  });

  it("runs the rollback-only RLS check when migrations are current", async () => {
    loadSaasReadinessWithPg.mockResolvedValue(createReadiness({ status: "ready" }));
    runConfiguredSaasRlsIsolationSmoke.mockResolvedValue({
      ok: true,
      rolledBack: true,
      currentUser: "openclaw_tenant",
      sessionUser: "openclaw_tenant",
      tenantA: "550e8400-e29b-41d4-a716-446655440000",
      tenantB: "550e8400-e29b-41d4-a716-446655440001",
      checks: [],
      issues: [],
    });

    await createProgram().parseAsync(["saas", "rls-check", "--json"], { from: "user" });

    expect(loadSaasReadinessWithPg).toHaveBeenCalledTimes(1);
    expect(runConfiguredSaasRlsIsolationSmoke).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtimeLogs.at(-1)));
    expect(payload).toMatchObject({
      ok: true,
      rolledBack: true,
      currentUser: "openclaw_tenant",
      issues: [],
    });
  });

  it("fails the RLS check when tenant contexts can see each other", async () => {
    loadSaasReadinessWithPg.mockResolvedValue(createReadiness({ status: "ready" }));
    runConfiguredSaasRlsIsolationSmoke.mockResolvedValue({
      ok: false,
      rolledBack: true,
      tenantA: "550e8400-e29b-41d4-a716-446655440000",
      tenantB: "550e8400-e29b-41d4-a716-446655440001",
      checks: [
        {
          tenantId: "550e8400-e29b-41d4-a716-446655440000",
          visibleTenantIds: [
            "550e8400-e29b-41d4-a716-446655440000",
            "550e8400-e29b-41d4-a716-446655440001",
          ],
          expectedVisibleTenantIds: ["550e8400-e29b-41d4-a716-446655440000"],
          ok: false,
        },
      ],
      issues: [
        {
          code: "tenant_a_visibility_mismatch",
          message: "Tenant A context saw 2 smoke tenant rows instead of exactly itself.",
        },
      ],
    });

    await expect(
      createProgram().parseAsync(["saas", "rls-check"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeLogs.join("\n")).toContain("Status: failed");
    expect(runtimeLogs.join("\n")).toContain("tenant_a_visibility_mismatch");
  });

  it("blocks the RLS check when migrations are pending", async () => {
    loadSaasReadinessWithPg.mockResolvedValue(
      createReadiness({
        status: "needs_migration",
        migrations: {
          applied: [],
          pending: [
            {
              id: "0001_saas_foundation",
              description: "Create SaaS foundation schema.",
              sql: "select 1",
            },
          ],
          issues: [],
        },
      }),
    );

    await expect(
      createProgram().parseAsync(["saas", "rls-check"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(runConfiguredSaasRlsIsolationSmoke).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("openclaw saas migrate --yes");
  });

  it("dry-runs tenant provisioning by default", async () => {
    await createProgram().parseAsync(
      [
        "saas",
        "tenant",
        "create",
        "--slug",
        "Acme",
        "--name",
        "Acme Inc",
        "--owner-user-id",
        "owner@example.com",
        "--agent-id",
        "default",
        "--json",
      ],
      { from: "user" },
    );

    expect(provisionConfiguredSaasTenant).not.toHaveBeenCalled();
    const payload = JSON.parse(String(runtimeLogs.at(-1)));
    expect(payload).toMatchObject({
      ok: true,
      dryRun: true,
      slug: "acme",
      displayName: "Acme Inc",
      ownerUserId: "owner@example.com",
      agent: {
        agentId: "default",
        displayName: "Default Agent",
      },
    });
    expect(String(payload.tenantId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("creates a tenant only when --yes is provided and migrations are current", async () => {
    loadSaasReadinessWithPg.mockResolvedValue(createReadiness({ status: "ready" }));
    provisionConfiguredSaasTenant.mockResolvedValue({
      created: true,
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      slug: "acme",
      displayName: "Acme Inc",
      ownerUserId: "owner@example.com",
      agent: {
        agentId: "default",
        displayName: "Default",
      },
    });

    await createProgram().parseAsync(
      [
        "saas",
        "tenant",
        "create",
        "--tenant-id",
        "550e8400-e29b-41d4-a716-446655440000",
        "--slug",
        "acme",
        "--name",
        "Acme Inc",
        "--owner-user-id",
        "owner@example.com",
        "--agent-id",
        "default",
        "--agent-name",
        "Default",
        "--yes",
      ],
      { from: "user" },
    );

    expect(loadSaasReadinessWithPg).toHaveBeenCalledTimes(1);
    expect(provisionConfiguredSaasTenant).toHaveBeenCalledWith({
      input: {
        tenantId: "550e8400-e29b-41d4-a716-446655440000",
        slug: "acme",
        displayName: "Acme Inc",
        ownerUserId: "owner@example.com",
        agentId: "default",
        agentDisplayName: "Default",
      },
    });
    expect(runtimeLogs.join("\n")).toContain("OpenClaw SaaS tenant created");
  });

  it("blocks tenant creation when migrations are pending", async () => {
    loadSaasReadinessWithPg.mockResolvedValue(
      createReadiness({
        status: "needs_migration",
        migrations: {
          applied: [],
          pending: [
            {
              id: "0001_saas_foundation",
              description: "Create SaaS foundation schema.",
              sql: "select 1",
            },
          ],
          issues: [],
        },
      }),
    );

    await expect(
      createProgram().parseAsync(
        [
          "saas",
          "tenant",
          "create",
          "--slug",
          "acme",
          "--name",
          "Acme Inc",
          "--owner-user-id",
          "owner@example.com",
          "--yes",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");

    expect(provisionConfiguredSaasTenant).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("openclaw saas migrate --yes");
  });
});
