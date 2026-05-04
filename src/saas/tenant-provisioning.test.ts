import { describe, expect, it } from "vitest";
import { SAAS_SECRET_DEK_LENGTH_BYTES } from "./envelope-encryption.js";
import type { SaasKmsProvider } from "./kms.js";
import type { SaasPostgresQueryExecutor } from "./postgres-migration-runner.js";
import {
  SaasTenantProvisioningConflictError,
  SaasTenantProvisioningValidationError,
  buildSaasTenantProvisioningPlan,
  normalizeSaasTenantSlug,
  provisionSaasTenant,
} from "./tenant-provisioning.js";

const TENANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const ENCRYPTED_DEK = Buffer.from("encrypted-dek");

type QueryCall = {
  sql: string;
  params?: readonly unknown[];
};

function createExecutor(params?: {
  insertedTenant?: boolean;
}): SaasPostgresQueryExecutor & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      queryParams?: readonly unknown[],
    ) {
      calls.push(queryParams ? { sql, params: queryParams } : { sql });
      if (sql.startsWith("INSERT INTO openclaw_saas.tenants")) {
        return {
          rows:
            params?.insertedTenant === false
              ? []
              : ([
                  {
                    id: queryParams?.[0],
                    slug: queryParams?.[1],
                    display_name: queryParams?.[2],
                  },
                ] as unknown as readonly TRow[]),
        };
      }
      return { rows: [] as readonly TRow[] };
    },
  };
}

function createKmsProvider(): SaasKmsProvider & {
  encryptCalls: Array<{ plaintext: Buffer; associatedData?: string | Buffer }>;
} {
  const encryptCalls: Array<{ plaintext: Buffer; associatedData?: string | Buffer }> = [];
  return {
    encryptCalls,
    keyId() {
      return "local:test";
    },
    async encrypt(plaintext, associatedData) {
      encryptCalls.push({ plaintext: Buffer.from(plaintext), associatedData });
      return {
        keyId: "local:test",
        algorithm: "aes-256-gcm",
        ciphertext: Buffer.from(ENCRYPTED_DEK),
      };
    },
    async decrypt() {
      return Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 9);
    },
  };
}

describe("normalizeSaasTenantSlug", () => {
  it("normalizes valid tenant slugs", () => {
    expect(normalizeSaasTenantSlug(" Acme-01 ")).toBe("acme-01");
  });

  it("rejects invalid tenant slugs", () => {
    expect(() => normalizeSaasTenantSlug("-bad")).toThrow(SaasTenantProvisioningValidationError);
    expect(() => normalizeSaasTenantSlug("ab")).toThrow(SaasTenantProvisioningValidationError);
  });
});

describe("buildSaasTenantProvisioningPlan", () => {
  it("builds a normalized provisioning plan", () => {
    expect(
      buildSaasTenantProvisioningPlan({
        tenantId: TENANT_ID,
        slug: "Acme",
        displayName: " Acme Inc ",
        ownerUserId: " owner@example.com ",
        agentId: "default",
      }),
    ).toEqual({
      tenantId: TENANT_ID,
      slug: "acme",
      displayName: "Acme Inc",
      ownerUserId: "owner@example.com",
      agent: {
        agentId: "default",
        displayName: "Default Agent",
      },
    });
  });
});

describe("provisionSaasTenant", () => {
  it("sets transaction-local tenant context before inserting tenant-owned rows", async () => {
    const executor = createExecutor();

    await expect(
      provisionSaasTenant(executor, {
        tenantId: TENANT_ID,
        slug: "acme",
        displayName: "Acme",
        ownerUserId: "owner@example.com",
        agentId: "default",
        agentDisplayName: "Default",
      }),
    ).resolves.toEqual({
      tenantId: TENANT_ID,
      slug: "acme",
      displayName: "Acme",
      ownerUserId: "owner@example.com",
      agent: {
        agentId: "default",
        displayName: "Default",
      },
      created: true,
    });

    expect(executor.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "select set_config('app.current_tenant_id', $1, true)",
      expect.stringContaining("INSERT INTO openclaw_saas.tenants"),
      expect.stringContaining("INSERT INTO openclaw_saas.tenant_users"),
      expect.stringContaining("INSERT INTO openclaw_saas.agents"),
      "COMMIT",
    ]);
    expect(executor.calls[1]?.params).toEqual([TENANT_ID]);
    expect(executor.calls[2]?.params).toEqual([TENANT_ID, "acme", "Acme"]);
    expect(executor.calls[3]?.params).toEqual([TENANT_ID, "owner@example.com"]);
  });

  it("rolls back when the tenant id or slug already exists", async () => {
    const executor = createExecutor({ insertedTenant: false });

    await expect(
      provisionSaasTenant(executor, {
        tenantId: TENANT_ID,
        slug: "acme",
        displayName: "Acme",
        ownerUserId: "owner@example.com",
      }),
    ).rejects.toThrow(SaasTenantProvisioningConflictError);

    expect(executor.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("encrypts and stores an initial tenant DEK when a KMS provider is supplied", async () => {
    const executor = createExecutor();
    const kmsProvider = createKmsProvider();
    const plaintextDek = Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 9);

    await expect(
      provisionSaasTenant(
        executor,
        {
          tenantId: TENANT_ID,
          slug: "acme",
          displayName: "Acme",
          ownerUserId: "owner@example.com",
        },
        {
          kmsProvider,
          generateDek: () => Buffer.from(plaintextDek),
        },
      ),
    ).resolves.toMatchObject({
      initialDek: {
        version: 1,
        keyId: "local:test",
      },
    });

    expect(kmsProvider.encryptCalls).toEqual([
      {
        plaintext: plaintextDek,
        associatedData: `openclaw_saas:tenant_dek:${TENANT_ID}:1`,
      },
    ]);
    expect(executor.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "select set_config('app.current_tenant_id', $1, true)",
      expect.stringContaining("INSERT INTO openclaw_saas.tenants"),
      expect.stringContaining("INSERT INTO openclaw_saas.tenant_users"),
      expect.stringContaining("INSERT INTO openclaw_saas.tenant_deks"),
      "COMMIT",
    ]);
    expect(executor.calls.at(-2)?.params).toEqual([
      TENANT_ID,
      1,
      ENCRYPTED_DEK,
      "local:test",
      "aes-256-gcm",
    ]);
  });
});
